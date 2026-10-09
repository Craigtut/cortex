/**
 * Passthrough parity: CortexAgent in passthrough mode must behave
 * identically to using AgentLoop directly (docs/cortex/duplex/facade-api.md,
 * migration-plan.md P2.1). Both sides are driven with the same script over
 * identical mock pi agents and compared on everything a consumer can
 * observe: pi-level interaction, events (with origin context), callbacks,
 * history, turn results, and usage.
 *
 * Parity is measured against the CURRENT (post Phase 0/1) behavior, not
 * against pre-restructure behavior.
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel, DeliverResult } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type {
  AgentLoopConfig,
  AgentTextOutput,
  ClassifiedError,
  LoopOriginContext,
  RetryScheduledInfo,
  SessionUsage,
} from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { CortexAgentConfig } from '../../src/cortex-agent.js';
import type { LoosePiEvent } from '../helpers/pi-events.js';

// ---------------------------------------------------------------------------
// Mock PiAgent: holdable runs, failure injection, queues, usage on turn_end.
// Both sides of every scenario get an identical fresh instance.
// ---------------------------------------------------------------------------

interface ParityMockPiAgent extends PiAgent {
  emitEvent: (event: LoosePiEvent) => void;
  promptCalls: Array<string | AgentMessage[]>;
  steeringQueue: Array<{ role: string; content: string }>;
  followUpQueue: Array<{ role: string; content: string }>;
  hold: boolean;
  failWith: Error | null;
  releaseRun: () => void;
}

function createMockPiAgent(): ParityMockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let releaseRun: (() => void) | null = null;
  let rejectRun: ((err: Error) => void) | null = null;
  let idleResolve: (() => void) | null = null;
  let running = false;

  const agent: ParityMockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    promptCalls: [],
    steeringQueue: [],
    followUpQueue: [],
    hold: false,
    failWith: null,

    subscribe(handler: (event: PiEvent) => void): () => void {
      eventHandler = handler;
      return () => {
        eventHandler = null;
      };
    },

    emitEvent(event: LoosePiEvent): void {
      eventHandler?.(event as unknown as PiEvent);
    },

    async prompt(input: string | AgentMessage[]): Promise<unknown> {
      agent.promptCalls.push(input);
      running = true;
      try {
        agent.emitEvent({ type: 'agent_start' });
        const messages: AgentMessage[] = Array.isArray(input)
          ? input
          : [{ role: 'user', content: input, timestamp: Date.now() }];
        agent.state.messages.push(...messages);
        agent.state.messages.push(...(agent.steeringQueue.splice(0) as AgentMessage[]));

        if (agent.hold) {
          agent.hold = false;
          await new Promise<void>((resolve, reject) => {
            releaseRun = resolve;
            rejectRun = reject;
          });
          // Pi polls steering again at the turn boundary after the hold.
          agent.state.messages.push(...(agent.steeringQueue.splice(0) as AgentMessage[]));
        }

        if (agent.failWith) {
          const err = agent.failWith;
          agent.failWith = null;
          (agent.state as Record<string, unknown>)['errorMessage'] = err.message;
          throw err;
        }
        delete (agent.state as Record<string, unknown>)['errorMessage'];

        agent.state.messages.push(...(agent.followUpQueue.splice(0) as AgentMessage[]));

        agent.emitEvent({
          type: 'turn_end',
          text: 'ok',
          usage: {
            input: 100,
            output: 20,
            cacheRead: 5,
            cacheWrite: 7,
            totalTokens: 120,
            cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
          },
        });
        agent.state.messages.push({
          role: 'assistant',
          content: 'ok',
          timestamp: Date.now(),
        });
        agent.emitEvent({ type: 'agent_end', messages: [] });
        return { content: 'ok' };
      } finally {
        running = false;
        idleResolve?.();
        idleResolve = null;
      }
    },

    releaseRun(): void {
      releaseRun?.();
      releaseRun = null;
      rejectRun = null;
    },

    async continue(): Promise<unknown> {
      delete (agent.state as Record<string, unknown>)['errorMessage'];
      agent.emitEvent({ type: 'turn_end', text: 'recovered' });
      agent.state.messages.push({
        role: 'assistant',
        content: 'recovered',
        timestamp: Date.now(),
      });
      agent.emitEvent({ type: 'agent_end', messages: [] });
      return { content: 'recovered' };
    },

    abort(): void {
      if (rejectRun) {
        const err = new Error('Request was aborted.');
        err.name = 'AbortError';
        rejectRun(err);
      }
      releaseRun = null;
      rejectRun = null;
    },

    async waitForIdle(): Promise<void> {
      if (!running) return;
      return new Promise<void>((resolve) => {
        idleResolve = resolve;
      });
    },

    reset(): void {
      agent.state.messages = [];
    },

    steer(message: { role: string; content: string }): void {
      agent.steeringQueue.push(message);
    },

    followUp(message: { role: string; content: string }): void {
      agent.followUpQueue.push(message);
    },

    clearSteeringQueue(): void {
      agent.steeringQueue = [];
    },

    clearFollowUpQueue(): void {
      agent.followUpQueue = [];
    },

    hasQueuedMessages(): boolean {
      return agent.steeringQueue.length > 0 || agent.followUpQueue.length > 0;
    },
  };

  return agent;
}

// ---------------------------------------------------------------------------
// Harness: a uniform driving surface over "direct AgentLoop" and
// "CortexAgent in passthrough", with consumer-level observation collectors.
// ---------------------------------------------------------------------------

interface Harness {
  label: 'direct' | 'facade';
  piAgent: ParityMockPiAgent;
  /** Full normalized events (type, payload shape, origin), not just types. */
  events: unknown[];
  /** What AgentLoop.prompt() received on this side (input plus options). */
  loopPromptCalls: Array<{ input: string; options: unknown }>;
  /** Causation tags this side's wiring put on AgentLoop.prompt() calls. */
  loopCauseTags: unknown[];
  turnOutputs: Array<{ userFacing: string; loopPath: string }>;
  loopCompletes: number;
  errors: Array<{ category: string; severity: string; loopPath: string }>;
  // delayMs is deterministic (jitter-free backoff from config), so it is
  // asserted: a facade mis-routing retryPolicy diverges here first.
  retriesScheduled: Array<{ attempt: number; category: string; delayMs: number }>;
  prompt: (input: string, options?: { sessionId?: string }) => Promise<unknown>;
  deliver: (content: string, options?: { wake?: boolean }) => DeliverResult;
  steer: (message: string) => void;
  abort: () => Promise<void>;
  getConversationHistory: () => AgentMessage[];
  getSessionUsage: () => SessionUsage;
  queuedDeliveryCount: () => number;
  waitForIdle: () => Promise<void>;
}

