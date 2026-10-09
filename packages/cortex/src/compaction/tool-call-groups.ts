/**
 * Structural grouping of tool call messages with their tool results.
 *
 * In real pi conversations, one assistant message may carry N parallel
 * 'toolCall' content blocks; pi-agent-core then appends N separate
 * role 'toolResult' messages (one per call, in order). Providers require
 * every tool call to have a matching result and every result to have a
 * preceding matching call, so the assistant message plus its consecutive
 * toolResult messages form ONE atomic unit for compaction purposes:
 *
 *   - A swap, a view cut, or an overflow drop must remove the whole group
 *     or none of it (observational/units.ts).
 *
 * Orphaning either side corrupts the conversation: an orphaned toolResult
 * (result without its call) is a hard provider 400; an orphaned toolCall
 * gets a synthetic "No result provided" error injected by pi-ai.
 */

import type { AgentMessage } from '../context-manager.js';
import { isToolCallMessage, isToolResultMessage } from './tool-messages.js';

/**
 * Collect the tool call IDs from an assistant message's 'toolCall' blocks.
 */
export function extractToolCallIds(message: AgentMessage): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(message.content)) {
    return ids;
  }
  for (const part of message.content) {
    if (part.type === 'toolCall' && typeof part['id'] === 'string') {
      ids.add(part['id']);
    }
  }
  return ids;
}

/**
 * Find atomic tool call groups in conversation history.
 *
 * A group is a contiguous run of messages: one assistant message containing
 * 'toolCall' blocks followed by its consecutive toolResult messages.
 *
 * Every contiguous toolResult message after an assistant tool-call message is
 * swept into the group, including one whose ID does not match any of the
 * assistant's calls. Providers place a result immediately after its call, so a
 * contiguous run of results structurally belongs to the preceding call message.
 * Ending the group early on a foreign ID (which cannot arise from well-formed
 * pi history) would strand a later, genuinely-matched result as its own head,
 * so the group is kept whole instead.
 *
 * Returns a map from every message index that belongs to a group to the full
 * ascending list of indices in that group. Indices within a group are always
 * contiguous. Messages outside any group are absent from the map.
 */
export function findToolCallGroups(history: AgentMessage[]): Map<number, number[]> {
  const groups = new Map<number, number[]>();

  let i = 0;
  while (i < history.length) {
    if (!isToolCallMessage(history[i]!)) {
      i++;
      continue;
    }

    const group = [i];
    let j = i + 1;
    while (j < history.length && isToolResultMessage(history[j]!)) {
      group.push(j);
      j++;
    }

    for (const idx of group) {
      groups.set(idx, group);
    }
    i = j;
  }

  return groups;
}
