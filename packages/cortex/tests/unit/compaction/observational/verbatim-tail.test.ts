/**
 * Swaps keep a verbatim tail: the most recent messages that fit the tail
 * budget, never split between a tool call and its result, and the latest
 * user message wherever it is. And across any sequence of buffering, swaps
 * and appends, no message leaves context unobserved, none is observed
 * twice, no tool call is orphaned, and the latest user message stays.
 */
import { describe, it, expect, vi } from 'vitest';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import type { CompleteFn } from '../../../../src/compaction/observational/types.js';
import type { AgentContext, AgentMessage } from '../../../../src/context-manager.js';
import { makeToolCallMsg, makeToolResultMsg, assertNoOrphans } from '../helpers.js';

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });
const assistantMsg = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: 0 });
const OBSERVED = '<observations>\n* (10:00) observed\n</observations>';

function newEngine(complete: CompleteFn, contextWindow = 20_000): ObservationalMemoryEngine {
  const engine = new ObservationalMemoryEngine({ maxAttempts: 1 }, 0);
  engine.setContextWindow(contextWindow); // tail budget: 20% of the window
  engine.setUtilityModelContextWindow(200_000);
  engine.setCompleteFn(complete);
  return engine;
}

async function activate(
  engine: ObservationalMemoryEngine,
  source: AgentMessage[],
  options?: { allowSync?: boolean; utilization?: number },
): Promise<AgentMessage[]> {
  let current = [...source];
  await engine.applyInTransformContext(
    { systemPrompt: '', model: null, messages: [userMsg('slot'), ...current], tools: [], thinkingLevel: 'medium' } as AgentContext,
    options?.utilization ?? 0.95, 1,
    (ctx) => ctx.messages.slice(1),
    (ctx, history) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...history] }),
    () => current,
    (history) => { current = history; },
    { allowSync: options?.allowSync ?? true },
  );
  return current;
}

