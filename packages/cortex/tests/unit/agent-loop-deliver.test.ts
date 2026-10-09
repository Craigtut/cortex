/**
 * deliver(): the state machine over (loop-gate depth, pi run state, abort
 * state) that lets a facade hand content to a loop regardless of its run
 * state, plus the queue surfaces exposed alongside it (followUp, queue
 * modes, queue clears).
 *
 * The load-bearing assertions here mirror docs/cortex/duplex/log-and-context.md:
 * NO deliver() content ever touches pi's steering queue (that queue belongs
 * to the public steer() API alone), silent (no-wake) content waits for the
 * next real prompt, and wake content parked while the gate is held opens
 * the NEXT run exactly once: as leading batch messages of a prompt queued
 * ahead of the sweep, or through the sweep's own run.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import { partsOf } from './agent-loop/parts.js';
import type { LoosePiEvent } from '../helpers/pi-events.js';
import { textAssistant } from '../helpers/messages.js';

// ---------------------------------------------------------------------------
// Mock PiAgent with steering/follow-up queues and a run that can hold at
// steering-poll boundaries. `holds` counts turn boundaries the next run
// pauses at (each drains the steering queue when released, like pi does
// after a tool batch); `finalHold` pauses once more AFTER the run's last
// steering poll, modeling the tail of a real run (follow-up poll, agent_end
// listeners, promise unwinding) where arriving content has no poll left to
// drain it. That window is exactly where the old reconciliation-based
// parking duplicated or destroyed content.
// ---------------------------------------------------------------------------

interface DeliverMockPiAgent extends PiAgent {
  emitEvent: (event: LoosePiEvent) => void;
  promptCalls: Array<string | AgentMessage[]>;
  steerCalls: Array<{ role: string; content: string; timestamp?: number }>;
  followUpCalls: Array<{ role: string; content: string; timestamp?: number }>;
  clearSteeringQueueCalls: number;
  clearFollowUpQueueCalls: number;
  /** Messages steered but not yet drained by a run (mirrors pi's queue). */
  steeringQueue: Array<{ role: string; content: string }>;
  /** Messages queued for a would-stop point (mirrors pi's follow-up queue). */
  followUpQueue: Array<{ role: string; content: string }>;
  /** Steering polls made so far (run start and each released hold). */
  polls: number;
  /** Number of turn-boundary holds the next run pauses at. */
  holds: number;
  /** When true, the next run pauses once more AFTER its last steering poll. */
  finalHold: boolean;
  releaseRun: () => void;
}

function createMockPiAgent(): DeliverMockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let releaseRun: (() => void) | null = null;
  let idleResolve: (() => void) | null = null;
  let running = false;

  const agent: DeliverMockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    promptCalls: [],
    steerCalls: [],
    followUpCalls: [],
    clearSteeringQueueCalls: 0,
    clearFollowUpQueueCalls: 0,
    steeringQueue: [],
    followUpQueue: [],
    polls: 0,
    holds: 0,
    finalHold: false,

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
        // Mirrors pi-agent-core: prompt messages (single or batch) are pushed
        // into state.messages at run start, before any model call.
        const messages: AgentMessage[] = Array.isArray(input)
          ? input
          : [{ role: 'user', content: input, timestamp: Date.now() }];
        agent.state.messages.push(...messages);
        // Pi polls the steering queue at run start.
        agent.polls += 1;
        agent.state.messages.push(
          ...(agent.steeringQueue.splice(0) as AgentMessage[]),
        );

        const holds = agent.holds;
        agent.holds = 0;
        for (let i = 0; i < holds; i += 1) {
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
          // ... and again at every turn boundary within the run.
          agent.polls += 1;
          agent.state.messages.push(
            ...(agent.steeringQueue.splice(0) as AgentMessage[]),
          );
        }

        if (agent.finalHold) {
          agent.finalHold = false;
          // Past the run's last steering poll: whatever arrives now has no
          // poll left inside this run.
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
        }

        // Pi drains the follow-up queue at a would-stop point: the run
        // continues with the queued message instead of stopping. Without
        // this, a queued follow-up would sit unconsumed and a test could
        // only prove absence of re-delivery, not that the follow-up lands.
        agent.state.messages.push(
          ...(agent.followUpQueue.splice(0) as AgentMessage[]),
        );

        agent.emitEvent({ type: 'turn_end', text: 'ok' });
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
    },

    async continue(): Promise<unknown> {
      throw new Error('not used in these tests');
    },

    abort(): void {
      releaseRun?.();
      releaseRun = null;
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
      agent.steerCalls.push(message);
      agent.steeringQueue.push(message);
    },

    followUp(message: { role: string; content: string }): void {
      agent.followUpCalls.push(message);
      agent.followUpQueue.push(message);
    },

    clearSteeringQueue(): void {
      agent.clearSteeringQueueCalls += 1;
      agent.steeringQueue = [];
    },

    hasQueuedMessages(): boolean {
      return agent.steeringQueue.length > 0 || agent.followUpQueue.length > 0;
    },

    clearFollowUpQueue(): void {
      agent.clearFollowUpQueueCalls += 1;
      agent.followUpQueue = [];
    },
  };

  return agent;
}

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
) => AgentLoop;

