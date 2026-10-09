/**
 * When a request will not fit: a failed activation still has headroom up to
 * the emergency ceiling; past it, the request's view is cut (the source keeps
 * every message for the observer) while the latest user message and the tail
 * stay; and only a provider overflow drops unobserved messages for good,
 * recording the gap in the log, where reflection cannot erase it.
 */
import { describe, it, expect, vi } from 'vitest';
import { CompactionManager, buildCompactionConfig } from '../../../../src/compaction/index.js';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import { AgentLoop } from '../../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../../src/agent-loop.js';
import { wrapModel } from '../../../../src/model-wrapper.js';
import type { AgentLoopConfig } from '../../../../src/types.js';
import type { CompleteFn } from '../../../../src/compaction/compaction.js';
import type { AgentContext, AgentMessage } from '../../../../src/context-manager.js';
import { makeToolCallMsg, makeToolResultMsg, assertNoOrphans } from '../helpers.js';

const userMsg = (content: string, timestamp = 0): AgentMessage => ({ role: 'user', content, timestamp });
const assistantMsg = (content: string, timestamp = 0): AgentMessage => ({ role: 'assistant', content, timestamp });

function failingManager(): CompactionManager {
  const manager = new CompactionManager(buildCompactionConfig({ observational: { maxAttempts: 1 } }), 1);
  manager.setContextWindow(100_000);
  manager.setModelContextWindow(100_000);
  manager.setObservationalCompleteFn(vi.fn<CompleteFn>().mockRejectedValue(new Error('500 internal server error')));
  // A warm prompt cache keeps tool-result trimming (L1) out of the way.
  manager.setCacheInfo('anthropic', 'short');
  return manager;
}

async function transform(manager: CompactionManager, history: AgentMessage[]): Promise<AgentMessage[]> {
  let source = [...history];
  const result = await manager.applyInTransformContext(
    { systemPrompt: '', model: null, messages: [userMsg('slot'), ...history], tools: [], thinkingLevel: 'medium' } as AgentContext,
    (ctx) => ctx.messages.slice(1),
    (ctx, h) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...h] }),
    () => source,
    (h) => { source = h; },
  );
  return result.messages.slice(1);
}

describe('in-band emergency', () => {
  it('leaves a failed activation the headroom up to the ceiling', async () => {
    const manager = failingManager();
    manager.updateCurrentContextTokenCount(91_000);
    const history = Array.from({ length: 12 }, (_, i) => (i % 2 ? assistantMsg(`a${i} ` + 'x'.repeat(4_000)) : userMsg(`u${i}`)));

    const view = await transform(manager, history);

    // Activation (90%) failed to observe; 91% is under the 95% ceiling.
    expect(view).toEqual(history);
  });

  it('past the ceiling, cuts the view keeping the latest user message, the tail, and a note', async () => {
    const manager = failingManager();
    manager.updateCurrentContextTokenCount(99_000);
    const ask = userMsg('refactor the parser');
    const work: AgentMessage[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
      work.push(makeToolCallMsg([{ id, name: 'Read' }]), makeToolResultMsg(id, 'Read', 'r'.repeat(40_000)));
    }
    // The ask is older than everything the ceiling leaves room for.
    const history = [ask, ...work];

    const view = await transform(manager, history);

    expect(view).toContain(ask);
    expect(view.slice(-2)).toEqual(work.slice(-2));
    // The oldest tool group is not shown, and a note says a span is missing.
    expect(view).not.toContain(work[0]);
    expect(view).not.toContain(work[1]);
    expect(String(view[0]!.content)).toContain('are not shown');
    assertNoOrphans(view.slice(1));
  });
});

describe('provider overflow', () => {
  type Ctor = new (
    agent: PiAgent,
    config: AgentLoopConfig,
    tools?: unknown[],
    options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
  ) => AgentLoop;

  it('drops unobserved messages that do not fit and records the gap', async () => {
    const piAgent = {
      state: { messages: [] as AgentMessage[], systemPrompt: '', tools: [] },
      subscribe() { return () => {}; },
      async prompt(input: string) {
        const state = piAgent.state as { messages: AgentMessage[]; errorMessage?: string };
        state.messages.push(userMsg(input, Date.now()));
        state.errorMessage = 'prompt is too long: 213462 tokens > 200000 maximum';
        state.messages.push({ role: 'assistant', content: [], stopReason: 'error', timestamp: Date.now() } as never);
        return {};
      },
      async continue() { return {}; },
      abort() {},
      async waitForIdle() {},
      reset() {},
      steer() {},
      clearSteeringQueue() {},
      hasQueuedMessages() { return false; },
    } as unknown as PiAgent;
    const raw = { provider: 'anthropic', name: 'model', contextWindow: 20_000 } as PiModel;
    const loop = new (AgentLoop as unknown as Ctor)(
      piAgent,
      {
        model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
        workingDirectory: '/tmp/test-workspace',
        initialBasePrompt: 'Test prompt',
        slots: [],
        retryPolicy: { enabled: false },
      },
      [],
      { enableSubAgentTool: false, enableLoadSkillTool: false },
    );
    const gaps: Array<{ droppedMessages: number; note: string }> = [];
    loop.onMemoryGap((info) => gaps.push(info));
    const start = new Date(2026, 9, 8, 14, 2).getTime();
    // Nothing observed: eight large unobserved messages, two minutes apart.
    loop.restoreConversationHistory(Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? assistantMsg('a'.repeat(12_000), start + i * 120_000) : userMsg('u'.repeat(12_000), start + i * 120_000))));

    await expect(loop.prompt('one more thing')).rejects.toThrow();

    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.droppedMessages).toBeGreaterThan(0);
    const log = loop.getObservationalMemoryState()?.observations ?? '';
    expect(log).toContain('GAP:');
    expect(log).toContain('2:02 PM');
    // The latest user message is still there for the next attempt.
    const history = loop.getConversationHistory();
    expect(history.some((m) => m.role === 'user' && m.content === 'one more thing')).toBe(true);
  });
});

describe('gap notes and reflection', () => {
  it('a reflection that drops a gap line gets it back', async () => {
    const engine = new ObservationalMemoryEngine({ maxAttempts: 1 }, 0);
    engine.setContextWindow(20_000); // reflection threshold 4,000 tokens
    engine.setUtilityModelContextWindow(200_000);
    const gap = '* \u{1F534} (2:02 PM to 2:40 PM) GAP: 7 messages from 2:02 PM to 2:40 PM left context before memory recorded them (test). Details from that span are missing.';
    engine.restoreState({
      observations: '* (10:00) fact\n'.repeat(1_200) + gap,
      continuationHint: null,
      observationTokenCount: 5_000,
      generationCount: 0,
      bufferedChunks: [],
      bufferWatermark: 0,
    });
    engine.setCompleteFn(vi.fn<CompleteFn>().mockImplementation(async (_ctx, options) =>
      options?.purpose === 'reflector'
        ? '<observations>\n* (10:00) condensed facts\n</observations>'
        : '<observations>\n* observed\n</observations>'));

    let source = [userMsg('hello')];
    await engine.applyInTransformContext(
      { systemPrompt: '', model: null, messages: [userMsg('slot'), ...source], tools: [], thinkingLevel: 'medium' } as AgentContext,
      0.95, 1,
      (ctx) => ctx.messages.slice(1),
      (ctx, h) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...h] }),
      () => source,
      (h) => { source = h; },
    );

    // Precondition: the reflection landed.
    expect(engine.getObservations()).toContain('condensed facts');
    expect(engine.getObservations()).toContain(gap);
  });
});
