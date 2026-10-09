/**
 * Headline feed API: a facade feeds a live status block into the loop's
 * transformContext. The block must land OUTSIDE the BP3 cache boundary
 * (it churns every tick), be rebuilt per call, and be hard token-capped
 * (injected user-role content is never trimmed by microcompaction, so an
 * unbounded block would inflate utilization without ever shrinking).
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentContext, AgentMessage } from '../../src/context-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import { estimateTokens } from '../../src/token-estimator.js';
import type { CacheBreakpointIndices } from '../../src/cache-breakpoints.js';
import { partsOf } from './agent-loop/parts.js';
import { textAssistant } from '../helpers/messages.js';

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

function makeModel(raw: PiModel) {
  return wrapModel(raw, raw.provider, raw.name, raw.contextWindow);
}

function createMockPiAgent(): PiAgent {
  return {
    state: { messages: [], systemPrompt: '', tools: [] },
    subscribe() { return () => {}; },
    async prompt() { return { content: 'ok' }; },
    abort() {},
    async waitForIdle() {},
    reset() { this.state.messages = []; },
    steer() {},
  } as unknown as PiAgent;
}

function createLoop(config?: Partial<AgentLoopConfig>): AgentLoop {
  const Ctor = AgentLoop as unknown as TestAgentLoopConstructor;
  return new Ctor(
    createMockPiAgent(),
    {
      model: makeModel({
        provider: 'anthropic',
        name: 'claude-sonnet-4-20250514',
        contextWindow: 200_000,
      } as PiModel),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'Test prompt',
      slots: [],
      ...config,
    },
    [],
    { enableSubAgentTool: false, enableLoadSkillTool: false },
  );
}

function baseContext(loop: AgentLoop): AgentContext {
  const piAgent = (loop as unknown as { agent: PiAgent }).agent;
  return {
    systemPrompt: 'sys',
    model: null,
    messages: piAgent.state.messages,
    tools: [],
    thinkingLevel: 'medium',
  };
}

function contentOf(message: AgentMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

async function runHook(loop: AgentLoop): Promise<AgentContext> {
  const hook = loop.getTransformContextHook();
  return hook(baseContext(loop));
}

describe('setHeadlineProvider', () => {
  it('injects the provider content into the transformed context, rebuilt per call', async () => {
    const loop = createLoop();
    let tick = 0;
    loop.setHeadlineProvider(() => `<status>tick ${++tick}</status>`);

    const first = await runHook(loop);
    expect(first.messages.some((m) => contentOf(m) === '<status>tick 1</status>')).toBe(true);

    const second = await runHook(loop);
    expect(second.messages.some((m) => contentOf(m) === '<status>tick 2</status>')).toBe(true);
    expect(second.messages.some((m) => contentOf(m).includes('tick 1'))).toBe(false);
  });

  it('never enters the transcript (source messages stay clean)', async () => {
    const loop = createLoop();
    loop.setHeadlineProvider(() => '<status>live</status>');

    await runHook(loop);

    const piAgent = (loop as unknown as { agent: PiAgent }).agent;
    expect(
      piAgent.state.messages.some((m) => contentOf(m as AgentMessage).includes('<status>')),
    ).toBe(false);
  });

  it('stays outside the BP3 boundary: breakpoint indices match a headline-free call', async () => {
    // Seed a slot and old history so the indices are non-trivial: with an
    // empty fixture both arms compute {bp2: -1, bp3: -1} and the equality
    // assertion holds vacuously.
    const loop = createLoop({ slots: ['notes'] });
    const internals = partsOf(loop);
    const piAgent = (loop as unknown as { agent: PiAgent }).agent;
    loop.getContextManager().setSlot('notes', 'stable slot content');
    piAgent.state.messages.push(
      { role: 'user', content: 'old question', timestamp: 1 },
      textAssistant('old answer', 2),
      { role: 'user', content: 'follow-up', timestamp: 3 },
      textAssistant('more detail', 4),
    );
    // Everything above is pre-prompt history, so BP3 sits after it.
    internals.runner.boundary = piAgent.state.messages.length;

    await runHook(loop);
    const withoutHeadline = internals.pipeline.cacheBreakpointIndices;

    // Guard against the fixture going vacuous again: BP2 covers the slot,
    // BP3 the old-history boundary beyond it.
    expect(withoutHeadline?.bp2ApiIndex).toBe(0);
    expect(withoutHeadline?.bp3ApiIndex).toBeGreaterThan(0);

    loop.setHeadlineProvider(() => '<status>churn every tick</status>');
    await runHook(loop);
    const withHeadline = internals.pipeline.cacheBreakpointIndices;

    expect(withHeadline).toEqual(withoutHeadline);
  });

  it('hard-caps oversized content with a truncation marker', async () => {
    const loop = createLoop();
    loop.setHeadlineProvider(() => 'x'.repeat(100_000), { maxTokens: 100 });

    const result = await runHook(loop);
    const injected = result.messages.map(contentOf).find((c) => c.includes('[headline block truncated]'));

    expect(injected).toBeDefined();
    expect(estimateTokens(injected!)).toBeLessThanOrEqual(100);
  });

  it('injects nothing for null, whitespace, or a throwing provider', async () => {
    const loop = createLoop();
    const countMessages = async () => (await runHook(loop)).messages.length;

    const baseline = await countMessages();

    loop.setHeadlineProvider(() => null);
    expect(await countMessages()).toBe(baseline);

    loop.setHeadlineProvider(() => '   \n ');
    expect(await countMessages()).toBe(baseline);

    loop.setHeadlineProvider(() => {
      throw new Error('provider exploded');
    });
    expect(await countMessages()).toBe(baseline);
  });

  it('stops injecting when the provider is cleared', async () => {
    const loop = createLoop();
    loop.setHeadlineProvider(() => '<status>live</status>');
    expect((await runHook(loop)).messages.some((m) => contentOf(m).includes('<status>'))).toBe(true);

    loop.setHeadlineProvider(null);
    expect((await runHook(loop)).messages.some((m) => contentOf(m).includes('<status>'))).toBe(false);
  });

  it('rejects a non-positive token cap', () => {
    const loop = createLoop();
    expect(() => loop.setHeadlineProvider(() => 'x', { maxTokens: 0 })).toThrow('positive');
    expect(() => loop.setHeadlineProvider(() => 'x', { maxTokens: -5 })).toThrow('positive');
  });

  it('provider exceptions do not break the transform pipeline', async () => {
    const loop = createLoop();
    const warn = vi.fn();
    // Swap the logger to observe the warning without failing the call.
    (loop as unknown as { logger: { warn: typeof warn } }).logger.warn = warn;
    loop.setHeadlineProvider(() => {
      throw new Error('boom');
    });

    await expect(runHook(loop)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith('headline provider threw', expect.objectContaining({
      error: 'boom',
    }));
  });
});
