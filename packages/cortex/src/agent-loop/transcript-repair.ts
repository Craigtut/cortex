/**
 * Transcript repair after a failed run. pi appends a synthetic assistant
 * failure stub when a run fails, and pushes a run's leading messages at run
 * start, before any model call; these functions decide what of that to
 * remove so the transcript can be resumed (continue() rejects a trailing
 * assistant turn) or the undelivered content re-delivered exactly once.
 *
 * Pure over the live message array (mutated in place); callers report what
 * was removed to the compaction manager.
 */

import type { AgentMessage } from '../context-manager.js';
import { messageHasText, messageHasToolCalls, userMessageText } from '../pi-message.js';
import { isSystemMessage } from '../system-transcript.js';

type RawMessage = Record<string, unknown>;

function raw(message: AgentMessage | undefined): RawMessage {
  return message as unknown as RawMessage;
}

/**
 * Whether a transcript message is a synthetic failure stub that trimming
 * may remove. Error stubs are always trimmable.
 *
 * An aborted message keeps pi's PARTIAL content, which the user may already
 * have read, so it is trimmable only when it has no text to keep or carries
 * tool calls (trailing ones are unpaired, a hard provider error next
 * request).
 */
export function isTrimmableFailureMessage(msg: RawMessage): boolean {
  if (msg['role'] !== 'assistant') return false;
  const isAborted = msg['stopReason'] === 'aborted';
  if (msg['stopReason'] === 'error' || (msg['errorMessage'] != null && !isAborted)) {
    return true;
  }
  if (!isAborted) return false;
  return !messageHasText(msg) || messageHasToolCalls(msg);
}

/** Trailing failure stubs at or above index `floor`. */
export function trailingFailureCount(messages: readonly AgentMessage[], floor = 0): number {
  let end = messages.length;
  while (end > floor && isTrimmableFailureMessage(raw(messages[end - 1]))) {
    end -= 1;
  }
  return messages.length - end;
}

/**
 * Whether trimming trailing failure stubs would leave a transcript that
 * continue() can resume: the last turn is a user or tool-result past the
 * slot region (a failure with only slots present must surface instead).
 * System messages declare, they are not turns: one trailing (a tool or
 * prompt update pi or Cortex wrote after the results) is looked past.
 */
export function isResumableAfterTrim(messages: readonly AgentMessage[], historyStart: number): boolean {
  let lastIndex = messages.length - trailingFailureCount(messages) - 1;
  while (lastIndex >= historyStart && isSystemMessage(messages[lastIndex])) lastIndex -= 1;
  if (lastIndex < historyStart) return false;
  return raw(messages[lastIndex])['role'] !== 'assistant';
}

/** Remove trailing failure stubs. Returns whether anything was removed. */
export function trimTrailingFailures(messages: AgentMessage[]): boolean {
  const trimCount = trailingFailureCount(messages);
  if (trimCount === 0) return false;
  messages.splice(messages.length - trimCount, trimCount);
  return true;
}

/**
 * After a failed delivery run (a sweep or a background drain), restore the
 * transcript to its pre-delivery state when possible, so a re-attempt does
 * not append the same body again.
 *
 * - 'requeue': the delivery message is no longer in the transcript; the
 *   content must be re-queued to survive.
 * - 'durable': the run progressed past the delivery message; re-queueing
 *   would duplicate it.
 *
 * A tail ending in an assistant tool-call turn (unpaired, a hard provider
 * error next request) unwinds the whole delivery. User messages pi injected
 * inside that run come back as `injectedUserTexts` for exactly-once
 * re-delivery. The transcript cannot tell a drained steer from a drained
 * follow-up, so the caller parks them rather than guess a pi queue.
 *
 * @param runStart - Where the run pushed the delivery message: the live
 *   history boundary, which compaction moves when it removes older history
 *   mid-run, never a length captured before the run.
 * @param deliveryContent - The delivery message's text. When the first turn
 *   at `runStart` is not it, compaction removed or moved it mid-run: the run
 *   progressed, so the delivery is durable, and nothing after `runStart` may
 *   be mistaken for it.
 * @returns `removed`: the indices of every message removed, ascending, as
 *   the array was before the call. Not only the tail: system messages among
 *   the unwound turns stay.
 */