function createLoop(agent: PiAgent, overrides?: Partial<AgentLoopConfig>): AgentLoop {
  const model: CortexModel = wrapModel(
    { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel,
    'anthropic',
    'claude-sonnet-4-20250514',
  );
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  return new AgentLoopCtor(agent, {
    model,
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    ...overrides,
  });
}

function contentOf(message: AgentMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

/** Times `needle` appears across the transcript (duplication detector). */
function occurrences(agent: DeliverMockPiAgent, needle: string): number {
  return agent.state.messages.filter((m) => contentOf(m).includes(needle)).length;
}

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AgentLoop.deliver', () => {
  it('idle + wake starts a turn whose promise the result carries', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    const result = loop.deliver('new direction');

    expect(result.outcome).toBe('prompted');
    expect(result.turn).toBeDefined();
    await result.turn;
    expect(piAgent.promptCalls).toEqual(['new direction']);
    expect(piAgent.steerCalls).toEqual([]);
  });

  it('passes promptOptions through to the prompted turn (and only that path)', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const promptSpy = vi.spyOn(loop, 'prompt');

    const options = { sessionId: 'affinity-1', usageCategory: 'direct' } as const;
    const result = loop.deliver('with options', { promptOptions: options });

    expect(result.outcome).toBe('prompted');
    expect(promptSpy).toHaveBeenCalledWith('with options', options);
    await result.turn;
  });

  it('delivery into a running turn parks and opens the next run, not the one in flight', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const resetSpy = vi.spyOn(loop.getBudgetGuard(), 'reset');

    piAgent.holds = 1;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    const result = loop.deliver('mid-run redirect');

    expect(result.outcome).toBe('parked');
    // No separate promise: the parked content has no turn until a run
    // consumes it; that run's failures surface through onError.
    expect(result.turn).toBeUndefined();
    // Wake content never enters pi's steering queue (public steer() only).
    expect(piAgent.steerCalls).toEqual([]);
    expect(loop.pendingWakeDeliveryCount).toBe(1);

    piAgent.releaseRun();
    await turn;
    // The in-flight run never carried the parked content (its prompt was
    // the plain string, and nothing was steered into it): the accepted
    // cost of exact parking is a bounded one-run delay.
    expect(piAgent.promptCalls[0]).toBe('long task');

    // The sweep then delivers it with a run of its own, exactly once.
    await waitUntil(() => piAgent.promptCalls.length === 2);
    expect(piAgent.promptCalls[1]).toBe('mid-run redirect');
    await waitUntil(() => !loop.isLoopActive);
    expect(occurrences(piAgent, 'mid-run redirect')).toBe(1);
    // Two logical turns, each with its own budget window.
    expect(resetSpy).toHaveBeenCalledTimes(2);
  });

  it('same-frame delivery after prompt() parks and rides that prompt as a leading batch message', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    const turn = loop.prompt('first');
    // Same synchronous frame: the gate is held but pi has not started yet.
    // prompt() would throw here; deliver() parks, and the already-queued
    // prompt splices the parked content to the front of its batch.
    const result = loop.deliver('same frame delivery');

    expect(result.outcome).toBe('parked');
    await turn;
    expect(piAgent.steerCalls).toEqual([]);
    const batch = piAgent.promptCalls[0]!;
    expect(Array.isArray(batch)).toBe(true);
    expect((batch as AgentMessage[]).map((m) => contentOf(m))).toEqual([
      'same frame delivery',
      'first',
    ]);

    // The splice cleared the parked list at batch time, so the sweep finds
    // nothing and starts no second run.
    await waitUntil(() => !loop.isLoopActive);
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(occurrences(piAgent, 'same frame delivery')).toBe(1);
  });

  it('silent delivery while idle queues on the loop, never on pi', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    const result = loop.deliver('background fact', { wake: false });

    expect(result.outcome).toBe('queued');
    expect(loop.queuedDeliveryCount).toBe(1);
    // The R2-A1 trap: parked in pi's steering queue this would drain into
    // whatever run starts next and be answered unprompted.
    expect(piAgent.steerCalls).toEqual([]);
    expect(piAgent.promptCalls).toEqual([]);
  });

  it('silent delivery during a LIVE run also queues, never steers', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.holds = 1;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    const result = loop.deliver('silent while running', { wake: false });

    expect(result.outcome).toBe('queued');
    // After a terminated tool batch pi polls steering and continues the
    // inner loop if anything is queued, so a silent steer during a live run
    // would surface as an unprompted response.
    expect(piAgent.steerCalls).toEqual([]);
    expect(loop.queuedDeliveryCount).toBe(1);

    piAgent.releaseRun();
    await turn;
  });

  it('queued silent deliveries flush into the next real prompt as leading batch messages', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.deliver('fact one', { wake: false });
    loop.deliver('fact two', { wake: false });
    await loop.prompt('real question');

    expect(loop.queuedDeliveryCount).toBe(0);
    expect(piAgent.promptCalls).toHaveLength(1);
    const batch = piAgent.promptCalls[0]!;
    expect(Array.isArray(batch)).toBe(true);
    const messages = batch as AgentMessage[];
    expect(messages.map((m) => contentOf(m))).toEqual(['fact one', 'fact two', 'real question']);
    expect(messages.every((m) => m.role === 'user' && typeof m.timestamp === 'number')).toBe(true);
  });

  it('a background-completion drain does not flush the silent queue', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    // Activate the loop so drains run (state transitions on first prompt).
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    loop.deliver('silent fact', { wake: false });
    await partsOf(loop).background.enqueue({
      kind: 'subagent',
      taskId: 'task-1',
      result: {
        output: 'done',
        status: 'completed',
        usage: { turns: 1, cost: 0, durationMs: 5, contextTokens: 10 },
      },
    });

    // The drain delivered its completion as a plain string prompt and the
    // silent content is still waiting for the next REAL prompt.
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(typeof piAgent.promptCalls[0]).toBe('string');
    expect(piAgent.promptCalls[0]).toContain('task-1');
    expect(loop.queuedDeliveryCount).toBe(1);

    await loop.prompt('follow-up');
    const batch = piAgent.promptCalls[1] as AgentMessage[];
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.map((m) => contentOf(m))).toEqual(['silent fact', 'follow-up']);
  });

  it('rejects whitespace-only content', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    expect(() => loop.deliver('   \n  ')).toThrow('non-whitespace');
    expect(() => loop.deliver('   ', { wake: false })).toThrow('non-whitespace');
  });

  it('throws synchronously when no base prompt is configured', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent, { initialBasePrompt: undefined as never });

    // Without the synchronous check, the idle+wake branch would return
    // { outcome: 'prompted' } carrying a turn that rejects pre-flight
    // without emitting onError: a reported outcome for a turn that never
    // ran, invisible to a fire-and-forget caller.
    expect(() => loop.deliver('content')).toThrow('not configured');
    expect(piAgent.promptCalls).toEqual([]);
  });

  it('throws once the loop is shutting down', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.destroy();

    expect(() => loop.deliver('too late')).toThrow('destroyed');
  });

  it('drops queued silent deliveries on destroy', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.deliver('will be dropped', { wake: false });
    expect(loop.queuedDeliveryCount).toBe(1);
    await loop.destroy();
    expect(loop.queuedDeliveryCount).toBe(0);
  });
});

