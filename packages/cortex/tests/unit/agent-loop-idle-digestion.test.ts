/**
 * Idle-digestion entry point: digestIdle() runs pending observation buffers
 * and threshold compaction OUTSIDE a prompt. Observation normally triggers
 * only on turn_end and compaction only inside transformContext; this is the
 * primitive that lets an owner schedule the blocking work during idle
 * windows (and it deliberately overrides the non-blocking posture for its
 * own pass).
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import type { CompleteFn } from '../../src/compaction/observational/types.js';
import { ObservationalMemoryEngine } from '../../src/compaction/observational/index.js';
import { wrapModel } from '../../src/model-wrapper.js';
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

interface DigestMockPiAgent extends PiAgent {
  hangNextRun: boolean;
  releaseRun: () => void;
  promptCalls: Array<string | AgentMessage[]>;
  steeringQueue: Array<{ role: string; content: string }>;
}

function createMockPiAgent(): DigestMockPiAgent {
  let release: (() => void) | null = null;
  const agent: DigestMockPiAgent = {
    state: { messages: [], systemPrompt: '', tools: [] },
    hangNextRun: false,
    promptCalls: [],
    steeringQueue: [],
    subscribe() { return () => {}; },
    async prompt(input: string | AgentMessage[]) {
      agent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      agent.state.messages.push(...messages);
      // Pi polls the steering queue at run start.
      agent.state.messages.push(...(agent.steeringQueue.splice(0) as AgentMessage[]));
      if (agent.hangNextRun) {
        agent.hangNextRun = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      agent.state.messages.push(textAssistant('ok', Date.now()));
      return { content: 'ok' };
    },
    releaseRun() {
      release?.();
      release = null;
    },
    async continue() { throw new Error('not used'); },
    abort() {},
    async waitForIdle() {},
    reset() { agent.state.messages = []; },
    steer(message: { role: string; content: string }) {
      agent.steeringQueue.push(message);
    },
    clearSteeringQueue() {
      agent.steeringQueue = [];
    },
    hasQueuedMessages() {
      return agent.steeringQueue.length > 0;
    },
  };
  return agent;
}

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createLoop(
  piAgent: PiAgent,
  overrides?: Partial<AgentLoopConfig>,
): AgentLoop {
  const Ctor = AgentLoop as unknown as TestAgentLoopConstructor;
  return new Ctor(
    piAgent,
    {
      model: makeModel({
        provider: 'anthropic',
        name: 'claude-sonnet-4-20250514',
        contextWindow: 200_000,
      } as PiModel),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'Test prompt',
      slots: [],
      contextWindowLimit: 20_000,
      ...overrides,
    },
    [],
    { enableSubAgentTool: false, enableLoadSkillTool: false },
  );
}

const OBSERVER_OUTPUT =
  '<observations>\nDate: Apr 10, 2026\n\n* \u{1F7E1} (14:30) Digested observation\n</observations>\n\n' +
  '<current-task>\nDigesting between turns.\n</current-task>\n\n' +
  '<suggested-response>\nContinue.\n</suggested-response>';

/** Push post-slot history big enough to clear the buffering floor (5k tokens). */
function seedHistory(piAgent: PiAgent, chars = 30_000): void {
  piAgent.state.messages.push(
    { role: 'user', content: 'work '.repeat(Math.ceil(chars / 10)), timestamp: 1 } as AgentMessage,
    textAssistant('done '.repeat(Math.ceil(chars / 10)), 2),
  );
}

/**
 * History just past the 4,000-token verbatim tail and under the 5,000-token
 * buffering floor: idle buffering skips it, so the only observer call is
 * the threshold pass's own catch-up.
 */
function seedJustPastTheTail(piAgent: PiAgent): void {
  for (let i = 0; i < 4; i++) {
    piAgent.state.messages.push({
      role: i % 2 ? 'assistant' : 'user',
      content: `m${i} ` + 'w'.repeat(4_500),
      timestamp: i + 1,
    } as AgentMessage);
  }
}

