/**
 * Compaction composition: wires all three layers into the transformContext chain.
 *
 * Layer 1 (Microcompaction): tool result trimming at threshold crossings
 * Layer 2 (Compaction): conversation summarization via LLM
 * Layer 3 (Failsafe): emergency truncation, purely mechanical
 *
 * All three layers run inside transformContext, which fires before every LLM
 * call. Compaction is fully self-contained within Cortex; no external calls
 * from the backend are needed to trigger it. Layer 2 fires when token usage
 * exceeds 70% of the context window and a completeFn + source accessors are
 * provided. Layer 3 fires whenever tokens exceed 90% of the model's context
 * window.
 *
 * References:
 *   - compaction-strategy.md
 *   - phase-5-compaction.md (5.5)
 */

import type { AgentMessage, AgentContext } from '../context-manager.js';
import type {
  CortexLogger,
  CortexCompactionConfig,
  AdaptiveThresholdConfig,
  CompactionResult,
  CompactionTarget,
  CompactionDegradedInfo,
  CompactionExhaustedInfo,
} from '../types.js';
import { NOOP_LOGGER } from '../noop-logger.js';
import { estimateTokens } from '../token-estimator.js';
import { MicrocompactionEngine, MICROCOMPACTION_DEFAULTS, extractTextContent, isToolResultMessage, capToolResult, extractToolName, getToolCategory, applyBookend } from './microcompaction.js';
import {
  runCompaction,
  shouldCompact,
  COMPACTION_DEFAULTS,
} from './compaction.js';
import type { CompleteFn, BeforeCompactionHandler, PostCompactionHandler, CompactionErrorHandler } from './compaction.js';
import {
  emergencyTruncate,
  shouldTruncate,
  FAILSAFE_DEFAULTS,
} from './failsafe.js';
import { ObservationalMemoryEngine } from './observational/index.js';
import type { ObservationalMemoryConfig, ObservationalMemoryState, ObservationEvent, ReflectionEvent } from './observational/types.js';
import { resolvePromptCacheTtlMs } from '../provider-registry.js';
import type { CacheRetention } from '../provider-registry.js';
import type { ModelPromptCacheLifetimes } from '../model-wrapper.js';

// ---------------------------------------------------------------------------
// Re-exports for consumer convenience
// ---------------------------------------------------------------------------

export { MicrocompactionEngine, capToolResult } from './microcompaction.js';
export type { TrimAction, TrimState } from './microcompaction.js';
export { runCompaction, shouldCompact, partitionHistory, buildSummaryMessage } from './compaction.js';
export type { CompleteFn } from './compaction.js';
export { emergencyTruncate, shouldTruncate, isContextOverflow } from './failsafe.js';
export type { FailsafeTruncationResult } from './failsafe.js';
export { ObservationalMemoryEngine } from './observational/index.js';
export type { ObservationalMemoryConfig, ObservationalMemoryState, ObservationChunk, ObservationEvent, ReflectionEvent, RecallResult, RecallConfig } from './observational/types.js';
export { createRecallTool } from './observational/recall-tool.js';
// computeAdaptiveThreshold is defined below in this file and exported at the declaration site

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const ADAPTIVE_DEFAULTS: AdaptiveThresholdConfig = {
  enabled: true,
  recentWindowMs: 300_000,     // 5 minutes
  idleWindowMs: 1_800_000,     // 30 minutes
  recentReduction: 0.0,        // no change when recent
  moderateReduction: 0.10,     // lower threshold by 0.10 when moderately idle
  idleReduction: 0.20,         // lower threshold by 0.20 when fully idle
};

export const DEFAULT_COMPACTION_CONFIG: CortexCompactionConfig = {
  microcompaction: MICROCOMPACTION_DEFAULTS,
  compaction: COMPACTION_DEFAULTS,
  failsafe: FAILSAFE_DEFAULTS,
  adaptive: ADAPTIVE_DEFAULTS,
};

/**
 * Build a full compaction config from partial overrides.
 *
 * Always returns fresh objects, never the shared defaults: a loop writes its
 * own persistResult into the microcompaction settings, which would otherwise
 * leak into every later loop in the process.
 */
