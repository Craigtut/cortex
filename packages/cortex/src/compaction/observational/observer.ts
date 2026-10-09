/**
 * Observer module for the observational memory system.
 *
 * Handles extracting observations from raw conversation messages via a
 * background LLM call. The observer watches the conversation and produces
 * structured, timestamped observations that become the agent's sole
 * memory of past interactions.
 *
 * References:
 *   - observational-memory-architecture.md (Observer System section)
 *   - compaction-strategy.md
 */

import type { CompleteFn } from './types.js';
import type { AgentMessage } from '../../context-manager.js';
import type { ObserverOutput } from './types.js';
import { OBSERVER_SYSTEM_PROMPT } from './constants.js';
import { estimateTokens } from '../../token-estimator.js';
import { isSystemMessage } from '../../system-transcript.js';
import { MemoryReplyError, readObservationsBlock } from './reply.js';
import { applyBookend } from '../microcompaction.js';
import { historyTokens } from '../message-tokens.js';
import { callWithPolicy, SINGLE_ATTEMPT } from './calls.js';
import type { CallPolicy } from './calls.js';

// ---------------------------------------------------------------------------
// Message Formatting
// ---------------------------------------------------------------------------

/**
 * Converts an array of AgentMessages into a formatted string for the
 * observer LLM.
 *
 * Each message is formatted with role and positional timestamp. Messages
 * with content arrays (tool calls/results) receive structured formatting
 * so the observer can extract meaningful takeaways.
 *
 * Messages with timestamps are formatted with their actual date and time.
 * Messages without timestamps fall back to sequential labels.
 * Messages are grouped by date when timestamps are available.
 */
