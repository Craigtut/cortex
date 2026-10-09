/**
 * CortexAgent facade skeleton (docs/cortex/duplex/facade-api.md):
 * passthrough mode routing, the duplex not-implemented guard, config
 * routing completeness, session log wiring with causation stamps,
 * append-then-emit ordering, abort scope semantics, and the settlement
 * predicates built on loop-gate depth.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig, SubAgentResult, TrackedSubAgent } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import type { CortexTool } from '../../src/tool-contract.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import {
  CortexAgent,
  CONFIG_ROUTING,
  AGENT_LOOP_DELEGATION,
  buildReasonerConfig,
} from '../../src/cortex-agent.js';
import type { CortexAgentConfig, ForwardedLoopMember } from '../../src/cortex-agent.js';
import { partsOf } from './agent-loop/parts.js';
import type { LoosePiEvent } from '../helpers/pi-events.js';

// These harnesses bypass create() and inject already-resolved loop configuration.
type ResolvedFacadeConfig = Omit<CortexAgentConfig, 'sandbox'> & Pick<AgentLoopConfig, 'sandbox'>;

// ---------------------------------------------------------------------------
// Mock PiAgent (holdable runs, steering/follow-up queues), the shared shape
// used across agent-loop unit tests.
// ---------------------------------------------------------------------------

interface FacadeMockPiAgent extends PiAgent {
  emitEvent: (event: LoosePiEvent) => void;
  promptCalls: Array<string | AgentMessage[]>;
  steeringQueue: Array<{ role: string; content: string }>;
  followUpQueue: Array<{ role: string; content: string }>;
  clearSteeringQueueCalls: number;
  clearFollowUpQueueCalls: number;
  /** When true, the next run pauses until releaseRun() is called. */
  hold: boolean;
  /** When set, the next run throws this error after starting. */
  failWith: Error | null;
  releaseRun: () => void;
}

function createMockPiAgent(): FacadeMockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let releaseRun: (() => void) | null = null;
  let rejectRun: ((err: Error) => void) | null = null;
  let idleResolve: (() => void) | null = null;
  let running = false;

  const agent: FacadeMockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    promptCalls: [],
    steeringQueue: [],
    followUpQueue: [],
    clearSteeringQueueCalls: 0,
    clearFollowUpQueueCalls: 0,
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
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 120,
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
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
      throw new Error('not used in these tests');
    },

    abort(): void {
      // Like real pi: aborting a held run fails it.
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
      agent.clearSteeringQueueCalls += 1;
      agent.steeringQueue = [];
    },

    clearFollowUpQueue(): void {
      agent.clearFollowUpQueueCalls += 1;
      agent.followUpQueue = [];
    },

    hasQueuedMessages(): boolean {
      return agent.steeringQueue.length > 0 || agent.followUpQueue.length > 0;
    },
  };

  return agent;
}

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
) => AgentLoop;

type TestCortexAgentConstructor = new (
  reasoner: AgentLoop,
  config: ResolvedFacadeConfig,
) => CortexAgent;

/** Whether the facade's debounced onStateChanged emission is armed. */
function stateEmissionScheduled(facade: CortexAgent): boolean {
  return (facade as unknown as { stateEmitter: { scheduled: boolean } }).stateEmitter.scheduled;
}

function testModel(): CortexModel {
  return wrapModel(
    { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel,
    'anthropic',
    'claude-sonnet-4-20250514',
  );
}

function createLoop(agent: PiAgent, overrides?: Partial<AgentLoopConfig>): AgentLoop {
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  return new AgentLoopCtor(agent, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    ...overrides,
  });
}

function createFacade(overrides?: Partial<ResolvedFacadeConfig>): {
  facade: CortexAgent;
  loop: AgentLoop;
  piAgent: FacadeMockPiAgent;
} {
  const piAgent = createMockPiAgent();
  const loop = createLoop(piAgent, overrides as Partial<AgentLoopConfig>);
  const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
  const facade = new CortexAgentCtor(loop, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    // Explicit since duplex became the default (D14): this suite drives a
    // single mock loop through the private constructor, so passthrough is
    // the mode under test, not the mode that happened to be the default.
    mode: 'passthrough',
    ...overrides,
  });
  return { facade, loop, piAgent };
}

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Register a fake tracked sub-agent on the loop's manager. */
function trackFakeSubAgent(
  loop: AgentLoop,
  taskId: string,
  options?: { background?: boolean },
): { resolve: (result: SubAgentResult) => void; entry: TrackedSubAgent } {
  let resolveCompletion!: (result: SubAgentResult) => void;
  const completion = new Promise<SubAgentResult>((resolve) => {
    resolveCompletion = resolve;
  });
  const entry: TrackedSubAgent = {
    taskId,
    agent: {
      loopPath: `main/${taskId}`,
      currentContextTokenCount: 0,
      isLoopActive: false,
      isPrompting: false,
      deliver: () => ({ outcome: 'queued' as const }),
      steer: () => {},
      abort: async () => {},
      destroy: async () => {},
      getBudgetGuard: () => ({
        getTurnCount: () => 0,
        getTotalCost: () => 0,
        getMaxTurns: () => Infinity,
        getMaxCost: () => Infinity,
      }),
    },
    instructions: `instructions for ${taskId}`,
    background: options?.background ?? true,
    spawnedAt: Date.now(),
    completion,
    resolve: resolveCompletion,
    toolCount: 0,
    lastToolName: null,
    lastToolSummary: null,
    lastToolStartedAt: null,
    pendingPermission: null,
  };
  expect(loop.getSubAgentManager().track(entry)).toBe(true);
  return { resolve: resolveCompletion, entry };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe('CortexAgent modes', () => {
  it('duplex without a talker loop throws rather than silently degrading', () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
    expect(
      () =>
        new CortexAgentCtor(loop, {
          model: testModel(),
          workingDirectory: '/tmp/test-workspace',
          mode: 'duplex',
        }),
    ).toThrow(/requires a talker loop/);
  });

  it('defaults to passthrough and runs prompts through the reasoner', async () => {
    const { facade, piAgent } = createFacade();
    const result = await facade.prompt('hello');
    expect(result).toEqual({ content: 'ok' });
    expect(piAgent.promptCalls).toEqual(['hello']);
  });
});