describe('AgentLoop.deliver run guarantee (sweep)', () => {
  it('a wake delivery parked while the gate is held by an empty drain still runs a turn', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    // Schedule a drain with nothing to deliver: it dequeues, finds the
    // pending queue empty, and returns while still holding the gate. No
    // run will start on its own for content parked in that window.
    const drain = partsOf(loop).background.schedule();
    const result = loop.deliver('urgent redirect');
    expect(result.outcome).toBe('parked');

    await drain;
    // The sweep queued behind the drain delivers the parked content with a
    // run of its own instead of leaving it for an unrelated later run.
    await waitUntil(() => piAgent.promptCalls.length === 1);
    expect(piAgent.promptCalls[0]).toBe('urgent redirect');
    expect(piAgent.steerCalls).toEqual([]);
    await waitUntil(() => !loop.isLoopActive);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
  });

  it('clearAllQueues drops parked wake deliveries so the sweep finds nothing', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    const drain = partsOf(loop).background.schedule();
    loop.deliver('will be cleared');
    const dropped = loop.clearAllQueues();
    expect(dropped).toEqual(['will be cleared']);

    await drain;
    await waitUntil(() => !loop.isLoopActive);
    // Content the caller explicitly dropped is not resurrected by the sweep.
    expect(piAgent.promptCalls).toHaveLength(0);
  });
});

// The interleavings the duplex facade generates by design: a run drains one
// message at a boundary poll while another lands after the run's last poll.
// The old reconciliation-based parking (steer into pi's queue, inspect
// hasQueuedMessages() afterwards) duplicated the drained content (BL1),
// destroyed public steer() content with clearSteeringQueue() (BL2), and
// re-delivered drained content whenever a follow-up sat queued (SF1).
describe('AgentLoop.deliver exactness under partial-drain interleavings', () => {
  it('a delivery mid-run plus one after the last poll are each delivered exactly once (BL1)', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.holds = 1;
    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    // C1 lands mid-run, before the run's remaining boundary poll.
    loop.deliver('C1-first');
    piAgent.releaseRun();
    await waitUntil(() => piAgent.polls === 2);

    // C2 lands after the run's last poll.
    loop.deliver('C2-second');
    piAgent.releaseRun();
    await turn;

    await waitUntil(() => !loop.isLoopActive);
    expect(occurrences(piAgent, 'C1-first')).toBe(1);
    expect(occurrences(piAgent, 'C2-second')).toBe(1);
  });

  it('a public steer() parked after the last poll is not destroyed by the sweep (BL2)', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.holds = 1;
    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    loop.deliver('D-delivery');
    piAgent.releaseRun();
    await waitUntil(() => piAgent.polls === 2);

    // An unrelated public steer() lands after the run's last steering poll
    // and parks in pi's queue.
    loop.steer('S-plain-steer');
    piAgent.releaseRun();
    await turn;

    await waitUntil(() => !loop.isLoopActive);
    // The sweep never blanket-clears pi's queue: the parked steer drains
    // into the next run start (here the sweep's own run), exactly once.
    expect(piAgent.clearSteeringQueueCalls).toBe(0);
    expect(occurrences(piAgent, 'S-plain-steer')).toBe(1);
    expect(occurrences(piAgent, 'D-delivery')).toBe(1);
  });

  it('a queued follow-up does not trigger re-delivery of consumed content (SF1)', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.holds = 1;
    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    loop.deliver('F-delivery');
    piAgent.releaseRun();
    await waitUntil(() => piAgent.polls === 2);

    // A consumer queues a follow-up near the run's end. The old sweep read
    // this as "something is still parked" and re-ran the whole record.
    loop.followUp('later thought');
    piAgent.releaseRun();
    await turn;

    await waitUntil(() => !loop.isLoopActive);
    expect(occurrences(piAgent, 'F-delivery')).toBe(1);
    // The follow-up itself lands (the run drains it at its would-stop
    // point), exactly once: the sweep neither re-delivers nor destroys it.
    expect(occurrences(piAgent, 'later thought')).toBe(1);
  });
});

describe('AgentLoop.deliver sweep failure recovery', () => {
  it('unwinds a failed sweep run and re-delivers the parked content exactly once', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const errored = vi.fn();
    loop.onError(errored);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    // The first sweep run fails after an assistant tool-call turn but
    // before its tool results: the surviving tail carries an unpaired tool
    // call, a hard provider error on the very next request if left there.
    let failuresLeft = 1;
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        piAgent.state.messages.push({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call_1', name: 'Bash', arguments: {} }],
        } as never);
        throw new Error('provider dropped mid-batch');
      }
      piAgent.state.messages.push({
        role: 'assistant',
        content: 'ok',
        timestamp: Date.now(),
      });
      return { content: 'ok' };
    };

    const drain = partsOf(loop).background.schedule();
    loop.deliver('parked content');
    await drain;

    // The failed run was unwound and the content re-parked; the follow-up
    // sweep delivers it. Exactly one copy survives, no unpaired tool call
    // lingers, and the recovered failure never surfaced through onError.
    await waitUntil(() => occurrences(piAgent, 'parked content') === 1 && !loop.isLoopActive);
    expect(piAgent.promptCalls).toHaveLength(2);
    expect(piAgent.state.messages.some((m) => Array.isArray(m.content))).toBe(false);
    expect(errored).not.toHaveBeenCalled();
    expect(loop.pendingWakeDeliveryCount).toBe(0);
  });

  it('caps a sweep attempt in-run retry ladder by the remaining wake-delivery budget', async () => {
    // Retry enabled: a network failure would normally schedule an in-run
    // retry, and each re-parked sweep attempt would re-enter the full
    // ladder (~3h under the default policy) while holding the loop gate.
    // With the item's delivery budget exhausted, the bounded policy the
    // sweep passes down must fail fast and drop the item instead.
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent, {
      retryPolicy: { backoffMs: [1], maxBackoffMs: 1, maxAttempts: 3 },
    });
    const scheduled = vi.fn();
    const errored = vi.fn();
    loop.onRetryScheduled(scheduled);
    loop.onError(errored);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      piAgent.state.messages.push({
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'connect ECONNREFUSED',
      } as never);
      throw new Error('connect ECONNREFUSED');
    };

    // Park through the real API (an empty drain holds the gate), then age
    // the item: its first delivery run started five hours ago, so earlier
    // attempts already consumed the whole elapsed budget.
    const drain = partsOf(loop).background.schedule();
    loop.deliver('over-budget parked content');
    const internal = partsOf(loop);
    internal.queues.wake[0]!.deliveryAttempts = 1;
    internal.queues.wake[0]!.firstDeliveryAttemptAt =
      Date.now() - 5 * 60 * 60 * 1000;
    await drain;

    await waitUntil(() => errored.mock.calls.length === 1 && !loop.isLoopActive);
    // One attempt, no in-run retry ladder, then the drop surfaces once.
    expect(scheduled).not.toHaveBeenCalled();
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
    expect(occurrences(piAgent, 'over-budget parked content')).toBe(0);
  });

  it('drops parked content after repeated failed sweep runs instead of looping', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const errored = vi.fn();
    loop.onError(errored);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      piAgent.state.messages.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'Bash', arguments: {} }],
      } as never);
      throw new Error('provider dropped mid-batch');
    };

    const drain = partsOf(loop).background.schedule();
    loop.deliver('doomed content');
    await drain;

    await waitUntil(() => errored.mock.calls.length === 1 && !loop.isLoopActive);
    // Exactly the capped number of attempts, then the content is dropped
    // (surfacing through onError once) and the transcript is left clean.
    expect(piAgent.promptCalls).toHaveLength(3);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
    expect(occurrences(piAgent, 'doomed content')).toBe(0);
    expect(piAgent.state.messages.some((m) => Array.isArray(m.content))).toBe(false);
  });

  it('dead-letters dropped wake deliveries so the drop is inspectable, not just a log line', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    loop.onError(() => {});
    const deadLettered = vi.fn();
    loop.onBackgroundResultDeadLettered(deadLettered);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      piAgent.state.messages.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'Bash', arguments: {} }],
      } as never);
      throw new Error('provider dropped mid-batch');
    };

    const drain = partsOf(loop).background.schedule();
    loop.deliver('doomed content');
    await drain;

    await waitUntil(() => deadLettered.mock.calls.length === 1 && !loop.isLoopActive);
    const entry = deadLettered.mock.calls[0]![0] as {
      kind: string; taskId: string; attempts: number; lastError: string; message: string;
    };
    expect(entry.kind).toBe('wake_delivery');
    expect(entry.taskId).toBe('wake-delivery');
    expect(entry.attempts).toBe(3);
    expect(entry.lastError).toContain('provider dropped mid-batch');
    // The dropped content itself is retained for inspection or re-drive.
    expect(entry.message).toBe('doomed content');
    expect(
      loop.getDeadLetteredBackgroundResults().some((result) => result.kind === 'wake_delivery'),
    ).toBe(true);
  });
});

