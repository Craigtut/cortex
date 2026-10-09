/**
 * An omitted CortexAgent mode is resolved from the backends (decisions.md
 * D21): passthrough only when the talker and the reasoner would share one
 * backend that cannot serve them concurrently, with a note saying why, and
 * duplex otherwise. An explicit mode always wins, and duplex on such a
 * shared backend carries a warning note.
 *
 * Models come from the real creation paths (ProviderManager against a
 * synthetic Ollama server, pi-ai's catalog), so the capability each path
 * stamps is what the decision reads. Only the pi agent under each loop is
 * substituted.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent } from '../../src/agent-loop.js';
import { CortexAgent } from '../../src/cortex-agent.js';
import type { CortexAgentConfig } from '../../src/cortex-agent.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import { ProviderManager } from '../../src/provider-manager.js';
import type { ResolutionNote } from '../../src/resolution-report.js';
import { createScriptedPiAgent } from './duplex-scenario-harness.js';
import { ollamaServer } from '../helpers/ollama.js';

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

const facades: CortexAgent[] = [];

afterEach(async () => {
  for (const facade of facades.splice(0)) await facade.destroy().catch(() => {});
  vi.restoreAllMocks();
});

/** Build a facade through the real create(), recording the loops it assembled. */
async function create(config: Partial<CortexAgentConfig> & { model: CortexModel }): Promise<{
  facade: CortexAgent;
  loopPaths: string[];
  loops: Map<string, AgentLoop>;
}> {
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  const loopPaths: string[] = [];
  const loops = new Map<string, AgentLoop>();
  vi.spyOn(AgentLoop, 'create').mockImplementation(async (loopConfig) => {
    const extras = loopConfig as { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean };
    const loop = new AgentLoopCtor(createScriptedPiAgent(), loopConfig, [], {
      enableSubAgentTool: extras.enableSubAgentTool ?? true,
      enableLoadSkillTool: extras.enableLoadSkillTool ?? true,
    });
    loopPaths.push(loopConfig.loopPath ?? 'main');
    loops.set(loopConfig.loopPath ?? 'main', loop);
    return loop;
  });
  const facade = await CortexAgent.create({
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    ...config,
  });
  facades.push(facade);
  return { facade, loopPaths, loops };
}

function note(facade: CortexAgent, code: string): ResolutionNote | undefined {
  return facade.getResolutionReport().find((candidate) => candidate.code === code);
}

function ollamaModel(
  options: { parallelRequests?: boolean; modelId?: string; baseUrl?: string } = {},
): Promise<CortexModel> {
  return new ProviderManager().createOllamaModel({
    modelId: 'test',
    baseUrl: 'http://localhost:11434',
    fetch: ollamaServer({ name: options.modelId ?? 'test' }).fetch,
    ...options,
  });
}

describe('omitted mode', () => {
  it('runs an Anthropic duplex talker on the newest Haiku', async () => {
    const model = await new ProviderManager().resolveModel('anthropic', 'claude-opus-5-5');

    const { loops } = await create({ model });

    // pi-ai 1.1.0 ships claude-haiku-5-5 beside the dated claude-haiku-4-5-20251001.
    expect(loops.get('talker')!.getModel().modelId).toBe('claude-haiku-5-5');
  });

  it('resolves to duplex on a hosted provider', async () => {
    const model = await new ProviderManager().resolveModel('anthropic', 'claude-sonnet-4-6');
    expect(model.capabilities?.concurrency).toBe('parallel');

    const { facade, loopPaths, loops } = await create({ model });

    expect(loopPaths).toEqual(['reasoner', 'talker']);
    // The auto-resolved fast tier, so the talker is a different model.
    expect(loops.get('talker')!.getModel().modelId).not.toBe('claude-sonnet-4-6');
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();
  });

  it('resolves to duplex when a hosted talker runs the same model as the reasoner', async () => {
    const pm = new ProviderManager();
    const reasoner = await pm.resolveModel('anthropic', 'claude-opus-4-7');
    const talker = await pm.resolveModel('anthropic', 'claude-opus-4-7');

    const { facade, loopPaths, loops } = await create({ model: reasoner, talker: { model: talker } });

    // A hosted API serves two requests for one model concurrently.
    expect(loopPaths).toEqual(['reasoner', 'talker']);
    expect(loops.get('talker')!.getModel().modelId).toBe(loops.get('reasoner')!.getModel().modelId);
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();
  });

  it('resolves to passthrough on Ollama, and says why', async () => {
    const model = await ollamaModel();
    expect(model.capabilities?.concurrency).toBe('serial');

    const { facade, loopPaths } = await create({ model });

    expect(loopPaths).toEqual(['main']);
    const resolved = note(facade, 'mode-resolved-passthrough');
    expect(resolved).toBeDefined();
    expect(resolved!.severity).toBe('info');
    expect(resolved!.data).toMatchObject({
      reasonerProvider: 'ollama',
      reasonerModelId: 'test',
      reasonerConcurrency: 'serial',
      talkerConcurrency: 'serial',
    });
    expect(resolved!.detail).toContain('serves one request at a time');
    expect(resolved!.remedy).toContain('parallelRequests: true');
  });

  it('resolves to duplex on Ollama with the parallel opt-in', async () => {
    const model = await ollamaModel({ parallelRequests: true });
    expect(model.capabilities?.concurrency).toBe('parallel');

    const { facade, loopPaths } = await create({ model });

    expect(loopPaths).toEqual(['reasoner', 'talker']);
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();
  });

  it('resolves to passthrough on a custom OpenAI-compatible endpoint', async () => {
    const model = await new ProviderManager().createCustomModel({
      baseUrl: 'http://localhost:8000/v1',
      modelId: 'local-model',
    });
    expect(model.capabilities?.concurrency).toBe('unknown');

    const { facade, loopPaths } = await create({ model });

    expect(loopPaths).toEqual(['main']);
    expect(note(facade, 'mode-resolved-passthrough')!.data).toMatchObject({
      reasonerProvider: 'custom',
      reasonerConcurrency: 'unknown',
    });
  });
});

