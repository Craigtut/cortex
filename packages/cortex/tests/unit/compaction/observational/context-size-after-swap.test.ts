/**
 * After observational memory rewrites the source history, the last measured
 * input size describes a context that no longer exists. Reusing it made the
 * next pass believe the context was still full: it re-activated, ran a
 * second observer call, and removed the freshest messages.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../../src/agent-loop.js';
import { wrapModel } from '../../../../src/model-wrapper.js';
import type { AgentLoopConfig } from '../../../../src/types.js';
import type { CompleteFn } from '../../../../src/compaction/observational/types.js';
import type { AgentContext, AgentMessage } from '../../../../src/context-manager.js';
import { textAssistant } from '../../../helpers/messages.js';

type Ctor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

const OBSERVER_OUTPUT =
  '<observations>\n* (14:30) observed\n</observations>\n\n' +
  '<current-task>\nDoing the thing right now.\n</current-task>\n\n' +
  '<suggested-response>\nContinue the thing.\n</suggested-response>';

function createLoop(): { loop: AgentLoop; piAgent: PiAgent } {
  const piAgent = {
    state: { messages: [] as AgentMessage[], systemPrompt: '', tools: [] },
    subscribe() { return () => {}; },
    async prompt() { return {}; },
    async continue() { return {}; },
    abort() {},
    async waitForIdle() {},
    reset() {},
    steer() {},
    clearSteeringQueue() {},
    hasQueuedMessages() { return false; },
  } as unknown as PiAgent;
  const raw = { provider: 'anthropic', name: 'model', contextWindow: 200_000 } as PiModel;
  const loop = new (AgentLoop as unknown as Ctor)(
    piAgent,
    {
      model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'Test prompt',
      slots: [],
      contextWindowLimit: 20_000,
    },
    [],
    { enableSubAgentTool: false, enableLoadSkillTool: false },
  );
  return { loop, piAgent };
}

function history(loop: AgentLoop, piAgent: PiAgent): unknown[] {
  return piAgent.state.messages.slice(loop.getContextManager().historyStart).map((m) => (m as AgentMessage).content);
}

describe('context size after a swap', () => {
  it('an idle-digestion swap does not leave the next pass re-activating on the old size', async () => {
    const { loop, piAgent } = createLoop();
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
    loop.getCompactionManager().memory.setCompleteFn(complete);
    piAgent.state.messages.push(
      { role: 'user', content: 'work '.repeat(3000), timestamp: 1 },
      textAssistant('done '.repeat(3000), 2),
      { role: 'user', content: 'more '.repeat(3000), timestamp: 3 },
      textAssistant('again '.repeat(3000), 4),
    );
    // Buffer a chunk below the threshold, then add a fresh exchange.
    await loop.digestIdle();
    piAgent.state.messages.push(
      { role: 'user', content: 'latest question', timestamp: 3 },
      textAssistant('latest answer', 4),
    );
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);
    const swap = await loop.digestIdle();
    // Precondition: the swap happened, with one observer call so far.
    expect(swap.historyCompacted).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
    const afterSwap = history(loop, piAgent);

    // The next request's transformContext, as pi would run it.
    await loop.getTransformContextHook()({
      systemPrompt: '', model: null, messages: piAgent.state.messages as AgentMessage[], tools: [], thinkingLevel: 'medium',
    } as AgentContext);

    expect(complete).toHaveBeenCalledTimes(1);
    // The swap's result stands: the verbatim tail and the latest exchange.
    expect(history(loop, piAgent)).toEqual(afterSwap);
    expect(afterSwap.slice(-2)).toEqual(['latest question', 'latest answer']);
    expect(loop.estimateCurrentContextTokens()).toBeLessThan(18_000);
  });

  it('an in-band swap clears the measured size even if no turn reports a new one', async () => {
    const { loop, piAgent } = createLoop();
    loop.getCompactionManager().memory.setCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT));
    piAgent.state.messages.push(
      { role: 'user', content: 'work '.repeat(3000), timestamp: 1 },
      // About 3,700 tokens: inside the 4,000-token tail with the question.
      textAssistant('done '.repeat(2600), 2),
      { role: 'user', content: 'latest question', timestamp: 3 },
    );
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    await loop.getTransformContextHook()({
      systemPrompt: '', model: null, messages: piAgent.state.messages as AgentMessage[], tools: [], thinkingLevel: 'medium',
    } as AgentContext);

    // Precondition: the swap removed the older message; the verbatim tail stayed.
    expect(history(loop, piAgent)).toHaveLength(2);
    expect(history(loop, piAgent).at(-1)).toBe('latest question');
    expect(loop.currentContextTokenCount).toBe(0);
  });
});