describe('digestIdle (observational)', () => {
  it('buffers the unobserved tail into a chunk without waiting for a turn or a threshold', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);
    const lengthBefore = piAgent.state.messages.length;

    const result = await loop.digestIdle();

    expect(result.observerRan).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    // Below the activation threshold nothing activates: the chunk waits,
    // history is untouched, and the observer work is already paid for.
    expect(result.historyCompacted).toBe(false);
    expect(piAgent.state.messages).toHaveLength(lengthBefore);
    const state = loop.getObservationalMemoryState();
    expect(state?.bufferedChunks).toHaveLength(1);
    expect(state?.bufferWatermark).toBe(2);
  });

  it('skips the observer when the unobserved tail is below the buffering floor', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    piAgent.state.messages.push(
      { role: 'user', content: 'tiny', timestamp: 1 } as AgentMessage,
    );

    const result = await loop.digestIdle();

    expect(result.observerRan).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('activates over the threshold: history trims and the observation slot fills, all between turns', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    // Two exchanges: the older one can leave; the latest stays verbatim.
    seedHistory(piAgent);
    seedHistory(piAgent);
    // Over the activation threshold (default 0.9 of the 20k budget).
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);
    const lengthBefore = piAgent.state.messages.length;

    const result = await loop.digestIdle();

    expect(result.observerRan).toBe(true);
    expect(result.historyCompacted).toBe(true);
    expect(piAgent.state.messages.length).toBeLessThan(lengthBefore);
    expect(loop.getCompactionManager().memory.hasObservations()).toBe(true);
  });

  it('overrides the non-blocking posture for its own pass', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent, { compaction: { nonBlocking: true } });
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    // Two exchanges: the older one can leave; the latest stays verbatim.
    seedHistory(piAgent);
    seedHistory(piAgent);
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    const result = await loop.digestIdle();

    // Under nonBlocking an in-band call would have skipped all of this;
    // the digestion pass runs it deliberately.
    expect(result.observerRan).toBe(true);
    expect(result.historyCompacted).toBe(true);
    expect(loop.getCompactionManager().memory.hasObservations()).toBe(true);
  });
});

describe('digestIdle observer wait bound', () => {
  it('times out a hung observer call instead of wedging the loop gate', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    // A hung provider request: the utility completion never settles.
    const complete = vi.fn(() => new Promise<string>(() => {}));
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);

    // Unbounded, this await never resolves: prompt() then throws forever
    // and wake deliveries wait behind the wedged gate.
    const result = await loop.digestIdle({ observerTimeoutMs: 50 });

    expect(result.observerRan).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
    // The gate is free again: a real prompt can run.
    await waitUntil(() => !loop.isLoopActive);
    await loop.prompt('after the timeout');
    expect(piAgent.promptCalls.some(
      (call) => typeof call === 'string' && call.includes('after the timeout'),
    )).toBe(true);
  });

  it('times out a hung threshold pass (in-band observer) instead of wedging the gate', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    // A hung provider request in the BLOCKING threshold pass (step 2), the
    // phase after the observer waits. Unbounded, digestIdle never resolves
    // and the gate stays wedged while holding forceBlockingCompaction.
    const complete = vi.fn(() => new Promise<string>(() => {}));
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    seedJustPastTheTail(piAgent);
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    const result = await loop.digestIdle({ observerTimeoutMs: 50 });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.observerRan).toBe(false);
    expect(result.historyCompacted).toBe(false);
    // The gate is free again; the hung observer call was abandoned.
    await waitUntil(() => !loop.isLoopActive);
  });
});

