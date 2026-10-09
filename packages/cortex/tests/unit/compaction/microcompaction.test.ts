import { describe, it, expect, beforeEach } from 'vitest';
import {
  MicrocompactionEngine,
  capToolResult,
  computeTrimState,
  computeAction,
  computeHotZone,
  resolveExtendedRetentionMultiplier,
  applyTrimAction,
  applyBookend,
  applyBookendWithPersistence,
  getToolCategory,
  MICROCOMPACTION_DEFAULTS,
} from '../../../src/compaction/microcompaction.js';
import { extractTextContent } from '../../../src/compaction/tool-messages.js';
import type { AgentMessage } from '../../../src/context-manager.js';
import type { MicrocompactionConfig } from '../../../src/types.js';
import {
  makeUserMsg,
  makeAssistantMsg,
  makeToolCallMsg,
  makeToolResultMsg,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;

/** Real runtime tool result message with an auto-generated call id. */
function makeToolResult(content: string, toolName = 'Read'): AgentMessage {
  return makeToolResultMsg(`call_r${++seq}`, toolName, content);
}

/** Real assistant message with a single toolCall block. */
function makeToolCall(toolName: string): AgentMessage {
  return makeToolCallMsg([{ id: `call_c${++seq}`, name: toolName }]);
}

function generateLargeContent(wordCount: number): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(`word${i}`);
  }
  return words.join(' ');
}

// Content of approximately N tokens (estimateTokens uses chars/4).
function makeContentOfTokens(tokens: number): string {
  return 'x'.repeat(tokens * 4);
}

// ---------------------------------------------------------------------------
// Tests: Insertion-time cap
// ---------------------------------------------------------------------------