describe('AgentLoop.deliver consumer-prompt splice failure recovery', () => {
  it('re-parks wake content spliced into a consumer prompt that fails before progressing', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    // The consumer prompt fails after pi pushed its batch but before any
    // model output; the sweep's later run succeeds.
    let failuresLeft = 1;
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('provider exploded before any output');
      }
      piAgent.state.messages.push(textAssistant('ok', Date.now()));
      return { content: 'ok' };
    };

    const turn = loop.prompt('real question');
    // Same-frame park: the gate is held, so this splices into that prompt.
    const result = loop.deliver('spliced wake content');
    expect(result.outcome).toBe('parked');

    await expect(turn).rejects.toThrow('provider exploded');

    // The failed run never answered the spliced content: it is unwound and
    // re-parked, and a sweep re-delivers it with a run of its own.
    await waitUntil(() => piAgent.promptCalls.length === 2);
    expect(piAgent.promptCalls[1]).toBe('spliced wake content');
    await waitUntil(() => !loop.isLoopActive);
    // Exactly once in the transcript (the failed copy was unwound), and
    // the consumer prompt's own failure shape is unchanged.
    expect(occurrences(piAgent, 'spliced wake content')).toBe(1);
    expect(occurrences(piAgent, 'real question')).toBe(1);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
  });

  it('leaves spliced wake content in history when the failed run progressed past it', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    // The run produces a partial assistant answer after the batch, then
    // fails: the batch is durable history the next run sees, so re-parking
    // it would deliver the same content twice.
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      piAgent.state.messages.push({
        role: 'assistant',
        content: 'partial answer covering the delivery',
        timestamp: Date.now(),
      });
      throw new Error('provider dropped late in the run');
    };

    const turn = loop.prompt('real question');
    const result = loop.deliver('progressed wake content');
    expect(result.outcome).toBe('parked');

    await expect(turn).rejects.toThrow('provider dropped late');
    await waitUntil(() => !loop.isLoopActive);

    expect(occurrences(piAgent, 'progressed wake content')).toBe(1);
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
  });

  it('does not re-deliver a spliced batch when a mid-run front trim moved the boundary', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    loop.restoreConversationHistory([
      { role: 'user', content: 'old question', timestamp: 1 } as AgentMessage,
      textAssistant('old answer', 2),
      { role: 'user', content: 'old follow-up', timestamp: 3 } as AgentMessage,
    ]);

    // The run pushes its batch, then a mid-run front trim rewrites the
    // transcript exactly the way observational activation does through
    // setSourceHistory (splice the observed prefix, reassign
    // state.messages, recalculate the runner's history boundary, the only in-run
    // writer), then the provider fails before any output. The spliced wake
    // message is still in the transcript verbatim, just shifted down: the
    // repark must not misread that as "never pushed" and deliver it twice.
    const internals = partsOf(loop);
    let failuresLeft = 1;
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        const source = piAgent.state.messages;
        const currentTickCount = source.length - internals.runner.boundary;
        source.splice(0, 2);
        piAgent.state.messages = [...source];
        internals.runner.boundary = Math.max(
          0,
          piAgent.state.messages.length - currentTickCount,
        );
        throw new Error('provider exploded after activation trim');
      }
      piAgent.state.messages.push(textAssistant('ok', Date.now()));
      return { content: 'ok' };
    };

    const turn = loop.prompt('real question');
    const result = loop.deliver('trim-shifted wake content');
    expect(result.outcome).toBe('parked');

    await expect(turn).rejects.toThrow('provider exploded after activation trim');

    // The failed run never progressed past the batch: the content is
    // unwound at the SHIFTED boundary, re-parked, and delivered exactly
    // once by the sweep.
    await waitUntil(() => piAgent.promptCalls.length === 2);
    expect(piAgent.promptCalls[1]).toBe('trim-shifted wake content');
    await waitUntil(() => !loop.isLoopActive);
    expect(occurrences(piAgent, 'trim-shifted wake content')).toBe(1);
    expect(occurrences(piAgent, 'real question')).toBe(1);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
  });

  it('unwind recovery stamps re-parked injected content with the run-start abort epoch', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const internals = partsOf(loop);

    // A failed delivery run whose transcript ends on an unpaired assistant
    // tool call, with a steer pi injected mid-run in the spliced range.
    piAgent.state.messages = [
      { role: 'user', content: 'delivery body', timestamp: 1 },
      { role: 'user', content: 'injected steer', timestamp: 2 },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 't1', name: 'Bash' }],
        timestamp: 3,
      },
    ] as AgentMessage[];

    // The run started at epoch 3; an abort completed during the run and
    // advanced the live epoch before the failure's catch ran.
    internals.abortState.epoch = 3;
    const runStartEpoch = 3;
    internals.abortState.epoch = 4;

    expect(internals.queues.unwindFailedDelivery('delivery body', runStartEpoch)).toBe(true);
    expect(internals.queues.wake.map((d) => d.content)).toEqual(['injected steer']);
    // Stamped with the epoch the run started under, so the abort's epoch
    // gate cancels the recovered content with the run it rode in, instead
    // of a late-running catch resurrecting it under the new epoch.
    expect(internals.queues.wake[0]!.abortEpoch).toBe(runStartEpoch);
  });
});

