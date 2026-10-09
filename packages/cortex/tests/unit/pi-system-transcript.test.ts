/**
 * The system prompt and tool declarations as they reach pi's provider layer.
 *
 * Real pi Agent, real provider catalog, synthetic model responses: each
 * request's TranscriptContext is captured at pi's streamSimple boundary, so
 * these pin what a provider would actually receive, not a Cortex getter.
 * The load-bearing claim is cache-friendliness: once the model has
 * answered, a tool or prompt change must arrive as a later system message,
 * leaving the head (the cached prefix) byte-identical.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  hasNonAdditiveToolChanges,
} from '@earendil-works/pi-ai/utils/transcript';
import { AgentLoop } from '../../src/agent-loop.js';
import { ProviderManager } from '../../src/provider-manager.js';
import { TOOL_NAMES } from '../../src/tools/index.js';
import { INSTRUCTIONS_SECTION } from '../../src/agent-loop/system-prompt.js';
import { getModelRuntime } from '../../src/model-runtime.js';

type Sent = Array<{ role: string; [key: string]: unknown }>;

function probe(name: string) {
  return {
    name,
    description: `Probe ${name}.`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  };
}

/**
 * Every request to pi's Anthropic provider is captured into `requests`;
 * `failNext()` makes a call fail the way a provider error does. Installed
 * once per test. Only the transport is replaced: Cortex's runtime still
 * picks the provider and hands it the request.
 */
function mockProvider(requests: Sent[], failNext: () => boolean = () => false) {
  vi.spyOn(getModelRuntime().models.getProvider('anthropic')!, 'streamSimple').mockImplementation((rawModel, context) => {
    requests.push(structuredClone(context.messages) as unknown as Sent);
    const fail = failNext();
    const message: AssistantMessage = {
      role: 'assistant',
      content: fail ? [] : [{ type: 'text', text: 'Done' }],
      api: rawModel.api,
      provider: rawModel.provider,
      model: rawModel.id,
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: fail ? 'error' : 'stop',
      ...(fail ? { errorMessage: 'upstream exploded' } : {}),
      timestamp: Date.now(),
    };
    const events = createAssistantMessageEventStream();
    if (fail) {
      events.push({ type: 'error', reason: 'error', error: message });
    } else {
      events.push({ type: 'start', partial: message });
      events.push({ type: 'done', reason: 'stop', message });
    }
    return events;
  });
}

async function buildLoop(tools: string[] = ['first_probe']) {
  const manager = new ProviderManager();
  const catalog = await manager.listModels('anthropic');
  const model = await manager.resolveModel('anthropic', catalog[0]!.id);
  return AgentLoop.create({
    model,
    workingDirectory: process.cwd(),
    initialBasePrompt: 'You are the probe host.',
    getApiKey: async () => 'unused-test-key',
    compaction: { strategy: 'classic' },
    disableTools: Object.values(TOOL_NAMES),
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
    retryPolicy: { enabled: false },
    tools: tools.map(probe),
  });
}

async function createLoop(requests: Sent[]) {
  mockProvider(requests);
  return buildLoop();
}

const textOf = (message: { content?: unknown }): string =>
  typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((block: { text?: string }) => block.text ?? '').join('')
      : '';

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const systemMessages = (sent: Sent) => sent.filter((message) => message.role === 'system');
const toolNames = (sent: Sent) =>
  getCurrentTools(sent as never).map((tool) => tool.name).sort();

