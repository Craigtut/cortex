/**
 * Memory calls run under a policy: a hung call is abandoned at its timeout,
 * a transient failure is retried quickly, a failure that would repeat is
 * not, the run's abort ends the wait at once, and once the memory model has
 * failed the in-band pass stops blocking requests on it until a call
 * succeeds again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import type { ObservationalMemoryConfig } from '../../../../src/compaction/observational/types.js';
import type { CompleteFn } from '../../../../src/compaction/compaction.js';
import type { AgentContext, AgentMessage } from '../../../../src/context-manager.js';

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });
const OBSERVED = '<observations>\n* (10:00) OBSERVED\n</observations>';

function newEngine(complete: CompleteFn, config: Partial<ObservationalMemoryConfig> = {}): ObservationalMemoryEngine {
  const engine = new ObservationalMemoryEngine(config, 0);
  engine.setContextWindow(20_000);
  engine.setUtilityModelContextWindow(200_000);
  engine.setCompleteFn(complete);
  return engine;
}

/** One in-band activation over an unobserved history that keeps utilization over the threshold. */
async function activate(
  engine: ObservationalMemoryEngine,
  options?: { signal?: AbortSignal },
): Promise<AgentMessage[]> {
  let source = [userMsg('u'.repeat(4_000)), userMsg('latest')];
  const context: AgentContext = {
    systemPrompt: '', model: null, messages: [userMsg('slot'), ...source], tools: [], thinkingLevel: 'medium',
  };
  await engine.applyInTransformContext(
    context, 0.95, 1,
    (ctx) => ctx.messages.slice(1),
    (ctx, history) => ({ ...ctx, messages: [...ctx.messages.slice(0, 1), ...history] }),
    () => source,
    (history) => { source = history; },
    options,
  );
  return source;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('timeouts', () => {
  it('abandons a hung in-band observer at the pass budget and sends the request', async () => {
    const complete = vi.fn<CompleteFn>().mockReturnValue(new Promise<string>(() => {}));
    const engine = newEngine(complete, { callTimeoutMs: 20, maxAttempts: 1, blockingBudgetMs: 50 });

    const surviving = await activate(engine);

    // Nothing was observed, so nothing left the source.
    expect(surviving).toHaveLength(2);
    expect(engine.getObservations()).toBe('');
  });
});

describe('retries', () => {
  it('retries a transient failure and records the observation', async () => {
    vi.useFakeTimers();
    const complete = vi.fn<CompleteFn>()
      .mockRejectedValueOnce(new Error('529 overloaded_error: Overloaded'))
      .mockResolvedValue(OBSERVED);
    const engine = newEngine(complete);

    const pass = activate(engine);
    await vi.advanceTimersByTimeAsync(1_000);
    const surviving = await pass;

    expect(complete).toHaveBeenCalledTimes(2);
    expect(engine.getObservations()).toContain('OBSERVED');
    expect(surviving).toHaveLength(0);
  });

  it('guard: does not retry an authentication failure', async () => {
    const complete = vi.fn<CompleteFn>().mockRejectedValue(new Error('401 invalid x-api-key'));
    const engine = newEngine(complete);

    await activate(engine);

    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('retries a failed background observer before giving up', async () => {
    vi.useFakeTimers();
    const complete = vi.fn<CompleteFn>()
      .mockRejectedValueOnce(new Error('503 service unavailable'))
      .mockResolvedValue(OBSERVED);
    const engine = newEngine(complete, { bufferMinTokens: 100 });

    engine.onTurnEnd(10_000, 20_000, [userMsg('x'.repeat(12_000))], 0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(complete).toHaveBeenCalledTimes(2);
    expect(engine.getState().bufferedChunks).toHaveLength(1);
  });
});

describe('the run abort', () => {
  it('ends the in-band wait at once and applies nothing', async () => {
    const complete = vi.fn<CompleteFn>().mockReturnValue(new Promise<string>(() => {}));
    const engine = newEngine(complete);
    const run = new AbortController();

    const pass = activate(engine, { signal: run.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    run.abort();
    const surviving = await pass;

    expect(surviving).toHaveLength(2);
  });
});

describe('a degraded memory model', () => {
  it('gets no in-band call until a call succeeds again', async () => {
    const complete = vi.fn<CompleteFn>().mockRejectedValue(new Error('500 internal server error'));
    const engine = newEngine(complete, { maxAttempts: 1 });

    await activate(engine);
    // Precondition: the first pass called the observer and it failed.
    expect(complete).toHaveBeenCalledTimes(1);

    await activate(engine);

    expect(complete).toHaveBeenCalledTimes(1);
  });
});
