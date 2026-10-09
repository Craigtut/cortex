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
  MemoryErrorInfo,
  MemoryRecoveredInfo,
} from './types.js';
import { OBSERVATIONAL_MEMORY_DEFAULTS } from './constants.js';
import { runObserver } from './observer.js';
import { Reflection } from './reflection.js';
import { BufferingCoordinator, chunkFromOutput } from './buffering.js';
import { estimateTokens } from '../../token-estimator.js';
import { MemoryCallError, RETRY_BACKOFF_MS, deadlineSignal } from './calls.js';
import type { CallPolicy } from './calls.js';
import { MemoryHealth } from './health.js';
import { messageTokens, pieceEnd } from './units.js';
import { selectTail } from './tail.js';
import { keptAfter, removedBy, removesAny, swapCut } from './swap.js';
import type { SwapCut } from './swap.js';
import { ObservationLog } from './log.js';
import type { MemoryCallTrigger } from './health.js';

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
  MemoryCallTrigger,
  MemoryErrorInfo,
  MemoryRecoveredInfo,
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

/** Whether `promise` settled before `signal` fired. Never rejects. */
function settledUnlessAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      },
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      },
    );
  });
}

/** The continuation hint an observer output carries, if it carries one. */
function hintOf(output: ObserverOutput): ContinuationHint | null {
  if (!output.currentTask && !output.suggestedResponse) return null;
  return { currentTask: output.currentTask ?? '', suggestedResponse: output.suggestedResponse ?? '' };
}

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
  private readonly log: ObservationLog;
  private readonly reflection: Reflection;
  private contextWindow: number = 0;
  private utilityModelContextWindow: number = 0;
  private slotIndex: number;
  private logger: { warn: (msg: string) => void; info: (msg: string) => void } | null = null;
  private readonly health = new MemoryHealth((message) => this.logger?.warn(message));

  // Event handler arrays (method-level registration, multiple handlers)
  private observationHandlers: Array<(event: ObservationEvent) => void> = [];

  constructor(config: Partial<ObservationalMemoryConfig>, slotIndex: number) {
    this.slotIndex = slotIndex;
    this.buffering = new BufferingCoordinator({
      policy: () => this.callPolicy(),
      outcomes: this.health,
    });

    // Merge with defaults. Optional fields (observerInstruction,
    // reflectorInstruction, recall) are only included when provided.
    this.config = {
      ...OBSERVATIONAL_MEMORY_DEFAULTS,
      ...config,
    };
    this.log = new ObservationLog(this.config.recall !== undefined);
    this.reflection = new Reflection({
      log: this.log,
      buffering: this.buffering,
      health: this.health,
      completeFn: () => this.completeFn,
      policy: () => this.callPolicy(),
      windows: () => ({ contextWindow: this.contextWindow, utilityModelContextWindow: this.utilityModelContextWindow }),
      config: () => this.config,
      logger: () => this.logger,
    });
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
    this.reflection.onReflection(handler);
  }

  /** Register a handler for observer or reflector calls that failed after all attempts. */
  onMemoryError(handler: (info: MemoryErrorInfo) => void): void {
    this.health.onError(handler);
  }

  /** Register a handler for the first successful memory call after failures. */
  onMemoryRecovered(handler: (info: MemoryRecoveredInfo) => void): void {
    this.health.onRecovered(handler);
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
   *   signal is the run's abort: aborting ends the pass's memory calls at
   *   once and the pass applies nothing.
   * @returns Modified context with updated observations and trimmed history
   */
  async applyInTransformContext(
    context: AgentContext,
    utilization: number,
    historyStart: number,
    getHistory: (ctx: AgentContext) => AgentMessage[],
    setHistory: (ctx: AgentContext, history: AgentMessage[]) => AgentContext,
    getSourceHistory: () => AgentMessage[],
    setSourceHistory: (history: AgentMessage[]) => boolean | void,
    options?: { allowSync?: boolean; isStale?: () => boolean; signal?: AbortSignal },
  ): Promise<AgentContext> {
    if (utilization < this.config.activationThreshold) {
      return context;
    }
    // A degraded memory model gets no in-band calls: the pass blocks a
    // request once per failure episode, not on every LLM call.
    const allowSync = (options?.allowSync ?? true) && !this.health.isDegraded;
    const isStale = options?.isStale;
    const runSignal = options?.signal;
    // Every in-band memory call of this pass shares one deadline.
    const deadline = deadlineSignal(this.config.blockingBudgetMs);
    const passSignal = runSignal ? AbortSignal.any([deadline.signal, runSignal]) : deadline.signal;
    try {
      return await this.activate(
        context, utilization, historyStart, setHistory, getSourceHistory, setSourceHistory,
        { allowSync, passSignal, ...(isStale ? { isStale } : {}), ...(runSignal ? { runSignal } : {}) },
      );
    } finally {
      deadline.clear();
    }
  }

  private async activate(
    context: AgentContext,
    utilization: number,
    historyStart: number,
    setHistory: (ctx: AgentContext, history: AgentMessage[]) => AgentContext,
    getSourceHistory: () => AgentMessage[],
    setSourceHistory: (history: AgentMessage[]) => boolean | void,
    pass: { allowSync: boolean; passSignal: AbortSignal; isStale?: () => boolean; runSignal?: AbortSignal },
  ): Promise<AgentContext> {
    const { allowSync, passSignal, isStale, runSignal } = pass;

    // --- Activation ---
    // Planned from a snapshot: every await settles before anything changes,
    // so a failed or abandoned observer call can never leave messages
    // removed whose observations were not recorded.
    const sourceHistory = getSourceHistory();
    const tail = selectTail(sourceHistory, this.tailBudget());

    // Step 1: Would swapping in what is already observed be enough? If not,
    // and blocking work is allowed, observe up to the tail while we wait.
    let sync = false;
    if (
      allowSync &&
      this.completeFn &&
      this.buffering.getWatermark() < tail.start &&
      this.utilizationAfter(sourceHistory, swapCut(sourceHistory, tail, this.buffering.getWatermark()), utilization)
        >= this.config.activationThreshold
    ) {
      sync = await this.catchUp(sourceHistory, tail.start, passSignal, isStale);
    }

    // An abandoned or aborted pass applies nothing: its rewrite would be
    // discarded by the owner (or its request never sent); what it observed
    // stays buffered.
    if (isStale?.() || runSignal?.aborted) return context;

    // Step 2: Swap, synchronously: cut, merge, rewrite.
    const swap = swapCut(sourceHistory, tail, this.buffering.getWatermark());
    if (removesAny(swap)) {
      const priorPrefix = this.buffering.ledger.observedPrefix;
      const consumed = this.buffering.ledger.removePrefix(swap.cut, swap.keep ?? undefined);
      const observedEnd = consumed.length > 0 ? consumed[consumed.length - 1]!.endIndex : priorPrefix;
      const before = this.log.tokenCount;
      if (consumed.length > 0) {
        const swapped = this.log.merge(consumed);
        this.log.append(swapped.observations, swapped.hint);
      }
      const removedMessages = removedBy(sourceHistory, swap);
      setSourceHistory(keptAfter(sourceHistory, swap));

      // Step 3: Report it (the pass is known live: stale returned above).
      const tokensBefore = Math.round(utilization * this.contextWindow);
      const removedTokens = removedMessages.reduce((sum, message) => sum + messageTokens(message), 0);
      this.fireObservationEvent({
        trigger: 'activation',
        observedMessages: sourceHistory.slice(priorPrefix, observedEnd),
        removedMessages,
        observations: this.log.text,
        contextUtilization: utilization,
        tokensBefore,
        tokensAfter: Math.max(0, tokensBefore - removedTokens + (this.log.tokenCount - before)),
        sync,
        timestamp: new Date(),
      });
    }

    // Step 4: Handle reflection (may condense the log)
    await this.reflection.reflectIfDue(allowSync, isStale, passSignal);

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

  /** Tokens the verbatim tail may hold: a share of the window, capped. */
  private tailBudget(): number {
    return Math.min(this.config.tailRatio * this.contextWindow, this.config.tailMaxTokens);
  }

  /**
   * Estimated utilization after `swap`: the removed messages leave, the
   * chunks covering them join the slot. Counts the whole slot as added
   * (preamble, wrappers, hints), which overstates it, so the estimate errs
   * toward observing more.
   */
  private utilizationAfter(history: AgentMessage[], swap: SwapCut, utilization: number): number {
    if (this.contextWindow <= 0) return utilization;
    const removedTokens = removedBy(history, swap).reduce((sum, message) => sum + messageTokens(message), 0);
    let start = this.buffering.ledger.observedPrefix;
    const merging = this.buffering.ledger.completedChunks().filter((chunk) => {
      const covers = start < swap.cut;
      start = chunk.endIndex;
      return covers;
    });
    const slotTokens = merging.length > 0 ? estimateTokens(this.log.slotContent(this.log.merge(merging).observations)) : 0;
    return utilization - (removedTokens - slotTokens) / this.contextWindow;
  }

  /**
   * Observe [watermark, end) while the caller waits, so a swap can cut up to
   * the tail. The observer already in flight goes first: it is the cheapest
   * way to cover its messages, and starting another over them would observe
   * them twice. Then pieces within the observer's input cap, until `end`,
   * a failed call, the pass signal, or an abandoned pass. Returns whether
   * anything was observed here.
   */
  private async catchUp(
    history: AgentMessage[],
    end: number,
    signal: AbortSignal,
    isStale?: () => boolean,
  ): Promise<boolean> {
    if (this.buffering.isObserverInFlight()) {
      const settled = await settledUnlessAborted(this.buffering.waitForObserverSettled(), signal);
      if (!settled) return false;
    }
    let observed = false;
    while (this.buffering.getWatermark() < end) {
      if (signal.aborted || isStale?.()) return observed;
      const from = this.buffering.getWatermark();
      const to = Math.min(pieceEnd(history, from, this.observerInputCap()), end);
      if (to <= from) return observed;
      const messages = history.slice(from, to);
      const output = await this.observeInBand(messages, 'activation', signal);
      if (!output || isStale?.()) return observed;
      this.buffering.ledger.record(chunkFromOutput(output, messages), to);
      observed = true;
    }
    return observed;
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

    // Past the threshold, keep buffering at the floor interval: activation
    // can only swap in what is observed, and a non-blocking or degraded
    // pass does not observe in-band.
    const bufferInterval = tokensUntilActivation <= 0
      ? Math.min(this.config.bufferMinTokens, this.observerInputCap())
      : this.buffering.computeBufferInterval(tokensUntilActivation, {
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
      this.launchPiece(history, watermark, 'buffer');
    }
  }

  /**
   * Launch an observer over the next piece of unobserved history from
   * `watermark`: whole units, as many as fit the observer's input cap.
   */
  private launchPiece(history: AgentMessage[], watermark: number, trigger: MemoryCallTrigger): void {
    if (!this.completeFn) return;
    const end = pieceEnd(history, watermark, this.observerInputCap());
    this.buffering.launchObserver(
      this.completeFn,
      history.slice(watermark, end),
      end,
      this.log.text || null,
      this.buildObserverConfig(),
      this.logger ?? undefined,
      trigger,
    );
  }

  /**
   * Most tokens of history one observer call takes: the buffer cap, bounded
   * by 60% of the utility model's window so the input fits it.
   */
  private observerInputCap(): number {
    return this.utilityModelContextWindow > 0
      ? Math.min(this.config.bufferTokenCap, this.utilityModelContextWindow * 0.6)
      : this.config.bufferTokenCap;
  }

  // -------------------------------------------------------------------------
  // Idle digestion
  // -------------------------------------------------------------------------

  /**
   * Run pending observation buffering OUTSIDE a prompt: wait for any
   * in-flight observer to land its chunk, then observe the still-unobserved
   * tail (when it clears the buffering floor) one piece at a time, each
   * within the observer's input cap, waiting for each chunk.
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
    const unobserved = history.slice(this.buffering.getWatermark());
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

    // One piece at a time, each within the observer's input cap, until the
    // tail is observed, a call fails, or the budget runs out.
    let observerRan = false;
    while (this.buffering.getWatermark() < history.length) {
      const before = this.buffering.getWatermark();
      this.launchPiece(history, before, 'idle');
      if (!this.buffering.isObserverInFlight()) {
        // launchObserver declined (the coordinator was aborted): no
        // observer ran, so do not report one.
        return observerRan;
      }
      if (!(await this.buffering.waitForObserverSettledWithin(deadline - Date.now()))) {
        this.logger?.warn('Idle digestion timed out waiting for its observer call');
        return false;
      }
      if (this.buffering.getWatermark() <= before) return observerRan;
      observerRan = true;
    }
    return observerRan;
  }

  // -------------------------------------------------------------------------
  // Slot content
  // -------------------------------------------------------------------------

  /**
   * Build the full observation slot content: preamble, optional recall
   * instructions, the observation log, and the continuation hint.
   */
  buildSlotContent(): string {
    return this.log.slotContent();
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

    let output: ObserverOutput;
    try {
      output = await runObserver(
        this.completeFn,
        history,
        this.log.text || null,
        this.buildObserverConfig(),
        { policy: this.callPolicy() },
      );
      this.health.succeeded();
    } catch (err) {
      this.recordInBandFailure('observe', 'observe-now', err);
      throw err instanceof MemoryCallError ? err.lastError : err;
    }

    this.log.append(output.observations, hintOf(output));

    // Fire observation event
    this.fireObservationEvent({
      trigger: 'observe-now',
      observedMessages: history,
      removedMessages: [],
      tokensBefore: 0,
      tokensAfter: 0,
      observations: this.log.text,
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
      observations: this.log.text,
      continuationHint: this.log.continuationHint,
      observationTokenCount: this.log.tokenCount,
      generationCount: this.log.generationCount,
      bufferedChunks: buffering.chunks,
      bufferWatermark: buffering.watermark,
      observedPrefix: buffering.observedPrefix,
    };
  }

  /**
   * Restore state from a previous session.
   *
   * Sets observations, continuation hint, token count, and generation count,
   * then restores the buffer (completed chunks + watermark) so the observer
   * work done in the previous session is not recomputed on resume.
   *
   * The ledger's indices point into post-slot conversation history. Since
   * `restoreConversationHistory()` runs before this and splices the same
   * messages back at the same positions, they align: each restored chunk
   * covers its saved range, and the next activation removes exactly the
   * messages it merges (no duplication). Older state restores leniently
   * (see ObservationLedger.restore). No observer is launched on restore;
   * the unobserved remainder after the watermark is observed lazily on the
   * next `onTurnEnd` once it crosses the dynamic buffer interval.
   *
   * @param state - the persisted observational memory state
   * @param historyLength - length of the restored post-slot conversation
   *   history. Indices that drifted ahead of the saved history (possible
   *   only on a hard crash; graceful save keeps them in sync) are clamped
   *   to it. Omitted: no clamp.
   */
  restoreState(state: ObservationalMemoryState, historyLength?: number): void {
    this.log.restore(state);
    this.buffering.restoreState(
      {
        chunks: rehydrateChunks(state.bufferedChunks ?? []),
        ...(typeof state.bufferWatermark === 'number' ? { watermark: state.bufferWatermark } : {}),
        ...(typeof state.observedPrefix === 'number' ? { observedPrefix: state.observedPrefix } : {}),
      },
      historyLength,
    );
  }

  /**
   * Return to the empty state: no observations, no hint, nothing buffered,
   * nothing in flight. For history that was replaced with no memory to go
   * with it, which no previous log or watermark describes.
   */
  reset(): void {
    this.log.reset();
    this.buffering.reset();
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
    return this.log.slotContent();
  }

  /**
   * Returns just the observation text.
   */
  getObservations(): string {
    return this.log.text;
  }

  /**
   * Token count of activated observations only.
   */
  getObservationTokenCount(): number {
    return this.log.tokenCount;
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
  // Private: In-band calls
  // -------------------------------------------------------------------------

  /** The retry and timeout policy every observer and reflector call runs under. */
  private callPolicy(): CallPolicy {
    return {
      timeoutMs: this.config.callTimeoutMs,
      maxAttempts: this.config.maxAttempts,
      backoffMs: RETRY_BACKOFF_MS,
    };
  }

  /**
   * Observe `messages` while a caller waits. Null when the call produced
   * nothing usable; the failure is recorded, and nothing it would have
   * covered may leave the source.
   */
  private async observeInBand(
    messages: AgentMessage[],
    trigger: MemoryCallTrigger,
    signal: AbortSignal,
  ): Promise<ObserverOutput | null> {
    if (!this.completeFn) return null;
    try {
      const output = await runObserver(
        this.completeFn,
        messages,
        this.log.text || null,
        this.buildObserverConfig(),
        { policy: this.callPolicy(), signal },
      );
      this.health.succeeded();
      return output;
    } catch (err) {
      this.recordInBandFailure('observe', trigger, err);
      return null;
    }
  }

  /**
   * Record a waited-on call that produced no result. Nothing it would have
   * recorded changes: the log stays, and unobserved messages stay in the
   * source. An abort is the caller's choice, not the memory model's failure.
   */
  private recordInBandFailure(operation: 'observe' | 'reflect', trigger: MemoryCallTrigger, err: unknown): void {
    const error = err instanceof MemoryCallError ? err.lastError : err instanceof Error ? err : new Error(String(err));
    this.logger?.warn(`${operation === 'observe' ? 'Observer' : 'Reflector'} call failed (${trigger}): ${error.message}`);
    if (err instanceof MemoryCallError && err.aborted) return;
    this.health.failed({
      operation,
      trigger,
      error,
      attempts: err instanceof MemoryCallError ? err.attempts : 1,
    });
  }

  // -------------------------------------------------------------------------
  // Private: Config builders (exactOptionalPropertyTypes safe)
  // -------------------------------------------------------------------------

  /**
   * Build the observer config object without assigning undefined to optional
   * properties (exactOptionalPropertyTypes is enabled).
   */
  private buildObserverConfig(): { previousObserverTokens: number; observerInstruction?: string; maxInputTokens: number } {
    const config: { previousObserverTokens: number; observerInstruction?: string; maxInputTokens: number } = {
      previousObserverTokens: this.config.previousObserverTokens,
      maxInputTokens: this.observerInputCap(),
    };
    if (this.config.observerInstruction !== undefined) {
      config.observerInstruction = this.config.observerInstruction;
    }
    return config;
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
}

