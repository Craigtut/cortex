import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CompactionManager,
  buildCompactionConfig,
  DEFAULT_COMPACTION_CONFIG,
} from '../../../src/compaction/index.js';
import type { AgentContext, AgentMessage } from '../../../src/context-manager.js';
import type { CortexCompactionConfig } from '../../../src/types.js';
import type { ObservationEvent } from '../../../src/compaction/observational/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMsg(content: string): AgentMessage {
  return { role: 'user', content };
}

function makeAssistantMsg(content: string): AgentMessage {
  return { role: 'assistant', content };
}

function buildHistory(turnCount: number): AgentMessage[] {
  const history: AgentMessage[] = [];
  for (let i = 0; i < turnCount; i++) {
    history.push(makeUserMsg(`User message ${i}`));
    history.push(makeAssistantMsg(`Assistant response ${i}`));
  }
  return history;
}

function makeContext(messages: AgentMessage[]): AgentContext {
  return {
    systemPrompt: 'System prompt content',
    model: {},
    messages,
    tools: [],
    thinkingLevel: 'none',
  };
}

// ---------------------------------------------------------------------------
// Tests: buildCompactionConfig
// ---------------------------------------------------------------------------

describe('buildCompactionConfig', () => {
  it('returns defaults when no overrides provided', () => {
    const config = buildCompactionConfig();
    expect(config).toEqual(DEFAULT_COMPACTION_CONFIG);
  });

  it('returns defaults when undefined is passed', () => {
    const config = buildCompactionConfig(undefined);
    expect(config).toEqual(DEFAULT_COMPACTION_CONFIG);
  });

  it('applies partial microcompaction overrides', () => {
    const config = buildCompactionConfig({
      microcompaction: { maxResultTokens: 25_000 } as CortexCompactionConfig['microcompaction'],
    });

    expect(config.microcompaction.maxResultTokens).toBe(25_000);
    expect(config.microcompaction.trimFloorRatio).toBe(0.25); // default
  });

  it('rejects the removed classic strategy and its settings, naming the removal', () => {
    const removed = [
      { strategy: 'classic' },
      { compaction: { threshold: 0.8, preserveRecentTurns: 8 } },
      { adaptive: { enabled: false } },
    ];
    for (const legacy of removed) {
      expect(() => buildCompactionConfig(legacy as Partial<CortexCompactionConfig>))
        .toThrow('Classic compaction was removed');
    }
    // Precondition: the check rejects the removed settings, not any config.
    expect(() => buildCompactionConfig({ strategy: 'observational' } as Partial<CortexCompactionConfig>)).not.toThrow();
  });

  it('applies failsafe overrides', () => {
    const config = buildCompactionConfig({
      failsafe: { threshold: 0.85 },
    });

    expect(config.failsafe.threshold).toBe(0.85);
  });
});

// ---------------------------------------------------------------------------
// Tests: CompactionManager
// ---------------------------------------------------------------------------