describe('digestIdle preemption', () => {
  it('launches nothing more once preempted, so a swap after it cannot mark unobserved messages observed', async () => {
    const piAgent = createMockPiAgent();
    // Non-blocking: the run's activation merges what is buffered, never waits.
    const loop = createLoop(piAgent, {
      compaction: { nonBlocking: true, observational: { bufferMinTokens: 100, bufferTokenCap: 3_500, maxAttempts: 1 } },
    });
    const tags = (text: string): string[] => text.match(/<m\d+>/g) ?? [];
    const seen: string[][] = [];
    const releases: Array<() => void> = [];
    const complete = vi.fn<CompleteFn>((context) => {
      seen.push([...new Set(tags(JSON.stringify(context.messages)))]);
      return new Promise<string>((resolve) => releases.push(() => resolve(OBSERVER_OUTPUT)));
    });
    loop.getCompactionManager().memory.setCompleteFn(complete);
    // About 1,000 tokens a message; a piece holds three. m0 and m1 are
    // already observed.
    const message = (i: number): AgentMessage =>
      ({ role: i % 2 ? 'assistant' : 'user', content: `<m${i}> ` + 'x'.repeat(4_000), timestamp: i + 1 }) as AgentMessage;
    loop.restoreConversationHistory([
      ...Array.from({ length: 7 }, (_, i) => message(i)),
      { role: 'user', content: '<m7> latest', timestamp: 8 },
    ] as never);
    loop.restoreObservationalMemoryState({
      observations: '', continuationHint: null, observationTokenCount: 0, generationCount: 0,
      bufferedChunks: [{ observations: '* m0 m1', messageTokensObserved: 2_000, createdAt: new Date(), endIndex: 2 }],
      bufferWatermark: 2,
    });

    const preempt = new AbortController();
    const digestion = loop.digestIdle({ signal: preempt.signal });
    await waitUntil(() => complete.mock.calls.length === 1);
    expect(seen[0]).toEqual(['<m2>', '<m3>', '<m4>']);
    preempt.abort();
    expect((await digestion).preempted).toBe(true);

    // A run's activation swaps m0 and m1 out: the ledger rebases.
    loop.updateCurrentContextTokenCount(19_500);
    await loop.getTransformContextHook()({
      systemPrompt: '', model: null, messages: piAgent.state.messages, tools: [], thinkingLevel: 'medium',
    } as never);
    expect(tags(JSON.stringify(loop.getConversationHistory()[0]!.content))).toEqual(['<m2>']);

    // The digestion's piece lands; nothing launches after it.
    releases[0]!();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(complete).toHaveBeenCalledTimes(1);
    // Every message the ledger counts as observed was seen by an observer.
    const watermark = loop.getObservationalMemoryState().bufferWatermark!;
    const counted = loop.getConversationHistory().slice(0, watermark)
      .map((m) => tags(JSON.stringify(m.content))[0]!);
    expect(counted.filter((tag) => !seen.flat().includes(tag))).toEqual([]);
    expect(counted).toEqual(['<m2>', '<m3>', '<m4>']);
  });

  it('keeps observing the live history when a run rewrites it between pieces', async () => {
    // Not preempted: a digestion that continues past a swap must cut its
    // next piece from the history as it is now.
    const engine = new ObservationalMemoryEngine({ bufferMinTokens: 100, bufferTokenCap: 3_500, maxAttempts: 1 });
    engine.setContextWindow(20_000);
    engine.setUtilityModelContextWindow(200_000);
    const tags = (text: string): string[] => text.match(/<m\d+>/g) ?? [];
    const seen: string[][] = [];
    const releases: Array<() => void> = [];
    engine.setCompleteFn(vi.fn<CompleteFn>((context) => {
      seen.push([...new Set(tags(JSON.stringify(context.messages)))]);
      return new Promise<string>((resolve) => releases.push(() => resolve(OBSERVER_OUTPUT)));
    }));
    const message = (i: number): AgentMessage =>
      ({ role: i % 2 ? 'assistant' : 'user', content: `<m${i}> ` + 'x'.repeat(4_000), timestamp: 0 }) as AgentMessage;
    let live: AgentMessage[] = [...Array.from({ length: 9 }, (_, i) => message(i)), { role: 'user', content: '<m9> latest', timestamp: 0 }];
    engine.restoreState({
      observations: '', continuationHint: null, observationTokenCount: 0, generationCount: 0,
      bufferedChunks: [{ observations: '* m0 m1', messageTokensObserved: 2_000, createdAt: new Date(), endIndex: 2 }],
      bufferWatermark: 2,
    });

    const digestion = engine.digestPendingBuffers(() => live);
    await waitUntil(() => seen.length === 1);
    // A swap removes m0 and m1 while the first piece is in flight.
    await engine.applyInTransformContext(0.95, () => live, (history) => { live = history; }, { allowSync: false });
    expect(tags(JSON.stringify(live[0]!.content))).toEqual(['<m2>']);

    for (let i = 0; i < 4 && releases[i]; i++) {
      releases[i]!();
      await waitUntil(() => seen.length > i + 1 || i === 3, 200).catch(() => {});
    }
    await digestion;
    const watermark = engine.getState().bufferWatermark!;
    const counted = live.slice(0, watermark).map((m) => tags(JSON.stringify(m.content))[0]!);
    // Precondition: digestion went on past the first piece.
    expect(seen.length).toBeGreaterThan(1);
    expect(counted.filter((tag) => !seen.flat().includes(tag))).toEqual([]);
    // And no message was observed twice.
    expect(new Set(seen.flat()).size).toBe(seen.flat().length);
  });

  it('releases the gate at once when preempted during a hung observer wait', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn(() => new Promise<string>(() => {}));
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);

    const preempt = new AbortController();
    const digestion = loop.digestIdle({ signal: preempt.signal });
    await waitUntil(() => complete.mock.calls.length === 1);
    // Precondition: the pass is holding the gate on the hung observer.
    expect(loop.isLoopActive).toBe(true);

    preempt.abort();
    const result = await digestion;
    expect(result).toMatchObject({ observerRan: false, preempted: true });
    await waitUntil(() => !loop.isLoopActive, 200);
    await loop.prompt('the user spoke');
    expect(piAgent.promptCalls.some(
      (call) => typeof call === 'string' && call.includes('the user spoke'),
    )).toBe(true);
  });

  it('abandons a hung threshold pass when preempted, like a timeout', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn(() => new Promise<string>(() => {}));
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    seedJustPastTheTail(piAgent);
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    const preempt = new AbortController();
    const digestion = loop.digestIdle({ signal: preempt.signal });
    await waitUntil(() => complete.mock.calls.length > 0);
    preempt.abort();

    const result = await digestion;
    expect(result).toMatchObject({ historyCompacted: false, preempted: true });
    await waitUntil(() => !loop.isLoopActive, 200);
  });
});