// ---------------------------------------------------------------------------
// Config routing
// ---------------------------------------------------------------------------

describe('CortexAgent config routing', () => {
  it('routes every key: the table covers exactly the config surface', () => {
    // Compile-time exhaustiveness is enforced by the mapped type; this
    // guards the runtime shape (no key routed twice, none dangling).
    const tableKeys = Object.keys(CONFIG_ROUTING).sort();
    expect(new Set(tableKeys).size).toBe(tableKeys.length);
    expect(tableKeys).toContain('model');
    expect(tableKeys).toContain('mode');
    expect(tableKeys).toContain('tools');
  });

  it('strips facade-owned keys and passes everything else through unchanged', () => {
    const resolvePermission = vi.fn();
    const config: ResolvedFacadeConfig = {
      model: testModel(),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'base',
      slots: ['profile'],
      thinkingLevel: 'high',
      budgetGuard: { maxTurns: 5 },
      retryPolicy: { enabled: false },
      resolvePermission,
      sessionId: 'session-1',
      loopPath: 'custom-path',
      mode: 'passthrough',
      talker: {},
      idleSignal: () => true,
      sessionLog: { maxEntries: 10 },
      stateChangeDebounceMs: 5,
    };

    const routed = buildReasonerConfig(config) as unknown as Record<string, unknown>;

    // Facade keys never reach the loop config.
    for (const facadeKey of ['mode', 'talker', 'idleSignal', 'sessionLog', 'stateChangeDebounceMs']) {
      expect(facadeKey in routed).toBe(false);
    }

    // Routed keys arrive unchanged (same references, same values).
    expect(routed['model']).toBe(config.model);
    expect(routed['workingDirectory']).toBe('/tmp/test-workspace');
    expect(routed['initialBasePrompt']).toBe('base');
    expect(routed['slots']).toBe(config.slots);
    expect(routed['thinkingLevel']).toBe('high');
    expect(routed['budgetGuard']).toBe(config.budgetGuard);
    expect(routed['retryPolicy']).toBe(config.retryPolicy);
    expect(routed['resolvePermission']).toBe(resolvePermission);
    expect(routed['sessionId']).toBe('session-1');
    expect(routed['loopPath']).toBe('custom-path');
  });

  it('keys absent from consumer config stay absent (no key materializes as undefined)', () => {
    const routed = buildReasonerConfig({
      model: testModel(),
      workingDirectory: '/tmp/test-workspace',
    }) as unknown as Record<string, unknown>;
    expect('slots' in routed).toBe(false);
    expect('budgetGuard' in routed).toBe(false);
    expect('sessionId' in routed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// prompt() serialization
// ---------------------------------------------------------------------------

describe('CortexAgent.prompt', () => {
  it('never throws on a busy loop: concurrent prompts serialize in order', async () => {
    const { facade, piAgent } = createFacade();

    piAgent.hold = true;
    const first = facade.prompt('first');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    // Direct AgentLoop.prompt() would throw here; the facade queues.
    const second = facade.prompt('second');

    piAgent.releaseRun();
    await expect(first).resolves.toEqual({ content: 'ok' });
    await expect(second).resolves.toEqual({ content: 'ok' });
    expect(piAgent.promptCalls).toEqual(['first', 'second']);
  });

  it('each serialized prompt resolves against the turn that carried its input', async () => {
    const { facade, piAgent } = createFacade();

    piAgent.hold = true;
    const first = facade.prompt('first');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    piAgent.failWith = new Error('boom');
    const second = facade.prompt('second');
    piAgent.releaseRun();

    // The first turn fails; the second still runs and succeeds.
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toEqual({ content: 'ok' });
    expect(piAgent.promptCalls).toEqual(['first', 'second']);
  });

  it('threads DirectCompletionOptions through to the loop', async () => {
    const { facade, loop, piAgent } = createFacade();
    const promptSpy = vi.spyOn(loop, 'prompt');
    const options = { sessionId: 'per-call-affinity' };
    await facade.prompt('hello', options);
    // Plus the facade's own causation tag for the logged utterance.
    expect(promptSpy).toHaveBeenCalledWith('hello', {
      ...options,
      causeTag: { kind: 'utterance', seq: expect.any(Number) },
    });
    expect(piAgent.promptCalls).toEqual(['hello']);
  });

  it('rejects after destroy', async () => {
    const { facade } = createFacade();
    await facade.destroy();
    await expect(facade.prompt('late')).rejects.toThrow('CortexAgent has been destroyed');
  });

  it('rejects unconfigured input without logging a phantom utterance', async () => {
    const piAgent = createMockPiAgent();
    const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
    const loop = new AgentLoopCtor(piAgent, {
      model: testModel(),
      workingDirectory: '/tmp/test-workspace',
      slots: [],
    });
    const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
    const facade = new CortexAgentCtor(loop, {
      model: testModel(),
      workingDirectory: '/tmp/test-workspace',
      mode: 'passthrough',
    });

    await expect(facade.prompt('never ran')).rejects.toThrow(/not configured/);
    expect(() => facade.deliver('never ran either')).toThrow(/not configured/);
    expect(facade.getLog()).toEqual([]);
    expect(piAgent.promptCalls).toEqual([]);
  });

  it('rejects on a directly destroyed loop without logging a phantom utterance', async () => {
    const { facade, loop } = createFacade();
    await loop.destroy();
    await expect(facade.prompt('too late')).rejects.toThrow(/destroyed/);
    expect(facade.getLog().filter((e) => e.type === 'utterance')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Session log wiring
// ---------------------------------------------------------------------------

describe('CortexAgent session log', () => {
  it('logs the utterance before the run and the reply with a causation stamp', async () => {
    const { facade } = createFacade();
    await facade.prompt('do the thing');

    const entries = facade.getLog();
    expect(entries.map((e) => e.type)).toEqual(['utterance', 'reply']);
    const [utterance, reply] = entries;
    expect(utterance!.content).toBe('do the thing');
    expect(utterance!.causedBy).toBeUndefined();
    expect(reply!.content).toBe('ok');
    expect(reply!.causedBy).toBe(utterance!.seq);
    expect(reply!.loopPath).toBe('main');
  });

  it('append-then-emit: subscribers see the utterance before pi sees the run', async () => {
    const { facade, piAgent } = createFacade();
    const order: string[] = [];
    facade.subscribeLog((event) => {
      if (event.kind === 'entry') order.push(`log:${event.entry.type}`);
    });
    const originalPrompt = piAgent.prompt.bind(piAgent);
    piAgent.prompt = async (input) => {
      order.push('pi:prompt');
      return originalPrompt(input);
    };

    await facade.prompt('hello');
    expect(order[0]).toBe('log:utterance');
    expect(order.indexOf('pi:prompt')).toBeGreaterThan(order.indexOf('log:utterance'));
  });

  it('a prompted deliver() logs the utterance and stamps the reply causation', async () => {
    const { facade } = createFacade();
    const result = facade.deliver('delivered input');
    expect(result.outcome).toBe('prompted');
    await result.turn;

    const entries = facade.getLog();
    expect(entries.map((e) => e.type)).toEqual(['utterance', 'reply']);
    expect(entries[1]!.causedBy).toBe(entries[0]!.seq);
  });

  it('a silent deliver() logs the utterance without starting a run', () => {
    const { facade, piAgent } = createFacade();
    const result = facade.deliver('background fact', { wake: false, target: 'work' });
    expect(result.outcome).toBe('queued');
    expect(piAgent.promptCalls).toEqual([]);

    const entries = facade.getLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe('utterance');
    expect(entries[0]!.data).toEqual({ target: 'work' });
  });

  it('a failed run logs an error entry stamped with the utterance causation', async () => {
    const { facade, piAgent } = createFacade({ retryPolicy: { enabled: false } });
    piAgent.failWith = new Error('provider exploded');

    await expect(facade.prompt('doomed')).rejects.toThrow('provider exploded');

    const entries = facade.getLog();
    const utterance = entries.find((e) => e.type === 'utterance')!;
    const error = entries.find((e) => e.type === 'error')!;
    expect(error.content).toContain('provider exploded');
    expect(error.causedBy).toBe(utterance.seq);
    expect(error.data).toMatchObject({ severity: expect.any(String) });
  });

  it('a scheduled retry logs a retrying entry', async () => {
    const { facade, piAgent } = createFacade({
      retryPolicy: { backoffMs: [1], maxAttempts: 1 },
    });
    piAgent.failWith = new Error('socket hang up');
    // continue() resumes the failed turn on retry.
    piAgent.continue = async () => {
      delete (piAgent.state as Record<string, unknown>)['errorMessage'];
      piAgent.emitEvent({ type: 'turn_end', text: 'recovered' });
      piAgent.emitEvent({ type: 'agent_end', messages: [] });
      return { content: 'recovered' };
    };

    await facade.prompt('flaky');

    const retrying = facade.getLog().filter((e) => e.type === 'retrying');
    expect(retrying).toHaveLength(1);
    expect(retrying[0]!.data).toMatchObject({ attempt: 1, category: 'network' });
    expect(retrying[0]!.causedBy).toBe(facade.getLog()[0]!.seq);
  });

  it('sub-agent lifecycle entries chain causation: spawn during a run, completion to the spawn', async () => {
    const { facade, loop } = createFacade();

    // Spawn a fake child while the facade-initiated run is live (from the
    // turn-complete handler), so the spawn lifecycle entry picks up the
    // utterance causation.
    let spawned = false;
    loop.onTurnComplete(() => {
      if (!spawned) {
        spawned = true;
        trackFakeSubAgent(loop, 'task-1');
      }
    });
    await facade.prompt('spawn something');

    const spawn = facade.getLog().find((e) => e.data?.['event'] === 'sub_agent_spawned')!;
    const utterance = facade.getLog().find((e) => e.type === 'utterance')!;
    expect(spawn.causedBy).toBe(utterance.seq);
    expect(spawn.data).toMatchObject({ taskId: 'task-1', background: true });

    // Completion entry is caused by the spawn entry.
    loop.getSubAgentManager().complete('task-1', {
      output: 'done',
      status: 'completed',
      usage: { turns: 1, cost: 0.01, durationMs: 5, contextTokens: 100 },
    });

    const completed = facade.getLog().find((e) => e.data?.['event'] === 'sub_agent_completed')!;
    expect(completed.causedBy).toBe(spawn.seq);
    expect(completed.data).toMatchObject({ taskId: 'task-1', status: 'completed' });
  });

  it('logs a cancelled sub-agent as a cancellation milestone, not a failure', async () => {
    const { facade, loop } = createFacade();
    trackFakeSubAgent(loop, 'task-cancel');
    const spawn = facade.getLog().find((e) => e.data?.['event'] === 'sub_agent_spawned')!;

    await facade.abort('work');

    const entries = facade.getLog();
    const cancelled = entries.find((e) => e.data?.['event'] === 'sub_agent_cancelled')!;
    expect(cancelled).toBeDefined();
    expect(cancelled.type).toBe('lifecycle');
    expect(cancelled.content).toBe('Sub-agent task-cancel cancelled');
    expect(cancelled.causedBy).toBe(spawn.seq);
    // An explicit cancel carries its reason, distinct from a shutdown
    // teardown (next test); 2b's delivery router keys on it.
    expect(cancelled.data).toMatchObject({ taskId: 'task-cancel', reason: 'cancel' });
    expect(entries.find((e) => e.data?.['event'] === 'sub_agent_failed')).toBeUndefined();

    // A genuine failure still logs as one.
    trackFakeSubAgent(loop, 'task-fail');
    loop.getSubAgentManager().fail('task-fail', 'child exploded');
    const failed = facade.getLog().find((e) => e.data?.['event'] === 'sub_agent_failed')!;
    expect(failed.content).toBe('Sub-agent task-fail failed: child exploded');
    expect(failed.data).toMatchObject({ taskId: 'task-fail', error: 'child exploded' });
  });

  it('a shutdown teardown logs the cancellation with reason shutdown', async () => {
    const { facade, loop } = createFacade();
    trackFakeSubAgent(loop, 'task-teardown');

    // Direct loop destroy: the cancelAll sweep, not an explicit cancel.
    await loop.destroy();

    const cancelled = facade.getLog().find((e) => e.data?.['event'] === 'sub_agent_cancelled')!;
    expect(cancelled).toBeDefined();
    expect(cancelled.data).toMatchObject({ taskId: 'task-teardown', reason: 'shutdown' });
  });

  it('entries produced outside any facade-initiated run carry no causation stamp', () => {
    const { facade, loop } = createFacade();
    trackFakeSubAgent(loop, 'task-idle');
    const spawn = facade.getLog().find((e) => e.data?.['event'] === 'sub_agent_spawned')!;
    expect(spawn.causedBy).toBeUndefined();
  });

  it('getLog(fromSeq) and subscribeLog replay delegate to the log', async () => {
    const { facade } = createFacade();
    await facade.prompt('one');
    await facade.prompt('two');

    const all = facade.getLog();
    expect(all.length).toBeGreaterThanOrEqual(4);
    const tail = facade.getLog(all[2]!.seq);
    expect(tail.map((e) => e.seq)).toEqual(all.slice(2).map((e) => e.seq));

    const replayed: number[] = [];
    const unsubscribe = facade.subscribeLog((event) => {
      if (event.kind === 'entry') replayed.push(event.entry.seq);
    }, all[2]!.seq);
    expect(replayed).toEqual(all.slice(2).map((e) => e.seq));
    unsubscribe();
    unsubscribe();
  });

  it('whitespace deliver() throws without logging an utterance', () => {
    const { facade } = createFacade();
    expect(() => facade.deliver('   ')).toThrow('non-whitespace');
    expect(facade.getLog()).toEqual([]);
  });

  it('log order matches execution order when a same-tick deliver() runs first', async () => {
    const { facade, piAgent } = createFacade();

    // The prompt is accepted first but its run is chained; the deliver sees
    // an empty gate in the same tick and starts its run immediately. The
    // log (the ordering authority) must record them in execution order.
    const turn = facade.prompt('queued input');
    const result = facade.deliver('barged-in input');
    expect(result.outcome).toBe('prompted');
    await Promise.all([turn, result.turn]);

    expect(piAgent.promptCalls).toEqual(['barged-in input', 'queued input']);
    const utterances = facade
      .getLog()
      .filter((e) => e.type === 'utterance')
      .map((e) => e.content);
    expect(utterances).toEqual(['barged-in input', 'queued input']);

    // Causation still binds each reply to its own utterance.
    const entries = facade.getLog();
    for (const reply of entries.filter((e) => e.type === 'reply')) {
      const cause = entries.find((e) => e.seq === reply.causedBy);
      expect(cause?.type).toBe('utterance');
    }
  });
});

// ---------------------------------------------------------------------------
// Abort scopes
// ---------------------------------------------------------------------------

describe('CortexAgent.abort', () => {
  it("abort('all') aborts the in-flight turn, clears queues, and cancels children", async () => {
    const { facade, loop, piAgent } = createFacade();
    trackFakeSubAgent(loop, 'task-1');

    piAgent.hold = true;
    const turn = facade.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    facade.deliver('queued silent', { wake: false });
    facade.steer('steered');

    await facade.abort();
    await expect(turn).rejects.toThrow();

    expect(facade.queuedDeliveryCount).toBe(0);
    expect(piAgent.clearSteeringQueueCalls).toBeGreaterThan(0);
    expect(piAgent.clearFollowUpQueueCalls).toBeGreaterThan(0);
    expect(loop.getSubAgentManager().activeCount).toBe(0);
    expect(loop.getSubAgentManager().isCancelled('task-1')).toBe(true);

    const lifecycle = facade.getLog().find((e) => e.data?.['event'] === 'abort')!;
    expect(lifecycle.data).toMatchObject({ scope: 'all' });

    // The loop remains usable after abort.
    await facade.prompt('after abort');
    expect(piAgent.promptCalls.at(-1)).toBe('after abort');
  });

  it("abort('conversation') leaves children running", async () => {
    const { facade, loop } = createFacade();
    trackFakeSubAgent(loop, 'task-keep');

    await facade.abort('conversation');

    expect(loop.getSubAgentManager().activeCount).toBe(1);
    expect(loop.getSubAgentManager().isCancelled('task-keep')).toBe(false);
  });

  it("abort('work') cancels children", async () => {
    const { facade, loop } = createFacade();
    trackFakeSubAgent(loop, 'task-work');

    await facade.abort('work');

    expect(loop.getSubAgentManager().activeCount).toBe(0);
    expect(loop.getSubAgentManager().isCancelled('task-work')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Settlement predicates
// ---------------------------------------------------------------------------

describe('CortexAgent settlement', () => {
  it('conversationIdle keys on gate depth and facade prompt queue', async () => {
    const { facade, piAgent } = createFacade();
    expect(facade.conversationIdle).toBe(true);

    piAgent.hold = true;
    const turn = facade.prompt('busy');
    expect(facade.conversationIdle).toBe(false);
    await waitUntil(() => piAgent.promptCalls.length === 1);

    piAgent.releaseRun();
    await turn;
    await facade.waitForConversationIdle();
    expect(facade.conversationIdle).toBe(true);
  });

  it('waitForConversationIdle covers serialized facade prompts still queued', async () => {
    const { facade, piAgent } = createFacade();
    piAgent.hold = true;
    const first = facade.prompt('first');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    const second = facade.prompt('second');

    let settled = false;
    const wait = facade.waitForConversationIdle().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    piAgent.releaseRun();
    await Promise.all([first, second, wait]);
    expect(settled).toBe(true);
    expect(piAgent.promptCalls).toEqual(['first', 'second']);
  });

  it('workSettled is false while a sub-agent is active and true after it completes', async () => {
    const { facade, loop } = createFacade();
    expect(facade.workSettled).toBe(true);

    trackFakeSubAgent(loop, 'task-settle');
    expect(facade.workSettled).toBe(false);

    let settled = false;
    const wait = facade.waitForWorkSettled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    loop.getSubAgentManager().complete('task-settle', {
      output: 'done',
      status: 'completed',
      usage: { turns: 1, cost: 0, durationMs: 1, contextTokens: 0 },
    });
    await wait;
    expect(settled).toBe(true);
    expect(facade.workSettled).toBe(true);
  });

  it('waitForWorkSettled blocks on ask settlement without hot-polling', async () => {
    const { facade, loop } = createFacade();
    const registry = partsOf(loop);
    registry.asks.register({
      askId: 'ask-outlives-child',
      loopPath: 'main',
      toolName: 'Bash',
      renderedRequest: 'Bash: make deploy',
      requestedAt: Date.now(),
      voiced: false,
    });
    expect(facade.workSettled).toBe(false);

    // Fixed observation window for a negative assertion: while the ask is
    // pending the wait must neither resolve nor spin. A setImmediate poll
    // re-evaluates the predicate hundreds of times in this window; the
    // event-driven wait checks a handful of times then blocks.
    const pendingAsksSpy = vi.spyOn(loop, 'getPendingAsks');
    let settled = false;
    const wait = facade.waitForWorkSettled().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(pendingAsksSpy.mock.calls.length).toBeLessThan(20);

    registry.asks.settle('ask-outlives-child');
    await wait;
    expect(settled).toBe(true);
    expect(facade.workSettled).toBe(true);
  });

  it('workSettled counts parked wake deliveries (and settles once they deliver)', async () => {
    const { facade, piAgent } = createFacade();

    piAgent.hold = true;
    const turn = facade.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    const result = facade.deliver('mid-run redirect');
    expect(result.outcome).toBe('parked');
    expect(facade.workSettled).toBe(false);

    piAgent.releaseRun();
    await turn;
    await facade.waitForWorkSettled();
    expect(facade.workSettled).toBe(true);
    // The sweep delivered the parked content before settlement.
    expect(piAgent.promptCalls).toContain('mid-run redirect');
  });
});

// ---------------------------------------------------------------------------
// Delegated surface
// ---------------------------------------------------------------------------

describe('CortexAgent delegation', () => {
  it('structurally exposes every non-withheld public AgentLoop member', () => {
    // The delegation table in src/cortex-agent.ts is compile-time exhaustive
    // over AgentLoop's public surface (a new member is a type error until
    // routed). This asserts the runtime facade matches every disposition,
    // so a forwarding gap (or an accidental exposure of a withheld member)
    // cannot silently reappear.
    const { facade } = createFacade();
    for (const [member, disposition] of Object.entries(AGENT_LOOP_DELEGATION)) {
      if (disposition === 'forwarded') {
        expect(member in facade, `AgentLoop.${member} is marked forwarded but missing on CortexAgent`).toBe(true);
      } else {
        expect(
          member in facade,
          `AgentLoop.${member} is marked ${disposition} but exposed on CortexAgent; update the table if intended`,
        ).toBe(false);
      }
    }
  });

  it('exposes the reasoner event bridge, context manager, and usage verbatim', async () => {
    const { facade, loop } = createFacade();
    expect(facade.getEventBridge()).toBe(loop.getEventBridge());
    expect(facade.getContextManager()).toBe(loop.getContextManager());
    expect(facade.getBudgetGuard()).toBe(loop.getBudgetGuard());

    await facade.prompt('hello');
    expect(facade.getSessionUsage()).toEqual(loop.getSessionUsage());
    expect(facade.getConversationHistory()).toEqual(loop.getConversationHistory());
  });

  it('destroy is idempotent and tears down the loop', async () => {
    const { facade, loop } = createFacade();
    await facade.destroy();
    await facade.destroy();
    expect(loop.state).toBe('destroyed');
  });

  it('the state and log surfaces reject after destroy', async () => {
    const { facade } = createFacade();
    await facade.prompt('before destroy');
    await facade.destroy();

    await expect(facade.getState()).rejects.toThrow('CortexAgent has been destroyed');
    expect(() => facade.getLog()).toThrow('CortexAgent has been destroyed');
    expect(() => facade.subscribeLog(() => {})).toThrow('CortexAgent has been destroyed');
    // restore() rejects rather than throwing synchronously: the docs
    // describe it as "rejected while running", and a consumer writing
    // `await agent.restore(x).catch(...)` next to the async getState()
    // caught nothing while the guard threw.
    await expect(facade.restore([])).rejects.toThrow('CortexAgent has been destroyed');
  });

  it('a directly destroyed loop never schedules a state emission timer', async () => {
    const { facade, loop } = createFacade({ stateChangeDebounceMs: 60_000 });
    facade.onStateChanged(() => {});

    // Direct AgentLoop.destroy(): the facade is not told, but its final
    // onLoopComplete checkpoint must not schedule a debounce timer that
    // holds its handle for the window and then snapshots a dead loop.
    await loop.destroy();
    expect(stateEmissionScheduled(facade)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Forwarded semantics on the lifecycle edge
//
// The structural test above sees only that a forwarded member EXISTS on the
// facade. It cannot see that a forwarded member's BEHAVIOUR diverges, which
// is how steer() and abort() shipped throwing after destroy where the loop
// no-ops: a consumer wiring abort to Ctrl+C fire-and-forget turned the throw
// into an unhandled rejection that killed its shutdown mid-flight.
// ---------------------------------------------------------------------------

type PostDestroyTarget = CortexAgent | AgentLoop;

/**
 * How to exercise one forwarded member on a torn-down target, or why it is
 * not exercised. Keyed by ForwardedLoopMember, so a newly forwarded member
 * is a type error until it carries a probe or an explicit reason.
 */
type PostDestroyProbe =
  | { readonly call: (target: PostDestroyTarget) => unknown }
  | { readonly skip: string };

/**
 * A minimal consumer tool, only ever registered on a destroyed target.
 * Annotated rather than asserted: the literal satisfies CortexTool on its
 * own, so the `as unknown as` this used to carry bought nothing and would
 * have hidden the shape drifting later.
 */
const probeTool: CortexTool = {
  name: 'post_destroy_probe',
  description: 'probe',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'probe',
};

const POST_DESTROY_PROBES: Record<ForwardedLoopMember, PostDestroyProbe> = {
  // Interaction surface.
  prompt: { call: (t) => t.prompt('post-destroy') },
  deliver: { call: (t) => t.deliver('post-destroy') },
  steer: { call: (t) => t.steer('post-destroy') },
  abort: { call: (t) => t.abort() },
  destroy: { call: (t) => t.destroy() },
  followUp: { call: (t) => t.followUp('post-destroy') },
  isPrompting: { call: (t) => t.isPrompting },
  // Queues.
  setSteeringQueueMode: { call: (t) => t.setSteeringQueueMode('all') },
  setFollowUpQueueMode: { call: (t) => t.setFollowUpQueueMode('all') },
  clearSteeringQueue: { call: (t) => t.clearSteeringQueue() },
  clearFollowUpQueue: { call: (t) => t.clearFollowUpQueue() },
  clearQueuedDeliveries: { call: (t) => t.clearQueuedDeliveries() },
  getQueuedDeliveries: { call: (t) => t.getQueuedDeliveries() },
  queuedDeliveryCount: { call: (t) => t.queuedDeliveryCount },
  pendingWakeDeliveryCount: { call: (t) => t.pendingWakeDeliveryCount },
  // Asks and headlines.
  getPendingAsks: { call: (t) => t.getPendingAsks() },
  markAskVoiced: { call: (t) => t.markAskVoiced('no-such-ask') },
  setHeadlineProvider: { call: (t) => t.setHeadlineProvider(null) },
  // Prompt and model surface.
  setBasePrompt: { call: (t) => t.setBasePrompt('Test base prompt') },
  getBasePrompt: { call: (t) => t.getBasePrompt() },
  getCurrentSystemPrompt: { call: (t) => t.getCurrentSystemPrompt() },
  composeSystemPrompt: { call: (t) => t.composeSystemPrompt('Test base prompt') },
  getSystemPromptSections: { call: (t) => t.getSystemPromptSections() },
  getModel: { call: (t) => t.getModel() },
  setModel: { call: (t) => t.setModel(testModel()) },
  getUtilityModel: { call: (t) => t.getUtilityModel() },
  setUtilityModel: { call: (t) => t.setUtilityModel(testModel()) },
  resetUtilityModel: { call: (t) => t.resetUtilityModel() },
  getAutoResolvedUtilityModel: { call: (t) => t.getAutoResolvedUtilityModel() },
  isUtilityModelOverridden: { call: (t) => t.isUtilityModelOverridden() },
  getThinkingLevel: { call: (t) => t.getThinkingLevel() },
  setThinkingLevel: { call: (t) => t.setThinkingLevel('off') },
  getModelThinkingCapabilities: { call: (t) => t.getModelThinkingCapabilities() },
  clampThinkingLevel: { call: (t) => t.clampThinkingLevel('off') },
  setCacheRetention: { call: (t) => t.setCacheRetention('none') },
  getCacheRetention: { call: (t) => t.getCacheRetention() },
  setSessionId: { call: (t) => t.setSessionId(null) },
  getSessionId: { call: (t) => t.getSessionId() },
  // Context window and token accounting.
  setContextWindow: { call: (t) => t.setContextWindow(200_000) },
  setContextWindowLimit: { call: (t) => t.setContextWindowLimit(null) },
  contextWindowLimit: { call: (t) => t.contextWindowLimit },
  effectiveContextWindow: { call: (t) => t.effectiveContextWindow },
  modelContextWindow: { call: (t) => t.modelContextWindow },
  currentContextTokenCount: { call: (t) => t.currentContextTokenCount },
  updateCurrentContextTokenCount: { call: (t) => t.updateCurrentContextTokenCount(0) },
  estimateCurrentContextTokens: { call: (t) => t.estimateCurrentContextTokens() },
  capToolResult: { call: (t) => t.capToolResult('probe') },
  // Direct completions and usage.
  directComplete: { skip: 'issues a real model completion' },
  structuredComplete: { skip: 'issues a real model completion' },
  utilityComplete: { skip: 'issues a real model completion' },
  getLastDirectUsage: { call: (t) => t.getLastDirectUsage() },
  getSessionUsage: { call: (t) => t.getSessionUsage() },
  // History, memory, digestion, compaction.
  getConversationHistory: { call: (t) => t.getConversationHistory() },
  getObservationalMemoryState: { call: (t) => t.getObservationalMemoryState() },
  digestIdle: { skip: 'runs the observer/reflector against a real model' },
  checkAndRunCompaction: { skip: 'can run real summarization completions' },
  triggerObservation: { skip: 'runs the observer against a real model' },
  getCompactionManager: { call: (t) => t.getCompactionManager() },
  // Tools, MCP, skills.
  addConsumerTool: { call: (t) => t.addConsumerTool(probeTool) },
  removeConsumerTool: { call: (t) => t.removeConsumerTool('post_destroy_probe') },
  refreshTools: { call: (t) => t.refreshTools() },
  connectMcpServer: { skip: 'opens a real transport (subprocess or socket)' },
  disconnectMcpServer: { call: (t) => t.disconnectMcpServer('no-such-server') },
  getMcpServerStates: { call: (t) => t.getMcpServerStates() },
  mcpConfigMatches: {
    // `transport`, not `type`. Written unasserted so the shape is checked
    // against McpStdioConfig rather than waved through by a cast.
    call: (t) => t.mcpConfigMatches('no-such-server', { transport: 'stdio', command: 'true' }),
  },
  setMcpToolCallProgressHandler: { call: (t) => t.setMcpToolCallProgressHandler(undefined) },
  getMcpClientManager: { call: (t) => t.getMcpClientManager() },
  getMcpTools: { call: (t) => t.getMcpTools() },
  getSkillRegistry: { call: (t) => t.getSkillRegistry() },
  loadSkill: { call: (t) => t.loadSkill('no-such-skill') },
  clearSkillBuffer: { call: (t) => t.clearSkillBuffer() },
  getSkillBuffer: { call: (t) => t.getSkillBuffer() },
  setPreprocessorVariables: { call: (t) => t.setPreprocessorVariables({}) },
  setScriptContext: { call: (t) => t.setScriptContext({}) },
  // Sub-agents.
  spawnBackgroundSubAgent: { skip: 'spawns a real child loop against a real model' },
  cancelSubAgent: { call: (t) => t.cancelSubAgent('no-such-task') },
  steerSubAgent: { call: (t) => t.steerSubAgent('no-such-task', 'probe') },
  getActiveSubAgents: { call: (t) => t.getActiveSubAgents() },
  getDeadLetteredBackgroundResults: { call: (t) => t.getDeadLetteredBackgroundResults() },
  // State reads and misc.
  isRunning: { call: (t) => t.isRunning },
  state: { call: (t) => t.state },
  isWorkingTagsEnabled: { call: (t) => t.isWorkingTagsEnabled },
  setWorkingTagsEnabled: { call: (t) => t.setWorkingTagsEnabled(true) },
  setLastInteractionTime: { call: (t) => t.setLastInteractionTime(Date.now()) },
  getEnvOverrides: { call: (t) => t.getEnvOverrides() },
  getEventBridge: { call: (t) => t.getEventBridge() },
  getBudgetGuard: { call: (t) => t.getBudgetGuard() },
  getContextManager: { call: (t) => t.getContextManager() },
  // Callback registration.
  onLoopComplete: { call: (t) => t.onLoopComplete(() => {}) },
  onError: { call: (t) => t.onError(() => {}) },
  onTurnComplete: { call: (t) => t.onTurnComplete(() => {}) },
  onRetryScheduled: { call: (t) => t.onRetryScheduled(() => {}) },
  onRetrySucceeded: { call: (t) => t.onRetrySucceeded(() => {}) },
  onRetryExhausted: { call: (t) => t.onRetryExhausted(() => {}) },
  onBeforeCompaction: { call: (t) => t.onBeforeCompaction(async () => {}) },
  onPostCompaction: { call: (t) => t.onPostCompaction(() => {}) },
  onCompactionError: { call: (t) => t.onCompactionError(() => {}) },
  onCompactionDegraded: { call: (t) => t.onCompactionDegraded(() => {}) },
  onCompactionExhausted: { call: (t) => t.onCompactionExhausted(() => {}) },
  onSubAgentSpawned: { call: (t) => t.onSubAgentSpawned(() => {}) },
  onSubAgentCompleted: { call: (t) => t.onSubAgentCompleted(() => {}) },
  onSubAgentFailed: { call: (t) => t.onSubAgentFailed(() => {}) },
  onBackgroundResultDelivery: { call: (t) => t.onBackgroundResultDelivery(() => {}) },
  onBackgroundResultDeadLettered: { call: (t) => t.onBackgroundResultDeadLettered(() => {}) },
  onObservation: { call: (t) => t.onObservation(() => {}) },
  onReflection: { call: (t) => t.onReflection(() => {}) },
};

/**
 * The outcome class a consumer can observe. 'threw' and 'rejected' are kept
 * apart deliberately: a synchronous throw where the consumer awaits (or
 * discards) a promise is a different bug from a rejection.
 */
type Outcome = 'ok' | 'threw' | 'rejected';

async function observe(invoke: () => unknown): Promise<Outcome> {
  let value: unknown;
  try {
    value = invoke();
  } catch {
    return 'threw';
  }
  if (value instanceof Promise) {
    try {
      await value;
    } catch {
      return 'rejected';
    }
  }
  return 'ok';
}

describe('CortexAgent forwarded lifecycle semantics', () => {
  it('carries a probe for every forwarded member', () => {
    // The Record<ForwardedLoopMember, ...> type above says the same thing,
    // but tests are outside the tsc project (tsconfig excludes them), so
    // the exhaustiveness has to be asserted at runtime to actually bite.
    const forwarded = Object.entries(AGENT_LOOP_DELEGATION)
      .filter(([, disposition]) => disposition === 'forwarded')
      .map(([member]) => member)
      .sort();
    expect(Object.keys(POST_DESTROY_PROBES).sort()).toEqual(forwarded);
  });

  it('every practically callable forwarded member behaves as the loop does after destroy', async () => {
    const { facade, loop } = createFacade();
    await facade.prompt('before destroy');
    await facade.destroy();

    const divergences: string[] = [];
    for (const [member, probe] of Object.entries(POST_DESTROY_PROBES)) {
      if ('skip' in probe) continue;
      // The facade first, then the loop it forwards to: same underlying
      // teardown state, so any difference is the facade's own guard.
      const viaFacade = await observe(() => probe.call(facade));
      const viaLoop = await observe(() => probe.call(loop));
      if (viaFacade !== viaLoop) {
        divergences.push(`${member}: facade ${viaFacade}, loop ${viaLoop}`);
      }
    }
    expect(divergences).toEqual([]);
  });

  it('names every forwarded member it cannot probe, and why', () => {
    // Not silence: the members below run real model completions, spawn real
    // child loops, or open real transports, so their post-destroy behaviour
    // is verified by review rather than by this loop.
    const skipped = Object.entries(POST_DESTROY_PROBES)
      .filter(([, probe]) => 'skip' in probe)
      .map(([member]) => member)
      .sort();
    expect(skipped).toEqual([
      'checkAndRunCompaction',
      'connectMcpServer',
      'digestIdle',
      'directComplete',
      'spawnBackgroundSubAgent',
      'structuredComplete',
      'triggerObservation',
      'utilityComplete',
    ]);
  });

  it('steer() after destroy is a silent no-op, like the loop', async () => {
    const { facade, piAgent } = createFacade();
    await facade.destroy();

    expect(() => facade.steer('late keystroke')).not.toThrow();
    expect(piAgent.steeringQueue).toEqual([]);
  });

  it('abort() after destroy resolves instead of rejecting', async () => {
    const { facade } = createFacade();
    await facade.destroy();

    await expect(facade.abort()).resolves.toBeUndefined();
    await expect(facade.abort('conversation')).resolves.toBeUndefined();
    await expect(facade.abort('work')).resolves.toBeUndefined();
  });

  it('a fire-and-forget abort during teardown never becomes an unhandled rejection', async () => {
    const { facade, piAgent } = createFacade();
    piAgent.hold = true;
    const turn = facade.prompt('long turn').catch(() => undefined);
    await waitUntil(() => piAgent.promptCalls.length === 1);

    // The consumer symptom: a TUI wires abort to Ctrl+C and Escape and
    // discards the promise, so a quit races its own teardown. destroy()
    // marks the facade destroyed synchronously, so this abort lands
    // mid-teardown, exactly where the throw used to escape uncaught.
    const teardown = facade.destroy();
    const rejections: unknown[] = [];
    process.once('unhandledRejection', (err) => rejections.push(err));
    void facade.abort();
    facade.steer('escape during teardown');

    await teardown;
    await turn;
    // Let any queued microtask rejection surface before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejections).toEqual([]);
  });
});
