/**
 * History in units: a tool-call group (an assistant tool-call message and
 * its consecutive results) or a single message. Observation pieces and the
 * verbatim tail start and end only on unit boundaries, so no rewrite ever
 * separates a tool call from its result.
 */

import type { AgentMessage } from '../../context-manager.js';
import { messageTokens } from '../message-tokens.js';
import { findToolCallGroups } from '../tool-call-groups.js';

/** A unit's range in history, [start, end). */
export interface Unit {
  start: number;
  end: number;
}

/** The units of `history`, in order. */
export function unitsOf(history: AgentMessage[]): Unit[] {
  const groups = findToolCallGroups(history);
  const units: Unit[] = [];
  let i = 0;
  while (i < history.length) {
    const group = groups.get(i);
    const end = group ? group[group.length - 1]! + 1 : i + 1;
    units.push({ start: i, end });
    i = end;
  }
  return units;
}

/** The largest unit boundary at or below `index`. */
export function unitFloor(history: AgentMessage[], index: number): number {
  let floor = 0;
  for (const unit of unitsOf(history)) {
    if (unit.end > index) break;
    floor = unit.end;
  }
  return floor;
}

/** The smallest unit boundary at or above `index`. */
export function unitCeil(history: AgentMessage[], index: number): number {
  for (const unit of unitsOf(history)) {
    if (unit.start >= index) return unit.start;
    if (unit.end > index) return unit.end;
  }
  return history.length;
}

/**
 * Where the next observation piece starting at `from` should end: as many
 * whole units as fit `capTokens`, and at least one.
 */
export function pieceEnd(history: AgentMessage[], from: number, capTokens: number): number {
  let end = from;
  let tokens = 0;
  for (const unit of unitsOf(history)) {
    if (unit.end <= from) continue;
    // A `from` inside a unit (only legacy state can put it there) takes the
    // unit's remainder first.
    let unitTokens = 0;
    for (let i = Math.max(unit.start, from); i < unit.end; i++) unitTokens += messageTokens(history[i]!);
    if (end > from && tokens + unitTokens > capTokens) break;
    tokens += unitTokens;
    end = unit.end;
  }
  return end;
}
