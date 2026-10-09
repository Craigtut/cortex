/**
 * The persisted CortexAgent artifact: the versioned composite shape
 * getState() produces and restore() accepts, and the upgrade of every older
 * accepted shape to the current one (docs/cortex/duplex/facade-api.md).
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ObservationalMemoryState } from '../compaction/index.js';
import type { SessionLogEntry } from '../session-log.js';
import type { SessionUsage } from '../types.js';
import { cloneSessionUsage, zeroSessionUsage } from '../session-usage.js';
import type { DuplexRouterState } from '../duplex/router-contract.js';
import type { CortexAgentMode } from './config.js';

type AssertExtends<A extends B, B> = A;

/** Usage in the v2 artifact: one aggregate plus per-loop attribution. */
export interface CortexAgentUsageBreakdown {
  /**
   * Aggregate across every loop, sub-agent, and utility call. Children are
   * counted exactly once: each loop's session usage already includes its
   * forwarded child events (bridge-of-record), so the aggregate is the sum
   * of per-loop totals with SubAgentResult.usage never re-added on top.
   */
  total: SessionUsage;
  /**
   * Per-loop breakdown, so attribution survives a restore (a single blob
   * would erase it). `talker` is null for passthrough sessions.
   */
  perLoop: {
    talker: SessionUsage | null;
    reasoner: SessionUsage;
    /**
     * Accumulated quick-lookup spend (settled lookup loops, duplex only).
     * Absent when no lookup has ever run; carried through restores.
     */
    lookups?: SessionUsage;
  };
}

/**
 * Version 2: the composite artifact (facade-api.md). The log, per-loop
 * histories, per-loop observational states, and the usage breakdown.
 * Sub-agent state is deliberately absent (tasks re-derive from the log's
 * directive/lifecycle entries; resumable tasks are out of scope).
 */
export interface CortexAgentStateV2 {
  version: 2;
  /**
   * The mode of the agent that wrote the artifact. Optional, so artifacts
   * written before it existed still restore (their mode is read off their
   * shape, persistedMode()).
   */
  mode?: CortexAgentMode;
  log: SessionLogEntry[];
  /** Post-slot talker history. Empty for passthrough sessions. */
  talkerHistory: AgentMessage[];
  /** Post-slot reasoner history. */
  reasonerHistory: AgentMessage[];
  /** Talker observational state, order-coupled to talkerHistory. */
  talkerMemory: ObservationalMemoryState | null;
  /** Reasoner observational state, order-coupled to reasonerHistory. */
  reasonerMemory: ObservationalMemoryState | null;
  usage: CortexAgentUsageBreakdown;
  /**
   * Duplex router state that must outlive a restore: the task alias
   * counter, tracked tasks, results logged but not yet handed to the
   * talker, and conversation the reasoner has not seen yet. Optional, so
   * artifacts written before it existed still restore (the alias counter
   * is then recovered from the log). Absent for sessions that never ran
   * duplex.
   */
  router?: DuplexRouterState;
  /**
   * Silent deliveries queued on a resident loop, waiting for its next real
   * prompt. A restore queues them again, so content handed over silently
   * (a result the talker is meant to mention when relevant) is not lost to
   * a persist/restore round trip. Optional, and absent when both queues
   * are empty.
   */
  queuedDeliveries?: CortexAgentQueuedDeliveries;
}

/** Queued silent deliveries per resident loop, oldest first. */
export interface CortexAgentQueuedDeliveries {
  /** Empty for passthrough sessions. */
  talker: string[];
  reasoner: string[];
}

/**
 * Version 1: today's single-loop persistence surface (a conversation
 * history plus optionally observational state and session usage), given a
 * version wrapper so existing sessions upgrade transparently. It restores
 * into the reasoner with an empty talker and a log synthesized from
 * nothing.
 */
export interface CortexAgentStateV1 {
  version: 1;
  history: AgentMessage[];
  /**
   * Both optional fields accept an explicit null so a consumer can build
   * the artifact with a uniform spread. Under exactOptionalPropertyTypes a
   * `SessionUsage | undefined` cannot be assigned to `usage?: SessionUsage`,
   * which forced a conditional spread on one field while the other took a
   * plain `?? null`; treating absent and null alike removes that asymmetry.
   */
  memory?: ObservationalMemoryState | null;
  usage?: SessionUsage | null;
}

/**
 * Compile-time check on that uniformity. A consumer holding both fields as
 * `T | null` must be able to assign both directly; while `usage` was
 * `SessionUsage` only, exactOptionalPropertyTypes rejected the null and
 * forced a conditional spread on one field beside a plain `?? null` on the
 * other. Fails to typecheck if either field stops accepting null.
 */
export type _V1OptionalFieldsAcceptNull = AssertExtends<
  {
    version: 1;
    history: AgentMessage[];
    memory: ObservationalMemoryState | null;
    usage: SessionUsage | null;
  },
  CortexAgentStateV1
>;

/**
 * What restore() accepts: a versioned artifact, or a bare message array
 * (today's rawest persistence shape, treated as v1 history).
 */
export type CortexAgentPersistedState =
  | CortexAgentStateV2
  | CortexAgentStateV1
  | AgentMessage[];

/** Normalize any accepted persisted shape to v2. */
export function normalizePersistedState(state: CortexAgentPersistedState): CortexAgentStateV2 {
  if (Array.isArray(state)) {
    return upgradeV1({ version: 1, history: state });
  }
  if (state.version === 1) {
    return upgradeV1(state);
  }
  if (state.version === 2) {
    return state;
  }
  throw new Error(
    `Unsupported CortexAgent state version: ${String((state as { version: unknown }).version)}`,
  );
}

/**
 * The mode that wrote an artifact: its own record, or for an older
 * artifact its shape (a duplex agent always writes router state and talker
 * usage; a passthrough agent that never restored a duplex artifact writes
 * neither).
 */
export function persistedMode(state: CortexAgentStateV2): CortexAgentMode {
  if (state.mode === 'duplex' || state.mode === 'passthrough') return state.mode;
  const talkerSide = state.router !== undefined
    || state.usage.perLoop.talker !== null
    || state.talkerHistory.length > 0;
  return talkerSide ? 'duplex' : 'passthrough';
}

/** A v1 artifact restores into the reasoner with an empty talker and log. */
function upgradeV1(state: CortexAgentStateV1): CortexAgentStateV2 {
  const usage = state.usage ? cloneSessionUsage(state.usage) : zeroSessionUsage();
  return {
    version: 2,
    log: [],
    talkerHistory: [],
    reasonerHistory: state.history,
    talkerMemory: null,
    reasonerMemory: state.memory ?? null,
    usage: {
      total: cloneSessionUsage(usage),
      perLoop: { talker: null, reasoner: usage },
    },
  };
}
