import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { LoopRunInfo, PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';
import { CompactionManager } from '../../src/compaction/index.js';
import { partsOf } from './agent-loop/parts.js';

// ---------------------------------------------------------------------------
// Scriptable mock that mutates state.messages the way pi-agent-core does:
// a committed user message before each run, and a synthetic assistant failure
// message (stopReason 'error'/'aborted') appended when a run fails.
// ---------------------------------------------------------------------------

type Outcome = 'fail' | 'ok';

interface RetryMockAgent extends PiAgent {
  promptCalls: number;
  continueCalls: number;
  /** Roles seen as the LAST message at the moment continue() was entered. */
  continueLastRoles: string[];
  abortCalled: boolean;
}

function createRetryMock(outcomes: Outcome[], failStopReason: 'error' | 'aborted' = 'error'): RetryMockAgent {
  const queue = [...outcomes];
  let idleResolve: (() => void) | null = null;
  let eventHandler: ((event: PiEvent) => void) | null = null;

  const pushUser = (text: string): void => {
    agent.state.messages.push({ role: 'user', content: text } as never);
  };
  const applyOutcome = (): void => {
    agent.state.messages = agent.state.messages.filter(Boolean);
    const outcome = queue.shift() ?? 'ok';
    if (outcome === 'fail') {
      agent.state.errorMessage = 'Connection error.';
      const failMsg = {
        role: 'assistant',
        content: [],
        stopReason: failStopReason,
        errorMessage: 'Connection error.',
      };
      agent.state.messages.push(failMsg as never);
      // pi emits turn_end carrying its synthetic failure message. The budget
      // guard skips these (they are not real model turns).
      eventHandler?.({ type: 'turn_end', message: failMsg } as PiEvent);
    } else {
      const okMsg = {
        role: 'assistant',
        content: 'done',
        stopReason: 'end_turn',
      };
      agent.state.messages.push(okMsg as never);
      eventHandler?.({ type: 'turn_end', message: okMsg } as PiEvent);
    }
  };

  const agent: RetryMockAgent = {
    state: { messages: [], systemPrompt: '', tools: [] },
    promptCalls: 0,
    continueCalls: 0,
    continueLastRoles: [],
    abortCalled: false,

    subscribe(handler: (event: PiEvent) => void): () => void {
      eventHandler = handler;
      return () => {
        eventHandler = null;
      };
    },

    async prompt(input: string): Promise<unknown> {
      agent.promptCalls += 1;
      agent.state.errorMessage = undefined;
      // Pi emits agent_start once per run (so once per retry attempt too).
      eventHandler?.({ type: 'agent_start' });
      pushUser(input);
      applyOutcome();
      return undefined;
    },

    async continue(): Promise<unknown> {
      agent.continueCalls += 1;
      agent.state.errorMessage = undefined;
      eventHandler?.({ type: 'agent_start' });
      const last = agent.state.messages[agent.state.messages.length - 1] as
        | { role?: string }
        | undefined;
      agent.continueLastRoles.push(last?.role ?? 'none');
      applyOutcome();
      return undefined;
    },

    steer(_message: { role: string; content: string }): void {},

    abort(): void {
      agent.abortCalled = true;
      idleResolve?.();
      idleResolve = null;
    },

    async waitForIdle(): Promise<void> {
      return new Promise<void>((resolve) => {
        idleResolve = resolve;
        setTimeout(() => {
          resolve();
          idleResolve = null;
        }, 5);
      });
    },

    reset(): void {
      agent.state.messages = [];
    },
  };

  return agent;
}

function makeModel(raw: PiModel) {
  return wrapModel(raw, raw.provider, raw.name, raw.contextWindow);
}

function createConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model: makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    // Tiny backoff so the loop runs fast under real timers.
    retryPolicy: { backoffMs: [5], maxBackoffMs: 5, maxAttempts: 3 },
    ...overrides,
  };
}

type Ctor = new (agent: PiAgent, config: AgentLoopConfig) => AgentLoop;
function build(agent: PiAgent, config: AgentLoopConfig): AgentLoop {
  return new (AgentLoop as unknown as Ctor)(agent, config);
}

