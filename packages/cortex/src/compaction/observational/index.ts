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

import type { CompleteFn } from './types.js';
import type { AgentMessage } from '../../context-manager.js';
import type {
  ObservationalMemoryConfig,
  ObservationalMemoryState,
  ObservationChunk,
  ObservationEvent,
  ReflectionEvent,
  RecallConfig,
  MemoryErrorInfo,
  MemoryRecoveredInfo,
  MemoryGapInfo,
  CompactNowOptions,
  CompactNowResult,
  ObserveNowResult,
} from './types.js';
import { OBSERVATIONAL_MEMORY_DEFAULTS } from './constants.js';
import { Reflection } from './reflection.js';
import { BufferingCoordinator } from './buffering.js';
import { estimateTokens } from '../../token-estimator.js';
import { RETRY_BACKOFF_MS, deadlineSignal } from './calls.js';
import type { CallPolicy } from './calls.js';
import { MemoryHealth } from './health.js';
import { InBandObserver } from './in-band.js';
import { historyTokens, pieceEnd } from './units.js';
import { selectTail } from './tail.js';
import { applySwap, removedBy, removesAny, swapCut } from './swap.js';
import { OverflowDrop, truncateView } from './emergency.js';
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
  MemoryGapInfo,
  MemoryEventPayload,
  CompactNowOptions,
  CompactNowResult,
  ObserveNowResult,
  ReflectionOutcome,
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

