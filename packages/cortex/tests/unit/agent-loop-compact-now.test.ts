/**
 * compactNow and observeNow: the explicit entry points.
 *
 * compactNow swaps observations in whatever the utilization, keeping the
 * verbatim tail; it waits for the background observer instead of observing
 * its messages again, and a failed observer call changes nothing. With
 * `observe: false` it never calls the memory model. observeNow records
 * everything once and removes nothing. Both wait for a running turn.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { CompleteFn } from '../../src/compaction/observational/types.js';
import type { ObservationEvent } from '../../src/compaction/index.js';
import { wrapModel } from '../../src/model-wrapper.js';

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

interface HoldingPiAgent extends PiAgent {
  holdNextRun: boolean;
  releaseRun: () => void;
  runs: number;
}

function createPiAgent(): HoldingPiAgent {
  let release: (() => void) | null = null;
  const agent: HoldingPiAgent = {
    state: { messages: [], systemPrompt: '', tools: [] },
    holdNextRun: false,
    runs: 0,
    subscribe() { return () => {}; },
    async prompt(input: string | AgentMessage[]) {
      agent.runs++;
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      agent.state.messages.push(...messages);
      if (agent.holdNextRun) {
        agent.holdNextRun = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      agent.state.messages.push({ role: 'assistant', content: 'ok', timestamp: Date.now() });
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
    steer() {},
    clearSteeringQueue() {},
    hasQueuedMessages() { return false; },
  };
  return agent;
}

function createLoop(piAgent: PiAgent, observational: Record<string, unknown> = {}): AgentLoop {
  const Ctor = AgentLoop as unknown as TestAgentLoopConstructor;
  const raw = { provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel;
  return new Ctor(
    piAgent,
    {
      model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'Test prompt',
      slots: [],
      // Tail budget: 20% of 20,000 = 4,000 tokens.
      contextWindowLimit: 20_000,
      compaction: { observational: { maxAttempts: 1, ...observational } },
    },
    [],
    { enableSubAgentTool: false, enableLoadSkillTool: false },
  );
}

const OBSERVED = '<observations>\n* (10:00) observed\n</observations>';

const user = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 1 });
const assistant = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: 2 });

/**
 * An older exchange (about 10k tokens) and a recent one that fits the tail,
 * each message tagged so an observer call's input can be read back.
 */
function seed(piAgent: PiAgent): { older: AgentMessage[]; recent: AgentMessage[] } {
  const older = [user('<m0> ' + 'a'.repeat(20_000)), assistant('<m1> ' + 'b'.repeat(20_000))];
  const recent = [user('<m2> the latest question'), assistant('<m3> ' + 'c'.repeat(2_000))];
  piAgent.state.messages.push(...older, ...recent);
  return { older, recent };
}

