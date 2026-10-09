/**
 * Long-lived loop mode: opt-in persistentRuntime (workspace tool state
 * survives across prompts) and lifetime budget scope (limits bound the
 * loop's whole life instead of one logical turn). Both exist for resident
 * loops that are woken repeatedly by deliveries, where a per-prompt reset
 * wipes exactly the state one continuous working session depends on.
 */
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import type { CortexToolRuntime } from '../../src/tools/runtime.js';
import { partsOf } from './agent-loop/parts.js';
import { textAssistant } from '../helpers/messages.js';

interface LongLivedMockPiAgent extends PiAgent {
  emitEvent: (event: PiEvent) => void;
  /** turn_end usage emitted per prompt (drives budget counters). */
  turnCost: number;
}

function createMockPiAgent(): LongLivedMockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;

  const agent: LongLivedMockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    turnCost: 0,

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
      agent.emitEvent({ type: 'agent_start' });
      const messages: AgentMessage[] = Array.isArray(input)
        ? input
        : [{ role: 'user', content: input, timestamp: Date.now() }];
      agent.state.messages.push(...messages);
      agent.emitEvent({
        type: 'turn_end',
        text: 'ok',
        message: {
          usage: {
            input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: agent.turnCost },
          },
        },
      });
      agent.state.messages.push(textAssistant('ok', Date.now()));
      agent.emitEvent({ type: 'agent_end', messages: [] });
      return { content: 'ok' };
    },

    async continue(): Promise<unknown> {
      throw new Error('not used in these tests');
    },

    abort(): void {},
    async waitForIdle(): Promise<void> {},
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

function runtimeOf(loop: AgentLoop): CortexToolRuntime {
  return partsOf(loop).tools.runtime;
}

describe('persistentRuntime', () => {
  it('keeps cwd, read registry, and undo history across prompts', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent, { persistentRuntime: true });
    const runtime = runtimeOf(loop);

    runtime.cwdTracker.updateCwd('/tmp/test-workspace/subdir');
    runtime.readRegistry.markRead('/tmp/test-workspace/file.ts');

    await loop.prompt('first');
    await loop.prompt('second');

    expect(runtime.cwdTracker.getCwd()).toBe('/tmp/test-workspace/subdir');
    expect(runtime.readRegistry.hasBeenRead('/tmp/test-workspace/file.ts')).toBe(true);
  });

  it('still resets the WebFetch per-loop counter each prompt', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent, { persistentRuntime: true });
    const runtime = runtimeOf(loop);

    runtime.webFetch.incrementFetchCount();
    runtime.webFetch.incrementFetchCount();
    expect(runtime.webFetch.fetchCount).toBe(2);

    await loop.prompt('first');

    expect(runtime.webFetch.fetchCount).toBe(0);
  });

  it('default mode wipes workspace state at each prompt (unchanged behavior)', async () => {
    const piAgent = createMockPiAgent();
    const loop = createLoop(piAgent);
    const runtime = runtimeOf(loop);

    runtime.readRegistry.markRead('/tmp/test-workspace/file.ts');
    await loop.prompt('first');

    expect(runtime.readRegistry.hasBeenRead('/tmp/test-workspace/file.ts')).toBe(false);
  });
});

describe('lifetime budget scope', () => {
  it('accumulates turns and cost across prompts instead of resetting', async () => {
    const piAgent = createMockPiAgent();
    piAgent.turnCost = 0.01;
    const loop = createLoop(piAgent, {
      budgetGuard: { maxTurns: 100, maxCost: 100, scope: 'lifetime' },
    });

    await loop.prompt('first');
    await loop.prompt('second');
    await loop.prompt('third');

    expect(loop.getBudgetGuard().getTurnCount()).toBe(3);
    expect(loop.getBudgetGuard().getTotalCost()).toBeCloseTo(0.03);
  });

  it('default prompt scope still resets per prompt (unchanged behavior)', async () => {
    const piAgent = createMockPiAgent();
    piAgent.turnCost = 0.01;
    const loop = createLoop(piAgent, {
      budgetGuard: { maxTurns: 100, maxCost: 100 },
    });

    await loop.prompt('first');
    await loop.prompt('second');

    expect(loop.getBudgetGuard().getTurnCount()).toBe(1);
    expect(loop.getBudgetGuard().getTotalCost()).toBeCloseTo(0.01);
  });
});
