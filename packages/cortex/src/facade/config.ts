/**
 * CortexAgent consumer configuration and its routing contract: which keys a
 * consumer can set, and where each one lands (docs/cortex/duplex/facade-api.md).
 */

import type { AgentLoopConfig } from '../types.js';
import type { CortexTool } from '../tool-contract.js';
import type { CortexModel } from '../model-wrapper.js';
import type { SandboxProvider } from '../sandbox/types.js';
import type { SandboxConfig } from '../sandbox/options.js';
import type { DuplexRouterOptions } from '../duplex/router-contract.js';

/**
 * Facade mode. `duplex` runs a talker fronting the reasoner; `passthrough`
 * routes everything to the single reasoner loop and reproduces direct
 * AgentLoop behavior exactly (decisions.md D14). An omitted mode is resolved
 * from the loops' backends (facade/mode-resolution.ts, decisions.md D21).
 */
export type CortexAgentMode = 'passthrough' | 'duplex';

/** Talker-loop overrides (duplex mode). */
export interface TalkerConfig {
  /**
   * Talker model. Default: the fast tier resolved from the primary
   * provider (the reasoner's auto-resolved utility model). The talker's
   * toolset is fixed (control tools only, decisions.md D5/D8); consumer
   * tools never route to it.
   */
  model?: CortexModel;
}

/**
 * Duplex tuning: router backpressure and scheduling knobs plus the facade's
 * idle-digestion delay. Every field has a production default; the talker's
 * hard maxTurns is deliberately NOT here (consumer config cannot raise it,
 * decisions.md D17).
 */
export interface DuplexTuningConfig extends Omit<DuplexRouterOptions, 'now'> {
  /**
   * Quiet time after a run completes before the facade digests both loops
   * (pending observation buffers, threshold compaction) outside a prompt.
   * Default: 10000.
   */
  idleDigestionDelayMs?: number;
  /**
   * Concurrent quick-lookup cap: the separate small pool (D13), so a busy
   * task fleet can never starve lookups and vice versa. Default: 2.
   */
  maxConcurrentLookups?: number;
  /**
   * Wall-clock timeout per quick lookup in ms; on expiry the lookup aborts
   * and reports timed_out (visibly, never silently). Default: 30000.
   */
  lookupTimeoutMs?: number;
  /**
   * Aggregate lifetime cost cap in USD across both resident loops, every
   * sub-agent, and utility spend (observer/reflector/summarization).
   * Deliberately its own key: `budgetGuard.maxCost` keeps its per-prompt
   * meaning on the reasoner, and silently reinterpreting that number as a
   * whole-session cap would make the same config mean two different
   * things. Default: Infinity (the aggregate accumulates but never
   * aborts).
   */
  maxTotalCost?: number;
}

/**
 * Every router option a consumer can set, as a compile-time-exhaustive
 * record. The value is ignored; the KEY SET is the contract, and it is what
 * {@link routerOptionsFrom} iterates when it copies tuning into the
 * router.
 *
 * The mapped type is the whole point. `DuplexTuningConfig` extends
 * `Omit<DuplexRouterOptions, 'now'>`, so adding a router option instantly
 * makes it settable by consumers and typechecks at their call site; a
 * hand-written key list would accept the new option and then silently drop
 * it, which is worse than not offering it. The record fails to compile
 * until the new key is listed.
 *
 * `now` is excluded deliberately: it is a test clock, not consumer tuning,
 * and `DuplexTuningConfig` omits it for the same reason.
 */
const ROUTER_TUNING_KEY_SET: {
  [K in keyof Required<Omit<DuplexRouterOptions, 'now'>>]: true;
} = {
  minDeliverySpacingMs: true,
  whenIdleDegradeMs: true,
  idlePollMs: true,
  interruptBucketCapacity: true,
  interruptRefillMs: true,
  deliveryDedupWindowMs: true,
  deliveryDedupMaxEntries: true,
  maxDispatchesPerTurn: true,
  maxDispatchesPerExchange: true,
  watchdogIntervalMs: true,
  delegationMaxAgeMs: true,
  deltaBufferMaxChars: true,
  askTimeoutMs: true,
  escalationAskTimeoutMs: true,
  settleVoiceDelayMs: true,
};

const ROUTER_TUNING_KEYS = Object.keys(ROUTER_TUNING_KEY_SET) as Array<
  keyof typeof ROUTER_TUNING_KEY_SET
>;

