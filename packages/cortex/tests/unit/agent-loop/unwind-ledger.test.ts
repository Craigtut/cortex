/**
 * Unwinding a failed delivery removes messages from inside the history, not
 * only its tail: the prompt input after a spliced wake batch stays, as do
 * system messages among an unwound run's turns. Memory's ledger moves with
 * the messages, so what it counts as observed is what an observer saw, and
 * an observer over unwound content records nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../../src/types.js';
import type { AgentMessage } from '../../../src/context-manager.js';
import type { CompleteFn } from '../../../src/compaction/observational/types.js';
import { wrapModel } from '../../../src/model-wrapper.js';
import { partsOf } from './parts.js';
import { textAssistant } from '../../helpers/messages.js';

type Ctor = new (agent: PiAgent, config: AgentLoopConfig, tools?: unknown[], options?: Record<string, unknown>) => AgentLoop;

function createPiAgent(): PiAgent & { state: { messages: AgentMessage[] } } {
  const agent = {
    state: { messages: [] as AgentMessage[], systemPrompt: '', tools: [] },
    subscribe() { return () => {}; },
    async prompt() { return { content: 'ok' }; },
    async continue() { throw new Error('not used'); },
    abort() {},
    async waitForIdle() {},
    reset() { agent.state.messages = []; },
    steer() {},
    clearSteeringQueue() {},
    hasQueuedMessages() { return false; },
  };
  return agent as unknown as PiAgent & { state: { messages: AgentMessage[] } };
}

function createLoop(piAgent: PiAgent): AgentLoop {
  const raw = { provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel;
  return new (AgentLoop as unknown as Ctor)(piAgent, {
    model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test prompt',
    slots: [],
    contextWindowLimit: 20_000,
    compaction: { observational: { maxAttempts: 1, bufferMinTokens: 100 } },
  } as AgentLoopConfig, [], { enableSubAgentTool: false, enableLoadSkillTool: false });
}

const user = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 1 });
const assistant = (content: string): AgentMessage => textAssistant(content, 2);
const toolCallTurn = (): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'Bash', arguments: {} }], stopReason: 'toolUse', timestamp: 3 }) as unknown as AgentMessage;
const errorStub = (): AgentMessage =>
  ({ role: 'assistant', content: [], stopReason: 'error', errorMessage: '503 unavailable', timestamp: 4 }) as unknown as AgentMessage;

/** Chunks covering [0, end) of the history, in the shape a session restores. */
function observedTo(loop: AgentLoop, ...ends: number[]): void {
  loop.restoreObservationalMemoryState({
    observations: '', continuationHint: null, observationTokenCount: 0, generationCount: 0,
    bufferedChunks: ends.map((endIndex) => ({ observations: `* to ${endIndex}`, messageTokensObserved: 10, createdAt: new Date(), endIndex })),
    bufferWatermark: ends[ends.length - 1]!,
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('an unwound delivery moves the memory ledger with the messages', () => {
  it('stops counting the prompt input as observed when a spliced wake message before it leaves', () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    const parts = partsOf(loop);
    const historyStart = loop.getContextManager().historyStart;
    piAgent.state.messages.push(user('m0'), assistant('m1'), user('wake content'), user('prompt input'), errorStub());
    // An observer saw m0, m1 and the wake message; the prompt input is unobserved.
    observedTo(loop, 3);
    parts.runner.boundary = historyStart + 2;

    parts.queues.settleSplicedBatch([{ id: 'w1', content: 'wake content', timestamp: 1 }], 0, null, true);

    // Precondition: the wake message left from inside the history.
    expect(loop.getConversationHistory().map((m) => m.content)).toEqual(['m0', 'm1', 'prompt input', []]);
    const state = loop.getObservationalMemoryState();
    expect(state.bufferWatermark).toBe(2);
    expect(state.bufferedChunks!.map((c) => c.endIndex)).toEqual([2]);
  });

  it('does not count a system message after the unwound delivery as observed', () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    const parts = partsOf(loop);
    const historyStart = loop.getContextManager().historyStart;
    const patch = { role: 'system', content: '', sections: { A: 'b' }, timestamp: 3 } as unknown as AgentMessage;
    piAgent.state.messages.push(user('m0'), assistant('m1'), user('delivery body'), patch, toolCallTurn());
    // Observed through the delivery message, not the patch after it.
    observedTo(loop, 2, 3);
    parts.runner.boundary = historyStart + 2;

    expect(parts.queues.unwindFailedDelivery('delivery body', 0)).toBe(true);

    // Precondition: the patch stays, now right after m1.
    expect(loop.getConversationHistory().map((m) => m.role)).toEqual(['user', 'assistant', 'system']);
    const state = loop.getObservationalMemoryState();
    expect(state.bufferWatermark).toBe(2);
    expect(state.bufferedChunks!.map((c) => c.endIndex)).toEqual([2, 2]);
  });

  it('records nothing from an observer that was reading the unwound delivery', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    const parts = partsOf(loop);
    const historyStart = loop.getContextManager().historyStart;
    const releases: Array<() => void> = [];
    const complete = vi.fn<CompleteFn>(() =>
      new Promise<string>((resolve) => releases.push(() => resolve('<observations>\n* (10:00) user delivered the payload\n</observations>'))));
    loop.getCompactionManager().memory.setCompleteFn(complete);
    piAgent.state.messages.push(user('m0'), assistant('m1'));
    observedTo(loop, 2);
    piAgent.state.messages.push(user('delivery body ' + 'x'.repeat(4_000)), toolCallTurn());
    // A turn ended past the threshold: an observer starts over the delivery.
    loop.getCompactionManager().memory.onTurnEnd(19_000, 20_000, piAgent.state.messages, historyStart);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(loop.getCompactionManager().memory.isObserverInFlight()).toBe(true);
    parts.runner.boundary = historyStart + 2;

    expect(parts.queues.unwindFailedDelivery('delivery body ' + 'x'.repeat(4_000), 0)).toBe(true);
    expect(loop.getConversationHistory()).toHaveLength(2);
    releases[0]!();
    await flush();

    // The delivery is re-queued and will be observed when it lands again.
    const state = loop.getObservationalMemoryState();
    expect(state.bufferedChunks!.map((c) => c.observations)).toEqual(['* to 2']);
    expect(state.bufferWatermark).toBe(2);
    expect(loop.getCompactionManager().memory.isObserverInFlight()).toBe(false);
  });
});
