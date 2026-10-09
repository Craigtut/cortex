/**
 * Background work carries the causation of the run that started it: the
 * drain run delivering a background sub-agent's or Bash task's completion
 * exposes that run's cause tags through activeRunCauseTags. Without it the
 * completion arrives in a run with no causation, and a consumer that drops
 * results of cancelled work (the duplex router) cannot attribute it.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import { EventBridge } from '../../src/event-bridge.js';

type Ctor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

type PiTool = { name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> };

interface Harness {
  loop: AgentLoop;
  /** Each pi run's input and the loop's cause tags while it ran. */
  runs: Array<{ input: string | AgentMessage[]; tags: readonly unknown[] }>;
}

/** A loop whose first run calls `tool` with `params` from inside the run. */
function setup(tool: string, params: unknown): Harness {
  const runs: Harness['runs'] = [];
  const pi = {
    state: { messages: [] as AgentMessage[], systemPrompt: '', tools: [] as PiTool[] },
    subscribe() { return () => {}; },
    async prompt(input: string | AgentMessage[]) {
      runs.push({ input, tags: loop.activeRunCauseTags });
      pi.state.messages.push({ role: 'user', content: typeof input === 'string' ? input : 'batch', timestamp: 0 });
      if (runs.length === 1) {
        await pi.state.tools.find((t) => t.name === tool)!.execute('tc-1', params);
      }
      pi.state.messages.push({ role: 'assistant', content: 'ok', timestamp: 0 } as AgentMessage);
      return {};
    },
    abort() {},
    async waitForIdle() {},
    reset() { pi.state.messages = []; },
    steer() {},
  };
  const raw = { provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel;
  const loop = new (AgentLoop as unknown as Ctor)(
    pi as unknown as PiAgent,
    {
      model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
      workingDirectory: '/tmp',
      initialBasePrompt: 'Test prompt',
      slots: [],
    },
    [],
    { enableSubAgentTool: true, enableLoadSkillTool: false },
  );
  return { loop, runs };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('background completions carry the spawning run causation', () => {
  it('delivers a background sub-agent result in a run carrying the spawning run tags', async () => {
    const t = setup('SubAgent', { instructions: 'look into it', background: true });
    let finishChild!: () => void;
    const childDone = new Promise<void>((resolve) => { finishChild = resolve; });
    (t.loop as unknown as { createChildAgent: unknown }).createChildAgent = vi.fn().mockResolvedValue({
      destroy: vi.fn().mockResolvedValue(undefined),
      prompt: () => childDone,
      getConversationHistory: () => [{ role: 'assistant', content: 'found it' }],
      getBudgetGuard: () => ({ getTurnCount: () => 1, getTotalCost: () => 0 }),
      getEventBridge: () => new EventBridge(false),
      currentContextTokenCount: 0,
    });

    const { turn } = t.loop.deliver('start the task', { causeTag: 'directive-7' });
    await turn;
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]!.tags).toEqual(['directive-7']);

    // The spawning run is over; the result arrives later in a drain run.
    finishChild();
    await waitFor(() => t.runs.length === 2);
    expect(String(t.runs[1]!.input)).toContain('found it');
    expect(t.runs[1]!.tags).toEqual(['directive-7']);
    await t.loop.waitForLoopIdle();
    await t.loop.destroy();
  });

  it('delivers a backgrounded Bash completion in a run carrying the spawning run tags', async () => {
    const t = setup('Bash', { command: 'echo bg-done', background: true });

    const { turn } = t.loop.deliver('run it in the background', { causeTag: 'directive-9' });
    await turn;
    expect(t.runs[0]!.tags).toEqual(['directive-9']);

    await waitFor(() => t.runs.length === 2);
    expect(String(t.runs[1]!.input)).toContain('bg-done');
    expect(t.runs[1]!.tags).toEqual(['directive-9']);
    await t.loop.waitForLoopIdle();
    await t.loop.destroy();
  });

  it('a sub-agent spawned outside any run carries no causation', async () => {
    const t = setup('SubAgent', {});
    (t.loop as unknown as { createChildAgent: unknown }).createChildAgent = vi.fn().mockResolvedValue({
      destroy: vi.fn().mockResolvedValue(undefined),
      prompt: async () => ({}),
      getConversationHistory: () => [{ role: 'assistant', content: 'consumer work' }],
      getBudgetGuard: () => ({ getTurnCount: () => 1, getTotalCost: () => 0 }),
      getEventBridge: () => new EventBridge(false),
      currentContextTokenCount: 0,
    });
    // A consumer-API spawn: the precondition is that a drain run happens at
    // all, so the empty tag set below is a real observation.
    t.runs.push({ input: 'placeholder', tags: [] });
    await t.loop.spawnBackgroundSubAgent({ instructions: 'consumer work' });
    await waitFor(() => t.runs.length === 2);
    expect(String(t.runs[1]!.input)).toContain('consumer work');
    expect(t.runs[1]!.tags).toEqual([]);
    await t.loop.waitForLoopIdle();
    await t.loop.destroy();
  });
});
