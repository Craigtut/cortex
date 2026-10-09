/**
 * When and what an interactive session writes to disk, and how a saved one is
 * read back for /resume.
 *
 * The artifact is the facade's composite (v2) snapshot: the session log, both
 * loops' histories and memory, and per-loop usage. Autosave hangs off the
 * facade's `onStateChanged`, which fires with a consistent snapshot at
 * quiescence. Two checkpoints cover what that cannot: one at startup, so a
 * session is listable before it does anything, and one at each turn boundary
 * in passthrough, so a long task is not a crash away from being lost.
 */

import type {
  CortexAgent,
  CortexAgentConfig,
  CortexAgentStateV1,
  CortexAgentStateV2,
  ObservationalMemoryState,
} from '@animus-labs/cortex';
import { log } from '../logger.js';
import {
  createDebouncedStateSaver,
  loadObservationalState,
  loadSession,
  loadSessionState,
  saveSessionState,
  type SessionMeta,
} from './sessions.js';

/**
 * How long shutdown waits for a fresh composite snapshot before falling back
 * to the last one the facade published. getState() resolves at a quiescence
 * window, which a session that is still working may not reach.
 */
const SHUTDOWN_SNAPSHOT_TIMEOUT_MS = 2000;

export type CheckpointAgent = Pick<
  CortexAgent,
  | 'getState'
  | 'getLog'
  | 'getConversationHistory'
  | 'getObservationalMemoryState'
  | 'getSessionUsage'
>;

/** The session facts recorded in meta.json alongside every save. */
export type SessionDescription = Pick<SessionMeta, 'mode' | 'provider' | 'model' | 'cwd' | 'contextTokenCount'>;

export interface SessionCheckpointsDeps {
  sessionId: string;
  agentMode: NonNullable<CortexAgentConfig['mode']>;
  getAgent: () => CheckpointAgent | null;
  describe: () => SessionDescription;
}

export class SessionCheckpoints {
  /**
   * Shorter than the saver's 500 ms default. The facade already debounces
   * onStateChanged by 500 ms, so a second full window here only delayed the
   * settled write; and this window is the crash exposure for turn-boundary
   * checkpoints, where the whole point is bytes on disk sooner. Still long
   * enough to coalesce a burst of turns.
   */
  private readonly saver: ReturnType<typeof createDebouncedStateSaver>;
  /**
   * The last composite snapshot the facade handed over. Shutdown falls back
   * to it when a fresh `getState()` cannot settle in time, so a session that
   * is still busy at exit is saved slightly stale rather than not at all.
   */
  private lastCompositeState: CortexAgentStateV2 | null = null;
  private createdAt = Date.now();
  private readonly sessionId: string;
  private readonly agentMode: SessionCheckpointsDeps['agentMode'];
  private readonly getAgent: () => CheckpointAgent | null;
  private readonly describe: () => SessionDescription;

  constructor(deps: SessionCheckpointsDeps) {
    this.sessionId = deps.sessionId;
    this.agentMode = deps.agentMode;
    this.getAgent = deps.getAgent;
    this.describe = deps.describe;
    this.saver = createDebouncedStateSaver(deps.sessionId, 150);
  }

  /** A resumed session keeps the creation time of the one it continues. */
  adoptCreatedAt(createdAt: number): void {
    this.createdAt = createdAt;
  }

  /** Write any debounced save now. */
  flush(): Promise<void> {
    return this.saver.flush();
  }

  /** The exit save. Best-effort: shutdown must not fail on it. */
  async saveFinal(agent: CheckpointAgent): Promise<void> {
    try {
      const state = await this.finalState(agent);
      if (state) {
        await saveSessionState(this.sessionId, state, this.buildMeta());
      }
    } catch {
      // Best-effort save during shutdown
    }
  }

