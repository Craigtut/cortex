/**
 * AgentLoop's public surface, the context the model sees (slots, history,
 * the transformContext hook, the headline feed, token tracking,
 * compaction, observational memory). AgentLoop implements this interface;
 * the member docs here are AgentLoop's documentation.
 */

import type { CompactionManager } from '../../compaction/index.js';
import type {
  MemoryErrorInfo,
  MemoryRecoveredInfo,
  ObservationEvent,
  ObservationalMemoryState,
  ReflectionEvent,
} from '../../compaction/observational/types.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentContext, ContextManager } from '../../context-manager.js';
import type { CompactionDegradedInfo, CompactionExhaustedInfo, CompactionResult, CompactionTarget, LoopOriginContext } from '../../types.js';

export interface LoopContextApi {
  /**
   * Feed a consumer-built headline block (live task status, activity lines)
   * into this loop's context. The provider is called on EVERY LLM call and
   * its result is view-injected after the built-in background-task state,
   * OUTSIDE the BP3 cache boundary. It never enters the transcript and is
   * absent on compaction turns (like all view injections).
   *
   * The block is hard token-capped (default 2000 tokens; override via
   * options.maxTokens), since microcompaction never trims injected content.
   *
   * Pass null to stop injecting. A provider that throws or returns
   * null/whitespace injects nothing for that call.
   */
  setHeadlineProvider(
    provider: (() => string | null) | null,
    options?: { maxTokens?: number },
  ): void;

  /**
   * Get the ContextManager for slot and ephemeral context management.
   */
  getContextManager(): ContextManager;

  /**
   * Get conversation history: everything after the system head and slots.
   *
   * Includes the `role: 'system'` messages inline in history (pi's tool
   * declarations and Cortex's prompt section updates). They carry no
   * conversation; a consumer rendering history skips them, and one
   * persisting it keeps them, so a restore lines up with the observational
   * watermark and the cached prefix. The consumer snapshots this to their
   * storage.
   *
   * @returns Conversation history messages (everything after slots)
   */
  getConversationHistory(): AgentMessage[];

  /**
   * Restore conversation history after the slot region.
   *
   * Replaces any existing conversation history. System messages in the
   * saved history replay as declared; the loop then brings the prompt and
   * tools up to date on its next request.
   *
   * Observational memory starts empty: it described the replaced history.
   * To restore memory with the history, call
   * restoreObservationalMemoryState() after this.
   *
   * @param messages - Previously saved conversation history
   */
  restoreConversationHistory(messages: AgentMessage[]): void;

  /**
   * Register a handler called before compaction starts.
   * Handler is awaited. The consumer should flush critical state
   * (e.g., observational memory) before history is compacted.
   *
   * NOT called during mid-loop emergency truncation (Layer 3).
   */
  onBeforeCompaction(
    handler: (target: CompactionTarget, origin: LoopOriginContext) => Promise<void>,
  ): void;

  /**
   * Register a handler called after compaction completes, e.g. to re-seed
   * messages from the consumer's store or update internal state.
   */
  onPostCompaction(
    handler: (result: CompactionResult, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler for compaction errors.
   */
  onCompactionError(
    handler: (error: Error, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler called when Layer 2 compaction failed and Layer 3
   * (emergency truncation) was used as fallback. The session continues
   * but context quality is degraded.
   */
  onCompactionDegraded(
    handler: (info: CompactionDegradedInfo, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler called when all compaction layers have failed.
   * The consumer should take recovery action (e.g., pause heartbeat,
   * abort the session, or notify the user).
   */
  onCompactionExhausted(
    handler: (info: CompactionExhaustedInfo, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Update the post-hoc current-context token count from LLM usage data.
   * Called by the consumer after each LLM call with the input_tokens
   * from AssistantMessage.usage.
   */
  updateCurrentContextTokenCount(inputTokens: number): void;

  /**
   * Get the post-hoc current-context token count from the most recent parent turn.
   */
  readonly currentContextTokenCount: number;

  /**
   * Estimate the current context tokens Cortex would send on the next parent LLM call.
   *
   * This is a heuristic estimate of the transformed context snapshot built from:
   * - the current system prompt
   * - slots and conversation history
   * - ephemeral context
   * - background task state
   * - loaded skills
   *
   * The estimate is compared against the most recent post-hoc parent turn usage
   * and the larger value is returned. This matches the compaction manager's
   * internal decision logic.
   */
  estimateCurrentContextTokens(): number;

  /**
   * Signal how recently the user last interacted. Compaction uses normal
   * thresholds after recent interaction and compacts more aggressively
   * after a quiet period. Call it (with Date.now()) on user-triggered
   * work only, so the timestamp ages naturally otherwise.
   */
  setLastInteractionTime(timestamp: number): void;

  /**
   * Cap a tool result at insertion time. If the result exceeds
   * maxResultTokens, truncates to head+tail bookend format.
   * Call this when tool results enter conversation history.
   */
  capToolResult(content: string): string;

  /**
   * Get the observational memory state for session persistence.
   * Returns null if not using the observational strategy.
   */
  getObservationalMemoryState(): ObservationalMemoryState | null;

  /**
   * Restore observational memory state from a previous session.
   * Must be called after restoreConversationHistory().
   */
  restoreObservationalMemoryState(state: ObservationalMemoryState): void;

  /**
   * Force a synchronous observation cycle.
   * Useful after critical user corrections.
   */
  triggerObservation(): Promise<void>;

  /**
   * Register a handler for observation events.
   * Fires when messages are compressed into observations.
   */
  onObservation(
    handler: (event: ObservationEvent, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler for reflection events.
   * Fires when the reflector condenses observations.
   */
  onReflection(
    handler: (event: ReflectionEvent, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler for observer or reflector calls that failed after
   * all their attempts. Nothing is lost when it fires: unobserved messages
   * stay in context and a failed reflection keeps the current log. While
   * failures continue, the loop stops blocking requests on memory calls;
   * `info.consecutiveFailures` is 1 on the call that started the episode.
   */
  onMemoryError(
    handler: (info: MemoryErrorInfo, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Register a handler for the first successful memory call after one or
   * more failures: the episode `onMemoryError` started is over.
   */
  onMemoryRecovered(
    handler: (info: MemoryRecoveredInfo, origin: LoopOriginContext) => void,
  ): void;

  /**
   * Run the end-of-tick compaction check, between ticks. Returns the
   * CompactionResult if Layer 2 compaction ran, null otherwise.
   */
  checkAndRunCompaction(): Promise<CompactionResult | null>;

  /**
   * Get the CompactionManager for advanced use.
   */
  getCompactionManager(): CompactionManager;

  /**
   * Get the composed transformContext hook for the pi-agent-core Agent.
   *
   * Composes, in order:
   * 0. Tier 1 insertion-time cap (mutates source messages)
   * 1. View injections (ephemeral, skills, background tasks, headline) at
   *    the history boundary, then message sanitization
   * 2. Compaction (microcompaction, summarization or observation, failsafe)
   * 3. API message indices for cache breakpoints BP2 and BP3
   *
   * Anthropic allows 4 cache_control breakpoints. pi-ai sets up to 3
   * (system prompt, last tool definition, last user message); the onPayload
   * hook swaps the tool breakpoint for BP2 (after the last slot) and BP3
   * (old history boundary). Injecting at the boundary rather than the end
   * keeps the history prefix stable and cache-readable across ticks.
   *
   * Async because compaction may call an LLM.
   *
   * @returns An async transformContext function for the Agent constructor
   */
  getTransformContextHook(): (context: AgentContext) => Promise<AgentContext>;
}
