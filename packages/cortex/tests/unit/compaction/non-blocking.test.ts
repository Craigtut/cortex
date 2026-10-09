/**
 * Non-blocking compaction posture: with `nonBlocking: true`, no synchronous
 * LLM call may run inside transformContext. Emergency truncation remains the
 * only in-band fallback; observation and reflection happen through async
 * buffering (or an explicit digestion call that re-enables blocking work via
 * the allowBlocking override). Built for a presence loop whose turns must
 * never stall on a multi-second observer or summarization call.
 */
import { describe, it, expect, vi } from 'vitest';
import { CompactionManager, buildCompactionConfig } from '../../../src/compaction/index.js';
import { ObservationalMemoryEngine } from '../../../src/compaction/observational/index.js';
import type { CompleteFn } from '../../../src/compaction/observational/types.js';
import type { AgentContext, AgentMessage } from '../../../src/context-manager.js';

function makeUserMsg(content: string): AgentMessage {
  return { role: 'user', content, timestamp: 0 };
}

function makeAssistantMsg(content: string): AgentMessage {
  return { role: 'assistant', content, timestamp: 0 };
}

function buildHistory(turnCount: number): AgentMessage[] {
  const history: AgentMessage[] = [];
  for (let i = 1; i <= turnCount; i++) {
    history.push(makeUserMsg(`User message ${i}`));
    history.push(makeAssistantMsg(`Assistant response ${i}`));
  }
  return history;
}

function makeContext(messages: AgentMessage[]): AgentContext {
  return {
    systemPrompt: 'system',
    model: null,
    messages,
    tools: [],
    thinkingLevel: 'medium',
  };
}

const OBSERVER_OUTPUT =
  '<observations>\n* observed\n</observations>\n\n' +
  '<current-task>\ntask\n</current-task>\n\n<suggested-response>\nnext\n</suggested-response>';

describe('observational strategy under nonBlocking', () => {
  it('skips the forced pre-truncation observation when over the failsafe threshold', async () => {
    const manager = new CompactionManager(
      buildCompactionConfig({ nonBlocking: true }),
      1,
    );
    manager.setContextWindow(100_000);
    manager.setModelContextWindow(100_000);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    manager.setObservationalCompleteFn(complete as unknown as CompleteFn);
    manager.updateCurrentContextTokenCount(95_000); // over activation AND failsafe

    const slots = [makeUserMsg('slot')];
    const history = buildHistory(10);
    const context = makeContext([...slots, ...history]);
    let sourceHistory = [...history];

    await manager.applyInTransformContext(
      context,
      (ctx) => ctx.messages.slice(1),
      (ctx, hist) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...hist] }),
      () => sourceHistory,
      (h) => { sourceHistory = h; },
    );

    // No observer call anywhere in-band: neither the Step 2 forced sync
    // observer nor the pre-L3 catch-up observation.
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('ObservationalMemoryEngine allowSync', () => {
  function buildEngine(): { engine: ObservationalMemoryEngine; complete: ReturnType<typeof vi.fn> } {
    const engine = new ObservationalMemoryEngine({ activationThreshold: 0.5 }, 1);
    engine.setContextWindow(100_000);
    engine.setUtilityModelContextWindow(100_000);
    const complete = vi.fn().mockResolvedValue(OBSERVER_OUTPUT);
    engine.setCompleteFn(complete as unknown as CompleteFn);
    return { engine, complete };
  }

  async function activate(
    engine: ObservationalMemoryEngine,
    source: AgentMessage[],
    allowSync: boolean,
  ): Promise<AgentMessage[]> {
    let sourceHistory = [...source];
    const context = makeContext([makeUserMsg('slot'), ...sourceHistory]);
    await engine.applyInTransformContext(
      context,
      0.95,
      1,
      (ctx) => ctx.messages.slice(1),
      (ctx, hist) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...hist] }),
      () => sourceHistory,
      (h) => { sourceHistory = h; },
      { allowSync },
    );
    return sourceHistory;
  }

  /** Two large exchanges: more than the verbatim tail (20% of the window) holds. */
  function largeHistory(): AgentMessage[] {
    return [
      makeUserMsg('a'.repeat(40_000)),
      makeAssistantMsg('b'.repeat(40_000)),
      makeUserMsg('c'.repeat(40_000)),
      makeAssistantMsg('d'.repeat(40_000)),
    ];
  }

  it('with allowSync false, never runs the forced observer on the unobserved tail', async () => {
    const { engine, complete } = buildEngine();

    const surviving = await activate(engine, largeHistory(), false);

    expect(complete).not.toHaveBeenCalled();
    // Nothing was observed, so nothing may be trimmed.
    expect(surviving).toHaveLength(4);
  });

  it('control: with allowSync true, the forced observer runs and trims up to the tail', async () => {
    const { engine, complete } = buildEngine();

    const surviving = await activate(engine, largeHistory(), true);

    expect(complete).toHaveBeenCalled();
    // The older exchange left; the latest stays verbatim.
    expect(surviving).toHaveLength(2);
  });

  it('with allowSync false, reflection at threshold launches async instead of running inline', async () => {
    const { engine } = buildEngine();
    // Seed observations well past the reflection threshold.
    const bigObservations = Array.from({ length: 30_000 }, (_, i) => `* line ${i}`).join('\n');
    engine.restoreState({
      observations: bigObservations,
      continuationHint: null,
      observationTokenCount: Math.ceil(bigObservations.length / 4),
      generationCount: 0,
      bufferedChunks: [],
      bufferWatermark: 0,
    });

    // Now a reflector-shaped completion that never settles: if reflection
    // ran inline, activation below would hang; async launch keeps it
    // in-flight without blocking.
    const pendingComplete = vi.fn().mockReturnValue(new Promise<string>(() => {}));
    engine.setCompleteFn(pendingComplete as unknown as CompleteFn);

    const source = buildHistory(2);
    let sourceHistory = [...source];
    const context = makeContext([makeUserMsg('slot'), ...sourceHistory]);

    const apply = engine.applyInTransformContext(
      context,
      0.95,
      1,
      (ctx) => ctx.messages.slice(1),
      (ctx, hist) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...hist] }),
      () => sourceHistory,
      (h) => { sourceHistory = h; },
      { allowSync: false },
    );

    // The apply call settles while the reflector completion is still
    // pending: the blocking work moved off the in-band path.
    await expect(apply).resolves.toBeDefined();
    expect(engine.isReflectorInFlight()).toBe(true);
  });
});
