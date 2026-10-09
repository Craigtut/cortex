import { describe, it, expect, vi } from 'vitest';
import {
  formatMessagesForObserver,
  parseObserverOutput,
  buildObserverPrompt,
  buildObserverMessages,
  detectDegenerateRepetition,
  runObserver,
} from '../../../../src/compaction/observational/observer.js';
import { OBSERVER_SYSTEM_PROMPT } from '../../../../src/compaction/observational/constants.js';
import { MemoryReplyError } from '../../../../src/compaction/observational/reply.js';
import type { CompleteFn } from '../../../../src/compaction/compaction.js';
import type { AgentMessage } from '../../../../src/context-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });
const assistantMsg = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: 0 });

// Real pi-ai shapes: assistant 'toolCall' blocks with `arguments`, and tool
// results as separate role 'toolResult' messages with toolCallId/toolName.
function makeToolCallMsg(name: string): AgentMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'call_123', name, arguments: { path: '/tmp/test.txt' } },
    ],
    timestamp: 0,
  } as AgentMessage;
}

function makeToolResultMsg(text: string, toolName = 'Read'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call_123',
    toolName,
    content: [
      { type: 'text', text },
    ],
    isError: false,
    timestamp: 0,
  } as AgentMessage;
}

const VALID_OBSERVER_OUTPUT =
  '<observations>\nDate: Apr 10, 2026\n\n* \u{1F534} (14:30) Test observation\n</observations>\n\n' +
  '<current-task>\n- Primary: Writing tests\n</current-task>\n\n' +
  '<suggested-response>\nContinue with the next test file.\n</suggested-response>';

// ---------------------------------------------------------------------------
// Tests: formatMessagesForObserver
// ---------------------------------------------------------------------------

describe('formatMessagesForObserver', () => {
  it('formats string content messages with role and label', () => {
    const messages = [userMsg('Hello'), assistantMsg('Hi there')];
    const result = formatMessagesForObserver(messages);

    expect(result).toContain('**user (Message 1)**: Hello');
    expect(result).toContain('**assistant (Message 2)**: Hi there');
  });

  it('formats assistant toolCall blocks with tool name and summarized arguments', () => {
    const messages = [makeToolCallMsg('Read')];
    const result = formatMessagesForObserver(messages);

    expect(result).toContain('[Tool Call: Read]');
    expect(result).toContain('path:');
    expect(result).toContain('/tmp/test.txt');
  });

  it('formats runtime toolResult messages with their tool name', () => {
    const messages = [makeToolResultMsg('file contents here', 'Read')];
    const result = formatMessagesForObserver(messages);

    expect(result).toContain('[Tool Result: Read]');
    expect(result).toContain('file contents here');
  });

  it('formats legacy tool_result content parts', () => {
    const legacy: AgentMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_123', text: 'legacy output' },
      ],
      timestamp: 0,
    } as AgentMessage;
    const result = formatMessagesForObserver([legacy]);

    expect(result).toContain('[Tool Result');
    expect(result).toContain('legacy output');
  });

  it('returns empty string for empty messages array', () => {
    expect(formatMessagesForObserver([])).toBe('');
  });

  it('handles messages with empty content array', () => {
    const msg: AgentMessage = { role: 'user', content: [] as unknown[] } as AgentMessage;
    const result = formatMessagesForObserver([msg]);
    expect(result).toContain('[empty]');
  });

  it('separates messages with double newlines', () => {
    const messages = [userMsg('First'), userMsg('Second'), userMsg('Third')];
    const result = formatMessagesForObserver(messages);

    const parts = result.split('\n\n');
    // 4 parts: date header + 3 messages (messages without timestamps get a fallback date header)
    expect(parts.length).toBe(4);
    expect(parts[0]).toContain('Date:');
  });

  it('uses real timestamps from messages', () => {
    const ts = new Date('2026-04-11T14:30:00Z').getTime();
    const messages: AgentMessage[] = [
      { role: 'user', content: 'Hello', timestamp: ts },
      { role: 'assistant', content: 'Hi there', timestamp: ts + 60_000 },
    ];
    const result = formatMessagesForObserver(messages);

    expect(result).toContain('Date: April 11, 2026');
    expect(result).not.toContain('Message 1');
  });

  it('groups messages by date when timestamps span multiple days', () => {
    const day1 = new Date('2026-04-10T10:00:00Z').getTime();
    const day2 = new Date('2026-04-11T14:00:00Z').getTime();
    const messages: AgentMessage[] = [
      { role: 'user', content: 'Day one', timestamp: day1 },
      { role: 'user', content: 'Day two', timestamp: day2 },
    ];
    const result = formatMessagesForObserver(messages);

    expect(result).toContain('Date: April 10, 2026');
    expect(result).toContain('Date: April 11, 2026');
  });
});