describe('AgentLoop background retry', () => {
  let mock: RetryMockAgent;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries a transient failure by resuming with continue() and succeeds', async () => {
    mock = createRetryMock(['fail', 'ok']);
    const agent = build(mock, createConfig());
    const scheduled = vi.fn();
    const succeeded = vi.fn();
    const errored = vi.fn();
    agent.onRetryScheduled(scheduled);
    agent.onRetrySucceeded(succeeded);
    agent.onError(errored);

    await agent.prompt('hello');

    expect(mock.promptCalls).toBe(1);
    expect(mock.continueCalls).toBe(1);
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(scheduled.mock.calls[0][0]).toMatchObject({
      category: 'network',
      attempt: 1,
      maxAttempts: 3,
    });
    // Second argument is the loop's origin context: every fan-out callback
    // carries it so a composite consumer can tell which loop retried.
    expect(succeeded).toHaveBeenCalledWith({ attempts: 1 }, { loopPath: 'main' });
    expect(errored).not.toHaveBeenCalled();
  });

  it('trims the synthetic failure message so continue() sees a user/tool-result', async () => {
    mock = createRetryMock(['fail', 'ok']);
    const agent = build(mock, createConfig());
    await agent.prompt('hi');
    // The only continue() call must have seen a non-assistant last message.
    expect(mock.continueLastRoles).toEqual(['user']);
  });

  it('gives up after maxAttempts and fires onRetryExhausted then onError', async () => {
    mock = createRetryMock(['fail', 'fail', 'fail', 'fail']);
    const agent = build(mock, createConfig({ retryPolicy: { backoffMs: [3], maxBackoffMs: 3, maxAttempts: 3 } }));
    const scheduled = vi.fn();
    const exhausted = vi.fn();
    const errored = vi.fn();
    agent.onRetryScheduled(scheduled);
    agent.onRetryExhausted(exhausted);
    agent.onError(errored);

    await expect(agent.prompt('hi')).rejects.toThrow();

    expect(scheduled).toHaveBeenCalledTimes(3); // one per allowed retry
    expect(mock.continueCalls).toBe(3);
    expect(exhausted).toHaveBeenCalledWith(
      { attempts: 3, category: 'network' },
      { loopPath: 'main' },
    );
    expect(errored).toHaveBeenCalledTimes(1);
    expect(errored.mock.calls[0][0].category).toBe('network');
  });

  it('does not retry a non-retryable (authentication) failure', async () => {
    mock = createRetryMock(['ok']);
    // Force an auth error regardless of message script.
    mock.prompt = async (input: string) => {
      mock.promptCalls += 1;
      mock.state.messages.push({ role: 'user', content: input } as never);
      mock.state.errorMessage = 'invalid api key';
      return undefined;
    };
    const agent = build(mock, createConfig());
    const scheduled = vi.fn();
    const errored = vi.fn();
    agent.onRetryScheduled(scheduled);
    agent.onError(errored);

    await expect(agent.prompt('hi')).rejects.toThrow();

    expect(scheduled).not.toHaveBeenCalled();
    expect(mock.continueCalls).toBe(0);
    expect(errored.mock.calls[0][0].category).toBe('authentication');
  });

  it('does not retry when the policy is disabled', async () => {
    mock = createRetryMock(['fail', 'ok']);
    const agent = build(mock, createConfig({ retryPolicy: { enabled: false } }));
    const scheduled = vi.fn();
    const errored = vi.fn();
    agent.onRetryScheduled(scheduled);
    agent.onError(errored);

    await expect(agent.prompt('hi')).rejects.toThrow();

    expect(scheduled).not.toHaveBeenCalled();
    expect(mock.continueCalls).toBe(0);
    expect(errored.mock.calls[0][0].category).toBe('network');
  });

  it('budget counts real turns per logical prompt, skipping synthetic failures', async () => {
    mock = createRetryMock(['fail', 'ok']);
    const agent = build(mock, createConfig());

    await agent.prompt('hi');

    // One logical turn, two attempts (fail + successful retry). Both pi runs
    // emit agent_start (which no longer resets the budget) and a turn_end;
    // the failed attempt's turn_end is synthetic (stopReason 'error') and is
    // skipped, so only the single real turn counts.
    expect(mock.continueCalls).toBe(1);
    expect(agent.getBudgetGuard().getTurnCount()).toBe(1);

    // The next logical prompt resets the budget, so its real turn counts as 1
    // (proving the reset is per logical prompt, not accumulated).
    await agent.prompt('again');
    expect(agent.getBudgetGuard().getTurnCount()).toBe(1);
  });

  it('abort() mid-turn does not resurrect the turn as a background retry', async () => {
    // The failure message deliberately does NOT match /abort|cancelled/, so
    // classification must rely on the abort controller alone. Before the
    // fix, abort() reset the controller as soon as pi went idle, racing the
    // turn's own catch: the cancelled turn was reclassified as a retryable
    // network failure and resurrected via continue().
    mock = createRetryMock(['fail', 'ok']);
    let releasePrompt: (() => void) | null = null;
    let idleResolve: (() => void) | null = null;
    const basePrompt = mock.prompt.bind(mock);
    mock.prompt = async (input: string): Promise<unknown> => {
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
      const result = await basePrompt(input);
      // Mirror pi-agent-core's settlement order: finishRun() resolves the
      // activeRun promise (waitForIdle) BEFORE the caller's own await on
      // prompt() resumes, so abort()'s continuation races ahead of the
      // turn's catch block exactly as it does against the real Agent.
      idleResolve?.();
      idleResolve = null;
      return result;
    };
    mock.waitForIdle = (): Promise<void> => new Promise<void>((resolve) => {
      idleResolve = resolve;
    });
    mock.abort = (): void => {
      mock.abortCalled = true;
      releasePrompt?.();
      releasePrompt = null;
    };

    const agent = build(mock, createConfig());
    const scheduled = vi.fn();
    const errored = vi.fn();
    agent.onRetryScheduled(scheduled);
    agent.onError(errored);

    const turn = agent.prompt('hi');
    const settled = turn.then(
      () => 'resolved',
      () => 'rejected',
    );
    await new Promise((resolve) => setImmediate(resolve));

    await agent.abort();

    expect(await settled).toBe('rejected');
    expect(scheduled).not.toHaveBeenCalled();
    expect(mock.continueCalls).toBe(0);
    expect(errored).toHaveBeenCalledTimes(1);
    expect(errored.mock.calls[0][0].category).toBe('cancelled');
  });

  it('destroy() during a retry backoff cancels the pending retry timer', async () => {
    mock = createRetryMock(['fail', 'ok']);
    // A backoff long enough that the test would time out if destroy() left
    // the retry timer running instead of cancelling it.
    const agent = build(
      mock,
      createConfig({ retryPolicy: { backoffMs: [60_000], maxBackoffMs: 60_000, maxAttempts: 3 } }),
    );
    const scheduledPromise = new Promise<void>((resolve) => {
      agent.onRetryScheduled(() => resolve());
    });

    const turn = agent.prompt('hi');
    const settled = turn.then(
      () => 'resolved',
      (e: Error) => e.name,
    );
    await scheduledPromise;

    await agent.destroy();

    expect(await settled).toBe('AbortError');
    expect(mock.continueCalls).toBe(0);
    expect(agent.state).toBe('destroyed');
  });

  it('cancels a pending retry when aborted during the backoff wait', async () => {
    mock = createRetryMock(['fail', 'ok']);
    const agent = build(mock, createConfig({ retryPolicy: { backoffMs: [1000], maxBackoffMs: 1000, maxAttempts: 3 } }));
    const errored = vi.fn();
    agent.onError(errored);
    // Abort as soon as the first retry is scheduled (during the 1s wait).
    agent.onRetryScheduled(() => {
      void agent.abort();
    });

    // A backoff abort throws a cancellation, not the stale transient error, so
    // the consumer's catch treats it as an interruption (message says aborted).
    const thrown = await agent.prompt('hi').then(
      () => null,
      (e: Error) => e,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.name).toBe('AbortError');
    expect(thrown!.message).toMatch(/abort/i);

    // The wait was cancelled before the retry ran.
    expect(mock.continueCalls).toBe(0);
    expect(errored.mock.calls[0][0].category).toBe('cancelled');
  });
});

