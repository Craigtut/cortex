/**
 * Buffering coordinator for the observational memory system.
 *
 * Manages the async lifecycle of observer and reflector operations,
 * ensuring at-most-one-in-flight per operation type, computing dynamic
 * buffer intervals, and handling abort/cleanup.
 *
 * The coordinator does not own the observation slot or conversation
 * history. It produces observation chunks and buffered reflections that
 * the ObservationalMemoryEngine consumes during activation.
 *
 * References:
 *   - observational-memory-architecture.md (Observer System, Reflector System)
 *   - observer.ts (runObserver)
 *   - reflector.ts (runReflector)
 */

import type { CompleteFn } from '../compaction.js';
import type { AgentMessage } from '../../context-manager.js';
import type { ObservationChunk, ObserverOutput, ReflectorOutput } from './types.js';
import { runObserver } from './observer.js';
import { runReflector } from './reflector.js';
import { estimateTokens } from '../../token-estimator.js';

// ---------------------------------------------------------------------------
// BufferingCoordinator
// ---------------------------------------------------------------------------

/**
 * Coordinates async observer and reflector operations for the
 * observational memory system.
 *
 * Ensures at-most-one observer and at-most-one reflector call are
 * in-flight at any time. Completed observer results are stored as
 * {@link ObservationChunk}s until the engine activates them. Completed
 * reflector results are stored until the engine swaps them in.
 *
 * All in-flight operations are fire-and-forget from the caller's
 * perspective. The coordinator attaches `.then()` / `.catch()` handlers
 * internally and never surfaces unhandled rejections.
 */
export class BufferingCoordinator {
  // --- Internal state ---

  private chunks: ObservationChunk[] = [];
  private bufferWatermark: number = 0;
  private inFlightObserver: Promise<ObserverOutput> | null = null;
  private inFlightObserverEndIndex: number | null = null;
  private inFlightReflector: Promise<ReflectorOutput> | null = null;
  private bufferedReflection: { observations: string; compressionLevel: number; input: string } | null = null;
  private aborted: boolean = false;

  /**
   * Activation epoch. Incremented each time activation consumes chunks or
   * a sync observer trims messages. In-flight observers capture the epoch
   * at launch and discard their result if the epoch has changed by the time
   * they complete. This prevents stale chunks from landing after sync
   * activation has already processed those messages.
   */
  private activationEpoch: number = 0;

  // -------------------------------------------------------------------------
  // Buffer Interval Calculation
  // -------------------------------------------------------------------------

  /**
   * Compute the dynamic buffer interval based on current context state.
   *
   * The interval targets `bufferTargetCycles` observer calls between the
   * current utilization and the activation threshold. It is clamped between
   * `bufferMinTokens` and `effectiveBufferCap` (the lesser of
   * `bufferTokenCap` and 60% of the utility model's context window). The cap
   * wins when a small utility model cannot accommodate the preferred minimum.
   *
   * @param tokensUntilActivation - tokens remaining before activation threshold
   * @param config - buffer interval configuration
   * @returns the buffer interval in tokens
   */
  computeBufferInterval(
    tokensUntilActivation: number,
    config: {
      bufferTargetCycles: number;
      bufferTokenCap: number;
      bufferMinTokens: number;
      utilityModelContextWindow: number;
    },
  ): number {
    const effectiveBufferCap = Math.min(
      config.bufferTokenCap,
      config.utilityModelContextWindow * 0.6,
    );
    const dynamicInterval = tokensUntilActivation / config.bufferTargetCycles;
    return Math.min(
      Math.max(dynamicInterval, config.bufferMinTokens),
      effectiveBufferCap,
    );
  }

  // -------------------------------------------------------------------------
  // Observer Buffering
  // -------------------------------------------------------------------------

  /**
   * Check if a buffer observation should be triggered based on
   * unobserved tokens.
   *
   * Returns true when the unobserved token count meets or exceeds the
   * buffer interval, no observer call is currently in flight, and the
   * coordinator has not been aborted.
   *
   * @param unobservedTokens - estimated tokens of messages after the buffer watermark
   * @param bufferInterval - computed from {@link computeBufferInterval}
   * @returns true if a buffer observation should launch
   */
  shouldBuffer(unobservedTokens: number, bufferInterval: number): boolean {
    return (
      unobservedTokens >= bufferInterval &&
      !this.isObserverInFlight() &&
      !this.aborted
    );
  }

