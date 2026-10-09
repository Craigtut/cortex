/**
 * Reading tool activity out of transcript messages: their text (tool calls
 * rendered so the observer and token estimates see them), whether a message
 * is a tool call or a tool result, and the tool's name. Shared by every
 * layer that walks history: Layer 1 trimming, observational memory's units
 * and tail, tool-call grouping.
 */

import type { AgentMessage } from '../context-manager.js';
import { contentPartsOf, stringField } from '../pi-message.js';


/**
 * Render tool call arguments as a compact JSON string.
 * Returns '' for empty/missing arguments. Full fidelity (no truncation):
 * the output feeds token estimation and the observer, both of which need
 * the real size and content of the arguments.
 */
function formatToolCallArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  try {
    const json = JSON.stringify(args);
    return json === '{}' || json === undefined ? '' : json;
  } catch {
    return String(args);
  }
}

/**
 * Extract the text content from a message's content field.
 * Handles both string content and content arrays.
 *
 * For content arrays:
 *   - 'text' parts (and legacy 'tool_result' parts with a text field)
 *     contribute their text verbatim.
 *   - 'toolCall' parts (pi-ai assistant tool call blocks) render as
 *     "[Tool call: <name> <args JSON>]" so tool activity is visible to
 *     the observer and counted by token estimation. A turn
 *     that is purely tool calls no longer renders empty.
 */
export function extractTextContent(message: AgentMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  // Guard: content may be undefined/null (corrupted toolResult) or empty
  const parts = contentPartsOf(message);
  if (!parts || parts.length === 0) {
    return '';
  }

  const segments: string[] = [];
  for (const part of parts) {
    if (part['type'] === 'toolCall') {
      const name = stringField(part, 'name') ?? 'unknown';
      const args = formatToolCallArgs(part['arguments']);
      segments.push(args ? `[Tool call: ${name} ${args}]` : `[Tool call: ${name}]`);
      continue;
    }
    const text = stringField(part, 'text');
    if (text !== undefined) {
      segments.push(text);
    }
  }
  return segments.join('\n');
}

/**
 * Check if a message is a tool result: pi's `toolResult` message, or a
 * restored message carrying legacy `tool_result` parts.
 */
export function isToolResultMessage(message: AgentMessage): boolean {
  if (message.role === 'toolResult') {
    return true;
  }
  return contentPartsOf(message)?.some(part => part['type'] === 'tool_result') ?? false;
}

/**
 * Check if an assistant message contains a tool call.
 * Real pi-ai assistant messages carry tool calls as content blocks of
 * type 'toolCall' ({ type: 'toolCall', id, name, arguments }).
 */
export function isToolCallMessage(message: AgentMessage): boolean {
  if (message.role !== 'assistant') {
    return false;
  }
  return contentPartsOf(message)?.some(part => part['type'] === 'toolCall') ?? false;
}

/**
 * Extract the tool name from a tool result or tool call message.
 * Returns null if the message is not a tool-related message.
 */
export function extractToolName(message: AgentMessage): string | null {
  const toolName = stringField(message, 'toolName');
  if (toolName !== undefined) {
    return toolName;
  }

  for (const part of contentPartsOf(message) ?? []) {
    const name = stringField(part, 'name');
    if ((part['type'] === 'toolCall' || part['type'] === 'tool_result') && name !== undefined) {
      return name;
    }
  }

  return null;
}