describe('the verbatim tail', () => {
  it('keeps the latest user message through an in-band swap', async () => {
    const engine = newEngine(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    const latest = userMsg('what about the edge case?');
    const source = [userMsg('a'.repeat(20_000)), assistantMsg('b'.repeat(20_000)), latest];

    const surviving = await activate(engine, source);

    // Precondition: the older exchange was observed and left.
    expect(engine.getObservations()).toContain('observed');
    expect(surviving).toEqual([latest]);
  });

  it('keeps recent messages within the tail budget', async () => {
    const engine = newEngine(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    const recent = [userMsg('r'.repeat(4_000)), assistantMsg('s'.repeat(4_000)), userMsg('latest')];
    const source = [userMsg('a'.repeat(40_000)), assistantMsg('b'.repeat(40_000)), ...recent];

    const surviving = await activate(engine, source);

    expect(surviving).toEqual(recent);
  });

  it('keeps the latest user message even when it is older than the tail, and the tool call with its result', async () => {
    const engine = newEngine(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    const ask = userMsg('refactor the module');
    const work = [
      makeToolCallMsg([{ id: 'a', name: 'Read' }]), makeToolResultMsg('a', 'Read', 'x'.repeat(12_000)),
      makeToolCallMsg([{ id: 'b', name: 'Read' }]), makeToolResultMsg('b', 'Read', 'y'.repeat(12_000)),
      makeToolCallMsg([{ id: 'c', name: 'Read' }]), makeToolResultMsg('c', 'Read', 'z'.repeat(8_000)),
    ];
    const source = [userMsg('earlier ' + 'e'.repeat(8_000)), ask, ...work];

    const surviving = await activate(engine, source);

    // The ask moved to the front; the last tool group stayed whole.
    expect(surviving[0]).toBe(ask);
    expect(surviving.slice(-2)).toEqual(work.slice(-2));
    expect(surviving).not.toContain(work[0]);
    assertNoOrphans(surviving);
  });

  it('merges a chunk that reaches into the tail and keeps its messages as observed', async () => {
    const engine = newEngine(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    const source = [
      userMsg('a'.repeat(20_000)), assistantMsg('b'.repeat(20_000)),
      userMsg('c'.repeat(4_000)), assistantMsg('d'.repeat(4_000)),
    ];
    // One chunk covers all four: it straddles the tail.
    engine.restoreState({
      observations: '',
      continuationHint: null,
      observationTokenCount: 0,
      generationCount: 0,
      bufferedChunks: [{ observations: '* STRADDLING', messageTokensObserved: 12_000, createdAt: new Date(), endIndex: 4 }],
      bufferWatermark: 4,
    });

    const surviving = await activate(engine, source, { allowSync: false });

    expect(surviving).toEqual(source.slice(2));
    expect(engine.getObservations()).toContain('STRADDLING');
    expect(engine.getState().observedPrefix).toBe(2);
    expect(engine.getState().bufferedChunks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Invariants over random sequences
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('swap invariants over random sequences', () => {
  it('never loses, re-observes, orphans, or drops the latest user message', async () => {
    let totalRemoved = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed);
      let nextId = 0;
      const tag = (): string => `<m${nextId++}>`;
      const idsIn = (text: string): string[] => text.match(/<m\d+>/g) ?? [];
      const observedCount = new Map<string, number>();
      const removed = new Set<string>();

      const complete = vi.fn<CompleteFn>(async (context) => {
        for (const id of idsIn(JSON.stringify(context.messages.slice(-2)))) {
          observedCount.set(id, (observedCount.get(id) ?? 0) + 1);
        }
        return OBSERVED;
      });
      const engine = new ObservationalMemoryEngine({ maxAttempts: 1, bufferMinTokens: 50, bufferTokenCap: 3_000 }, 0);
      engine.setContextWindow(20_000);
      engine.setUtilityModelContextWindow(200_000);
      engine.setCompleteFn(complete);

      let source: AgentMessage[] = [];
      const size = (): number => Math.floor(random() * 6_000) + 10;
      for (let step = 0; step < 40; step++) {
        const roll = random();
        if (roll < 0.45) {
          // A turn: a user message, or a tool group, or an assistant reply.
          const kind = random();
          if (kind < 0.35) source.push(userMsg(tag() + 'u'.repeat(size())));
          else if (kind < 0.7) {
            const id = `t${nextId}`;
            source.push(makeToolCallMsg([{ id, name: 'Read' }], tag()));
            source.push(makeToolResultMsg(id, 'Read', tag() + 'r'.repeat(size())));
          } else source.push(assistantMsg(tag() + 'a'.repeat(size())));
        } else if (roll < 0.7) {
          engine.onTurnEnd(Math.floor(random() * 20_000), 20_000, source, 0);
          await new Promise((resolve) => setTimeout(resolve, 0));
        } else {
          const before = new Set(source);
          const latestUser = [...source].reverse().find((m) => m.role === 'user');
          let current = [...source];
          await engine.applyInTransformContext(
            { systemPrompt: '', model: null, messages: [userMsg('slot'), ...current], tools: [], thinkingLevel: 'medium' } as AgentContext,
            0.9 + random() * 0.1, 1,
            (ctx) => ctx.messages.slice(1),
            (ctx, history) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...history] }),
            () => current,
            (history) => { current = history; },
            { allowSync: random() < 0.5 },
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
          const after = new Set(current);
          for (const message of before) {
            if (after.has(message)) continue;
            for (const id of idsIn(JSON.stringify(message.content))) removed.add(id);
          }
          source = current;
          if (latestUser) expect(source, `seed ${seed}: latest user message kept`).toContain(latestUser);
        }
        assertNoOrphans(source);
      }

      totalRemoved += removed.size;
      for (const id of removed) {
        expect(observedCount.get(id) ?? 0, `seed ${seed}: ${id} observed before it left`).toBeGreaterThan(0);
      }
      for (const [id, count] of observedCount) {
        expect(count, `seed ${seed}: ${id} observed once`).toBe(1);
      }
    }
    // Precondition: the sequences actually swapped messages out.
    expect(totalRemoved).toBeGreaterThan(100);
  });
});
