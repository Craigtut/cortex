/**
 * PassthroughSession: a single reasoner loop behind the facade, reproducing
 * direct AgentLoop behavior exactly (decisions.md D14). The consumer opt-out
 * and the parity baseline for tests.
 */

import type { AgentLoop, DeliverResult, DirectCompletionOptions } from '../agent-loop.js';
import type { PendingAsk, SessionUsage } from '../types.js';
import type { CortexModel } from '../model-wrapper.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ContextManager } from '../context-manager.js';
import type { ObservationalMemoryState } from '../compaction/index.js';
import type { EventBridge } from '../event-bridge.js';
import { collectCauseTags } from '../duplex/cause-tags.js';
import type { CausationSource, CauseTag } from '../duplex/cause-tags.js';
import type { LogRecorder } from './log-recorder.js';
import {
  gateTerm,
  loopAsksTerm,
  parkedWakesTerm,
  subAgentsTerm,
} from './settlement.js';
import type { SettlementTerm } from './settlement.js';
import type {
  CortexAbortScope,
  CortexDeliverOptions,
  FacadeServices,
  RestoredSessionParts,
  SessionMode,
  SessionStateParts,
} from './session-mode.js';

export class PassthroughSession implements SessionMode {
  readonly causation: CausationSource;
  readonly aggregateBudgetGuard = null;
  private readonly reasoner: AgentLoop;
  private readonly services: FacadeServices;
  private readonly recorder: LogRecorder;
  /** Serializes facade prompt() calls (concurrent prompts queue, never throw). */
  private promptChain: Promise<void> = Promise.resolve();
  /**
   * The talker side and router state of a restored duplex artifact, carried
   * through opaquely: passthrough has no talker loop to hydrate, but the
   * artifact must round-trip getState() without losing that side.
   */
  private retained: SessionStateParts = { talkerHistory: [], talkerMemory: null };

  constructor(reasoner: AgentLoop, services: FacadeServices) {
    this.reasoner = reasoner;
    this.services = services;
    this.recorder = services.recorder;
    // Read off the loop's live run, as in duplex: the input's log seq rides
    // the call or delivery that carries it, so a run's entries are stamped
    // with the input it actually consumed (a parked delivery's included)
    // and a run with no tagged input carries no stamp rather than a guess.
    this.causation = {
      tags: () => collectCauseTags(reasoner.activeRunCauseTags),
    };
    // Additive handlers (the loop keeps handler arrays), so consumer
    // handlers and their signatures are untouched and parity holds.
    this.recorder.wireConversation(reasoner);
    this.recorder.wireErrors(reasoner);
    this.recorder.wireWork(reasoner);
  }

  get eventBridge(): EventBridge {
    return this.reasoner.getEventBridge();
  }

  get contextManager(): ContextManager {
    return this.reasoner.getContextManager();
  }

