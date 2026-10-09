/**
 * Compaction: keeps every request inside the context window.
 *
 * Runs inside transformContext, before every LLM call:
 *
 * - Observational memory swaps observed messages out of history for their
 *   observations in the `_observations` slot (observational/index.ts).
 * - Layer 1 (microcompaction) trims large tool results in what remains,
 *   cache-aware so a warm prompt cache is not thrown away.
 * - Layer 3 (failsafe) cuts the request's view when it would still not fit;
 *   the source keeps every message, so the observer still reads them.
 *
 * After the provider rejects a request as too long, handleOverflowError
 * shrinks the source itself, recording any messages memory never saw.
 *
 * References:
 *   - observational-memory-architecture.md
 *   - compaction-strategy.md
 */

import type { AgentMessage, AgentContext } from '../context-manager.js';
import type { CortexLogger, CortexCompactionConfig } from '../types.js';
import { NOOP_LOGGER } from '../noop-logger.js';
import { estimateTokens } from '../token-estimator.js';
import { MicrocompactionEngine, MICROCOMPACTION_DEFAULTS } from './microcompaction.js';
import { extractTextContent } from './tool-messages.js';
import { FAILSAFE_DEFAULTS } from './failsafe.js';
import { ObservationalMemoryEngine } from './observational/index.js';
import type { ObservationalMemory } from './observational/index.js';
import type { CompactNowOptions, CompactNowResult, ObserveNowResult } from './observational/types.js';
import { resolvePromptCacheTtlMs } from '../provider-registry.js';
import type { CacheRetention } from '../provider-registry.js';
import type { ModelPromptCacheLifetimes } from '../model-wrapper.js';

// ---------------------------------------------------------------------------
// Re-exports for consumer convenience
// ---------------------------------------------------------------------------

export { MicrocompactionEngine, capToolResult } from './microcompaction.js';
export type { TrimAction, TrimState } from './microcompaction.js';
export type { CompleteFn } from './observational/types.js';
export { isContextOverflow } from './failsafe.js';
export { ObservationalMemoryEngine } from './observational/index.js';
export type { ObservationalMemory } from './observational/index.js';
export type {
  ObservationalMemoryConfig,
  ObservationalMemoryState,
  ObservationChunk,
  ObservationEvent,
  ReflectionEvent,
  RecallResult,
  RecallConfig,
  MemoryCallTrigger,
  MemoryErrorInfo,
  MemoryRecoveredInfo,
  MemoryGapInfo,
  MemoryEventPayload,
  CompactNowOptions,
  CompactNowResult,
  ObserveNowResult,
  ReflectionOutcome,
} from './observational/types.js';
export { createRecallTool } from './observational/recall-tool.js';

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

/**
 * After the provider rejects a request as too long, history shrinks to fit
 * this fraction of capacity. The only lossy step, so it drops the minimum;
 * in-band view truncation then holds later requests under the ceiling.
 */
const OVERFLOW_TARGET_RATIO = 0.8;

const NO_INJECTIONS: ReadonlySet<AgentMessage> = new Set();

/** Options for one transform pass (see CompactionManager.applyInTransformContext). */
export interface TransformPassOptions {
  /** Overrides the configured nonBlocking posture for this pass. */
  allowBlocking?: boolean;
  /** Whether the pass was abandoned (a timed-out or preempted digestion). */
  isStale?: () => boolean;
  /** The run's abort: ends the pass's memory calls. */
  signal?: AbortSignal;
  /**
   * The messages the caller added to this request's view only (ephemeral
   * context, loaded skills, task state, a headline). The failsafe never
   * drops them, and drops every other message before the tail whole.
   */
  injections?: ReadonlySet<AgentMessage>;
  /**
   * Re-derive the request's view after a swap rewrote the source: the
   * rewritten history with the caller's injections and the current
   * observation slot. Omitted, the view becomes the source history as it
   * stands, which suits a caller that adds nothing to it.
   */
  rebuildView?: () => { context: AgentContext; injections: ReadonlySet<AgentMessage> };
}

export const DEFAULT_COMPACTION_CONFIG: CortexCompactionConfig = {
  microcompaction: MICROCOMPACTION_DEFAULTS,
  failsafe: FAILSAFE_DEFAULTS,
};

