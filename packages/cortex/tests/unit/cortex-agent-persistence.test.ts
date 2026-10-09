/**
 * CortexAgent composite persistence (docs/cortex/duplex/facade-api.md):
 * the versioned v2 artifact, per-loop restore ordering, the
 * restore-while-running guard, baseline-plus-delta usage restore, the v1
 * transparent upgrade path, and the debounced onStateChanged trigger with
 * atomic snapshotting.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig, SubAgentResult, TrackedSubAgent } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import type { ObservationalMemoryState } from '../../src/compaction/index.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import { CortexAgent } from '../../src/cortex-agent.js';
import { PassthroughSession } from '../../src/facade/passthrough-session.js';
import type {
  CortexAgentConfig,
  CortexAgentStateV2,
} from '../../src/cortex-agent.js';
import type { LoosePiEvent } from '../helpers/pi-events.js';

/**
 * The passthrough facade's session, for planting state no public surface
 * can produce. Checked by class, so a moved field fails here loudly.
 */
function passthroughSessionOf(facade: CortexAgent): PassthroughSession {
  const session = (facade as unknown as { session?: unknown }).session;
  if (!(session instanceof PassthroughSession)) {
    throw new Error('passthroughSessionOf: not a passthrough facade, or its internals moved');
  }
  return session;
}

// ---------------------------------------------------------------------------
// Mock PiAgent (same shape as the facade tests: holdable runs, usage on
// turn_end so session usage accumulates).
// ---------------------------------------------------------------------------

interface PersistenceMockPiAgent extends PiAgent {
  emitEvent: (event: LoosePiEvent) => void;
  promptCalls: Array<string | AgentMessage[]>;
  hold: boolean;
  releaseRun: () => void;
}

const TURN_COST = 0.003;

function createMockPiAgent(): PersistenceMockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let releaseRun: (() => void) | null = null;
  let idleResolve: (() => void) | null = null;
  let running = false;

  const agent: PersistenceMockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    promptCalls: [],
    hold: false,

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

        if (agent.hold) {
          agent.hold = false;
          await new Promise<void>((resolve) => {
            releaseRun = resolve;
          });
        }

        agent.emitEvent({
          type: 'turn_end',
          text: 'ok',
          usage: {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 120,
            cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: TURN_COST },
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

    steer(): void {},
  };

  return agent;
}

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
) => AgentLoop;

type TestCortexAgentConstructor = new (
  reasoner: AgentLoop,
  config: CortexAgentConfig,
) => CortexAgent;

