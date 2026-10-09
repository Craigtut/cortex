/**
 * A failed delivery run is unwound from where the delivery message actually
 * is. When observational memory removes older history mid-run, every later
 * message shifts down; locating the delivery by the transcript length
 * captured before the run then pointed at the run's own work, removed part
 * of it (orphaning a tool call), and re-queued a delivery that was still in
 * history.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../src/agent-loop.js';
import { wrapModel } from '../../../src/model-wrapper.js';
import type { AgentLoopConfig } from '../../../src/types.js';
import type { CompleteFn } from '../../../src/compaction/compaction.js';
import type { AgentContext, AgentMessage } from '../../../src/context-manager.js';
import { makeToolCallMsg, makeToolResultMsg, assertNoOrphans } from '../compaction/helpers.js';
import { partsOf } from './parts.js';

type Ctor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

describe('failed delivery after a mid-run swap', () => {
  it('unwinds the delivery from its live position, leaving no duplicate and no orphaned tool call', async () => {
    let attempts = 0;
    const piAgent = {
      state: { messages: [] as AgentMessage[], systemPrompt: '', tools: [] },
      subscribe() { return () => {}; },
      async prompt(input: string) {
        attempts++;
        const state = piAgent.state as { messages: AgentMessage[]; errorMessage?: string };
        // pi clears the previous run's error when a run starts.
        delete state.errorMessage;
        // pi pushes the delivery message at run start, then transforms the
        // context before its first model call.
        state.messages.push({ role: 'user', content: input, timestamp: 100 });
        await loop.getTransformContextHook()({
          systemPrompt: '', model: null, messages: state.messages, tools: [], thinkingLevel: 'medium',
        } as AgentContext);
        if (attempts > 1) {
          state.messages.push({ role: 'assistant', content: 'handled', timestamp: 200 });
          return {};
        }
        // The run makes progress, then fails mid tool call.
        for (const id of ['a', 'b', 'd', 'e']) {
          state.messages.push(makeToolCallMsg([{ id, name: 'Read' }]), makeToolResultMsg(id, 'Read', `result ${id}`));
        }
        state.messages.push(makeToolCallMsg([{ id: 'c', name: 'Read' }]));
        state.messages.push({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' } as never);
        state.errorMessage = 'boom';
        return {};
      },
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
        retryPolicy: { enabled: false },
        // Activation consumes buffered chunks only: no observer call in-band.
        compaction: { nonBlocking: true },
      },
      [],
      { enableSubAgentTool: false, enableLoadSkillTool: false },
    );
    loop.getCompactionManager().setObservationalCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(
      '<observations>\n* observed\n</observations>',
    ));

    // Ten earlier messages, the first six already observed in a chunk.
    loop.restoreConversationHistory(Array.from({ length: 10 }, (_, i): AgentMessage => (
      { role: i % 2 ? 'assistant' : 'user', content: `old ${i} ` + 'x'.repeat(2_000), timestamp: i + 1 }
    )));
    loop.restoreObservationalMemoryState({
      observations: '',
      continuationHint: null,
      observationTokenCount: 0,
      generationCount: 0,
      bufferedChunks: [{ observations: '* the first six', messageTokensObserved: 3_000, createdAt: new Date() }],
      bufferWatermark: 6,
    });
    loop.getCompactionManager().updateCurrentContextTokenCount(19_500);

    const parts = partsOf(loop);
    parts.tools.runtime.backgroundTasks.set({
      id: 'task_1',
      command: 'npm run check',
      process: {} as never,
      stdout: 'BACKGROUND RESULT',
      stderr: '',
      exitCode: 0,
      completed: true,
      notified: false,
      startTime: Date.now() - 1_000,
    });

    await parts.background.enqueue({ kind: 'bash', taskId: 'task_1' });

    // Precondition: the first run swapped the observed history out, failed,
    // and the delivery went through on the second attempt.
    expect(attempts).toBe(2);
    expect(loop.getObservationalMemoryState()?.observations).toContain('the first six');

    const history = loop.getConversationHistory();
    const deliveries = history.filter((m) => typeof m.content === 'string' && m.content.includes('BACKGROUND RESULT'));
    expect(deliveries).toHaveLength(1);
    assertNoOrphans(history);
  });
});
