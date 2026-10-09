/**
 * Buffered observations carry the message range they cover. That is what
 * lets an observer in flight survive a swap (it lands at its shifted range
 * instead of being discarded and repeated), keeps every observer call within
 * the utility model's input, and lets older saved state restore without
 * losing its chunks.
 */
import { describe, it, expect, vi } from 'vitest';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import { runObserver } from '../../../../src/compaction/observational/observer.js';
import type { CompleteFn } from '../../../../src/compaction/compaction.js';
import type { AgentContext, AgentMessage } from '../../../../src/context-manager.js';
import { makeToolCallMsg, makeToolResultMsg } from '../helpers.js';

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });
const OBSERVED = '<observations>\n* (10:00) observed\n</observations>';

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred(): { promise: Promise<string>; resolve: (value: string) => void } {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('an observer in flight during a swap', () => {
  it('lands at its shifted range instead of being discarded', async () => {
    const engine = new ObservationalMemoryEngine({ bufferMinTokens: 100 }, 0);
    engine.setContextWindow(20_000);
    engine.setUtilityModelContextWindow(200_000);
    const pending = deferred();
    engine.setCompleteFn(vi.fn<CompleteFn>().mockReturnValue(pending.promise));
    // m0 and m1 are observed in a chunk; m2 and m3 are not.
    const history = [userMsg('m0'), userMsg('m1'), userMsg('m2 ' + 'x'.repeat(8_000)), userMsg('m3 ' + 'y'.repeat(8_000))];
    engine.restoreState({
      observations: '',
      continuationHint: null,
      observationTokenCount: 0,
      generationCount: 0,
      bufferedChunks: [{ observations: '* m0 and m1', messageTokensObserved: 2, createdAt: new Date(), endIndex: 2 }],
      bufferWatermark: 2,
    });
    // An observer launches over m2 and m3...
    engine.onTurnEnd(10_000, 20_000, history, 0);
    expect(engine.isObserverInFlight()).toBe(true);

    // ...and while it runs, activation swaps out m0 and m1 (no in-band call).
    let source = [...history];
    await engine.applyInTransformContext(
      { systemPrompt: '', model: null, messages: [userMsg('slot'), ...source], tools: [], thinkingLevel: 'medium' } as AgentContext,
      0.95, 1,
      (ctx) => ctx.messages.slice(1),
      (ctx, h) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...h] }),
      () => source,
      (h) => { source = h; },
      { allowSync: false },
    );
    // Precondition: the swap removed the two observed messages.
    expect(source).toHaveLength(2);

    pending.resolve(OBSERVED);
    await flushPromises();

    const state = engine.getState();
    expect(state.bufferedChunks).toHaveLength(1);
    expect(state.bufferWatermark).toBe(2);
  });
});

describe('observer input', () => {
  it('buffers one piece within the input cap, ending on a unit boundary', async () => {
    const engine = new ObservationalMemoryEngine({ bufferMinTokens: 100, bufferTokenCap: 1_000 }, 0);
    engine.setContextWindow(100_000);
    engine.setUtilityModelContextWindow(200_000);
    engine.setCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    const history = [
      userMsg('a'.repeat(2_400)), // 600 tokens
      makeToolCallMsg([{ id: 't1', name: 'Read' }]),
      makeToolResultMsg('t1', 'Read', 'b'.repeat(2_400)), // the group pushes past 1,000
      userMsg('c'.repeat(2_400)),
    ];

    engine.onTurnEnd(10_000, 100_000, history, 0);
    await flushPromises();

    // Not the whole history, and not inside the tool-call group.
    expect(engine.getState().bufferWatermark).toBe(1);
  });

  it('bookends an oversized tool result so the observer call fits', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    const huge = makeToolResultMsg('t1', 'Bash', 'z'.repeat(400_000)); // ~100k tokens

    await runObserver(
      complete,
      [makeToolCallMsg([{ id: 't1', name: 'Bash' }]), huge],
      null,
      { previousObserverTokens: 2_000, maxInputTokens: 10_000 },
    );

    const sent = JSON.stringify(complete.mock.calls[0]![0].messages);
    expect(sent.length).toBeLessThan(60_000);
  });
});

describe('buffering past the activation threshold', () => {
  it('keeps observing, so a pass that cannot observe in-band has chunks to swap in', () => {
    const engine = new ObservationalMemoryEngine({}, 0);
    engine.setContextWindow(100_000);
    engine.setUtilityModelContextWindow(200_000);
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    engine.setCompleteFn(complete);

    engine.onTurnEnd(95_000, 100_000, [userMsg('x'.repeat(50_000))], 0);

    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe('restoring older state', () => {
  it('merges chunks saved without ranges into one chunk ending at the watermark', () => {
    const engine = new ObservationalMemoryEngine({}, 0);
    engine.restoreState({
      observations: '',
      continuationHint: null,
      observationTokenCount: 0,
      generationCount: 0,
      bufferedChunks: [
        { observations: '* first', messageTokensObserved: 10, createdAt: new Date(), currentTask: 'Older task in progress' },
        { observations: '* second', messageTokensObserved: 20, createdAt: new Date(), currentTask: 'Latest task in progress' },
      ],
      bufferWatermark: 4,
    }, 6);

    const chunks = engine.getState().bufferedChunks;
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      observations: '* first\n\n* second',
      messageTokensObserved: 30,
      currentTask: 'Latest task in progress',
      endIndex: 4,
    });
  });
});