type TestAgentLoopConstructor = new (agent: PiAgent, config: AgentLoopConfig) => AgentLoop;
type TestCortexAgentConstructor = new (reasoner: AgentLoop, config: CortexAgentConfig) => CortexAgent;

function testModel(): CortexModel {
  return wrapModel(
    { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel,
    'anthropic',
    'claude-sonnet-4-20250514',
  );
}

function baseConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    ...overrides,
  };
}

/**
 * Deep-normalize a value for cross-side comparison: volatile wall-clock
 * values (timestamps, durations, *At fields) are replaced with a marker so
 * everything else in the payload shape still must match. delayMs is
 * deliberately not scrubbed: backoffForAttempt is jitter-free, so the
 * scheduled backoff is fully determined by config and a facade that
 * mis-routed retryPolicy must fail parity on it. A projection to
 * event.type alone would miss exactly the payload-shaped changes 2b makes
 * (loop paths stamped on every event).
 */
const VOLATILE_KEY = /^(timestamp|durationMs)$|At$/;

/**
 * Identity-shaped fields carry UUIDs minted independently on each side
 * (askId, sub-agent task ids), so raw values can never match across
 * harnesses. Scrubbing them away would also stop asserting their presence
 * and correlation; instead each harness maps values to stable placeholders
 * in first-seen order, so the same id keeps the same placeholder wherever
 * it reappears on that side.
 */