describe('AgentLoop fatal failures exhaust parked wake content at once', () => {
  // Retrying an authentication failure is futile until the consumer acts,
  // which is why background completions dead-letter on a fatal error at
  // once. Parked wake content follows the same rule on both of its paths.

  /** A pi run that pushes its input and fails with an auth error. */
  function failingWithAuth(piAgent: DeliverMockPiAgent): void {
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      throw new Error('401 Unauthorized: token expired');
    };
  }

  it('a sweep run failing with an auth error dead-letters its content after one attempt', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    loop.onError(() => {});
    const deadLettered = vi.fn();
    loop.onBackgroundResultDeadLettered(deadLettered);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];
    failingWithAuth(piAgent);

    const drain = partsOf(loop).background.schedule();
    loop.deliver('needs a live credential');
    await drain;

    await waitUntil(() => deadLettered.mock.calls.length === 1 && !loop.isLoopActive);
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(deadLettered.mock.calls[0]![0]).toMatchObject({
      kind: 'wake_delivery', attempts: 1, message: 'needs a live credential',
    });
    expect(loop.pendingWakeDeliveryCount).toBe(0);
  });

  it('a consumer prompt failing with an auth error dead-letters its spliced wake batch', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    loop.onError(() => {});
    const deadLettered = vi.fn();
    loop.onBackgroundResultDeadLettered(deadLettered);
    failingWithAuth(piAgent);

    const turn = loop.prompt('real question');
    // Parked while the gate is held, then spliced into the prompt's batch.
    expect(loop.deliver('spliced content').outcome).toBe('parked');
    await expect(turn).rejects.toThrow('401');

    await waitUntil(() => deadLettered.mock.calls.length === 1 && !loop.isLoopActive);
    // Precondition: the content rode the failed prompt's batch.
    expect(Array.isArray(piAgent.promptCalls[0])).toBe(true);
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(deadLettered.mock.calls[0]![0]).toMatchObject({
      kind: 'wake_delivery', attempts: 1, message: 'spliced content',
    });
    expect(loop.pendingWakeDeliveryCount).toBe(0);
  });
});

describe('AgentLoop abort of a prompt carrying spliced wake content', () => {
  // An abort cancels parked content with the run that carried it, on the
  // sweep path and on a consumer prompt's batch alike: content no response
  // answered leaves the transcript and is dead-lettered, never left behind
  // as unanswered context the next run reads as already delivered.

  /** A run that pushes its batch and holds until abort() ends it. */
  function abortableRun(piAgent: DeliverMockPiAgent, ending: 'rejects' | 'resolves-with-stub'): void {
    let endRun: (() => void) | null = null;
    piAgent.abort = () => { endRun?.(); };
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      await new Promise<void>((resolve) => { endRun = resolve; });
      if (ending === 'rejects') {
        const err = new Error('Request was aborted.');
        err.name = 'AbortError';
        throw err;
      }
      piAgent.state.messages.push({ role: 'assistant', content: [], stopReason: 'aborted' } as never);
      return {};
    };
  }

  it.each(['rejects', 'resolves-with-stub'] as const)(
    'unwinds and dead-letters the batch when the aborted run %s',
    async (ending) => {
      const piAgent = createMockPiAgent();
      const loop = createLoop(piAgent);
      loop.onError(() => {});
      const deadLettered = vi.fn();
      loop.onBackgroundResultDeadLettered(deadLettered);
      await loop.prompt('warm up');
      piAgent.promptCalls = [];

      // Parked in the frame the prompt enqueued, so its run splices it.
      abortableRun(piAgent, ending);
      const turn = loop.prompt('real question');
      expect(loop.deliver('spoken during the turn').outcome).toBe('parked');
      await waitUntil(() => piAgent.promptCalls.length === 1);
      // Precondition: the content rode the prompt's batch into the transcript.
      expect(Array.isArray(piAgent.promptCalls[0])).toBe(true);
      expect(occurrences(piAgent, 'spoken during the turn')).toBe(1);

      await loop.abort();
      await turn.catch(() => {});
      await waitUntil(() => !loop.isLoopActive);

      expect(occurrences(piAgent, 'spoken during the turn')).toBe(0);
      expect(deadLettered.mock.calls.map((call) => call[0])).toEqual([
        expect.objectContaining({
          kind: 'wake_delivery',
          message: 'spoken during the turn',
          lastError: 'cancelled by abort (carrying run aborted)',
        }),
      ]);
      // Not re-parked either: nothing starts a run after the user stopped.
      expect(loop.pendingWakeDeliveryCount).toBe(0);
      expect(piAgent.promptCalls).toHaveLength(1);
      // The prompt's own input stays, as it does for any aborted prompt.
      expect(occurrences(piAgent, 'real question')).toBe(1);
    },
  );
});

