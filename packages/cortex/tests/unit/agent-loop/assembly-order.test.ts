/**
 * assembly.ts construction-order invariant: the turn-boundary steer
 * listener registers AFTER the budget guard's, so a turn that breaches the
 * budget is seen as breached before parked content could be steered into a
 * run that is about to be aborted.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../src/agent-loop.js';
import type { PiEvent } from '../../../src/event-bridge.js';
import type { AgentLoopConfig } from '../../../src/types.js';
import { wrapModel } from '../../../src/model-wrapper.js';

type Ctor = new (agent: PiAgent, config: AgentLoopConfig) => AgentLoop;

function setup(maxTurns: number) {
  let emit!: (event: PiEvent) => void;
  let release!: () => void;
  const steer = vi.fn();
  const pi = {
    state: { messages: [], systemPrompt: '', tools: [] },
    subscribe(handler: (event: PiEvent) => void) {
      emit = handler;
      return () => {};
    },
    async prompt() {
      await new Promise<void>((resolve) => { release = resolve; });
      return {};
    },
    abort: vi.fn(),
    async waitForIdle() {},
    reset() {},
    steer,
    hasQueuedMessages: () => false,
  } as unknown as PiAgent;
  const raw = { provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel;
  const loop = new (AgentLoop as unknown as Ctor)(pi, {
    model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test prompt',
    budgetGuard: { maxTurns },
  });
  const endTurn = (): void => emit({
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }],
      stopReason: 'toolUse',
      usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } },
    },
  });
  return { loop, steer, endTurn, release: () => release() };
}

async function parkRedirectDuringRun(t: ReturnType<typeof setup>): Promise<{ turn: Promise<unknown> }> {
  const turn = t.loop.prompt('do the work');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(t.loop.isPrompting).toBe(true);
  expect(t.loop.deliver('change course', { atTurnBoundary: true }).outcome).toBe('parked');
  // Wrapped: an async function returning the promise would adopt it.
  return { turn };
}

describe('assembly listener order', () => {
  it('steers a parked turn-boundary delivery into a live run within budget', async () => {
    const t = setup(10);
    const { turn } = await parkRedirectDuringRun(t);
    t.endTurn();
    expect(t.steer).toHaveBeenCalledTimes(1);
    expect(t.loop.pendingWakeDeliveryCount).toBe(0);
    t.release();
    await turn;
  });

  it('leaves it parked when that turn breached the budget', async () => {
    const t = setup(1);
    const { turn } = await parkRedirectDuringRun(t);
    t.endTurn();
    expect(t.loop.getBudgetGuard().isBreached()).toBe(true);
    expect(t.steer).not.toHaveBeenCalled();
    expect(t.loop.pendingWakeDeliveryCount).toBe(1);
    // Drop it so its sweep does not start a run the mock would hold.
    t.loop.clearAllQueues();
    t.release();
    await turn;
  });
});
