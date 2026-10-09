/**
 * Readers for pi-agent-core / pi-ai message and event shapes.
 *
 * Cortex types its transcript with pi's own message types, but history a
 * consumer restores is data Cortex did not write: it can hold string
 * content where pi has parts, legacy `tool_result` parts, or missing
 * fields. Every reader here is defensive: a missing or malformed field
 * reads as empty, never throws. One reader per question keeps the several
 * consumers (the loop, the event bridge, the facade, compaction, quick
 * lookups) from drifting apart on shape details such as string versus
 * typed-part content.
 */

import type { CortexUsage } from './types.js';

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
  return value && typeof value === 'object' ? (value as RawRecord) : null;
}

/** Text parts of a typed-content array, joined. */
function joinTextParts(content: unknown[]): string {
  return content
    .filter((part) => {
      const p = asRecord(part);
      return p?.['type'] === 'text' && typeof p['text'] === 'string';
    })
    .map((part) => (part as RawRecord)['text'] as string)
    .join('');
}

// ---------------------------------------------------------------------------
// Message content
// ---------------------------------------------------------------------------

/** A content part as stored: any shape, since restored history may hold any. */
export type LoosePart = Readonly<Record<string, unknown>>;

/**
 * A message's content array, its parts read as loose records, or null when
 * the content is a string or missing. The array itself, not a copy: a
 * rewrite maps over it index for index.
 */
export function contentPartsOf(message: unknown): readonly LoosePart[] | null {
  const content = asRecord(message)?.['content'];
  return Array.isArray(content) ? (content as LoosePart[]) : null;
}

/** A string field of a record, or undefined. */
export function stringField(value: unknown, key: string): string | undefined {
  const field = asRecord(value)?.[key];
  return typeof field === 'string' ? field : undefined;
}

/**
 * `message` with its content replaced, every other field kept. For
 * rewrites that change the text inside a message, not its kind: the caller
 * keeps each part's shape (or the content's string form), so the result is
 * the same kind of message as the input, restored legacy shapes included.
 */
export function withContent<T extends object>(message: T, content: string | readonly unknown[]): T {
  return { ...message, content } as T;
}

/**
 * Text of an assistant message: string content as is, typed content's text
 * parts joined (thinking and tool calls excluded), else a top-level `text`.
 */
export function assistantText(message: unknown): string {
  const msg = asRecord(message);
  if (!msg) return '';
  const content = msg['content'];
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return joinTextParts(content);
  if (typeof msg['text'] === 'string') return msg['text'];
  return '';
}

/** Whether a message carries non-empty text content. */
export function messageHasText(message: unknown): boolean {
  const content = asRecord(message)?.['content'];
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const p = asRecord(part);
    return p?.['type'] === 'text' && typeof p['text'] === 'string' && p['text'].length > 0;
  });
}

/** Whether a content part is a tool call (pi's `toolCall` or the wire `tool_use`). */
export function isToolCallPart(part: unknown): boolean {
  const type = asRecord(part)?.['type'];
  return type === 'toolCall' || type === 'tool_use';
}

/** Whether a message contains tool-call content parts. */
export function messageHasToolCalls(message: unknown): boolean {
  const content = asRecord(message)?.['content'];
  return Array.isArray(content) && content.some(isToolCallPart);
}

/**
 * Arguments of the first pi `toolCall` part naming `toolName`, or null.
 * Used to read a forced tool call back out of a structured completion.
 */
export function toolCallArguments(message: unknown, toolName: string): RawRecord | null {
  const content = asRecord(message)?.['content'];
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    const p = asRecord(part);
    if (p?.['type'] === 'toolCall' && p['name'] === toolName) {
      const args = asRecord(p['arguments']);
      if (args) return args;
    }
  }
  return null;
}

/** Names of the tool calls in an assistant message, in order. */
export function toolCallNames(message: unknown): string[] {
  const msg = asRecord(message);
  if (msg?.['role'] !== 'assistant' || !Array.isArray(msg['content'])) return [];
  return msg['content']
    .filter(isToolCallPart)
    .map((part) => {
      const p = part as RawRecord;
      return String(p['name'] ?? p['toolName'] ?? 'unknown');
    });
}

/**
 * Text of a user message: string content as is, else every part's `text`
 * joined (user content has no thinking or tool-call parts to exclude).
 */
export function userMessageText(message: unknown): string {
  const content = asRecord(message)?.['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const text = asRecord(part)?.['text'];
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/** The last assistant message in a history, or undefined. */
export function findLastAssistant<T>(history: readonly T[]): T | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (asRecord(history[i])?.['role'] === 'assistant') return history[i];
  }
  return undefined;
}

/**
 * The message with empty content (undefined, null, or `[]`) replaced by a
 * "(no output)" text part; otherwise the message itself. Providers reject
 * empty content, and a checkpoint from a failed tool execution can hold it.
 */
