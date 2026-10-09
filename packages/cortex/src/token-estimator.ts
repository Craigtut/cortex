/**
 * Token estimates, on pi-ai's heuristic (characters / 3.5) so Cortex and pi
 * agree on what a text costs. Not a tokenizer: a fast estimate for budget
 * decisions and compaction triggers. Measured usage, where a call reports
 * it, is authoritative.
 */

import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';

/**
 * pi-ai's characters per token (`CHARS_PER_TOKEN` in its utils/estimate,
 * not exported). Only {@link charsForTokens} uses it; a test pins that
 * inverse to pi's estimate, so a change to pi's ratio fails there.
 */
const CHARS_PER_TOKEN = 3.5;

/**
 * Estimate the number of tokens in a text string.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count (0 for empty text, otherwise rounded up)
 */
export function estimateTokens(text: string): number {
  return text ? estimateTextTokens(text) : 0;
}

/**
 * The most characters whose estimate stays within `tokens`: the inverse of
 * {@link estimateTokens}, for cutting text to a token budget.
 */
export function charsForTokens(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}