describe('digestIdle abandoned pass invalidation', () => {
  // The dangerous shape is hang-then-SETTLE, not hang-forever: nothing can
  // cancel the hung utility call, so after the timeout lowers the gate and
  // a real prompt appends live messages, the abandoned pass's continuation
  // eventually runs. Pre-fix it replaced the whole post-slot history from
  // its stale snapshot; it must discard itself instead.

  function messageTexts(piAgent: PiAgent): string[] {
    return piAgent.state.messages.map((m) =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    );
  }

  /**
   * Drain the abandoned pass's continuation chain. Once its hung promise
   * is resolved the rest of the chain is microtasks only, so one macrotask
   * hop is a hard barrier, not a timing-dependent sleep. Two for margin.
   */
  async function drainSettledContinuations(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('a timed-out observational pass that later settles does not wipe messages a real prompt appended', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const releases: Array<(value: string) => void> = [];
    const complete = vi.fn(
      () => new Promise<string>((resolve) => { releases.push(resolve); }),
    );
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);
    // Over the activation threshold so the pass reaches the sync observer.
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    // Both the buffering catch-up and the threshold pass's sync observer
    // hang past the deadline; the digestion times out and abandons them.
    const result = await loop.digestIdle({ observerTimeoutMs: 30 });
    expect(result.historyCompacted).toBe(false);

    // The gate is free: a real prompt runs and appends live messages.
    await loop.prompt('after timeout question');
    const lengthAfterPrompt = piAgent.state.messages.length;
    expect(messageTexts(piAgent).some((t) => t.includes('after timeout question'))).toBe(true);

    // Now the hung observer calls SETTLE. The abandoned pass's continuation
    // must discard its stale rewrite instead of destroying live history.
    for (const release of releases.splice(0)) release(OBSERVER_OUTPUT);
    await drainSettledContinuations();

    expect(piAgent.state.messages.length).toBe(lengthAfterPrompt);
    expect(messageTexts(piAgent).some((t) => t.includes('after timeout question'))).toBe(true);
  });

  it("a timed-out threshold pass whose own observer later settles does not rewrite live history", async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    let releaseObserver!: (value: string) => void;
    const complete = vi.fn(
      () => new Promise<string>((resolve) => { releaseObserver = resolve; }),
    );
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    seedJustPastTheTail(piAgent);
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    const result = await loop.digestIdle({ observerTimeoutMs: 30 });
    expect(result.historyCompacted).toBe(false);
    // Precondition: the hung call is the threshold pass's, not buffering's.
    expect(complete).toHaveBeenCalledTimes(1);

    await loop.prompt('after the timeout');
    const lengthAfterPrompt = piAgent.state.messages.length;

    releaseObserver(OBSERVER_OUTPUT);
    await drainSettledContinuations();

    expect(piAgent.state.messages.length).toBe(lengthAfterPrompt);
    expect(messageTexts(piAgent).some((t) => t.includes('after the timeout'))).toBe(true);
  });

  it('an abandoned pass settling mid-flight does not strip the blocking posture from a later pass', async () => {
    const piAgent = createMockPiAgent();
    // nonBlocking: the posture under which the clobber is destructive. A
    // later pass degraded to it skips every blocking path and does nothing.
    const loop = createLoop(piAgent, {
      compaction: { nonBlocking: true },
    });
    let releaseFirst: ((value: string) => void) | null = null;
    const complete = vi.fn((): Promise<string> => {
      if (releaseFirst === null) {
        return new Promise<string>((resolve) => { releaseFirst = resolve; });
      }
      return Promise.resolve(OBSERVER_OUTPUT);
    });
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    seedJustPastTheTail(piAgent);
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    // Pass 1: the threshold pass's observer hangs, the pass times out and
    // is abandoned while still awaiting its hung call.
    await loop.digestIdle({ observerTimeoutMs: 20 });
    expect(complete).toHaveBeenCalledTimes(1);

    // Pass 2: intercept the pipeline INSIDE its window between raising the
    // blocking flag and reading it, and settle pass 1 there. Its abandoned
    // finally must not lower the flag out from under pass 2.
    const mgr = loop.getCompactionManager();
    const managerAny = mgr as unknown as {
      applyInsertionCap: (...args: unknown[]) => Promise<unknown>;
      applyInTransformContext: (...args: unknown[]) => Promise<unknown>;
    };
    const originalCap = managerAny.applyInsertionCap.bind(mgr);
    let settledPassOne = false;
    managerAny.applyInsertionCap = async (...args: unknown[]) => {
      if (!settledPassOne) {
        settledPassOne = true;
        releaseFirst!(OBSERVER_OUTPUT);
        // Macrotask barrier: pass 1's remaining chain is microtasks only,
        // so it has fully settled (including its finally) after this hop.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return originalCap(...args);
    };
    const optionsSeen: unknown[] = [];
    const originalApply = managerAny.applyInTransformContext.bind(mgr);
    managerAny.applyInTransformContext = async (...args: unknown[]) => {
      optionsSeen.push(args[5]);
      return originalApply(...args);
    };

    await loop.digestIdle({ observerTimeoutMs: 5_000 });

    // Pass 2 still ran under the blocking posture its own digestIdle set.
    expect(settledPassOne).toBe(true);
    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0]).toMatchObject({ allowBlocking: true });
  });
});

