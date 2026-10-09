/**
 * A reflection condenses the log as it was when the reflector started. It
 * must land onto that log with everything appended since kept, never replace
 * the whole log and drop the newer observations.
 */
import { describe, it, expect, vi } from 'vitest';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import type { CompleteFn } from '../../../../src/compaction/compaction.js';
import type { AgentContext, AgentMessage } from '../../../../src/context-manager.js';

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function newEngine(complete: CompleteFn, observations: string): ObservationalMemoryEngine {
  const engine = new ObservationalMemoryEngine({}, 0);
  engine.setContextWindow(20_000); // reflection threshold 4,000 tokens; async trigger 2,000
  engine.setUtilityModelContextWindow(200_000);
  engine.restoreState({
    observations,
    continuationHint: null,
    observationTokenCount: Math.ceil(observations.length / 4),
    generationCount: 0,
    bufferedChunks: [],
    bufferWatermark: 0,
  });
  engine.setCompleteFn(complete);
  return engine;
}

async function activate(engine: ObservationalMemoryEngine, content: string): Promise<void> {
  let source = [userMsg(content)];
  const context: AgentContext = {
    systemPrompt: '', model: null, messages: [userMsg('slot'), ...source], tools: [], thinkingLevel: 'medium',
  };
  await engine.applyInTransformContext(
    context, 0.95, 1,
    (ctx) => ctx.messages.slice(1),
    (ctx, history) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...history] }),
    () => source,
    (history) => { source = history; },
  );
}

describe('buffered reflection', () => {
  it('keeps the observations a later activation appended before it landed', async () => {
    let observerCalls = 0;
    const engine = newEngine(vi.fn<CompleteFn>().mockImplementation(async (_ctx, options) => {
      if (options?.purpose === 'reflector') return '<observations>\nREFLECTED\n</observations>';
      observerCalls++;
      return observerCalls === 1
        ? '<observations>\nFIRST\n</observations>'
        : '<observations>\n' + 'SECOND '.repeat(900) + '\n</observations>';
    }), 'A'.repeat(4 * 2_500)); // 2,500 tokens: between the async trigger and the threshold

    // Activation 1 appends FIRST; the log sits between the async trigger and
    // the threshold, so a reflection launches in the background and lands.
    await activate(engine, 'q1 ' + 'z'.repeat(400));
    expect(engine.getObservations()).toContain('FIRST');
    await flushPromises();

    // Activation 2 appends SECOND, crossing the threshold: the buffered
    // reflection swaps in.
    await activate(engine, 'q2 ' + 'z'.repeat(400));

    const log = engine.getObservations();
    expect(log.startsWith('REFLECTED')).toBe(true);
    expect(log).toContain('SECOND');
  });
});

describe('in-band reflection', () => {
  it('keeps observations appended while the reflector ran', async () => {
    let releaseReflector!: (value: string) => void;
    let observerCalls = 0;
    const engine = newEngine(vi.fn<CompleteFn>().mockImplementation(async (_ctx, options) => {
      if (options?.purpose === 'reflector') {
        return new Promise<string>((resolve) => { releaseReflector = resolve; });
      }
      observerCalls++;
      return observerCalls === 1
        ? '<observations>\nIN-PASS\n</observations>'
        : '<observations>\nOBSERVED-DURING\n</observations>';
    }), 'B'.repeat(4 * 5_000)); // over the 4,000-token threshold: reflects inline

    const pass = activate(engine, 'hello');
    await flushPromises();
    // A manual observation lands while the inline reflection is in flight.
    await engine.triggerObservation([userMsg('a correction')], 0);
    releaseReflector('<observations>\nREFLECTED\n</observations>');
    await pass;

    const log = engine.getObservations();
    expect(log.startsWith('REFLECTED')).toBe(true);
    expect(log).toContain('OBSERVED-DURING');
  });
});