describe('AgentLoop.deliver and abort', () => {
  it('abort() drops parked wake deliveries instead of waiting on a swept run', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    // Parks: the run has already made its only steering poll.
    loop.deliver('post-abort content');
    expect(loop.pendingWakeDeliveryCount).toBe(1);

    await loop.abort();
    await turn.catch(() => {});
    await waitUntil(() => !loop.isLoopActive);

    // The parked delivery was cancelled with the turn: no model run starts
    // for it after the user stopped the agent, and nothing stays parked.
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
    expect(occurrences(piAgent, 'post-abort content')).toBe(0);
  });

  it('drops a delivery parked during abort even when pending background results skip the gate wait', async () => {
    // The SF-D window: with a background completion pending, abort() skips
    // its gate-tail wait and resets (or a mid-abort drain replaces) the
    // controller, so a delivery that parked during abort's await windows
    // used to meet a fresh controller when the sweep dequeued and run
    // AFTER the user stopped the agent.
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    // First call hangs until abort rejects it; later calls (the background
    // drain, and the sweep run this test forbids) succeed.
    let rejectRun: ((err: Error) => void) | null = null;
    let firstCall = true;
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      if (firstCall) {
        firstCall = false;
        await new Promise<never>((_resolve, reject) => {
          rejectRun = reject;
        });
      }
      piAgent.state.messages.push(textAssistant('ok', Date.now()));
      return { content: 'ok' };
    };
    piAgent.abort = (): void => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      rejectRun?.(err);
      rejectRun = null;
    };

    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    // A background completion is pending, so abort() skips the gate wait.
    void partsOf(loop).background.enqueue({
      kind: 'subagent',
      taskId: 'task-mid-abort',
      result: {
        output: 'done',
        status: 'completed',
        usage: { turns: 1, cost: 0, durationMs: 5, contextTokens: 10 },
      },
    });

    const abortPromise = loop.abort();
    // Parks during abort's await window: after the synchronous drop at
    // abort() entry, before the epoch advances at its end.
    const result = loop.deliver('parked mid-abort');
    expect(result.outcome).toBe('parked');

    await abortPromise;
    await turn.catch(() => {});
    // Background completions survive the abort and are delivered.
    await waitUntil(() => piAgent.promptCalls.some(
      (call) => typeof call === 'string' && call.includes('task-mid-abort'),
    ));
    await waitUntil(() => !loop.isLoopActive);

    // The mid-abort delivery was cancelled with the turn, not delivered by
    // a post-abort run (neither a sweep run nor a prompt splice).
    expect(loop.pendingWakeDeliveryCount).toBe(0);
    expect(occurrences(piAgent, 'parked mid-abort')).toBe(0);
  });

  it('an abort during a swept run cancels the content instead of re-parking it', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const errored = vi.fn();
    loop.onError(errored);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    // First call hangs until abort rejects it; a later call (the re-park
    // path this test forbids) would succeed and show up in promptCalls.
    let rejectRun: ((err: Error) => void) | null = null;
    let first = true;
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      if (first) {
        first = false;
        await new Promise<never>((_resolve, reject) => {
          rejectRun = reject;
        });
      }
      piAgent.state.messages.push(textAssistant('ok', Date.now()));
      return { content: 'ok' };
    };
    piAgent.abort = (): void => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      rejectRun?.(err);
      rejectRun = null;
    };

    const drain = partsOf(loop).background.schedule();
    loop.deliver('swept then aborted');
    await drain;
    await waitUntil(() => piAgent.promptCalls.length === 1);

    await loop.abort();
    await waitUntil(() => !loop.isLoopActive);

    // The aborted swept run was unwound and its content cancelled, not
    // re-parked for a post-abort redelivery.
    expect(piAgent.promptCalls).toHaveLength(1);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
    expect(occurrences(piAgent, 'swept then aborted')).toBe(0);
  });
});

describe('AgentLoop.deliver cause tags', () => {
  it('prompt() carries its own cause tag into exactly the run it starts', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const seen: Array<readonly unknown[]> = [];
    const original = piAgent.prompt.bind(piAgent);
    piAgent.prompt = async (input) => {
      seen.push(loop.activeRunCauseTags);
      return original(input);
    };
    await loop.prompt('tagged', { causeTag: 'utterance-3' });
    await loop.prompt('untagged');
    expect(seen).toEqual([['utterance-3'], []]);
  });

  it('a run killed by a throwing consumer logger does not leak its cause tags', async () => {
    // The tag set and its clearing finally must be paired by construction:
    // logger.debug('loop start') runs between the batch take and the run's
    // try, and prefixLoggerWithLoopPath does not catch, so a throwing
    // consumer logger escapes runPromptOnce there. Pre-fix the tags were
    // assigned before that point and the finally never ran, leaving a dead
    // run's tags live at gate depth 0, where the error entry for this very
    // failure would read them as its causation stamp.
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent, {
      logger: {
        debug: (message: string) => {
          if (message.includes('loop start')) throw new Error('logger boom');
        },
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });

    const result = loop.deliver('tagged input', { causeTag: { kind: 'utterance', seq: 7 } });
    expect(result.outcome).toBe('prompted');
    await expect(result.turn).rejects.toThrow('logger boom');

    await waitUntil(() => !loop.isLoopActive);
    // The dead run's tags did not survive it.
    expect(loop.activeRunCauseTags).toEqual([]);
  });
});

describe('AgentLoop.waitForWakeDeliveriesDrained', () => {
  it('resolves at once with nothing parked, and when the sweep takes what parked', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    await loop.waitForWakeDeliveriesDrained();

    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    loop.deliver('parked');
    let drained = false;
    const wait = loop.waitForWakeDeliveriesDrained().then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Precondition: it is still parked, so the wait is really waiting.
    expect(loop.pendingWakeDeliveryCount).toBe(1);
    expect(drained).toBe(false);

    piAgent.releaseRun();
    await turn;
    await wait;
    expect(loop.pendingWakeDeliveryCount).toBe(0);
    expect(piAgent.promptCalls).toEqual(['long task', 'parked']);
  });

  it('is released by a retraction too', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    const { deliveryId } = loop.deliver('retract me');
    const wait = loop.waitForWakeDeliveriesDrained();
    loop.dropPendingWakeDeliveries((_content, delivery) => delivery.id === deliveryId);
    await wait;
    piAgent.releaseRun();
    await turn;
  });
});

describe('AgentLoop.deliver handles', () => {
  it('returns a stable id on every branch, and honors a supplied one', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const silent = loop.deliver('later', { wake: false });
    const prompted = loop.deliver('now');
    const parked = loop.deliver('next', { deliveryId: 'mine' });
    expect(silent.deliveryId).toEqual(expect.any(String));
    expect(prompted.deliveryId).toEqual(expect.any(String));
    expect(new Set([silent.deliveryId, prompted.deliveryId]).size).toBe(2);
    expect(parked).toMatchObject({ outcome: 'parked', deliveryId: 'mine' });
    await prompted.turn;
    await waitUntil(() => !loop.isLoopActive);
  });

  it('shows the retraction predicate each parked delivery handle', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    const keep = loop.deliver('same words', { causeTag: 'user' });
    const drop = loop.deliver('same words', { causeTag: 'voicing' });

    const seen: Array<{ id: string; causeTag?: unknown }> = [];
    const dropped = loop.dropPendingWakeDeliveries((_content, delivery) => {
      seen.push({ id: delivery.id, causeTag: delivery.causeTag });
      return delivery.id === drop.deliveryId;
    });
    expect(dropped).toEqual(['same words']);
    expect(seen).toEqual(expect.arrayContaining([
      { id: keep.deliveryId, causeTag: 'user' },
      { id: drop.deliveryId, causeTag: 'voicing' },
    ]));
    expect(loop.pendingWakeDeliveryCount).toBe(1);

    piAgent.releaseRun();
    await turn;
    await waitUntil(() => !loop.isLoopActive);
  });

  it('leaves the parked queue untouched when the retraction predicate throws', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    loop.deliver('first');
    loop.deliver('second');
    expect(() => loop.dropPendingWakeDeliveries((content) => {
      if (content === 'first') throw new Error('predicate bug');
      return true;
    })).toThrow('predicate bug');
    expect(loop.pendingWakeDeliveryCount).toBe(2);
    piAgent.releaseRun();
    await turn;
    await waitUntil(() => !loop.isLoopActive);
  });

  it('dead-letters a wake delivery with its handle and cause tag', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const deadLettered = vi.fn();
    loop.onBackgroundResultDeadLettered(deadLettered);
    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    const { deliveryId } = loop.deliver('cancelled with the turn', { causeTag: { seq: 4 } });

    await loop.abort();
    await turn.catch(() => {});
    await waitUntil(() => !loop.isLoopActive);
    expect(deadLettered.mock.calls[0]![0]).toMatchObject({
      kind: 'wake_delivery', deliveryId, causeTag: { seq: 4 },
    });
  });
});