  /**
   * Launch an async observer call. Does NOT await it.
   *
   * Stores the in-flight promise and tracks the end index of messages
   * being processed. When the observer completes, its output is converted
   * to an {@link ObservationChunk} and appended to the internal chunk
   * list. If the coordinator has been aborted before the observer
   * completes, the result is discarded.
   *
   * @param complete - the LLM completion function
   * @param messages - the unobserved messages to process (snapshot)
   * @param endIndex - the index in conversation history where these messages end
   * @param previousObservations - current observation text for context
   * @param config - observer config
   * @param logger - optional logger for error reporting
   */
  launchObserver(
    complete: CompleteFn,
    messages: AgentMessage[],
    endIndex: number,
    previousObservations: string | null,
    config: { previousObserverTokens: number; observerInstruction?: string },
    logger?: { warn: (msg: string) => void },
  ): void {
    if (this.aborted) return;

    // Estimate tokens from the message snapshot for the chunk metadata
    const messageTokensObserved = messages.reduce((sum, msg) => {
      if (typeof msg.content === 'string') {
        return sum + estimateTokens(msg.content);
      }
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .map((part) => {
            if (typeof part.text === 'string') return part.text;
            return JSON.stringify(part);
          })
          .join(' ');
        return sum + estimateTokens(text);
      }
      return sum;
    }, 0);

    const promise = runObserver(complete, messages, previousObservations, config);
    this.inFlightObserver = promise;
    this.inFlightObserverEndIndex = endIndex;

    // Capture the activation epoch at launch. If activation fires (sync or
    // chunk-based) before this observer completes, the epoch will have
    // advanced and the result is stale (those messages were already observed).
    const launchEpoch = this.activationEpoch;