describe('CompactionManager', () => {
  let manager: CompactionManager;

  beforeEach(() => {
    manager = new CompactionManager(buildCompactionConfig(), 2);
  });

  // -----------------------------------------------------------------------
  // Configuration
  // -----------------------------------------------------------------------

  describe('configuration', () => {
    it('tracks context window size', () => {
      manager.setContextWindow(200_000);
      expect(manager.contextWindow).toBe(200_000);
    });
  });

  // -----------------------------------------------------------------------
  // Cache-aware gating
  // -----------------------------------------------------------------------

  describe('cache-aware gating', () => {
    it('reports cache cold when no provider info is set', () => {
      expect(manager.isCacheCold()).toBe(true);
    });

    it('reports cache cold when caching is unsupported', () => {
      manager.setCacheInfo('google', 'long');
      expect(manager.providerCacheTtlMs).toBe(0);
      expect(manager.isCacheCold()).toBe(true);
    });

    it('reports cache cold when retention is none', () => {
      manager.setCacheInfo('anthropic', 'none');
      expect(manager.providerCacheTtlMs).toBe(0);
      expect(manager.isCacheCold()).toBe(true);
    });

    it('resolves Anthropic short TTL to 5 minutes', () => {
      manager.setCacheInfo('anthropic', 'short');
      expect(manager.providerCacheTtlMs).toBe(300_000);
    });

    it('resolves Anthropic long TTL to 1 hour', () => {
      manager.setCacheInfo('anthropic', 'long');
      expect(manager.providerCacheTtlMs).toBe(3_600_000);
    });

    it('resolves OpenAI short TTL to 10 minutes', () => {
      manager.setCacheInfo('openai', 'short');
      expect(manager.providerCacheTtlMs).toBe(600_000);
    });

    it('resolves OpenAI long TTL to 24 hours', () => {
      manager.setCacheInfo('openai', 'long');
      expect(manager.providerCacheTtlMs).toBe(86_400_000);
    });

    it('reports cache cold when no LLM call has been recorded', () => {
      manager.setCacheInfo('anthropic', 'short');
      expect(manager.lastLlmCallTimestamp).toBeNull();
      expect(manager.isCacheCold()).toBe(true);
    });

    it('reports cache warm immediately after an LLM call', () => {
      manager.setCacheInfo('anthropic', 'short');
      manager.updateCurrentContextTokenCount(1000);
      expect(manager.lastLlmCallTimestamp).not.toBeNull();
      expect(manager.isCacheCold()).toBe(false);
    });

    it('reports cache cold after the TTL has elapsed', () => {
      manager.setCacheInfo('anthropic', 'short'); // 5 min TTL
      manager.updateCurrentContextTokenCount(1000);
      const callTime = manager.lastLlmCallTimestamp!;
      // Simulate 6 minutes passing
      expect(manager.isCacheCold(callTime + 360_000)).toBe(true);
    });

    it('reports cache warm just before the TTL boundary', () => {
      manager.setCacheInfo('anthropic', 'short'); // 5 min TTL
      manager.updateCurrentContextTokenCount(1000);
      const callTime = manager.lastLlmCallTimestamp!;
      // 4 minutes 59 seconds: still warm
      expect(manager.isCacheCold(callTime + 299_000)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Token Tracking
  // -----------------------------------------------------------------------

  describe('token tracking', () => {
    it('tracks current context token count', () => {
      expect(manager.currentContextTokenCount).toBe(0);

      manager.updateCurrentContextTokenCount(50_000);
      expect(manager.currentContextTokenCount).toBe(50_000);
    });

    it('calculates usage ratio', () => {
      manager.setContextWindow(200_000);
      manager.updateCurrentContextTokenCount(100_000);

      expect(manager.usageRatio).toBe(0.5);
    });

    it('returns 0 usage ratio when contextWindow is 0', () => {
      expect(manager.usageRatio).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Insertion-time cap
  // -----------------------------------------------------------------------

  describe('capToolResult', () => {
    it('passes through small content', () => {
      const result = manager.capToolResult('small content');
      expect(result).toBe('small content');
    });
  });

  // -----------------------------------------------------------------------
  // applyInsertionCap
  // -----------------------------------------------------------------------

  describe('applyInsertionCap', () => {
    function generateLargeContent(wordCount: number): string {
      const words: string[] = [];
      for (let i = 0; i < wordCount; i++) {
        words.push(`word${i}`);
      }
      return words.join(' ');
    }

    function makeToolResultMsg(text: string, toolName?: string): AgentMessage {
      return {
        role: 'user',
        content: [
          { type: 'tool_result', text, ...(toolName ? { name: toolName } : {}) },
        ],
      };
    }

    function makeRuntimeToolResultMsg(text: string, toolName?: string): AgentMessage {
      return {
        role: 'toolResult',
        toolName,
        content: [
          { type: 'text', text },
        ],
      };
    }

    it('caps oversized tool results in place', () => {
      // ~40000 words * 1.3 = ~52000 tokens, exceeding 50000 default
      const largeContent = generateLargeContent(40_000);
      const slot = makeUserMsg('slot content');
      const toolResult = makeToolResultMsg(largeContent, 'Read');
      const messages: AgentMessage[] = [slot, toolResult, makeAssistantMsg('analysis')];

      manager.applyInsertionCap(messages, 1);

      // The tool result should have been capped
      const capped = messages[1]!;
      expect(Array.isArray(capped.content)).toBe(true);
      const part = (capped.content as Array<{ text?: string }>)[0]!;
      expect(part.text).toContain('tokens trimmed at insertion');
      expect(part.text!.length).toBeLessThan(largeContent.length);
    });

    it('caps oversized runtime toolResult messages in place', async () => {
      const largeContent = generateLargeContent(40_000);
      const slot = makeUserMsg('slot content');
      const toolResult = makeRuntimeToolResultMsg(largeContent, 'Read');
      const messages: AgentMessage[] = [slot, toolResult, makeAssistantMsg('analysis')];

      await manager.applyInsertionCap(messages, 1);

      const capped = messages[1]!;
      expect(Array.isArray(capped.content)).toBe(true);
      const part = (capped.content as Array<{ text?: string }>)[0]!;
      expect(part.text).toContain('tokens trimmed at insertion');
      expect(part.text!.length).toBeLessThan(largeContent.length);
    });

    it('skips already-capped tool results', () => {
      const alreadyCapped = 'HEAD\n\n... [~1000 tokens trimmed at insertion] ...\n\nTAIL';
      const toolResult = makeToolResultMsg(alreadyCapped, 'Read');
      const messages: AgentMessage[] = [toolResult];

      manager.applyInsertionCap(messages, 0);

      // Should be unchanged
      const part = (messages[0]!.content as Array<{ text?: string }>)[0]!;
      expect(part.text).toBe(alreadyCapped);
    });

    it('skips small tool results', () => {
      const smallContent = 'small result';
      const toolResult = makeToolResultMsg(smallContent, 'Read');
      const messages: AgentMessage[] = [toolResult];

      manager.applyInsertionCap(messages, 0);

      const part = (messages[0]!.content as Array<{ text?: string }>)[0]!;
      expect(part.text).toBe(smallContent);
    });

    it('skips messages in the slot region', () => {
      const largeContent = generateLargeContent(40_000);
      const slotToolResult = makeToolResultMsg(largeContent, 'Read');
      const messages: AgentMessage[] = [slotToolResult, makeAssistantMsg('after slot')];

      manager.applyInsertionCap(messages, 1);

      // Slot region (index 0) should be untouched
      const part = (messages[0]!.content as Array<{ text?: string }>)[0]!;
      expect(part.text).toBe(largeContent);
    });

    it('skips non-tool-result messages', () => {
      const messages: AgentMessage[] = [
        makeUserMsg('regular message'),
        makeAssistantMsg('response'),
      ];

      manager.applyInsertionCap(messages, 0);

      expect(messages[0]!.content).toBe('regular message');
      expect(messages[1]!.content).toBe('response');
    });
  });

  // -----------------------------------------------------------------------
  // transformContext integration
  // -----------------------------------------------------------------------

  describe('applyInTransformContext', () => {
    /** Run the pass over `slots` + `history`, with the source accessors. */
    async function apply(slots: AgentMessage[], history: AgentMessage[]): Promise<{ result: AgentContext; source: AgentMessage[] }> {
      let source = [...history];
      const result = await manager.applyInTransformContext(
        makeContext([...slots, ...history]),
        (ctx) => ctx.messages.slice(2),
        (ctx, hist) => ({ ...ctx, messages: [...ctx.messages.slice(0, 2), ...hist] }),
        () => source,
        (h) => { source = h; },
      );
      return { result, source };
    }

    it('returns context unchanged when contextWindow is 0', async () => {
      const slots = [makeUserMsg('slot1'), makeUserMsg('slot2')];
      const history = buildHistory(5);

      const { result } = await apply(slots, history);

      expect(result.messages).toEqual([...slots, ...history]);
    });

    it('applies microcompaction when above soft threshold', async () => {
      manager.setContextWindow(100_000);
      manager.updateCurrentContextTokenCount(45_000); // 45% > 40% threshold

      const slots = [makeUserMsg('slot1'), makeUserMsg('slot2')];
      const toolResult: AgentMessage = {
        role: 'user',
        content: [{ type: 'tool_result', text: 'old file content that is long enough to be trimmed', name: 'Read' }],
      };
      const history = [
        toolResult,
        makeAssistantMsg('old analysis'),
        makeAssistantMsg('more analysis'),
        makeAssistantMsg('turn 3'),
        makeAssistantMsg('turn 4'),
        makeAssistantMsg('turn 5'),
        makeAssistantMsg('turn 6'),
        makeAssistantMsg('recent'),
      ];

      const { result } = await apply(slots, history);

      // Slots should be untouched
      expect(result.messages[0]).toBe(slots[0]);
      expect(result.messages[1]).toBe(slots[1]);
    });

    it('cuts the view, not the source, past the emergency ceiling', async () => {
      manager.setContextWindow(100_000);
      // A warm cache keeps L1 out of the way.
      manager.setCacheInfo('anthropic', 'short');
      manager.updateCurrentContextTokenCount(99_000);

      const slots = [makeUserMsg('slot1'), makeUserMsg('slot2')];
      const history = Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? makeAssistantMsg('a'.repeat(40_000)) : makeUserMsg(`question ${i}`)));

      const { result, source } = await apply(slots, history);

      expect(result.messages.length).toBeLessThan(slots.length + history.length);
      expect(source).toEqual(history);
    });

    it('activates on the current transformed-context estimate when the measured count is stale', async () => {
      manager.setContextWindow(1_000);
      manager.updateCurrentContextTokenCount(100);
      const mockComplete = vi.fn().mockResolvedValue('<observations>\n* (10:00) observed\n</observations>');
      manager.setObservationalCompleteFn(mockComplete);

      const slots = [makeUserMsg('slot1'), makeUserMsg('slot2')];
      const largeTurn = 'x'.repeat(5_000);
      const history = [
        makeUserMsg(largeTurn),
        makeAssistantMsg(largeTurn),
        makeUserMsg(largeTurn),
        makeAssistantMsg(largeTurn),
        makeUserMsg('latest'),
      ];

      const { source } = await apply(slots, history);

      expect(mockComplete).toHaveBeenCalled();
      expect(source.length).toBeLessThan(history.length);
    });
  });

  // -----------------------------------------------------------------------
  // Reactive overflow handling
  // -----------------------------------------------------------------------

  describe('handleOverflowError', () => {
    it('drops what does not fit and records the gap', () => {
      manager.setContextWindow(100_000);
      manager.updateCurrentContextTokenCount(150_000);

      const history = Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? makeAssistantMsg('a'.repeat(30_000)) : makeUserMsg('u'.repeat(30_000))));
      let replacedHistory: AgentMessage[] | null = null;

      manager.handleOverflowError(
        () => history,
        (h) => { replacedHistory = h; },
      );

      expect(replacedHistory).not.toBeNull();
      expect(replacedHistory!.length).toBeLessThan(history.length);
      expect(manager.getObservationalMemoryState().observations).toContain('GAP:');
    });

    it('reports the observed messages that left with the context size before and after', () => {
      manager.setContextWindow(100_000);
      manager.updateCurrentContextTokenCount(150_000);
      const history = Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? makeAssistantMsg('a'.repeat(30_000)) : makeUserMsg('u'.repeat(30_000))));
      // The first four messages are observed; the rest are not.
      manager.restoreObservationalMemoryState({
        observations: '', continuationHint: null, observationTokenCount: 0, generationCount: 0,
        bufferedChunks: [{ observations: '* (10:00) the first exchanges', messageTokensObserved: 30_000, createdAt: new Date(), endIndex: 4 }],
        bufferWatermark: 4,
      });
      const events: ObservationEvent[] = [];
      manager.onObservation((event) => events.push(event));
      let replaced: AgentMessage[] = [];

      manager.handleOverflowError(() => history, (h) => { replaced = h; });

      // Precondition: the observed messages left as a swap, the rest as a gap.
      expect(events).toHaveLength(1);
      expect(events[0]!.trigger).toBe('emergency');
      expect(events[0]!.removedMessages).toHaveLength(4);
      // The rejected context was at least what was measured; what is left
      // fits the window, and is what the kept history and the log weigh.
      const { tokensBefore, tokensAfter, contextUtilization } = events[0]!;
      expect(tokensBefore).toBeGreaterThanOrEqual(150_000);
      expect(contextUtilization).toBe(tokensBefore / 100_000);
      expect(tokensAfter).toBeGreaterThan(replaced.length * 7_000);
      expect(tokensAfter).toBeLessThan(100_000);
    });

    it('is a no-op for empty history', () => {
      manager.setContextWindow(100_000);
      manager.updateCurrentContextTokenCount(95_000);

      let setCalled = false;
      manager.handleOverflowError(
        () => [],
        () => { setCalled = true; },
      );

      expect(setCalled).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  describe('destroy', () => {
    it('resets all state', () => {
      manager.setContextWindow(200_000);
      manager.updateCurrentContextTokenCount(100_000);

      manager.destroy();

      expect(manager.currentContextTokenCount).toBe(0);
    });
  });
});