describe('capToolResult', () => {
  it('returns content unchanged when below maxResultTokens', () => {
    const content = 'small result';
    const result = capToolResult(content, { maxResultTokens: 50_000, bookendMaxChars: 2000 });
    expect(result).toBe(content);
  });

  it('truncates content exceeding maxResultTokens to bookend format', () => {
    const content = generateLargeContent(40_000);
    const result = capToolResult(content, { maxResultTokens: 50_000, bookendMaxChars: 200 });

    expect(result).toContain('tokens trimmed at insertion');
    expect(result.length).toBeLessThan(content.length);
  });

  it('uses configurable bookendMaxChars', () => {
    const content = generateLargeContent(40_000);
    const result = capToolResult(content, { maxResultTokens: 50_000, bookendMaxChars: 100 });
    expect(result).toContain('tokens trimmed at insertion');
  });

  it('returns content unchanged when bookendMaxChars exceeds content length', () => {
    const content = 'small';
    const result = capToolResult(content, { maxResultTokens: 1, bookendMaxChars: 10_000 });
    expect(result).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Tests: Content extraction helpers
// ---------------------------------------------------------------------------

describe('getToolCategory', () => {
  it('returns default category for built-in tools', () => {
    expect(getToolCategory('Read')).toBe('rereadable');
    expect(getToolCategory('Glob')).toBe('rereadable');
    expect(getToolCategory('Grep')).toBe('rereadable');
    expect(getToolCategory('WebFetch')).toBe('non-reproducible');
    expect(getToolCategory('Bash')).toBe('non-reproducible');
    expect(getToolCategory('SubAgent')).toBe('ephemeral');
  });

  it('returns custom category when provided', () => {
    const custom = { MyTool: 'rereadable' as const };
    expect(getToolCategory('MyTool', custom)).toBe('rereadable');
  });

  it('custom categories override defaults', () => {
    const custom = { Read: 'non-reproducible' as const };
    expect(getToolCategory('Read', custom)).toBe('non-reproducible');
  });

  it('returns undefined for unknown tools without custom categories', () => {
    expect(getToolCategory('UnknownTool')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Hot zone computation
// ---------------------------------------------------------------------------

describe('computeHotZone', () => {
  it('leaves room to trim when the budget is smaller than the preferred hot zone', () => {
    expect(computeHotZone(8_192, MICROCOMPACTION_DEFAULTS)).toBe(4_096);
  });
  it('uses the floor on small windows', () => {
    expect(computeHotZone(32_000, MICROCOMPACTION_DEFAULTS)).toBe(16_000);
  });

  it('uses the floor on medium windows where ratio is below floor', () => {
    // 200k * 0.05 = 10k, floor wins at 16k
    expect(computeHotZone(200_000, MICROCOMPACTION_DEFAULTS)).toBe(16_000);
  });

  it('uses the ratio on large windows where ratio exceeds floor', () => {
    // 1M * 0.05 = 50k, ratio wins
    expect(computeHotZone(1_000_000, MICROCOMPACTION_DEFAULTS)).toBe(50_000);
  });

  it('respects custom floor and ratio', () => {
    expect(computeHotZone(100_000, { hotZoneMinTokens: 5_000, hotZoneRatio: 0.10 })).toBe(10_000);
    expect(computeHotZone(100_000, { hotZoneMinTokens: 20_000, hotZoneRatio: 0.10 })).toBe(20_000);
  });
});

// ---------------------------------------------------------------------------
// Tests: Extended retention multiplier resolution
// ---------------------------------------------------------------------------

describe('resolveExtendedRetentionMultiplier', () => {
  it('uses explicit multiplier when configured', () => {
    const config: MicrocompactionConfig = { ...MICROCOMPACTION_DEFAULTS, extendedRetentionMultiplier: 3 };
    expect(resolveExtendedRetentionMultiplier(config)).toBe(3);
  });

  it('returns 1.0 when persister is configured (content recoverable from disk)', () => {
    const config: MicrocompactionConfig = {
      ...MICROCOMPACTION_DEFAULTS,
      persistResult: async () => '/tmp/x',
    };
    expect(resolveExtendedRetentionMultiplier(config)).toBe(1.0);
  });

  it('returns 1.5 when no persister (content lost on trim)', () => {
    expect(resolveExtendedRetentionMultiplier(MICROCOMPACTION_DEFAULTS)).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// Tests: computeAction (per-result decision based on token offset)
// ---------------------------------------------------------------------------

describe('computeAction', () => {
  const config = MICROCOMPACTION_DEFAULTS;
  const hotZone = 16_000;
  const degradationSpan = 80_000;

  it('returns full within the hot zone', () => {
    const msg = makeToolResult('content', 'Read');
    const action = computeAction(msg, 5_000, hotZone, degradationSpan, config, 1.5);
    expect(action.kind).toBe('full');
  });

  it('returns full at the hot zone boundary', () => {
    const msg = makeToolResult('content', 'Read');
    // Boundary is exclusive: tokenOffset === hotZone is BEYOND the hot zone.
    const action = computeAction(msg, hotZone - 1, hotZone, degradationSpan, config, 1.5);
    expect(action.kind).toBe('full');
  });

  it('returns max-size bookend just past the hot zone', () => {
    const msg = makeToolResult('A'.repeat(10_000), 'Read');
    const action = computeAction(msg, hotZone, hotZone, degradationSpan, config, 1.5);
    expect(action.kind).toBe('bookend');
    if (action.kind === 'bookend') {
      // At t=0, bookend size should be ~bookendMaxChars
      expect(action.headChars).toBe(config.bookendMaxChars);
      expect(action.tailChars).toBe(config.bookendMaxChars);
    }
  });

  it('returns smaller bookend further into the degradation span', () => {
    const msg = makeToolResult('A'.repeat(10_000), 'Read');
    // Halfway through the degradation span: bookend should interpolate to roughly midway
    const action = computeAction(msg, hotZone + degradationSpan / 2, hotZone, degradationSpan, config, 1.5);
    expect(action.kind).toBe('bookend');
    if (action.kind === 'bookend') {
      const expectedMid = (config.bookendMaxChars + config.bookendMinChars) / 2;
      expect(action.headChars).toBeGreaterThan(config.bookendMinChars);
      expect(action.headChars).toBeLessThan(config.bookendMaxChars);
      // Within ~50 chars of the linear midpoint
      expect(Math.abs(action.headChars - expectedMid)).toBeLessThan(50);
    }
  });

  it('returns minimum bookend at the far end of the degradation span', () => {
    const msg = makeToolResult('A'.repeat(10_000), 'Read');
    // Just before t=1.0
    const action = computeAction(
      msg,
      hotZone + degradationSpan - 100,
      hotZone,
      degradationSpan,
      config,
      1.5,
    );
    expect(action.kind).toBe('bookend');
    if (action.kind === 'bookend') {
      expect(action.headChars).toBeGreaterThanOrEqual(config.bookendMinChars);
      expect(action.headChars).toBeLessThan(500);
    }
  });

  it('returns clear beyond degradation span for ephemeral tools', () => {
    const msg = makeToolResult('content', 'SubAgent');
    const action = computeAction(msg, hotZone + degradationSpan + 1_000, hotZone, degradationSpan, config, 1.5);
    expect(action.kind).toBe('clear');
  });

  it('returns placeholder beyond degradation span for non-reproducible tools', () => {
    const msg = makeToolResult('search results here', 'WebFetch');
    // For non-reproducible: effectiveHotZone = 16k * 1.5 = 24k. To exceed
    // degradation span, tokenOffset must be > 24k + 80k = 104k.
    const action = computeAction(msg, hotZone * 1.5 + degradationSpan + 1_000, hotZone, degradationSpan, config, 1.5);
    expect(action.kind).toBe('placeholder');
    if (action.kind === 'placeholder') {
      expect(action.toolName).toBe('WebFetch');
    }
  });

  it('returns placeholder beyond degradation span for rereadable tools', () => {
    const msg = makeToolResult('file contents', 'Read');
    const action = computeAction(msg, hotZone + degradationSpan + 1_000, hotZone, degradationSpan, config, 1.5);
    expect(action.kind).toBe('placeholder');
  });

  it('returns placeholder beyond degradation span for unknown tools', () => {
    const msg = makeToolResult('output', 'CustomTool');
    const action = computeAction(msg, hotZone + degradationSpan + 1_000, hotZone, degradationSpan, config, 1.5);
    expect(action.kind).toBe('placeholder');
  });

  it('extends the hot zone for non-reproducible tools', () => {
    const msg = makeToolResult('curl output', 'Bash');
    // 1.5x multiplier -> effective hot zone = 24_000. 20_000 is still inside.
    const action = computeAction(msg, 20_000, hotZone, degradationSpan, config, 1.5);
    expect(action.kind).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// Tests: Trim state computation
// ---------------------------------------------------------------------------

describe('computeTrimState', () => {
  const config = MICROCOMPACTION_DEFAULTS;

  it('returns empty actions when no tool results exist', () => {
    const history: AgentMessage[] = [
      makeUserMsg('hello'),
      makeAssistantMsg('hi'),
      makeUserMsg('question'),
      makeAssistantMsg('answer'),
    ];
    const state = computeTrimState(history, 200_000, 0.5, config);
    expect(state.actions.size).toBe(0);
  });

  it('preserves recent tool results within the hot zone', () => {
    // The algorithm walks history from newest to oldest, accumulating token
    // offsets from messages NEWER than each tool result. So a big assistant
    // message must come AFTER an older tool result to push it back.
    const history: AgentMessage[] = [
      makeToolCall('Read'),                             // 0
      makeToolResult('old content', 'Read'),            // 1
      makeAssistantMsg(makeContentOfTokens(20_000)),    // 2 - pushes index 1 beyond hot zone
      makeToolCall('Read'),                             // 3
      makeToolResult('recent content', 'Read'),         // 4 - tokenOffset = 0
    ];

    const state = computeTrimState(history, 200_000, 0.5, config);
    // Most recent tool result is fully within hot zone -> not in actions
    expect(state.actions.has(4)).toBe(false);
    // The older one is pushed beyond the hot zone by the 20k assistant msg after it
    expect(state.actions.has(1)).toBe(true);
  });

  it('counts tool call arguments toward token offsets', () => {
    // A toolCall whose arguments carry ~20k tokens must push older tool
    // results beyond the hot zone even with no other content around.
    const bigArgs = { path: '/f.txt', content: makeContentOfTokens(20_000) };
    const history: AgentMessage[] = [
      makeToolCall('Read'),                                                  // 0
      makeToolResult('old content', 'Read'),                                 // 1
      makeToolCallMsg([{ id: 'call_w', name: 'Write', arguments: bigArgs }]), // 2
      makeToolResultMsg('call_w', 'Write', 'File written'),                  // 3
    ];

    const state = computeTrimState(history, 200_000, 0.5, config);
    expect(state.actions.has(1)).toBe(true);
  });

  it('records historyLength and utilizationBand on the cached state', () => {
    const history = [makeToolResult('content', 'Read')];
    const state = computeTrimState(history, 100_000, 0.42, config);
    expect(state.historyLength).toBe(1);
    expect(state.utilizationBand).toBe(4); // floor(0.42 * 10)
  });

  it('walks history from newest to oldest accumulating token offsets', () => {
    // contextWindow = 200k, hotZone = 16k, degradationSpan = 80k
    // The big assistant messages must come AFTER (newer than) older tool
    // results to push them back, since the algorithm walks newest to oldest.
    const history: AgentMessage[] = [
      makeToolCall('Read'),                               // 0
      makeToolResult('very old', 'Read'),                 // 1
      makeAssistantMsg(makeContentOfTokens(100_000)),     // 2 - pushes index 1 beyond degradation span
      makeToolCall('Read'),                               // 3
      makeToolResult('middle', 'Read'),                   // 4
      makeAssistantMsg(makeContentOfTokens(20_000)),      // 5 - pushes index 4 just beyond hot zone
      makeToolCall('Read'),                               // 6
      makeToolResult('newest', 'Read'),                   // 7 - tokenOffset = 0
    ];
    const state = computeTrimState(history, 200_000, 0.6, config);

    // newest (index 7): full (within hot zone)
    expect(state.actions.has(7)).toBe(false);
    // middle (index 4): pushed back ~20k tokens by the assistant msg, within degradation span
    const middleAction = state.actions.get(4);
    expect(middleAction?.kind).toBe('bookend');
    // very old (index 1): pushed back >100k tokens, beyond degradation span (16k+80k=96k)
    const oldAction = state.actions.get(1);
    expect(oldAction?.kind === 'placeholder' || oldAction?.kind === 'clear').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Apply trim action
// ---------------------------------------------------------------------------

describe('applyTrimAction', () => {
  it('returns message unchanged for full action', () => {
    const msg = makeToolResult('content', 'Read');
    const result = applyTrimAction(msg, { kind: 'full' });
    expect(result).toBe(msg);
  });

  it('applies bookend format', () => {
    const content = 'A'.repeat(200) + 'B'.repeat(200);
    const msg: AgentMessage = { role: 'user', content, timestamp: 0 };
    const result = applyTrimAction(msg, {
      kind: 'bookend',
      headChars: 50,
      tailChars: 50,
      originalTokens: 100,
    });

    const text = extractTextContent(result);
    expect(text).toContain('tokens trimmed');
    expect(text.length).toBeLessThan(content.length);
  });

  it('applies placeholder format', () => {
    const msg = makeToolResult('content', 'Read');
    const result = applyTrimAction(msg, {
      kind: 'placeholder',
      toolName: 'Read',
      preview: 'file content preview',
    });
    const text = extractTextContent(result);
    expect(text).toContain('Tool result trimmed');
    expect(text).toContain('Read');
  });

  it('applies clear format', () => {
    const msg = makeToolResult('content', 'Read');
    const result = applyTrimAction(msg, { kind: 'clear' });
    const text = extractTextContent(result);
    expect(text).toBe('[Tool result cleared]');
  });

  it('preserves runtime toolResult structure and toolCallId linkage', () => {
    const msg: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'call_123',
      toolName: 'Bash',
      content: [
        { type: 'text', text: 'runtime output' },
      ],
      timestamp: 0,
    };
    const result = applyTrimAction(msg, { kind: 'clear' });

    expect(result.role).toBe('toolResult');
    expect(result.toolCallId).toBe('call_123');
    expect(result.toolName).toBe('Bash');
    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as Array<Record<string, unknown>>;
    expect(parts[0]!.type).toBe('text');
    expect(parts[0]!.text).toBe('[Tool result cleared]');
  });

  describe('legacy tool_result content parts', () => {
    it('preserves structure with tool_use_id for clear action', () => {
      const msg: AgentMessage = {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_abc123', text: 'file contents here', name: 'Read' },
        ],
        timestamp: 0,
      };
      const result = applyTrimAction(msg, { kind: 'clear' });

      expect(Array.isArray(result.content)).toBe(true);
      const parts = result.content as Array<Record<string, unknown>>;
      expect(parts.length).toBe(1);
      expect(parts[0]!.type).toBe('tool_result');
      expect(parts[0]!.tool_use_id).toBe('toolu_abc123');
      expect(parts[0]!.text).toBe('[Tool result cleared]');
    });

    it('preserves structure with tool_use_id for placeholder action', () => {
      const msg: AgentMessage = {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_xyz789', text: 'original content', name: 'Grep' },
        ],
        timestamp: 0,
      };
      const result = applyTrimAction(msg, {
        kind: 'placeholder',
        toolName: 'Grep',
        preview: 'original con',
      });

      expect(Array.isArray(result.content)).toBe(true);
      const parts = result.content as Array<Record<string, unknown>>;
      expect(parts[0]!.type).toBe('tool_result');
      expect(parts[0]!.tool_use_id).toBe('toolu_xyz789');
      expect(parts[0]!.text as string).toContain('Tool result trimmed');
    });

    it('preserves structure with tool_use_id for bookend action', () => {
      const longContent = 'A'.repeat(500);
      const msg: AgentMessage = {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_def456', text: longContent, name: 'Read' },
        ],
        timestamp: 0,
      };
      const result = applyTrimAction(msg, {
        kind: 'bookend',
        headChars: 50,
        tailChars: 50,
        originalTokens: 125,
      });

      expect(Array.isArray(result.content)).toBe(true);
      const parts = result.content as Array<Record<string, unknown>>;
      expect(parts[0]!.type).toBe('tool_result');
      expect(parts[0]!.tool_use_id).toBe('toolu_def456');
      expect(parts[0]!.text as string).toContain('tokens trimmed');
    });

    it('handles multiple tool_result parts in a single message', () => {
      const msg: AgentMessage = {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', text: 'result one', name: 'Read' },
          { type: 'tool_result', tool_use_id: 'toolu_2', text: 'result two', name: 'Glob' },
        ],
        timestamp: 0,
      };
      const result = applyTrimAction(msg, { kind: 'clear' });

      expect(Array.isArray(result.content)).toBe(true);
      const parts = result.content as Array<Record<string, unknown>>;
      expect(parts.length).toBe(2);
      expect(parts[0]!.text).toBe('[Tool result cleared]');
      expect(parts[1]!.text).toBe('[Tool result cleared]');
    });
  });

  it('falls back to plain string for non-array content', () => {
    const msg: AgentMessage = { role: 'user', content: 'plain string content', timestamp: 0 };
    const result = applyTrimAction(msg, { kind: 'clear' });
    expect(result.content).toBe('[Tool result cleared]');
  });
});

describe('applyBookend', () => {
  it('returns content unchanged when head+tail exceeds content length', () => {
    expect(applyBookend('short', 100, 100, 10)).toBe('short');
  });

  it('produces head + marker + tail format', () => {
    const content = 'START' + 'x'.repeat(500) + 'END';
    const result = applyBookend(content, 10, 10, 200);
    expect(result.startsWith('START')).toBe(true);
    expect(result).toContain('END');
    expect(result).toContain('tokens trimmed');
    expect(result.length).toBeLessThan(content.length);
  });
});

describe('applyBookendWithPersistence', () => {
  it('includes header with disk path and tool name', () => {
    const content = 'x'.repeat(2_000);
    const result = applyBookendWithPersistence(content, 100, 100, 500, 'WebFetch', '/tmp/result.txt');
    expect(result).toContain('Result persisted');
    expect(result).toContain('/tmp/result.txt');
    expect(result).toContain('WebFetch');
  });

  it('includes path reference in the middle marker', () => {
    const content = 'A'.repeat(1_000) + 'B'.repeat(1_000);
    const result = applyBookendWithPersistence(content, 100, 100, 500, 'Bash', '/tmp/x.txt');
    expect(result).toContain('full content at /tmp/x.txt');
  });

  it('returns header + content when bookends exceed content length', () => {
    const result = applyBookendWithPersistence('short', 100, 100, 5, 'Bash', '/tmp/x.txt');
    expect(result).toContain('Result persisted');
    expect(result).toContain('short');
  });
});

// ---------------------------------------------------------------------------
// Tests: MicrocompactionEngine
// ---------------------------------------------------------------------------

describe('MicrocompactionEngine', () => {
  describe('cache-aware gating', () => {
    let engine: MicrocompactionEngine;

    beforeEach(() => {
      engine = new MicrocompactionEngine();
    });

    it('returns history unchanged when cache is warm (regardless of utilization)', async () => {
      const history: AgentMessage[] = [
        makeAssistantMsg(makeContentOfTokens(50_000)),
        makeToolCall('Read'),
        makeToolResult(makeContentOfTokens(20_000), 'Read'),
        makeAssistantMsg('recent'),
      ];
      // 80% utilization, but cache is warm
      const result = await engine.apply(history, 100_000, 80_000, { cacheCold: false });
      expect(result).toBe(history);
    });

    it('returns history unchanged below trim floor (even when cache is cold)', async () => {
      const history: AgentMessage[] = [
        makeToolCall('Read'),
        makeToolResult(makeContentOfTokens(5_000), 'Read'),
        makeAssistantMsg('recent'),
      ];
      // 20% utilization, cache cold
      const result = await engine.apply(history, 100_000, 20_000, { cacheCold: true });
      expect(result).toBe(history);
    });

    it('trims when cache is cold and above trim floor', async () => {
      // contextWindow=200k, hotZone=16k. Push old result well past hot zone with a big assistant msg.
      const longContent = makeContentOfTokens(20_000);
      const history: AgentMessage[] = [
        makeToolCall('Read'),
        makeToolResult(longContent, 'Read'),
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      const result = await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      const trimmed = extractTextContent(result[1]!);
      expect(trimmed).not.toBe(longContent);
      expect(trimmed).toContain('tokens trimmed');
    });

    it('defaults cacheCold to true when no options provided', async () => {
      const longContent = makeContentOfTokens(20_000);
      const history: AgentMessage[] = [
        makeToolCall('Read'),
        makeToolResult(longContent, 'Read'),
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      // No options arg -> default behavior should trim
      const result = await engine.apply(history, 200_000, 100_000);
      const trimmed = extractTextContent(result[1]!);
      expect(trimmed).toContain('tokens trimmed');
    });
  });

  describe('progressive degradation', () => {
    it('keeps recent results full (within hot zone)', async () => {
      const engine = new MicrocompactionEngine();
      const recentContent = 'recent and full';
      const history: AgentMessage[] = [
        makeAssistantMsg(makeContentOfTokens(50_000)),
        makeToolCall('Read'),
        makeToolResult(recentContent, 'Read'),
      ];
      const result = await engine.apply(history, 200_000, 80_000, { cacheCold: true });
      // The most recent tool result is at the end, so its tokenOffset == 0, full.
      expect(extractTextContent(result[2]!)).toBe(recentContent);
    });

    it('uses smaller bookends for results further from the most recent message', async () => {
      const engine = new MicrocompactionEngine();
      // Make the OLDER tool result much further from the end.
      const middleContent = 'M'.repeat(20_000);
      const olderContent = 'O'.repeat(20_000);
      const history: AgentMessage[] = [
        makeToolCall('Read'),
        makeToolResult(olderContent, 'Read'),
        makeAssistantMsg(makeContentOfTokens(40_000)),
        makeToolCall('Read'),
        makeToolResult(middleContent, 'Read'),
        makeAssistantMsg(makeContentOfTokens(20_000)),
      ];
      const result = await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      const middleTrimmed = extractTextContent(result[4]!);
      const olderTrimmed = extractTextContent(result[1]!);
      // Both should be trimmed; the older one should be shorter (smaller bookend).
      expect(middleTrimmed.length).toBeLessThan(middleContent.length);
      expect(olderTrimmed.length).toBeLessThan(olderContent.length);
      expect(olderTrimmed.length).toBeLessThan(middleTrimmed.length);
    });

    it('extends hot zone for non-reproducible tools', async () => {
      const engine = new MicrocompactionEngine();
      // Push a Bash result just past the standard hot zone (16k) but within
      // the extended hot zone (16k * 1.5 = 24k for no-persister default).
      const content = makeContentOfTokens(5_000);
      const history: AgentMessage[] = [
        makeToolCall('Bash'),
        makeToolResult(content, 'Bash'),
        makeAssistantMsg(makeContentOfTokens(18_000)),
      ];
      const result = await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      // Bash result should still be full (within extended hot zone)
      expect(extractTextContent(result[1]!)).toBe(content);
    });
  });

  describe('persistence', () => {
    it('persists non-reproducible content on bookend with disk path', async () => {
      const persisted: Array<{ content: string; path: string }> = [];
      const engine = new MicrocompactionEngine({
        persistResult: async (content) => {
          const path = `/tmp/persisted-${persisted.length}.txt`;
          persisted.push({ content, path });
          return path;
        },
      });
      const longContent = 'web' + 'x'.repeat(20_000);
      const history: AgentMessage[] = [
        makeToolCall('WebFetch'),
        makeToolResult(longContent, 'WebFetch'),
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      const result = await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      const trimmed = extractTextContent(result[1]!);

      expect(persisted.length).toBe(1);
      expect(persisted[0]!.content).toBe(longContent);
      expect(trimmed).toContain('Result persisted');
      expect(trimmed).toContain(persisted[0]!.path);
    });

    it('does NOT persist rereadable content on trim (agent can re-read source)', async () => {
      const persistCalls: string[] = [];
      const engine = new MicrocompactionEngine({
        persistResult: async (content) => {
          persistCalls.push(content);
          return '/tmp/x.txt';
        },
      });
      const longContent = 'file contents ' + 'y'.repeat(20_000);
      const history: AgentMessage[] = [
        makeToolCall('Read'),
        makeToolResult(longContent, 'Read'),
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      expect(persistCalls.length).toBe(0);
    });

    it('does NOT persist ephemeral content on trim (re-runnable)', async () => {
      const persistCalls: string[] = [];
      const engine = new MicrocompactionEngine({
        persistResult: async (content) => {
          persistCalls.push(content);
          return '/tmp/x.txt';
        },
      });
      const history: AgentMessage[] = [
        makeToolCall('SubAgent'),
        makeToolResult('subagent output ' + 'z'.repeat(20_000), 'SubAgent'),
        makeAssistantMsg(makeContentOfTokens(120_000)),
        makeAssistantMsg('recent'),
      ];
      await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      expect(persistCalls.length).toBe(0);
    });

    it('falls back to standard trim when persist callback throws', async () => {
      const engine = new MicrocompactionEngine({
        persistResult: async () => { throw new Error('disk full'); },
      });
      const longContent = 'web' + 'x'.repeat(20_000);
      const history: AgentMessage[] = [
        makeToolCall('WebFetch'),
        makeToolResult(longContent, 'WebFetch'),
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      const result = await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      const trimmed = extractTextContent(result[1]!);
      // Should still be trimmed (just without the persisted path)
      expect(trimmed).toContain('tokens trimmed');
      expect(trimmed).not.toContain('Result persisted');
    });

    it('formats placeholder with disk path when persisted', async () => {
      const engine = new MicrocompactionEngine({
        persistResult: async () => '/tmp/output.txt',
      });
      // Push a non-reproducible result far enough back that it goes beyond
      // the degradation span (200k * 0.40 = 80k) plus the extended hot zone
      // (16k * 1.0 = 16k since persister is configured).
      const history: AgentMessage[] = [
        makeToolCall('Bash'),
        makeToolResult('bash output', 'Bash'),
        makeAssistantMsg(makeContentOfTokens(120_000)),
        makeAssistantMsg('recent'),
      ];
      const result = await engine.apply(history, 200_000, 130_000, { cacheCold: true });
      const trimmed = extractTextContent(result[1]!);
      expect(trimmed).toContain('persisted');
      expect(trimmed).toContain('/tmp/output.txt');
    });
  });

  describe('state caching', () => {
    let engine: MicrocompactionEngine;

    beforeEach(() => {
      engine = new MicrocompactionEngine();
    });

    it('caches trim state across identical calls', async () => {
      const longContent = makeContentOfTokens(20_000);
      const history: AgentMessage[] = [
        makeToolCall('Read'),
        makeToolResult(longContent, 'Read'),
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      const firstState = engine.getCachedState();
      expect(firstState).not.toBeNull();

      await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      const secondState = engine.getCachedState();
      expect(secondState).toBe(firstState);
    });

    it('never replays a trim onto another message at the same index', async () => {
      const result = makeToolResult(makeContentOfTokens(20_000), 'Read');
      const history: AgentMessage[] = [
        makeToolCall('Read'),
        result,
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      const first = await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      // Precondition: the result at index 1 was trimmed.
      expect(first[1]).not.toBe(result);

      // A rewrite of the same length (a swap removed as many messages as
      // had arrived) puts the user's latest question at index 1.
      const ask = makeUserMsg('the latest question');
      const rewritten: AgentMessage[] = [
        makeAssistantMsg('kept'),
        ask,
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      const second = await engine.apply(rewritten, 200_000, 100_000, { cacheCold: true });

      expect(second[1]).toBe(ask);
    });

    it('recomputes when history length changes', async () => {
      const longContent = makeContentOfTokens(20_000);
      const history: AgentMessage[] = [
        makeToolCall('Read'),
        makeToolResult(longContent, 'Read'),
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      const firstState = engine.getCachedState();

      // Add another message
      const history2 = [...history, makeAssistantMsg('newer')];
      await engine.apply(history2, 200_000, 105_000, { cacheCold: true });
      const secondState = engine.getCachedState();
      expect(secondState).not.toBe(firstState);
    });

    it('recomputes when utilization band changes', async () => {
      const longContent = makeContentOfTokens(20_000);
      const history: AgentMessage[] = [
        makeToolCall('Read'),
        makeToolResult(longContent, 'Read'),
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      // Band 5 (50%)
      await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      const firstState = engine.getCachedState();

      // Band 6 (60%)
      await engine.apply(history, 200_000, 130_000, { cacheCold: true });
      const secondState = engine.getCachedState();
      expect(secondState).not.toBe(firstState);
    });

    it('resets cache on resetCache()', async () => {
      const longContent = makeContentOfTokens(20_000);
      const history: AgentMessage[] = [
        makeToolCall('Read'),
        makeToolResult(longContent, 'Read'),
        makeAssistantMsg(makeContentOfTokens(30_000)),
        makeAssistantMsg('recent'),
      ];
      await engine.apply(history, 200_000, 100_000, { cacheCold: true });
      expect(engine.getCachedState()).not.toBeNull();

      engine.resetCache();
      expect(engine.getCachedState()).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty history', async () => {
      const engine = new MicrocompactionEngine();
      const result = await engine.apply([], 200_000, 100_000, { cacheCold: true });
      expect(result).toEqual([]);
    });

    it('returns history unchanged when contextWindow is 0', async () => {
      const engine = new MicrocompactionEngine();
      const history = [makeUserMsg('hello')];
      const result = await engine.apply(history, 0, 0, { cacheCold: true });
      expect(result).toEqual(history);
    });
  });

  describe('capAtInsertion', () => {
    it('caps large content', () => {
      const engine = new MicrocompactionEngine();
      const large = generateLargeContent(40_000);
      const result = engine.capAtInsertion(large);
      expect(result.length).toBeLessThan(large.length);
      expect(result).toContain('tokens trimmed at insertion');
    });

    it('passes through small content', () => {
      const engine = new MicrocompactionEngine();
      const small = 'hello world';
      const result = engine.capAtInsertion(small);
      expect(result).toBe(small);
    });
  });

  describe('hasPersistCallback', () => {
    it('returns true when persistResult is configured', () => {
      const engine = new MicrocompactionEngine({ persistResult: async () => '/tmp/x' });
      expect(engine.hasPersistCallback).toBe(true);
    });

    it('returns false when persistResult is not configured', () => {
      const engine = new MicrocompactionEngine();
      expect(engine.hasPersistCallback).toBe(false);
    });
  });
});
