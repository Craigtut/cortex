/**
 * One observer or reflector call under a policy: each attempt bounded by a
 * timeout, quick retries for failures worth retrying, and the caller's
 * signal ending the whole call at once.
 *
 * An attempt is the model call plus reading its reply, so an unusable reply
 * (MemoryReplyError) is retried like a provider error. Authentication,
 * billing and context-overflow errors are not: the same request fails the
 * same way. Neither is a limit with a stated reset: quick retries cannot
 * reach it.
 */

import { classifyError } from '../../error-classifier.js';
import { MemoryReplyError } from './reply.js';

export interface CallPolicy {
  /** Wall-clock bound on each attempt. Infinity disables it. */
  timeoutMs: number;
  /** Attempts in total, the first included. */
  maxAttempts: number;
  /** Wait before each retry; the last entry repeats. */
  backoffMs: readonly number[];
}

/** Quick retries: a call that keeps failing should give the request back fast. */
export const RETRY_BACKOFF_MS: readonly number[] = [1_000, 2_000];

/** One attempt, no timeout: the bare call. */
export const SINGLE_ATTEMPT: CallPolicy = { timeoutMs: Infinity, maxAttempts: 1, backoffMs: [] };

/** An attempt that ran past its policy's timeout. */
export class MemoryCallTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The memory model did not answer within ${timeoutMs} ms`);
    this.name = 'MemoryCallTimeoutError';
  }
}

/** A call that did not produce a result: every attempt failed, or the caller stopped it. */
export class MemoryCallError extends Error {
  /** The last attempt's error. */
  readonly lastError: Error;
  readonly attempts: number;
  /**
   * The caller's signal ended the call for a reason other than a deadline
   * (a user abort, a preemption). Not the memory model's failure.
   */
  readonly aborted: boolean;

  constructor(lastError: Error, attempts: number, aborted: boolean) {
    super(lastError.message);
    this.name = 'MemoryCallError';
    this.lastError = lastError;
    this.attempts = attempts;
    this.aborted = aborted;
  }
}

/**
 * Run `attempt` under `policy`. Each attempt receives a signal that fires on
 * its timeout or on the caller's signal; the attempt is abandoned at that
 * moment even if it ignores the signal.
 *
 * @throws MemoryCallError when no attempt succeeded
 */
export async function callWithPolicy<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  policy: CallPolicy,
  signal?: AbortSignal,
): Promise<T> {
  let attempts = 0;
  for (;;) {
    if (signal?.aborted) {
      throw new MemoryCallError(reasonOf(signal), attempts, !isDeadline(signal.reason));
    }
    attempts++;
    try {
      return await boundedAttempt(attempt, policy.timeoutMs, signal);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (signal?.aborted) {
        throw new MemoryCallError(reasonOf(signal), attempts, !isDeadline(signal.reason));
      }
      if (attempts >= policy.maxAttempts || !isRetryable(error)) {
        throw new MemoryCallError(error, attempts, false);
      }
      const wait = policy.backoffMs[Math.min(attempts - 1, policy.backoffMs.length - 1)] ?? 0;
      await sleep(wait, signal);
    }
  }
}

/** A signal that fires after `ms` with a MemoryCallTimeoutError, plus its cleanup. */
export function deadlineSignal(ms: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  if (!Number.isFinite(ms)) return { signal: controller.signal, clear: () => {} };
  const timer = setTimeout(() => controller.abort(new MemoryCallTimeoutError(ms)), Math.max(0, ms));
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function boundedAttempt<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<T> {
  const deadline = deadlineSignal(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([deadline.signal, callerSignal]) : deadline.signal;
  try {
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(reasonOf(signal));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      attempt(signal).then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  } finally {
    deadline.clear();
  }
}

function isRetryable(error: Error): boolean {
  if (error instanceof MemoryReplyError || error instanceof MemoryCallTimeoutError) return true;
  const classified = classifyError(error);
  if (classified.retryAfterMs !== undefined) return false;
  return !NOT_RETRIED.has(classified.category);
}

const NOT_RETRIED: ReadonlySet<string> = new Set(['authentication', 'billing', 'context_overflow', 'cancelled']);

function isDeadline(reason: unknown): boolean {
  return reason instanceof MemoryCallTimeoutError;
}

/** The error a fired signal carries, or an AbortError when it carries none. */
export function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Memory call aborted');
  error.name = 'AbortError';
  return error;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