/**
 * Build a full compaction config from partial overrides.
 *
 * Always returns fresh objects, never the shared defaults: a loop writes its
 * own persistResult into the microcompaction settings, which would otherwise
 * leak into every later loop in the process.
 *
 * Throws on the classic strategy's settings (`strategy: 'classic'`, a
 * `compaction` or `adaptive` section): classic compaction was removed, and
 * ignoring them would leave a consumer believing it still runs.
 */
export function buildCompactionConfig(
  partial?: Partial<CortexCompactionConfig>,
): CortexCompactionConfig {
  rejectClassicSettings(partial);
  const config: CortexCompactionConfig = {
    microcompaction: {
      ...MICROCOMPACTION_DEFAULTS,
      ...partial?.microcompaction,
    },
    failsafe: {
      ...FAILSAFE_DEFAULTS,
      ...partial?.failsafe,
    },
  };
  if (partial?.nonBlocking !== undefined) config.nonBlocking = partial.nonBlocking;
  if (partial?.observational !== undefined) config.observational = partial.observational;
  return config;
}

function rejectClassicSettings(partial: Partial<CortexCompactionConfig> | undefined): void {
  if (!partial) return;
  const legacy = partial as Record<string, unknown>;
  const removed: string[] = [];
  if (legacy['strategy'] !== undefined && legacy['strategy'] !== 'observational') removed.push(`strategy: '${String(legacy['strategy'])}'`);
  if (legacy['compaction'] !== undefined) removed.push('compaction');
  if (legacy['adaptive'] !== undefined) removed.push('adaptive');
  if (removed.length === 0) return;
  throw new Error(
    `Classic compaction was removed; observational memory is the only strategy. Remove ${removed.join(', ')} from the compaction config.`,
  );
}

// ---------------------------------------------------------------------------
// CompactionManager
// ---------------------------------------------------------------------------

/**
 * CompactionManager runs observational memory, Layer 1 and Layer 3.
 *
 * It is stateful: it tracks the current token count and the microcompaction
 * cache. The AgentLoop creates one instance and delegates all compaction
 * decisions to it. Compaction is fully autonomous: every layer runs inside
 * applyInTransformContext(), which fires before every LLM call.
 */
export class CompactionManager {
  private readonly config: CortexCompactionConfig;
  private readonly microcompaction: MicrocompactionEngine;
  private readonly historyStart: number;
  private readonly observationalEngine: ObservationalMemoryEngine;
  /**
   * Observational memory's configuration, events, state and status. Its
   * context-rewriting passes run through this manager instead.
   */
  readonly memory: ObservationalMemory;

  /** Post-hoc current-context token count, updated after each parent LLM call. */
  private _currentContextTokenCount = 0;

  /** The effective context window compaction keeps requests inside (may be artificially limited). */
  private _contextWindow = 0;

  /** Actual model context window for Layer 3 failsafe (never artificially limited). */
  private _modelContextWindow = 0;

  /**
   * Timestamp (ms) of the last LLM call. Used by L1 to decide whether the
   * prompt cache has gone cold. Updated automatically in
   * updateCurrentContextTokenCount() (which fires after every LLM response).
   * Null means no LLM call has been recorded yet (treated as cold).
   */
  private _lastLlmCallTimestamp: number | null = null;

  /**
   * Effective cache TTL (ms) for the current provider + cache retention.
   * Zero means caching is unsupported or disabled, in which case L1 treats
   * the cache as perpetually cold (trim freely). Set via setCacheInfo().
   */
  private _providerCacheTtlMs = 0;
  private _automaticPrefixCache = false;

  /**
   * Tokens outside history (system prompt, slots, tools, injections) in the
   * last transform pass: what an overflow drop must leave room for when no
   * measured count is available.
   */
  private lastOverheadTokens = 0;

  /** Logger for compaction diagnostics. */
  private logger: CortexLogger = NOOP_LOGGER;

