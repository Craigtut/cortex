/**
 * Whether the memory model is answering: healthy, or degraded since a call
 * failed after all its attempts. Any later success makes it healthy again.
 *
 * While degraded, the in-band activation pass behaves like the non-blocking
 * posture (merge what is buffered, never wait, never call), so a hung or
 * failing memory model blocks a run once per episode rather than on every
 * LLM call. Background buffering keeps calling, and its first success is
 * what recovers the engine.
 */

import type { MemoryCallTrigger, MemoryErrorInfo, MemoryRecoveredInfo } from './types.js';

export type { MemoryCallTrigger };

/** A memory call that failed after all its attempts. */
export interface MemoryCallFailure {
  operation: 'observe' | 'reflect';
  trigger: MemoryCallTrigger;
  /** The last attempt's error. */
  error: Error;
  attempts: number;
}

/** Where a memory call reports how it ended. */
export interface MemoryCallOutcomes {
  succeeded(operation: 'observe' | 'reflect'): void;
  failed(failure: MemoryCallFailure): void;
}

export class MemoryHealth implements MemoryCallOutcomes {
  private consecutiveFailures = 0;
  private degradedSince: number | null = null;
  private readonly errorHandlers: Array<(info: MemoryErrorInfo) => void> = [];
  private readonly recoveredHandlers: Array<(info: MemoryRecoveredInfo) => void> = [];

  /** @param onHandlerError - told when a consumer handler throws */
  constructor(private readonly onHandlerError: (message: string) => void = () => {}) {}

  get isDegraded(): boolean {
    return this.consecutiveFailures > 0;
  }

  onError(handler: (info: MemoryErrorInfo) => void): void {
    this.errorHandlers.push(handler);
  }

  onRecovered(handler: (info: MemoryRecoveredInfo) => void): void {
    this.recoveredHandlers.push(handler);
  }

  succeeded(): void {
    if (this.consecutiveFailures === 0) return;
    const info: MemoryRecoveredInfo = {
      failures: this.consecutiveFailures,
      degradedForMs: Date.now() - (this.degradedSince ?? Date.now()),
    };
    this.consecutiveFailures = 0;
    this.degradedSince = null;
    this.dispatch(this.recoveredHandlers, info, 'onMemoryRecovered');
  }

  failed(failure: MemoryCallFailure): void {
    this.consecutiveFailures++;
    this.degradedSince ??= Date.now();
    this.dispatch(this.errorHandlers, {
      ...failure,
      consecutiveFailures: this.consecutiveFailures,
      outcome: outcomeOf(failure),
    }, 'onMemoryError');
  }

  private dispatch<T>(handlers: Array<(info: T) => void>, info: T, name: string): void {
    for (const handler of handlers) {
      try {
        handler(info);
      } catch (err) {
        this.onHandlerError(`${name} handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** What a failed call left behind (see MemoryErrorInfo.outcome). */
function outcomeOf(failure: MemoryCallFailure): MemoryErrorInfo['outcome'] {
  if (failure.operation === 'reflect') return 'unchanged';
  switch (failure.trigger) {
    case 'buffer':
    case 'idle':
      return 'retry-later';
    case 'activation':
      return 'partial-swap';
    default:
      return 'unchanged';
  }
}