const IDENTITY_KEY = /^(askId|taskId|childTaskId)$/;

function scrubVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubVolatile);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = VOLATILE_KEY.test(key) ? '<volatile>' : scrubVolatile(entry);
    }
    return out;
  }
  return value;
}

/** Per-harness event normalizer: volatile scrub plus identity placeholders. */
function createEventNormalizer(): (value: unknown) => unknown {
  const placeholders = new Map<string, string>();
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (VOLATILE_KEY.test(key)) {
          out[key] = '<volatile>';
        } else if (IDENTITY_KEY.test(key) && typeof entry === 'string') {
          let placeholder = placeholders.get(entry);
          if (placeholder === undefined) {
            placeholder = `<id-${placeholders.size + 1}>`;
            placeholders.set(entry, placeholder);
          }
          out[key] = placeholder;
        } else {
          out[key] = normalize(entry);
        }
      }
      return out;
    }
    return value;
  };
  return normalize;
}

/**
 * Record every AgentLoop.prompt() invocation (input plus options). The
 * facade's own causation tag rides the options (PromptOptions.causeTag); it
 * is facade-internal wiring, not a consumer option, so it is recorded apart
 * and the options compare as the consumer passed them.
 */
function recordLoopPrompts(
  loop: AgentLoop,
  calls: Array<{ input: string; options: unknown }>,
  causeTags: unknown[] = [],
): void {
  const original = loop.prompt.bind(loop);
  (loop as { prompt: AgentLoop['prompt'] }).prompt = (input, options) => {
    const { causeTag, ...consumerOptions } = options ?? {};
    if (causeTag !== undefined) causeTags.push(causeTag);
    calls.push({ input, options: Object.keys(consumerOptions).length > 0 ? consumerOptions : undefined });
    return original(input, options);
  };
}

function collect(
  harness: Omit<Harness, 'prompt' | 'deliver' | 'steer' | 'abort' | 'getConversationHistory' | 'getSessionUsage' | 'queuedDeliveryCount' | 'waitForIdle'>,
  surface: {
    getEventBridge: AgentLoop['getEventBridge'];
    onTurnComplete: (handler: (output: AgentTextOutput, origin: LoopOriginContext) => void) => void;
    onLoopComplete: (handler: () => void) => void;
    onError: (handler: (error: ClassifiedError, origin: LoopOriginContext) => void) => void;
    onRetryScheduled: (handler: (info: RetryScheduledInfo) => void) => void;
  },
): void {
  const normalizeEvent = createEventNormalizer();
  surface.getEventBridge().onAll((event) => {
    harness.events.push(normalizeEvent(event));
  });
  surface.onTurnComplete((output, origin) => {
    harness.turnOutputs.push({ userFacing: output.userFacing, loopPath: origin.loopPath });
  });
  surface.onLoopComplete(() => {
    harness.loopCompletes += 1;
  });
  surface.onError((error, origin) => {
    harness.errors.push({
      category: error.category,
      severity: error.severity,
      loopPath: origin.loopPath,
    });
  });
  surface.onRetryScheduled((info) => {
    harness.retriesScheduled.push({
      attempt: info.attempt,
      category: info.category,
      delayMs: info.delayMs,
    });
  });
}

