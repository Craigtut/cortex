import type { AgentMessage } from '../../src/context-manager.js';

/**
 * An assistant message with string content. pi writes an assistant's
 * content as typed parts; a string is what restored history can hold, and
 * Cortex's readers accept both. Tests use it where the shape does not
 * matter to what they check.
 */
export function textAssistant(content: string, timestamp = 0): AgentMessage {
  return { role: 'assistant', content, timestamp } as unknown as AgentMessage;
}

/**
 * A message in a shape pi's types do not admit (string tool output, legacy
 * `tool_result` parts, a partial assistant message): history as a consumer
 * may restore it, which Cortex reads defensively.
 */
export function restoredMessage(fields: Record<string, unknown>): AgentMessage {
  return fields as unknown as AgentMessage;
}

/** A content part as a test reads it back, legacy fields included. */
export interface ReadPart {
  type?: string;
  text?: string;
  name?: string;
  tool_use_id?: string;
  [key: string]: unknown;
}

/** A message's content parts, read back for assertions whatever their shape. */
export function readParts(message: AgentMessage): ReadPart[] {
  return message.content as unknown as ReadPart[];
}
