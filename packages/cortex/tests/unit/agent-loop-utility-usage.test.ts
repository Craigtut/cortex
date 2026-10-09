/**
 * Utility usage accounting: direct/utility completion spend (observer,
 * reflector, L2 summarization, WebFetch summarization, Bash utility calls)
 * accumulates into per-loop session usage under a category tag and emits a
 * utility_usage event. Before this, that spend was stashed in a field with
 * no public reader and reached no accounting surface at all.
 */
import { describe, it, expect, vi } from 'vitest';

const mockComplete = vi.fn();

vi.mock('../../src/model-runtime.js', () => ({
  streamModel: (...args: unknown[]) => ({ result: () => mockComplete(...args) }),
}));

import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { AgentLoopConfig, UtilityUsagePayload } from '../../src/types.js';
import type { CortexEvent } from '../../src/event-bridge.js';
import { wrapModel } from '../../src/model-wrapper.js';

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

function createLoop(configOverrides?: Partial<AgentLoopConfig>): AgentLoop {
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
      ...configOverrides,
    },
    [],
    { enableSubAgentTool: false, enableLoadSkillTool: false },
  );
}

function completionResult(costTotal: number) {
  return {
    content: 'result text',
    usage: {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 150,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
  };
}

describe('utility usage accounting', () => {
  it('accumulates a tagged utilityComplete into session usage under its category', async () => {
    mockComplete.mockResolvedValue(completionResult(0.003));
    const loop = createLoop();

    await loop.utilityComplete(
      { systemPrompt: 'summarize', messages: [{ role: 'user', content: 'page' }] },
      { usageCategory: 'webfetch' },
    );

    const usage = loop.getSessionUsage();
    expect(usage.totalCost).toBeCloseTo(0.003);
    expect(usage.tokens.input).toBe(100);
    expect(usage.tokens.output).toBe(50);
    expect(usage.utility).toBeDefined();
    expect(usage.utility!['webfetch']).toEqual({
      calls: 1,
      cost: 0.003,
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
    });
  });

  it('defaults untagged calls to their entry point category', async () => {
    mockComplete.mockResolvedValue(completionResult(0.001));
    const loop = createLoop();

    await loop.directComplete({ systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] });
    await loop.utilityComplete({ systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] });

    const usage = loop.getSessionUsage();
    expect(usage.utility!['direct']?.calls).toBe(1);
    expect(usage.utility!['utility']?.calls).toBe(1);
    expect(usage.totalCost).toBeCloseTo(0.002);
  });

  it('threads budgetGuard.includeUtilityUsage into the loop guard (S7)', async () => {
    mockComplete.mockResolvedValue(completionResult(0.25));
    const loop = createLoop({
      budgetGuard: { maxTurns: 100, maxCost: 10, includeUtilityUsage: true },
    });

    await loop.utilityComplete(
      { systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] },
      { usageCategory: 'observer' },
    );

    // The declared config field reaches the guard: utility spend counts
    // toward maxCost instead of being silently dropped.
    expect(loop.getBudgetGuard().getTotalCost()).toBeCloseTo(0.25);
  });

  it('leaves utility spend out of the loop guard by default', async () => {
    mockComplete.mockResolvedValue(completionResult(0.25));
    const loop = createLoop({ budgetGuard: { maxTurns: 100, maxCost: 10 } });

    await loop.utilityComplete(
      { systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] },
      { usageCategory: 'observer' },
    );

    expect(loop.getBudgetGuard().getTotalCost()).toBe(0);
  });

  it('emits a utility_usage event with the category and typed usage', async () => {
    mockComplete.mockResolvedValue(completionResult(0.003));
    const loop = createLoop();
    const events: CortexEvent[] = [];
    loop.getEventBridge().on('utility_usage', (event) => events.push(event));

    await loop.utilityComplete(
      { systemPrompt: 'observe', messages: [{ role: 'user', content: 'history' }] },
      { usageCategory: 'observer' },
    );

    expect(events).toHaveLength(1);
    expect((events[0]!.payload as UtilityUsagePayload).category).toBe('observer');
    expect(events[0]!.usage?.cost.total).toBeCloseTo(0.003);
    expect(events[0]!.usage?.input).toBe(100);
  });

  it('routes observer and reflector spend into separate buckets through the compaction wiring', async () => {
    const OBSERVER_OUTPUT =
      '<observations>\n* seen\n</observations>\n\n' +
      '<current-task>\nt\n</current-task>\n\n<suggested-response>\nr\n</suggested-response>';
    mockComplete.mockResolvedValue({ ...completionResult(0.004), content: OBSERVER_OUTPUT });
    const loop = createLoop();
    // Seed post-slot history so the observer has something to observe.
    const piAgent = (loop as unknown as { agent: PiAgent }).agent;
    piAgent.state.messages.push({ role: 'user', content: 'work happened', timestamp: 1 } as never);

    // Drive the observer through the real wiring (manual trigger uses the
    // same setObservationalCompleteFn path activation uses).
    await loop.triggerObservation();

    const usage = loop.getSessionUsage();
    expect(usage.utility!['observer']?.calls).toBeGreaterThanOrEqual(1);
    expect(usage.utility!['observer']?.cost).toBeCloseTo(0.004 * usage.utility!['observer']!.calls);
    expect(usage.totalCost).toBeCloseTo(usage.utility!['observer']!.cost);
  });

  it('accumulates forwarded child utility spend into the parent totals', async () => {
    mockComplete.mockResolvedValue(completionResult(0.005));
    const parent = createLoop();
    const child = createLoop();
    const stop = parent.getEventBridge().forwardFrom(child.getEventBridge(), 'task-1');

    await child.utilityComplete(
      { systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] },
      { usageCategory: 'observer' },
    );

    // The child accounts its own spend...
    expect(child.getSessionUsage().utility!['observer']?.calls).toBe(1);
    // ...and the parent sees the same spend through forwarding, matching
    // how child turn usage rolls into parent session totals.
    expect(parent.getSessionUsage().utility!['observer']?.calls).toBe(1);
    expect(parent.getSessionUsage().totalCost).toBeCloseTo(0.005);
    stop();
  });

  it('round-trips utility buckets through getSessionUsage/restoreSessionUsage', async () => {
    mockComplete.mockResolvedValue(completionResult(0.003));
    const saved = createLoop();
    await saved.utilityComplete(
      { systemPrompt: 's', messages: [{ role: 'user', content: 'x' }] },
      { usageCategory: 'summarization' },
    );
    const snapshot = saved.getSessionUsage();

    const restored = createLoop();
    restored.restoreSessionUsage(snapshot);

    const usage = restored.getSessionUsage();
    expect(usage.totalCost).toBeCloseTo(0.003);
    expect(usage.utility!['summarization']).toEqual({
      calls: 1,
      cost: 0.003,
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
    });
    // The snapshot is a deep copy: mutating it never leaks into the loop.
    snapshot.utility!['summarization']!.cost = 999;
    expect(restored.getSessionUsage().utility!['summarization']?.cost).toBeCloseTo(0.003);
  });
});