describe('digestIdle gate serialization', () => {
  it('waits for a running turn instead of racing its history mutations', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);

    piAgent.hangNextRun = true;
    const turn = loop.prompt('long task');
    await new Promise((resolve) => setTimeout(resolve, 10));

    let digested = false;
    const digestion = loop.digestIdle().then((r) => {
      digested = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Still queued behind the running turn.
    expect(digested).toBe(false);
    expect(complete).not.toHaveBeenCalled();

    piAgent.releaseRun();
    await turn;
    const result = await digestion;
    expect(digested).toBe(true);
    expect(result.observerRan).toBe(true);
  });

  it('throws once the loop is shutting down', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.destroy();

    await expect(loop.digestIdle()).rejects.toThrow('destroyed');
  });
});

describe('digestIdle and deliver interleaving', () => {
  it('a wake delivery during idle digestion still runs a turn once the digest completes', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    let releaseObserver!: (value: string) => void;
    const complete = vi.fn(
      () => new Promise<string>((resolve) => { releaseObserver = resolve; }),
    );
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    seedHistory(piAgent);

    const digestion = loop.digestIdle();
    await waitUntil(() => complete.mock.calls.length === 1);

    // The gate is held by the digest, which never starts a pi run. Without
    // the sweep, the parked content would wait for some unrelated later
    // run (an unprompted response) instead of getting a run of its own.
    const result = loop.deliver('urgent while digesting');
    expect(result.outcome).toBe('parked');

    releaseObserver(OBSERVER_OUTPUT);
    await digestion;

    // A turn actually runs with the delivered content.
    await waitUntil(() => piAgent.promptCalls.some(
      (call) => typeof call === 'string' && call.includes('urgent while digesting'),
    ));
    expect(piAgent.steeringQueue).toEqual([]);
    await waitUntil(() => !loop.isLoopActive);
  });
});