/** Tags of the messages each observer call was given, per call. */
function observedTags(complete: ReturnType<typeof vi.fn<CompleteFn>>): string[][] {
  return complete.mock.calls
    .filter(([, options]) => options?.purpose !== 'reflector')
    .map(([context]) => JSON.stringify(context.messages).match(/<m\d+>/g) ?? []);
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('compactNow', () => {
  it('swaps below the activation threshold, keeping the verbatim tail', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    loop.getCompactionManager().setObservationalCompleteFn(complete);
    const { recent } = seed(piAgent);
    const events: ObservationEvent[] = [];
    loop.onObservation((event) => events.push(event));
    // Measured at 50%: below the 90% activation threshold.
    loop.updateCurrentContextTokenCount(10_000);

    const result = await loop.compactNow();

    expect(result.status).toBe('compacted');
    if (result.status !== 'compacted') return;
    expect(result.removedMessages).toBe(2);
    expect(result.tokensBefore).toBeGreaterThanOrEqual(10_000);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(loop.getConversationHistory()).toEqual(recent);
    expect(loop.getObservationalMemoryState()?.observations).toContain('observed');
    expect(loop.getContextManager().getSlot('_observations')).toContain('observed');
    // The measured context no longer exists.
    expect(loop.currentContextTokenCount).toBe(0);
    expect(events.map((event) => event.trigger)).toEqual(['compact-now']);
    expect(events[0]!.removedMessages).toHaveLength(2);
  });

  it('waits for the observer already running and never observes its messages again', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    let release: (reply: string) => void = () => {};
    const complete = vi.fn<CompleteFn>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue(OBSERVED);
    const manager = loop.getCompactionManager();
    manager.setObservationalCompleteFn(complete);
    seed(piAgent);
    // A turn end launches a background observer over the history.
    manager.onTurnEnd(16_000, 20_000, piAgent.state.messages, loop.getContextManager().historyStart);
    expect(complete).toHaveBeenCalledTimes(1);

    const compacting = loop.compactNow();
    await settle();
    // Still waiting on the background call, not observing beside it.
    expect(complete).toHaveBeenCalledTimes(1);
    release(OBSERVED);
    const result = await compacting;

    expect(result.status).toBe('compacted');
    // The background chunk covered everything outside the tail.
    expect(complete).toHaveBeenCalledTimes(1);
    const tags = observedTags(complete).flat();
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('changes neither history nor the log when the observer fails', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    loop.getCompactionManager().setObservationalCompleteFn(
      vi.fn<CompleteFn>().mockRejectedValue(new Error('500 internal server error')),
    );
    seed(piAgent);
    const before = loop.getConversationHistory();

    const result = await loop.compactNow();

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.message).toContain('500');
    expect(loop.getConversationHistory()).toEqual(before);
    expect(loop.getObservationalMemoryState()?.observations).toBe('');
  });

  it('keeps the pieces observed before a failure, so the next call does not repeat them', async () => {
    const piAgent = createPiAgent();
    // One message per observer call.
    const loop = createLoop(piAgent, { bufferTokenCap: 3_000 });
    const complete = vi.fn<CompleteFn>()
      .mockResolvedValueOnce(OBSERVED)
      .mockRejectedValueOnce(new Error('500 internal server error'))
      .mockResolvedValue(OBSERVED);
    loop.getCompactionManager().setObservationalCompleteFn(complete);
    const { older } = seed(piAgent);
    const before = loop.getConversationHistory();

    const failed = await loop.compactNow();

    expect(failed.status).toBe('failed');
    expect(loop.getConversationHistory()).toEqual(before);
    expect(loop.getObservationalMemoryState()?.observations).toBe('');
    expect(loop.getObservationalMemoryState()?.bufferedChunks).toHaveLength(1);

    const retried = await loop.compactNow();

    expect(retried.status).toBe('compacted');
    expect(loop.getConversationHistory()).not.toContain(older[0]);
    const tags = observedTags(complete);
    // Call 1 observed <m0>, call 2 failed on <m1>, call 3 observed <m1> only.
    expect(tags[0]).toEqual(['<m0>']);
    expect(tags[2]).toEqual(['<m1>']);
  });

  it('reports a failed reflection and keeps the swap', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    loop.getCompactionManager().setObservationalCompleteFn(vi.fn<CompleteFn>().mockImplementation(async (_context, options) => {
      if (options?.purpose === 'reflector') throw new Error('500 internal server error');
      return OBSERVED;
    }));
    const { older, recent } = seed(piAgent);
    loop.restoreConversationHistory([...older, ...recent] as PiAgentMessage[]);
    // A log past the reflection threshold (20% of 20,000 tokens).
    loop.restoreObservationalMemoryState({
      observations: '* (09:00) an older fact\n'.repeat(1_200),
      continuationHint: null,
      observationTokenCount: 6_000,
      generationCount: 0,
      bufferedChunks: [],
      bufferWatermark: 0,
    });

    const result = await loop.compactNow();

    expect(result.status).toBe('compacted');
    if (result.status !== 'compacted') return;
    expect(result.reflection.status).toBe('failed');
    expect(loop.getConversationHistory()).toEqual(recent);
  });

  it('has nothing to compact when the history fits the tail', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    loop.getCompactionManager().setObservationalCompleteFn(complete);
    piAgent.state.messages.push(user('hello'), assistant('hi'));

    expect(await loop.compactNow()).toEqual({ status: 'nothing-to-compact' });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('compactNow without observing', () => {
  it('never calls the memory model and swaps only what is already observed', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    loop.getCompactionManager().setObservationalCompleteFn(complete);
    const { older, recent } = seed(piAgent);

    // Nothing observed yet: nothing can leave.
    expect(await loop.compactNow({ observe: false })).toEqual({ status: 'nothing-to-compact' });

    loop.restoreConversationHistory([...older, ...recent] as PiAgentMessage[]);
    loop.restoreObservationalMemoryState({
      observations: '',
      continuationHint: null,
      observationTokenCount: 0,
      generationCount: 0,
      bufferedChunks: [{ observations: '* (10:00) the older exchange', messageTokensObserved: 10_000, createdAt: new Date(), endIndex: 2 }],
      bufferWatermark: 2,
    });
    const result = await loop.compactNow({ observe: false });

    expect(result.status).toBe('compacted');
    expect(loop.getConversationHistory()).toEqual(recent);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not wait for an observer in flight', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn<CompleteFn>().mockImplementation(() => new Promise(() => {}));
    const manager = loop.getCompactionManager();
    manager.setObservationalCompleteFn(complete);
    seed(piAgent);
    manager.onTurnEnd(16_000, 20_000, piAgent.state.messages, loop.getContextManager().historyStart);
    expect(manager.isObserverInFlight()).toBe(true);

    expect(await loop.compactNow({ observe: false })).toEqual({ status: 'nothing-to-compact' });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('observeNow', () => {
  it('records everything once and removes nothing; a second call observes nothing', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    loop.getCompactionManager().setObservationalCompleteFn(complete);
    seed(piAgent);
    const before = loop.getConversationHistory();

    expect(await loop.observeNow()).toEqual({ status: 'observed', observedMessages: 4 });
    expect(await loop.observeNow()).toEqual({ status: 'nothing-to-observe' });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(loop.getConversationHistory()).toEqual(before);
    expect(loop.getObservationalMemoryState()?.observations).toContain('observed');
    expect(loop.getObservationalMemoryState()?.observedPrefix).toBe(4);
  });

  it('leaves the log unchanged when the observer fails', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    loop.getCompactionManager().setObservationalCompleteFn(
      vi.fn<CompleteFn>().mockRejectedValue(new Error('500 internal server error')),
    );
    seed(piAgent);

    const result = await loop.observeNow();

    expect(result.status).toBe('failed');
    expect(loop.getObservationalMemoryState()?.observations).toBe('');
  });
});

describe('a running turn', () => {
  it('holds compactNow and observeNow until it ends', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    loop.getCompactionManager().setObservationalCompleteFn(complete);
    seed(piAgent);
    piAgent.holdNextRun = true;
    const turn = loop.prompt('keep going');
    await settle();
    expect(piAgent.runs).toBe(1);

    const compacting = loop.compactNow();
    const observing = loop.observeNow();
    await settle();
    expect(complete).not.toHaveBeenCalled();

    piAgent.releaseRun();
    await turn;
    await Promise.all([compacting, observing]);
    expect(complete).toHaveBeenCalled();
  });
});