describe('AgentLoop follow-up and queue surfaces', () => {
  it('followUp forwards to pi follow-up queue', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.followUp('after you finish');

    // pi's UserMessage carries a timestamp; pi pushes the message into the
    // transcript as given.
    expect(piAgent.followUpCalls).toEqual([{ role: 'user', content: 'after you finish', timestamp: expect.any(Number) }]);
  });

  it('followUp throws a clear error when the underlying agent lacks it', () => {
    const piAgent = createMockPiAgent();
    delete (piAgent as Partial<PiAgent>).followUp;
    const loop = createLoop(piAgent);

    expect(() => loop.followUp('x')).toThrow('does not expose followUp');
  });

  it('queue mode setters write through to pi', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.setSteeringQueueMode('all');
    loop.setFollowUpQueueMode('one-at-a-time');

    expect(piAgent.steeringMode).toBe('all');
    expect(piAgent.followUpMode).toBe('one-at-a-time');
  });

  it('clearAllQueues clears pi queues and returns dropped silent and parked content', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.deliver('queued one', { wake: false });
    loop.deliver('queued two', { wake: false });
    const dropped = loop.clearAllQueues();

    expect(piAgent.clearSteeringQueueCalls).toBe(1);
    expect(piAgent.clearFollowUpQueueCalls).toBe(1);
    expect(dropped).toEqual(['queued one', 'queued two']);
    expect(loop.queuedDeliveryCount).toBe(0);
  });

  it('clearQueuedDeliveries drops only the silent queue', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    loop.deliver('queued', { wake: false });
    const dropped = loop.clearQueuedDeliveries();

    expect(dropped).toEqual(['queued']);
    expect(loop.queuedDeliveryCount).toBe(0);
    expect(piAgent.clearSteeringQueueCalls).toBe(0);
    expect(piAgent.clearFollowUpQueueCalls).toBe(0);
  });
});

describe('AgentLoop teardown dead-letters loop-owned queued content', () => {
  // Like abort(), which dead-letters the parked content it drops, and like
  // pending background completions at teardown: nothing the loop accepted
  // for delivery vanishes without an entry saying so.

  it('destroy() dead-letters parked wake and queued silent deliveries', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const deadLettered = vi.fn();
    loop.onBackgroundResultDeadLettered(deadLettered);

    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    loop.deliver('parked behind the run');
    loop.deliver('for the next prompt', { wake: false });
    // Precondition: both are held by the loop when teardown starts.
    expect(loop.pendingWakeDeliveryCount).toBe(1);
    expect(loop.queuedDeliveryCount).toBe(1);

    await loop.destroy();
    await turn.catch(() => {});

    const entries = deadLettered.mock.calls.map((call) => call[0] as {
      kind: string; taskId: string; lastError: string; message: string;
    });
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'wake_delivery', message: 'parked behind the run', lastError: 'agent shut down before delivery',
      }),
      expect.objectContaining({
        kind: 'silent_delivery', taskId: 'silent-delivery', message: 'for the next prompt',
        lastError: 'agent shut down before delivery',
      }),
    ]));
    expect(entries).toHaveLength(2);
    expect(loop.getDeadLetteredBackgroundResults().map((result) => result.message))
      .toEqual(expect.arrayContaining(['parked behind the run', 'for the next prompt']));
  });
});

