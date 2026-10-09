/**
 * Pure helpers for cortex's background retry loop.
 *
 * The loop itself lives in TurnRunner.runWithRetry (agent-loop/turn-runner.ts),
 * which drives agent.prompt / agent.continue. Everything decidable without touching agent state lives
 * here so it can be unit-tested in isolation: default policy, policy merge,
 * the backoff schedule, and the retry gate.
 *
 * Reference: error-recovery.md
 */

import type { ClassifiedError, ErrorCategory, RetryPolicy } from './types.js';

/**
 * Built-in defaults: retry transient categories with a 2m -> 4m -> 8m backoff
 * capped at 10m, up to 20 times (~3h window) before giving up. A reset the
 * provider states is waited for when it is up to 6h away.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  retryableCategories: ['network', 'server_error', 'rate_limit'],
  backoffMs: [120_000, 240_000, 480_000],
  maxBackoffMs: 600_000,
  maxAttempts: 20,
  maxRetryAfterMs: 6 * 60 * 60 * 1000,
};

/**
 * Merge a partial policy over the defaults. Undefined fields fall back to the
 * default; `retryableCategories` and `backoffMs` are replaced wholesale (not
 * concatenated) when provided.
 */
export function resolveRetryPolicy(partial?: Partial<RetryPolicy>): RetryPolicy {
  const merged: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...(partial ?? {}),
  };
  // Guard against nonsensical overrides that would make the loop misbehave.
  if (!Array.isArray(merged.retryableCategories)) {
    merged.retryableCategories = DEFAULT_RETRY_POLICY.retryableCategories;
  }
  if (!Array.isArray(merged.backoffMs) || merged.backoffMs.length === 0) {
    merged.backoffMs = DEFAULT_RETRY_POLICY.backoffMs;
  }
  if (!Number.isFinite(merged.maxBackoffMs) || merged.maxBackoffMs <= 0) {
    merged.maxBackoffMs = DEFAULT_RETRY_POLICY.maxBackoffMs;
  }
  if (!Number.isInteger(merged.maxAttempts) || merged.maxAttempts < 0) {
    merged.maxAttempts = DEFAULT_RETRY_POLICY.maxAttempts;
  }
  if (!Number.isFinite(merged.maxRetryAfterMs) || merged.maxRetryAfterMs < 0) {
    merged.maxRetryAfterMs = DEFAULT_RETRY_POLICY.maxRetryAfterMs;
  }
  return merged;
}

/**
 * Backoff delay (ms) before the retry at `retryIndex` (0-based: 0 is the first
 * retry). Indices within the schedule use it directly; indices past the end
 * fall back to `maxBackoffMs`. Every value is clamped to `maxBackoffMs` so a
 * long schedule entry can never exceed the cap.
 */
export function backoffForAttempt(policy: RetryPolicy, retryIndex: number): number {
  const scheduled = policy.backoffMs[retryIndex] ?? policy.maxBackoffMs;
  return Math.min(policy.maxBackoffMs, Math.max(0, scheduled));
}

/**
 * The wait before the retry at `retryIndex` after `error`: the backoff, or
 * the reset the provider stated (`retryAfterMs`) when that is later. A wait
 * for a stated reset counts as one attempt like any other.
 */
export function retryDelayForAttempt(policy: RetryPolicy, retryIndex: number, error: ClassifiedError): number {
  return Math.max(backoffForAttempt(policy, retryIndex), error.retryAfterMs ?? 0);
}

/**
 * Whether a reset the provider stated is close enough to wait for: within
 * `maxRetryAfterMs`, and before the elapsed ceiling. A retry sooner would be
 * refused the same way, so a reset out of reach ends the retries.
 */
function statedResetWithinReach(error: ClassifiedError, elapsedMs: number, policy: RetryPolicy): boolean {
  if (error.retryAfterMs === undefined) return true;
  if (error.retryAfterMs > policy.maxRetryAfterMs) return false;
  return policy.maxElapsedMs === undefined || elapsedMs + error.retryAfterMs <= policy.maxElapsedMs;
}

/**
 * `policy` with its elapsed ceiling lowered to at most `remainingMs`, so an
 * in-run retry ladder cannot outlast an outer budget it runs inside.
 */
export function withElapsedCeiling(policy: RetryPolicy, remainingMs: number): RetryPolicy {
  return {
    ...policy,
    maxElapsedMs: Math.min(policy.maxElapsedMs ?? Number.POSITIVE_INFINITY, remainingMs),
  };
}

/** Context for a retry decision, captured at the moment of failure. */
export interface RetryDecisionContext {
  /** Retries already scheduled so far (0-based index of the NEXT retry). */
  retryIndex: number;
  /** Elapsed ms since the first failure of this turn. */
  elapsedMs: number;
  /** Whether the turn was aborted (user/system cancellation). */
  aborted: boolean;
}

/**
 * Decide whether a failed turn should be retried in the background.
 *
 * Retries only transient categories, never when aborted, fatal, out of
 * attempts, or past the elapsed ceiling, nor when the provider stated a
 * reset too far away to wait for. A 404 (classified `unknown`), auth and
 * billing failures are deliberately excluded so they surface to the user.
 */
export function shouldRetry(
  error: ClassifiedError,
  ctx: RetryDecisionContext,
  policy: RetryPolicy,
): boolean {
  if (!policy.enabled) return false;
  if (ctx.aborted) return false;
  if (error.severity === 'fatal') return false;
  if (!isRetryableCategory(error.category, policy)) return false;
  if (ctx.retryIndex >= policy.maxAttempts) return false;
  if (policy.maxElapsedMs !== undefined && ctx.elapsedMs >= policy.maxElapsedMs) {
    return false;
  }
  return statedResetWithinReach(error, ctx.elapsedMs, policy);
}

/** Whether a category is in the policy's retryable set. */
export function isRetryableCategory(
  category: ErrorCategory,
  policy: RetryPolicy,
): boolean {
  return policy.retryableCategories.includes(category);
}
