/**
 * Buffering coordinator for the observational memory system.
 *
 * Manages the async lifecycle of observer and reflector operations,
 * ensuring at-most-one-in-flight per operation type, computing dynamic
 * buffer intervals, and handling abort/cleanup.
 *
 * The coordinator does not own the observation slot or conversation
 * history. It produces observation chunks, recorded in its
 * ObservationLedger at the message range each covers, and buffered
 * reflections; the ObservationalMemoryEngine consumes both during
 * activation.
 *
 * References:
 *   - observational-memory-architecture.md (Observer System, Reflector System)
 *   - observer.ts (runObserver)
 *   - reflector.ts (runReflector)
 */

import type { CompleteFn } from './types.js';
import type { AgentMessage } from '../../context-manager.js';
import type { ObservationChunk, ObserverOutput, ReflectorOutput } from './types.js';
import { ObservationLedger } from './ledger.js';
import type { LedgerState, RangedChunk } from './ledger.js';
import { runObserver } from './observer.js';
import { runReflector } from './reflector.js';
import { estimateTokens } from '../../token-estimator.js';
import { MemoryCallError, SINGLE_ATTEMPT } from './calls.js';
import type { CallPolicy } from './calls.js';
import type { MemoryCallOutcomes, MemoryCallTrigger } from './health.js';

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

  /** Which messages are observed, buffered, or pending, by index. */
  readonly ledger = new ObservationLedger();
  private inFlightObserver: { promise: Promise<ObserverOutput>; token: number } | null = null;
  private inFlightReflector: Promise<ReflectorOutput> | null = null;
  private bufferedReflection: { observations: string; compressionLevel: number; input: string } | null = null;
  private aborted: boolean = false;
  /** Fires on abort(): background calls stop retrying when the loop is destroyed. */
  private readonly lifetime = new AbortController();
  private readonly policy: () => CallPolicy;
  private readonly outcomes: MemoryCallOutcomes | null;

  /**
   * @param options.policy - Retry and timeout policy for each background
   *   call (default: one attempt, no timeout)
   * @param options.outcomes - Told how each background call ended
   */
  constructor(options: { policy?: () => CallPolicy; outcomes?: MemoryCallOutcomes } = {}) {
    this.policy = options.policy ?? ((): CallPolicy => SINGLE_ATTEMPT);
    this.outcomes = options.outcomes ?? null;
  }

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
   * Launch an async observer call over [watermark, endIndex). Does NOT await
   * it.
   *
   * The call's range is pending in the ledger, which moves it with every
   * rewrite of the source. When the observer completes, its output lands as
   * a chunk covering that range. A call invalidated meanwhile (a restore, a
   * reset, an in-band observation of the same messages) lands nothing.
   *
   * @param complete - the LLM completion function
   * @param messages - the unobserved messages to process (snapshot)
   * @param endIndex - the index in conversation history where these messages end
   * @param previousObservations - current observation text for context
   * @param config - observer config
   * @param logger - optional logger for error reporting
   * @param trigger - what started the call, for failure reports
   */
  launchObserver(
    complete: CompleteFn,
    messages: AgentMessage[],
    endIndex: number,
    previousObservations: string | null,
    config: { previousObserverTokens: number; observerInstruction?: string; maxInputTokens?: number },
    logger?: { warn: (msg: string) => void },
    trigger: MemoryCallTrigger = 'buffer',
  ): void {
    if (this.aborted) return;

    const token = this.ledger.begin(endIndex);
    const promise = runObserver(complete, messages, previousObservations, config, {
      policy: this.policy(),
      signal: this.lifetime.signal,
    });
    const flight = { promise, token };
    this.inFlightObserver = flight;

    promise
      .then((output: ObserverOutput) => {
        if (this.aborted) return;
        this.outcomes?.succeeded('observe');
        // Invalidated: this call no longer owns the in-flight slot, which
        // may hold a newer call, and its range no longer maps.
        if (this.inFlightObserver !== flight) return;
        this.inFlightObserver = null;

        this.ledger.land(token, chunkFromOutput(output, messages));
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (logger) {
          logger.warn(`Observer buffer call failed: ${message}`);
        }
        this.reportFailure('observe', trigger, err);
        if (this.inFlightObserver !== flight) return;
        this.inFlightObserver = null;
        this.ledger.drop(token);
      });
  }

  /**
   * Check if there are completed buffer chunks ready for activation.
   */
  hasCompletedChunks(): boolean {
    return this.ledger.completedChunks().length > 0;
  }

  /**
   * Get all completed chunks (each with the end of its range) and the
   * watermark up to which messages are observed.
   */
  getCompletedChunks(): { chunks: RangedChunk[]; watermark: number } {
    return { chunks: this.ledger.completedChunks(), watermark: this.ledger.watermark };
  }

  /**
   * Forget the in-flight observer: its messages are about to be observed
   * by a caller that waits, and its result must not land a second chunk
   * for them.
   */
  invalidateObserver(): void {
    this.ledger.invalidatePending();
    this.inFlightObserver = null;
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
   * @param trigger - what started the call, for failure reports
   */
  launchReflector(
    complete: CompleteFn,
    observations: string,
    config: { reflectionThreshold: number; reflectorInstruction?: string },
    logger?: { warn: (msg: string) => void },
    trigger: MemoryCallTrigger = 'buffer',
  ): void {
    if (this.aborted) return;

    const promise = runReflector(complete, observations, config, {
      policy: this.policy(),
      signal: this.lifetime.signal,
    });
    this.inFlightReflector = promise;

    promise
      .then((output: ReflectorOutput) => {
        if (this.aborted) return;
        this.outcomes?.succeeded('reflect');
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
        this.reportFailure('reflect', trigger, err);
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
   * save). Only completed chunks, their ranges, and the observed prefix
   * are persisted.
   */
  getState(): LedgerState {
    return this.ledger.getState();
  }

  /**
   * Restore state from a previous session (see ObservationLedger.restore).
   *
   * Work in flight belongs to the replaced state: an observer's indices and a
   * reflection's input describe history and a log that no longer exist, so
   * both are invalidated (they settle unobserved) along with any buffered
   * reflection.
   */
  restoreState(
    state: { chunks: ObservationChunk[]; watermark?: number; observedPrefix?: number },
    historyLength?: number,
  ): void {
    this.invalidateInFlight();
    this.ledger.restore(state, historyLength);
  }

  /** Nothing observed, buffered, or in flight. */
  reset(): void {
    this.invalidateInFlight();
    this.ledger.reset();
  }

  /**
   * Report a background call that produced no result. A call stopped by
   * the coordinator's own abort is not the memory model's failure.
   */
  private reportFailure(operation: 'observe' | 'reflect', trigger: MemoryCallTrigger, err: unknown): void {
    if (this.aborted) return;
    if (err instanceof MemoryCallError) {
      if (err.aborted) return;
      this.outcomes?.failed({ operation, trigger, error: err.lastError, attempts: err.attempts });
      return;
    }
    // A reflection no smaller than its input, thrown outside the call policy.
    const error = err instanceof Error ? err : new Error(String(err));
    this.outcomes?.failed({ operation, trigger, error, attempts: 1 });
  }

  /** Forget the work in flight and any buffered reflection. */
  private invalidateInFlight(): void {
    this.ledger.invalidatePending();
    this.inFlightObserver = null;
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
    this.lifetime.abort();
    this.ledger.invalidatePending();
    this.inFlightObserver = null;
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
    const inFlight = this.inFlightObserver?.promise;
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
    const inFlight = this.inFlightObserver?.promise;
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
   * where the observed messages end).
   */
  getWatermark(): number {
    return this.ledger.watermark;
  }

  /**
   * Reconcile buffer state after the source conversation history was
   * trimmed from the tail (an aborted or failed run's stub, or a failed
   * background delivery being unwound).
   *
   * pi emits turn_end for those messages before Cortex trims them, so an
   * observer may have launched with a range that counts them, or already
   * completed and recorded a chunk past the new source length. Every index
   * is clamped to the surviving length: text describing a trimmed stub is
   * harmless, while the clamped index stays aligned with the source.
   *
   * @param postSlotLength - length of the post-slot source history after
   *   the tail trim
   */
  onSourceTailTrimmed(postSlotLength: number): void {
    this.ledger.onTailTrimmed(postSlotLength);
  }
}

/** The chunk an observer output records for the messages it observed. */
export function chunkFromOutput(output: ObserverOutput, messages: AgentMessage[]): ObservationChunk {
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
  const chunk: ObservationChunk = {
    observations: output.observations,
    messageTokensObserved,
    createdAt: new Date(),
  };
  if (output.currentTask) chunk.currentTask = output.currentTask;
  if (output.suggestedResponse) chunk.suggestedResponse = output.suggestedResponse;
  return chunk;
}
