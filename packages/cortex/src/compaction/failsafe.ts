/**
 * Layer 3 (failsafe) settings and context-overflow detection.
 *
 * Under observational memory, Layer 3 cuts a request's view when it would
 * still not fit after a swap (observational/emergency.ts truncateView);
 * after the provider rejects a request as too long (the error classifier's
 * `context_overflow`), the source shrinks (CompactionManager.handleOverflowError).
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
 * Whether an error is the provider rejecting a request as too long: pi-ai's
 * detection, after Cortex's rate-limit patterns, so a throttle worded like
 * an overflow (Bedrock's "Too many tokens, please wait") never runs the
 * lossy overflow drop. Owned by the error classifier.
 */
export { isContextOverflow } from '../error-classifier.js';
