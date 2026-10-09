import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { AgentLoop } from '../../src/agent-loop.js';
import { ProviderManager } from '../../src/provider-manager.js';
import { TOOL_NAMES } from '../../src/tools/index.js';
import { ollamaServer } from '../helpers/ollama.js';
import { CompactionManager, buildCompactionConfig } from '../../src/compaction/index.js';
import { MICROCOMPACTION_DEFAULTS } from '../../src/compaction/microcompaction.js';

const loops: AgentLoop[] = [];
afterEach(async () => { await Promise.all(loops.splice(0).map(loop => loop.destroy())); });

async function createLoop(server = ollamaServer(), tools: unknown[] = []) {
  const model = await new ProviderManager().createOllamaModel({ modelId: 'test', fetch: server.fetch });
  const loop = await AgentLoop.create({ model, workingDirectory: process.cwd(), initialBasePrompt: 'You are a test agent.',
    compaction: { strategy: 'classic' }, disableTools: Object.values(TOOL_NAMES), enableSubAgentTool: false, enableLoadSkillTool: false,
    tools: tools as never, thinkingLevel: 'low',
  });
  loops.push(loop);
  return { loop, model, server };
}

describe('Ollama through the installed agent loop', () => {
  it('executes a tool and preserves thinking through the next request and restored history', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'tool result' }] }));
    const { loop, server } = await createLoop(ollamaServer(), [{ name: 'probe', description: 'Probe', parameters: Type.Object({}), execute }]);
    server.replies.push([{ message: { thinking: 'Use the probe', tool_calls: [{ id: 'call', function: { name: 'probe', arguments: {} } }] }, done: true }]);
    await loop.prompt('Use the probe');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(server.requests.filter(r => r.path === '/api/chat')).toHaveLength(2);
    expect(server.requests.at(-1)!.body['messages']).toContainEqual(expect.objectContaining({ role: 'assistant', thinking: 'Use the probe' }));
    loop.restoreConversationHistory(JSON.parse(JSON.stringify(loop.getConversationHistory())));
    await loop.prompt('Continue');
    expect(server.requests.at(-1)!.body['messages']).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'call' }));
  });

  it('shares the runtime profile across direct, structured, and utility completion', async () => {
    const { loop, server, model } = await createLoop();
    expect(loop.getUtilityModel()).toBe(model);
    const context = { systemPrompt: 'Return a result.', prompt: 'Test' };
    await expect(loop.directComplete(context)).resolves.toBe('Done');
    server.replies.push([{ message: { content: '{"answer":42}' }, done: true }]);
    const schema = Type.Object({ answer: Type.Number() });
    await expect(loop.structuredComplete(context, schema)).resolves.toEqual({ answer: 42 });
    expect(server.requests.at(-1)!.body).toMatchObject({ format: schema });
    expect(server.requests.at(-1)!.body).not.toHaveProperty('tools');
    await expect(loop.utilityComplete(context)).resolves.toBe('Done');
    expect(server.requests.filter(r => r.path === '/api/chat').map(r => r.body['options'].num_ctx)).toEqual([32768, 32768, 32768]);
    server.replies.push([{ message: { content: '{"answer":"wrong"}' }, done: true }]);
    await expect(loop.structuredComplete(context, schema)).rejects.toThrow('JSON schema');
  });

  it('honors a runtime smaller than the former 16K floor and carries prefix policy on switches', async () => {
    const { loop, model } = await createLoop(ollamaServer({ context: 8192 }));
    expect(loop.effectiveContextWindow).toBe(8192);
    expect(loop.modelContextWindow).toBe(8192);
    expect(loop.getCompactionManager().shouldTrimHistory(3000)).toBe(false);
    loop.setCacheRetention('none');
    expect(loop.getCompactionManager().shouldTrimHistory(3000)).toBe(false);
    expect(loop.getCompactionManager().shouldTrimHistory(7000)).toBe(true);
    const other = await new ProviderManager().createCustomModel({ baseUrl: 'http://example.test/v1', modelId: 'other', contextWindow: 8192 });
    loop.setModel(other);
    expect(loop.getCompactionManager().shouldTrimHistory(3000)).toBe(true);
    loop.setModel(model);
    expect(loop.getCompactionManager().shouldTrimHistory(3000)).toBe(false);
  });

  it('keeps one shared allocation while loops use independent compaction budgets', async () => {
    const { loop, model, server } = await createLoop();
    const other = await AgentLoop.create({ model, contextWindowLimit: 4096,
      workingDirectory: process.cwd(), compaction: { strategy: 'classic' },
      disableTools: Object.values(TOOL_NAMES), enableSubAgentTool: false, enableLoadSkillTool: false,
    });
    loops.push(other);
    loop.setContextWindowLimit(8192);
    expect([loop.effectiveContextWindow, other.effectiveContextWindow]).toEqual([8192, 4096]);
    expect([loop.modelContextWindow, other.modelContextWindow]).toEqual([32768, 32768]);
    await loop.directComplete({ systemPrompt: 'Test', prompt: 'First' });
    await other.utilityComplete({ systemPrompt: 'Test', prompt: 'Second' });
    expect(server.requests.filter(r => r.path === '/api/chat').map(r => r.body['options'].num_ctx)).toEqual([32768, 32768]);
  });


});

describe('automatic prefix preservation', () => {
  it('preserves actual long tool history under headroom and trims it under pressure', async () => {
    const manager = new CompactionManager(buildCompactionConfig(), 0);
    manager.setContextWindow(100000);
    manager.setCacheInfo('ollama', 'none', 'automatic-prefix');
    const history = Array.from({ length: 12 }, (_, i) => ({ role: 'toolResult' as const, toolCallId: `call${i}`, toolName: 'Bash',
      content: [{ type: 'text' as const, text: 'abc '.repeat(10000) }], isError: false, timestamp: i }));
    // Check the production gate and real trimming engine, with context totals supplied as the loop would.
    const { MicrocompactionEngine } = await import('../../src/compaction/microcompaction.js');
    const engine = new MicrocompactionEngine(MICROCOMPACTION_DEFAULTS);
    expect(await engine.apply(history, 100000, 50000, { cacheCold: manager.shouldTrimHistory(50000) })).toBe(history);
    expect(await engine.apply(history, 100000, 80000, { cacheCold: manager.shouldTrimHistory(80000) })).not.toEqual(history);
    expect(manager.providerCacheTtlMs).toBe(0);
    expect(manager.isCacheCold()).toBe(true); // Unknown server state is not reported as a guaranteed warm cache.
  });

  it('trims from its own prefix ratio', () => {
    const manager = new CompactionManager(buildCompactionConfig({
      microcompaction: { ...MICROCOMPACTION_DEFAULTS, prefixTrimRatio: 0.9 },
    }), 0);
    manager.setContextWindow(100000);
    manager.setCacheInfo('ollama', 'none', 'automatic-prefix');
    expect(manager.shouldTrimHistory(80000)).toBe(false);
    expect(manager.shouldTrimHistory(90000)).toBe(true);
  });
});