// ---------------------------------------------------------------------------
// Tests: parseObserverOutput
// ---------------------------------------------------------------------------

describe('parseObserverOutput', () => {
  it('extracts observations from XML tags', () => {
    const result = parseObserverOutput(VALID_OBSERVER_OUTPUT);
    expect(result.observations).toContain('Test observation');
    expect(result.observations).toContain('Date: Apr 10, 2026');
  });

  it('extracts current-task', () => {
    const result = parseObserverOutput(VALID_OBSERVER_OUTPUT);
    expect(result.currentTask).toContain('Writing tests');
  });

  it('extracts suggested-response', () => {
    const result = parseObserverOutput(VALID_OBSERVER_OUTPUT);
    expect(result.suggestedResponse).toContain('Continue with the next test file.');
  });

  it('rejects output with no observations tag', () => {
    expect(() => parseObserverOutput('Just some plain text output without tags')).toThrow(MemoryReplyError);
  });

  it('omits currentTask and suggestedResponse when tags are missing', () => {
    const raw = '<observations>\nSome observations\n</observations>';
    const result = parseObserverOutput(raw);
    expect(result.observations).toBe('Some observations');
    expect(result.currentTask).toBeUndefined();
    expect(result.suggestedResponse).toBeUndefined();
  });

  it('rejects empty output', () => {
    expect(() => parseObserverOutput('')).toThrow(MemoryReplyError);
  });

  it('omits currentTask when tag content is empty whitespace', () => {
    const raw = '<observations>\nObs\n</observations>\n<current-task>\n  \n</current-task>';
    const result = parseObserverOutput(raw);
    expect(result.currentTask).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: buildObserverPrompt
// ---------------------------------------------------------------------------

describe('buildObserverPrompt', () => {
  it('includes the base observer system prompt', () => {
    const prompt = buildObserverPrompt(null, 2000);
    expect(prompt).toBe(OBSERVER_SYSTEM_PROMPT);
  });

  it('appends custom instructions when provided', () => {
    const prompt = buildObserverPrompt(null, 2000, 'Focus on code changes');
    expect(prompt).toContain(OBSERVER_SYSTEM_PROMPT);
    expect(prompt).toContain('## Additional Instructions');
    expect(prompt).toContain('Focus on code changes');
  });

  it('does not append additional instructions section when no custom instruction', () => {
    const prompt = buildObserverPrompt('existing obs', 2000);
    expect(prompt).not.toContain('## Additional Instructions');
  });
});

// ---------------------------------------------------------------------------
// Tests: buildObserverMessages
// ---------------------------------------------------------------------------

describe('buildObserverMessages', () => {
  it('includes previous observations with dedup preamble when provided', () => {
    const messages = [userMsg('Hello')];
    const result = buildObserverMessages(messages, 'Previous obs here', 2000);

    expect(result.length).toBe(3);
    const first = result[0] as { role: string; content: string };
    expect(first.content).toContain('already been captured');
    expect(first.content).toContain('Previous obs here');
  });

  it('omits previous observations message when null', () => {
    const messages = [userMsg('Hello')];
    const result = buildObserverMessages(messages, null, 2000);

    // Should be 2 messages: formatted history + task instruction
    expect(result.length).toBe(2);
  });

  it('omits previous observations message when empty string', () => {
    const messages = [userMsg('Hello')];
    const result = buildObserverMessages(messages, '  ', 2000);

    expect(result.length).toBe(2);
  });

  it('includes formatted messages as a user message', () => {
    const messages = [userMsg('Hello'), assistantMsg('World')];
    const result = buildObserverMessages(messages, null, 2000);

    const formatted = result[0] as { role: string; content: string };
    expect(formatted.role).toBe('user');
    expect(formatted.content).toContain('Hello');
    expect(formatted.content).toContain('World');
  });

  it('includes task instruction as the last message', () => {
    const messages = [userMsg('Hello')];
    const result = buildObserverMessages(messages, null, 2000);

    const last = result[result.length - 1] as { role: string; content: string };
    expect(last.content).toContain('Extract observations');
  });

  it('truncates previous observations to token budget', () => {
    // Create observations that exceed the budget
    const longObs = 'x'.repeat(50_000); // ~12500 tokens at 4 chars/token
    const messages = [userMsg('Hello')];
    const result = buildObserverMessages(messages, longObs, 500); // 500 token budget

    const first = result[0] as { role: string; content: string };
    // Should contain truncation marker
    expect(first.content).toContain('[...truncated...]');
    // Should be much shorter than the original
    expect(first.content.length).toBeLessThan(longObs.length);
  });
});

// ---------------------------------------------------------------------------
// Tests: detectDegenerateRepetition
// ---------------------------------------------------------------------------

describe('detectDegenerateRepetition', () => {
  it('detects 5+ consecutive repeated lines', () => {
    const text = 'line A\nline A\nline A\nline A\nline A';
    expect(detectDegenerateRepetition(text)).toBe(true);
  });

  it('detects repetition even with more than 5 repeats', () => {
    const text = Array(10).fill('repeated line').join('\n');
    expect(detectDegenerateRepetition(text)).toBe(true);
  });

  it('returns false for normal text', () => {
    const text = 'line 1\nline 2\nline 3\nline 4\nline 5';
    expect(detectDegenerateRepetition(text)).toBe(false);
  });

  it('returns false for text with fewer than 5 lines', () => {
    const text = 'a\na\na';
    expect(detectDegenerateRepetition(text)).toBe(false);
  });

  it('ignores empty lines when checking for repetition', () => {
    const text = 'line A\n\n\n\n\nline B';
    expect(detectDegenerateRepetition(text)).toBe(false);
  });

  it('returns false for text with 4 consecutive repeated lines (below threshold)', () => {
    const text = 'unique\nline A\nline A\nline A\nline A\ndifferent';
    expect(detectDegenerateRepetition(text)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(detectDegenerateRepetition('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: runObserver
// ---------------------------------------------------------------------------

describe('runObserver', () => {
  it('calls complete with correct prompt structure and parses output', async () => {
    const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(VALID_OBSERVER_OUTPUT);

    const result = await runObserver(
      mockComplete,
      [userMsg('Hello'), assistantMsg('Hi')],
      null,
      { previousObserverTokens: 2000 },
    );

    expect(mockComplete).toHaveBeenCalledOnce();
    const callArgs = mockComplete.mock.calls[0]![0];
    expect(callArgs).toHaveProperty('systemPrompt');
    expect(callArgs).toHaveProperty('messages');
    expect(callArgs.systemPrompt).toContain('memory consciousness');

    expect(result.observations).toContain('Test observation');
    expect(result.currentTask).toContain('Writing tests');
    expect(result.suggestedResponse).toContain('Continue');
  });

  it('retries on degenerate repetition', async () => {
    const degenerateOutput =
      '<observations>\nrepeated\nrepeated\nrepeated\nrepeated\nrepeated\n</observations>';
    const goodOutput =
      '<observations>\nDate: Apr 10, 2026\n\n* \u{1F7E1} (10:00) Good observation\n</observations>';

    const mockComplete = vi.fn<CompleteFn>()
      .mockResolvedValueOnce(degenerateOutput)
      .mockResolvedValueOnce(goodOutput);

    const result = await runObserver(
      mockComplete,
      [userMsg('Hello')],
      null,
      { previousObserverTokens: 2000 },
    );

    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(result.observations).toContain('Good observation');
  });

  it('passes custom instruction through to the prompt', async () => {
    const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(
      '<observations>\ntest\n</observations>',
    );

    await runObserver(
      mockComplete,
      [userMsg('Hello')],
      null,
      { previousObserverTokens: 2000, observerInstruction: 'Focus on errors' },
    );

    const callArgs = mockComplete.mock.calls[0]![0];
    expect(callArgs.systemPrompt).toContain('Focus on errors');
  });

  it('includes previous observations in messages for deduplication', async () => {
    const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(
      '<observations>\nnew obs\n</observations>',
    );

    await runObserver(
      mockComplete,
      [userMsg('Hello')],
      'Previous observations text',
      { previousObserverTokens: 2000 },
    );

    const callArgs = mockComplete.mock.calls[0]![0];
    const messages = callArgs.messages as Array<{ role: string; content: string }>;
    const hasDedup = messages.some((m) => m.content.includes('Previous observations text'));
    expect(hasDedup).toBe(true);
  });
});
