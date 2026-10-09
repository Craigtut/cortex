/**
 * Restoring history replaces what observational memory described. Memory work
 * from the replaced state must not land in the restored one, and history
 * restored with no memory must not inherit the previous log and watermark.
 */
import { describe, it, expect, vi } from 'vitest';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import { BufferingCoordinator } from '../../../../src/compaction/observational/buffering.js';
import { CompactionManager } from '../../../../src/compaction/index.js';
import { AgentLoop } from '../../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../../src/agent-loop.js';
import { wrapModel } from '../../../../src/model-wrapper.js';
import type { AgentLoopConfig } from '../../../../src/types.js';
import type { CompleteFn } from '../../../../src/compaction/observational/types.js';
import type { AgentMessage } from '../../../../src/context-manager.js';
import type { ObservationalMemoryState } from '../../../../src/compaction/observational/types.js';

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 1 });

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => { resolve = r; });
  return { promise, resolve };
}

const SAVED: ObservationalMemoryState = {
  observations: '* (09:00) restored session fact',
  continuationHint: null,
  observationTokenCount: 8,
  generationCount: 0,
  bufferedChunks: [],
  bufferWatermark: 0,
};

describe('restoring observational state', () => {
  it('an observer in flight from before the restore does not land', async () => {
    const engine = new ObservationalMemoryEngine({ bufferMinTokens: 100 }, 0);
    engine.setContextWindow(100_000);
    engine.setUtilityModelContextWindow(200_000);
    const pending = deferred();
    engine.setCompleteFn(vi.fn<CompleteFn>().mockReturnValue(pending.promise));
    // An observer launches over 3 messages of the current session.
    engine.onTurnEnd(85_000, 100_000, [userMsg('a'.repeat(8_000)), userMsg('b'), userMsg('c')], 0);
    expect(engine.isObserverInFlight()).toBe(true);

    engine.restoreState(SAVED, 1);
    pending.resolve('<observations>\n* replaced session\n</observations>');
    await flushPromises();

    expect(engine.getState().bufferedChunks).toEqual([]);
    expect(engine.getState().bufferWatermark).toBe(0);
  });

  it('a reflector in flight from before the restore leaves nothing buffered', async () => {
    const buffering = new BufferingCoordinator();
    const pending = deferred();
    buffering.launchReflector(vi.fn<CompleteFn>().mockReturnValue(pending.promise), 'o'.repeat(4_000), {
      reflectionThreshold: 100_000,
    });

    buffering.restoreState({ chunks: [], watermark: 0 });
    pending.resolve('<observations>\n* reflected old log\n</observations>');
    await flushPromises();

    expect(buffering.isReflectorInFlight()).toBe(false);
    expect(buffering.consumeBufferedReflection()).toBeNull();
  });
});

describe('restoring history', () => {
  type Ctor = new (
    agent: PiAgent,
    config: AgentLoopConfig,
    tools?: unknown[],
    options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
  ) => AgentLoop;

  function createLoop(prompt?: (agent: PiAgent, input: string) => Promise<unknown>): { loop: AgentLoop; piAgent: PiAgent } {
    const piAgent = {
      state: { messages: [] as AgentMessage[], systemPrompt: '', tools: [] },
      subscribe() { return () => {}; },
      async prompt(input: string) { return prompt?.(piAgent, input); },
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
      },
      [],
      { enableSubAgentTool: false, enableLoadSkillTool: false },
    );
    return { loop, piAgent };
  }

  it('with no memory to go with it, starts observational memory empty', () => {
    const { loop } = createLoop();
    loop.restoreConversationHistory([userMsg('first session'), userMsg('more')]);
    loop.restoreObservationalMemoryState({
      ...SAVED,
      bufferedChunks: [{ observations: 'chunk', messageTokensObserved: 1, createdAt: new Date() }],
      bufferWatermark: 2,
    });
    // Precondition: the first session's memory is in place.
    expect(loop.getObservationalMemoryState()?.observations).toContain('restored session fact');

    loop.restoreConversationHistory([userMsg('a different session')]);

    const state = loop.getObservationalMemoryState();
    expect(state?.observations).toBe('');
    expect(state?.bufferedChunks).toEqual([]);
    expect(state?.bufferWatermark).toBe(0);
    expect(loop.getContextManager().getSlot('_observations')).toBe('');
  });

  it('guard: a provider overflow keeps the observation log (the truncation is not a restore)', async () => {
    const truncate = vi.spyOn(CompactionManager.prototype, 'handleOverflowError');
    const { loop } = createLoop(async (agent, input) => {
      agent.state.messages.push({ role: 'user', content: input, timestamp: 2 } as AgentMessage);
      (agent.state as Record<string, unknown>)['errorMessage'] = 'prompt is too long: 213462 tokens > 200000 maximum';
      agent.state.messages.push({ role: 'assistant', content: [], stopReason: 'error', timestamp: 3 } as never);
      return undefined;
    });
    loop.restoreConversationHistory([userMsg('earlier')]);
    loop.restoreObservationalMemoryState(SAVED);

    await expect(loop.prompt('hi')).rejects.toThrow();

    // Precondition: the overflow path ran.
    expect(truncate).toHaveBeenCalledTimes(1);
    expect(loop.getObservationalMemoryState()?.observations).toBe(SAVED.observations);
    truncate.mockRestore();
  });
});
