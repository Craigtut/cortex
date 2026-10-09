/**
 * Shared test fixtures matching the REAL pi message shapes at runtime.
 *
 * Validated against node_modules/@earendil-works/pi-ai/dist/types.d.ts:
 *   - AssistantMessage.content blocks: TextContent | ThinkingContent | ToolCall
 *     where ToolCall = { type: 'toolCall', id, name, arguments }
 *   - Tool results are separate messages: ToolResultMessage =
 *     { role: 'toolResult', toolCallId, toolName, content, isError, timestamp }
 *   - pi-agent-core's agent loop pushes ONE toolResult message per tool call,
 *     so an assistant message with N parallel toolCall blocks is followed by
 *     N consecutive toolResult messages.
 */

import { expect } from 'vitest';
import type { AgentMessage } from '../../../src/context-manager.js';
import { restoredMessage, textAssistant } from '../../helpers/messages.js';

export function makeUserMsg(content: string): AgentMessage {
  return { role: 'user', content, timestamp: 0 };
}

export function makeAssistantMsg(content: string): AgentMessage {
  return textAssistant(content, 0);
}

export interface ToolCallSpec {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * Real assistant message carrying one or more 'toolCall' content blocks,
 * optionally preceded by a text block.
 */
export function makeToolCallMsg(calls: ToolCallSpec[], text?: string): AgentMessage {
  const content: Array<{ type: string; text?: string; [key: string]: unknown }> = [];
  if (text !== undefined) {
    content.push({ type: 'text', text });
  }
  for (const call of calls) {
    content.push({
      type: 'toolCall',
      id: call.id,
      name: call.name,
      arguments: call.arguments ?? {},
    });
  }
  // Content as pi writes it, without the response fields a test never reads.
  return restoredMessage({ role: 'assistant', content, timestamp: 0 });
}

/**
 * Real runtime tool result message (role 'toolResult', one per tool call).
 */
export function makeToolResultMsg(
  toolCallId: string,
  toolName: string,
  text: string,
): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0,
  };
}

/**
 * Assert the structural invariant providers require. Anthropic (and the pi
 * runtime) demand that an assistant message's `toolCall` blocks are answered
 * by `toolResult` messages that IMMEDIATELY follow it, one per call, before
 * any other message. This helper enforces contiguity, not just presence:
 *   - a toolResult may only appear inside the contiguous run directly after
 *     its own assistant tool-call message, and its id must match one of that
 *     message's calls (otherwise it is an orphaned result → hard 400), and
 *   - every toolCall block must be answered within that run (otherwise it is
 *     an orphaned call → pi injects a synthetic "No result provided" error).
 */
export function assertNoOrphans(messages: AgentMessage[]): void {
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;

    // A tool result reached here is not inside any call's contiguous run.
    if (msg.role === 'toolResult') {
      expect.fail(
        `orphaned tool result at index ${i}: ${String(msg.toolCallId)} has no immediately preceding toolCall message`,
      );
    }

    const callIds =
      msg.role === 'assistant' && Array.isArray(msg.content)
        ? msg.content.flatMap(p => (p.type === 'toolCall' && typeof p.id === 'string' ? [p.id] : []))
        : [];

    if (callIds.length === 0) {
      i++;
      continue;
    }

    // Consume the contiguous run of toolResult messages answering this call.
    const remaining = new Set(callIds);
    let j = i + 1;
    for (let next = messages[j]; next?.role === 'toolResult'; next = messages[j]) {
      const id = next.toolCallId;
      expect(
        typeof id === 'string' && remaining.has(id),
        `tool result at index ${j} (${String(id)}) does not match an open call from the assistant message at index ${i}`,
      ).toBe(true);
      remaining.delete(id as string);
      j++;
    }

    expect(
      remaining.size,
      `orphaned tool call(s) with no contiguous toolResult: ${[...remaining].join(', ')}`,
    ).toBe(0);

    i = j;
  }
}