describe('system transcript at the provider boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens the first request with one head carrying the sections and the initial tools', async () => {
    const requests: Sent[] = [];
    const loop = await createLoop(requests);
    try {
      await loop.prompt('Hello.');

      const [first] = requests;
      expect(first![0]).toMatchObject({
        role: 'system',
        content: '',
        sections: expect.objectContaining({ [INSTRUCTIONS_SECTION]: 'You are the probe host.' }),
      });
      // pi declared the tools as a separate message before the prompt; the
      // pre-request sync folded it into the head, where native tool-change
      // transports anchor later additions.
      expect(systemMessages(first!)).toHaveLength(1);
      expect((first![0]!['toolsAdded'] as Array<{ name: string }>).map((tool) => tool.name))
        .toEqual(['first_probe']);
      expect(getCurrentSystemPrompt(first! as never)).toBe(loop.getCurrentSystemPrompt());
    } finally {
      await loop.destroy();
    }
  });

  it('declares a tool added after an answer as a later message, leaving the head intact', async () => {
    const requests: Sent[] = [];
    const loop = await createLoop(requests);
    try {
      await loop.prompt('Hello.');
      loop.addConsumerTool(probe('second_probe'));
      await loop.prompt('Now with more tools.');

      const [first, second] = requests;
      expect(second![0]).toEqual(first![0]);
      const later = systemMessages(second!).slice(1);
      expect(later).toHaveLength(1);
      expect((later[0]!['toolsAdded'] as Array<{ name: string }>).map((tool) => tool.name))
        .toEqual(['second_probe']);
      expect(toolNames(second!)).toEqual(['first_probe', 'second_probe']);
      // In time order: after the first exchange, before the new prompt.
      const laterIndex = second!.indexOf(later[0]!);
      expect(second![laterIndex - 1]).toMatchObject({ role: 'assistant' });
      expect(second![laterIndex + 1]).toMatchObject({ role: 'user' });
    } finally {
      await loop.destroy();
    }
  });

  it('sends a prompt change after an answer as a section patch, leaving the head intact', async () => {
    const requests: Sent[] = [];
    const loop = await createLoop(requests);
    try {
      await loop.prompt('Hello.');
      loop.setBasePrompt('You are the renamed probe host.');
      await loop.prompt('Carry on.');

      const [first, second] = requests;
      expect(second![0]).toEqual(first![0]);
      const later = systemMessages(second!).slice(1);
      expect(later).toEqual([expect.objectContaining({
        content: '',
        sections: { [INSTRUCTIONS_SECTION]: 'You are the renamed probe host.' },
      })]);
      expect(getCurrentSystemPrompt(second! as never)).toBe(loop.getCurrentSystemPrompt());
    } finally {
      await loop.destroy();
    }
  });

  it('round-trips history with its system messages through JSON and restores in line', async () => {
    const requests: Sent[] = [];
    const loop = await createLoop(requests);
    try {
      await loop.prompt('Hello.');
      loop.addConsumerTool(probe('second_probe'));
      await loop.prompt('Again.');
      const saved = JSON.parse(JSON.stringify(loop.getConversationHistory()));
      expect(saved.map((message: { role: string }) => message.role))
        .toEqual(['user', 'assistant', 'system', 'user', 'assistant']);

      loop.restoreConversationHistory(saved);
      expect(loop.getConversationHistory()).toEqual(saved);
      await loop.prompt('After restore.');
      const last = requests.at(-1)!;
      // Nothing to re-declare: the restored delta already matches the live tools.
      expect(systemMessages(last)).toHaveLength(2);
      expect(toolNames(last)).toEqual(['first_probe', 'second_probe']);
    } finally {
      await loop.destroy();
    }
  });

  it('declares each tool once after restoring into a fresh loop', async () => {
    const requests: Sent[] = [];
    mockProvider(requests);
    const first = await buildLoop(['first_probe']);
    let saved: unknown;
    try {
      await first.prompt('Hello.');
      first.addConsumerTool(probe('second_probe'));
      await first.prompt('Again.');
      saved = JSON.parse(JSON.stringify(first.getConversationHistory()));
    } finally {
      await first.destroy();
    }

    const resumed = await buildLoop(['first_probe', 'second_probe']);
    try {
      resumed.restoreConversationHistory(saved as never);
      await resumed.prompt('Resumed.');
      const sent = requests.at(-1)!;
      expect(toolNames(sent)).toEqual(['first_probe', 'second_probe']);
      // A duplicate declaration is outside what native tool-change transports accept.
      expect(hasNonAdditiveToolChanges(sent as never)).toBe(false);
      expect(getCurrentSystemPrompt(sent as never)).toBe(resumed.getCurrentSystemPrompt());
    } finally {
      await resumed.destroy();
    }
  });

  it('re-delivers a spliced wake delivery once when a tool change preceded the failed run', async () => {
    const requests: Sent[] = [];
    let failNext = false;
    mockProvider(requests, () => {
      const fail = failNext;
      failNext = false;
      return fail;
    });
    const loop = await buildLoop();
    try {
      await loop.prompt('Hello.');
      // pi declares the new tool ahead of the next run's batch, at the boundary.
      loop.addConsumerTool(probe('second_probe'));
      failNext = true;
      const turn = loop.prompt('real question');
      expect(loop.deliver('spliced wake content').outcome).toBe('parked');
      await expect(turn).rejects.toThrow();
      await waitUntil(() => !loop.isLoopActive && loop.pendingWakeDeliveryCount === 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await waitUntil(() => !loop.isLoopActive);

      const copies = loop.getConversationHistory()
        .filter((message) => message.role === 'user' && textOf(message).includes('spliced wake content'));
      expect(copies).toHaveLength(1);
    } finally {
      await loop.destroy();
    }
  });
});
