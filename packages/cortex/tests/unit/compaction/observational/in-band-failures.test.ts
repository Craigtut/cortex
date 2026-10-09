/**
 * In-band observer and reflector failures: observational memory never loses
 * recorded observations to a failed call, and transformContext never throws
 * (pi's contract: a throw fails the run with a synthetic error).
 */
import { describe, it, expect, vi } from 'vitest';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import { CompactionManager, buildCompactionConfig } from '../../../../src/compaction/index.js';
import { AgentLoop } from '../../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../../src/agent-loop.js';
import { wrapModel } from '../../../../src/model-wrapper.js';
import type { AgentLoopConfig } from '../../../../src/types.js';
import type { CompleteFn, MemoryErrorInfo } from '../../../../src/compaction/observational/types.js';
import type { AgentContext, AgentMessage } from '../../../../src/context-manager.js';

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });
const assistantMsg = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: 0 });

function context(messages: AgentMessage[]): AgentContext {
  return { systemPrompt: '', model: null, messages, tools: [], thinkingLevel: 'medium' };
}

/** Run one engine activation over `source` behind a single slot. */
async function activate(
  engine: ObservationalMemoryEngine,
  source: AgentMessage[],
  utilization: number,
): Promise<AgentMessage[]> {
  let current = [...source];
  await engine.applyInTransformContext(
    utilization,
    () => current,
    (history) => { current = history; },
  );
  return current;
}

describe('in-band observer failure after chunk activation', () => {
  it('keeps the chunk text and removes only the messages the chunk covered', async () => {
    const engine = new ObservationalMemoryEngine({ maxAttempts: 1 });
    engine.setContextWindow(20_000);
    engine.setUtilityModelContextWindow(200_000);
    const covered = userMsg('covered by the chunk');
    // Unobserved history past the chunk: more than the verbatim tail holds,
    // so the pass tries to observe it in-band, and fails.
    const unbuffered = assistantMsg('u'.repeat(80_000));
    const latest = userMsg('the latest question');
    engine.restoreState({
      observations: '',
      continuationHint: null,
      observationTokenCount: 0,
      generationCount: 0,
      bufferedChunks: [{ observations: 'CHUNK TEXT', messageTokensObserved: 5, createdAt: new Date() }],
      bufferWatermark: 1,
    });
    // The unbuffered remainder keeps utilization over the threshold, so the
    // in-band observer runs after the chunk swap, and fails.
    const complete = vi.fn<CompleteFn>().mockRejectedValue(new Error('utility 529'));
    engine.setCompleteFn(complete);

    const surviving = await activate(engine, [covered, unbuffered, latest], 0.99);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(engine.getObservations()).toContain('CHUNK TEXT');
    expect(surviving).toEqual([unbuffered, latest]);
    expect(engine.getState().bufferedChunks).toEqual([]);
  });
});

describe('in-band reflector failure', () => {
  it('keeps the current observations', async () => {
    const engine = new ObservationalMemoryEngine({ maxAttempts: 1 });
    engine.setContextWindow(20_000); // reflection threshold: 4,000 tokens
    engine.setUtilityModelContextWindow(200_000);
    const log = '* (10:00) a fact worth keeping\n'.repeat(700);
    engine.restoreState({
      observations: log,
      continuationHint: null,
      observationTokenCount: 6_000,
      generationCount: 0,
      bufferedChunks: [],
      bufferWatermark: 0,
    });
    const complete = vi.fn<CompleteFn>().mockImplementation(async (_ctx, options) => {
      if (options?.purpose === 'reflector') throw new Error('reflector overloaded');
      return '<observations>\n* observed\n</observations>';
    });
    engine.setCompleteFn(complete);

    await expect(activate(engine, [userMsg('hello')], 0.95)).resolves.toBeDefined();

    expect(complete.mock.calls.some(([, options]) => options?.purpose === 'reflector')).toBe(true);
    expect(engine.getObservations().startsWith(log)).toBe(true);
  });
});

describe('emergency truncation under the blocking posture', () => {
  it('makes no observer call: the truncation is view-only and the source keeps every message', async () => {
    // Activation is pushed out of reach so only emergency truncation acts.
    const manager = new CompactionManager(
      buildCompactionConfig({ observational: { activationThreshold: 2 } }),
      1,
    );
    manager.setContextWindow(100_000);
    manager.setModelContextWindow(100_000);
    const complete = vi.fn<CompleteFn>().mockResolvedValue('<observations>\n* observed\n</observations>');
    manager.setObservationalCompleteFn(complete);
    manager.updateCurrentContextTokenCount(99_000);

    const history = Array.from({ length: 20 }, (_, i) => (i % 2 ? assistantMsg(`a${i}`) : userMsg(`u${i}`)));
    let source = [...history];
    const result = await manager.applyInTransformContext(
      context([userMsg('slot'), ...history]),
      (ctx) => ctx.messages.slice(1),
      (ctx, h) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...h] }),
      () => source,
      (h) => { source = h; },
    );

    // Precondition: emergency truncation did fire on the view.
    expect(result.messages.length).toBeLessThan(history.length + 1);
    expect(complete).not.toHaveBeenCalled();
    expect(source).toHaveLength(history.length);
  });
});

describe('transformContext never throws', () => {
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
    const raw = { provider: 'anthropic', name: 'model', contextWindow: 200_000 } as PiModel;
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

  it('resolves when the in-band observer rejects', async () => {
    const { loop, piAgent } = createLoop();
    loop.getCompactionManager().setObservationalCompleteFn(
      vi.fn<CompleteFn>().mockRejectedValue(new Error('utility 529')),
    );
    piAgent.state.messages.push(userMsg('w'.repeat(30_000)), assistantMsg('d'.repeat(30_000)));
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    const hook = loop.getTransformContextHook();
    const result = await hook(context(piAgent.state.messages as AgentMessage[]));

    expect(result.messages.length).toBeGreaterThan(0);
  });
});

describe('a hung background observer and in-band passes', () => {
  it('blocks one pass, then degrades instead of waiting again', async () => {
    // Each pass may wait 150ms; the background call would only fail after
    // three 400ms attempts and two backoffs, about 4.2s.
    const engine = new ObservationalMemoryEngine({ blockingBudgetMs: 150, callTimeoutMs: 400, maxAttempts: 3, bufferMinTokens: 10 });
    engine.setContextWindow(20_000);
    engine.setUtilityModelContextWindow(200_000);
    const complete = vi.fn<CompleteFn>(() => new Promise<string>(() => {}));
    engine.setCompleteFn(complete);
    const errors: MemoryErrorInfo[] = [];
    engine.onMemoryError((info) => errors.push(info));
    const source = [userMsg('a'.repeat(40_000)), assistantMsg('b'.repeat(40_000)), userMsg('latest')];
    engine.onTurnEnd(15_000, 20_000, source, 0);
    // Precondition: a background observer over the history is in flight.
    expect(engine.isObserverInFlight()).toBe(true);

    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      await activate(engine, source, 0.95);
      waits.push(Date.now() - started);
    }

    // The first pass waited its budget out and degraded memory.
    expect(waits[0]).toBeGreaterThanOrEqual(140);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ operation: 'observe', trigger: 'activation', consecutiveFailures: 1 });
    // The rest sent their requests without waiting.
    expect(waits[1]).toBeLessThan(50);
    expect(waits[2]).toBeLessThan(50);
    // Nothing called the model beside the one background call.
    expect(complete).toHaveBeenCalledTimes(1);
  }, 10_000);
});