/** Whether `now` still holds exactly the messages of `snapshot`. */
function unchanged(snapshot: AgentMessage[], now: AgentMessage[]): boolean {
  return snapshot.length === now.length && snapshot.every((message, i) => message === now[i]);
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
  private readonly inBand: InBandObserver;
  private readonly overflow: OverflowDrop;
  private contextWindow: number = 0;
  private utilityModelContextWindow: number = 0;
  private logger: { warn: (msg: string) => void; info: (msg: string) => void } | null = null;
  private readonly health = new MemoryHealth((message) => this.logger?.warn(message));

  // Event handler arrays (method-level registration, multiple handlers)
  private observationHandlers: Array<(event: ObservationEvent) => void> = [];

  constructor(config: Partial<ObservationalMemoryConfig>) {
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
    this.inBand = new InBandObserver({
      buffering: this.buffering,
      health: this.health,
      completeFn: () => this.completeFn,
      logText: () => this.log.text,
      observerConfig: () => this.buildObserverConfig(),
      policy: () => this.callPolicy(),
      logger: () => this.logger,
    });
    this.overflow = new OverflowDrop({
      ledger: this.buffering.ledger,
      log: this.log,
      lastError: () => this.health.lastError,
      invalidateObserver: () => this.buffering.invalidateObserver(),
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

  /** Register a handler for messages dropped before memory recorded them. */
  onMemoryGap(handler: (info: MemoryGapInfo) => void): void {
    this.overflow.onGap(handler);
  }

  // -------------------------------------------------------------------------
  // Core: applyInTransformContext
  // -------------------------------------------------------------------------

  /**
   * Activation, called from CompactionManager during transformContext: at
   * or past the activation threshold, swap observed messages out of the
   * source for their observations, then reflect if the log is due.
   *
   * The engine never builds the request's view. It reports whether the
   * source was rewritten, and the caller re-derives the view from the
   * source when it was (its own injections included) and otherwise sends
   * the view it had. The observation slot follows the log (getSlotContent).
   *
   * @param utilization - Current total context utilization (0-1)
   * @param getSourceHistory - Get the transcript history (post-slot)
   * @param setSourceHistory - Replace the transcript history; false when the
   *   owner discarded the rewrite
   * @param options - allowSync (default true): whether memory calls may run
   *   while the request waits. When false (the non-blocking posture), a swap
   *   merges only what is already buffered and reflection never runs inline.
   *   isStale reports whether the pass has been abandoned (a timed-out
   *   idle digestion); a stale pass's observation and reflection events
   *   are suppressed, since its rewrite is discarded by the owner and
   *   reporting it would tell a consumer about work that never landed.
   *   signal is the run's abort: aborting ends the pass's memory calls at
   *   once and the pass applies nothing.
   * @returns whether a rewrite of the source landed
   */
  async applyInTransformContext(
    utilization: number,
    getSourceHistory: () => AgentMessage[],
    setSourceHistory: (history: AgentMessage[]) => boolean | void,
    options?: { allowSync?: boolean; isStale?: () => boolean; signal?: AbortSignal },
  ): Promise<boolean> {
    if (utilization < this.config.activationThreshold) {
      return false;
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
        utilization, getSourceHistory, setSourceHistory,
        { allowSync, passSignal, ...(isStale ? { isStale } : {}), ...(runSignal ? { runSignal } : {}) },
      );
    } finally {
      deadline.clear();
    }
  }

  private async activate(
    utilization: number,
    getSourceHistory: () => AgentMessage[],
    setSourceHistory: (history: AgentMessage[]) => boolean | void,
    pass: { allowSync: boolean; passSignal: AbortSignal; isStale?: () => boolean; runSignal?: AbortSignal },
  ): Promise<boolean> {
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
      sync = (await this.inBand.catchUp(sourceHistory, tail.start, 'activation', passSignal, isStale)).observed;
    }

    // An abandoned or aborted pass applies nothing: its rewrite would be
    // discarded by the owner (or its request never sent); what it observed
    // stays buffered.
    if (isStale?.() || runSignal?.aborted) return false;

    // Step 2: Swap, synchronously: cut, merge, rewrite.
    const swap = swapCut(sourceHistory, tail, this.buffering.getWatermark());
    let rewritten = false;
    if (removesAny(swap)) {
      const before = this.log.tokenCount;
      const applied = applySwap(sourceHistory, swap, this.buffering.ledger, this.log);
      rewritten = setSourceHistory(applied.kept) !== false;

      // Step 3: Report it (the pass is known live: stale returned above).
      const tokensBefore = Math.round(utilization * this.contextWindow);
      const removedTokens = historyTokens(applied.removed);
      this.fireObservationEvent({
        trigger: 'activation',
        observedMessages: applied.observed,
        removedMessages: applied.removed,
        observations: this.log.text,
        contextUtilization: utilization,
        tokensBefore,
        tokensAfter: Math.max(0, tokensBefore - removedTokens + (this.log.tokenCount - before)),
        sync,
        timestamp: new Date(),
      });
    }

    // Step 4: Handle reflection (may condense the log)
    await this.reflection.reflectIfDue({ allowSync, ...(isStale ? { isStale } : {}), signal: passSignal, trigger: 'activation' });

    return rewritten;
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
    const removedTokens = historyTokens(removedBy(history, swap));
    let start = this.buffering.ledger.observedPrefix;
    const merging = this.buffering.ledger.completedChunks().filter((chunk) => {
      const covers = start < swap.cut;
      start = chunk.endIndex;
      return covers;
    });
    const slotTokens = merging.length > 0 ? estimateTokens(this.log.slotContent(this.log.merge(merging).observations)) : 0;
    return utilization - (removedTokens - slotTokens) / this.contextWindow;
  }

  // -------------------------------------------------------------------------
  // Emergency: the provider rejected a request as too long
  // -------------------------------------------------------------------------

  /**
   * Shrink the source after the provider rejected a request for overflow,
   * so the history fits `budgetTokens` (see emergency.ts OverflowDrop).
   * Observed messages that left are reported as an observation, sized from
   * `tokensBefore` less everything that left (dropped messages too) plus
   * what the log grew by.
   *
   * @param tokensBefore - the rejected context's estimated size
   * @returns the new source history, or null when nothing could be dropped
   */
  dropForOverflow(source: AgentMessage[], budgetTokens: number, tokensBefore: number): AgentMessage[] | null {
    const slotBefore = this.slotTokens();
    const rewrite = this.overflow.drop(source, budgetTokens);
    if (!rewrite) return null;
    const { swapped, dropped } = rewrite;
    if (swapped.removed.length > 0) {
      const leftTokens = historyTokens(swapped.removed) + historyTokens(dropped);
      this.fireObservationEvent({
        trigger: 'emergency',
        observedMessages: swapped.observed,
        removedMessages: swapped.removed,
        observations: this.log.text,
        contextUtilization: this.contextWindow > 0 ? tokensBefore / this.contextWindow : 0,
        tokensBefore,
        tokensAfter: Math.max(0, tokensBefore - leftTokens + this.slotTokens() - slotBefore),
        sync: false,
        timestamp: new Date(),
      });
    }
    return rewrite.kept;
  }

  /**
   * The request's history cut to fit `budgetTokens` in the view only (see
   * emergency.ts truncateView). The source keeps every message.
   *
   * @param injections - the view's request-only messages, which stay
   */
  truncateView(view: AgentMessage[], injections: ReadonlySet<AgentMessage>, budgetTokens: number): AgentMessage[] | null {
    return truncateView(view, injections, budgetTokens);
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
   * Every wait is bounded by `timeoutMs` (one wall-clock budget for the
   * whole call) and by `signal` (the owner preempting the digestion):
   * callers hold the loop gate while digesting, so a hung utility request
   * must time the digestion out rather than wedge the gate, and input
   * arriving must stop it. A stopped digestion launches nothing more; an
   * observer already in flight lands its chunk whenever it settles.
   *
   * History is read afresh for every piece: a run between pieces may have
   * swapped observed messages out and rebased the ledger, and a piece cut
   * from an older snapshot would mark messages observed that no observer
   * saw.
   *
   * @param getHistory - The live post-slot history
   * @param options.timeoutMs - Wall-clock budget for the whole call (default 60s)
   * @param options.signal - Preempts the digestion
   * @returns true when an observer call ran to completion in this digestion
   */
  async digestPendingBuffers(
    getHistory: () => AgentMessage[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    if (!this.completeFn) return false;
    const deadline = deadlineSignal(options.timeoutMs ?? DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS);
    const stop = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;
    const timedOut = (what: string): false => {
      if (deadline.signal.aborted) this.logger?.warn(`Idle digestion timed out waiting for ${what}`);
      return false;
    };
    try {
      // Let an already-running observer finish and record its chunk, so the
      // tail read below starts at the settled watermark. When the wait is
      // given up, launch nothing behind a hung observer.
      if (!(await this.buffering.observerSettledUnless(stop))) return timedOut('the in-flight observer');

      const unobservedTokens = getHistory().slice(this.buffering.getWatermark()).reduce((sum, msg) => {
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
        return sum + estimateTokens(content);
      }, 0);
      // Same floor onTurnEnd's buffering uses: observing a trivial tail
      // thrashes the utility model for nothing.
      if (unobservedTokens === 0 || unobservedTokens < this.config.bufferMinTokens) return false;

      // One piece at a time, each within the observer's input cap, until the
      // tail is observed, a call fails, or the digestion is stopped.
      let observerRan = false;
      for (;;) {
        if (stop.aborted) return observerRan;
        const history = getHistory();
        const before = this.buffering.getWatermark();
        if (before >= history.length) return observerRan;
        this.launchPiece(history, before, 'idle');
        if (!this.buffering.isObserverInFlight()) {
          // launchObserver declined (the coordinator was aborted): no
          // observer ran, so do not report one.
          return observerRan;
        }
        if (!(await this.buffering.observerSettledUnless(stop))) return timedOut('its observer call');
        if (this.buffering.getWatermark() <= before) return observerRan;
        observerRan = true;
      }
    } finally {
      deadline.clear();
    }
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
  // Explicit compaction and observation
  // -------------------------------------------------------------------------

  /**
   * Swap observations in now, whatever the utilization: observe up to the
   * verbatim tail, swap, then reflect if the log is due. The caller holds
   * the loop's gate, so no turn runs meanwhile.
   *
   * When an observer call fails or the signal stops it, history and the
   * log are unchanged; pieces observed before the failure stay buffered.
   * With `observe` false nothing waits on the memory model: only what is
   * already observed swaps in, and a due reflection runs in the background.
   *
   * @param tokensBefore - the context's estimated size now
   */
  async compactNow(
    getSource: () => AgentMessage[],
    setSource: (history: AgentMessage[]) => void,
    options: CompactNowOptions & { tokensBefore: number },
  ): Promise<CompactNowResult> {
    const observe = options.observe ?? true;
    const signal = options.signal ?? new AbortController().signal;
    const history = getSource();
    const tail = selectTail(history, this.tailBudget());
    if (observe) {
      const { error } = await this.inBand.catchUp(history, tail.start, 'compact-now', signal);
      if (error) return { status: 'failed', error };
      if (!unchanged(history, getSource())) return { status: 'failed', error: new Error('History changed while compacting') };
    }
    const swap = swapCut(history, tail, this.buffering.getWatermark());
    if (!removesAny(swap)) return { status: 'nothing-to-compact' };

    const { tokensBefore } = options;
    const slotBefore = this.slotTokens();
    const applied = applySwap(history, swap, this.buffering.ledger, this.log);
    setSource(applied.kept);
    const removedTokens = historyTokens(applied.removed);
    const tokensNow = (): number => Math.max(0, tokensBefore - removedTokens + this.slotTokens() - slotBefore);
    this.fireObservationEvent({
      trigger: 'compact-now',
      observedMessages: applied.observed,
      removedMessages: applied.removed,
      observations: this.log.text,
      contextUtilization: this.contextWindow > 0 ? tokensBefore / this.contextWindow : 0,
      tokensBefore,
      tokensAfter: tokensNow(),
      sync: observe,
      timestamp: new Date(),
    });

    // A failed reflection keeps the current log; the swap stands.
    const reflection = await this.reflection.reflectIfDue({ allowSync: observe, signal, trigger: 'compact-now' });
    return { status: 'compacted', removedMessages: applied.removed.length, tokensBefore, tokensAfter: tokensNow(), reflection };
  }

  /**
   * Record everything not yet in the log, now, removing nothing: observe
   * from the watermark to the end, then move every buffered chunk into the
   * log. The messages stay in history as observed, so nothing is observed
   * twice. For a correction the log should carry at once. A failed or
   * stopped observer call leaves the log unchanged, as in compactNow.
   *
   * @param tokensBefore - the context's estimated size now
   */
  async observeNow(
    getSource: () => AgentMessage[],
    options: { tokensBefore: number; signal?: AbortSignal },
  ): Promise<ObserveNowResult> {
    const signal = options.signal ?? new AbortController().signal;
    const history = getSource();
    const { error } = await this.inBand.catchUp(history, history.length, 'observe-now', signal);
    if (error) return { status: 'failed', error };
    if (!unchanged(history, getSource())) return { status: 'failed', error: new Error('History changed while observing') };

    const ledger = this.buffering.ledger;
    const priorPrefix = ledger.observedPrefix;
    const absorbed = ledger.absorb();
    if (absorbed.length === 0) return { status: 'nothing-to-observe' };
    const slotBefore = this.slotTokens();
    const merged = this.log.merge(absorbed);
    this.log.append(merged.observations, merged.hint);
    const observed = history.slice(priorPrefix, ledger.observedPrefix);
    const { tokensBefore } = options;
    this.fireObservationEvent({
      trigger: 'observe-now',
      observedMessages: observed,
      removedMessages: [],
      observations: this.log.text,
      contextUtilization: this.contextWindow > 0 ? tokensBefore / this.contextWindow : 0,
      tokensBefore,
      tokensAfter: tokensBefore + this.slotTokens() - slotBefore,
      sync: true,
      timestamp: new Date(),
    });
    return { status: 'observed', observedMessages: observed.length };
  }

  /** Estimated tokens of the observation slot; empty while the log is. */
  private slotTokens(): number {
    return this.log.text ? estimateTokens(this.log.slotContent()) : 0;
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
   * Reconcile buffer state after the tail of the post-slot source history
   * was trimmed (aborted/failed run stubs).
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
   * Reconcile buffer state after messages left the post-slot source history
   * from anywhere in it (a failed delivery being unwound): every index
   * shifts with the messages it points at, and an observer over removed
   * content lands nothing.
   *
   * @param postSlotIndices - removed post-slot indices, ascending, as the
   *   history was before the removal
   */
  onSourceHistoryRemoved(postSlotIndices: readonly number[]): void {
    this.buffering.onSourceRemoved(postSlotIndices);
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
  // Private: Call policy
  // -------------------------------------------------------------------------

  /** The retry and timeout policy every observer and reflector call runs under. */
  private callPolicy(): CallPolicy {
    return {
      timeoutMs: this.config.callTimeoutMs,
      maxAttempts: this.config.maxAttempts,
      backoffMs: RETRY_BACKOFF_MS,
    };
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

