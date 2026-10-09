/**
 * Where a swap cuts the source history, and what it keeps.
 *
 * A swap removes observed messages from the front, up to the verbatim tail
 * or the watermark, whichever comes first, on a unit boundary. The latest
 * user message stays even when it is older than the cut: it moves to the
 * front of what remains. Every removed message is observed (the cut never
 * passes the watermark), and the messages kept are the tail, the latest
 * user message, and anything not yet observed.
 */

import type { AgentMessage } from '../../context-manager.js';
import type { TailSelection } from './tail.js';
import { unitFloor } from './units.js';

export interface SwapCut {
  /** Messages [0, cut) leave the source, except `keep`. */
  cut: number;
  /** The latest user message's index when it is older than the cut. */
  keep: number | null;
}

/** The cut a swap makes with the messages observed up to `watermark`. */
export function swapCut(history: AgentMessage[], tail: TailSelection, watermark: number): SwapCut {
  const cut = unitFloor(history, Math.min(tail.start, watermark));
  const keep = tail.latestUser !== null && tail.latestUser < cut ? tail.latestUser : null;
  return { cut, keep };
}

/** Whether the cut removes any message at all. */
export function removesAny(swap: SwapCut): boolean {
  return swap.cut - (swap.keep !== null ? 1 : 0) > 0;
}

/** The messages the cut removes. */
export function removedBy(history: AgentMessage[], swap: SwapCut): AgentMessage[] {
  return history.slice(0, swap.cut).filter((_, index) => index !== swap.keep);
}

/** The source after the cut: the kept latest user message, then the rest. */
export function keptAfter(history: AgentMessage[], swap: SwapCut): AgentMessage[] {
  return swap.keep !== null ? [history[swap.keep]!, ...history.slice(swap.cut)] : history.slice(swap.cut);
}
