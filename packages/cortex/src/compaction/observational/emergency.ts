/**
 * What to do when a request will not fit even after a swap.
 *
 * In-band (before a request), the cut is made in the request's view only:
 * the source keeps every message and the observer still reads them, so
 * nothing is lost, and the model is told which span it is not shown.
 *
 * After the provider rejects a request for overflow, the source itself must
 * shrink. Observed messages leave as in any swap; unobserved ones are
 * dropped, oldest first, and the log records the gap.
 *
 * Both keep the latest user message and the last unit of history, and cut
 * only on unit boundaries.
 */

import type { AgentMessage } from '../../context-manager.js';
import { selectTail } from './tail.js';

/**
 * The request's history with the oldest units dropped so the rest fits
 * `budgetTokens`, keeping the latest user message and the last unit. Only
 * transcript messages (in `source`) are dropped; view-only injections
 * stay. Null when nothing needs dropping.
 */
export function truncateView(
  view: AgentMessage[],
  source: ReadonlySet<AgentMessage>,
  budgetTokens: number,
): AgentMessage[] | null {
  const tail = selectTail(view, budgetTokens);
  const dropped: AgentMessage[] = [];
  const kept: AgentMessage[] = [];
  view.forEach((message, index) => {
    if (index < tail.start && index !== tail.latestUser && source.has(message)) dropped.push(message);
    else kept.push(message);
  });
  if (dropped.length === 0) return null;
  return [hiddenSpanNote(dropped), ...kept];
}

/** The one-request note standing in for messages the view does not show. */
function hiddenSpanNote(hidden: AgentMessage[]): AgentMessage {
  const span = timeSpan(hidden);
  const when = span ? ` from ${span.from} to ${span.to}` : '';
  return {
    role: 'user',
    content: `[${hidden.length} earlier messages${when} are not shown: the context is full and memory has not recorded them yet.]`,
    timestamp: Date.now(),
  };
}

/**
 * The log line recording messages dropped before memory recorded them.
 * Marked critical so reflection keeps it; the log also restores a gap line
 * a reflection drops.
 */
export function gapNote(dropped: AgentMessage[], reason: string): string {
  const span = timeSpan(dropped);
  const when = span ? ` (${span.from} to ${span.to})` : '';
  const spanText = span ? ` from ${span.from} to ${span.to}` : '';
  return `* \u{1F534}${when} GAP: ${dropped.length} messages${spanText} left context before memory recorded them (${reason}). Details from that span are missing.`;
}

/** Earliest and latest timestamps of `messages` as clock times, or null without any. */
export function timeSpan(messages: AgentMessage[]): { from: string; to: string; start: Date; end: Date } | null {
  const times = messages.map((message) => message.timestamp).filter((time): time is number => typeof time === 'number' && time > 0);
  if (times.length === 0) return null;
  const start = new Date(Math.min(...times));
  const end = new Date(Math.max(...times));
  return { from: clock(start), to: clock(end), start, end };
}

function clock(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}
