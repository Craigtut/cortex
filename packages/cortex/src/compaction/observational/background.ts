/**
 * Observation nobody waits on. At each turn end, an observer is launched
 * over the next piece of unobserved history once enough has accumulated;
 * when the loop is idle, what is pending is observed one piece at a time.
 * Either way the chunks stay buffered until an activation swaps them in.
 */

import type { AgentMessage } from '../../context-manager.js';
import { estimateTokens } from '../../token-estimator.js';
import type { BufferingCoordinator } from './buffering.js';
import { deadlineSignal } from './calls.js';
import type { MemoryCallTrigger } from './health.js';
import type { CompleteFn } from './types.js';
import { pieceEnd } from './units.js';

/**
 * Default wall-clock budget for idle digestion's observer waits. Idle
 * digestion holds the caller's loop gate, so waiting on a hung utility
 * request must be bounded; a healthy observer call settles well inside
 * this. Overridable per call (digestIdle's observerTimeoutMs).
 */
export const DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS = 60_000;

export interface BackgroundObservationPorts {
  buffering: BufferingCoordinator;
  completeFn(): CompleteFn | null;
  /** The observation log's text, for the observer's context. */
  logText(): string;
  observerConfig(): { previousObserverTokens: number; observerInstruction?: string; maxInputTokens: number };
  /** Most tokens of history one observer call takes. */
  inputCap(): number;
  config(): { activationThreshold: number; bufferMinTokens: number; bufferTargetCycles: number; bufferTokenCap: number };
  utilityModelContextWindow(): number;
  logger(): { warn: (msg: string) => void } | null;
}

export class BackgroundObservation {
  constructor(private readonly ports: BackgroundObservationPorts) {}

  /**
   * At a turn end, launch an observer over the next piece of unobserved
   * history once enough has accumulated.
   *
   * Computes the dynamic buffer interval and launches an async observer
   * if enough unobserved tokens have accumulated.
   *
   * @param totalTokens - Total tokens from the last LLM response
   * @param contextWindow - Current context window size
   * @param history - The post-slot history
   */
  onTurnEnd(totalTokens: number, contextWindow: number, history: AgentMessage[]): void {
    if (!this.ports.completeFn() || contextWindow <= 0) return;
    const config = this.ports.config();
    const buffering = this.ports.buffering;

    const currentUtilization = totalTokens / contextWindow;
    const tokensUntilActivation = (config.activationThreshold - currentUtilization) * contextWindow;

    // Past the threshold, keep buffering at the floor interval: activation
    // can only swap in what is observed, and a non-blocking or degraded
    // pass does not observe in-band.
    const bufferInterval = tokensUntilActivation <= 0
      ? Math.min(config.bufferMinTokens, this.ports.inputCap())
      : buffering.computeBufferInterval(tokensUntilActivation, {
        bufferTargetCycles: config.bufferTargetCycles,
        bufferTokenCap: config.bufferTokenCap,
        bufferMinTokens: config.bufferMinTokens,
        utilityModelContextWindow: this.ports.utilityModelContextWindow(),
      });

    // Compute unobserved tokens (messages after buffer watermark)
    const watermark = buffering.getWatermark();
    const unobservedMessages = history.slice(watermark);
    const unobservedTokens = unobservedMessages.reduce((sum, msg) => {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      return sum + estimateTokens(content);
    }, 0);

    if (buffering.shouldBuffer(unobservedTokens, bufferInterval)) {
      this.launchPiece(history, watermark, 'buffer');
    }
  }

  /**
   * Launch an observer over the next piece of unobserved history from
   * `watermark`: whole units, as many as fit the observer's input cap.
   */
  private launchPiece(history: AgentMessage[], watermark: number, trigger: MemoryCallTrigger): void {
    const complete = this.ports.completeFn();
    if (!complete) return;
    const end = pieceEnd(history, watermark, this.ports.inputCap());
    this.ports.buffering.launchObserver(
      complete,
      history.slice(watermark, end),
      end,
      this.ports.logText() || null,
      this.ports.observerConfig(),
      this.ports.logger() ?? undefined,
      trigger,
    );
  }

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
  async digest(
    getHistory: () => AgentMessage[],
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    if (!this.ports.completeFn()) return false;
    const buffering = this.ports.buffering;
    const deadline = deadlineSignal(options.timeoutMs ?? DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS);
    const stop = options.signal ? AbortSignal.any([deadline.signal, options.signal]) : deadline.signal;
    const timedOut = (what: string): false => {
      if (deadline.signal.aborted) this.ports.logger()?.warn(`Idle digestion timed out waiting for ${what}`);
      return false;
    };
    try {
      // Let an already-running observer finish and record its chunk, so the
      // tail read below starts at the settled watermark. When the wait is
      // given up, launch nothing behind a hung observer.
      if (!(await buffering.observerSettledUnless(stop))) return timedOut('the in-flight observer');

      const unobservedTokens = getHistory().slice(buffering.getWatermark()).reduce((sum, msg) => {
        const content = typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
        return sum + estimateTokens(content);
      }, 0);
      // Same floor onTurnEnd's buffering uses: observing a trivial tail
      // thrashes the utility model for nothing.
      if (unobservedTokens === 0 || unobservedTokens < this.ports.config().bufferMinTokens) return false;

      // One piece at a time, each within the observer's input cap, until the
      // tail is observed, a call fails, or the digestion is stopped.
      let observerRan = false;
      for (;;) {
        if (stop.aborted) return observerRan;
        const history = getHistory();
        const before = buffering.getWatermark();
        if (before >= history.length) return observerRan;
        this.launchPiece(history, before, 'idle');
        if (!buffering.isObserverInFlight()) {
          // launchObserver declined (the coordinator was aborted): no
          // observer ran, so do not report one.
          return observerRan;
        }
        if (!(await buffering.observerSettledUnless(stop))) return timedOut('its observer call');
        if (buffering.getWatermark() <= before) return observerRan;
        observerRan = true;
      }
    } finally {
      deadline.clear();
    }
  }
}
