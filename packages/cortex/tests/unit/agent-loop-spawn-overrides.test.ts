/**
 * Per-spawn controls added for the duplex restructure: wall-clock timeouts
 * (producing the previously-unused 'timed_out' status), independent named
 * concurrency pools, and per-spawn model / thinking / compaction overrides
 * on the child-config path (createChildAgent previously hardcoded the
 * parent's primary model).
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { AgentLoopConfig, CortexCompactionConfig } from '../../src/types.js';
import { SubAgentManager } from '../../src/sub-agent-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import { EventBridge } from '../../src/event-bridge.js';

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

function createTestAgentLoop(config?: Partial<AgentLoopConfig>): AgentLoop {
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

interface SpawnInternals {
  createChildAgent: (params: unknown) => Promise<unknown>;
}

/** A child stub whose prompt hangs until abort() rejects it (like a real abort). */
function createHangingChild(options?: { partialOutput?: string }) {
  let rejectPrompt!: (err: Error) => void;
  const promptGate = new Promise<never>((_, reject) => { rejectPrompt = reject; });
  promptGate.catch(() => {});
  const history = options?.partialOutput
    ? [{ role: 'assistant', content: options.partialOutput }]
    : [];
  return {
    abort: vi.fn().mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      rejectPrompt(err);
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    prompt: vi.fn().mockReturnValue(promptGate),
    getConversationHistory: () => history,
    getBudgetGuard: () => ({ getTurnCount: () => 2, getTotalCost: () => 0.01 }),
    getEventBridge: () => new EventBridge(false),
    currentContextTokenCount: 0,
  };
}

describe('sub-agent wall-clock timeout', () => {
  it('aborts the child on expiry and resolves the completion as timed_out with partial output', async () => {
    const agent = createTestAgentLoop();
    const child = createHangingChild({ partialOutput: 'partial findings' });
    (agent as unknown as SpawnInternals).createChildAgent = vi.fn().mockResolvedValue(child);

    const completedHook = vi.fn();
    agent.onSubAgentCompleted(completedHook);

    const { taskId } = await agent.spawnBackgroundSubAgent({
      instructions: 'long scan',
      timeoutMs: 25,
    });
    const completion = agent.getSubAgentManager().get(taskId)!.completion;

    const result = await completion;
    expect(result.status).toBe('timed_out');
    expect(result.output).toBe('partial findings');
    expect(child.abort).toHaveBeenCalled();
    expect(child.destroy).toHaveBeenCalled();
    expect(completedHook).toHaveBeenCalledWith(
      taskId,
      'partial findings',
      'timed_out',
      expect.anything(),
    );
  });

  it('reports timed_out even when the aborted run settles by resolving', async () => {
    const agent = createTestAgentLoop();
    // A child whose prompt resolves cleanly once abort() is called, the way
    // pi settles a run whose stream returned stopReason 'aborted'.
    let resolvePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { resolvePrompt = resolve; });
    const child = {
      abort: vi.fn().mockImplementation(async () => { resolvePrompt(); }),
      destroy: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockReturnValue(promptGate),
      getConversationHistory: () => [{ role: 'assistant', content: 'stopped mid-way' }],
      getBudgetGuard: () => ({ getTurnCount: () => 1, getTotalCost: () => 0 }),
      getEventBridge: () => new EventBridge(false),
      currentContextTokenCount: 0,
    };
    (agent as unknown as SpawnInternals).createChildAgent = vi.fn().mockResolvedValue(child);

    const { taskId } = await agent.spawnBackgroundSubAgent({
      instructions: 'long scan',
      timeoutMs: 25,
    });

    const result = await agent.getSubAgentManager().get(taskId)!.completion;
    expect(result.status).toBe('timed_out');
    expect(result.output).toBe('stopped mid-way');
  });

  it('does not time out a spawn without a cap', async () => {
    const agent = createTestAgentLoop();
    let resolvePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { resolvePrompt = resolve; });
    const child = {
      abort: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockReturnValue(promptGate),
      getConversationHistory: () => [{ role: 'assistant', content: 'done' }],
      getBudgetGuard: () => ({ getTurnCount: () => 1, getTotalCost: () => 0 }),
      getEventBridge: () => new EventBridge(false),
      currentContextTokenCount: 0,
    };
    (agent as unknown as SpawnInternals).createChildAgent = vi.fn().mockResolvedValue(child);

    const { taskId } = await agent.spawnBackgroundSubAgent({ instructions: 'quick task' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    resolvePrompt();

    const result = await agent.getSubAgentManager().get(taskId)!.completion;
    expect(result.status).toBe('completed');
    expect(child.abort).not.toHaveBeenCalled();
  });
});