  /**
   * Write the session out once, now, before it has done anything.
   *
   * Persistence is otherwise driven by `onStateChanged`, which the facade
   * only emits from a `getState()` taken at gate quiescence. A session that
   * starts work and never reaches quiescence therefore never wrote anything:
   * a brand-new session killed during its first task left no `meta.json`, so
   * `listSessions()` could not see it and `/resume` could not find it. Not
   * stale, invisible.
   *
   * The agent is idle at both call sites, so the snapshot is a real
   * consistent composite rather than a placeholder, and it gives
   * {@link crashCheckpoint} the talker side it needs as a base.
   *
   * Callers must not invoke this on a resumed session before `resume()` has
   * read the file: `start()` runs first, and an unconditional write there
   * would overwrite the very session the user asked to resume with an empty
   * agent.
   */
  async writeInitial(): Promise<void> {
    const agent = this.getAgent();
    if (!agent) return;
    try {
      const state = await agent.getState();
      this.lastCompositeState = state;
      await saveSessionState(this.sessionId, state, this.buildMeta());
    } catch (err) {
      log.warn('Initial session checkpoint failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * A crash-recovery checkpoint taken at a turn boundary, mid-run.
   *
   * `getState()` cannot help here: it resolves only when the loop gate is
   * empty, and a ten-minute task holds the gate for its whole duration, so
   * settlement-driven persistence writes nothing until the task is over. That
   * is a crash away from losing the task.
   *
   * Passthrough only, deliberately. A turn boundary is a coherent point for
   * ONE loop (pi has appended the assistant message and every tool result of
   * the batch before `turn_end` fires), and in passthrough that one loop is
   * the whole agent, so this is a consistent snapshot rather than the mid-run
   * partial the old `triggerAutoSave` was taking. Under duplex it would not
   * be: the other loop can be mid-turn at this instant, and the consumer has
   * no way to read its history except through the `getState()` that is
   * blocked. Closing that gap needs a turn-boundary snapshot on the facade,
   * not a workaround here.
   *
   * Observational memory always rides along. Its buffer watermark indexes
   * into history, and both are read in this one synchronous frame, so no
   * generation can land between the reads; a call still in flight is simply
   * not in the snapshot, and its messages are observed again after a crash.
   */
  crashCheckpoint(): void {
    const agent = this.getAgent();
    if (!agent || this.agentMode !== 'passthrough') return;
    const base = this.lastCompositeState;
    if (!base) return;

    const usage = agent.getSessionUsage();

    this.record({
      ...base,
      log: agent.getLog(),
      // Passthrough: the conversation loop IS the reasoner. The talker side
      // comes from the base snapshot rather than being blanked, so a duplex
      // artifact restored into this session round-trips instead of losing a
      // half it cannot see.
      reasonerHistory: agent.getConversationHistory(),
      reasonerMemory: agent.getObservationalMemoryState(),
      usage: { ...base.usage, total: usage, perLoop: { ...base.usage.perLoop, reasoner: usage } },
    });
  }

  /**
   * The composite snapshot to write at exit. `getState()` resolves only at a
   * quiescence window, so a session still mid-run at exit would block the
   * shutdown path; bound the wait and fall back to the last snapshot the
   * facade published, which is stale by at most one debounce rather than
   * absent.
   */
  private async finalState(agent: CheckpointAgent): Promise<CortexAgentStateV2 | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SHUTDOWN_SNAPSHOT_TIMEOUT_MS);
      timer.unref();
    });
    try {
      const fresh = await Promise.race([agent.getState().catch(() => null), bound]);
      return fresh ?? this.lastCompositeState;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Cache the composite snapshot and queue it for disk. The snapshot carries
   * the session log, BOTH loops' histories and observational memory, and
   * per-loop usage, so nothing that only exists on the conversation loop is
   * lost. The reasoner-only trio (`getConversationHistory()` plus
   * `getObservationalMemoryState()` plus `getSessionUsage()`) that used to
   * build a v1 artifact here reads the work transcript under duplex, and the
   * dialogue it omits was never written, so no later migration could get it
   * back.
   */
  record(state: CortexAgentStateV2): void {
    this.lastCompositeState = state;
    try {
      this.saver.save(state, this.buildMeta());
    } catch {
      // Swallow auto-save errors silently
    }
  }

  private buildMeta(): SessionMeta {
    const meta: SessionMeta = {
      id: this.sessionId,
      ...this.describe(),
      createdAt: this.createdAt,
      updatedAt: Date.now(),
    };
    const agent = this.getAgent();
    if (agent) {
      meta.usage = agent.getSessionUsage();
    }
    return meta;
  }


  /**
   * Load a saved session as something `restore()` accepts, plus the history
   * the transcript should replay. The replayed half is the DIALOGUE, which
   * under duplex is the talker's transcript, not the reasoner's work log.
   */
  async loadResumable(sessionId: string): Promise<{
    artifact: CortexAgentStateV1 | CortexAgentStateV2;
    meta: SessionMeta;
    dialogue: unknown[];
  } | null> {
    const composite = await loadSessionState(sessionId);
    if (composite) {
      const { state } = composite;
      return {
        artifact: state,
        meta: composite.meta,
        dialogue: state.talkerHistory.length > 0 ? state.talkerHistory : state.reasonerHistory,
      };
    }

    const saved = await loadSession(sessionId);
    if (!saved) return null;

    // Observational memory state, loaded before the restore because history
    // and memory now go in together (the buffer watermark indexes into the
    // history, so the facade orders them itself rather than trusting the
    // caller to). A session saved by a classic build has none.
    const omState = await loadObservationalState(sessionId);

    return {
      artifact: {
        version: 1,
        history: saved.history as CortexAgentStateV1['history'],
        memory: (omState ?? null) as ObservationalMemoryState | null,
        ...(saved.meta.usage ? { usage: saved.meta.usage } : {}),
      },
      meta: saved.meta,
      dialogue: saved.history,
    };
  }

}
