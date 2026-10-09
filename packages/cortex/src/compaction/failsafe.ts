/**
 * Layer 3: Emergency Truncation (Failsafe).
 *
 * Last-resort truncation when Layer 2 fails or context is still too large.
 * Drops the oldest conversation turns purely mechanically (no LLM call).
 * Preserves structural integrity: an assistant tool call message and its
 * consecutive toolResult messages form an atomic group that is dropped
 * together or not at all.
 *
 * Triggers at 90% of context window (configurable), or reactively when
 * the API returns a context overflow error.
 *
 * This layer also serves as a mid-loop safety valve: it fires inside
 * transformContext during the agentic loop when estimated token count
 * exceeds 90%. Mid-loop truncation does NOT emit onBeforeCompaction
 * (no observational memory processing mid-loop).
 *
 * References:
 *   - compaction-strategy.md (Layer 3: Emergency Truncation)
 *   - phase-5-compaction.md (5.4)
 */

import type { AgentMessage } from '../context-manager.js';
import type { FailsafeConfig } from '../types.js';
import { estimateTokens } from '../token-estimator.js';
import { extractTextContent } from './microcompaction.js';
import { findToolCallGroups } from './tool-call-groups.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const FAILSAFE_DEFAULTS: FailsafeConfig = {
  threshold: 0.95,
};

/**
 * Minimum number of recent turns to preserve during emergency truncation.
 * Fewer turns preserved than Layer 2 since this is a last resort.
 */
const FAILSAFE_PRESERVE_TURNS = 3;

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Result of an emergency truncation operation.
 */
export interface FailsafeTruncationResult {
  /** The truncated conversation history. */
  newHistory: AgentMessage[];
  /** Number of turns removed. */
  turnsRemoved: number;
  /** Estimated tokens after truncation. */
  tokensAfter: number;
}

/**
 * Perform emergency truncation on conversation history.
 *
 * Drops the oldest turns until the estimated token count drops below the
 * threshold, or until only the preserved tail remains. Tool call groups
 * (an assistant message with 'toolCall' blocks plus its consecutive
 * toolResult messages) are dropped atomically: either the whole group is
 * removed or the whole group is kept, so truncation can never orphan a
 * tool call or a tool result.
 *
 * @param history - Conversation history (post-slot region)
 * @param contextWindow - Total context window size in tokens
 * @param slotTokens - Estimated tokens used by slots
 * @param threshold - Usage ratio threshold (default 0.90)
 * @returns Truncation result with new history and metrics
 */
export function emergencyTruncate(
  history: AgentMessage[],
  contextWindow: number,
  slotTokens: number,
  threshold: number = FAILSAFE_DEFAULTS.threshold,
): FailsafeTruncationResult {
  if (history.length === 0) {
    return { newHistory: [], turnsRemoved: 0, tokensAfter: slotTokens };
  }

  const targetTokens = contextWindow * threshold;
  const groups = findToolCallGroups(history);
  const dropped = new Set<number>();

  // Calculate initial token estimate
  let currentTokens = slotTokens + estimateTokens(
    history.map(m => extractTextContent(m)).join('\n'),
  );

  // Drop from the front, but respect the preserved tail
  const preserveFrom = Math.max(0, history.length - FAILSAFE_PRESERVE_TURNS);
  let i = 0;

  while (currentTokens > targetTokens && i < preserveFrom) {
    if (dropped.has(i)) {
      i++;
      continue;
    }

    // Get all indices that must be dropped together
    const group = groups.get(i);
    const indicesToDrop = group ?? [i];

    // A group that reaches into the preserved tail is kept intact
    const canDrop = indicesToDrop.every(idx => idx < preserveFrom);
    if (!canDrop) {
      i++;
      continue;
    }

    // Drop the turn(s)
    for (const idx of indicesToDrop) {
      const msgTokens = estimateTokens(extractTextContent(history[idx]!));
      currentTokens -= msgTokens;
      dropped.add(idx);
    }

    i++;
  }

  // Build new history excluding dropped messages
  const newHistory = history.filter((_, idx) => !dropped.has(idx));

  return {
    newHistory,
    turnsRemoved: dropped.size,
    tokensAfter: currentTokens,
  };
}

/**
 * Check if emergency truncation should fire based on token count.
 */
export function shouldTruncate(
  currentTokens: number,
  contextWindow: number,
  threshold: number = FAILSAFE_DEFAULTS.threshold,
): boolean {
  if (contextWindow <= 0) return false;
  return (currentTokens / contextWindow) >= threshold;
}

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