describe('AgentLoop abort-stub trim', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lastMessage(mock: RetryMockAgent): { role?: string; stopReason?: string } {
    return (mock.state.messages[mock.state.messages.length - 1] ?? {}) as {
      role?: string;
      stopReason?: string;
    };
  }

  it('trims the aborted assistant stub left by an abort mid-turn', async () => {
    // Same settlement choreography as the resurrect test: abort() lands
    // while the turn is in flight, and pi appends its synthetic failure stub.
    const mock = createRetryMock(['fail', 'ok']);
    let releasePrompt: (() => void) | null = null;
    let idleResolve: (() => void) | null = null;
    const basePrompt = mock.prompt.bind(mock);
    mock.prompt = async (input: string): Promise<unknown> => {
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
      const result = await basePrompt(input);
      idleResolve?.();
      idleResolve = null;
      return result;
    };
    mock.waitForIdle = (): Promise<void> => new Promise<void>((resolve) => {
      idleResolve = resolve;
    });
    mock.abort = (): void => {
      mock.abortCalled = true;
      releasePrompt?.();
      releasePrompt = null;
    };

    const agent = build(mock, createConfig());
    const turn = agent.prompt('hi').catch(() => 'rejected');
    await new Promise((resolve) => setImmediate(resolve));

    await agent.abort();
    expect(await turn).toBe('rejected');

    // The synthetic failure stub is gone; history ends on the user message.
    expect(lastMessage(mock).role).toBe('user');
  });

  /**
   * A mock whose single run parks until abort, then appends an aborted
   * assistant message with the given content (mirroring pi returning the
   * accumulated partial content with stopReason 'aborted', no error state).
   */
  function createCleanAbortMock(abortedContent: unknown): RetryMockAgent {
    const mock = createRetryMock([]);
    let releasePrompt: (() => void) | null = null;
    let idleResolve: (() => void) | null = null;
    mock.prompt = async (input: string): Promise<unknown> => {
      mock.promptCalls += 1;
      mock.state.errorMessage = undefined;
      mock.state.messages.push({ role: 'user', content: input } as never);
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
      mock.state.messages.push({
        role: 'assistant',
        content: abortedContent,
        stopReason: 'aborted',
      } as never);
      idleResolve?.();
      idleResolve = null;
      return undefined;
    };
    mock.waitForIdle = (): Promise<void> => new Promise<void>((resolve) => {
      idleResolve = resolve;
    });
    mock.abort = (): void => {
      mock.abortCalled = true;
      releasePrompt?.();
      releasePrompt = null;
    };
    return mock;
  }

  async function runCleanAbort(mock: RetryMockAgent): Promise<void> {
    const agent = build(mock, createConfig());
    const turn = agent.prompt('hi');
    await new Promise((resolve) => setImmediate(resolve));
    await agent.abort();
    await turn;
  }

  it('keeps partial assistant text the user already saw when a clean abort ends the run', async () => {
    // Abort mid-stream without a throw: pi records the accumulated partial
    // content with stopReason 'aborted' and prompt() resolves normally. The
    // streamed text was already rendered by the consumer UI, so trimming it
    // would make the model forget an answer the user read.
    const mock = createCleanAbortMock([{ type: 'text', text: 'partial answer' }]);

    await runCleanAbort(mock);

    expect(lastMessage(mock)).toMatchObject({ role: 'assistant', stopReason: 'aborted' });
    const content = lastMessage(mock) as { content?: Array<{ text?: string }> };
    expect(content.content?.[0]?.text).toBe('partial answer');
  });

  it('trims a cleanly-aborted stub with no text content', async () => {
    const mock = createCleanAbortMock([]);

    await runCleanAbort(mock);

    expect(lastMessage(mock).role).toBe('user');
  });

  it('trims an aborted message whose tool call would be left unpaired', async () => {
    // Partial text plus a dispatched tool call whose result never ran: an
    // unpaired tool call in history is a hard provider error on the next
    // request, so the whole message goes even at the cost of the text.
    const mock = createCleanAbortMock([
      { type: 'text', text: 'let me check that file' },
      { type: 'toolCall', toolCallId: 'tc_1', name: 'Read', args: {} },
    ]);

    await runCleanAbort(mock);

    expect(lastMessage(mock).role).toBe('user');
  });

  it('leaves no failure stub behind when aborted during the backoff wait', async () => {
    const mock = createRetryMock(['fail', 'ok']);
    const agent = build(
      mock,
      createConfig({ retryPolicy: { backoffMs: [1000], maxBackoffMs: 1000, maxAttempts: 3 } }),
    );
    agent.onRetryScheduled(() => {
      void agent.abort();
    });

    await agent.prompt('hi').catch(() => {});

    expect(lastMessage(mock).role).toBe('user');
  });

  it('does not treat a provider error containing ABORTED as an abort', async () => {
    // ECONNABORTED is a network failure; the abort heuristic must not match
    // "abort" inside a larger identifier, or the error is mislabeled as a
    // cancellation and its diagnostic stub is trimmed.
    const mock = createRetryMock([]);
    mock.prompt = async (input: string): Promise<unknown> => {
      mock.promptCalls += 1;
      mock.state.messages.push({ role: 'user', content: input } as never);
      mock.state.errorMessage = 'read ECONNABORTED';
      mock.state.messages.push({
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'read ECONNABORTED',
      } as never);
      return undefined;
    };
    const agent = build(mock, createConfig({ retryPolicy: { enabled: false } }));
    const errored = vi.fn();
    agent.onError(errored);

    await expect(agent.prompt('hi')).rejects.toThrow();

    expect(errored.mock.calls[0][0].category).not.toBe('cancelled');
    expect(lastMessage(mock)).toMatchObject({ role: 'assistant', stopReason: 'error' });
  });

  it('keeps the failure stub for a surfaced non-abort failure', async () => {
    // Retry disabled: the network failure surfaces immediately, un-aborted.
    // Its stub is diagnostic state the consumer may inspect; only aborts trim.
    const mock = createRetryMock(['fail', 'ok']);
    const agent = build(mock, createConfig({ retryPolicy: { enabled: false } }));

    await expect(agent.prompt('hi')).rejects.toThrow();

    expect(lastMessage(mock)).toMatchObject({ role: 'assistant', stopReason: 'error' });
  });

  it('does not trim a normal successful turn', async () => {
    const mock = createRetryMock(['ok']);
    const agent = build(mock, createConfig());

    await agent.prompt('hi');

    expect(lastMessage(mock)).toMatchObject({ role: 'assistant', stopReason: 'end_turn' });
  });

  it('tells the compaction manager the post-slot length after trimming an aborted stub', async () => {
    // pi emits turn_end for the stub before Cortex trims it, so an
    // observational buffer watermark may already count it. The trim must
    // notify the compaction manager with the surviving post-slot length so
    // the watermark is clamped and the next activation cannot slice away a
    // message that was never observed.
    const mock = createCleanAbortMock([]);
    const agent = build(mock, createConfig());
    const internal = partsOf(agent);
    const spy = vi.spyOn(internal.compactionManager, 'onSourceHistoryTailTrimmed');

    const turn = agent.prompt('hi');
    await new Promise((resolve) => setImmediate(resolve));
    await agent.abort();
    await turn;

    // History ends on the committed user message: post-slot length 1.
    expect(lastMessage(mock).role).toBe('user');
    expect(spy).toHaveBeenCalledWith(1);
  });

  it('does not notify the compaction manager when nothing was trimmed', async () => {
    // A clean abort that keeps the partial text trims nothing, so there is
    // no tail-trim to reconcile.
    const mock = createCleanAbortMock([{ type: 'text', text: 'partial answer' }]);
    const agent = build(mock, createConfig());
    const internal = partsOf(agent);
    const spy = vi.spyOn(internal.compactionManager, 'onSourceHistoryTailTrimmed');

    const turn = agent.prompt('hi');
    await new Promise((resolve) => setImmediate(resolve));
    await agent.abort();
    await turn;

    expect(lastMessage(mock)).toMatchObject({ role: 'assistant', stopReason: 'aborted' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('AgentLoop.currentRun across a retry ladder', () => {
  it('names one logical run across its attempts, with no live attempt during backoff', async () => {
    const agent = createRetryMock(['fail', 'ok']);
    const loop = build(agent, createConfig());
    const seen: Array<LoopRunInfo | null> = [];
    const original = { prompt: agent.prompt.bind(agent), continue: agent.continue.bind(agent) };
    agent.prompt = async (input: string) => { seen.push(loop.currentRun); return original.prompt(input); };
    agent.continue = async () => { seen.push(loop.currentRun); return original.continue(); };
    const backoff: Array<LoopRunInfo | null> = [];
    loop.onRetryScheduled(() => { backoff.push(loop.currentRun); });

    expect(loop.currentRun).toBeNull();
    const before = Date.now();
    await loop.prompt('work');

    // Two attempts of run 1, each live while pi ran it.
    expect(seen).toEqual([
      expect.objectContaining({ id: 1, attempt: 1, attemptStartedAt: expect.any(Number) }),
      expect.objectContaining({ id: 1, attempt: 2, attemptStartedAt: expect.any(Number) }),
    ]);
    expect(seen[0]!.startedAt).toBeGreaterThanOrEqual(before);
    expect(seen[1]!.startedAt).toBe(seen[0]!.startedAt);
    // Between them the run is in flight but no attempt is.
    expect(backoff).toEqual([expect.objectContaining({ id: 1, attempt: 1, attemptStartedAt: null })]);

    expect(loop.currentRun).toBeNull();
    expect(loop.lastRunEndedAt).toBeGreaterThanOrEqual(seen[0]!.startedAt);

    await loop.prompt('more');
    expect(seen.at(-1)).toEqual(expect.objectContaining({ id: 2, attempt: 1 }));
  });
});

describe('AgentLoop billing and stated resets', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A mock whose attempts fail with `failures` in turn, then succeed. */
  function failingWith(...failures: string[]): RetryMockAgent {
    const mock = createRetryMock(['ok']);
    const queue = [...failures];
    const attempt = (): void => {
      const message = queue.shift();
      mock.state.errorMessage = message;
      mock.state.messages.push(
        message === undefined
          ? { role: 'assistant', content: 'done', stopReason: 'stop' } as never
          : { role: 'assistant', content: [], stopReason: 'error', errorMessage: message } as never,
      );
    };
    mock.prompt = async (input: string) => {
      mock.promptCalls += 1;
      mock.state.messages.push({ role: 'user', content: input } as never);
      attempt();
      return undefined;
    };
    mock.continue = async () => {
      mock.continueCalls += 1;
      attempt();
      return undefined;
    };
    return mock;
  }

  const INSUFFICIENT_QUOTA =
    'OpenAI API error (429): {"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}';
  const USAGE_LIMIT = 'You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.';

  it('surfaces insufficient_quota at once as a fatal billing error', async () => {
    const mock = failingWith(INSUFFICIENT_QUOTA);
    const loop = build(mock, createConfig());
    const scheduled = vi.fn();
    const errored = vi.fn();
    loop.onRetryScheduled(scheduled);
    loop.onError(errored);

    await expect(loop.prompt('hi')).rejects.toThrow();

    expect(scheduled).not.toHaveBeenCalled();
    expect(mock.continueCalls).toBe(0);
    expect(errored.mock.calls[0]![0]).toMatchObject({ category: 'billing', severity: 'fatal' });
  });

  it('waits for the reset a usage limit states before retrying', async () => {
    vi.useFakeTimers();
    const mock = failingWith(USAGE_LIMIT);
    const loop = build(mock, createConfig());
    const scheduled = vi.fn();
    loop.onRetryScheduled(scheduled);

    const turn = loop.prompt('hi');
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(scheduled.mock.calls[0]![0]).toMatchObject({ category: 'rate_limit', delayMs: 2_520_000 });

    await vi.advanceTimersByTimeAsync(2_519_000);
    expect(mock.continueCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await turn;
    expect(mock.continueCalls).toBe(1);
  });

  it('waits the retry delay a provider requested over the backoff', async () => {
    vi.useFakeTimers();
    const mock = failingWith('Server requested 3600s retry delay (max: 60s). 429 Rate limit exceeded');
    // The default policy: a 2 minute first backoff.
    const loop = build(mock, createConfig({ retryPolicy: {} }));
    const scheduled = vi.fn();
    loop.onRetryScheduled(scheduled);

    const turn = loop.prompt('hi');
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduled.mock.calls[0]![0]).toMatchObject({ category: 'rate_limit', delayMs: 3_600_000 });

    await vi.advanceTimersByTimeAsync(3_600_000);
    await turn;
    expect(mock.continueCalls).toBe(1);
  });

  it('does not wait for a reset further away than maxRetryAfterMs', async () => {
    const mock = failingWith('You have hit your ChatGPT usage limit (plus plan). Try again in ~420 min.');
    const loop = build(mock, createConfig());
    const scheduled = vi.fn();
    const errored = vi.fn();
    loop.onRetryScheduled(scheduled);
    loop.onError(errored);

    await expect(loop.prompt('hi')).rejects.toThrow();

    expect(scheduled).not.toHaveBeenCalled();
    expect(errored.mock.calls[0]![0]).toMatchObject({ category: 'rate_limit', retryAfterMs: 25_200_000 });
  });
});

describe('AgentLoop reactive overflow handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A mock whose first attempt fails with `message`; a retry succeeds. */
  function failFirstAttemptWith(message: string): RetryMockAgent {
    const mock = createRetryMock(['ok']);
    mock.prompt = async (input: string) => {
      mock.promptCalls += 1;
      mock.state.messages.push({ role: 'user', content: input } as never);
      mock.state.errorMessage = message;
      mock.state.messages.push(
        { role: 'assistant', content: [], stopReason: 'error', errorMessage: message } as never,
      );
      return undefined;
    };
    return mock;
  }

  it('runs emergency truncation when the provider reports a context overflow', async () => {
    const truncate = vi.spyOn(CompactionManager.prototype, 'handleOverflowError');
    const loop = build(failFirstAttemptWith('prompt is too long: 213462 tokens > 200000 maximum'), createConfig());

    await expect(loop.prompt('hi')).rejects.toThrow();

    expect(truncate).toHaveBeenCalledTimes(1);
  });

  /** A mock whose run completes with an answer reporting `input` tokens of input. */
  function answersWithInput(input: number): RetryMockAgent {
    const mock = createRetryMock(['ok']);
    mock.prompt = async (text: string) => {
      mock.promptCalls += 1;
      mock.state.messages.push({ role: 'user', content: text } as never);
      mock.state.messages.push({
        role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop',
        usage: { input, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: input + 5 },
      } as never);
      return undefined;
    };
    return mock;
  }

  const modelWithWindow = (contextWindow: number) =>
    makeModel({ provider: 'zai', name: 'glm-4.6', contextWindow } as PiModel);

  it('runs the overflow drop when a provider overflows silently', async () => {
    const truncate = vi.spyOn(CompactionManager.prototype, 'handleOverflowError');
    const loop = build(answersWithInput(250_000), createConfig({ model: modelWithWindow(200_000) }));

    await loop.prompt('hi');

    expect(truncate).toHaveBeenCalledTimes(1);
  });

  it('guard: leaves history alone when the answer fit the window', async () => {
    const truncate = vi.spyOn(CompactionManager.prototype, 'handleOverflowError');
    const loop = build(answersWithInput(150_000), createConfig({ model: modelWithWindow(200_000) }));

    await loop.prompt('hi');

    expect(truncate).not.toHaveBeenCalled();
  });

  it('does not truncate history when Bedrock throttles on tokens per minute', async () => {
    const truncate = vi.spyOn(CompactionManager.prototype, 'handleOverflowError');
    const mock = failFirstAttemptWith('Throttling error: Too many tokens, please wait before trying again.');
    const loop = build(mock, createConfig());
    const scheduled = vi.fn();
    loop.onRetryScheduled(scheduled);

    await loop.prompt('hi');

    // The failure reached the turn runner and was retried as a rate limit.
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(scheduled.mock.calls[0]![0].category).toBe('rate_limit');
    expect(mock.continueCalls).toBe(1);
    expect(truncate).not.toHaveBeenCalled();
  });
});