describe('sub-agent concurrency pools', () => {
  it('counts pools independently in the manager', () => {
    const manager = new SubAgentManager({ maxConcurrent: 1, pools: { lookup: 2 } });
    const entry = (taskId: string, pool?: string) => ({
      taskId,
      agent: {} as never,
      instructions: 'x',
      background: true,
      spawnedAt: Date.now(),
      completion: Promise.resolve({} as never),
      resolve: () => {},
      toolCount: 0,
      lastToolName: null,
      lastToolSummary: null,
      lastToolStartedAt: null,
      pendingPermission: null,
      ...(pool !== undefined ? { pool } : {}),
    });

    // Fill the default pool.
    expect(manager.track(entry('a'))).toBe(true);
    expect(manager.canSpawn()).toBe(false);
    // The named pool is unaffected by the saturated default pool.
    expect(manager.canSpawn('lookup')).toBe(true);
    expect(manager.track(entry('b', 'lookup'))).toBe(true);
    expect(manager.track(entry('c', 'lookup'))).toBe(true);
    // And the named pool's own cap holds.
    expect(manager.canSpawn('lookup')).toBe(false);
    expect(manager.track(entry('d', 'lookup'))).toBe(false);
    // An unnamed pool spawn is still blocked by its own cap.
    expect(manager.track(entry('e'))).toBe(false);
    expect(manager.activeCountInPool()).toBe(1);
    expect(manager.activeCountInPool('lookup')).toBe(2);
  });

  it('an unlisted pool falls back to the default limit but counts separately', () => {
    const manager = new SubAgentManager({ maxConcurrent: 1 });
    expect(manager.poolLimit('adhoc')).toBe(1);
    expect(manager.canSpawn('adhoc')).toBe(true);
  });

  it('spawnBackgroundSubAgent in a named pool succeeds while the default pool is full', async () => {
    const agent = createTestAgentLoop({
      maxConcurrentSubAgents: 0,
      subAgentPools: { lookup: 1 },
    });
    let resolvePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => { resolvePrompt = resolve; });
    const child = {
      abort: vi.fn(),
      destroy: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockReturnValue(promptGate),
      getConversationHistory: () => [{ role: 'assistant', content: 'done' }],
      getBudgetGuard: () => ({ getTurnCount: () => 1, getTotalCost: () => 0 }),
      getEventBridge: () => new EventBridge(false),
      currentContextTokenCount: 0,
    };
    (agent as unknown as SpawnInternals).createChildAgent = vi.fn().mockResolvedValue(child);

    // Default pool is capped at zero...
    await expect(
      agent.spawnBackgroundSubAgent({ instructions: 'task work' }),
    ).rejects.toThrow('concurrency limit reached');

    // ...but the lookup pool has its own capacity.
    const { taskId } = await agent.spawnBackgroundSubAgent({
      instructions: 'quick lookup',
      pool: 'lookup',
    });
    expect(agent.getSubAgentManager().get(taskId)?.pool).toBe('lookup');

    resolvePrompt();
    await agent.getSubAgentManager().get(taskId)?.completion;
  });
});

describe('per-spawn child config overrides', () => {
  interface CreateChildInternals {
    createChildAgent: (params: {
      taskId: string;
      instructions: string;
      model?: unknown;
      thinkingLevel?: string;
      compaction?: Partial<CortexCompactionConfig>;
    }) => Promise<unknown>;
  }

  function spyOnManagedCreate() {
    return vi
      .spyOn(AgentLoop as unknown as {
        createManagedAgent: (params: unknown) => Promise<unknown>;
      }, 'createManagedAgent')
      .mockResolvedValue({
        getContextManager: () => ({ setSlot: vi.fn() }),
        setCacheRetention: vi.fn(),
      });
  }

  it('applies model, thinkingLevel, and compaction overrides to the child config', async () => {
    const agent = createTestAgentLoop();
    const override = makeModel({
      provider: 'anthropic',
      name: 'claude-haiku-4-5-20251001',
      contextWindow: 200_000,
    } as PiModel);
    const managedSpy = spyOnManagedCreate();
    try {
      await (agent as unknown as CreateChildInternals).createChildAgent({
        taskId: 'task-1',
        instructions: 'quick lookup',
        model: override,
        thinkingLevel: 'off',
        compaction: { nonBlocking: true },
      });

      const createParams = managedSpy.mock.calls[0]![0] as {
        cortexConfig: AgentLoopConfig;
      };
      expect(createParams.cortexConfig.model).toBe(override);
      expect(createParams.cortexConfig.thinkingLevel).toBe('off');
      expect(createParams.cortexConfig.compaction).toEqual({ nonBlocking: true });
    } finally {
      managedSpy.mockRestore();
    }
  });

  it('defaults to the parent primary model with no thinking or compaction overrides', async () => {
    const agent = createTestAgentLoop();
    const managedSpy = spyOnManagedCreate();
    try {
      await (agent as unknown as CreateChildInternals).createChildAgent({
        taskId: 'task-2',
        instructions: 'normal task',
      });

      const createParams = managedSpy.mock.calls[0]![0] as {
        cortexConfig: AgentLoopConfig;
      };
      expect(createParams.cortexConfig.model).toBe(agent.getModel());
      expect(createParams.cortexConfig.thinkingLevel).toBeUndefined();
      expect(createParams.cortexConfig.compaction).toBeUndefined();
    } finally {
      managedSpy.mockRestore();
    }
  });
});
