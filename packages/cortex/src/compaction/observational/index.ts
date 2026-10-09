/**
 * ObservationalMemoryEngine: core orchestrator for the observational memory
 * system.
 *
 * Ties together the observer, reflector, and buffering coordinator. Manages
 * the observation slot, handles activation and reflection, and exposes the
 * state management API.
 *
 * The engine runs inside CompactionManager's transformContext hook. It does
 * NOT directly call ContextManager.setSlot(); instead, it manages the slot
 * content string and the integration layer handles writing it to the slot.
 *
 * References:
 *   - observational-memory-architecture.md
 *   - compaction-strategy.md
 *   - context-manager.md
 */

import type { CompleteFn } from '../compaction.js';
import type { AgentMessage, AgentContext } from '../../context-manager.js';
import type {
  ObservationalMemoryConfig,
  ObservationalMemoryState,
  ObservationChunk,
  ObservationEvent,
  ReflectionEvent,
  ContinuationHint,
  RecallConfig,
  ObserverOutput,
  ReflectorOutput,
} from './types.js';
import {
  OBSERVATIONAL_MEMORY_DEFAULTS,
  OBSERVATION_CONTEXT_PREAMBLE,
  OBSERVATION_RECALL_INSTRUCTIONS,
} from './constants.js';
import { runObserver } from './observer.js';
import { runReflector, computeEffectiveReflectionThreshold, applyReflection } from './reflector.js';
import { BufferingCoordinator } from './buffering.js';
import { estimateTokens } from '../../token-estimator.js';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { BufferingCoordinator } from './buffering.js';
export { runObserver } from './observer.js';
export { runReflector, computeEffectiveReflectionThreshold } from './reflector.js';
export { createRecallTool } from './recall-tool.js';

