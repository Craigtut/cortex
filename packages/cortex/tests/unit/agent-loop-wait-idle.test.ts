/**
 * waitForLoopIdle(): the awaitable form of isLoopActive, keyed on loop-gate
 * depth. This is the primitive the facade's settlement predicates
 * (conversationIdle, workSettled) are built on, per
 * docs/cortex/duplex/facade-api.md: gate depth, not isPrompting, because
 * the prompting flag reads idle while gate tasks (queued drains, delivery
 * sweeps) are still pending.
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';

interface HoldableMockPiAgent extends PiAgent {
  emitEvent: (event: PiEvent) => void;
  promptCalls: Array<string | AgentMessage[]>;
  /** When true, the next run pauses until releaseRun() is called. */
  hold: boolean;
  releaseRun: () => void;
}

function createMockPiAgent(): HoldableMockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let releaseRun: (() => void) | null = null;
  let idleResolve: (() => void) | null = null;
  let running = false;

  const agent: HoldableMockPiAgent = {
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

    emitEvent(event: PiEvent): void {
      eventHandler?.(event);
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

    steer(): void {},
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

/** Poll until `predicate` holds; fails the test after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('AgentLoop.waitForLoopIdle', () => {
  it('resolves immediately on an idle loop', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    expect(loop.isLoopActive).toBe(false);
    await loop.waitForLoopIdle();
    expect(loop.isLoopActive).toBe(false);
  });

  it('stays pending while a run holds the gate and resolves after it releases', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.hold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);
    expect(loop.isLoopActive).toBe(true);

    let settled = false;
    const wait = loop.waitForLoopIdle().then(() => {
      settled = true;
    });

    // The run is still holding; the wait must not have resolved.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    piAgent.releaseRun();
    await turn;
    await wait;
    expect(settled).toBe(true);
    expect(loop.isLoopActive).toBe(false);
  });

  it('covers gate tasks that never run pi: a parked delivery sweep extends the wait', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.hold = true;
    const turn = loop.prompt('long task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    // Parks and enqueues a sweep task behind the running turn. isPrompting
    // will read false between the turn ending and the sweep running, but
    // gate depth stays above zero until the sweep's run finishes too.
    const result = loop.deliver('mid-run redirect');
    expect(result.outcome).toBe('parked');

    let settled = false;
    const wait = loop.waitForLoopIdle().then(() => {
      settled = true;
    });

    piAgent.releaseRun();
    await turn;
    await wait;
    expect(settled).toBe(true);
    // The sweep's own delivery run completed before the wait resolved.
    expect(piAgent.promptCalls.length).toBe(2);
    expect(piAgent.promptCalls[1]).toBe('mid-run redirect');
    expect(loop.isLoopActive).toBe(false);
    expect(loop.pendingWakeDeliveryCount).toBe(0);
  });

  it('supports multiple concurrent waiters', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);

    piAgent.hold = true;
    const turn = loop.prompt('task');
    await waitUntil(() => piAgent.promptCalls.length === 1);

    const waits = [loop.waitForLoopIdle(), loop.waitForLoopIdle(), loop.waitForLoopIdle()];
    piAgent.releaseRun();
    await turn;
    await Promise.all(waits);
    expect(loop.isLoopActive).toBe(false);
  });
});
