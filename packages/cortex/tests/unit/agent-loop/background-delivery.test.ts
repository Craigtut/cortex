import { describe, it, expect, vi } from 'vitest';
import { BackgroundDelivery } from '../../../src/agent-loop/background-delivery.js';
import type { PendingBackgroundCompletion } from '../../../src/agent-loop/background-delivery.js';
import { DeadLetterStore } from '../../../src/agent-loop/delivery-failure.js';
import { AbortState, LoopGate } from '../../../src/agent-loop/run-control.js';
import { DEFAULT_RETRY_POLICY } from '../../../src/retry-policy.js';
import type { RetryPolicy, SubAgentResult } from '../../../src/types.js';

const result: SubAgentResult = {
  output: 'done',
  status: 'completed',
  usage: { turns: 1, cost: 0, durationMs: 10, contextTokens: 0 },
};

function setup(overrides?: { run?: () => Promise<unknown>; unwind?: boolean; cancelled?: string[] }) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deadLetters = new DeadLetterStore(logger);
  const runDeliveryTurn = vi.fn<(message: string, policy: RetryPolicy, causeTags: unknown[]) => Promise<unknown>>(
    overrides?.run ?? (async () => ({})),
  );
  const emitError = vi.fn();
  const delivery = new BackgroundDelivery({
    gate: new LoopGate(),
    abort: new AbortState(),
    isAborted: () => false,
    isShuttingDown: () => false,
    isCancelled: (taskId) => overrides?.cancelled?.includes(taskId) ?? false,
    runDeliveryTurn,
    unwindFailedDelivery: () => overrides?.unwind ?? true,
    backgroundTasks: { get: () => undefined },
    deadLetters,
    retryPolicy: DEFAULT_RETRY_POLICY,
    emitError,
    logger,
  });
  return { delivery, deadLetters, runDeliveryTurn, emitError };
}

const item = (taskId: string): PendingBackgroundCompletion => ({ kind: 'subagent', taskId, result });

describe('BackgroundDelivery', () => {
  it('delivers queued completions in one run and notifies delivery handlers once', async () => {
    const t = setup();
    const notified = vi.fn();
    t.delivery.deliveryHandlers.add(notified);
    t.delivery.pending.push(item('a'), item('b'));
    await t.delivery.drain();
    expect(t.runDeliveryTurn).toHaveBeenCalledTimes(1);
    expect(String(t.runDeliveryTurn.mock.calls[0]![0])).toContain('[Background sub-agent a completed]');
    expect(notified).toHaveBeenCalledWith(['a', 'b']);
    expect(t.delivery.pending).toHaveLength(0);
  });

  it('discards a cancelled sub-agent result without a run', async () => {
    const t = setup({ cancelled: ['a'] });
    t.delivery.pending.push(item('a'));
    await t.delivery.drain();
    expect(t.runDeliveryTurn).not.toHaveBeenCalled();
    expect(t.deadLetters.list()).toHaveLength(0);
  });

  it('re-queues a failed delivery and dead-letters it once attempts run out', async () => {
    const t = setup({ run: async () => { throw new Error('503 service unavailable'); } });
    t.delivery.pending.push(item('a'));
    await expect(t.delivery.drain()).rejects.toThrow('503');
    expect(t.runDeliveryTurn).toHaveBeenCalledTimes(3);
    expect(t.deadLetters.list()).toMatchObject([{ kind: 'subagent', taskId: 'a', attempts: 3 }]);
    expect(t.delivery.pending).toHaveLength(0);
  });

  it('delivers a re-queued batch on a later attempt without dead-lettering it', async () => {
    let calls = 0;
    const t = setup({ run: async () => { calls += 1; if (calls === 1) throw new Error('503'); return {}; } });
    t.delivery.pending.push(item('a'));
    await t.delivery.drain();
    expect(t.runDeliveryTurn).toHaveBeenCalledTimes(2);
    expect(t.deadLetters.list()).toHaveLength(0);
  });

  it('does not re-queue content the failed run progressed past', async () => {
    const t = setup({ run: async () => { throw new Error('boom'); }, unwind: false });
    t.delivery.pending.push(item('a'));
    await expect(t.delivery.drain()).rejects.toThrow('boom');
    expect(t.runDeliveryTurn).toHaveBeenCalledTimes(1);
    expect(t.delivery.pending).toHaveLength(0);
  });

  it('dead-letters everything pending at teardown and purges a cancelled task', () => {
    const t = setup();
    t.delivery.pending.push(item('a'), item('b'), item('c'));
    t.delivery.purgeSubAgent('b');
    expect(t.delivery.pending.map((i) => i.taskId)).toEqual(['a', 'c']);
    t.delivery.deadLetterAllPending('agent shut down before delivery');
    expect(t.deadLetters.list().map((e) => e.taskId)).toEqual(['a', 'c']);
    expect(t.delivery.pending).toHaveLength(0);
  });
});

describe('BackgroundDelivery causation', () => {
  it('runs the drain with the causation of every completion it delivers', async () => {
    const t = setup();
    t.delivery.pending.push({ ...item('a'), causeTags: ['x'] }, item('b'), { ...item('c'), causeTags: ['y', 'z'] });
    await t.delivery.drain();
    expect(t.runDeliveryTurn.mock.calls[0]![2]).toEqual(['x', 'y', 'z']);
  });

  it('attributes a Bash completion to the run that backgrounded it, once', async () => {
    const t = setup();
    t.delivery.noteBashStarted('task_1', ['origin']);
    const enqueue = vi.spyOn(t.delivery, 'enqueue').mockResolvedValue();
    await t.delivery.bashCompleted('task_1');
    await t.delivery.bashCompleted('task_1');
    expect(enqueue.mock.calls.map((call) => call[0])).toEqual([
      { kind: 'bash', taskId: 'task_1', causeTags: ['origin'] },
      { kind: 'bash', taskId: 'task_1' },
    ]);
  });
});
