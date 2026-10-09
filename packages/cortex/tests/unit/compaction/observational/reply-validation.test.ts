/**
 * An unusable memory model reply is a failed call, never an empty result:
 * an empty reflection must not replace the log, and an empty or broken
 * observer reply must not advance the watermark past messages it never
 * recorded.
 */
import { describe, it, expect, vi } from 'vitest';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import { BufferingCoordinator } from '../../../../src/compaction/observational/buffering.js';
import { parseObserverOutput } from '../../../../src/compaction/observational/observer.js';
import { parseReflectorOutput } from '../../../../src/compaction/observational/reflector.js';
import type { CompleteFn } from '../../../../src/compaction/observational/types.js';
import type { AgentMessage } from '../../../../src/context-manager.js';

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const LOG = '* (10:00) a fact worth keeping\n'.repeat(700); // ~5,250 tokens

function engineOverReflectionThreshold(complete: CompleteFn): ObservationalMemoryEngine {
  const engine = new ObservationalMemoryEngine({ maxAttempts: 1 });
  engine.setContextWindow(20_000); // reflection threshold: 4,000 tokens
  engine.setUtilityModelContextWindow(200_000);
  engine.restoreState({
    observations: LOG,
    continuationHint: null,
    observationTokenCount: 5_250,
    generationCount: 0,
    bufferedChunks: [],
    bufferWatermark: 0,
  });
  engine.setCompleteFn(complete);
  return engine;
}

async function activate(engine: ObservationalMemoryEngine, options?: { allowSync?: boolean }): Promise<void> {
  let source = [userMsg('hello')];
  await engine.applyInTransformContext(
    0.95,
    () => source,
    (history) => { source = history; },
    options,
  );
}

describe('reflector replies', () => {
  it('an empty in-band reflection keeps the log', async () => {
    const engine = engineOverReflectionThreshold(vi.fn<CompleteFn>().mockImplementation(async (_ctx, options) =>
      options?.purpose === 'reflector' ? '' : '<observations>\n* observed\n</observations>'));

    await activate(engine);

    expect(engine.getObservations().startsWith(LOG)).toBe(true);
  });

  it('an empty buffered reflection is never swapped in', async () => {
    const engine = engineOverReflectionThreshold(vi.fn<CompleteFn>().mockImplementation(async (_ctx, options) =>
      options?.purpose === 'reflector' ? '   ' : '<observations>\n* observed\n</observations>'));

    // Non-blocking: the reflection is launched in the background...
    await activate(engine, { allowSync: false });
    await flushPromises();
    // ...and a later activation would swap in whatever buffered.
    await activate(engine, { allowSync: false });

    expect(engine.getObservations().startsWith(LOG)).toBe(true);
  });

  it('rejects a reply without an observations block, and an empty block', () => {
    expect(() => parseReflectorOutput('Here is the consolidated log, without tags')).toThrow(/observations|empty/);
    expect(() => parseReflectorOutput('<observations>\n\n</observations>')).toThrow(/observations|empty/);
    // Precondition: a populated block parses.
    expect(parseReflectorOutput('<observations>\n* kept\n</observations>')).toBe('* kept');
  });
});

describe('observer replies', () => {
  it('an empty reply lands no chunk and leaves the watermark', async () => {
    const buffering = new BufferingCoordinator();
    buffering.launchObserver(vi.fn<CompleteFn>().mockResolvedValue(''), [userMsg('x')], 1, null, {
      previousObserverTokens: 2_000,
    });
    await flushPromises();

    expect(buffering.getCompletedChunks()).toEqual({ chunks: [], watermark: 0 });
  });

  it('rejects a reply without an observations block, and one cut off inside it', () => {
    expect(() => parseObserverOutput('I cannot help with that.')).toThrow(/observations|empty/);
    expect(() => parseObserverOutput('<observations>\n* (10:00) started the refactor and then')).toThrow(/observations|empty/);
  });

  it('accepts a well-formed empty block as nothing worth recording', async () => {
    const buffering = new BufferingCoordinator();
    // Precondition: a populated block lands as a chunk.
    buffering.launchObserver(
      vi.fn<CompleteFn>().mockResolvedValue('<observations>\n* noted\n</observations>'),
      [userMsg('x')], 1, null, { previousObserverTokens: 2_000 },
    );
    await flushPromises();
    expect(buffering.getCompletedChunks().watermark).toBe(1);

    buffering.launchObserver(
      vi.fn<CompleteFn>().mockResolvedValue('<observations>\n</observations>'),
      [userMsg('ok')], 2, null, { previousObserverTokens: 2_000 },
    );
    await flushPromises();
    expect(buffering.getCompletedChunks().watermark).toBe(2);
  });
});
