/**
 * Every compaction layer measures history on one basis: what buffering
 * waits for, what idle digestion's floor counts, what a chunk records as
 * observed, and the sizes an overflow drop reports all agree with the
 * estimate the swap, the tail and the view cut use.
 */
import { describe, it, expect, vi } from 'vitest';
import { CompactionManager, buildCompactionConfig } from '../../../src/compaction/index.js';
import { ObservationalMemoryEngine } from '../../../src/compaction/observational/index.js';
import type { CompleteFn } from '../../../src/compaction/observational/types.js';
import { historyTokens } from '../../../src/compaction/message-tokens.js';
import { estimateTokens } from '../../../src/token-estimator.js';
import type { AgentMessage } from '../../../src/context-manager.js';
import type { ObservationEvent } from '../../../src/compaction/observational/types.js';
import { makeToolCallMsg, makeToolResultMsg } from './helpers.js';

const OBSERVED = '<observations>\n* (10:00) observed\n</observations>';

/**
 * A tool group whose result is all quotes: 1,250 tokens as text, more than
 * twice that once JSON escapes every quote.
 */
function quotedResult(id: string): AgentMessage[] {
  return [makeToolCallMsg([{ id, name: 'Read' }]), makeToolResultMsg(id, 'Read', '"'.repeat(5_000))];
}

function engineWith(complete: CompleteFn): ObservationalMemoryEngine {
  const engine = new ObservationalMemoryEngine({ maxAttempts: 1, bufferMinTokens: 3_000 });
  engine.setContextWindow(100_000);
  engine.setUtilityModelContextWindow(200_000);
  engine.setCompleteFn(complete);
  return engine;
}

describe('one token basis for history', () => {
  it('buffers at a turn end only once enough has accumulated on that basis', () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    const engine = engineWith(complete);
    const history = [...quotedResult('a'), ...quotedResult('b')];
    // Precondition: under the 3,000-token floor as the swap measures it.
    expect(historyTokens(history)).toBeLessThan(3_000);

    // Past the activation threshold, the interval is the floor.
    engine.onTurnEnd(95_000, 100_000, history, 0);

    expect(complete).not.toHaveBeenCalled();
  });

  it('holds idle digestion to the same floor', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    const engine = engineWith(complete);
    const history = [...quotedResult('a'), ...quotedResult('b')];
    expect(historyTokens(history)).toBeLessThan(3_000);

    expect(await engine.digestPendingBuffers(() => history)).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('records a chunk as observing what its messages weigh', async () => {
    const engine = engineWith(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    const history = [...quotedResult('a'), ...quotedResult('b'), ...quotedResult('c')];

    expect(await engine.digestPendingBuffers(() => history)).toBe(true);

    const [chunk] = engine.getState().bufferedChunks!;
    expect(chunk!.endIndex).toBe(history.length);
    expect(chunk!.messageTokensObserved).toBe(historyTokens(history));
  });

  it('reports an overflow drop leaving what the kept history and the log weigh', () => {
    const manager = new CompactionManager(buildCompactionConfig(), 1);
    manager.setContextWindow(100_000);
    manager.setModelContextWindow(100_000);
    manager.updateCurrentContextTokenCount(150_000);
    const history = Array.from({ length: 20 }, (_, i) =>
      ({ role: i % 2 ? 'assistant' : 'user', content: String(i % 10).repeat(30_000), timestamp: i + 1 }) as AgentMessage);
    manager.memory.restoreState({
      observations: '', continuationHint: null, observationTokenCount: 0, generationCount: 0,
      bufferedChunks: [{ observations: '* (10:00) the first exchanges', messageTokensObserved: 30_000, createdAt: new Date(), endIndex: 4 }],
      bufferWatermark: 4,
    });
    const events: ObservationEvent[] = [];
    manager.memory.onObservation((event) => events.push(event));
    let kept: AgentMessage[] = [];

    manager.handleOverflowError(() => history, (h) => { kept = h; });

    expect(events).toHaveLength(1);
    expect(events[0]!.tokensBefore).toBe(150_000);
    expect(events[0]!.tokensAfter).toBe(historyTokens(kept) + estimateTokens(manager.memory.getSlotContent()));
  });
});