describe('omitted mode across backends', () => {
  it('resolves to duplex with a serial reasoner and a talker pinned to a hosted provider', async () => {
    const reasoner = await ollamaModel();
    const talker = await new ProviderManager().resolveModel('anthropic', 'claude-haiku-4-5');
    expect(reasoner.capabilities?.concurrency).toBe('serial');

    const { facade, loopPaths } = await create({ model: reasoner, talker: { model: talker } });

    // The talker's requests go to Anthropic, so nothing queues behind the reasoner.
    expect(loopPaths).toEqual(['reasoner', 'talker']);
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();
  });

  it('resolves to duplex with a hosted reasoner and a talker pinned to a serial server', async () => {
    const reasoner = await new ProviderManager().resolveModel('anthropic', 'claude-sonnet-4-6');
    const talker = await ollamaModel();
    expect(talker.capabilities?.concurrency).toBe('serial');

    const { facade, loopPaths } = await create({ model: reasoner, talker: { model: talker } });

    expect(loopPaths).toEqual(['reasoner', 'talker']);
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();
  });

  it('resolves to duplex when an explicit utilityModel puts the talker on another server', async () => {
    const reasoner = await ollamaModel({ baseUrl: 'http://gpu-a.local:11434' });
    const utility = await ollamaModel({ modelId: 'small', baseUrl: 'http://gpu-b.local:11434' });

    const { facade, loopPaths, loops } = await create({ model: reasoner, utilityModel: utility });

    expect(loopPaths).toEqual(['reasoner', 'talker']);
    expect(loops.get('talker')!.getModel().modelId).toBe('small');
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
  });

  it('resolves to passthrough when an explicit utilityModel shares the serial server', async () => {
    const reasoner = await ollamaModel();
    // 127.0.0.1 and localhost are one server.
    const utility = await ollamaModel({ modelId: 'small', baseUrl: 'http://127.0.0.1:11434' });

    const { facade, loopPaths } = await create({ model: reasoner, utilityModel: utility });

    expect(loopPaths).toEqual(['main']);
    expect(note(facade, 'mode-resolved-passthrough')!.data).toMatchObject({
      reasonerModelId: 'test',
      talkerModelId: 'small',
    });
  });

  it('resolves to passthrough for two distinct models on one serial server, and says how to opt in', async () => {
    const reasoner = await ollamaModel();
    const talker = await ollamaModel({ modelId: 'small' });

    const { facade, loopPaths } = await create({ model: reasoner, talker: { model: talker } });

    // Ollama runs two models at once only if both fit in memory, which it
    // does not expose, so a shared serial server blocks by default.
    expect(loopPaths).toEqual(['main']);
    const resolved = note(facade, 'mode-resolved-passthrough')!;
    expect(resolved.data).toMatchObject({
      reasonerEndpoint: 'http://localhost:11434',
      talkerEndpoint: 'http://localhost:11434',
      talkerModelId: 'small',
    });
    expect(resolved.detail).toContain('the talker model "small" and the reasoner model "test" both run on');
    expect(resolved.remedy).toContain('both models fitting in memory together');
    expect(resolved.remedy).toContain('parallelRequests: true');
  });

  it('resolves to duplex for two distinct models on one server that opted into parallel requests', async () => {
    const reasoner = await ollamaModel({ parallelRequests: true });
    const talker = await ollamaModel({ modelId: 'small', parallelRequests: true });

    const { loopPaths } = await create({ model: reasoner, talker: { model: talker } });

    expect(loopPaths).toEqual(['reasoner', 'talker']);
  });

  it('resolves to passthrough when a custom endpoint is the same server as the native model', async () => {
    const reasoner = await ollamaModel();
    const talker = await new ProviderManager().createCustomModel({
      baseUrl: 'http://localhost:11434/v1',
      modelId: 'test',
    });

    const { loopPaths } = await create({ model: reasoner, talker: { model: talker } });

    expect(loopPaths).toEqual(['main']);
  });
});