export function withPlaceholderContent<T extends object>(message: T): T {
  const content = (message as RawRecord)['content'];
  if (content === undefined || content === null || (Array.isArray(content) && content.length === 0)) {
    return { ...message, content: [{ type: 'text' as const, text: '(no output)' }] };
  }
  return message;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function numberOr0(record: RawRecord, key: string): number {
  const value = record[key];
  return typeof value === 'number' ? value : 0;
}

/**
 * Typed usage from a pi-ai Usage object (`{ input, output, cacheRead,
 * cacheWrite, totalTokens, cost: {...} }`), missing fields read as 0.
 * With `requireNonZero`, a usage whose input, output, cacheRead, and
 * totalTokens are all zero reads as absent.
 */
export function readUsage(
  raw: unknown,
  options?: { requireNonZero?: boolean },
): CortexUsage | null {
  const u = asRecord(raw);
  if (!u) return null;
  const input = numberOr0(u, 'input');
  const output = numberOr0(u, 'output');
  const cacheRead = numberOr0(u, 'cacheRead');
  const cacheWrite = numberOr0(u, 'cacheWrite');
  const totalTokens = typeof u['totalTokens'] === 'number' ? u['totalTokens'] : input + output;
  if (
    options?.requireNonZero &&
    input === 0 && output === 0 && cacheRead === 0 && totalTokens === 0
  ) {
    return null;
  }
  const c = asRecord(u['cost']);
  const cost = c
    ? {
        input: numberOr0(c, 'input'),
        output: numberOr0(c, 'output'),
        cacheRead: numberOr0(c, 'cacheRead'),
        cacheWrite: numberOr0(c, 'cacheWrite'),
        total: numberOr0(c, 'total'),
      }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

/** {@link readUsage} of an AssistantMessage's `usage`, stamped with its model. */
export function assistantUsage(
  message: unknown,
  options?: { requireNonZero?: boolean },
): CortexUsage | null {
  const msg = asRecord(message);
  if (!msg) return null;
  const usage = readUsage(msg['usage'], options);
  if (usage && typeof msg['model'] === 'string') usage.model = msg['model'];
  return usage;
}

/**
 * Total input tokens the model saw. With prefix caching, input shifts
 * between input/cacheRead/cacheWrite, so the real context size is their
 * sum; falls back to `totalTokens - output` when those are missing.
 */
export function totalInputTokens(usage: RawRecord): number {
  const input = numberOr0(usage, 'input');
  const cacheRead = numberOr0(usage, 'cacheRead');
  const cacheWrite = numberOr0(usage, 'cacheWrite');
  if (input + cacheRead + cacheWrite > 0) return input + cacheRead + cacheWrite;
  const totalTokens = numberOr0(usage, 'totalTokens');
  const output = numberOr0(usage, 'output');
  return totalTokens > output ? totalTokens - output : 0;
}

// ---------------------------------------------------------------------------
// turn_end events
// ---------------------------------------------------------------------------

/**
 * Usage of a turn_end event: the assistant message's, else a usage the
 * event or its result carries directly.
 */
export function turnUsage(event: unknown, options?: { requireNonZero?: boolean }): CortexUsage | null {
  const e = asRecord(event);
  if (!e) return null;
  return (
    assistantUsage(e['message'], options) ??
    readUsage(e['usage'], options) ??
    readUsage(asRecord(e['result'])?.['usage'], options)
  );
}

/**
 * Text of a pi turn_end event. pi emits `{ message, toolResults }` with the
 * AssistantMessage's content as typed parts; a top-level `text`, string
 * content, and a `result` carrying the content are accepted as well.
 */
export function turnText(event: unknown): string | null {
  const e = asRecord(event);
  if (!e) return null;
  if (typeof e['text'] === 'string') return e['text'];
  for (const holder of [asRecord(e['message']), asRecord(e['result'])]) {
    if (!holder) continue;
    const content = holder['content'];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const hasText = content.some((part) => {
        const p = asRecord(part);
        return p?.['type'] === 'text' && typeof p['text'] === 'string';
      });
      if (hasText) return joinTextParts(content);
    }
  }
  return null;
}

/**
 * Total input tokens from a turn_end event: the first of `message.usage`,
 * `usage`, and `result.usage` that yields a non-zero total.
 */
export function turnInputTokens(event: unknown): number {
  const e = asRecord(event);
  if (!e) return 0;
  const candidates = [
    asRecord(e['message'])?.['usage'],
    e['usage'],
    asRecord(e['result'])?.['usage'],
  ];
  for (const candidate of candidates) {
    const usage = asRecord(candidate);
    if (!usage) continue;
    const total = totalInputTokens(usage);
    if (total > 0) return total;
  }
  return 0;
}