describe('AgentLoop abort-cancelled wake deliveries are dead-lettered', () => {
  // An abort deliberately destroys parked wake content. The destruction
  // must reach the dead-letter surface (and through it the facade's
  // session log): in duplex the router owns delivery and the log is the
  // durable record of undelivered content, so a bare log line would leave
  // an utterance with no reply and nothing saying why.

  it('abort() dead-letters the parked deliveries it drops at entry', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const deadLettered = vi.fn();
    loop.onBackgroundResultDeadLettered(deadLettered);

    piAgent.finalHold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    loop.deliver('cancelled with the turn');
    expect(loop.pendingWakeDeliveryCount).toBe(1);

    await loop.abort();
    await turn.catch(() => {});
    await waitUntil(() => !loop.isLoopActive);

    expect(deadLettered).toHaveBeenCalledTimes(1);
    const entry = deadLettered.mock.calls[0]![0] as {
      kind: string; attempts: number; lastError: string; message: string;
    };
    expect(entry.kind).toBe('wake_delivery');
    expect(entry.lastError).toContain('cancelled by abort');
    expect(entry.message).toBe('cancelled with the turn');
    expect(
      loop.getDeadLetteredBackgroundResults().some(
        (result) => result.message === 'cancelled with the turn',
      ),
    ).toBe(true);
  });

  it('the epoch gate dead-letters deliveries parked during the abort window', async () => {
    // Same shape as the SF-D window test above: with a background
    // completion pending, abort() skips the gate wait, and a delivery that
    // parks during abort's await windows is dropped by the epoch gate at
    // the next take of the parked queue.
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const deadLettered = vi.fn();
    loop.onBackgroundResultDeadLettered(deadLettered);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    let rejectRun: ((err: Error) => void) | null = null;
    let firstCall = true;
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      if (firstCall) {
        firstCall = false;
        await new Promise<never>((_resolve, reject) => {
          rejectRun = reject;
        });
      }
      piAgent.state.messages.push(textAssistant('ok', Date.now()));
      return { content: 'ok' };
    };
    piAgent.abort = (): void => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      rejectRun?.(err);
      rejectRun = null;
    };

    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    void partsOf(loop).background.enqueue({
      kind: 'subagent',
      taskId: 'task-mid-abort',
      result: {
        output: 'done',
        status: 'completed',
        usage: { turns: 1, cost: 0, durationMs: 5, contextTokens: 10 },
      },
    });

    const abortPromise = loop.abort();
    const result = loop.deliver('parked mid-abort');
    expect(result.outcome).toBe('parked');

    await abortPromise;
    await turn.catch(() => {});
    await waitUntil(() => deadLettered.mock.calls.some((call) =>
      (call[0] as { message: string }).message === 'parked mid-abort'));
    const entry = deadLettered.mock.calls
      .map((call) => call[0] as { kind: string; lastError: string; message: string })
      .find((candidate) => candidate.message === 'parked mid-abort')!;
    expect(entry.kind).toBe('wake_delivery');
    expect(entry.lastError).toContain('abort window');
  });

  it('an abort during a swept run dead-letters the cancelled content', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    loop.onError(() => {});
    const deadLettered = vi.fn();
    loop.onBackgroundResultDeadLettered(deadLettered);
    await loop.prompt('warm up');
    piAgent.promptCalls = [];

    let rejectRun: ((err: Error) => void) | null = null;
    let first = true;
    piAgent.prompt = async (input: string | AgentMessage[]): Promise<unknown> => {
      piAgent.promptCalls.push(input);
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      piAgent.state.messages.push(...messages);
      if (first) {
        first = false;
        await new Promise<never>((_resolve, reject) => {
          rejectRun = reject;
        });
      }
      piAgent.state.messages.push(textAssistant('ok', Date.now()));
      return { content: 'ok' };
    };
    piAgent.abort = (): void => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      rejectRun?.(err);
      rejectRun = null;
    };

    const drain = partsOf(loop).background.schedule();
    loop.deliver('swept then aborted');
    await drain;
    await waitUntil(() => piAgent.promptCalls.length === 1);

    await loop.abort();
    await waitUntil(() => !loop.isLoopActive);

    await waitUntil(() => deadLettered.mock.calls.length === 1);
    const entry = deadLettered.mock.calls[0]![0] as {
      kind: string; lastError: string; message: string;
    };
    expect(entry.kind).toBe('wake_delivery');
    expect(entry.lastError).toContain('carrying run aborted');
    expect(entry.message).toBe('swept then aborted');
  });
});

// ---------------------------------------------------------------------------
// atTurnBoundary fallback: when pi's queues are not provably empty at the
// turn boundary, the hand-over would not be exact (pi's poll would drain
// something else with it), so the delivery stays parked and opens the next
// run instead, still carrying its cause tag.
// ---------------------------------------------------------------------------

describe('AgentLoop.deliver atTurnBoundary fallback to the next run', () => {
  function boundarySetup(queueState: 'empty' | 'non-empty' | 'unknown') {
    let emit!: (event: PiEvent) => void;
    let release: (() => void) | null = null;
    const runs: Array<{ input: string | AgentMessage[]; tags: readonly unknown[] }> = [];
    const steer = vi.fn();
    const pi = {
      state: { messages: [] as AgentMessage[], systemPrompt: '', tools: [] },
      subscribe(handler: (event: PiEvent) => void) {
        emit = handler;
        return () => {};
      },
      async prompt(input: string | AgentMessage[]) {
        runs.push({ input, tags: loop.activeRunCauseTags });
        if (runs.length === 1) await new Promise<void>((resolve) => { release = resolve; });
        pi.state.messages.push(textAssistant('ok', 0));
        return {};
      },
      abort() {},
      async waitForIdle() {},
      reset() {},
      steer,
      ...(queueState !== 'unknown' ? { hasQueuedMessages: () => queueState === 'non-empty' } : {}),
    };
    const loop = createLoop(pi as unknown as PiAgent);
    const endTurn = (): void => emit({
      type: 'turn_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'working' }],
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0 } },
      },
    });
    return { loop, runs, steer, endTurn, release: () => release?.() };
  }

  it.each(['non-empty', 'unknown'] as const)(
    'defers to the next run when pi queue state is %s',
    async (queueState) => {
      const t = boundarySetup(queueState);
      const turn = t.loop.prompt('do the work');
      await waitUntil(() => t.loop.isPrompting);
      expect(t.loop.deliver('change course', { atTurnBoundary: true, causeTag: 'redirect' }).outcome)
        .toBe('parked');

      t.endTurn();
      // Not handed to the live run: pi's queue was left alone and the
      // content is still parked, and the live run did not take its tag.
      expect(t.steer).not.toHaveBeenCalled();
      expect(t.loop.pendingWakeDeliveryCount).toBe(1);
      expect(t.loop.activeRunCauseTags).toEqual([]);

      t.release();
      await turn;
      await waitUntil(() => t.runs.length === 2);
      await t.loop.waitForLoopIdle();
      // The next run opens with it, exactly once, carrying its causation.
      expect(t.runs[1]!.input).toBe('change course');
      expect(t.runs[1]!.tags).toEqual(['redirect']);
      expect(t.loop.pendingWakeDeliveryCount).toBe(0);
      expect(t.steer).not.toHaveBeenCalled();
    },
  );

  it('hands it to the live run when pi reports empty queues (the precondition path)', async () => {
    // Same harness, queues reported empty: the boundary hand-over happens.
    const t = boundarySetup('empty');
    const turn = t.loop.prompt('do the work');
    await waitUntil(() => t.loop.isPrompting);
    t.loop.deliver('change course', { atTurnBoundary: true, causeTag: 'redirect' });
    t.endTurn();
    expect(t.steer).toHaveBeenCalledTimes(1);
    expect(t.loop.activeRunCauseTags).toEqual(['redirect']);
    t.release();
    await turn;
  });
});

describe('AgentLoop origin context', () => {
  it('hands every handler an origin no earlier handler can rewrite', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const seen: string[] = [];
    loop.onLoopComplete((origin) => {
      try {
        (origin as { loopPath: string }).loopPath = 'rewritten';
      } catch {
        // A frozen origin refuses the write in strict mode.
      }
      seen.push(origin.loopPath);
    });
    loop.onLoopComplete((origin) => { seen.push(origin.loopPath); });
    await loop.prompt('one');
    await loop.prompt('two');
    expect(seen).toEqual(['main', 'main', 'main', 'main']);
  });
});
