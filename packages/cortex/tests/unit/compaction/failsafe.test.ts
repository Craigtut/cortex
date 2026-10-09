import { describe, it, expect } from 'vitest';
import {
  emergencyTruncate,
  shouldTruncate,
  isContextOverflow,
} from '../../../src/compaction/failsafe.js';
import type { AgentMessage } from '../../../src/context-manager.js';
import {
  makeUserMsg,
  makeAssistantMsg,
  makeToolCallMsg,
  makeToolResultMsg,
  assertNoOrphans,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a history that will use approximately targetTokens in total.
 * Each message is padded with words to reach the target.
 */
function buildLargeHistory(messageCount: number, wordsPerMessage: number): AgentMessage[] {
  const history: AgentMessage[] = [];
  for (let i = 0; i < messageCount; i++) {
    const words: string[] = [];
    for (let w = 0; w < wordsPerMessage; w++) {
      words.push(`word${w}`);
    }
    const content = words.join(' ');
    history.push(i % 2 === 0 ? makeUserMsg(content) : makeAssistantMsg(content));
  }
  return history;
}

/** A single-call group: assistant toolCall message + its toolResult message. */
function makeGroup(id: string, toolName: string, resultText: string): AgentMessage[] {
  return [
    makeToolCallMsg([{ id, name: toolName, arguments: { path: '/tmp/file.txt' } }]),
    makeToolResultMsg(id, toolName, resultText),
  ];
}

// ---------------------------------------------------------------------------
// Tests: shouldTruncate
// ---------------------------------------------------------------------------

describe('shouldTruncate', () => {
  it('returns true when usage exceeds threshold', () => {
    expect(shouldTruncate(95_000, 100_000, 0.90)).toBe(true);
  });

  it('returns false when usage is below threshold', () => {
    expect(shouldTruncate(80_000, 100_000, 0.90)).toBe(false);
  });

  it('returns true at exactly the threshold', () => {
    expect(shouldTruncate(90_000, 100_000, 0.90)).toBe(true);
  });

  it('returns false when contextWindow is 0', () => {
    expect(shouldTruncate(100, 0, 0.90)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: emergencyTruncate
// ---------------------------------------------------------------------------

describe('emergencyTruncate', () => {
  it('preserves the last 3 turns', () => {
    const history: AgentMessage[] = [
      makeUserMsg('old1'),
      makeAssistantMsg('old2'),
      makeUserMsg('old3'),
      makeAssistantMsg('old4'),
      makeUserMsg('recent1'),
      makeAssistantMsg('recent2'),
      makeUserMsg('recent3'),
    ];

    // Force truncation by using a small context window
    const result = emergencyTruncate(history, 100, 0, 0.01);

    // Last 3 messages should always be preserved
    expect(result.newHistory.length).toBeGreaterThanOrEqual(3);
    const last3 = result.newHistory.slice(-3);
    expect(last3).toEqual(history.slice(-3));
  });

  it('drops oldest turns first', () => {
    // 10 messages, 200 words each = ~260 tokens each = ~2600 total
    // With contextWindow=500 and threshold=0.10, target=50 tokens
    // This forces aggressive truncation
    const history = buildLargeHistory(10, 200);

    const result = emergencyTruncate(history, 500, 0, 0.10);

    // Some turns should have been removed
    expect(result.turnsRemoved).toBeGreaterThan(0);
    expect(result.newHistory.length).toBeLessThan(history.length);

    // The remaining messages should be the tail of the original
    const lastMessages = history.slice(-result.newHistory.length);
    expect(result.newHistory).toEqual(lastMessages);
  });

  it('drops a toolCall message and its toolResult together', () => {
    const history: AgentMessage[] = [
      ...makeGroup('call_1', 'Read', 'file content'),  // 0, 1
      makeAssistantMsg('analysis'),                    // 2
      makeUserMsg('recent1'),                          // 3
      makeAssistantMsg('recent2'),                     // 4
      makeUserMsg('recent3'),                          // 5
    ];

    // Force truncation
    const result = emergencyTruncate(history, 100, 0, 0.01);

    // The toolCall and toolResult should both be dropped or both preserved
    const hasToolCall = result.newHistory.some(m =>
      m.role === 'assistant' && Array.isArray(m.content) &&
      m.content.some(p => p.type === 'toolCall'),
    );
    const hasToolResult = result.newHistory.some(m => m.role === 'toolResult');

    expect(hasToolCall).toBe(hasToolResult);
    assertNoOrphans(result.newHistory);
  });

  it('drops an N-parallel-call group atomically (one assistant message, N toolResults)', () => {
    const parallel = makeToolCallMsg([
      { id: 'call_a', name: 'Read', arguments: { path: '/a.ts' } },
      { id: 'call_b', name: 'Grep', arguments: { pattern: 'foo' } },
      { id: 'call_c', name: 'Bash', arguments: { command: 'ls' } },
    ], 'Running three tools in parallel.');
    const history: AgentMessage[] = [
      makeUserMsg('old request ' + 'x'.repeat(400)),
      parallel,                                          // 1
      makeToolResultMsg('call_a', 'Read', 'contents of a ' + 'y'.repeat(400)),
      makeToolResultMsg('call_b', 'Grep', 'three matches ' + 'y'.repeat(400)),
      makeToolResultMsg('call_c', 'Bash', 'dir listing ' + 'y'.repeat(400)),
      makeAssistantMsg('done with old work'),
      makeUserMsg('recent1'),
      makeAssistantMsg('recent2'),
      makeUserMsg('recent3'),
    ];

    const result = emergencyTruncate(history, 100, 0, 0.01);

    // The whole group (1 assistant message + 3 results) must vanish together
    expect(result.turnsRemoved).toBeGreaterThan(0);
    const remainingResults = result.newHistory.filter(m => m.role === 'toolResult');
    const remainingCalls = result.newHistory.filter(m =>
      Array.isArray(m.content) && m.content.some(p => p.type === 'toolCall'),
    );
    if (remainingCalls.length === 0) {
      expect(remainingResults.length).toBe(0);
    } else {
      expect(remainingResults.length).toBe(3);
    }
    assertNoOrphans(result.newHistory);
  });

  it('keeps a group intact when it straddles the preserved tail boundary', () => {
    // Group occupies indices 2..5; preserveFrom = 7 - 3 = 4, so the group
    // straddles the boundary. It must be kept whole, not split.
    const history: AgentMessage[] = [
      makeUserMsg('old ' + 'x'.repeat(2_000)),                     // 0
      makeAssistantMsg('old answer ' + 'x'.repeat(2_000)),         // 1
      makeToolCallMsg([
        { id: 'call_a', name: 'Read', arguments: { path: '/a' } },
        { id: 'call_b', name: 'Read', arguments: { path: '/b' } },
        { id: 'call_c', name: 'Read', arguments: { path: '/c' } },
      ]),                                                          // 2
      makeToolResultMsg('call_a', 'Read', 'aaa'),                  // 3
      makeToolResultMsg('call_b', 'Read', 'bbb'),                  // 4 (preserveFrom)
      makeToolResultMsg('call_c', 'Read', 'ccc'),                  // 5
      makeAssistantMsg('most recent'),                             // 6
    ];

    const result = emergencyTruncate(history, 100, 0, 0.01);

    // Indices 0 and 1 are droppable; the group must survive intact.
    const calls = result.newHistory.filter(m =>
      Array.isArray(m.content) && m.content.some(p => p.type === 'toolCall'),
    );
    const results = result.newHistory.filter(m => m.role === 'toolResult');
    expect(calls.length).toBe(1);
    expect(results.length).toBe(3);
    assertNoOrphans(result.newHistory);
  });

  it('never emits orphaned tool calls or results across truncation pressures', () => {
    const history: AgentMessage[] = [
      makeUserMsg('start ' + 'x'.repeat(200)),
      ...makeGroup('call_1', 'Read', 'r1 ' + 'x'.repeat(200)),
      makeAssistantMsg('thoughts ' + 'x'.repeat(200)),
      makeToolCallMsg([
        { id: 'call_2', name: 'Grep', arguments: { pattern: 'a' } },
        { id: 'call_3', name: 'Glob', arguments: { pattern: '*.ts' } },
      ]),
      makeToolResultMsg('call_2', 'Grep', 'matches ' + 'x'.repeat(200)),
      makeToolResultMsg('call_3', 'Glob', 'files ' + 'x'.repeat(200)),
      makeUserMsg('follow-up ' + 'x'.repeat(200)),
      ...makeGroup('call_4', 'Bash', 'output ' + 'x'.repeat(200)),
      makeAssistantMsg('answer ' + 'x'.repeat(200)),
      makeUserMsg('latest'),
    ];

    // Sweep thresholds from "drop nothing" to "drop everything droppable"
    for (const threshold of [0.9, 0.5, 0.3, 0.2, 0.1, 0.05, 0.01]) {
      const result = emergencyTruncate(history, 1_000, 0, threshold);
      assertNoOrphans(result.newHistory);
    }
  });

  it('returns unchanged history when already below threshold', () => {
    const history: AgentMessage[] = [
      makeUserMsg('hello'),
      makeAssistantMsg('hi'),
    ];

    // Huge context window, should not truncate
    const result = emergencyTruncate(history, 1_000_000, 0, 0.90);

    expect(result.turnsRemoved).toBe(0);
    expect(result.newHistory).toEqual(history);
  });

  it('returns empty array for empty history', () => {
    const result = emergencyTruncate([], 100, 0, 0.90);

    expect(result.newHistory).toEqual([]);
    expect(result.turnsRemoved).toBe(0);
  });

  it('reports correct turnsRemoved count', () => {
    const history = buildLargeHistory(20, 100);

    const result = emergencyTruncate(history, 500, 0, 0.90);

    expect(result.turnsRemoved).toBe(
      history.length - result.newHistory.length,
    );
  });

  it('reports tokensAfter correctly', () => {
    const history = buildLargeHistory(10, 50);

    const result = emergencyTruncate(history, 500, 100, 0.90);

    // tokensAfter should include the slot tokens
    expect(result.tokensAfter).toBeGreaterThanOrEqual(100);
    // tokensAfter should be less than contextWindow * threshold if truncation happened
    if (result.turnsRemoved > 0) {
      expect(result.tokensAfter).toBeLessThanOrEqual(500 * 0.90 + 100);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: isContextOverflow
// ---------------------------------------------------------------------------

describe('isContextOverflow', () => {
  it('detects context_length_exceeded', () => {
    expect(isContextOverflow(new Error('context_length_exceeded'))).toBe(true);
  });

  it('detects "context window" error', () => {
    expect(isContextOverflow(new Error('Exceeded context window limit'))).toBe(true);
  });

  it('detects "maximum context length"', () => {
    expect(isContextOverflow(new Error('maximum context length exceeded'))).toBe(true);
  });

  it('detects "token limit"', () => {
    expect(isContextOverflow(new Error('token limit exceeded'))).toBe(true);
  });

  it('detects "too many tokens"', () => {
    expect(isContextOverflow(new Error('Request has too many tokens'))).toBe(true);
  });

  it('detects "request too large"', () => {
    expect(isContextOverflow(new Error('request too large'))).toBe(true);
  });

  it('detects "prompt is too long"', () => {
    expect(isContextOverflow(new Error('prompt is too long'))).toBe(true);
  });

  it('detects "input too long"', () => {
    expect(isContextOverflow(new Error('input too long for this model'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isContextOverflow(new Error('connection refused'))).toBe(false);
    expect(isContextOverflow(new Error('invalid API key'))).toBe(false);
    expect(isContextOverflow(new Error('rate limited'))).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isContextOverflow(new Error('CONTEXT_LENGTH_EXCEEDED'))).toBe(true);
    expect(isContextOverflow(new Error('Token Limit Exceeded'))).toBe(true);
  });

  // Bedrock reports a tokens-per-minute throttle as "Too many tokens, please
  // wait before trying again." pi-ai's formatBedrockError prefixes it
  // "Throttling error:"; the raw SDK name is "ThrottlingException". Waiting
  // fixes it; dropping history does not.
  it('does not treat throttling or rate limits that mention too many tokens as overflow', () => {
    // Precondition: the phrase alone is an overflow signal.
    expect(isContextOverflow(new Error('Request has too many tokens'))).toBe(true);

    expect(isContextOverflow(new Error(
      'Throttling error: Too many tokens, please wait before trying again.',
    ))).toBe(false);
    expect(isContextOverflow(new Error(
      'ThrottlingException: Too many tokens, please wait before trying again.',
    ))).toBe(false);
    expect(isContextOverflow(new Error('Rate limit reached: too many tokens per minute'))).toBe(false);
    expect(isContextOverflow(new Error('429 Too Many Requests: too many tokens in flight'))).toBe(false);
  });
});