  /**
   * Concurrent calls are serialized, each resolving against the turn that
   * carries its input; the utterance is logged when its run starts, so log
   * order always matches execution order even when a deliver() issued in
   * the same tick starts its run ahead of a queued prompt().
   */
  async prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    this.services.noteInputArriving();
    this.services.prompts.begin();
    const run = this.promptChain.then(async () => {
      // Wait for gate quiescence, then act in the SAME frame: between the
      // idle wait resolving and this continuation running, an unrelated
      // continuation (e.g. a background-completion drain) can seize the
      // gate, and AgentLoop.prompt() fails fast on a held gate. The
      // synchronous isLoopActive re-check closes that window exactly.
      for (;;) {
        await this.reasoner.waitForLoopIdle();
        if (this.reasoner.isLoopActive) continue;
        // Re-validate at run start: a teardown that landed while this call
        // was queued must reject it before the utterance is logged.
        this.services.assertPromptable();
        // Logged here rather than at call time: the log is the ordering
        // authority, and content that reached the loop first (a same-tick
        // deliver()) must hold the lower seq.
        const entry = this.recorder.append({
          type: 'utterance',
          loopPath: this.reasoner.loopPath,
          content: input,
          causedBy: null,
        });
        return await this.reasoner.prompt(input, {
          ...options,
          causeTag: { kind: 'utterance', seq: entry.seq } satisfies CauseTag,
        });
      }
    });
    const settle = (): void => {
      this.services.prompts.end();
    };
    this.promptChain = run.then(settle, settle);
    return run;
  }

  deliver(content: string, options?: CortexDeliverOptions): DeliverResult {
    const entry = this.recorder.append({
      type: 'utterance',
      loopPath: this.reasoner.loopPath,
      content,
      causedBy: null,
      ...(options?.target !== undefined ? { data: { target: options.target } } : {}),
    });

    // A wake delivery carries its seq into whichever run consumes it (the
    // turn it starts, a prompt batch, or a sweep); a silent one is context
    // and carries none. The kind follows the same speaker rule as duplex.
    return this.reasoner.deliver(content, {
      ...(options?.wake !== undefined ? { wake: options.wake } : {}),
      ...(options?.wake !== false
        ? {
            causeTag: {
              kind: options?.speaker === 'user' ? 'utterance' : 'delivery',
              seq: entry.seq,
            } satisfies CauseTag,
          }
        : {}),
    });
  }

  /** Matches AgentLoop.steer(), including the no-op while idle. */
  steer(message: string): void {
    this.reasoner.steer(message);
  }

  /**
   * The single reasoner is both surfaces, so every scope aborts its
   * in-flight turn and clears queued deliveries and pi's steering and
   * follow-up queues; 'work' and 'all' additionally cancel running
   * sub-agents. Pending asks resolve as deny through the abort race.
   */
  async abort(scope: CortexAbortScope): Promise<void> {
    // Dropped queued content: silent deliveries, parked wake deliveries
    // (abort() drops those itself too), and pi's steering/follow-up queues.
    this.recorder.recordDroppedQueue(this.reasoner, 'abort', this.reasoner.clearAllQueues());

    const work: Array<Promise<unknown>> = [this.reasoner.abort()];
    if (scope !== 'conversation') {
      for (const taskId of this.reasoner.getSubAgentManager().getActiveTaskIds()) {
        work.push(this.reasoner.cancelSubAgent(taskId));
      }
    }
    await Promise.all(work);
  }

  pendingAsks(): PendingAsk[] {
    return this.reasoner.getPendingAsks();
  }

  /** The consumer presents asks itself here, so it owns the voiced flag. */
  markAskVoiced(askId: string): boolean {
    return this.reasoner.markAskVoiced(askId);
  }

  settlementTerms(prompts: SettlementTerm): { conversation: SettlementTerm[]; work: SettlementTerm[] } {
    const { reasoner } = this;
    return {
      conversation: [prompts, gateTerm(reasoner)],
      work: [
        prompts,
        gateTerm(reasoner),
        subAgentsTerm(reasoner),
        loopAsksTerm(reasoner),
        parkedWakesTerm(reasoner),
      ],
    };
  }

  setBasePrompt(basePrompt: string): string {
    return this.reasoner.setBasePrompt(basePrompt);
  }

  getBasePrompt(): string {
    return this.reasoner.getBasePrompt();
  }

  setModel(model: CortexModel): void {
    this.reasoner.setModel(model);
    // The mode stays; the note explaining it is read off the model.
    this.services.refreshModelNotes();
  }

  setUtilityModel(model: CortexModel): void {
    this.reasoner.setUtilityModel(model);
  }

  setSessionId(value: string | null): void {
    this.reasoner.setSessionId(value);
  }

  lookupUsage(): SessionUsage | null {
    return null;
  }

  restoreBlocked(): boolean {
    return false;
  }

  /**
   * The retained duplex side, copied like getLog(): a persistence layer
   * that normalizes the snapshot in place must never mutate live state.
   */
  captureState(): SessionStateParts {
    return {
      talkerHistory: structuredClone(this.retained.talkerHistory) as AgentMessage[],
      talkerMemory: structuredClone(this.retained.talkerMemory) as ObservationalMemoryState | null,
      ...(this.retained.router ? { router: structuredClone(this.retained.router) } : {}),
      ...(this.retained.talkerQueuedDeliveries
        ? { talkerQueuedDeliveries: [...this.retained.talkerQueuedDeliveries] }
        : {}),
    };
  }

  hydrate(parts: SessionStateParts): void {
    this.retained = { ...this.retained, talkerHistory: parts.talkerHistory, talkerMemory: parts.talkerMemory };
  }

  resetForRestore(restored: RestoredSessionParts): void {
    const { router: _router, talkerQueuedDeliveries: _queued, ...rest } = this.retained;
    this.retained = { ...rest, ...restored };
  }

  beginDestroy(): void {}

  teardowns(): Array<Promise<void>> {
    return [];
  }

  async closeOwnedResources(): Promise<void> {}

  finishDestroy(): void {}
}