  constructor(
    config: CortexCompactionConfig,
    historyStart: number,
  ) {
    this.config = config;
    this.historyStart = historyStart;
    this.microcompaction = new MicrocompactionEngine(config.microcompaction);
    this.observationalEngine = new ObservationalMemoryEngine(config.observational ?? {});
    this.memory = this.observationalEngine;
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  /**
   * Set the context budget: the effective window compaction keeps requests
   * inside. This may be smaller than the model's actual context window when
   * a user-configured limit is applied.
   */
  setContextWindow(contextWindow: number): void {
    this._contextWindow = contextWindow;
    this.observationalEngine.setContextWindow(contextWindow);
  }

  /**
   * Set the model's actual context window: the capacity an overflow drop
   * shrinks below after the provider rejected a request.
   *
   * Also used as a proxy for the utility model context window until the
   * actual utility model window is set via memory.setUtilityModelContextWindow().
   */
  setModelContextWindow(modelContextWindow: number): void {
    this._modelContextWindow = modelContextWindow;
    this.observationalEngine.setUtilityModelContextWindow(modelContextWindow);
  }

  /**
   * Set a logger for compaction diagnostics.
   */
  setLogger(logger: CortexLogger): void {
    this.logger = logger;
    this.observationalEngine.setLogger(logger);
  }

  /**
   * Set the active provider and cache retention. Resolves the effective
   * cache TTL (the model's own promptCache lifetimes first, then
   * PROVIDER_CACHE_CONFIG) and stores it for L1's cache-aware gating.
   * Called by AgentLoop at construction, on model changes, and on cache
   * retention changes.
   *
   * @param provider - The active provider name (e.g., "anthropic", "openai")
   * @param cacheRetention - The configured cache retention ('none' | 'short' | 'long')
   * @param promptCaching - The model's caching mode, when it is automatic-prefix
   * @param modelPromptCache - The model's lifetimes per tier (pi-ai's Model.promptCache)
   */
  setCacheInfo(
    provider: string,
    cacheRetention: CacheRetention,
    promptCaching?: 'automatic-prefix',
    modelPromptCache?: ModelPromptCacheLifetimes,
  ): void {
    this._automaticPrefixCache = promptCaching === 'automatic-prefix';
    this._providerCacheTtlMs = resolvePromptCacheTtlMs(provider, cacheRetention, modelPromptCache);
  }

  /**
   * Check whether the prompt cache has gone cold (or is unused).
   *
   * Returns true when:
   *   - Caching is unsupported / disabled (TTL <= 0), OR
   *   - No LLM call has been recorded yet, OR
   *   - The elapsed time since the last LLM call >= the cache TTL.
   *
   * @param now - Current timestamp (ms), injectable for testing
   */
  isCacheCold(now: number = Date.now()): boolean {
    if (this._providerCacheTtlMs <= 0) return true;
    if (this._lastLlmCallTimestamp === null) return true;
    return (now - this._lastLlmCallTimestamp) >= this._providerCacheTtlMs;
  }

  /** Prefix preservation is a trimming policy, not a claim that the server cache is warm. */
  shouldTrimHistory(tokens: number): boolean {
    if (!this._automaticPrefixCache) return this.isCacheCold();
    return this._contextWindow > 0 && tokens >= this._contextWindow * this.config.microcompaction.prefixTrimRatio;
  }

  /** Effective explicit cache TTL. Zero also covers automatic caches with unknown lifetime. */
  get providerCacheTtlMs(): number {
    return this._providerCacheTtlMs;
  }

  /**
   * Get the timestamp of the last LLM call, or null if none recorded.
   */
  get lastLlmCallTimestamp(): number | null {
    return this._lastLlmCallTimestamp;
  }

  // -----------------------------------------------------------------------
  // Token Tracking
  // -----------------------------------------------------------------------

  /**
   * Update the post-hoc current-context token count from LLM usage data.
   */
  updateCurrentContextTokenCount(inputTokens: number): void {
    const prev = this._currentContextTokenCount;
    this._currentContextTokenCount = inputTokens;
    // Track the LLM call timestamp so L1 can decide whether the prompt cache
    // is still warm. updateCurrentContextTokenCount() is called after every
    // parent LLM call, so this is the natural point to record it.
    this._lastLlmCallTimestamp = Date.now();
    this.logger.debug('[Compaction] updateCurrentContextTokenCount', { prev, inputTokens });
    // Log significant drops to help diagnose token count display issues
    if (prev > 0 && inputTokens < prev * 0.5) {
      this.logger.warn('[Compaction] currentContextTokenCount dropped >50%', {
        prev,
        inputTokens,
        drop: `${((1 - inputTokens / prev) * 100).toFixed(1)}%`,
      });
    }
  }

  /**
   * Forget the post-hoc count after compaction rewrote the source history:
   * it measured a context that no longer exists. Estimates fall back to the
   * heuristic until the next parent turn measures again.
   */
  invalidateContextTokenCount(): void {
    this.logger.debug('[Compaction] context token count invalidated by a history rewrite', {
      prev: this._currentContextTokenCount,
    });
    this._currentContextTokenCount = 0;
  }

  /**
   * Get the post-hoc current-context token count from the most recent parent turn.
   */
  get currentContextTokenCount(): number {
    return this._currentContextTokenCount;
  }

  /**
   * Get the context budget (the effective window).
   */
  get contextWindow(): number {
    return this._contextWindow;
  }

  /**
   * Get the model's actual context window.
   */
  get modelContextWindow(): number {
    return this._modelContextWindow;
  }

  /**
   * Get the current context usage ratio.
   */
  get usageRatio(): number {
    if (this._contextWindow <= 0) return 0;
    return this._currentContextTokenCount / this._contextWindow;
  }

  /**
   * Estimate current context tokens from a transformed AgentContext snapshot.
   *
   * Returns the larger of:
   * - the heuristic estimate of the provided context snapshot
   * - the post-hoc token count from the most recent parent turn
   *
   * This mirrors the compaction decision logic so consumers can reason about
   * context pressure using the same semantics Cortex uses internally.
   */
  estimateCurrentContextTokens(context: AgentContext): number {
    const estimated = this.estimateContextTokens(context);
    return this._currentContextTokenCount > 0
      ? Math.max(this._currentContextTokenCount, estimated)
      : estimated;
  }

  // -----------------------------------------------------------------------
  // Observational Memory
  // -----------------------------------------------------------------------

  /**
   * Swap observations in now, whatever the utilization (see
   * ObservationalMemoryEngine.compactNow). The caller holds the loop's gate.
   *
   * @param tokensBefore - the context's estimated size now
   */
  async compactNow(
    getSource: () => AgentMessage[],
    setSource: (history: AgentMessage[]) => void,
    options: CompactNowOptions & { tokensBefore: number },
  ): Promise<CompactNowResult> {
    const result = await this.observationalEngine.compactNow(getSource, setSource, options);
    // The measured context no longer exists.
    if (result.status === 'compacted') this.invalidateContextTokenCount();
    return result;
  }

  /**
   * Record everything not yet in the log, removing nothing (see
   * ObservationalMemoryEngine.observeNow). The caller holds the loop's gate.
   *
   * @param tokensBefore - the context's estimated size now
   */
  async observeNow(
    getSource: () => AgentMessage[],
    options: { tokensBefore: number; signal?: AbortSignal },
  ): Promise<ObserveNowResult> {
    const result = await this.observationalEngine.observeNow(getSource, options);
    // The slot grew: the measured context no longer exists.
    if (result.status === 'observed') this.invalidateContextTokenCount();
    return result;
  }

  // -----------------------------------------------------------------------
  // Insertion-time cap
  // -----------------------------------------------------------------------

  /**
   * Cap a tool result at insertion time (before it enters conversation history).
   */
  capToolResult(content: string): string {
    return this.microcompaction.capAtInsertion(content);
  }

  /**
   * Apply the insertion-time cap to every uncapped tool result in the
   * source messages, in place (see MicrocompactionEngine.capInsertedResults).
   */
  applyInsertionCap(
    messages: AgentMessage[],
    historyStart: number,
    isStale?: () => boolean,
  ): Promise<void> {
    return this.microcompaction.capInsertedResults(messages, historyStart, isStale);
  }

  // -----------------------------------------------------------------------
  // transformContext hook
  // -----------------------------------------------------------------------

  /**
   * Apply compaction to the context in transformContext.
   *
   * The main entry point, called from AgentLoop.getTransformContextHook().
   * Fully self-contained: every layer runs here, triggered by token
   * thresholds, before every LLM call.
   *
   * Execution order:
   * 1. Observational memory: past the activation threshold, swap observed
   *    messages out of the source for their observations
   * 2. Layer 1 (microcompaction): trim large tool results in the view,
   *    cache-aware
   * 3. Layer 3 (failsafe): past the emergency ceiling, cut the view; the
   *    source keeps every message
   *
   * @param context - The AgentContext from transformContext
   * @param getHistory - Function to get conversation history from the context
   * @param setHistory - Function to set conversation history in the context
   * @param getSourceHistory - Function to get the original source transcript history (post-slot)
   * @param setSourceHistory - Function to replace the original source
   *   transcript history; returns false when the owner discarded the rewrite
   * @param options - allowBlocking overrides the configured nonBlocking
   *   posture for this call (an idle-digestion entry point runs the
   *   synchronous work deliberately). Omitted: the config decides.
   *   isStale reports whether the pass has been abandoned (a timed-out
   *   digestIdle advanced the generation): a stale pass's history rewrite
   *   is discarded by the owner's setSourceHistory guard, and this hook
   *   suppresses the matching event dispatch, so a consumer never sees an
   *   observation reported for a rewrite that never landed.
   *   signal is the run's abort, which ends the pass's memory calls.
   *   injections are the view's request-only messages.
   * @returns Modified context with compacted history
   */
  async applyInTransformContext(
    context: AgentContext,
    getHistory: (ctx: AgentContext) => AgentMessage[],
    setHistory: (ctx: AgentContext, history: AgentMessage[]) => AgentContext,
    getSourceHistory: () => AgentMessage[],
    setSourceHistory: (history: AgentMessage[]) => boolean | void,
    options?: TransformPassOptions,
  ): Promise<AgentContext> {
    // pi requires transformContext never to throw. Every layer keeps its
    // state coherent on its own, so a failure here sends the request as it
    // stands rather than failing the run.
    try {
      return await this.applyLayers(context, getHistory, setHistory, getSourceHistory, setSourceHistory, options);
    } catch (err) {
      this.logger.error('[Compaction] transformContext pass failed; sending the context unchanged', {
        error: err instanceof Error ? err.message : String(err),
      });
      return context;
    }
  }

  private async applyLayers(
    context: AgentContext,
    getHistory: (ctx: AgentContext) => AgentMessage[],
    setHistory: (ctx: AgentContext, history: AgentMessage[]) => AgentContext,
    getSourceHistory: () => AgentMessage[],
    setSourceHistory: (history: AgentMessage[]) => boolean | void,
    options?: TransformPassOptions,
  ): Promise<AgentContext> {
    if (this._contextWindow <= 0) {
      // contextWindow not set, skip compaction
      return context;
    }

    // Non-blocking posture: no synchronous LLM call may run in-band. Only
    // mechanical work (chunk activation, L1 trimming, L3 truncation) is
    // allowed unless the caller explicitly re-enables blocking work.
    const allowBlocking = options?.allowBlocking ?? !(this.config.nonBlocking ?? false);
    const isStale = options?.isStale;

    let history = getHistory(context);
    if (history.length === 0) {
      return context;
    }

    // Use the current transformed context estimate as a first-class input.
    // Post-hoc token tracking from the previous turn is useful, but it can be
    // stale when transformContext injects large ephemeral content on this turn.
    const currentTokens = this.estimateCurrentContextTokens(context);

    this.logger.debug('[Compaction] transformContext', {
      historyLen: history.length,
      currentContextTokens: this._currentContextTokenCount,
      currentTokens,
      ctxWindow: this._contextWindow,
    });

    // Observational memory: the observer and reflector compress history. A
    // landed rewrite makes the last measured input size describe a context
    // that no longer exists.
    const writeSource = (rewritten: AgentMessage[]): boolean | void => {
      const landed = setSourceHistory(rewritten);
      if (landed !== false) this.invalidateContextTokenCount();
      return landed;
    };
    const utilization = currentTokens / this._contextWindow;
    const rewritten = await this.observationalEngine.applyInTransformContext(
      utilization, getSourceHistory, writeSource,
      {
        allowSync: allowBlocking,
        ...(isStale ? { isStale } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    // A swap rewrote the source under the view: re-derive it. Without one
    // the view stands as the caller built it, injections included.
    let injections = options?.injections ?? NO_INJECTIONS;
    if (rewritten) {
      const rebuilt = options?.rebuildView?.()
        ?? { context: setHistory(context, getSourceHistory()), injections: NO_INJECTIONS };
      context = rebuilt.context;
      injections = rebuilt.injections;
    }
    history = getHistory(context);

    // Layer 1 on the surviving history. Cache-aware gating trims only when
    // the prompt cache has gone cold, preserving cache hits during active
    // use. Re-estimate from the updated context so the observation slot's
    // new size is reflected, and so L3 below measures the context this call
    // will actually send.
    const postObsTotal = this.estimateCurrentContextTokens(context);
    const slotTokens = Math.max(0, postObsTotal - this.estimateHistoryTokens(history));
    const trimmedHistory = await this.microcompaction.apply(
      history, this._contextWindow, postObsTotal, { cacheCold: this.shouldTrimHistory(postObsTotal) },
    );
    if (trimmedHistory !== history) {
      context = setHistory(context, trimmedHistory);
      history = trimmedHistory;
    }

    // Layer 3: the view only, near the full effective window. The source
    // keeps every message and the observer still reads them, so a context
    // that will not fit loses nothing; it is shown less for this request,
    // with a note saying so.
    this.lastOverheadTokens = slotTokens;
    const ceiling = this._contextWindow * this.config.failsafe.threshold;
    if (slotTokens + this.estimateHistoryTokens(history) >= ceiling) {
      const truncated = this.observationalEngine.truncateView(
        history, injections, Math.max(0, ceiling - slotTokens),
      );
      if (truncated) {
        this.logger.warn('[Compaction] context over the emergency ceiling; older messages are not shown this request', {
          shown: truncated.length - 1,
          of: history.length,
        });
        history = truncated;
      }
    }
    return setHistory(context, history);
  }

  // -----------------------------------------------------------------------
  // Reactive overflow handling
  // -----------------------------------------------------------------------

  /**
   * Shrink the source after the provider rejected a request as too long.
   *
   * The estimate was optimistic, so history shrinks well below capacity.
   * Observed messages leave as in any swap; unobserved ones that do not fit
   * are dropped and the log records the gap.
   *
   * @param getHistory - Get current conversation history
   * @param setHistory - Replace conversation history
   */
  handleOverflowError(
    getHistory: () => AgentMessage[],
    setHistory: (history: AgentMessage[]) => void,
  ): void {
    const history = getHistory();
    if (history.length === 0) return;

    const capacity = this._modelContextWindow > 0 ? this._modelContextWindow : this._contextWindow;
    const historyTokens = this.estimateHistoryTokens(history);
    const overhead = Math.max(this._currentContextTokenCount - historyTokens, this.lastOverheadTokens);
    const rewritten = this.observationalEngine.dropForOverflow(
      history,
      Math.max(0, capacity * OVERFLOW_TARGET_RATIO - overhead),
      overhead + historyTokens,
    );
    if (rewritten) {
      setHistory(rewritten);
      this.microcompaction.resetCache();
      this.invalidateContextTokenCount();
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Stop in-flight memory work and clear the token state.
   */
  destroy(): void {
    this.microcompaction.resetCache();
    this.observationalEngine.abort();
    this._currentContextTokenCount = 0;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Estimate tokens for a set of history messages.
   */
  private estimateHistoryTokens(history: AgentMessage[]): number {
    return estimateTokens(
      history.map(m => extractTextContent(m)).join('\n'),
    );
  }

  /**
   * Estimate total context tokens from an AgentContext object.
   */
  private estimateContextTokens(context: AgentContext): number {
    let total = estimateTokens(context.systemPrompt);
    for (const msg of context.messages) {
      total += estimateTokens(extractTextContent(msg));
    }
    return total;
  }
}