export function unwindFailedDelivery(
  messages: AgentMessage[],
  runStart: number,
  deliveryContent?: string,
): { outcome: 'requeue' | 'durable'; injectedUserTexts: string[]; removed: number[] } {
  const injectedUserTexts: string[] = [];
  // Only this run's stubs; an earlier turn's stub stays.
  const stubs = trailingFailureCount(messages, runStart);
  const stubIndices = Array.from({ length: stubs }, (_, i) => messages.length - stubs + i);
  messages.splice(messages.length - stubs, stubs);
  // Every turn sits before the stubs, so its index is the same either side
  // of their removal.
  const result = (outcome: 'requeue' | 'durable', removedTurns: number[] = []) =>
    ({ outcome, injectedUserTexts, removed: [...removedTurns, ...stubIndices] });

  // A mid-run compaction keeps the recent tail, so the delivery is durable.
  if (messages.length < runStart) return result('durable');
  // Turns only: pi declares tool changes ahead of the delivery and Cortex
  // patches the prompt mid-run. Those system messages stay where they are
  // (they declare what is still true); only turns are unwound.
  const turns = turnIndicesFrom(messages, runStart);
  if (turns.length === 0) return result('requeue');
  if (deliveryContent !== undefined && !isDeliveryMessage(messages[turns[0]!], deliveryContent)) {
    return result('durable');
  }
  if (turns.length === 1 && raw(messages[turns[0]!])['role'] === 'user') {
    removeIndices(messages, turns);
    return result('requeue', turns);
  }
  if (raw(messages[turns[turns.length - 1]!])['role'] === 'assistant') {
    for (const index of turns.slice(1)) {
      const msg = raw(messages[index]);
      if (msg['role'] !== 'user') continue;
      const text = userMessageText(msg);
      if (text.trim().length > 0) injectedUserTexts.push(text);
    }
    removeIndices(messages, turns);
    return result('requeue', turns);
  }
  return result('durable');
}

/** Whether `message` is the user turn carrying `content`. */
function isDeliveryMessage(message: AgentMessage | undefined, content: string): boolean {
  return raw(message)['role'] === 'user' && userMessageText(message) === content;
}

/** Indices of the non-system messages at or after `from`. */
function turnIndicesFrom(messages: readonly AgentMessage[], from: number): number[] {
  const indices: number[] = [];
  for (let i = from; i < messages.length; i++) {
    if (!isSystemMessage(messages[i])) indices.push(i);
  }
  return indices;
}

/** Remove the messages at ascending `indices`. */
function removeIndices(messages: AgentMessage[], indices: readonly number[]): void {
  for (let i = indices.length - 1; i >= 0; i--) messages.splice(indices[i]!, 1);
}

/**
 * After a terminal failure of a run whose leading batch carried spliced
 * wake deliveries, decide whether those deliveries still need a run.
 *
 * - 'repark': no run answered them; landed wake messages are spliced out.
 * - 'durable': the run progressed past the batch; re-parking would
 *   duplicate it.
 * - 'rewritten': only part of the batch sits at the boundary. Left alone:
 *   duplicating content is worse than leaving it as context.
 *
 * Messages are identity-checked by role and content, so a mid-run history
 * rewrite never removes an unrelated message. The prompt input and flushed
 * silent deliveries stay.
 *
 * @param boundary - Index where pi pushed the batch.
 * @param trailingBatchCount - Messages the batch carried after the wake
 *   portion (flushed silent deliveries); the prompt input follows those.
 * @returns `removed`: the indices of the wake messages spliced out,
 *   ascending, as the array was before the call. The prompt input and any
 *   failure stub after them stay.
 */
export function unwindSplicedBatch(
  messages: AgentMessage[],
  wakeBatch: ReadonlyArray<{ content: string }>,
  boundary: number,
  trailingBatchCount: number,
): { outcome: 'repark' | 'durable' | 'rewritten'; removed: number[] } {
  // pi puts a tool-change declaration ahead of the batch, and Cortex may
  // patch the prompt mid-run: match and count turns, not system messages.
  const end = messages.length - trailingFailureCount(messages, boundary);
  const turns = turnIndicesFrom(messages, boundary).filter((index) => index < end);
  let landed = 0;
  while (landed < wakeBatch.length && landed < turns.length) {
    const msg = raw(messages[turns[landed]!]);
    if (msg['role'] !== 'user' || msg['content'] !== wakeBatch[landed]!.content) break;
    landed += 1;
  }

  if (landed === 0) return { outcome: 'repark', removed: [] };
  if (landed < wakeBatch.length) return { outcome: 'rewritten', removed: [] };

  // Any surviving turn beyond the pushed batch, stubs aside, means progress.
  if (turns.length > wakeBatch.length + trailingBatchCount + 1) {
    return { outcome: 'durable', removed: [] };
  }
  const removed = turns.slice(0, landed);
  removeIndices(messages, removed);
  return { outcome: 'repark', removed };
}
