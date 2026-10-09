/**
 * Observation while a caller waits: the activation pass catching up to the
 * verbatim tail, and explicit observation a consumer asked for.
 *
 * The observer already running in the background goes first: it is the
 * cheapest way to cover its messages, and starting another over them would
 * observe them twice. Then the rest, one piece at a time, each piece whole
 * units within the observer's input cap and recorded in the ledger as it
 * lands. A failed piece ends the catch-up; the pieces before it stay
 * recorded, so nothing is observed twice. Failures go to the memory
 * health, except an abort, which is the caller's choice.
 */

import type { CompleteFn } from './types.js';
import type { AgentMessage } from '../../context-manager.js';
import { chunkFromOutput } from './buffering.js';
import type { BufferingCoordinator } from './buffering.js';
import { MemoryCallError, reasonOf } from './calls.js';
import type { CallPolicy } from './calls.js';
import type { MemoryCallTrigger, MemoryHealth } from './health.js';
import { runObserver } from './observer.js';
import { pieceEnd } from './units.js';
import type { ObserverOutput } from './types.js';

export interface InBandPorts {
  buffering: BufferingCoordinator;
  health: MemoryHealth;
  completeFn(): CompleteFn | null;
  /** The log the observer continues from. */
  logText(): string;
  /** The observer's config; `maxInputTokens` also bounds each piece. */
  observerConfig(): { previousObserverTokens: number; observerInstruction?: string; maxInputTokens: number };
  policy(): CallPolicy;
  logger(): { warn: (msg: string) => void } | null;
}

/** How a catch-up ended. */
export interface CatchUpResult {
  /** Whether any piece was observed here. */
  observed: boolean;
  /** Why it stopped short of its end; null when it got there. */
  error: Error | null;
}

export class InBandObserver {
  constructor(private readonly ports: InBandPorts) {}

  /**
   * Observe [watermark, end) of `history` while the caller waits. Stops at
   * `end`, a failed call, `signal`, or an abandoned pass (`isStale`); what
   * a stale pass observed after it was abandoned is not recorded.
   */
  async catchUp(
    history: AgentMessage[],
    end: number,
    trigger: MemoryCallTrigger,
    signal: AbortSignal,
    isStale?: () => boolean,
  ): Promise<CatchUpResult> {
    const { buffering } = this.ports;
    let observed = false;
    const stop = (error: Error): CatchUpResult => ({ observed, error });
    if (buffering.isObserverInFlight() && !(await settledUnlessAborted(buffering.waitForObserverSettled(), signal))) {
      return stop(reasonOf(signal));
    }
    while (buffering.getWatermark() < end) {
      if (signal.aborted) return stop(reasonOf(signal));
      if (isStale?.()) return stop(new Error('The pass was abandoned'));
      const from = buffering.getWatermark();
      const to = Math.min(pieceEnd(history, from, this.ports.observerConfig().maxInputTokens), end);
      if (to <= from) return stop(new Error('The history ends before the range to observe'));
      const messages = history.slice(from, to);
      const output = await this.observe(messages, trigger, signal);
      if (output instanceof Error) return stop(output);
      if (isStale?.()) return stop(new Error('The pass was abandoned'));
      buffering.ledger.record(chunkFromOutput(output, messages), to);
      observed = true;
    }
    return { observed, error: null };
  }

  /**
   * One observer call over `messages`, under the full policy. The error
   * when it produced nothing usable; the failure is recorded.
   */
  async observe(
    messages: AgentMessage[],
    trigger: MemoryCallTrigger,
    signal?: AbortSignal,
  ): Promise<ObserverOutput | Error> {
    const completeFn = this.ports.completeFn();
    if (!completeFn) return new Error('No memory model is configured');
    try {
      const output = await runObserver(
        completeFn,
        messages,
        this.ports.logText() || null,
        this.ports.observerConfig(),
        { policy: this.ports.policy(), ...(signal ? { signal } : {}) },
      );
      this.ports.health.succeeded();
      return output;
    } catch (err) {
      return this.recordFailure(trigger, err);
    }
  }

  /**
   * Record a waited-on call that produced no result. Nothing it would have
   * recorded changes: the log stays, and unobserved messages stay in the
   * source. An abort is the caller's choice, not the memory model's failure.
   */
  private recordFailure(trigger: MemoryCallTrigger, err: unknown): Error {
    const error = err instanceof MemoryCallError ? err.lastError : err instanceof Error ? err : new Error(String(err));
    this.ports.logger()?.warn(`Observer call failed (${trigger}): ${error.message}`);
    if (err instanceof MemoryCallError && err.aborted) return error;
    this.ports.health.failed({
      operation: 'observe',
      trigger,
      error,
      attempts: err instanceof MemoryCallError ? err.attempts : 1,
    });
    return error;
  }
}

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