function createDirectHarness(overrides?: Partial<AgentLoopConfig>): Harness {
  const piAgent = createMockPiAgent();
  const loop = new (AgentLoop as unknown as TestAgentLoopConstructor)(piAgent, baseConfig(overrides));
  const harness: Harness = {
    label: 'direct',
    piAgent,
    events: [],
    loopPromptCalls: [],
    loopCauseTags: [],
    turnOutputs: [],
    loopCompletes: 0,
    errors: [],
    retriesScheduled: [],
    prompt: (input, options) => loop.prompt(input, options),
    deliver: (content, options) => loop.deliver(content, options),
    steer: (message) => loop.steer(message),
    abort: () => loop.abort(),
    getConversationHistory: () => loop.getConversationHistory(),
    getSessionUsage: () => loop.getSessionUsage(),
    queuedDeliveryCount: () => loop.queuedDeliveryCount,
    waitForIdle: () => loop.waitForLoopIdle(),
  };
  recordLoopPrompts(loop, harness.loopPromptCalls, harness.loopCauseTags);
  collect(harness, loop);
  return harness;
}

function createFacadeHarness(overrides?: Partial<AgentLoopConfig>): Harness {
  const piAgent = createMockPiAgent();
  const loop = new (AgentLoop as unknown as TestAgentLoopConstructor)(piAgent, baseConfig(overrides));
  const facade = new (CortexAgent as unknown as TestCortexAgentConstructor)(loop, {
    ...baseConfig(overrides),
    mode: 'passthrough',
  });
  const harness: Harness = {
    label: 'facade',
    piAgent,
    events: [],
    loopPromptCalls: [],
    loopCauseTags: [],
    turnOutputs: [],
    loopCompletes: 0,
    errors: [],
    retriesScheduled: [],
    prompt: (input, options) => facade.prompt(input, options),
    deliver: (content, options) => facade.deliver(content, options),
    steer: (message) => facade.steer(message),
    abort: () => facade.abort(),
    getConversationHistory: () => facade.getConversationHistory(),
    getSessionUsage: () => facade.getSessionUsage(),
    queuedDeliveryCount: () => facade.queuedDeliveryCount,
    waitForIdle: () => facade.waitForConversationIdle(),
  };
  recordLoopPrompts(loop, harness.loopPromptCalls, harness.loopCauseTags);
  collect(harness, facade);
  return harness;
}

function harnessPair(overrides?: Partial<AgentLoopConfig>): [Harness, Harness] {
  return [createDirectHarness(overrides), createFacadeHarness(overrides)];
}

/**
 * Project history for cross-side comparison: the full message shape with
 * only wall-clock values scrubbed, so a payload-shaped divergence (an extra
 * field, a changed role, structured content) fails parity instead of being
 * projected away.
 */
function historyShape(history: AgentMessage[]): unknown[] {
  return history.map(scrubVolatile);
}

/** Project pi prompt calls: strings stay strings, batches become contents. */
function promptCallShape(calls: Array<string | AgentMessage[]>): unknown[] {
  return calls.map((call) =>
    typeof call === 'string'
      ? call
      : call.map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        ),
  );
}