    promise
      .then((output: ObserverOutput) => {
        if (this.aborted) return;
        // Invalidated (a restore or reset replaced the buffer): this call
        // no longer owns the in-flight slot, which may hold a newer call.
        if (this.inFlightObserver !== promise) return;

        // Discard if activation already processed these messages
        if (this.activationEpoch !== launchEpoch) {
          this.inFlightObserver = null;
          this.inFlightObserverEndIndex = null;
          return;
        }

        const chunk: ObservationChunk = {
          observations: output.observations,
          messageTokensObserved,
          createdAt: new Date(),
        };

        if (output.currentTask) {
          chunk.currentTask = output.currentTask;
        }
        if (output.suggestedResponse) {
          chunk.suggestedResponse = output.suggestedResponse;
        }

        this.chunks.push(chunk);
        this.bufferWatermark = this.inFlightObserverEndIndex ?? endIndex;
        this.inFlightObserver = null;
        this.inFlightObserverEndIndex = null;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (logger) {
          logger.warn(`Observer buffer call failed: ${message}`);
        }
        if (this.inFlightObserver !== promise) return;
        this.inFlightObserver = null;
        this.inFlightObserverEndIndex = null;
      });
  }

  /**
   * Check if there are completed buffer chunks ready for activation.
   */
  hasCompletedChunks(): boolean {
    return this.chunks.length > 0;
  }

  /**
   * Get all completed chunks and the watermark up to which messages
   * are covered.
   *
   * Does NOT clear state. Call {@link commitActivation} after
   * successfully activating.
   */
  getCompletedChunks(): { chunks: ObservationChunk[]; watermark: number } {
    return { chunks: [...this.chunks], watermark: this.bufferWatermark };
  }

  /**
   * Called after successful activation to reset buffer state.
   *
   * Clears accumulated chunks and resets the watermark to 0 since the
   * messages it pointed to have been removed from the conversation
   * history.
   */
  commitActivation(): void {
    this.chunks = [];
    this.bufferWatermark = 0;
    this.activationEpoch++;
  }

  // -------------------------------------------------------------------------
  // Reflector Buffering
  // -------------------------------------------------------------------------

  /**
   * Check if reflection should be triggered based on observation token count.
   *
   * Returns:
   * - `'sync'` when observation tokens are at or above the effective threshold
   *   (the caller decides whether to use a buffered reflection or force a sync call)
   * - `'async'` when observation tokens are between the buffer activation point
   *   and the threshold, and no reflector is currently in flight
   * - `'none'` otherwise
   *
   * @param observationTokens - current observation slot token count
   * @param effectiveThreshold - from computeEffectiveReflectionThreshold
   * @param reflectionBufferActivation - fraction at which to start async reflection
   * @returns action indicator
   */
  shouldReflect(
    observationTokens: number,
    effectiveThreshold: number,
    reflectionBufferActivation: number,
  ): 'none' | 'async' | 'sync' {
    if (observationTokens >= effectiveThreshold) {
      return 'sync';
    }

    const asyncTrigger = effectiveThreshold * reflectionBufferActivation;
    if (
      observationTokens >= asyncTrigger &&
      !this.isReflectorInFlight() &&
      !this.aborted
    ) {
      return 'async';
    }

    return 'none';
  }

  /**
   * Launch an async reflector call. Does NOT await it.
   *
   * When the reflector completes, its result is stored in
   * `bufferedReflection` for later consumption via
   * {@link consumeBufferedReflection}. If the coordinator has been
   * aborted before the reflector completes, the result is discarded.
   *
   * @param complete - the LLM completion function
   * @param observations - the current observation text to consolidate
   * @param config - reflector config
   * @param logger - optional logger for error reporting
   */
  launchReflector(
    complete: CompleteFn,
    observations: string,
    config: { reflectionThreshold: number; reflectorInstruction?: string },
    logger?: { warn: (msg: string) => void },
  ): void {
    if (this.aborted) return;

    const promise = runReflector(complete, observations, config);
    this.inFlightReflector = promise;

    promise
      .then((output: ReflectorOutput) => {
        if (this.aborted) return;
        // Invalidated by a restore or reset: the log it condensed is gone.
        if (this.inFlightReflector !== promise) return;

        this.bufferedReflection = {
          observations: output.observations,
          compressionLevel: output.compressionLevel,
          input: observations,
        };
        this.inFlightReflector = null;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (logger) {
          logger.warn(`Reflector buffer call failed: ${message}`);
        }
        if (this.inFlightReflector !== promise) return;
        this.inFlightReflector = null;
      });
  }

  /**
   * Check if a buffered reflection is ready to swap in.
   */
  hasBufferedReflection(): boolean {
    return this.bufferedReflection !== null;
  }

  /**
   * Get the buffered reflection and clear it.
   *
   * Returns the consolidated observations, the compression level that was
   * applied, and the exact log the reflection condensed (`input`), or null
   * if no buffered reflection is available. The log may have grown since
   * the reflector launched; the caller applies the result only onto a log
   * that still starts with `input`.
   */
  consumeBufferedReflection(): {
    observations: string;
    compressionLevel: number;
    input: string;
  } | null {
    const result = this.bufferedReflection;
    this.bufferedReflection = null;
    return result;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Get the current state for session persistence.
   *
   * In-flight operations are NOT included (they are lost on session
   * save). Only completed chunks and the watermark are persisted.
   */
  getState(): { chunks: ObservationChunk[]; watermark: number } {
    return { chunks: [...this.chunks], watermark: this.bufferWatermark };
  }

  /**
   * Restore state from a previous session.
   *
   * Work in flight belongs to the replaced state: an observer's indices and a
   * reflection's input describe history and a log that no longer exist, so
   * both are invalidated (they settle unobserved) along with any buffered
   * reflection.
   */
  restoreState(state: { chunks: ObservationChunk[]; watermark: number }): void {
    this.invalidateInFlight();
    this.chunks = [...state.chunks];
    this.bufferWatermark = state.watermark;
  }

  /** Forget the work in flight and any buffered reflection. */
  private invalidateInFlight(): void {
    this.activationEpoch++;
    this.inFlightObserver = null;
    this.inFlightObserverEndIndex = null;
    this.inFlightReflector = null;
    this.bufferedReflection = null;
  }

  /**
   * Abort all in-flight operations. Called on agent destruction.
   *
   * Sets the aborted flag so that any in-flight promise handlers
   * discard their results when they eventually resolve.
   */
  abort(): void {
    this.aborted = true;
    this.inFlightObserver = null;
    this.inFlightObserverEndIndex = null;
    this.inFlightReflector = null;
  }

  /**
   * Whether an observer call is currently in flight.
   */
  isObserverInFlight(): boolean {
    return this.inFlightObserver !== null;
  }

  /**
   * Resolve once the in-flight observer (if any) has settled. The internal
   * completion handler was attached at launch, so by the time this resolves
   * the chunk (or the failure cleanup) is already recorded. Resolves
   * immediately when nothing is in flight; never rejects.
   */
  async waitForObserverSettled(): Promise<void> {
    const inFlight = this.inFlightObserver;
    if (!inFlight) return;
    await inFlight.then(
      () => {},
      () => {},
    );
  }

  /**
   * Like {@link waitForObserverSettled}, but bounded by a wall clock:
   * resolves false when the in-flight observer has not settled within
   * `timeoutMs`. The observer stays in flight; its chunk (or failure
   * cleanup) is still recorded whenever it eventually settles. This bound
   * exists for callers that hold a gate while waiting (idle digestion): an
   * unbounded await on a hung provider request would wedge the gate
   * forever. Never rejects.
   */
  async waitForObserverSettledWithin(timeoutMs: number): Promise<boolean> {
    const inFlight = this.inFlightObserver;
    if (!inFlight) return true;
    const settled = inFlight.then(
      () => true,
      () => true,
    );
    if (!Number.isFinite(timeoutMs)) return settled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      timer.unref?.();
    });
    try {
      return await Promise.race([settled, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Whether a reflector call is currently in flight.
   */
  isReflectorInFlight(): boolean {
    return this.inFlightReflector !== null;
  }

  /**
   * Get the buffer watermark (index into conversation history marking
   * where the last completed observation ended).
   */
  getWatermark(): number {
    return this.bufferWatermark;
  }

  /**
   * Set the watermark. Used during initialization or after manual
   * adjustments to the conversation history.
   */
  setWatermark(index: number): void {
    this.bufferWatermark = index;
  }

  /**
   * Advance the activation epoch. Called when a sync activation trims
   * messages outside of the normal commitActivation() flow (e.g., the
   * engine's Step 2 sync observer path). This invalidates any in-flight
   * observers that were launched before the sync activation.
   */
  advanceEpoch(): void {
    this.activationEpoch++;
  }

  /**
   * Reconcile buffer state after the source conversation history was
   * truncated from the front (emergency truncation / reactive overflow).
   *
   * `droppedFrontCount` messages were removed from the head of the source
   * history, so every surviving message shifted down by that many indices.
   * The watermark, which counts observed messages from the front, is
   * clamped by the same amount: observed messages that were dropped no
   * longer count, and if the whole observed prefix was dropped the
   * watermark falls to 0. Without this shift the next activation would
   * slice `sourceHistory.slice(0, staleWatermark)`, silently trimming
   * still-unobserved messages and potentially leaving an orphaned tool
   * result at the head of the surviving source (a hard provider 400).
   *
   * The activation epoch is advanced so any in-flight observer (whose
   * captured end index now points at stale positions) discards its result
   * on completion instead of landing a chunk with a misaligned watermark.
   *
   * Completed chunks are kept: their observation text stays valid, and the
   * clamped watermark keeps them consistent with the truncated source.
   *
   * @param droppedFrontCount - number of messages removed from the front of
   *   the source history. No-op when zero or negative.
   */
  onSourceTruncated(droppedFrontCount: number): void {
    if (droppedFrontCount <= 0) return;
    this.bufferWatermark = Math.max(0, this.bufferWatermark - droppedFrontCount);
    this.activationEpoch++;
  }

  /**
   * Reconcile buffer state after the source conversation history was
   * trimmed from the tail (an aborted or failed run's stub, or a failed
   * background delivery being unwound).
   *
   * pi emits turn_end for those messages before Cortex trims them, so an
   * observer may have launched with an endIndex that counts them, or
   * already completed and moved the watermark past the new source length.
   * Without clamping, later messages land at indices the watermark already
   * claims as observed, and the next activation slices away an unobserved
   * message (or orphans a tool result at the surviving head).
   *
   * Clamping (rather than epoch-advancing) keeps the observation content:
   * text describing a trimmed stub is harmless, while the clamped index
   * stays aligned with the surviving source prefix.
   *
   * @param postSlotLength - length of the post-slot source history after
   *   the tail trim
   */
  onSourceTailTrimmed(postSlotLength: number): void {
    const length = Math.max(0, postSlotLength);
    if (this.bufferWatermark > length) {
      this.bufferWatermark = length;
    }
    if (this.inFlightObserverEndIndex !== null && this.inFlightObserverEndIndex > length) {
      this.inFlightObserverEndIndex = length;
    }
  }
}