export type {
  ObservationalMemoryConfig,
  ObservationalMemoryState,
  ObservationChunk,
  ObservationEvent,
  ReflectionEvent,
  ContinuationHint,
  RecallConfig,
  RecallResult,
  ObserverOutput,
  ReflectorOutput,
  BufferState,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default wall-clock budget for idle digestion's observer waits. Idle
 * digestion holds the caller's loop gate, so waiting on a hung utility
 * request must be bounded; a healthy observer call settles well inside
 * this. Overridable per call (digestIdle's observerTimeoutMs).
 */
export const DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS = 60_000;

/**
 * Rehydrate buffered chunks loaded from persistence. `createdAt` survives
 * JSON serialization as an ISO string; convert it back to a `Date` so the
 * in-memory shape matches {@link ObservationChunk}.
 */
function rehydrateChunks(chunks: ObservationChunk[]): ObservationChunk[] {
  return chunks.map((chunk) => ({
    ...chunk,
    createdAt: chunk.createdAt instanceof Date ? chunk.createdAt : new Date(chunk.createdAt),
  }));
}

// ---------------------------------------------------------------------------
// ObservationalMemoryEngine
// ---------------------------------------------------------------------------

/**
 * Core orchestrator for the observational memory system.
 *
 * Coordinates the observer, reflector, and buffering coordinator to maintain
 * a compressed observation log of the conversation. Called from
 * CompactionManager during transformContext.
 */
export class ObservationalMemoryEngine {
  private config: Required<Omit<ObservationalMemoryConfig, 'observerInstruction' | 'reflectorInstruction' | 'recall'>> & {
    observerInstruction?: string;
    reflectorInstruction?: string;
    recall?: RecallConfig;
  };
  private buffering: BufferingCoordinator;
  private completeFn: CompleteFn | null = null;
  private observations: string = '';
  private continuationHint: ContinuationHint | null = null;
  private observationTokenCount: number = 0;
  private generationCount: number = 0;
  private contextWindow: number = 0;
  private utilityModelContextWindow: number = 0;
  private slotIndex: number;
  private logger: { warn: (msg: string) => void; info: (msg: string) => void } | null = null;

  // Event handler arrays (method-level registration, multiple handlers)
  private observationHandlers: Array<(event: ObservationEvent) => void> = [];
  private reflectionHandlers: Array<(event: ReflectionEvent) => void> = [];

  constructor(config: Partial<ObservationalMemoryConfig>, slotIndex: number) {
    this.slotIndex = slotIndex;
    this.buffering = new BufferingCoordinator();

    // Merge with defaults. Optional fields (observerInstruction,
    // reflectorInstruction, recall) are only included when provided.
    this.config = {
      ...OBSERVATIONAL_MEMORY_DEFAULTS,
      ...config,
    };
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Set the LLM completion function (wired to utilityComplete on AgentLoop).
   */
  setCompleteFn(fn: CompleteFn): void {
    this.completeFn = fn;
  }

  /**
   * Update the context window size.
   */
  setContextWindow(contextWindow: number): void {
    this.contextWindow = contextWindow;
  }

  /**
   * Update the utility model context window (for clamps).
   */
  setUtilityModelContextWindow(utilityModelContextWindow: number): void {
    this.utilityModelContextWindow = utilityModelContextWindow;
  }

  /**
   * Set the logger.
   */
  setLogger(logger: { warn: (msg: string) => void; info: (msg: string) => void }): void {
    this.logger = logger;
  }

  // -------------------------------------------------------------------------
  // Event Registration
  // -------------------------------------------------------------------------

  /**
   * Register an observation event handler.
   */
  onObservation(handler: (event: ObservationEvent) => void): void {
    this.observationHandlers.push(handler);
  }

  /**
   * Register a reflection event handler.
   */
  onReflection(handler: (event: ReflectionEvent) => void): void {
    this.reflectionHandlers.push(handler);
  }

  // -------------------------------------------------------------------------
  // Core: applyInTransformContext
  // -------------------------------------------------------------------------

  /**
   * Core method called from CompactionManager during transformContext.
   *
   * Handles observation activation and reflection when context utilization
   * exceeds the activation threshold. Updates the observation slot and
   * trims observed messages from history.
   *
   * @param context - The AgentContext from transformContext
   * @param utilization - Current total context utilization (0-1)
   * @param historyStart - Index of the first history message (past the system head and slots)
   * @param getHistory - Get conversation history from the context (post-slot)
   * @param setHistory - Set conversation history in the context (post-slot)
   * @param getSourceHistory - Get the original transcript history (agent.state.messages post-slot)
   * @param setSourceHistory - Replace the original transcript history
   * @param options - allowSync (default true): whether synchronous LLM
   *   calls may run inline. When false (the non-blocking posture),
   *   activation only consumes already-buffered chunks, the Step 2 forced
   *   observer is skipped, and reflection never runs inline.
   *   isStale reports whether the pass has been abandoned (a timed-out
   *   idle digestion); a stale pass's observation and reflection events
   *   are suppressed, since its history rewrite is discarded by the
   *   owner's setSourceHistory guard and reporting it would tell a
   *   consumer about work that never landed.
   * @returns Modified context with updated observations and trimmed history
   */
  async applyInTransformContext(
    context: AgentContext,
    utilization: number,
    historyStart: number,
    getHistory: (ctx: AgentContext) => AgentMessage[],
    setHistory: (ctx: AgentContext, history: AgentMessage[]) => AgentContext,
    getSourceHistory: () => AgentMessage[],
    setSourceHistory: (history: AgentMessage[]) => void,
    options?: { allowSync?: boolean; isStale?: () => boolean },
  ): Promise<AgentContext> {
    if (utilization < this.config.activationThreshold) {
      return context;
    }
    const allowSync = options?.allowSync ?? true;
    const isStale = options?.isStale;

    // --- Activation ---
    // Planned from a snapshot: every await settles before anything changes,
    // so a failed or abandoned observer call can never leave messages
    // removed whose observations were not recorded.
    const sourceHistory = getSourceHistory();
    const { chunks, watermark: chunkWatermark } = this.buffering.getCompletedChunks();
    const merged = chunks.length > 0 ? this.mergeChunks(chunks) : null;
    const chunkMessages = merged ? sourceHistory.slice(0, chunkWatermark) : [];
    const unbufferedMessages = merged ? sourceHistory.slice(chunkWatermark) : sourceHistory;

    // Step 1: Would swapping in the completed chunks alone be enough?
    // Account for the full slot overhead (preamble, XML wrappers,
    // continuation hints) rather than just the raw observation text, since
    // the slot is always larger.
    const trimmedMessageTokens = estimateTokens(
      chunkMessages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n'),
    );
    const slotOverheadTokens = merged
      ? estimateTokens(this.buildSlotContentForEstimate(merged.observations))
      : 0;
    const netTokenReduction = trimmedMessageTokens - slotOverheadTokens;
    const postChunkUtilization = utilization - (this.contextWindow > 0 ? netTokenReduction / this.contextWindow : 0);

    // Step 2: If not, observe the unbuffered remainder in-band.
    let syncOutput: ObserverOutput | null = null;
    if (
      allowSync &&
      postChunkUtilization >= this.config.activationThreshold &&
      this.completeFn &&
      unbufferedMessages.length > 0
    ) {
      // These messages are about to be observed here; an in-flight observer
      // covering them must not land a second chunk for them.
      this.buffering.advanceEpoch();
      try {
        syncOutput = await runObserver(
          this.completeFn,
          unbufferedMessages,
          this.observations || null,
          this.buildObserverConfig(),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`In-band observer failed; swapping in buffered chunks only: ${message}`);
      }
    }

    // An abandoned pass applies nothing: its rewrite would be discarded by
    // the owner, and the chunks it did not consume stay buffered.
    if (isStale?.()) return context;

    // Step 3: Apply, synchronously.
    let compactedMessages: AgentMessage[] = [];
    let newObservationText = '';
    if (merged) {
      newObservationText = merged.observations;
      if (merged.hint) this.continuationHint = merged.hint;
      compactedMessages = chunkMessages;
    }
    if (syncOutput) {
      newObservationText = newObservationText
        ? newObservationText + '\n\n' + syncOutput.observations
        : syncOutput.observations;
      if (syncOutput.currentTask || syncOutput.suggestedResponse) {
        this.continuationHint = {
          currentTask: syncOutput.currentTask ?? '',
          suggestedResponse: syncOutput.suggestedResponse ?? '',
        };
      }
      compactedMessages = [...compactedMessages, ...unbufferedMessages];
    }
    const activatedSync = syncOutput !== null;
    if (merged || syncOutput) {
      setSourceHistory(syncOutput ? [] : unbufferedMessages);
      // Resets chunks and the watermark and advances the epoch: every
      // message the buffer described has just left the source.
      this.buffering.commitActivation();
    }

    // Merge new observations into existing
    if (newObservationText) {
      if (this.observations) {
        this.observations += '\n\n' + newObservationText;
      } else {
        this.observations = newObservationText;
      }
      this.observationTokenCount = estimateTokens(this.observations);
    }

    // Fire the observation event (the pass is known live: stale returned above).
    if (compactedMessages.length > 0) {
      this.fireObservationEvent({
        compactedMessages,
        observations: this.observations,
        contextUtilization: utilization,
        sync: activatedSync,
        timestamp: new Date(),
      });
    }

    // Step 4: Handle reflection (may replace this.observations with condensed version)
    await this.handleReflection(allowSync, isStale);

    // Step 5: Build slot content AFTER reflection so it contains post-reflection
    // observations. Previously this was captured before reflection, requiring
    // an external patch in agent-loop.ts to correct stale content.
    const slotContent = this.buildSlotContent();

    // Step 6: Rebuild context with updated observations and trimmed history
    const updatedSourceHistory = getSourceHistory();

    // Build new message array: slot region + observation slot + remaining source messages
    const slotRegion = context.messages.slice(0, this.slotIndex);
    const observationSlotMessage: AgentMessage = {
      role: 'user',
      content: slotContent,
      timestamp: Date.now(),
    };
    // Messages after the slot region that are not part of the observation slot
    const postSlotMessages = updatedSourceHistory;

    const newMessages: AgentMessage[] = [
      ...slotRegion,
      observationSlotMessage,
      ...context.messages.slice(this.slotIndex + 1, historyStart),
      ...postSlotMessages,
    ];

    return setHistory(
      { ...context, messages: newMessages },
      postSlotMessages,
    );
  }

  // -------------------------------------------------------------------------
  // Turn-end handler
  // -------------------------------------------------------------------------

  /**
   * Called at each turn_end event. Handles async buffer triggering.
   *
   * Computes the dynamic buffer interval and launches an async observer
   * if enough unobserved tokens have accumulated.
   *
   * @param totalTokens - Total tokens from the last LLM response
   * @param contextWindow - Current context window size
   * @param messages - Current conversation messages (post-slot)
   * @param historyStart - Index of the first history message (past the system head and slots)
   */
  onTurnEnd(
    totalTokens: number,
    contextWindow: number,
    messages: AgentMessage[],
    historyStart: number,
  ): void {
    if (!this.completeFn || contextWindow <= 0) return;

    const currentUtilization = totalTokens / contextWindow;
    const tokensUntilActivation = (this.config.activationThreshold - currentUtilization) * contextWindow;

    // Already past threshold, activation will handle it in transformContext
    if (tokensUntilActivation <= 0) return;

    const bufferInterval = this.buffering.computeBufferInterval(tokensUntilActivation, {
      bufferTargetCycles: this.config.bufferTargetCycles,
      bufferTokenCap: this.config.bufferTokenCap,
      bufferMinTokens: this.config.bufferMinTokens,
      utilityModelContextWindow: this.utilityModelContextWindow,
    });

    // Skip slot messages to avoid processing them as conversation content
    const history = messages.slice(historyStart);

    // Compute unobserved tokens (messages after buffer watermark)
    const watermark = this.buffering.getWatermark();
    const unobservedMessages = history.slice(watermark);
    const unobservedTokens = unobservedMessages.reduce((sum, msg) => {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      return sum + estimateTokens(content);
    }, 0);

    if (this.buffering.shouldBuffer(unobservedTokens, bufferInterval)) {
      // Snapshot the unobserved messages
      const snapshot = [...unobservedMessages];
      const endIndex = watermark + unobservedMessages.length;

      this.buffering.launchObserver(
        this.completeFn,
        snapshot,
        endIndex,
        this.observations || null,
        this.buildObserverConfig(),
        this.logger ?? undefined,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Idle digestion
  // -------------------------------------------------------------------------

  /**
   * Run pending observation buffering OUTSIDE a prompt: wait for any
   * in-flight observer to land its chunk, then observe the still-unobserved
   * tail (when it clears the buffering floor) and wait for that chunk too.
   *
   * Chunks stay buffered rather than activating here: activation trims raw
   * history, which is a threshold decision, while this call only ensures the
   * expensive observer work is DONE so the next activation (in-band or via
   * an explicit digestion pass) is a cheap chunk merge. This is the
   * primitive behind "digest during idle windows".
   *
   * Both waits are bounded by `timeoutMs` (a single wall-clock budget for
   * the whole call): callers hold the loop gate while digesting, so a hung
   * utility request must time the digestion out rather than wedge the gate.
   * A timed-out observer stays in flight and lands its chunk whenever it
   * settles; only the waiting is abandoned.
   *
   * @param messages - The full message array (slot messages included)
   * @param historyStart - Index of the first history message (past the system head and slots)
   * @param timeoutMs - Wall-clock budget for observer waits (default 60s)
   * @returns true when an observer call ran to completion in this digestion
   */
  async digestPendingBuffers(
    messages: AgentMessage[],
    historyStart: number,
    timeoutMs: number = DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS,
  ): Promise<boolean> {
    if (!this.completeFn) return false;
    const deadline = Date.now() + timeoutMs;

    // Let an already-running observer finish and record its chunk, so the
    // tail computed below starts at the settled watermark. On timeout,
    // skip launching a second observer behind a hung one.
    if (!(await this.buffering.waitForObserverSettledWithin(timeoutMs))) {
      this.logger?.warn('Idle digestion timed out waiting for the in-flight observer');
      return false;
    }

    const history = messages.slice(historyStart);
    const watermark = this.buffering.getWatermark();
    const unobserved = history.slice(watermark);
    if (unobserved.length === 0) return false;

    const unobservedTokens = unobserved.reduce((sum, msg) => {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      return sum + estimateTokens(content);
    }, 0);
    // Same floor onTurnEnd's buffering uses: observing a trivial tail
    // thrashes the utility model for nothing.
    if (unobservedTokens < this.config.bufferMinTokens) return false;

    this.buffering.launchObserver(
      this.completeFn,
      [...unobserved],
      watermark + unobserved.length,
      this.observations || null,
      this.buildObserverConfig(),
      this.logger ?? undefined,
    );
    if (!this.buffering.isObserverInFlight()) {
      // launchObserver declined (the coordinator was aborted): no observer
      // ran, so do not report one.
      return false;
    }
    if (!(await this.buffering.waitForObserverSettledWithin(deadline - Date.now()))) {
      this.logger?.warn('Idle digestion timed out waiting for its observer call');
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Slot content
  // -------------------------------------------------------------------------

  /**
   * Build the full observation slot content.
   *
   * Assembles the preamble, optional recall instructions, observation block,
   * and optional continuation hints into a single string.
   */
  buildSlotContent(): string {
    let content = OBSERVATION_CONTEXT_PREAMBLE;

    if (this.config.recall) {
      content += OBSERVATION_RECALL_INSTRUCTIONS;
    }

    content += '\n\n<observations>\n' + this.observations + '\n</observations>';

    if (this.continuationHint) {
      content += '\n\n<current-task>\n' + this.continuationHint.currentTask + '\n</current-task>';
      content += '\n\n<suggested-response>\n' + this.continuationHint.suggestedResponse + '\n</suggested-response>';
    }

    return content;
  }

  /**
   * Estimate the full slot content size for a given observation text.
   *
   * Used by the post-chunk utilization estimate to account for slot
   * overhead (preamble, XML wrappers, continuation hints) rather than
   * just the raw observation text.
   */
  private buildSlotContentForEstimate(observationText: string): string {
    let content = OBSERVATION_CONTEXT_PREAMBLE;

    if (this.config.recall) {
      content += OBSERVATION_RECALL_INSTRUCTIONS;
    }

    content += '\n\n<observations>\n' + observationText + '\n</observations>';

    if (this.continuationHint) {
      content += '\n\n<current-task>\n' + this.continuationHint.currentTask + '\n</current-task>';
      content += '\n\n<suggested-response>\n' + this.continuationHint.suggestedResponse + '\n</suggested-response>';
    }

    return content;
  }

  // -------------------------------------------------------------------------
  // Manual trigger
  // -------------------------------------------------------------------------

  /**
   * Force a synchronous observation cycle.
   *
   * Used by consumers after critical corrections to ensure the observation
   * log captures the correction immediately.
   *
   * @param messages - The full message array (may include slot messages)
   * @param historyStart - Index of the first history message (past the system head and slots)
   */
  async triggerObservation(
    messages: AgentMessage[],
    historyStart: number,
  ): Promise<void> {
    const history = messages.slice(historyStart);
    if (!this.completeFn || history.length === 0) return;

    const output = await runObserver(
      this.completeFn,
      history,
      this.observations || null,
      this.buildObserverConfig(),
    );

    // Merge observations
    if (this.observations) {
      this.observations += '\n\n' + output.observations;
    } else {
      this.observations = output.observations;
    }

    if (output.currentTask || output.suggestedResponse) {
      this.continuationHint = {
        currentTask: output.currentTask ?? '',
        suggestedResponse: output.suggestedResponse ?? '',
      };
    }

    this.observationTokenCount = estimateTokens(this.observations);

    // Fire observation event
    this.fireObservationEvent({
      compactedMessages: history,
      observations: this.observations,
      contextUtilization: 0, // manual trigger, utilization unknown
      sync: true,
      timestamp: new Date(),
    });
  }

  // -------------------------------------------------------------------------
  // State management
  // -------------------------------------------------------------------------

  /**
   * Returns the current state for session persistence.
   */
  getState(): ObservationalMemoryState {
    const buffering = this.buffering.getState();
    return {
      observations: this.observations,
      continuationHint: this.continuationHint,
      observationTokenCount: this.observationTokenCount,
      generationCount: this.generationCount,
      bufferedChunks: buffering.chunks,
      bufferWatermark: buffering.watermark,
    };
  }

  /**
   * Restore state from a previous session.
   *
   * Sets observations, continuation hint, token count, and generation count,
   * then restores the buffer (completed chunks + watermark) so the observer
   * work done in the previous session is not recomputed on resume.
   *
   * The watermark indexes into post-slot conversation history. Since
   * `restoreConversationHistory()` runs before this and splices the same
   * messages back at the same positions, the watermark aligns: the restored
   * chunks observe `messages[0:watermark]`, and the next activation trims
   * exactly those messages when it merges the chunk observations (no
   * duplication). No observer is launched on restore; the genuinely
   * unobserved remainder after the watermark is observed lazily on the next
   * `onTurnEnd` once it crosses the dynamic buffer interval.
   *
   * @param state - the persisted observational memory state
   * @param historyLength - length of the restored post-slot conversation
   *   history. Used to clamp a watermark that drifted ahead of the saved
   *   history (possible only on a hard crash; graceful save keeps them in
   *   sync). Defaults to the saved watermark (no clamp) when omitted.
   */
  restoreState(state: ObservationalMemoryState, historyLength?: number): void {
    this.observations = state.observations;
    this.continuationHint = state.continuationHint;
    this.observationTokenCount = state.observationTokenCount;
    this.generationCount = state.generationCount;

    // Legacy sessions saved before buffer persistence have no watermark.
    // Their chunks cannot be safely aligned with the restored history, so
    // discard them (the observer re-observes naturally). This preserves the
    // pre-persistence behavior for old session files.
    if (typeof state.bufferWatermark !== 'number') {
      this.buffering.restoreState({ chunks: [], watermark: 0 });
      return;
    }

    const maxWatermark = historyLength ?? state.bufferWatermark;
    const watermark = Math.max(0, Math.min(state.bufferWatermark, maxWatermark));

    this.buffering.restoreState({
      chunks: rehydrateChunks(state.bufferedChunks ?? []),
      watermark,
    });
  }

  /**
   * Reconcile buffer state after emergency truncation spliced the source
   * history from the front.
   *
   * The compaction manager's two truncation paths (Layer 3 fallback in
   * checkAndRunCompaction and reactive handleOverflowError) drop the oldest
   * `droppedFrontCount` messages from the post-slot source history. That is
   * the same region the buffer watermark indexes into, so the watermark must
   * shift down by the dropped count to stay aligned. Otherwise the next
   * activation slices the wrong prefix, trimming unobserved messages and
   * possibly orphaning a tool result at the new head.
   *
   * @param droppedFrontCount - messages removed from the front of the source
   */
  onSourceHistoryTruncated(droppedFrontCount: number): void {
    this.buffering.onSourceTruncated(droppedFrontCount);
  }

  /**
   * Reconcile buffer state after the tail of the post-slot source history
   * was trimmed (aborted/failed run stubs, unwound background deliveries).
   *
   * pi emits turn_end for those messages before Cortex trims them, so an
   * observer counting them may be in flight (or already completed) with an
   * end index past the new source length. The watermark is clamped so the
   * next activation cannot slice away messages that were never observed.
   *
   * @param postSlotLength - post-slot source history length after the trim
   */
  onSourceHistoryTailTrimmed(postSlotLength: number): void {
    this.buffering.onSourceTailTrimmed(postSlotLength);
  }

  /**
   * Returns the current slot content string.
   */
  getSlotContent(): string {
    return this.buildSlotContent();
  }

  /**
   * Returns just the observation text.
   */
  getObservations(): string {
    return this.observations;
  }

  /**
   * Token count of activated observations only.
   */
  getObservationTokenCount(): number {
    return this.observationTokenCount;
  }


  /**
   * Whether the observer or reflector is currently running in the background.
   */
  isProcessing(): boolean {
    return this.buffering.isObserverInFlight() || this.buffering.isReflectorInFlight();
  }

  /**
   * Whether the observer specifically is in-flight.
   */
  isObserverInFlight(): boolean {
    return this.buffering.isObserverInFlight();
  }

  /**
   * Whether the reflector specifically is in-flight.
   */
  isReflectorInFlight(): boolean {
    return this.buffering.isReflectorInFlight();
  }

  /**
   * Abort all in-flight operations. Delegates to buffering.abort().
   */
  abort(): void {
    this.buffering.abort();
  }

  /**
   * Whether recall is configured.
   */
  hasRecall(): boolean {
    return this.config.recall !== undefined;
  }

  /**
   * Get the recall config if provided.
   */
  getRecallConfig(): RecallConfig | undefined {
    return this.config.recall;
  }

  // -------------------------------------------------------------------------
  // Private: Reflection handling
  // -------------------------------------------------------------------------

  /**
   * Check and handle reflection after observation activation.
   *
   * Determines whether reflection should run (sync, async, or none) based
   * on the current observation token count relative to the effective
   * reflection threshold.
   *
   * @param allowSync - When false (non-blocking posture), the sync branch
   *   consumes a buffered reflection if one is ready (instant) but never
   *   runs the reflector inline; it launches one asynchronously instead.
   */
  private async handleReflection(
    allowSync = true,
    isStale?: () => boolean,
  ): Promise<void> {
    if (!this.completeFn) return;

    const effectiveThreshold = computeEffectiveReflectionThreshold(
      this.contextWindow,
      this.config.reflectionThreshold,
      this.utilityModelContextWindow,
    );

    const reflectionAction = this.buffering.shouldReflect(
      this.observationTokenCount,
      effectiveThreshold,
      this.config.reflectionBufferActivation,
    );

    if (reflectionAction === 'none') return;

    if (reflectionAction === 'sync') {
      const previousObservations = this.observations;

      // Check for a ready buffered reflection first. It condensed the log as
      // it was when the reflector launched; what was appended since stays.
      const buffered = this.buffering.consumeBufferedReflection();
      const rebased = buffered
        ? applyReflection(this.observations, buffered.input, buffered.observations)
        : null;
      if (buffered && rebased !== null) {
        this.observations = rebased;
        this.observationTokenCount = estimateTokens(this.observations);
        this.generationCount++;

        // Suppressed for an abandoned pass: the swap-in above keeps the
        // engine coherent, but the event must not report it as landed work.
        if (!isStale?.()) {
          this.fireReflectionEvent({
            previousObservations,
            newObservations: this.observations,
            generationCount: this.generationCount,
            compressionLevel: buffered.compressionLevel,
            timestamp: new Date(),
          });
        }
        return;
      }

      // No buffered reflection ready. Under the non-blocking posture the
      // inline call is forbidden: launch (or keep) an async reflector so
      // the condensed result buffers for a later swap-in instead.
      if (!allowSync) {
        if (!this.buffering.isReflectorInFlight()) {
          this.buffering.launchReflector(
            this.completeFn,
            this.observations,
            this.buildReflectorConfig(effectiveThreshold),
            this.logger ?? undefined,
          );
        }
        return;
      }

      // Run synchronously. A failed reflection keeps the current log: it is
      // larger than ideal, which costs tokens, not memory.
      const input = this.observations;
      let output: ReflectorOutput;
      try {
        output = await runReflector(
          this.completeFn,
          input,
          this.buildReflectorConfig(effectiveThreshold),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`In-band reflector failed; keeping the current observations: ${message}`);
        return;
      }
      const reflected = applyReflection(this.observations, input, output.observations);
      if (reflected === null) return;

      this.observations = reflected;
      this.observationTokenCount = estimateTokens(this.observations);
      this.generationCount++;

      if (!isStale?.()) {
        this.fireReflectionEvent({
          previousObservations,
          newObservations: this.observations,
          generationCount: this.generationCount,
          compressionLevel: output.compressionLevel,
          timestamp: new Date(),
        });
      }
      return;
    }

    if (reflectionAction === 'async') {
      // Launch async reflector
      const effectiveThresholdForReflector = computeEffectiveReflectionThreshold(
        this.contextWindow,
        this.config.reflectionThreshold,
        this.utilityModelContextWindow,
      );

      this.buffering.launchReflector(
        this.completeFn,
        this.observations,
        this.buildReflectorConfig(effectiveThresholdForReflector),
        this.logger ?? undefined,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private: Config builders (exactOptionalPropertyTypes safe)
  // -------------------------------------------------------------------------

  /**
   * Build the observer config object without assigning undefined to optional
   * properties (exactOptionalPropertyTypes is enabled).
   */
  private buildObserverConfig(): { previousObserverTokens: number; observerInstruction?: string } {
    const config: { previousObserverTokens: number; observerInstruction?: string } = {
      previousObserverTokens: this.config.previousObserverTokens,
    };
    if (this.config.observerInstruction !== undefined) {
      config.observerInstruction = this.config.observerInstruction;
    }
    return config;
  }

  /**
   * Build the reflector config object without assigning undefined to optional
   * properties (exactOptionalPropertyTypes is enabled).
   */
  private buildReflectorConfig(threshold: number): { reflectionThreshold: number; reflectorInstruction?: string } {
    const config: { reflectionThreshold: number; reflectorInstruction?: string } = {
      reflectionThreshold: threshold,
    };
    if (this.config.reflectorInstruction !== undefined) {
      config.reflectorInstruction = this.config.reflectorInstruction;
    }
    return config;
  }

  // -------------------------------------------------------------------------
  // Private: Chunk merging
  // -------------------------------------------------------------------------

  /**
   * Merge buffered observation chunks into a single observation text.
   *
   * Concatenates all chunk observation texts with double newlines. Uses
   * the latest chunk's currentTask and suggestedResponse (latest wins).
   */
  private mergeChunks(
    chunks: ObservationChunk[],
  ): { observations: string; hint: ContinuationHint | null } {
    const observationParts: string[] = [];

    // Find the latest chunk that produced at least one meaningful hint field.
    // Each observer only sees its own batch of messages, so the latest chunk
    // reflects the most recent state of the conversation. We do NOT mix fields
    // across chunks: that would risk injecting a stale currentTask from an
    // earlier chunk when the conversation has since moved on to something else.
    //
    // The parser already rejects placeholder-only content, so an observer that
    // echoed the prompt template without filling it in will have undefined
    // hint fields (not empty strings).
    let latestHintChunk: ObservationChunk | null = null;

    for (const chunk of chunks) {
      observationParts.push(chunk.observations);
      if (chunk.currentTask || chunk.suggestedResponse) {
        latestHintChunk = chunk;
      }
    }

    // If no chunk produced hints, preserve the existing hint from prior
    // activation cycles. That hint is still more relevant than nothing, since
    // it came from the observer that ran at the end of the previous cycle
    // (itself more recent than anything older in this cycle).
    const hint: ContinuationHint | null = latestHintChunk
      ? {
          currentTask: latestHintChunk.currentTask ?? '',
          suggestedResponse: latestHintChunk.suggestedResponse ?? '',
        }
      : this.continuationHint;

    return {
      observations: observationParts.join('\n\n'),
      hint,
    };
  }

  // -------------------------------------------------------------------------
  // Private: Event firing
  // -------------------------------------------------------------------------

  /**
   * Fire all observation handlers. Each handler is individually try/catch
   * wrapped to prevent one handler from breaking others.
   */
  private fireObservationEvent(event: ObservationEvent): void {
    for (const handler of this.observationHandlers) {
      try {
        handler(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`Observation handler threw: ${message}`);
      }
    }
  }

  /**
   * Fire all reflection handlers. Each handler is individually try/catch
   * wrapped to prevent one handler from breaking others.
   */
  private fireReflectionEvent(event: ReflectionEvent): void {
    for (const handler of this.reflectionHandlers) {
      try {
        handler(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.warn(`Reflection handler threw: ${message}`);
      }
    }
  }
}