export function buildCompactionConfig(
  partial?: Partial<CortexCompactionConfig>,
): CortexCompactionConfig {
  const config: CortexCompactionConfig = {
    microcompaction: {
      ...MICROCOMPACTION_DEFAULTS,
      ...partial?.microcompaction,
    },
    compaction: {
      ...COMPACTION_DEFAULTS,
      ...partial?.compaction,
    },
    failsafe: {
      ...FAILSAFE_DEFAULTS,
      ...partial?.failsafe,
    },
    adaptive: {
      ...ADAPTIVE_DEFAULTS,
      ...partial?.adaptive,
    },
  };
  if (!partial) return config;

  if (partial.strategy !== undefined) {
    config.strategy = partial.strategy;
  }

  if (partial.nonBlocking !== undefined) {
    config.nonBlocking = partial.nonBlocking;
  }

  if (partial.observational !== undefined) {
    config.observational = partial.observational;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Adaptive threshold calculation
// ---------------------------------------------------------------------------

/**
 * Compute the effective Layer 2 compaction threshold adjusted by interaction
 * recency. When the user has not interacted recently, the threshold is lowered
 * (i.e., compaction fires sooner), reducing token costs for idle sessions.
 *
 * @param baseThreshold - The configured Layer 2 threshold (e.g., 0.70)
 * @param adaptiveConfig - Adaptive threshold configuration
 * @param lastInteractionTime - Timestamp (ms) of the last user interaction, or null if never
 * @param now - Current timestamp (ms), injectable for testing
 * @returns The adjusted threshold (always >= 0)
 */
export function computeAdaptiveThreshold(
  baseThreshold: number,
  adaptiveConfig: AdaptiveThresholdConfig,
  lastInteractionTime: number | null,
  now: number = Date.now(),
): number {
  if (!adaptiveConfig.enabled) {
    return baseThreshold;
  }

  // No interaction recorded yet: treat as fully idle
  if (lastInteractionTime === null) {
    return Math.max(0, baseThreshold - adaptiveConfig.idleReduction);
  }

  const elapsed = now - lastInteractionTime;

  if (elapsed < adaptiveConfig.recentWindowMs) {
    // Recent interaction: apply recentReduction (default 0, no change)
    return Math.max(0, baseThreshold - adaptiveConfig.recentReduction);
  }

  if (elapsed < adaptiveConfig.idleWindowMs) {
    // Moderate idle: apply moderateReduction
    return Math.max(0, baseThreshold - adaptiveConfig.moderateReduction);
  }

  // Fully idle: apply idleReduction
  return Math.max(0, baseThreshold - adaptiveConfig.idleReduction);
}

// ---------------------------------------------------------------------------
// CompactionManager
// ---------------------------------------------------------------------------

/**
 * CompactionManager orchestrates all three compaction layers.
 *
 * It is stateful: it tracks the current token count and the microcompaction
 * cache. The AgentLoop creates one instance and delegates all compaction
 * decisions to it. Compaction is fully autonomous: all three layers run
 * inside applyInTransformContext(), which fires before every LLM call.
 */
export class CompactionManager {
  private readonly config: CortexCompactionConfig;
  private readonly microcompaction: MicrocompactionEngine;
  private readonly historyStart: number;
  private readonly _strategy: 'observational' | 'classic';
  private observationalEngine: ObservationalMemoryEngine | null = null;

  /** Post-hoc current-context token count, updated after each parent LLM call. */
  private _currentContextTokenCount = 0;

  /** Context budget for Layer 1/2 compaction decisions (may be artificially limited). */
  private _contextWindow = 0;

  /** Actual model context window for Layer 3 failsafe (never artificially limited). */
  private _modelContextWindow = 0;

  /**
   * Timestamp (ms) of the last user interaction. Used by the adaptive
   * threshold system to decide how aggressively to compact. Updated by
   * the consumer (backend) when a message-triggered tick fires.
   * Null means no interaction has been recorded yet.
   */
  private _lastInteractionTime: number | null = null;

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
   * Consumer handlers for compaction lifecycle events. **These are the live
   * ones.** `AgentLoop` used to declare four fields with identical names that
   * were pushed to, reset, and never fired, because its `onBeforeCompaction`
   * and friends register here and this is where they run. Those namesakes
   * were deleted as dead storage; do not read a stale memory of that deletion
   * as covering these. Grepping the names is what makes this confusable in
   * both directions: it used to return a wall of live hits that made the dead
   * fields look load-bearing, and it can now return these and make them look
   * like leftovers.
   */
  private beforeCompactionHandlers: BeforeCompactionHandler[] = [];
  private postCompactionHandlers: PostCompactionHandler[] = [];
  private compactionErrorHandlers: CompactionErrorHandler[] = [];
  private compactionResultHandlers: Array<(result: CompactionResult) => void> = [];
  private compactionDegradedHandlers: Array<(info: CompactionDegradedInfo) => void> = [];
  private compactionExhaustedHandlers: Array<(info: CompactionExhaustedInfo) => void> = [];

  /** Consecutive Layer 2 failure count for circuit breaker. Reset on success. */
  private _consecutiveLayer2Failures = 0;

  /** LLM completion function, set by AgentLoop. */
  private completeFn: CompleteFn | null = null;

  /** Logger for compaction diagnostics. */
  private logger: CortexLogger = NOOP_LOGGER;

  constructor(
    config: CortexCompactionConfig,
    historyStart: number,
  ) {
    this.config = config;
    this.historyStart = historyStart;
    this.microcompaction = new MicrocompactionEngine(config.microcompaction);
    this._strategy = config.strategy ?? 'observational';

    if (this._strategy === 'observational') {
      // The observation slot is the last slot, right before history.
      this.observationalEngine = new ObservationalMemoryEngine(
        config.observational ?? {},
        historyStart - 1,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  /** Get the compaction strategy. */
  get strategy(): 'observational' | 'classic' { return this._strategy; }

  /**
   * Set the context budget (the effective limit for Layer 1/2 compaction).
   * This may be smaller than the model's actual context window when a
   * user-configured limit is applied.
   */
  setContextWindow(contextWindow: number): void {
    this._contextWindow = contextWindow;
    this.observationalEngine?.setContextWindow(contextWindow);
  }

  /**
   * Set the model's actual context window (for Layer 3 failsafe only).
   * Layer 3 emergency truncation uses this to avoid dropping messages
   * when the model still has capacity, even if the user-configured
   * budget has been exceeded.
   *
   * Also used as a proxy for the utility model context window until the
   * actual utility model window is set via setUtilityModelContextWindow().
   */
  setModelContextWindow(modelContextWindow: number): void {
    this._modelContextWindow = modelContextWindow;
    this.observationalEngine?.setUtilityModelContextWindow(modelContextWindow);
  }

  /**
   * Set the LLM completion function for Layer 2 summarization.
   */
  setCompleteFn(fn: CompleteFn): void {
    this.completeFn = fn;
  }

  /**
   * Set the LLM completion function for observational memory (utility model).
   */
  setObservationalCompleteFn(fn: CompleteFn): void {
    this.observationalEngine?.setCompleteFn(fn);
  }

  /**
   * Update the utility model context window for observer/reflector clamps.
   */
  setUtilityModelContextWindow(utilityModelContextWindow: number): void {
    this.observationalEngine?.setUtilityModelContextWindow(utilityModelContextWindow);
  }

  /**
   * Set a logger for compaction diagnostics.
   */
  setLogger(logger: CortexLogger): void {
    this.logger = logger;
    this.observationalEngine?.setLogger(logger);
  }

  /**
   * Signal when the user last interacted with the system.
   * The consumer (backend) calls this during GATHER when a message-triggered
   * tick fires. For interval ticks, it is not called, so the timestamp
   * naturally ages.
   */
  setLastInteractionTime(timestamp: number): void {
    this._lastInteractionTime = timestamp;
  }

  /**
   * Get the timestamp of the last user interaction, or null if none recorded.
   */
  get lastInteractionTime(): number | null {
    return this._lastInteractionTime;
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
    return this._contextWindow > 0 && tokens >= this._contextWindow * COMPACTION_DEFAULTS.threshold;
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

  /**
   * Compute the effective Layer 2 compaction threshold, adjusted for
   * interaction recency when adaptive thresholds are enabled.
   *
   * @param now - Current timestamp (ms), injectable for testing
   */
  getEffectiveThreshold(now?: number): number {
    return computeAdaptiveThreshold(
      this.config.compaction.threshold,
      this.config.adaptive,
      this._lastInteractionTime,
      now,
    );
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
   * Get the post-hoc current-context token count from the most recent parent turn.
   */
  get currentContextTokenCount(): number {
    return this._currentContextTokenCount;
  }

  /**
   * Get the context budget (effective limit for Layer 1/2).
   */
  get contextWindow(): number {
    return this._contextWindow;
  }

  /**
   * Get the model's actual context window (for Layer 3 failsafe).
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
  // Event Handlers
  // -----------------------------------------------------------------------

  /**
   * Register a handler called before compaction starts (awaited).
   */
  onBeforeCompaction(handler: BeforeCompactionHandler): void {
    this.beforeCompactionHandlers.push(handler);
  }

  /**
   * Register a handler called after compaction completes.
   */
  onPostCompaction(handler: PostCompactionHandler): void {
    this.postCompactionHandlers.push(handler);
  }

  /**
   * Register a handler called if compaction fails.
   */
  onCompactionError(handler: CompactionErrorHandler): void {
    this.compactionErrorHandlers.push(handler);
  }

  /**
   * Register a handler that receives the CompactionResult (for AgentLoop event emission).
   */
  onCompactionResult(handler: (result: CompactionResult) => void): void {
    this.compactionResultHandlers.push(handler);
  }

  /**
   * Register a handler called when Layer 2 failed and Layer 3 was used as fallback.
   */
  onCompactionDegraded(handler: (info: CompactionDegradedInfo) => void): void {
    this.compactionDegradedHandlers.push(handler);
  }

  /**
   * Register a handler called when all compaction layers have failed.
   */
  onCompactionExhausted(handler: (info: CompactionExhaustedInfo) => void): void {
    this.compactionExhaustedHandlers.push(handler);
  }

  // -----------------------------------------------------------------------
  // Observational Memory
  // -----------------------------------------------------------------------

  /**
   * Called at turn_end to trigger async buffer checks.
   */
  onTurnEnd(totalTokens: number, contextWindow: number, messages: AgentMessage[], historyStart: number): void {
    this.observationalEngine?.onTurnEnd(totalTokens, contextWindow, messages, historyStart);
  }

  /**
   * Reconcile the observational buffer after the tail of the post-slot
   * source history was trimmed (an aborted or failed run's stub, or a
   * failed background delivery being unwound). Clamps the buffer watermark
   * and any in-flight observer end index to the surviving source length so
   * the next activation cannot slice away unobserved messages. No-op for
   * the classic strategy.
   *
   * @param postSlotLength - post-slot source history length after the trim
   */
  onSourceHistoryTailTrimmed(postSlotLength: number): void {
    this.observationalEngine?.onSourceHistoryTailTrimmed(postSlotLength);
  }

  /**
   * Register observation event handler.
   */
  onObservation(handler: (event: ObservationEvent) => void): void {
    this.observationalEngine?.onObservation(handler);
  }

  /**
   * Register reflection event handler.
   */
  onReflection(handler: (event: ReflectionEvent) => void): void {
    this.observationalEngine?.onReflection(handler);
  }

  /**
   * Get observational memory state for persistence.
   */
  getObservationalMemoryState(): ObservationalMemoryState | null {
    return this.observationalEngine?.getState() ?? null;
  }

  /**
   * Restore observational memory state from a previous session.
   *
   * @param state - the persisted observational memory state
   * @param historyLength - length of the restored post-slot conversation
   *   history, used to clamp the buffer watermark against drift
   */
  restoreObservationalMemoryState(state: ObservationalMemoryState, historyLength?: number): void {
    this.observationalEngine?.restoreState(state, historyLength);
  }

  /**
   * Force a synchronous observation cycle.
   */
  async triggerObservation(messages: AgentMessage[], historyStart: number): Promise<void> {
    await this.observationalEngine?.triggerObservation(messages, historyStart);
  }

  /**
   * Run pending observation buffering outside a prompt (see
   * ObservationalMemoryEngine.digestPendingBuffers). No-op under the
   * classic strategy. Returns true when an observer call ran to completion;
   * false also covers a wait that hit `observerTimeoutMs` (the digestion
   * gives the gate back rather than blocking on a hung utility request).
   */
  async digestPendingObservationBuffers(
    messages: AgentMessage[],
    historyStart: number,
    observerTimeoutMs?: number,
  ): Promise<boolean> {
    return this.observationalEngine?.digestPendingBuffers(messages, historyStart, observerTimeoutMs)
      ?? false;
  }

  /**
   * Get the observation slot content string (for ContextManager.setSlot).
   */
  getObservationSlotContent(): string {
    return this.observationalEngine?.getSlotContent() ?? '';
  }

  /**
   * Whether observations have been produced (non-empty observation text).
   */
  hasObservations(): boolean {
    return (this.observationalEngine?.getObservations() ?? '').length > 0;
  }

  /**
   * Whether the recall tool should be registered.
   */
  hasRecallTool(): boolean {
    return this.observationalEngine?.hasRecall() ?? false;
  }

  /**
   * Get the recall config if available.
   */
  getRecallConfig() {
    return this.observationalEngine?.getRecallConfig();
  }

  /**
   * Current token count of activated observations only.
   * Returns 0 when not using the observational strategy.
   */
  getObservationTokenCount(): number {
    return this.observationalEngine?.getObservationTokenCount() ?? 0;
  }


  /**
   * Whether the observer or reflector is currently running in the background.
   * Returns false when not using the observational strategy.
   */
  isObservationalProcessing(): boolean {
    return this.observationalEngine?.isProcessing() ?? false;
  }

  /**
   * Whether the observer specifically is in-flight.
   */
  isObserverInFlight(): boolean {
    return this.observationalEngine?.isObserverInFlight() ?? false;
  }

  /**
   * Whether the reflector specifically is in-flight.
   */
  isReflectorInFlight(): boolean {
    return this.observationalEngine?.isReflectorInFlight() ?? false;
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
   * Apply insertion-time cap to all uncapped tool results in the source
   * messages array (mutates in place).
   *
   * Called from the transformContext hook on `agent.state.messages` so that
   * Tier 1 capping is automatically applied when tool results enter
   * conversation history through pi-agent-core's internal tool execution
   * loop. The cap is applied at most once per tool result part; already
   * capped content (containing the insertion marker) is skipped.
   *
   * @param messages - The source messages array (mutated in place)
   * @param historyStart - Index of the first history message (past the system head and slots)
   * @param isStale - When provided and true, the pass has been abandoned
   *   (digestIdle timed out and advanced the generation) and no further
   *   mutation may land: the aggregate phase awaits a consumer
   *   persistResult, and a pass hanging there could otherwise write a
   *   stale message back at an index a later splice has changed.
   */
  async applyInsertionCap(
    messages: AgentMessage[],
    historyStart: number,
    isStale?: () => boolean,
  ): Promise<void> {
    const config = this.microcompaction.getConfig();

    // Phase 1: Individual per-result cap
    for (let i = historyStart; i < messages.length; i++) {
      const msg = messages[i]!;
      if (!isToolResultMessage(msg)) continue;
      if (typeof msg.content === 'string') continue;

      let modified = false;
      const newContent = msg.content.map(part => {
        const isLegacyToolResult = part.type === 'tool_result' && typeof part.text === 'string';
        const isRuntimeToolResultText = msg.role === 'toolResult' && part.type === 'text' && typeof part.text === 'string';
        if (!isLegacyToolResult && !isRuntimeToolResultText) {
          return part;
        }
        // Skip already-capped content
        if ((part.text as string).includes('tokens trimmed at insertion')) {
          return part;
        }
        const capped = capToolResult(part.text as string, config);
        if (capped !== part.text) {
          modified = true;
          return { ...part, text: capped };
        }
        return part;
      });

      if (modified) {
        messages[i] = { ...msg, content: newContent };
      }
    }

    // Phase 2: Aggregate per-message budget
    const aggregateLimit = config.maxAggregateTurnTokens ?? 150_000;
    if (aggregateLimit <= 0) return;

    for (let i = historyStart; i < messages.length; i++) {
      const msg = messages[i]!;
      if (!isToolResultMessage(msg)) continue;
      if (typeof msg.content === 'string') continue;

      const parts = msg.content;
      const partInfos: Array<{ index: number; tokens: number; text: string; toolName: string }> = [];
      let totalTokens = 0;

      for (let p = 0; p < parts.length; p++) {
        const part = parts[p]!;
        const isLegacyToolResult = part.type === 'tool_result' && typeof part.text === 'string';
        const isRuntimeToolResultText = msg.role === 'toolResult' && part.type === 'text' && typeof part.text === 'string';
        if (!isLegacyToolResult && !isRuntimeToolResultText) {
          continue;
        }

        const text = part.text as string;
        const tokens = estimateTokens(text);
        const name = (typeof (part as Record<string, unknown>)['name'] === 'string'
          ? (part as Record<string, unknown>)['name'] as string
          : null) ?? extractToolName(msg) ?? 'unknown';
        partInfos.push({ index: p, tokens, text, toolName: name });
        totalTokens += tokens;
      }

      if (totalTokens <= aggregateLimit) continue;

      const sorted = [...partInfos].sort((a, b) => b.tokens - a.tokens);
      const newParts = [...parts];
      let currentTotal = totalTokens;

      for (const info of sorted) {
        if (currentTotal <= aggregateLimit) break;
        if (info.tokens <= config.maxResultTokens / 2) break;

        const part = newParts[info.index]!;
        let replacement: string;

        if (config.persistResult) {
          const category = getToolCategory(info.toolName, config.toolCategories);
          try {
            const path = await config.persistResult(info.text, {
              toolName: info.toolName,
              messageIndex: i,
              category: category ?? 'rereadable',
            });
            const bookended = applyBookend(info.text, config.bookendMaxChars, config.bookendMaxChars, info.tokens);
            replacement = `${bookended}\n\n[Full content persisted to ${path} -- use Read to access]`;
          } catch {
            replacement = applyBookend(info.text, config.bookendMaxChars, config.bookendMaxChars, info.tokens);
          }
          // The await above is the pass's only suspension point: an
          // abandoned pass settling here must not mutate live history it
          // no longer owns.
          if (isStale?.()) return;
        } else {
          replacement = applyBookend(info.text, config.bookendMaxChars, config.bookendMaxChars, info.tokens);
        }

        const newTokens = estimateTokens(replacement);
        currentTotal = currentTotal - info.tokens + newTokens;
        newParts[info.index] = { ...part, text: replacement };
      }

      // Identity check before the write-back: if the slot no longer holds
      // the message this pass read (a splice landed during the awaited
      // persist), writing the capped copy would resurrect stale content at
      // an unrelated index. Skipping is safe; the cap is an optimization.
      if (messages[i] !== msg) continue;
      messages[i] = { ...msg, content: newParts };
    }
  }

  // -----------------------------------------------------------------------
  // transformContext hook
  // -----------------------------------------------------------------------

  /**
   * Apply compaction layers to the context in transformContext.
   *
   * This is the main entry point called from AgentLoop.getTransformContextHook().
   * It is fully self-contained: all three compaction layers are integrated here,
   * triggered autonomously based on token thresholds. No external calls from
   * the backend are needed to trigger compaction.
   *
   * Execution order:
   * 1. Layer 1 (microcompaction): tool result trimming at threshold crossings
   * 2. Layer 2 (summarization): if tokens exceed 70% after Layer 1, run LLM
   *    summarization on the source transcript, then rebuild context from the
   *    updated messages
   * 3. Layer 3 (failsafe): if tokens still exceed 90% after Layers 1-2,
   *    emergency truncation drops the oldest turns
   *
   * @param context - The AgentContext from transformContext
   * @param getHistory - Function to get conversation history from the context
   * @param setHistory - Function to set conversation history in the context
   * @param getSourceHistory - Function to get the original source transcript history (post-slot)
   * @param setSourceHistory - Function to replace the original source transcript history
   * @param options - allowBlocking overrides the configured nonBlocking
   *   posture for this call (an idle-digestion entry point runs the
   *   synchronous work deliberately). Omitted: the config decides.
   *   isStale reports whether the pass has been abandoned (a timed-out
   *   digestIdle advanced the generation): a stale pass's history rewrite
   *   is discarded by the owner's setSourceHistory guard, and this hook
   *   suppresses the matching event dispatch, so a consumer never sees a
   *   compaction or observation reported for a rewrite that never landed.
   * @returns Modified context with compacted history
   */
  async applyInTransformContext(
    context: AgentContext,
    getHistory: (ctx: AgentContext) => AgentMessage[],
    setHistory: (ctx: AgentContext, history: AgentMessage[]) => AgentContext,
    getSourceHistory?: () => AgentMessage[],
    setSourceHistory?: (history: AgentMessage[]) => void,
    options?: { allowBlocking?: boolean; isStale?: () => boolean },
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
    const estimatedCurrentTokens = this.estimateContextTokens(context);
    const currentTokens = this.estimateCurrentContextTokens(context);

    this.logger.debug('[Compaction] transformContext', {
      historyLen: history.length,
      currentContextTokens: this._currentContextTokenCount,
      heuristic: estimatedCurrentTokens,
      currentTokens,
      ctxWindow: this._contextWindow,
    });

    // Compute utilization and slot tokens (shared by both strategies and L3)
    const originalHistoryTokens = this.estimateHistoryTokens(getHistory(context));
    const slotTokens = Math.max(0, currentTokens - originalHistoryTokens);
    const utilization = this._contextWindow > 0 ? currentTokens / this._contextWindow : 0;

    let layer2Failed = false;
    let lastLayer2Error: Error | undefined;
    let effectiveThreshold = 0;

    const cacheCold = this.shouldTrimHistory(currentTokens);

    if (this._strategy === 'observational' && this.observationalEngine && getSourceHistory && setSourceHistory) {
      // Observational memory path: observer/reflector handle conversation
      // compression. L2 summarization is skipped, but L1 still runs in
      // cache-aware mode on the unobserved tail to trim large tool results
      // before they hit the LLM.
      context = await this.observationalEngine.applyInTransformContext(
        context, utilization, this.historyStart, getHistory, setHistory, getSourceHistory, setSourceHistory,
        { allowSync: allowBlocking, ...(isStale ? { isStale } : {}) },
      );
      history = getHistory(context);

      // Run L1 on the surviving (post-observation) history. Cache-aware
      // gating ensures we only trim when the prompt cache has gone cold,
      // preserving cache hits during active use. Re-estimate from the
      // updated context so the observation slot's new size is reflected.
      const postObsTotal = this.estimateCurrentContextTokens(context);
      const trimmedHistory = await this.microcompaction.apply(
        history, this._contextWindow, postObsTotal, { cacheCold: this.shouldTrimHistory(postObsTotal) },
      );
      if (trimmedHistory !== history) {
        context = setHistory(context, trimmedHistory);
        history = trimmedHistory;
      }
    } else {
      // Classic path: L1 + L2

      // Layer 1: Microcompaction. Cache-aware gating: only trims when the
      // prompt cache is cold (or unsupported). When warm, returns history
      // untouched to preserve cache hits.
      history = await this.microcompaction.apply(
        history, this._contextWindow, currentTokens, { cacheCold },
      );

      // Layer 2: Conversation summarization (70% threshold)
      // Operates on the original source transcript, not the in-memory
      // microcompacted context. After Layer 2 modifies the source, we rebuild
      // the context from the updated messages.
      const postMicroTokens = this.estimateHistoryTokens(history);
      const totalAfterMicro = slotTokens + postMicroTokens;

      effectiveThreshold = this.getEffectiveThreshold();

      this.logger.debug('[Compaction] Layer2 evaluation', {
        totalAfterMicro,
        threshold: effectiveThreshold,
        ratio: totalAfterMicro / this._contextWindow,
        completeFn: !!this.completeFn,
        srcAccessors: !!getSourceHistory && !!setSourceHistory,
        shouldCompact: shouldCompact(totalAfterMicro, this._contextWindow, effectiveThreshold),
      });

      if (
        allowBlocking &&
        this.completeFn &&
        getSourceHistory &&
        setSourceHistory &&
        shouldCompact(totalAfterMicro, this._contextWindow, effectiveThreshold)
      ) {
        const maxRetries = this.config.compaction.maxRetries ?? 3;
        const retryDelayMs = this.config.compaction.retryDelayMs ?? 2000;
        let succeeded = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const sourceHistory = getSourceHistory();
            if (sourceHistory.length === 0) break;

            const { newHistory: compactedSource, result } = await runCompaction(
              sourceHistory,
              this.config.compaction,
              this.completeFn,
              {
                onBeforeCompaction: this.beforeCompactionHandlers,
                // Post and error handlers are stale-guarded AT DISPATCH
                // TIME: runCompaction fires them internally after its LLM
                // call settles, which for an abandoned pass can be minutes
                // after the owner discarded the rewrite, and a consumer
                // must never see a compaction reported for a rewrite that
                // never landed. onBeforeCompaction stays unguarded: it
                // fires before the summarizer call, when the pass still
                // owns the generation.
                onPostCompaction: staleGuardHandlers(this.postCompactionHandlers, isStale),
                onCompactionError: staleGuardHandlers(this.compactionErrorHandlers, isStale),
              },
              currentTokens, // pass actual full-context token count for accurate reporting
            );

            // An abandoned pass settling late: its rewrite would be
            // discarded by the owner's setSourceHistory guard anyway, so
            // none of the success-path state (failure counters, the token
            // count, the microcompaction cache, the result events) may be
            // updated as if it landed.
            if (isStale?.()) return context;

            // Success: update state and reset failure counter
            setSourceHistory(compactedSource);
            this.microcompaction.resetCache();

            // result.tokensAfter now includes overhead (system prompt, slots,
            // tool definitions) since we passed actualContextTokens to
            // runCompaction. Use it directly to prevent the stale low value
            // that would cause re-triggering compaction on the next call.
            this._currentContextTokenCount = result.tokensAfter;

            this._consecutiveLayer2Failures = 0;

            for (const handler of this.compactionResultHandlers) {
              try {
                handler(result);
              } catch (err) {
                this.logger.error('[Compaction] compactionResult handler threw', {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            // Rebuild context from updated source. L2 just rewrote history
            // wholesale, so any existing cache prefix is invalidated; treat as
            // cold so L1 can trim the rebuilt history if warranted.
            history = await this.microcompaction.apply(
              compactedSource,
              this._contextWindow,
              this._currentContextTokenCount,
              { cacheCold: true },
            );

            succeeded = true;
            break;
          } catch (err) {
            // A stale pass's failure is not the live loop's failure: it
            // must not advance the failure ladder, trigger the L3 fallback
            // events below, or burn retry waits inside an abandoned pass.
            if (isStale?.()) return context;
            this._consecutiveLayer2Failures++;
            lastLayer2Error = err instanceof Error ? err : new Error(String(err));
            this.logger.warn('[Compaction] Layer2 retry failed', {
              attempt,
              maxRetries,
              error: lastLayer2Error.message,
            });

            if (attempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
          }
        }

        if (!succeeded) {
          layer2Failed = true;
        }
      }
    }

    // Layer 3: Emergency truncation (90% of model context window)
    // Uses the MODEL's actual context window, not the budget. Emergency
    // truncation should only fire when we're near the model's real limit,
    // not the user's artificial budget. Layer 1/2 handle the budget.
    // When observational memory is active, L3 operates on the post-slot
    // history (raw messages only). The observation slot lives in the slot
    // region and is naturally protected by historyStart.
    {
      const failsafeWindow = this._modelContextWindow > 0 ? this._modelContextWindow : this._contextWindow;
      const postLayerTokens = this.estimateHistoryTokens(history);
      const totalNow = slotTokens + postLayerTokens;

      if (shouldTruncate(totalNow, failsafeWindow, this.config.failsafe.threshold)) {
        // Force sync observation before L3 truncation to capture unobserved
        // content before it is dropped. The source history from getSourceHistory
        // is already post-slot, so pass 0 as historyStart. Skipped under the
        // non-blocking posture: truncation must be the ONLY in-band path
        // there, even at the cost of dropping unobserved content.
        if (
          allowBlocking &&
          this._strategy === 'observational' &&
          this.observationalEngine &&
          getSourceHistory
        ) {
          const sourceHistory = getSourceHistory();
          await this.observationalEngine.triggerObservation(sourceHistory, 0);
        }

        const truncResult = emergencyTruncate(
          history,
          failsafeWindow,
          slotTokens,
          this.config.failsafe.threshold,
        );
        history = truncResult.newHistory;

        // Emit degraded event if Layer 3 was used as fallback for Layer 2 failure
        if (layer2Failed) {
          const failures = this._consecutiveLayer2Failures;
          this._consecutiveLayer2Failures = 0;
          for (const handler of this.compactionDegradedHandlers) {
            try {
              handler({
                layer2Failures: failures,
                turnsDropped: truncResult.turnsRemoved,
              });
            } catch (err) {
              this.logger.error('[Compaction] compactionDegraded handler threw', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      } else if (layer2Failed) {
        // Layer 2 failed but Layer 3 didn't need to run. If tokens are still
        // over the Layer 2 budget, emit exhausted so the consumer can act.
        const postTokens = this.estimateHistoryTokens(history);
        const stillOverBudget = shouldCompact(slotTokens + postTokens, this._contextWindow, effectiveThreshold);

        if (stillOverBudget) {
          const failures = this._consecutiveLayer2Failures;
          this._consecutiveLayer2Failures = 0;
          for (const handler of this.compactionExhaustedHandlers) {
            try {
              handler({
                error: lastLayer2Error ?? new Error('Layer 2 compaction failed'),
                layer2Failures: failures,
              });
            } catch (err) {
              this.logger.error('[Compaction] compactionExhausted handler threw', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
    }

    return setHistory(context, history);
  }

  // -----------------------------------------------------------------------
  // End-of-tick compaction check
  // -----------------------------------------------------------------------

  /**
   * Manually check if compaction is needed and run it.
   *
   * This is a convenience API for consumers who want to trigger compaction
   * outside the agentic loop (e.g., for testing or manual maintenance).
   * The primary compaction trigger is `applyInTransformContext`, which runs
   * automatically before every LLM call.
   *
   * @param getHistory - Get current conversation history
   * @param setHistory - Replace conversation history
   * @returns CompactionResult if compaction ran, null otherwise
   */
  async checkAndRunCompaction(
    getHistory: () => AgentMessage[],
    setHistory: (history: AgentMessage[]) => void,
  ): Promise<CompactionResult | null> {
    if (this._contextWindow <= 0) return null;

    const history = getHistory();
    if (history.length === 0) return null;

    const estimatedTokens = this.estimateHistoryTokens(history);

    // Use adaptive threshold (adjusts based on interaction recency)
    const effectiveThreshold = this.getEffectiveThreshold();

    // Check Layer 2 threshold
    if (!shouldCompact(this._currentContextTokenCount, this._contextWindow, effectiveThreshold)) {
      // Also check using heuristic estimation as fallback
      if (!shouldCompact(estimatedTokens, this._contextWindow, effectiveThreshold)) {
        return null;
      }
    }

    // Attempt Layer 2 (summarization)
    if (this.completeFn) {
      try {
        const actualTokens = Math.max(this._currentContextTokenCount, estimatedTokens);
        const { newHistory, result } = await runCompaction(
          history,
          this.config.compaction,
          this.completeFn,
          {
            onBeforeCompaction: this.beforeCompactionHandlers,
            onPostCompaction: this.postCompactionHandlers,
            onCompactionError: this.compactionErrorHandlers,
          },
          actualTokens, // pass full-context token count for accurate reporting
        );

        setHistory(newHistory);
        this.microcompaction.resetCache();

        // result.tokensAfter includes overhead since we passed actualTokens
        this._currentContextTokenCount = result.tokensAfter;

        // Emit result
        for (const handler of this.compactionResultHandlers) {
          try {
            handler(result);
          } catch {
            // Swallow handler errors
          }
        }

        return result;

      } catch {
        // Layer 2 failed, fall through to Layer 3
      }
    }

    // Layer 3 fallback: emergency truncation (uses model's actual window)
    const failsafeWindow = this._modelContextWindow > 0 ? this._modelContextWindow : this._contextWindow;
    const slotTokens = this._currentContextTokenCount - estimatedTokens;
    if (shouldTruncate(this._currentContextTokenCount, failsafeWindow, this.config.failsafe.threshold)) {
      const result = emergencyTruncate(
        history,
        failsafeWindow,
        Math.max(0, slotTokens),
        this.config.failsafe.threshold,
      );
      setHistory(result.newHistory);
      this.microcompaction.resetCache();
      // Keep the observational buffer watermark aligned with the front-
      // truncated source so the next activation neither trims unobserved
      // messages nor orphans a tool result at the new head (H-4).
      this.observationalEngine?.onSourceHistoryTruncated(result.turnsRemoved);
      this._currentContextTokenCount = result.tokensAfter;
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Reactive overflow handling
  // -----------------------------------------------------------------------

  /**
   * Handle a context overflow error by performing emergency truncation.
   * Called when the API returns a context overflow error.
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

    // API returned overflow error, so use the model's actual window
    const failsafeWindow = this._modelContextWindow > 0 ? this._modelContextWindow : this._contextWindow;
    const estimatedTokens = this.estimateHistoryTokens(history);
    const slotTokens = Math.max(0, this._currentContextTokenCount - estimatedTokens);

    const result = emergencyTruncate(
      history,
      failsafeWindow,
      slotTokens,
      this.config.failsafe.threshold,
    );

    setHistory(result.newHistory);
    this.microcompaction.resetCache();
    // Keep the observational buffer watermark aligned with the front-
    // truncated source so the next activation neither trims unobserved
    // messages nor orphans a tool result at the new head (H-4).
    this.observationalEngine?.onSourceHistoryTruncated(result.turnsRemoved);
    this._currentContextTokenCount = result.tokensAfter;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Clear all state and handlers.
   */
  destroy(): void {
    this.microcompaction.resetCache();
    this.observationalEngine?.abort();
    this.observationalEngine = null;
    this.beforeCompactionHandlers = [];
    this.postCompactionHandlers = [];
    this.compactionErrorHandlers = [];
    this.compactionResultHandlers = [];
    this.compactionDegradedHandlers = [];
    this.compactionExhaustedHandlers = [];
    this.completeFn = null;
    this._currentContextTokenCount = 0;
    this._consecutiveLayer2Failures = 0;
    this._lastInteractionTime = null;
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

/**
 * Wrap handler arrays so each handler checks pass staleness at DISPATCH
 * time. runCompaction fires its handlers internally, after an LLM call that
 * an abandoned digestion pass cannot cancel, so the guard must live inside
 * the handler rather than around the call. Identity is preserved when no
 * staleness source exists.
 */
function staleGuardHandlers<Args extends unknown[], R>(
  handlers: Array<(...args: Args) => R>,
  isStale: (() => boolean) | undefined,
): Array<(...args: Args) => R | undefined> {
  if (!isStale) return handlers;
  return handlers.map((handler) => (...args: Args): R | undefined => {
    if (isStale()) return undefined;
    return handler(...args);
  });
}