describe('digestIdle abandoned pass event suppression', () => {
  // A pass abandoned by the timeout has its history rewrite discarded, but
  // the manager's and the observational engine's handler dispatch used to
  // fire anyway when the hung call finally settled: a consumer saw a
  // compaction or observation reported for a rewrite that never landed.

  async function drainSettledContinuations(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('a timed-out observational pass that later settles fires no observation event', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const releases: Array<(value: string) => void> = [];
    const complete = vi.fn(
      () => new Promise<string>((resolve) => { releases.push(resolve); }),
    );
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    const observed = vi.fn();
    loop.onObservation(observed);
    seedHistory(piAgent);
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    const result = await loop.digestIdle({ observerTimeoutMs: 30 });
    expect(result.historyCompacted).toBe(false);

    for (const release of releases.splice(0)) release(OBSERVER_OUTPUT);
    await drainSettledContinuations();

    // The rewrite was discarded, so no observation may be reported either.
    expect(observed).not.toHaveBeenCalled();
  });

  it('a live observational pass still fires its observation event', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().memory.setCompleteFn(complete as unknown as CompleteFn);
    const observed = vi.fn();
    loop.onObservation(observed);
    // Two exchanges: the older one can leave; the latest stays verbatim.
    seedHistory(piAgent);
    seedHistory(piAgent);
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    const result = await loop.digestIdle({ observerTimeoutMs: 5_000 });
    expect(result.historyCompacted).toBe(true);
    expect(observed).toHaveBeenCalled();
  });
});

describe('digestIdle and the loop transform hook', () => {
  it('runs its threshold pass through getTransformContextHook, so a wrapper sees it', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const original = loop.getTransformContextHook.bind(loop);
    const wrapped = vi.fn();
    vi.spyOn(loop, 'getTransformContextHook').mockImplementation(() => {
      const hook = original();
      return async (context) => {
        wrapped();
        return hook(context);
      };
    });
    await loop.digestIdle();
    expect(wrapped).toHaveBeenCalledTimes(1);
  });
});
