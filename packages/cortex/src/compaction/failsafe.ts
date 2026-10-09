/**
 * Layer 3 (failsafe) settings and context-overflow detection.
 *
 * Under observational memory, Layer 3 cuts a request's view when it would
 * still not fit after a swap (observational/emergency.ts truncateView);
 * after the provider rejects a request as too long, isContextOverflow
 * recognizes it and the source shrinks (CompactionManager.handleOverflowError).
 *
 * References:
 *   - compaction-strategy.md (Layer 3)
 */

import type { FailsafeConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const FAILSAFE_DEFAULTS: FailsafeConfig = {
  threshold: 0.95,
};

/**
 * Throttling and rate-limit errors that can share wording with an overflow.
 * Bedrock reports a tokens-per-minute throttle as "Too many tokens, please
 * wait before trying again." (prefixed "Throttling error:" by pi-ai, or the
 * raw "ThrottlingException"). Mirrors pi-ai's own overflow exclusions.
 */
const NON_OVERFLOW_PATTERNS: RegExp[] = [
  /throttl/i,
  /rate limit/i,
  /too many requests/i,
];

/**
 * Check if an error represents a context overflow.
 * Matches common API error patterns from various providers, excluding
 * throttling and rate-limit errors that use the same wording.
 */
export function isContextOverflow(error: Error): boolean {
  if (NON_OVERFLOW_PATTERNS.some((p) => p.test(error.message))) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('context_length_exceeded') ||
    msg.includes('context window') ||
    msg.includes('maximum context length') ||
    msg.includes('token limit') ||
    msg.includes('too many tokens') ||
    msg.includes('request too large') ||
    msg.includes('prompt is too long') ||
    msg.includes('input too long')
  );
}
