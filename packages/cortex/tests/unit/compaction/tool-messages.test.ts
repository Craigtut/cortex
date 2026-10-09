/**
 * Reading tool activity out of transcript messages.
 */
import { describe, it, expect } from 'vitest';
import {
  extractTextContent,
  isToolResultMessage,
  isToolCallMessage,
  extractToolName,
} from '../../../src/compaction/tool-messages.js';
import type { AgentMessage } from '../../../src/context-manager.js';
import {
  makeUserMsg,
  makeAssistantMsg,
  makeToolCallMsg,
  makeToolResultMsg,
} from './helpers.js';
import { restoredMessage } from '../../helpers/messages.js';

let seq = 0;

/** Real runtime tool result message with an auto-generated call id. */
function makeToolResult(content: string, toolName = 'Read'): AgentMessage {
  return makeToolResultMsg(`call_r${++seq}`, toolName, content);
}

/** Real assistant message with a single toolCall block. */
function makeToolCall(toolName: string): AgentMessage {
  return makeToolCallMsg([{ id: `call_c${++seq}`, name: toolName }]);
}

describe('extractTextContent', () => {
  it('extracts from string content', () => {
    expect(extractTextContent(makeUserMsg('hello world'))).toBe('hello world');
  });

  it('extracts from content array with text parts', () => {
    const msg: AgentMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'part1' },
        { type: 'text', text: 'part2' },
      ],
      timestamp: 0,
    };
    expect(extractTextContent(msg)).toBe('part1\npart2');
  });

  it('extracts text from legacy tool_result parts', () => {
    const msg = restoredMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_result', text: 'result' },
      ],
      timestamp: 0,
    });
    expect(extractTextContent(msg)).toBe('hello\nresult');
  });

  it('renders toolCall blocks with tool name and arguments', () => {
    const msg = makeToolCallMsg(
      [{ id: 'call_1', name: 'Grep', arguments: { pattern: 'handleAuth', path: '/src' } }],
      'Searching now.',
    );
    const text = extractTextContent(msg);
    expect(text).toContain('Searching now.');
    expect(text).toContain('[Tool call: Grep');
    expect(text).toContain('handleAuth');
    expect(text).toContain('/src');
  });

  it('renders a pure tool-call turn as non-empty', () => {
    const msg = makeToolCallMsg([
      { id: 'call_1', name: 'Read', arguments: { path: '/a.ts' } },
      { id: 'call_2', name: 'Bash', arguments: { command: 'npm test' } },
    ]);
    const text = extractTextContent(msg);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('[Tool call: Read');
    expect(text).toContain('[Tool call: Bash');
    expect(text).toContain('npm test');
  });

  it('includes full tool call arguments (not a truncated summary)', () => {
    const bigArg = 'z'.repeat(5_000);
    const msg = makeToolCallMsg([
      { id: 'call_1', name: 'Write', arguments: { path: '/f.txt', content: bigArg } },
    ]);
    const text = extractTextContent(msg);
    expect(text).toContain(bigArg);
  });

  it('renders a toolCall with empty arguments without trailing args', () => {
    const msg = makeToolCallMsg([{ id: 'call_1', name: 'Glob' }]);
    expect(extractTextContent(msg)).toBe('[Tool call: Glob]');
  });
});

describe('isToolResultMessage', () => {
  it('returns true for runtime toolResult messages', () => {
    expect(isToolResultMessage(makeToolResult('result', 'Read'))).toBe(true);
  });

  it('returns true for legacy tool_result content parts', () => {
    const msg = restoredMessage({
      role: 'user',
      content: [{ type: 'tool_result', text: 'result' }],
      timestamp: 0,
    });
    expect(isToolResultMessage(msg)).toBe(true);
  });

  it('returns false for string content messages', () => {
    expect(isToolResultMessage(makeUserMsg('hello'))).toBe(false);
  });

  it('returns false for content arrays without tool_result type', () => {
    const msg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      timestamp: 0,
    };
    expect(isToolResultMessage(msg)).toBe(false);
  });
});

describe('isToolCallMessage', () => {
  it('returns true for assistant messages with toolCall blocks', () => {
    expect(isToolCallMessage(makeToolCall('Read'))).toBe(true);
  });

  it('returns true when toolCall blocks are mixed with text', () => {
    const msg = makeToolCallMsg([{ id: 'call_1', name: 'Read' }], 'Let me check.');
    expect(isToolCallMessage(msg)).toBe(true);
  });

  it('returns false for user messages', () => {
    expect(isToolCallMessage(makeUserMsg('hello'))).toBe(false);
  });

  it('returns false for assistant messages without toolCall blocks', () => {
    expect(isToolCallMessage(makeAssistantMsg('thinking'))).toBe(false);
  });

  it('regression: the wrong Anthropic-style tool_use key is NOT a pi toolCall', () => {
    // Real pi-ai assistant blocks are typed 'toolCall'. Keying on 'tool_use'
    // made the structural-pair guard never fire (C-5/H-5).
    const msg = restoredMessage({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
      timestamp: 0,
    });
    expect(isToolCallMessage(msg)).toBe(false);
  });
});

describe('extractToolName', () => {
  it('extracts name from toolCall blocks', () => {
    expect(extractToolName(makeToolCall('Read'))).toBe('Read');
  });

  it('extracts name from runtime toolResult message metadata', () => {
    expect(extractToolName(makeToolResult('content', 'Bash'))).toBe('Bash');
  });

  it('extracts name from legacy tool_result parts with a name field', () => {
    const msg = restoredMessage({
      role: 'user',
      content: [{ type: 'tool_result', text: 'content', name: 'Glob' }],
      timestamp: 0,
    });
    expect(extractToolName(msg)).toBe('Glob');
  });

  it('returns null for string content messages', () => {
    expect(extractToolName(makeUserMsg('hello'))).toBeNull();
  });
});