/** Assert every consumer-observable surface matches between the two sides. */
function expectParity(direct: Harness, facade: Harness): void {
  expect(promptCallShape(facade.piAgent.promptCalls)).toEqual(
    promptCallShape(direct.piAgent.promptCalls),
  );
  expect(facade.loopPromptCalls).toEqual(direct.loopPromptCalls);
  expect(historyShape(facade.getConversationHistory())).toEqual(
    historyShape(direct.getConversationHistory()),
  );
  expect(facade.events).toEqual(direct.events);
  expect(facade.turnOutputs).toEqual(direct.turnOutputs);
  expect(facade.loopCompletes).toBe(direct.loopCompletes);
  expect(facade.errors).toEqual(direct.errors);
  expect(facade.retriesScheduled).toEqual(direct.retriesScheduled);
  expect(facade.getSessionUsage()).toEqual(direct.getSessionUsage());
}

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('CortexAgent passthrough parity', () => {
  it('sequential prompts: same pi calls, events, callbacks, history, usage, results', async () => {
    const [direct, facade] = harnessPair();

    const directResults = [await direct.prompt('first'), await direct.prompt('second')];
    const facadeResults = [await facade.prompt('first'), await facade.prompt('second')];

    expect(facadeResults).toEqual(directResults);
    expectParity(direct, facade);
    expect(facade.turnOutputs).toEqual([
      { userFacing: 'ok', loopPath: 'main' },
      { userFacing: 'ok', loopPath: 'main' },
    ]);
  });

  it('silent deliver then prompt: identical batch flush', async () => {
    const [direct, facade] = harnessPair();

    for (const side of [direct, facade]) {
      const result = side.deliver('background fact', { wake: false });
      expect(result.outcome).toBe('queued');
      await side.prompt('now respond');
    }

    expectParity(direct, facade);
    // The silent delivery leads the next prompt's batch on both sides.
    expect(promptCallShape(direct.piAgent.promptCalls)).toEqual([
      ['background fact', 'now respond'],
    ]);
  });

  it('wake deliver on an idle loop: identical prompted turn', async () => {
    const [direct, facade] = harnessPair();

    for (const side of [direct, facade]) {
      const result = side.deliver('new direction');
      expect(result.outcome).toBe('prompted');
      await result.turn;
    }

    expectParity(direct, facade);
  });

  it('wake deliver during a live run: identical parking and sweep delivery', async () => {
    const [direct, facade] = harnessPair();

    for (const side of [direct, facade]) {
      side.piAgent.hold = true;
      const turn = side.prompt('long task');
      await waitUntil(() => side.piAgent.promptCalls.length === 1);
      const result = side.deliver('mid-run redirect');
      expect(result.outcome).toBe('parked');
      side.piAgent.releaseRun();
      await turn;
      await side.waitForIdle();
    }

    expectParity(direct, facade);
    expect(promptCallShape(direct.piAgent.promptCalls)).toEqual([
      'long task',
      'mid-run redirect',
    ]);
  });

  it('steer during a live run: identical steering queue drain', async () => {
    const [direct, facade] = harnessPair();

    for (const side of [direct, facade]) {
      side.piAgent.hold = true;
      const turn = side.prompt('long task');
      await waitUntil(() => side.piAgent.promptCalls.length === 1);
      side.steer('course correction');
      side.piAgent.releaseRun();
      await turn;
    }

    expectParity(direct, facade);
    // The steer landed inside the run's transcript on both sides.
    expect(direct.getConversationHistory().map((message) => message.content)).toContain(
      'course correction',
    );
  });

  it('turn failure without retry: same rejection, error callback, history', async () => {
    const [direct, facade] = harnessPair({ retryPolicy: { enabled: false } });

    for (const side of [direct, facade]) {
      side.piAgent.failWith = new Error('provider exploded');
      await expect(side.prompt('doomed')).rejects.toThrow('provider exploded');
    }

    expectParity(direct, facade);
    expect(facade.errors).toEqual([
      { category: 'unknown', severity: 'recoverable', loopPath: 'main' },
    ]);
  });

  it('transient failure with retry: same retry schedule and recovery', async () => {
    const overrides: Partial<AgentLoopConfig> = {
      retryPolicy: { backoffMs: [1], maxBackoffMs: 1, maxAttempts: 2 },
    };
    const [direct, facade] = harnessPair(overrides);

    for (const side of [direct, facade]) {
      side.piAgent.failWith = new Error('socket hang up');
      const result = await side.prompt('flaky');
      expect(result).toEqual({ content: 'recovered' });
    }

    expectParity(direct, facade);
    // delayMs pins the configured backoff: a facade that mis-routed
    // retryPolicy would schedule the default backoff instead.
    expect(facade.retriesScheduled).toEqual([{ attempt: 1, category: 'network', delayMs: 1 }]);
  });

  it('abort mid-run: same cancellation surface, both reusable after', async () => {
    const [direct, facade] = harnessPair();

    for (const side of [direct, facade]) {
      side.piAgent.hold = true;
      const turn = side.prompt('long task');
      await waitUntil(() => side.piAgent.promptCalls.length === 1);
      await side.abort();
      await expect(turn).rejects.toThrow();
      await side.prompt('after abort');
    }

    expectParity(direct, facade);
    expect(facade.errors).toEqual([
      { category: 'cancelled', severity: 'recoverable', loopPath: 'main' },
    ]);
    expect(promptCallShape(facade.piAgent.promptCalls)).toEqual(['long task', 'after abort']);
  });

  it('abort with queued steer and silent content: the facade clears every queue, the direct loop retains them', async () => {
    // This pins the documented passthrough divergence (facade-api.md,
    // third footnote): facade abort() applies the abort-table scope
    // semantics and clears pi's steering queue plus the silent queue,
    // where direct AgentLoop.abort() leaves both intact. Without queued
    // content at abort time the divergence is invisible to the suite.
    const [direct, facade] = harnessPair();

    for (const side of [direct, facade]) {
      side.piAgent.hold = true;
      const turn = side.prompt('long task');
      await waitUntil(() => side.piAgent.promptCalls.length === 1);
      side.steer('queued steer');
      expect(side.deliver('background note', { wake: false }).outcome).toBe('queued');
      await side.abort();
      await expect(turn).rejects.toThrow();
    }

    // Direct: both queues survive the abort.
    expect(direct.piAgent.steeringQueue.map((m) => m.content)).toEqual(['queued steer']);
    expect(direct.queuedDeliveryCount()).toBe(1);
    // Facade: both queues are cleared per the abort table.
    expect(facade.piAgent.steeringQueue).toEqual([]);
    expect(facade.queuedDeliveryCount()).toBe(0);

    // The retained content reaches the direct loop's next run and never
    // reaches the facade's: a consumer that relied on steer() content
    // surviving an abort must re-issue it after a facade abort.
    for (const side of [direct, facade]) {
      await side.prompt('after abort');
      await side.waitForIdle();
    }
    expect(promptCallShape(direct.piAgent.promptCalls)).toEqual([
      'long task',
      ['background note', 'after abort'],
    ]);
    expect(promptCallShape(facade.piAgent.promptCalls)).toEqual(['long task', 'after abort']);
    const directContents = direct.getConversationHistory().map((m) => m.content);
    const facadeContents = facade.getConversationHistory().map((m) => m.content);
    expect(directContents).toContain('queued steer');
    expect(facadeContents).not.toContain('queued steer');
  });

  it('prompt options thread identically', async () => {
    const [direct, facade] = harnessPair();
    await direct.prompt('hello', { sessionId: 'affinity-1' });
    await facade.prompt('hello', { sessionId: 'affinity-1' });
    expectParity(direct, facade);
    // The loop received the options verbatim on BOTH sides. A facade that
    // dropped options entirely would previously still pass, because the
    // mock never recorded what it was given.
    expect(direct.loopPromptCalls).toEqual([
      { input: 'hello', options: { sessionId: 'affinity-1' } },
    ]);
    expect(facade.loopPromptCalls).toEqual(direct.loopPromptCalls);
    // Beside them, the facade's own causation: the logged utterance.
    expect(direct.loopCauseTags).toEqual([]);
    expect(facade.loopCauseTags).toEqual([{ kind: 'utterance', seq: expect.any(Number) }]);
  });

  it('usage parity includes cache token and cost breakdowns', async () => {
    const [direct, facade] = harnessPair();
    await direct.prompt('one');
    await facade.prompt('one');

    const usage = facade.getSessionUsage();
    expect(usage).toEqual(direct.getSessionUsage());
    expect(usage.totalTurns).toBe(1);
    expect(usage.tokens).toEqual({ input: 100, output: 20, cacheRead: 5, cacheWrite: 7 });
    expect(usage.totalCost).toBeCloseTo(0.0033, 10);
  });
});
