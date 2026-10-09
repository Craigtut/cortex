import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import * as piCompat from '@earendil-works/pi-ai/compat';
import { AgentLoop } from '../../src/agent-loop.js';
import { ProviderManager } from '../../src/provider-manager.js';
import { TOOL_NAMES } from '../../src/tools/index.js';

// Native ESM exports are immutable. Copy the real exports so Vitest can replace
// the transport while retaining the published entrypoint and its other APIs.
vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => ({
  ...await importOriginal<typeof piCompat>(),
}));

// Keep the installed Agent, provider catalog, and event stream real. Only the
// model response is synthetic, so this checks our dynamic upstream boundary
// without credentials or network requests.
describe('installed Pi integration', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['text', 'tool', 'terminating tool'] as const)(
    'settles a %s response and preserves provider metadata on replay',
    async (kind) => {
      const manager = new ProviderManager();
      const catalog = await manager.listModels('anthropic');
      expect(catalog.length).toBeGreaterThan(0);
      const model = await manager.resolveModel('anthropic', catalog[0]!.id);
      const execute = vi.fn(async () => ({
        content: [{ type: 'text', text: 'Tool completed' }],
        ...(kind === 'terminating tool' ? { terminate: true } : {}),
      }));
      const stream = vi.spyOn(piCompat, 'streamSimple');
      stream.mockImplementation((rawModel) => {
        const callsTool = kind !== 'text' && stream.mock.calls.length === 1;
        const message: AssistantMessage = {
          role: 'assistant',
          content: callsTool
            ? [{ type: 'toolCall', id: 'call-1', name: 'contract_probe', arguments: {}, namespace: 'probe' }]
            : [{ type: 'text', text: 'Done' }],
          api: rawModel.api,
          provider: rawModel.provider,
          model: rawModel.id,
          providerThinkingLevel: 'high',
          endTurn: !callsTool,
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: callsTool ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        };
        const events = createAssistantMessageEventStream();
        events.push({ type: 'start', partial: message });
        events.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message });
        return events;
      });

      const loop = await AgentLoop.create({
        model,
        workingDirectory: process.cwd(),
        initialBasePrompt: 'Test the upstream integration.',
        getApiKey: async () => 'unused-test-key',
        compaction: { strategy: 'classic' },
        disableTools: Object.values(TOOL_NAMES),
        enableSubAgentTool: false,
        enableLoadSkillTool: false,
        tools: [{
          name: 'contract_probe',
          description: 'Return a deterministic test result.',
          parameters: Type.Object({}),
          execute,
        }],
      });
      const complete = vi.fn();
      loop.onLoopComplete(complete);

      try {
        await loop.prompt('Run the probe.');

        expect(complete).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledTimes(kind === 'text' ? 0 : 1);
        expect(stream).toHaveBeenCalledTimes(kind === 'tool' ? 2 : 1);
        const history = loop.getConversationHistory();
        expect(history.map((message) => message.role)).toEqual(
          kind === 'text' ? ['user', 'assistant']
            : kind === 'tool' ? ['user', 'assistant', 'toolResult', 'assistant']
              : ['user', 'assistant', 'toolResult'],
        );
        expect(history[1]).toMatchObject({ providerThinkingLevel: 'high', endTurn: kind === 'text' });
        if (kind !== 'text') {
          expect(history[1]!.content).toEqual([
            expect.objectContaining({ type: 'toolCall', namespace: 'probe' }),
          ]);
          expect(history[2]).toMatchObject({ isError: false });
        }

        // Consumer persistence uses plain JSON. The next request must retain
        // new upstream fields through restore and Cortex's context transform.
        loop.restoreConversationHistory(JSON.parse(JSON.stringify(history)));
        await loop.prompt('Continue.');
        expect(complete).toHaveBeenCalledTimes(2);
        const replay = stream.mock.lastCall![1].messages;
        expect(replay).toContainEqual(expect.objectContaining({
          role: 'assistant', providerThinkingLevel: 'high', endTurn: kind === 'text',
        }));
        if (kind !== 'text') {
          expect(replay).toContainEqual(expect.objectContaining({
            content: [expect.objectContaining({ type: 'toolCall', namespace: 'probe' })],
          }));
        }
      } finally {
        await loop.destroy();
      }
    },
  );

  it('records an error-flagged tool result as an error, with timings and the requested thinking level', async () => {
    const manager = new ProviderManager();
    const catalog = await manager.listModels('anthropic');
    const model = await manager.resolveModel('anthropic', catalog[0]!.id);
    const stream = vi.spyOn(piCompat, 'streamSimple');
    stream.mockImplementation((rawModel) => {
      // Created first: a stream only times responses that start after it.
      const events = createAssistantMessageEventStream();
      const callsTool = stream.mock.calls.length === 1;
      const message: AssistantMessage = {
        role: 'assistant',
        content: callsTool
          ? [{ type: 'toolCall', id: 'call-1', name: 'failing_probe', arguments: {} }]
          : [{ type: 'text', text: 'Noted the failure' }],
        api: rawModel.api,
        provider: rawModel.provider,
        model: rawModel.id,
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: callsTool ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      };
      events.push({ type: 'start', partial: message });
      events.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop', message });
      return events;
    });

    const loop = await AgentLoop.create({
      model,
      workingDirectory: process.cwd(),
      initialBasePrompt: 'Test the upstream integration.',
      getApiKey: async () => 'unused-test-key',
      thinkingLevel: 'low',
      compaction: { strategy: 'classic' },
      disableTools: Object.values(TOOL_NAMES),
      enableSubAgentTool: false,
      enableLoadSkillTool: false,
      tools: [{
        name: 'failing_probe',
        description: 'Report a failure without throwing.',
        parameters: Type.Object({}),
        // A result flagged as an error, the way pi-agent-core 0.99+ lets a
        // tool fail without throwing. Earlier versions ignored the flag.
        execute: async () => ({ content: [{ type: 'text', text: 'Probe failed' }], isError: true }),
      }],
    });

    try {
      await loop.prompt('Run the probe.');
      const history = JSON.parse(JSON.stringify(loop.getConversationHistory())) as Array<Record<string, unknown>>;
      expect(history.map((message) => message['role'])).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
      expect(history[2]).toMatchObject({ role: 'toolResult', isError: true });
      expect(history[2]!['durationMs']).toEqual(expect.any(Number));
      expect(history[1]).toMatchObject({ thinkingLevel: 'low' });
      expect(history[1]!['durationMs']).toEqual(expect.any(Number));
    } finally {
      await loop.destroy();
    }
  });
});