/** The router options a consumer's duplex tuning sets, unset keys omitted. */
export function routerOptionsFrom(tuning: DuplexTuningConfig | undefined): DuplexRouterOptions {
  const routerOptions: DuplexRouterOptions = {};
  if (tuning) {
    for (const key of ROUTER_TUNING_KEYS) {
      const value = tuning[key];
      if (value !== undefined) {
        (routerOptions as Record<string, unknown>)[key] = value;
      }
    }
  }
  return routerOptions;
}

/** Session log tuning (retention and subscriber buffering). */
export interface CortexSessionLogConfig {
  /** Retention cap on held entries (see SessionLogOptions.maxEntries). */
  maxEntries?: number;
  /** Per-subscriber buffer bound (see SessionLogOptions.maxSubscriberBuffer). */
  maxSubscriberBuffer?: number;
}

/**
 * Configuration for CortexAgent.create(). Everything AgentLoopConfig has,
 * plus the facade's own keys, routed per {@link CONFIG_ROUTING}.
 */
export interface CortexAgentConfig extends Omit<AgentLoopConfig, 'sandbox'> {
  /** Opt in with true or settings. Cortex owns built-in setup and cleanup. */
  sandbox?: SandboxConfig;
  /** Consumer tools. Routed to the reasoner only (decisions.md D5). */
  tools?: CortexTool[];
  /**
   * Facade mode. Default: passthrough when the talker and the reasoner
   * would share one backend that is not served concurrently
   * (`capabilities.concurrency: 'parallel'`, every hosted provider), with a
   * 'mode-resolved-passthrough' resolution note, and duplex otherwise
   * (D21). An explicit value always wins.
   */
  mode?: CortexAgentMode;
  /** Talker overrides (duplex mode). */
  talker?: TalkerConfig;
  /**
   * Consumer idle signal for the wake policy (duplex mode): is the
   * user/channel idle right now? Advisory; the facade enforces its own
   * minimum inter-delivery spacing, and a held when_idle delivery degrades
   * to interrupt after a configurable delay.
   */
  idleSignal?: () => boolean;
  /** Duplex router and scheduling tuning (duplex mode). */
  duplex?: DuplexTuningConfig;
  /** Session log retention and subscription tuning. */
  sessionLog?: CortexSessionLogConfig;
  /**
   * Debounce for the onStateChanged persistence trigger, in ms.
   * Default: 500.
   */
  stateChangeDebounceMs?: number;
}

// ---------------------------------------------------------------------------
// Config routing
// ---------------------------------------------------------------------------

/**
 * Where a config key lands (docs/cortex/duplex/facade-api.md). In
 * passthrough mode every non-facade destination resolves to the reasoner
 * (it is the only loop); the distinctions below describe what Phase 2b's
 * duplex assembly does with the same key.
 *
 * - `reasoner`: the reasoner loop only; never the talker.
 * - `both-loops`: both resident loops, identical content.
 * - `per-loop`: each loop gets its own value derived from this one.
 * - `shared`: passed to every loop verbatim (environment-level).
 * - `facade`: consumed by the facade itself; never reaches a loop config.
 */
export type ConfigDestination =
  | 'reasoner'
  | 'both-loops'
  | 'per-loop'
  | 'shared'
  | 'facade';

/**
 * The complete config routing table, key by key. This mapped object is the
 * contract: adding a key to AgentLoopConfig or CortexAgentConfig without
 * routing it here is a compile error, so no key can silently diverge
 * (review-findings.md F18). Runtime routing derives from it: 'facade' keys
 * are stripped before the loop config is built.
 */
export type ResolvedCortexAgentConfig = Omit<CortexAgentConfig, 'sandbox'> & { sandbox?: SandboxProvider };

