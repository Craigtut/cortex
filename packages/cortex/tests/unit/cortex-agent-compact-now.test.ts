/**
 * CortexAgent.compactNow compacts every resident loop and says what each
 * did. The reasoner runs the full sequence; the talker, which the user is
 * waiting on, swaps in only what it has already observed and never waits
 * on the memory model, not even behind an idle digestion pass.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createDuplexScenario,
  createPassthroughScenario,
  destroyLiveFacades,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { AgentMessage } from '../../src/context-manager.js';
import type { CompleteFn } from '../../src/compaction/observational/types.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

const OBSERVED = '<observations>\n* (10:00) observed\n</observations>';

/** An older exchange that cannot fit a 4,000-token tail, then a short one. */
function seed(messages: AgentMessage[]): void {
  messages.push(
    { role: 'user', content: 'a'.repeat(20_000), timestamp: 1 } as AgentMessage,
    { role: 'assistant', content: 'b'.repeat(20_000), timestamp: 2 } as AgentMessage,
    { role: 'user', content: 'the latest question', timestamp: 3 } as AgentMessage,
    { role: 'assistant', content: 'c'.repeat(2_000), timestamp: 4 } as AgentMessage,
  );
}

describe('CortexAgent.compactNow', () => {
  it('reports the one loop in passthrough', async () => {
    const h = createPassthroughScenario();
    h.facade.setContextWindowLimit(20_000);
    h.reasonerLoop.getCompactionManager().setObservationalCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    seed(h.reasonerPi.state.messages);

    const result = await h.facade.compactNow();

    expect(result.reasoner.status).toBe('compacted');
    expect('talker' in result).toBe(false);
  });

  it('compacts both loops in duplex, and the talker never calls its memory model', async () => {
    const h = createDuplexScenario();
    // Tail budget: 20% of 20,000 tokens, on both loops.
    h.facade.setContextWindowLimit(20_000);
    h.reasonerLoop.getCompactionManager().setObservationalCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    const talkerMemory = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    h.talkerLoop.getCompactionManager().setObservationalCompleteFn(talkerMemory);
    seed(h.reasonerPi.state.messages);
    seed(h.talkerPi.state.messages);
    // The talker has its older exchange observed already.
    const talkerHistory = h.talkerLoop.getConversationHistory();
    h.talkerLoop.restoreConversationHistory(talkerHistory);
    h.talkerLoop.restoreObservationalMemoryState({
      observations: '',
      continuationHint: null,
      observationTokenCount: 0,
      generationCount: 0,
      bufferedChunks: [{ observations: '* (10:00) the older exchange', messageTokensObserved: 10_000, createdAt: new Date(), endIndex: 2 }],
      bufferWatermark: 2,
    });

    const result = await h.facade.compactNow();

    expect(result.reasoner.status).toBe('compacted');
    expect(result.talker?.status).toBe('compacted');
    expect(talkerMemory).not.toHaveBeenCalled();
    expect(h.talkerLoop.getConversationHistory()).toEqual(talkerHistory.slice(2));
  });

  it('does not wait behind an idle digestion pass', async () => {
    const h = createDuplexScenario({ duplex: { idleDigestionDelayMs: 5 } });
    const hung = vi.fn(() => new Promise<string>(() => {}));
    h.talkerLoop.getCompactionManager().setObservationalCompleteFn(hung as unknown as CompleteFn);
    h.talkerPi.state.messages.push(
      { role: 'user', content: 'talk '.repeat(3_000), timestamp: 1 } as AgentMessage,
      { role: 'assistant', content: 'reply '.repeat(3_000), timestamp: 2 } as AgentMessage,
    );
    h.talkerPi.script = [{ text: 'Hello.' }];
    await h.facade.prompt('hi');
    await waitUntil(() => hung.mock.calls.length === 1, 2000, 'digestion started');
    // Precondition: the digestion pass holds the talker's gate.
    expect(h.talkerLoop.isLoopActive).toBe(true);
    expect(h.talkerLoop.isPrompting).toBe(false);

    let settled = false;
    void h.facade.compactNow().then(() => { settled = true; });

    // Well inside the 60s the pass would otherwise hold the gate.
    await waitUntil(() => settled, 500, 'compactNow returned');
    expect(hung).toHaveBeenCalledTimes(1);
  });
});
