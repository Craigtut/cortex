/**
 * System messages in a loop transcript.
 *
 * pi keeps the system prompt and tool declarations in the transcript as
 * `role: 'system'` messages: a head at index 0, then later updates inline
 * in history (pi's tool-change declarations, Cortex's prompt section
 * patches). Replaying every system message in order yields the current
 * prompt and tools; models that accept mid-conversation system messages
 * read later updates in place without invalidating the cached prefix.
 *
 * This module owns that contract on Cortex's side. The replay semantics are
 * pi-ai's (`utils/transcript`), so the two can never disagree about what a
 * transcript declares.
 *
 * Reference: system-prompt.md, context-manager.md
 */

import type { SystemMessage } from '@earendil-works/pi-ai';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai/utils/transcript';

/** One named part of the system prompt, in render order. */
export interface PromptSection {
  name: string;
  content: string;
}

export function isSystemMessage(message: unknown): message is SystemMessage {
  return typeof message === 'object' && message !== null
    && (message as { role?: unknown }).role === 'system';
}

/** A head that declares nothing: the placeholder before a prompt is set. */
export function emptySystemHead(): SystemMessage {
  return { role: 'system', content: '', timestamp: 0 };
}

/** The conversation without its system messages (what history consumers persist and read). */
export function withoutSystemMessages<T>(messages: readonly T[]): T[] {
  return messages.filter((message) => !isSystemMessage(message));
}

/**
 * Every system message in `messages`, replayed into one head: content
 * appended, sections patched by name, tools resolved. An empty head when
 * nothing is declared.
 */
export function foldSystemMessages(messages: readonly unknown[]): SystemMessage {
  return getCurrentSystemMessage(messages as ReadonlyArray<{ role: string }>) ?? emptySystemHead();
}

/** The sections the transcript currently declares, after replay, in render order. */
export function replaySections(messages: readonly unknown[]): Map<string, string> {
  const sections = new Map<string, string>();
  for (const [name, value] of Object.entries(foldSystemMessages(messages).sections ?? {})) {
    if (value !== null) sections.set(name, value);
  }
  return sections;
}

/** The replayed head's free-form content (non-empty only for a prompt written outside sections). */
export function replayContent(messages: readonly unknown[]): string {
  const { content } = foldSystemMessages(messages);
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * Replace `target[historyStart..]` with `history`, folding into the head at
 * index 0 every system message the rewrite drops, so the tools and prompt
 * the transcript declares survive a rewrite that removes where they were
 * declared. Rewrites only ever drop older history, so folding before the
 * kept messages preserves replay order.
 */
export function spliceHistory(
  target: unknown[],
  historyStart: number,
  history: readonly unknown[],
): void {
  const kept = new Set(history);
  const dropped = target.slice(historyStart).filter(
    (message) => isSystemMessage(message) && !kept.has(message),
  );
  if (dropped.length > 0) {
    target[0] = foldSystemMessages([target[0], ...dropped]);
  }
  target.splice(historyStart, target.length - historyStart, ...history);
}