export const CONFIG_ROUTING: { [K in keyof Required<CortexAgentConfig>]: ConfigDestination } = {
  // Reasoner-only: the talker has its own dial (talker.model + a facade
  // thinking default) in 2b.
  model: 'reasoner',
  thinkingLevel: 'reasoner',
  // Consumer tools are wired to the reasoner only (D5); the talker's
  // toolset is the fixed control tools.
  tools: 'reasoner',
  // Both loops, identical content, no per-slot routing (D6).
  slots: 'both-loops',
  // Both loops in full; the talker's role prompt is appended to it in 2b.
  initialBasePrompt: 'both-loops',
  // Both loops run independent compaction managers in 2b; the talker is
  // forced to a non-blocking posture internally.
  compaction: 'both-loops',
  // Reasoner (and sub-agents by inheritance). In 2b the facade adds an
  // aggregate guard across every loop, and the talker gets a facade-set
  // hard maxTurns that consumer config cannot raise. Not added in
  // passthrough: a facade-level guard on a single loop would double-guard
  // today's behavior and break parity.
  budgetGuard: 'reasoner',
  // Reasoner and sub-agents; the talker gets fail-fast defaults in 2b so a
  // transient error never becomes minutes of silence.
  retryPolicy: 'reasoner',
  // Direct passthrough today; the facade permission broker owns it in
  // duplex (2b), and the talker loop receives no resolver at all.
  resolvePermission: 'reasoner',
  // Same broker pipeline as resolvePermission in 2b.
  resolveNetworkAccess: 'reasoner',
  // Facade broker input in 2b (bypasses voicing when set); reasoner today.
  isAutoApprove: 'reasoner',
  // Reasoner and sub-agents.
  toolExecution: 'reasoner',
  disableTools: 'reasoner',
  // Reasoner and sub-agents (the talker has no read tools). The facade's
  // quick-lookup loops get their own facade-set allowlist regardless.
  readPathAllowlist: 'reasoner',
  // MCP projects to the reasoner (and its sub-agents via tool closures),
  // never the talker. In duplex the facade supplies a shared manager here
  // when the consumer did not: one connection per server total.
  mcpClientManager: 'reasoner',
  deferredTools: 'reasoner',
  toolResultThresholds: 'reasoner',
  webFetch: 'reasoner',
  bash: 'reasoner',
  // Both loops (the talker uses working tags to separate thinking from
  // speech in 2b).
  workingTags: 'both-loops',
  // Per loop: the same consumer number on each loop, clamped separately
  // against each loop's own model window and floor. The limit is a
  // compaction budget, and the talker holds the real conversation, so a
  // reasoner-only limit lets the surface that grows fastest ignore the cap
  // the consumer set. D6's rule (the consumer never routes per loop)
  // applies here too: a knob that silently reaches one loop is the
  // divergence that rule exists to prevent.
  contextWindowLimit: 'per-loop',
  // Per loop, subject to the same-provider constraint each loop enforces on
  // itself: copied to the talker when it shares the talker's provider (the
  // common case, since the talker defaults to the fast tier of the primary
  // provider), and skipped with a warning when it does not, because a loop
  // rejects a utility model from another provider outright.
  utilityModel: 'per-loop',
  // Reasoner pool config; quick lookups get a separate facade-owned pool
  // in 2b.
  maxConcurrentSubAgents: 'reasoner',
  subAgentPools: 'reasoner',
  onBeforeSubAgentSpawn: 'reasoner',
  canSpawnSubAgent: 'reasoner',
  // Long-lived loop posture. Consumer value applies to the reasoner; the
  // facade sets the talker's own posture in 2b.
  persistentRuntime: 'reasoner',
  // Shared environment-level wiring, passed to every loop verbatim.
  getApiKey: 'shared',
  ambientCredentials: 'shared',
  sandbox: 'shared',
  envOverrides: 'shared',
  logger: 'shared',
  workingDirectory: 'shared',
  diagnostics: 'shared',
  // Shared; the loop stamps origin (loopPath) into persistence metadata.
  persistResult: 'shared',
  // The facade derives distinct stable per-loop cache ids from it in 2b.
  // The reasoner keeps the bare consumer id in both modes, so a session
  // that flips modes keeps its reasoner prefix cache warm.
  sessionId: 'per-loop',
  // Passthrough keeps the consumer's loop path (default 'main') so origin
  // context matches direct AgentLoop use exactly; the 2b duplex assembly
  // overrides per loop ('talker' / 'reasoner').
  loopPath: 'per-loop',
  // Facade-owned keys, never part of a loop config.
  mode: 'facade',
  talker: 'facade',
  idleSignal: 'facade',
  duplex: 'facade',
  sessionLog: 'facade',
  stateChangeDebounceMs: 'facade',
};

/**
 * Build the reasoner's AgentLoop config from consumer config by dropping
 * the facade-owned keys. Every other key flows through unchanged: in
 * passthrough the reasoner is the only loop, so 'both-loops', 'per-loop',
 * and 'shared' destinations all resolve to it. Exported for tests.
 */
export function buildReasonerConfig(
  config: ResolvedCortexAgentConfig,
): AgentLoopConfig & { tools?: CortexTool[] } {
  const routed: Record<string, unknown> = {};
  for (const key of Object.keys(CONFIG_ROUTING) as Array<keyof CortexAgentConfig>) {
    if (CONFIG_ROUTING[key] === 'facade') continue;
    if (key in config) {
      routed[key] = config[key];
    }
  }
  return routed as unknown as AgentLoopConfig & { tools?: CortexTool[] };
}
