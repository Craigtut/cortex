/**
 * The loop's wiring of observational memory calls: they carry the call's
 * signal into the utility completion, end with the run's abort, report
 * failures through the memory events (and the event bridge) instead of
 * onError, and forward from sub-agents like every bridge event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockComplete = vi.fn();

vi.mock('../../../../src/model-runtime.js', () => ({
  streamModel: (...args: unknown[]) => ({ result: () => mockComplete(...args) }),
}));

import { AgentLoop } from '../../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../../src/agent-loop.js';
import { EventBridge } from '../../../../src/event-bridge.js';
import type { CortexEvent } from '../../../../src/event-bridge.js';
import { wrapModel } from '../../../../src/model-wrapper.js';
import type { AgentLoopConfig } from '../../../../src/types.js';
import type { CompleteFn } from '../../../../src/compaction/compaction.js';
import type { AgentContext, AgentMessage } from '../../../../src/context-manager.js';
import { partsOf } from '../../agent-loop/parts.js';

type Ctor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

function createLoop(): { loop: AgentLoop; piAgent: PiAgent } {
  const piAgent = {
    state: { messages: [] as AgentMessage[], systemPrompt: '', tools: [] },
    subscribe() { return () => {}; },
    async prompt() { return {}; },
    async continue() { return {}; },
    abort() {},
    async waitForIdle() {},
    reset() {},
    steer() {},
    clearSteeringQueue() {},
    hasQueuedMessages() { return false; },
  } as unknown as PiAgent;
  const raw = { provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel;
  const loop = new (AgentLoop as unknown as Ctor)(
    piAgent,
    {
      model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'Test prompt',
      slots: [],
      contextWindowLimit: 20_000,
      compaction: { observational: { maxAttempts: 1 } },
    },
    [],
    { enableSubAgentTool: false, enableLoadSkillTool: false },
  );
  return { loop, piAgent };
}

function seed(piAgent: PiAgent): void {
  piAgent.state.messages.push(
    { role: 'user', content: 'work '.repeat(3_000), timestamp: 1 } as AgentMessage,
    { role: 'assistant', content: 'done '.repeat(3_000), timestamp: 2 } as AgentMessage,
  );
}

beforeEach(() => {
  mockComplete.mockReset();
});

describe('memory call wiring', () => {
  it('reports a failed observer call through onMemoryError and the bridge, not onError', async () => {
    mockComplete.mockRejectedValue(new Error('529 overloaded_error: Overloaded'));
    const { loop, piAgent } = createLoop();
    const onError = vi.fn();
    const onMemoryError = vi.fn();
    const bridgeEvents: CortexEvent[] = [];
    loop.onError(onError);
    loop.onMemoryError(onMemoryError);
    loop.getEventBridge().on('memory', (event) => bridgeEvents.push(event));
    seed(piAgent);

    await loop.digestIdle();

    // Precondition: the observer reached the utility model and failed.
    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(onMemoryError).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(bridgeEvents.map((e) => (e.payload as { kind: string }).kind)).toEqual(['error']);
  });

  it('passes the call signal into the utility completion', async () => {
    mockComplete.mockRejectedValue(new Error('529 overloaded_error: Overloaded'));
    const { loop, piAgent } = createLoop();
    seed(piAgent);

    await loop.digestIdle();

    const options = mockComplete.mock.calls[0]![2] as { signal?: unknown } | undefined;
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("ends the in-band pass when the run's abort fires", async () => {
    const { loop, piAgent } = createLoop();
    loop.getCompactionManager().setObservationalCompleteFn(
      vi.fn<CompleteFn>().mockReturnValue(new Promise<string>(() => {})),
    );
    seed(piAgent);
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    const pass = loop.getTransformContextHook()({
      systemPrompt: '', model: null, messages: piAgent.state.messages as AgentMessage[], tools: [], thinkingLevel: 'medium',
    } as AgentContext);
    await new Promise((resolve) => setTimeout(resolve, 0));
    partsOf(loop).abortState.abortCurrent();

    await expect(pass).resolves.toBeDefined();
  });
});

describe('memory events from a sub-agent', () => {
  it('forward to the parent bridge with the child task id', () => {
    const parent = new EventBridge(false);
    const child = new EventBridge(false);
    const received: CortexEvent[] = [];
    parent.on('memory', (event) => received.push(event));
    parent.forwardFrom(child, 'task-7');

    child.emitMemory({ kind: 'recovered', info: { failures: 2, degradedForMs: 1_000 } });

    expect(received).toHaveLength(1);
    expect(received[0]!.childTaskId).toBe('task-7');
  });
});
