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
 * Both keep the latest user message and cut only on unit boundaries. Both
 * also keep the last unit of history, but that protects content only in
 * the view: after the provider rejects a request, the last unit is pi's
 * failure stub for it.
 */

import type { AgentMessage } from '../../context-manager.js';
import type { ObservationLedger } from './ledger.js';
import type { ObservationLog } from './log.js';
import { applySwap, removesAny, swapCut } from './swap.js';
import type { AppliedSwap } from './swap.js';
import { latestUserIndex, selectTail } from './tail.js';
import type { MemoryGapInfo } from './types.js';
import { unitCeil } from './units.js';

/**
 * The request's history with the oldest units dropped so the rest fits
 * `budgetTokens`, keeping the latest user message and the last unit.
 * `injections` are the messages the pipeline added to this request only
 * (ephemeral context, loaded skills, task state, the headline): they stay,
 * and every other message before the tail goes, so a unit always leaves
 * whole, whatever copies Layer 1 made of its tool results. Null when
 * nothing needs dropping.
 */
export function truncateView(
  view: AgentMessage[],
  injections: ReadonlySet<AgentMessage>,
  budgetTokens: number,
): AgentMessage[] | null {
  const tail = selectTail(view, budgetTokens);
  const latestUser = latestUserIndex(view, injections);
  const dropped: AgentMessage[] = [];
  const kept: AgentMessage[] = [];
  view.forEach((message, index) => {
    if (index < tail.start && index !== latestUser && !injections.has(message)) dropped.push(message);
    else kept.push(message);
  });
  if (dropped.length === 0) return null;
  return [hiddenSpanNote(dropped), ...kept];
}

export interface OverflowPorts {
  ledger: ObservationLedger;
  log: ObservationLog;
  /** The error keeping memory degraded, if it is: why it fell behind. */
  lastError(): Error | null;
  /** Forget the pending observer call: messages in its range were dropped. */
  invalidateObserver(): void;
  logger(): { warn: (msg: string) => void } | null;
}

/** What an overflow drop did to the source. */
export interface OverflowRewrite {
  /** The new source history. */
  kept: AgentMessage[];
  /** The swap that came first: observed messages that left as in any swap. */
  swapped: AppliedSwap;
  /** Unobserved messages dropped, which the log records as a gap. */
  dropped: AgentMessage[];
}

/**
 * The source rewrite after the provider rejected a request for overflow,
 * and the gap reports it makes.
 */
export class OverflowDrop {
  private readonly gapHandlers: Array<(info: MemoryGapInfo) => void> = [];

  constructor(private readonly ports: OverflowPorts) {}

  onGap(handler: (info: MemoryGapInfo) => void): void {
    this.gapHandlers.push(handler);
  }

  /**
   * Shrink `source` so it fits `budgetTokens`. Synchronous: it runs in the
   * failed run's catch, with no time for an observer call.
   *
   * Everything already observed outside the reduced tail leaves as in any
   * swap. Unobserved messages outside it are dropped, oldest first, and the
   * log records the gap. The latest user message stays. So does the last
   * unit, which after a rejected request is pi's failure stub, not content.
   *
   * @returns the rewrite, or null when nothing could be dropped
   */
  drop(source: AgentMessage[], budgetTokens: number): OverflowRewrite | null {
    const { ledger, log } = this.ports;
    const tail = selectTail(source, budgetTokens);
    const watermark = ledger.watermark;
    const swap = swapCut(source, tail, watermark);
    // Unobserved units outside the tail: from the first unit boundary past
    // what is observed, up to the tail.
    const droppedIndices = new Set<number>();
    for (let i = unitCeil(source, Math.max(swap.cut, watermark)); i < tail.start; i++) {
      if (i !== tail.latestUser) droppedIndices.add(i);
    }
    if (!removesAny(swap) && droppedIndices.size === 0) return null;

    const applied = applySwap(source, swap, ledger, log);
    const dropped = [...droppedIndices].map((i) => source[i]!);
    if (dropped.length > 0) {
      // Every dropped index is past the observed region; only a pending
      // observer over them is affected.
      if (ledger.pendingRange()) this.ports.invalidateObserver();
      const lastError = this.ports.lastError();
      const reason = lastError
        ? `the memory model was failing: ${lastError.message}`
        : 'the context overflowed before they were observed';
      const note = gapNote(dropped, reason);
      log.append(note);
      const span = timeSpan(dropped);
      this.dispatchGap({
        droppedMessages: dropped.length,
        from: span?.start ?? null,
        to: span?.end ?? null,
        reason,
        note,
      });
    }
    const droppedSet = new Set(dropped);
    return { kept: applied.kept.filter((message) => !droppedSet.has(message)), swapped: applied, dropped };
  }

  private dispatchGap(info: MemoryGapInfo): void {
    for (const handler of this.gapHandlers) {
      try {
        handler(info);
      } catch (err) {
        this.ports.logger()?.warn(`onMemoryGap handler threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
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