describe('explicit mode', () => {
  it('runs duplex on a serial backend when asked, with a warning note', async () => {
    const model = await ollamaModel();

    const { facade, loopPaths } = await create({ model, mode: 'duplex' });

    expect(loopPaths).toEqual(['reasoner', 'talker']);
    const warning = note(facade, 'duplex-not-concurrent');
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe('degraded');
    expect(warning!.data).toMatchObject({ talkerConcurrency: 'serial', reasonerConcurrency: 'serial' });
    // Asked for, so there is no auto-resolution note.
    expect(note(facade, 'mode-resolved-passthrough')).toBeUndefined();
  });

  it('does not warn when a duplex talker is on another backend than a serial reasoner', async () => {
    const reasoner = await new ProviderManager().resolveModel('anthropic', 'claude-sonnet-4-6');
    const talker = await ollamaModel();
    expect(talker.capabilities?.concurrency).toBe('serial');

    const { facade, loopPaths } = await create({ model: reasoner, talker: { model: talker }, mode: 'duplex' });

    expect(loopPaths).toEqual(['reasoner', 'talker']);
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();
  });

  it('runs passthrough on a hosted provider when asked, with no mode notes', async () => {
    const model = await new ProviderManager().resolveModel('anthropic', 'claude-sonnet-4-6');

    const { facade, loopPaths } = await create({ model, mode: 'passthrough' });

    expect(loopPaths).toEqual(['main']);
    expect(facade.getResolutionReport()).toEqual([]);
  });
});

describe('setModel after assembly', () => {
  it('keeps the mode and warns when an unpinned duplex moves onto a serial server', async () => {
    const hosted = await new ProviderManager().resolveModel('anthropic', 'claude-sonnet-4-6');
    const { facade, loops } = await create({ model: hosted });
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();

    facade.setModel(await ollamaModel());

    // Still duplex, the unpinned talker mirrored onto the same server.
    expect(loops.get('talker')!.getModel().provider).toBe('ollama');
    expect(note(facade, 'duplex-not-concurrent')!.data).toMatchObject({
      talkerConcurrency: 'serial',
      reasonerConcurrency: 'serial',
    });
  });

  it('does not warn when a pinned hosted talker stays on another backend', async () => {
    const pm = new ProviderManager();
    const hosted = await pm.resolveModel('anthropic', 'claude-sonnet-4-6');
    const talker = await pm.resolveModel('anthropic', 'claude-haiku-4-5');
    const { facade, loops } = await create({ model: hosted, talker: { model: talker } });

    facade.setModel(await ollamaModel());

    expect(loops.get('reasoner')!.getModel().capabilities?.concurrency).toBe('serial');
    expect(loops.get('talker')!.getModel().modelId).toBe('claude-haiku-4-5');
    expect(note(facade, 'duplex-not-concurrent')).toBeUndefined();
  });

  it('re-reads the passthrough note when setModel moves onto models that would run duplex', async () => {
    const { facade, loopPaths } = await create({ model: await ollamaModel() });
    expect(note(facade, 'mode-resolved-passthrough')!.data).toMatchObject({ reasonerProvider: 'ollama' });

    facade.setModel(await new ProviderManager().resolveModel('anthropic', 'claude-sonnet-4-6'));

    // The mode stays; the note now says what fixes it.
    expect(loopPaths).toEqual(['main']);
    const resolved = note(facade, 'mode-resolved-passthrough')!;
    expect(resolved.data).toMatchObject({ reasonerProvider: 'anthropic', wouldResolveTo: 'duplex' });
    expect(resolved.summary).toContain('resolved at creation');
    expect(resolved.detail).not.toContain('serves one request at a time');
  });

  it('re-reads the passthrough note when setModel stays on a shared serial server', async () => {
    const { facade } = await create({ model: await ollamaModel() });
    expect(note(facade, 'mode-resolved-passthrough')!.data).toMatchObject({ reasonerModelId: 'test' });

    facade.setModel(await ollamaModel({ modelId: 'small' }));

    expect(note(facade, 'mode-resolved-passthrough')!.data).toMatchObject({
      reasonerModelId: 'small',
      wouldResolveTo: 'passthrough',
    });
    expect(facade.getResolutionReport().filter((n) => n.code === 'mode-resolved-passthrough')).toHaveLength(1);
  });

  it('gives an explicit passthrough no mode note after setModel onto a serial server', async () => {
    const hosted = await new ProviderManager().resolveModel('anthropic', 'claude-sonnet-4-6');
    const { facade, loops } = await create({ model: hosted, mode: 'passthrough' });

    facade.setModel(await ollamaModel());

    expect(loops.get('main')!.getModel().capabilities?.concurrency).toBe('serial');
    expect(facade.getResolutionReport()).toEqual([]);
  });
});
