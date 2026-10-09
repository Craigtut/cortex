/**
 * Memory failures are reported through their own events: onMemoryError for
 * a call that failed after all its attempts, onMemoryRecovered for the first
 * success after failures. Each carries the loop's origin.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../../src/agent-loop.js';
import { wrapModel } from '../../../../src/model-wrapper.js';
import type { AgentLoopConfig, LoopOriginContext } from '../../../../src/types.js';
import type { CompleteFn } from '../../../../src/compaction/observational/types.js';
import type { AgentContext, AgentMessage } from '../../../../src/context-manager.js';
import type { MemoryErrorInfo, MemoryRecoveredInfo } from '../../../../src/compaction/observational/types.js';

type Ctor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

const OBSERVED = '<observations>\n* (10:00) observed\n</observations>';

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
  const raw = { provider: 'anthropic', name: 'model', contextWindow: 200_000 } as PiModel;
  const loop = new (AgentLoop as unknown as Ctor)(
    piAgent,
    {
      model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'Test prompt',
      slots: [],
      contextWindowLimit: 20_000,
      loopPath: 'reasoner',
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

describe('memory events', () => {
  it('reports each failed background call, counting the failures in a row', async () => {
    const { loop, piAgent } = createLoop();
    loop.getCompactionManager().memory.setCompleteFn(
      vi.fn<CompleteFn>().mockRejectedValue(new Error('500 internal server error')),
    );
    const errors: Array<[MemoryErrorInfo, LoopOriginContext]> = [];
    loop.onMemoryError((info, origin) => errors.push([info, origin]));
    seed(piAgent);

    await loop.digestIdle();
    await loop.digestIdle();

    expect(errors.map(([info]) => info.consecutiveFailures)).toEqual([1, 2]);
    const [first, origin] = errors[0]!;
    expect(first).toMatchObject({ operation: 'observe', trigger: 'idle', attempts: 1, outcome: 'retry-later' });
    expect(first.error.message).toContain('500');
    expect(origin.loopPath).toBe('reasoner');
  });

  it('reports recovery once, on the first success after failures', async () => {
    const { loop, piAgent } = createLoop();
    const complete = vi.fn<CompleteFn>()
      .mockRejectedValueOnce(new Error('500 internal server error'))
      .mockRejectedValueOnce(new Error('500 internal server error'))
      .mockResolvedValue(OBSERVED);
    loop.getCompactionManager().memory.setCompleteFn(complete);
    const recovered: MemoryRecoveredInfo[] = [];
    loop.onMemoryRecovered((info) => recovered.push(info));
    seed(piAgent);

    await loop.digestIdle();
    await loop.digestIdle();
    // Precondition: two failures, no recovery yet.
    expect(recovered).toEqual([]);
    await loop.digestIdle();
    piAgent.state.messages.push({ role: 'user', content: 'more '.repeat(6_000), timestamp: 3 } as AgentMessage);
    await loop.digestIdle();

    expect(complete).toHaveBeenCalledTimes(4);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.failures).toBe(2);
  });

  it('reports an in-band failure as a partial swap', async () => {
    const { loop, piAgent } = createLoop();
    loop.getCompactionManager().memory.setCompleteFn(
      vi.fn<CompleteFn>().mockRejectedValue(new Error('500 internal server error')),
    );
    const errors: MemoryErrorInfo[] = [];
    loop.onMemoryError((info) => errors.push(info));
    seed(piAgent);
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    await loop.getTransformContextHook()({
      systemPrompt: '', model: null, messages: piAgent.state.messages as AgentMessage[], tools: [], thinkingLevel: 'medium',
    } as AgentContext);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ operation: 'observe', trigger: 'activation', outcome: 'partial-swap' });
  });
});
