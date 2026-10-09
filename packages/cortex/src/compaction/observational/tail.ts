/**
 * The verbatim tail a swap keeps: the most recent units of history that fit
 * the tail budget, plus the latest user message wherever it is.
 *
 * The last unit is always kept, whatever its size: it is what the next
 * request answers (a tool call's results, the user's newest words). The
 * latest user message is kept too, since it is the input the loop's current
 * activity responds to; deliveries and steers are user turns and count.
 */

import type { AgentMessage } from '../../context-manager.js';
import { isToolResultMessage } from '../microcompaction.js';
import { messageTokens, unitsOf } from './units.js';

export interface TailSelection {
  /** Start of the verbatim tail: a unit boundary. */
  start: number;
  /** Index of the latest user message, or null when there is none. */
  latestUser: number | null;
}

/**
 * Select the verbatim tail of `history` within `budgetTokens`.
 */
export function selectTail(history: AgentMessage[], budgetTokens: number): TailSelection {
  const units = unitsOf(history);
  let start = history.length;
  let tokens = 0;
  for (let u = units.length - 1; u >= 0; u--) {
    const unit = units[u]!;
    let unitTokens = 0;
    for (let i = unit.start; i < unit.end; i++) unitTokens += messageTokens(history[i]!);
    if (start < history.length && tokens + unitTokens > budgetTokens) break;
    tokens += unitTokens;
    start = unit.start;
  }
  return { start, latestUser: latestUserIndex(history) };
}

/**
 * The latest message a user (or a delivery) sent, past tool results and
 * declarations, and past `skip` (a request's view-only injections, which
 * are user-role but nobody's words).
 */
export function latestUserIndex(history: AgentMessage[], skip?: ReadonlySet<AgentMessage>): number | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === 'user' && !isToolResultMessage(message) && !skip?.has(message)) return i;
  }
  return null;
}
