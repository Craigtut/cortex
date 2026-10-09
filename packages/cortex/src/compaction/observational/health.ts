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

/** What started a memory call. */
export type MemoryCallTrigger = 'buffer' | 'activation' | 'idle' | 'compact-now' | 'observe-now';

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

  get isDegraded(): boolean {
    return this.consecutiveFailures > 0;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  succeeded(): void {
    this.consecutiveFailures = 0;
  }

  failed(_failure: MemoryCallFailure): void {
    this.consecutiveFailures++;
  }
}