export function formatMessagesForObserver(messages: AgentMessage[]): string {
  if (messages.length === 0) return '';

  const lines: string[] = [];
  let currentDateHeader: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    // Prompt and tool declarations, not conversation.
    if (isSystemMessage(msg)) continue;
    const roleLabel = msg.role;

    // Build the timestamp label from message metadata
    let label: string;
    if (msg.timestamp !== 0) {
      const date = new Date(msg.timestamp);
      const dateHeader = formatDateHeader(date);

      // Insert a date header when the date changes
      if (dateHeader !== currentDateHeader) {
        if (currentDateHeader !== null) {
          lines.push(''); // blank line between date groups
        }
        lines.push(`Date: ${dateHeader}`);
        currentDateHeader = dateHeader;
      }

      label = formatTime(date);
    } else {
      // No timestamp available; use a sequential fallback
      if (currentDateHeader === null) {
        lines.push('Date: (not specified)');
        currentDateHeader = '(not specified)';
      }
      label = `Message ${i + 1}`;
    }

    // Runtime toolResult messages carry the tool name as message metadata;
    // surface it so observations can attribute results to their tools.
    const resultHeader = msg.role === 'toolResult' && typeof msg.toolName === 'string'
      ? `[Tool Result: ${msg.toolName}]\n`
      : '';

    if (typeof msg.content === 'string') {
      lines.push(`**${roleLabel} (${label})**: ${resultHeader}${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      const parts = formatContentParts(msg.content);
      if (parts) {
        lines.push(`**${roleLabel} (${label})**:\n${resultHeader}${parts}`);
      } else {
        lines.push(`**${roleLabel} (${label})**: ${resultHeader || '[empty]'}`);
      }
    } else {
      lines.push(`**${roleLabel} (${label})**: [empty]`);
    }
  }

  return lines.join('\n\n');
}

/**
 * Format a date for the observer date header.
 * Example: "April 11, 2026"
 */
function formatDateHeader(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format a time for a message label.
 * Example: "2:30 PM"
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Format an array of content parts from a structured message.
 *
 * Handles text and toolCall part types (real pi-ai assistant blocks), plus
 * legacy tool_result parts. Other part types are rendered with their type
 * label.
 */
function formatContentParts(
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>,
): string {
  const formatted: string[] = [];

  for (const part of parts) {
    switch (part.type) {
      case 'text': {
        if (typeof part.text === 'string' && part.text.length > 0) {
          formatted.push(part.text);
        }
        break;
      }

      case 'toolCall': {
        const toolName = typeof part['name'] === 'string' ? part['name'] : 'unknown';
        const argsSummary = summarizeToolArgs(part['arguments']);
        formatted.push(`[Tool Call: ${toolName}] ${argsSummary}`);
        break;
      }

      case 'tool_result': {
        const toolUseId = typeof part['tool_use_id'] === 'string'
          ? part['tool_use_id']
          : undefined;
        // Resolve tool name: check for a name field on the part, fall back to tool_use_id reference
        const resultToolName = typeof part['name'] === 'string'
          ? part['name']
          : undefined;

        const header = resultToolName
          ? `[Tool Result: ${resultToolName}]`
          : toolUseId
            ? `[Tool Result (ref: ${toolUseId})]`
            : '[Tool Result]';

        const content = extractToolResultContent(part);
        if (content) {
          formatted.push(`${header}\n${content}`);
        } else {
          formatted.push(header);
        }
        break;
      }

      default: {
        // Unknown part type: include type label and any text
        if (typeof part.text === 'string' && part.text.length > 0) {
          formatted.push(`[${part.type}]: ${part.text}`);
        }
        break;
      }
    }
  }

  return formatted.join('\n');
}

/**
 * Summarize tool call arguments into a brief string.
 *
 * Produces a compact summary of the key arguments without reproducing
 * large values verbatim.
 */
function summarizeToolArgs(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return `{${truncateValue(input, 100)}}`;

  if (typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (entries.length === 0) return '{}';

    const parts = entries.slice(0, 5).map(([key, value]) => {
      return `${key}: ${truncateValue(String(value), 80)}`;
    });
    const suffix = entries.length > 5 ? `, ... (+${entries.length - 5} more)` : '';
    return `{${parts.join(', ')}${suffix}}`;
  }

  return String(input);
}

/**
 * Extract text content from a tool_result part.
 */
function extractToolResultContent(
  part: { type: string; text?: string; [key: string]: unknown },
): string {
  // Direct text field
  if (typeof part.text === 'string' && part.text.length > 0) {
    return part.text;
  }

  // Content may be nested in a 'content' field (some tool result formats)
  const nested = part['content'];
  if (typeof nested === 'string' && nested.length > 0) {
    return nested;
  }

  if (Array.isArray(nested)) {
    const textParts = nested
      .filter((p): p is { type: string; text: string } =>
        typeof p === 'object' && p !== null && typeof p.text === 'string',
      )
      .map(p => p.text);
    if (textParts.length > 0) return textParts.join('\n');
  }

  return '';
}

/**
 * Truncate a string value for argument summaries.
 */
function truncateValue(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + '...';
}

/**
 * Bookend oversized tool results so the observer's input fits
 * `maxInputTokens`. A piece of history is chosen to fit the observer's
 * budget, but one tool-call group is never split, and a single result can
 * be larger than the utility model takes. The observer extracts takeaways,
 * so the head and tail of an oversized result serve it; an input it cannot
 * take would fail every attempt and leave the messages unobservable.
 *
 * Messages are copied, never mutated. Under budget, returns them unchanged.
 */
export function fitMessagesToObserverBudget(messages: AgentMessage[], maxInputTokens: number): AgentMessage[] {
  const total = historyTokens(messages);
  if (total <= maxInputTokens) return messages;
  const resultCount = messages.reduce((count, msg) => count + toolResultTexts(msg), 0);
  if (resultCount === 0) return messages;
  // Results share half the budget; the rest of the conversation keeps the other half.
  const shareTokens = Math.max(500, Math.floor(maxInputTokens / 2 / resultCount));
  const sideChars = shareTokens * 2;
  const bookend = (text: string): string => {
    const tokens = estimateTokens(text);
    return tokens > shareTokens ? applyBookend(text, sideChars, sideChars, tokens) : text;
  };
  return messages.map((msg) => {
    if (msg.role === 'toolResult' && typeof msg.content === 'string') {
      return { ...msg, content: bookend(msg.content) };
    }
    if (!Array.isArray(msg.content) || toolResultTexts(msg) === 0) return msg;
    return {
      ...msg,
      content: msg.content.map((part) =>
        isToolResultText(msg, part) ? { ...part, text: bookend(part.text as string) } : part),
    };
  });
}

/** How many tool-result text parts a message carries. */
function toolResultTexts(msg: AgentMessage): number {
  if (msg.role === 'toolResult' && typeof msg.content === 'string') return 1;
  if (!Array.isArray(msg.content)) return 0;
  return msg.content.filter((part) => isToolResultText(msg, part)).length;
}

function isToolResultText(msg: AgentMessage, part: { type: string; text?: string }): boolean {
  if (typeof part.text !== 'string') return false;
  return part.type === 'tool_result' || (msg.role === 'toolResult' && part.type === 'text');
}

// ---------------------------------------------------------------------------
// Output Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the raw LLM output from the observer.
 *
 * Extracts content from `<observations>`, `<current-task>`, and
 * `<suggested-response>` XML blocks with simple string matching (not a DOM
 * parser). The `<observations>` block is required and must be closed; the
 * hints are optional and lenient. A well-formed but empty block is a valid
 * judgment that the span held nothing worth recording.
 *
 * @throws MemoryReplyError when the reply is empty, has no observations
 *   block, or ends inside it
 */
export function parseObserverOutput(raw: string): ObserverOutput {
  const observations = readObservationsBlock(raw, 'observer');
  const rawTask = extractTagContent(raw, 'current-task');
  const rawSuggested = extractTagContent(raw, 'suggested-response');

  const result: ObserverOutput = { observations };

  const trimmedTask = rawTask?.trim();
  if (trimmedTask && hasMeaningfulContent(trimmedTask)) {
    result.currentTask = trimmedTask;
  }

  const trimmedSuggested = rawSuggested?.trim();
  if (trimmedSuggested && hasMeaningfulContent(trimmedSuggested)) {
    result.suggestedResponse = trimmedSuggested;
  }

  return result;
}

/**
 * Check whether extracted tag content is meaningful (not just placeholder
 * labels echoed from the prompt template).
 *
 * The observer prompt shows a structure like "- Primary:" and "- Secondary:"
 * as a template. Some model outputs echo the template without filling in
 * real content. This check rejects such outputs so the caller can fall back
 * to prior hints or mark the field as missing.
 */
function hasMeaningfulContent(value: string): boolean {
  const contentOnly = value
    .split('\n')
    .map(line =>
      line
        .replace(/^\s*[-*]\s*/, '')
        .replace(/^Primary\s*:\s*/i, '')
        .replace(/^Secondary\s*:\s*/i, '')
        .trim(),
    )
    .filter(line => line.length > 0)
    .join(' ')
    .trim();

  return contentOnly.length >= 8;
}

/**
 * Extract content between XML-style tags.
 *
 * Lenient: handles whitespace around tags, multiline content, and
 * nested content. Returns null if the tag pair is not found.
 */
function extractTagContent(text: string, tagName: string): string | null {
  const openPattern = new RegExp(`<${tagName}>`, 'i');
  const closePattern = new RegExp(`</${tagName}>`, 'i');

  const openMatch = openPattern.exec(text);
  if (!openMatch) return null;

  const startIndex = openMatch.index + openMatch[0].length;
  const closeMatch = closePattern.exec(text.slice(startIndex));

  if (!closeMatch) {
    // Opening tag found but no closing tag: return everything after the opening tag
    return text.slice(startIndex);
  }

  return text.slice(startIndex, startIndex + closeMatch.index);
}

// ---------------------------------------------------------------------------
// Prompt Building
// ---------------------------------------------------------------------------

/**
 * Build the full observer system prompt.
 *
 * Starts with `OBSERVER_SYSTEM_PROMPT` from constants and optionally
 * appends consumer-provided custom instructions.
 *
 * @param previousObservations - Previous observations for context (unused in system prompt, kept for signature consistency)
 * @param previousObserverTokens - Token budget for previous observations (unused in system prompt)
 * @param customInstruction - Optional consumer-provided instruction to append
 * @returns The complete system prompt string
 */
export function buildObserverPrompt(
  previousObservations: string | null,
  previousObserverTokens: number,
  customInstruction?: string,
): string {
  let prompt = OBSERVER_SYSTEM_PROMPT;

  if (customInstruction) {
    prompt += `\n\n## Additional Instructions\n\n${customInstruction}`;
  }

  return prompt;
}

/**
 * Build the message array to send to the observer LLM.
 *
 * Constructs a sequence of user messages:
 * 1. (Optional) Previous observations for deduplication context
 * 2. The formatted message history
 * 3. A task instruction to extract observations
 *
 * @param messages - The conversation messages to observe
 * @param previousObservations - Previous observations to prevent duplication
 * @param previousObserverTokens - Token budget for the previous observations context
 * @returns Array of message objects for the LLM call
 */
export function buildObserverMessages(
  messages: AgentMessage[],
  previousObservations: string | null,
  previousObserverTokens: number,
): unknown[] {
  const result: Array<{ role: string; content: string }> = [];

  // 1. Previous observations context (if available)
  if (previousObservations && previousObservations.trim().length > 0) {
    const preamble =
      'These are the observations that have already been captured. Do not repeat them. Only add NEW observations from the messages below.\n\n';
    const truncated = tailTruncateToTokenBudget(previousObservations, previousObserverTokens);
    result.push({ role: 'user', content: preamble + truncated });
  }

  // 2. Formatted message history (timestamps from message metadata)
  const formatted = formatMessagesForObserver(messages);
  result.push({ role: 'user', content: formatted });

  // 3. Task instruction
  result.push({
    role: 'user',
    content: 'Extract observations from the message history above. Follow the output format exactly.',
  });

  return result;
}

/**
 * Tail-truncate a string to fit within a token budget.
 *
 * Keeps the end of the string (most recent observations) and trims
 * from the beginning if the string exceeds the budget.
 */
function tailTruncateToTokenBudget(text: string, tokenBudget: number): string {
  const currentTokens = estimateTokens(text);
  if (currentTokens <= tokenBudget) return text;

  // Estimate chars to keep (tokens * 4 chars/token approximation)
  const charsToKeep = tokenBudget * 4;
  if (charsToKeep >= text.length) return text;

  const truncated = text.slice(text.length - charsToKeep);

  // Try to start at a line boundary for cleaner output
  const firstNewline = truncated.indexOf('\n');
  if (firstNewline > 0 && firstNewline < truncated.length * 0.2) {
    return '[...truncated...]\n' + truncated.slice(firstNewline + 1);
  }

  return '[...truncated...]\n' + truncated;
}

// ---------------------------------------------------------------------------
// Degenerate Repetition Detection
// ---------------------------------------------------------------------------

/**
 * Check if the output contains degenerate repetition.
 *
 * Detects a line appearing 5+ times consecutively, which is a known
 * failure mode of LLMs under certain conditions (e.g., high temperature,
 * long context, repetitive input patterns).
 *
 * @param text - The text to check for repetition
 * @returns true if degenerate repetition is detected
 */
export function detectDegenerateRepetition(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 5) return false;

  let consecutiveCount = 1;
  let previousLine = lines[0]!;

  for (let i = 1; i < lines.length; i++) {
    const currentLine = lines[i]!;
    // Skip empty lines for comparison
    if (currentLine.trim() === '' && previousLine.trim() === '') {
      continue;
    }

    if (currentLine === previousLine && currentLine.trim().length > 0) {
      consecutiveCount++;
      if (consecutiveCount >= 5) return true;
    } else {
      consecutiveCount = 1;
      previousLine = currentLine;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the observer LLM call to extract observations from messages.
 *
 * Orchestrates the full observer pipeline:
 * 1. Builds the system prompt (with optional custom instructions)
 * 2. Builds the message array (with previous observations context)
 * 3. Calls the LLM via `complete`, under `call.policy`
 * 4. Parses the structured output; an unusable reply or degenerate
 *    repetition fails the attempt, which the policy may retry
 *
 * @param complete - The LLM completion function
 * @param messages - The conversation messages to observe
 * @param previousObservations - Previous observations for deduplication
 * @param config - Observer configuration
 * @param call - Retry and timeout policy (default: one attempt, no
 *   timeout) and the signal that cancels the whole call
 * @returns Parsed observer output with observations, current task, and suggested response
 * @throws MemoryCallError when no attempt produced a usable reply
 */
export async function runObserver(
  complete: CompleteFn,
  messages: AgentMessage[],
  previousObservations: string | null,
  config: {
    previousObserverTokens: number;
    observerInstruction?: string;
    /** Bound on the observed messages' size (see fitMessagesToObserverBudget). */
    maxInputTokens?: number;
  },
  call: { policy?: CallPolicy; signal?: AbortSignal } = {},
): Promise<ObserverOutput> {
  const systemPrompt = buildObserverPrompt(
    previousObservations,
    config.previousObserverTokens,
    config.observerInstruction,
  );

  const observerMessages = buildObserverMessages(
    config.maxInputTokens !== undefined
      ? fitMessagesToObserverBudget(messages, config.maxInputTokens)
      : messages,
    previousObservations,
    config.previousObserverTokens,
  );

  return callWithPolicy(async (signal) => {
    const raw = await complete({ systemPrompt, messages: observerMessages }, { purpose: 'observer', signal });
    const output = parseObserverOutput(raw);
    if (detectDegenerateRepetition(output.observations)) {
      throw new MemoryReplyError('repetitive', 'The observer reply repeats one line over and over');
    }
    return output;
  }, call.policy ?? SINGLE_ATTEMPT, call.signal);
}