function testModel(): CortexModel {
  return wrapModel(
    { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel,
    'anthropic',
    'claude-sonnet-4-20250514',
  );
}

function createFacade(overrides?: Partial<CortexAgentConfig>): {
  facade: CortexAgent;
  loop: AgentLoop;
  piAgent: PersistenceMockPiAgent;
} {
  const piAgent = createMockPiAgent();
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  const loop = new AgentLoopCtor(piAgent, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    // Classic strategy: no observation slot, so post-slot history counts
    // stay simple; observational restore is exercised via the spy test.
    ...(overrides as Partial<AgentLoopConfig>),
  });
  const CortexAgentCtor = CortexAgent as unknown as TestCortexAgentConstructor;
  const facade = new CortexAgentCtor(loop, {
    model: testModel(),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    // Explicit since duplex became the default (D14). The v2 artifact's
    // talker side is exercised here as restored-but-unhydrated content, so
    // these cases are passthrough by intent.
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

function fakeMemory(): ObservationalMemoryState {
  return {
    observations: 'observed things',
    continuationHint: null,
    observationTokenCount: 12,
    generationCount: 1,
    bufferedChunks: [],
    bufferWatermark: 0,
  };
}

function trackFakeSubAgent(loop: AgentLoop, taskId: string): void {
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
    instructions: 'fake',
    background: true,
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
}

// ---------------------------------------------------------------------------
// getState
// ---------------------------------------------------------------------------

describe('CortexAgent.getState', () => {
  it('captures the v2 composite: log, histories, memory, usage breakdown', async () => {
    const { facade, loop } = createFacade();
    await facade.prompt('hello');

    const state = await facade.getState();
    expect(state.version).toBe(2);
    expect(state.log).toEqual(facade.getLog());
    expect(state.log.map((e) => e.type)).toEqual(['utterance', 'reply']);
    expect(state.reasonerHistory).toEqual(loop.getConversationHistory());
    expect(state.talkerHistory).toEqual([]);
    expect(state.talkerMemory).toBeNull();
    expect(state.usage.perLoop.talker).toBeNull();
    expect(state.usage.perLoop.reasoner.totalCost).toBeCloseTo(TURN_COST, 10);
    expect(state.usage.total).toEqual(state.usage.perLoop.reasoner);
  });

  it('waits for a running turn to finish before snapshotting (atomicity)', async () => {
    const { facade, piAgent } = createFacade();

    piAgent.hold = true;
    const turn = facade.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    let state: CortexAgentStateV2 | null = null;
    const capture = facade.getState().then((s) => {
      state = s;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state).toBeNull();

    piAgent.releaseRun();
    await turn;
    await capture;
    // The snapshot saw the completed turn: user + assistant in history,
    // utterance + reply in the log.
    expect(state!.reasonerHistory.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(state!.log.map((e) => e.type)).toEqual(['utterance', 'reply']);
  });
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

describe('CortexAgent.restore', () => {
  it('round-trips a v2 artifact into a fresh facade', async () => {
    const first = createFacade();
    await first.facade.prompt('one');
    await first.facade.prompt('two');
    const artifact = await first.facade.getState();

    const second = createFacade();
    await second.facade.restore(artifact);

    expect(second.facade.getLog()).toEqual(artifact.log);
    expect(second.facade.getConversationHistory().map((m) => m.content)).toEqual(
      artifact.reasonerHistory.map((m) => m.content),
    );
    expect(second.facade.getSessionUsage().totalCost).toBeCloseTo(2 * TURN_COST, 10);
    expect(second.facade.getSessionUsage().totalTurns).toBe(2);

    const roundTripped = await second.facade.getState();
    expect(roundTripped.log).toEqual(artifact.log);
    expect(roundTripped.usage.total.totalCost).toBeCloseTo(artifact.usage.total.totalCost, 10);
  });

  it('usage is baseline plus live deltas, not an additive merge', async () => {
    const first = createFacade();
    await first.facade.prompt('one');
    const artifact = await first.facade.getState();

    const second = createFacade();
    await second.facade.restore(artifact);
    // Repeated restore stays idempotent (no double counting).
    await second.facade.restore(artifact);
    expect(second.facade.getSessionUsage().totalCost).toBeCloseTo(TURN_COST, 10);

    await second.facade.prompt('new turn');
    const usage = second.facade.getSessionUsage();
    expect(usage.totalCost).toBeCloseTo(2 * TURN_COST, 10);
    expect(usage.totalTurns).toBe(2);

    // And the next artifact carries the combined baseline forward.
    const nextArtifact = await second.facade.getState();
    expect(nextArtifact.usage.total.totalCost).toBeCloseTo(2 * TURN_COST, 10);
  });

  it('log seq numbering continues after the restored maximum', async () => {
    const first = createFacade();
    await first.facade.prompt('one');
    const artifact = await first.facade.getState();
    const maxSeq = artifact.log.at(-1)!.seq;

    const second = createFacade();
    await second.facade.restore(artifact);
    await second.facade.prompt('after restore');

    const appended = second.facade.getLog(maxSeq + 1);
    expect(appended.length).toBeGreaterThan(0);
    expect(appended[0]!.seq).toBe(maxSeq + 1);
  });

  it('restores history before observational state, watermark-aligned', async () => {
    const { facade, loop } = createFacade();
    const order: string[] = [];
    vi.spyOn(loop, 'restoreConversationHistory').mockImplementation(() => {
      order.push('history');
    });
    vi.spyOn(loop, 'restoreObservationalMemoryState').mockImplementation(() => {
      order.push('memory');
    });

    await facade.restore({
      version: 2,
      log: [],
      talkerHistory: [],
      reasonerHistory: [{ role: 'user', content: 'hi', timestamp: 1 } as AgentMessage],
      talkerMemory: null,
      reasonerMemory: fakeMemory(),
      usage: {
        total: { totalCost: 0, totalTurns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        perLoop: {
          talker: null,
          reasoner: { totalCost: 0, totalTurns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        },
      },
    });

    expect(order).toEqual(['history', 'memory']);
  });

  it('is rejected while a run is in flight', async () => {
    const { facade, piAgent } = createFacade();
    piAgent.hold = true;
    const turn = facade.prompt('busy');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    await expect(facade.restore([])).rejects.toThrow(/rejected: a loop is running/);

    piAgent.releaseRun();
    await turn;
  });

  it('is rejected while a sub-agent is active', async () => {
    const { facade, loop } = createFacade();
    trackFakeSubAgent(loop, 'task-live');
    await expect(facade.restore([])).rejects.toThrow(/rejected: a loop is running/);
  });

  it('upgrades a v1 artifact: history into the reasoner, empty log, usage as baseline', async () => {
    const { facade } = createFacade();
    await facade.restore({
      version: 1,
      history: [
        { role: 'user', content: 'old question', timestamp: 1 } as AgentMessage,
        { role: 'assistant', content: 'old answer', timestamp: 2 } as AgentMessage,
      ],
      usage: {
        totalCost: 1.5,
        totalTurns: 40,
        tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
      },
    });

    expect(facade.getLog()).toEqual([]);
    expect(facade.getConversationHistory().map((m) => m.content)).toEqual([
      'old question',
      'old answer',
    ]);
    const usage = facade.getSessionUsage();
    expect(usage.totalCost).toBeCloseTo(1.5, 10);
    expect(usage.totalTurns).toBe(40);
  });

  it('accepts a bare message array as v1 history', async () => {
    const { facade } = createFacade();
    await facade.restore([
      { role: 'user', content: 'bare history', timestamp: 1 } as AgentMessage,
    ]);
    expect(facade.getConversationHistory().map((m) => m.content)).toEqual(['bare history']);
    expect(facade.getLog()).toEqual([]);
    expect(facade.getSessionUsage().totalCost).toBe(0);
  });

  it('drops pre-restore queued silent deliveries instead of flushing them post-restore', async () => {
    const first = createFacade();
    await first.facade.prompt('one');
    const artifact = await first.facade.getState();

    const { facade, piAgent } = createFacade();
    facade.deliver('stale silent note', { wake: false });
    expect(facade.queuedDeliveryCount).toBe(1);

    await facade.restore(artifact);
    expect(facade.queuedDeliveryCount).toBe(0);

    // The restored session's first prompt carries no pre-restore content.
    await facade.prompt('fresh start');
    expect(piAgent.promptCalls.at(-1)).toBe('fresh start');
  });

  it('rejects an unsupported version', async () => {
    const { facade } = createFacade();
    await expect(
      facade.restore({ version: 3 } as unknown as CortexAgentStateV2),
    ).rejects.toThrow(/Unsupported CortexAgent state version: 3/);
  });

  it('never shares live talker references with the caller (copy on both sides)', async () => {
    const { facade } = createFacade();
    const zero = { totalCost: 0, totalTurns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const artifact: CortexAgentStateV2 = {
      version: 2,
      log: [],
      talkerHistory: [{ role: 'user', content: 'voice input', timestamp: 1 } as AgentMessage],
      reasonerHistory: [],
      talkerMemory: fakeMemory(),
      reasonerMemory: null,
      usage: { total: zero, perLoop: { talker: null, reasoner: zero } },
    };
    await facade.restore(artifact);

    // A persistence layer normalizing its own artifact in place must not
    // mutate live facade state.
    artifact.talkerHistory[0]!.content = 'mutated after restore';
    artifact.talkerMemory!.observations = 'mutated after restore';
    const state = await facade.getState();
    expect(state.talkerHistory[0]!.content).toBe('voice input');
    expect(state.talkerMemory!.observations).toBe('observed things');

    // And the returned snapshot is a copy, like getLog(): mutating it must
    // not reach the next snapshot.
    state.talkerHistory[0]!.content = 'normalized in place';
    state.talkerMemory!.observations = 'normalized in place';
    const second = await facade.getState();
    expect(second.talkerHistory[0]!.content).toBe('voice input');
    expect(second.talkerMemory!.observations).toBe('observed things');
  });

  it('rejects a non-cloneable artifact before touching any facade state', async () => {
    const { facade } = createFacade();
    await facade.prompt('existing turn');
    const historyBefore = facade.getConversationHistory();
    const logBefore = facade.getLog();
    const usageBefore = facade.getSessionUsage();

    const zero = { totalCost: 0, totalTurns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const artifact: CortexAgentStateV2 = {
      version: 2,
      log: [],
      // A consumer keeping session state in a reactive store (Vue
      // reactive(), a Solid store) hands restore() a Proxy, and
      // structuredClone throws DataCloneError on it.
      talkerHistory: new Proxy(
        [{ role: 'user', content: 'proxied', timestamp: 1 } as AgentMessage],
        {},
      ),
      reasonerHistory: [{ role: 'user', content: 'replaced', timestamp: 1 } as AgentMessage],
      talkerMemory: null,
      reasonerMemory: null,
      usage: { total: zero, perLoop: { talker: null, reasoner: zero } },
    };

    await expect(facade.restore(artifact)).rejects.toThrow();

    // The restore was rejected whole: no half-applied reasoner history
    // (applied first pre-fix), log, or usage baseline.
    expect(facade.getConversationHistory()).toEqual(historyBefore);
    expect(facade.getLog()).toEqual(logBefore);
    expect(facade.getSessionUsage()).toEqual(usageBefore);
  });

  it('carries a restored talker side through a passthrough round trip', async () => {
    const { facade } = createFacade();
    const talkerHistory = [
      { role: 'user', content: 'voice input', timestamp: 1 } as AgentMessage,
    ];
    const talkerUsage = {
      totalCost: 0.5,
      totalTurns: 10,
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    };
    await facade.restore({
      version: 2,
      log: [],
      talkerHistory,
      reasonerHistory: [],
      talkerMemory: fakeMemory(),
      reasonerMemory: null,
      usage: {
        total: talkerUsage,
        perLoop: {
          talker: talkerUsage,
          reasoner: { totalCost: 0, totalTurns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        },
      },
    });

    const state = await facade.getState();
    expect(state.talkerHistory).toEqual(talkerHistory);
    expect(state.talkerMemory).toEqual(fakeMemory());
    expect(state.usage.perLoop.talker).toEqual(talkerUsage);
    // Talker spend stays in the aggregate.
    expect(facade.getSessionUsage().totalCost).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// onStateChanged
// ---------------------------------------------------------------------------

describe('CortexAgent.onStateChanged', () => {
  it('fires debounced with a consistent snapshot after activity settles', async () => {
    const { facade } = createFacade({ stateChangeDebounceMs: 5 });
    const snapshots: CortexAgentStateV2[] = [];
    facade.onStateChanged((state) => {
      snapshots.push(state);
    });

    await facade.prompt('hello');
    await waitUntil(() => snapshots.length > 0);

    const state = snapshots.at(-1)!;
    expect(state.log.map((e) => e.type)).toEqual(['utterance', 'reply']);
    expect(state.reasonerHistory.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('never snapshots mid-run: the first emission lands after the turn ends', async () => {
    const { facade, piAgent } = createFacade({ stateChangeDebounceMs: 1 });
    const snapshots: CortexAgentStateV2[] = [];
    facade.onStateChanged((state) => {
      snapshots.push(state);
    });

    piAgent.hold = true;
    const turn = facade.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    // Debounce elapsed while the run holds the gate; no emission yet.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(snapshots).toEqual([]);

    piAgent.releaseRun();
    await turn;
    await waitUntil(() => snapshots.length > 0);
    expect(snapshots[0]!.reasonerHistory.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('coalesces bursts into few emissions and re-fires for late changes', async () => {
    const { facade } = createFacade({ stateChangeDebounceMs: 30 });
    const snapshots: CortexAgentStateV2[] = [];
    facade.onStateChanged((state) => {
      snapshots.push(state);
    });

    await facade.prompt('one');
    await facade.prompt('two');
    await waitUntil(
      () => (snapshots.at(-1)?.log.filter((e) => e.type === 'utterance').length ?? 0) === 2,
    );
    // Both prompts landed within one debounce window (two on a machine
    // slow enough to split the window; never one per dirty mark).
    expect(snapshots.length).toBeLessThanOrEqual(2);

    const countBefore = snapshots.length;
    await facade.prompt('three');
    await waitUntil(() => snapshots.length > countBefore);
    expect(snapshots.at(-1)!.log.filter((e) => e.type === 'utterance')).toHaveLength(3);
  });

  it('a handler registered after activity still gets a snapshot', async () => {
    const { facade } = createFacade({ stateChangeDebounceMs: 5 });
    await facade.prompt('early activity');

    const snapshots: CortexAgentStateV2[] = [];
    facade.onStateChanged((state) => {
      snapshots.push(state);
    });
    await waitUntil(() => snapshots.length > 0);
    expect(snapshots[0]!.log.map((e) => e.type)).toEqual(['utterance', 'reply']);
  });

  it('routes a snapshot failure to the logger, never an unhandled rejection', async () => {
    const errors: string[] = [];
    const { facade } = createFacade({
      stateChangeDebounceMs: 5,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message) => {
          errors.push(message);
        },
      },
    });
    // Simulates 2b, where the talker side holds a live loop's history: one
    // non-cloneable value makes getState() reject inside the debounce
    // timer, where nothing awaits it.
    passthroughSessionOf(facade).hydrate({
      talkerHistory: [{ role: 'user', content: 'x', callback: () => {} } as unknown as AgentMessage],
      talkerMemory: null,
    });

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      facade.onStateChanged(() => {});
      await facade.prompt('trigger a snapshot');
      await waitUntil(() => errors.length > 0 || rejections.length > 0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    expect(rejections).toEqual([]);
    expect(errors.some((m) => m.includes('onStateChanged snapshot failed'))).toBe(true);
  });

  it('stops firing after destroy', async () => {
    const { facade } = createFacade({ stateChangeDebounceMs: 5 });
    const snapshots: CortexAgentStateV2[] = [];
    facade.onStateChanged((state) => {
      snapshots.push(state);
    });
    await facade.prompt('before destroy');
    await facade.destroy();
    const count = snapshots.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(snapshots.length).toBe(count);
  });
});
