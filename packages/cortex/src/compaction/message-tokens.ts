/**
 * What a history message costs in context tokens: the one basis every
 * compaction layer measures history on. Layer 1 places its hot zone with
 * it; memory cuts units, the verbatim tail and observer pieces with it,
 * waits for it before buffering, and records it as observed; the manager
 * estimates the context and cuts the view with it.
 */

import type { AgentMessage } from '../context-manager.js';
import { estimateTokens } from '../token-estimator.js';
import { extractTextContent } from './tool-messages.js';

/** Estimated tokens of one message. */
export function messageTokens(message: AgentMessage): number {
  return estimateTokens(extractTextContent(message));
}

/** Estimated tokens of `messages`. */
export function historyTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}
