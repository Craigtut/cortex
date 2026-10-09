/**
 * View injections (ephemeral context, loaded skills, background-task state,
 * a headline) reach every request, including the ones at or past the
 * activation threshold: those where nothing could be swapped, and those
 * where a swap rewrote the source and the view had to be re-derived.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../../src/types.js';
import type { AgentContext, AgentMessage } from '../../../src/context-manager.js';
import type { CompleteFn } from '../../../src/compaction/observational/types.js';
import { wrapModel } from '../../../src/model-wrapper.js';
import { assertNoOrphans, makeToolCallMsg, makeToolResultMsg } from '../compaction/helpers.js';

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

function createLoop(piAgent: PiAgent, compaction: Record<string, unknown> = {}): AgentLoop {
  const raw = { provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel;
  return new (AgentLoop as unknown as Ctor)(piAgent, {
    model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test prompt',
    slots: [],
    contextWindowLimit: 20_000,
    compaction: { observational: { maxAttempts: 1 }, ...compaction },
  } as AgentLoopConfig, [], { enableSubAgentTool: false, enableLoadSkillTool: false });
}

const user = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 1 });
const assistant = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: 2 });
const OBSERVED = '<observations>\n* (10:00) the older exchange\n</observations>';

async function runHook(loop: AgentLoop, piAgent: { state: { messages: AgentMessage[] } }): Promise<AgentContext> {
  return loop.getTransformContextHook()({
    systemPrompt: 'sys', model: null, messages: piAgent.state.messages, tools: [], thinkingLevel: 'medium',
  } as AgentContext);
}

/** About 18,000 tokens of a 20,000-token window: past the 90% activation threshold. */
function seed(piAgent: { state: { messages: AgentMessage[] } }): void {
  piAgent.state.messages.push(user('old ' + 'a'.repeat(36_000)), assistant('b'.repeat(36_000)), user('latest question'));
}

describe('view injections at the activation threshold', () => {
  it('precondition: below the threshold the ephemeral context is in the request', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    piAgent.state.messages.push(user('small'), assistant('small'), user('latest'));
    loop.getContextManager().setEphemeral('EPHEMERAL-MARKER');

    const out = await runHook(loop, piAgent);

    expect(JSON.stringify(out.messages)).toContain('EPHEMERAL-MARKER');
  });

  it('stays in the request when the memory model fails and nothing is swapped', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    const complete = vi.fn<CompleteFn>().mockRejectedValue(new Error('529 overloaded'));
    loop.getCompactionManager().memory.setCompleteFn(complete);
    seed(piAgent);
    loop.getContextManager().setEphemeral('EPHEMERAL-MARKER');
    const before = loop.getConversationHistory().length;

    const out = await runHook(loop, piAgent);

    // Preconditions: activation ran (it called the observer) and swapped nothing.
    expect(complete).toHaveBeenCalled();
    expect(loop.getConversationHistory()).toHaveLength(before);
    expect(JSON.stringify(out.messages)).toContain('EPHEMERAL-MARKER');
  });

  it('stays in the request under the non-blocking posture with nothing buffered', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent, { nonBlocking: true });
    loop.getCompactionManager().memory.setCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    seed(piAgent);
    loop.getContextManager().setEphemeral('EPHEMERAL-MARKER');
    const before = loop.getConversationHistory().length;

    const out = await runHook(loop, piAgent);

    expect(loop.getConversationHistory()).toHaveLength(before);
    expect(JSON.stringify(out.messages)).toContain('EPHEMERAL-MARKER');
  });

  it('stays in the request on a swap turn, with the swapped source and the new observations', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    loop.getCompactionManager().memory.setCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    seed(piAgent);
    loop.getContextManager().setEphemeral('EPHEMERAL-MARKER');
    const before = loop.getConversationHistory().length;
    const historyStart = loop.getContextManager().historyStart;

    const out = await runHook(loop, piAgent);

    // Precondition: the older exchange was swapped out of the source.
    expect(loop.getConversationHistory().length).toBeLessThan(before);
    const view = out.messages.slice(historyStart);
    expect(view.filter((message) => message.content === 'EPHEMERAL-MARKER')).toHaveLength(1);
    expect(view).toContainEqual(user('latest question'));
    expect(JSON.stringify(view)).not.toContain('old aaaa');
    // The request carries the observations the swap just recorded.
    expect(String(out.messages[historyStart - 1]!.content)).toContain('the older exchange');
  });

  it('keeps tool groups whole in a swap turn view with an injection', async () => {
    const piAgent = createPiAgent();
    const loop = createLoop(piAgent);
    loop.getCompactionManager().memory.setCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    piAgent.state.messages.push(user('do the task'));
    for (let i = 0; i < 6; i++) {
      piAgent.state.messages.push(makeToolCallMsg([{ id: `t${i}`, name: 'Read' }]));
      piAgent.state.messages.push(makeToolResultMsg(`t${i}`, 'Read', 'r'.repeat(12_000)));
    }
    loop.getContextManager().setEphemeral('EPHEMERAL-MARKER');
    const before = loop.getConversationHistory().length;
    const historyStart = loop.getContextManager().historyStart;

    const out = await runHook(loop, piAgent);

    expect(loop.getConversationHistory().length).toBeLessThan(before);
    const view = out.messages.slice(historyStart);
    expect(JSON.stringify(view)).toContain('EPHEMERAL-MARKER');
    assertNoOrphans(view);
  });
});
