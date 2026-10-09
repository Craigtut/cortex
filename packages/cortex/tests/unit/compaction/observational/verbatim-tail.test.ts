/**
 * Swaps keep a verbatim tail: the most recent messages that fit the tail
 * budget, never split between a tool call and its result, and the latest
 * user message wherever it is. And across any sequence of buffering, swaps
 * and appends, no message leaves context unobserved, none is observed
 * twice, no tool call is orphaned, and the latest user message stays: in
 * the engine alone, and through the whole transform pass (Layer 1's
 * trimmed copies, the view cut, observers still in flight at a swap).
 */
import { describe, it, expect, vi } from 'vitest';
import { CompactionManager, buildCompactionConfig } from '../../../../src/compaction/index.js';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import type { CompleteFn } from '../../../../src/compaction/observational/types.js';
import type { AgentContext, AgentMessage } from '../../../../src/context-manager.js';
import type { CortexCompactionConfig } from '../../../../src/types.js';
import { makeToolCallMsg, makeToolResultMsg, assertNoOrphans } from '../helpers.js';

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });
const assistantMsg = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: 0 });
const OBSERVED = '<observations>\n* (10:00) observed\n</observations>';

function newEngine(complete: CompleteFn, contextWindow = 20_000): ObservationalMemoryEngine {
  const engine = new ObservationalMemoryEngine({ maxAttempts: 1 });
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
    options?.utilization ?? 0.95,
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
      const engine = new ObservationalMemoryEngine({ maxAttempts: 1, bufferMinTokens: 50, bufferTokenCap: 3_000 });
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
            0.9 + random() * 0.1,
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

describe('swap invariants through the transform pass', () => {
  const SLOT = userMsg('slot');
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('hold with Layer 1 trimming, the view cut, and observers in flight at a swap', async () => {
    const seen = { inFlightSwaps: 0, trimmedCopies: 0, viewCuts: 0, removed: 0 };
    for (let seed = 1; seed <= 40; seed++) {
      const random = rng(seed);
      let nextId = 0;
      const tag = (): string => `<m${nextId++}>`;
      const idsIn = (text: string): string[] => text.match(/<m\d+>/g) ?? [];
      const observedCount = new Map<string, number>();
      const removed = new Set<string>();

      // Every memory call waits until the sequence releases it, so an
      // observer launched at a turn end can still be in flight at a swap.
      // While memory is down, calls fail at once and unobserved history
      // piles up past the view cut's ceiling.
      const pending: Array<() => void> = [];
      let down = false;
      const complete = vi.fn<CompleteFn>((context) => down ? Promise.reject(new Error('529 overloaded')) : new Promise<string>((resolve) => {
        pending.push(() => {
          for (const id of idsIn(JSON.stringify(context.messages.slice(-2)))) {
            observedCount.set(id, (observedCount.get(id) ?? 0) + 1);
          }
          resolve(OBSERVED);
        });
      }));
      const releaseOne = (): void => { pending.shift()?.(); };
      const manager = new CompactionManager(buildCompactionConfig({
        observational: { maxAttempts: 1, bufferMinTokens: 50, bufferTokenCap: 3_000 },
        // A recent zone small enough that older tool results get trimmed.
        microcompaction: { hotZoneMinTokens: 1_000 } as CortexCompactionConfig['microcompaction'],
      }), 1);
      manager.setContextWindow(20_000);
      manager.setModelContextWindow(20_000);
      manager.memory.setUtilityModelContextWindow(200_000);
      manager.memory.setCompleteFn(complete);

      let source: AgentMessage[] = [];
      const size = (): number => Math.floor(random() * 10_000) + 10;
      for (let step = 0; step < 50; step++) {
        const roll = random();
        if (roll < 0.4) {
          const kind = random();
          if (kind < 0.35) source.push(userMsg(tag() + 'u'.repeat(size())));
          else if (kind < 0.7) {
            const id = `t${nextId}`;
            source.push(makeToolCallMsg([{ id, name: 'Read' }], tag()));
            source.push(makeToolResultMsg(id, 'Read', tag() + 'r'.repeat(size() * 2)));
          } else source.push(assistantMsg(tag() + 'a'.repeat(size())));
        } else if (roll < 0.55) {
          manager.memory.onTurnEnd(Math.floor(random() * 20_000), 20_000, [SLOT, ...source], 1);
        } else if (roll < 0.65) {
          releaseOne();
          await tick();
        } else if (roll < 0.7) {
          down = !down;
        } else {
          const before = new Set(source);
          const latestUser = [...source].reverse().find((m) => m.role === 'user');
          const inFlight = manager.memory.isObserverInFlight();
          let current = [...source];
          const pass = manager.applyInTransformContext(
            { systemPrompt: '', model: null, messages: [SLOT, ...source], tools: [], thinkingLevel: 'medium' } as AgentContext,
            (ctx) => ctx.messages.slice(1),
            (ctx, history) => ({ ...ctx, messages: [SLOT, ...history] }),
            () => current,
            (history) => { current = history; },
            { allowBlocking: random() < 0.5 },
          );
          // A blocking pass waits on its memory calls: answer them as it asks.
          let done = false;
          void pass.then(() => { done = true; });
          while (!done) {
            releaseOne();
            await tick();
          }
          const view = (await pass).messages.slice(1);

          const after = new Set(current);
          for (const message of before) {
            if (after.has(message)) continue;
            for (const id of idsIn(JSON.stringify(message.content))) removed.add(id);
          }
          if (inFlight && current.length < source.length) seen.inFlightSwaps += 1;
          if (view.some((m) => m.role === 'toolResult' && !after.has(m))) seen.trimmedCopies += 1;
          if (view.some((m) => typeof m.content === 'string' && m.content.includes('are not shown'))) seen.viewCuts += 1;

          source = current;
          if (latestUser) {
            expect(source, `seed ${seed}: latest user message kept`).toContain(latestUser);
            expect(view, `seed ${seed}: latest user message shown`).toContain(latestUser);
          }
          assertNoOrphans(view);
        }
        assertNoOrphans(source);
      }

      // Everything still pending lands, so no observation is missed.
      while (pending.length > 0) {
        releaseOne();
        await tick();
      }
      seen.removed += removed.size;
      for (const id of removed) {
        expect(observedCount.get(id) ?? 0, `seed ${seed}: ${id} observed before it left`).toBeGreaterThan(0);
      }
      for (const [id, count] of observedCount) {
        expect(count, `seed ${seed}: ${id} observed once`).toBe(1);
      }
    }
    // Preconditions: each mechanism this covers actually ran.
    expect(seen.removed).toBeGreaterThan(100);
    expect(seen.inFlightSwaps).toBeGreaterThan(10);
    expect(seen.trimmedCopies).toBeGreaterThan(10);
    expect(seen.viewCuts).toBeGreaterThan(5);
  });
});
