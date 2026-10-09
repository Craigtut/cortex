import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import { ProviderManager } from '../../src/provider-manager.js';

const mockGetModel = vi.fn();
const mockComplete = vi.fn();
let lastAgentConfig: Record<string, unknown> | null = null;
let lastAgentInstance: { state: Record<string, unknown> } | null = null;

class MockManagedPiAgent {
  state: Record<string, unknown>;

  constructor(config: Record<string, unknown>) {
    lastAgentConfig = config;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastAgentInstance = this;
    const initialState = config['initialState'] as Record<string, unknown>;
    this.state = {
      messages: [],
      systemPrompt: '',
      tools: [],
      ...initialState,
    };
  }

  subscribe(): () => void {
    return () => {};
  }

  async prompt(): Promise<unknown> {
    return { content: 'ok' };
  }

  abort(): void {}

  async waitForIdle(): Promise<void> {}

  reset(): void {
    this.state['messages'] = [];
  }

  steer(): void {}
}

vi.mock('@earendil-works/pi-ai', () => ({
  getModel: (...args: unknown[]) => mockGetModel(...args),
  createModel: vi.fn(),
  getModels: vi.fn(),
  getEnvApiKey: vi.fn(),
  getSupportedThinkingLevels: vi.fn(),
  clampThinkingLevel: vi.fn(),
  complete: (...args: unknown[]) => mockComplete(...args),
}));

// Catalog reads come from providers/all; mock them to the same fns.
vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinModel: (...args: unknown[]) => mockGetModel(...args),
  getBuiltinModels: vi.fn(),
  // Read by wrapModel's concurrency classification, which nothing here checks.
  builtinProviders: () => [],
}));

// Requests go through Cortex's model runtime; its stream resolves to the mock.
vi.mock('../../src/model-runtime.js', () => ({
  streamModel: (...args: unknown[]) => ({ result: () => mockComplete(...args) }),
}));

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: MockManagedPiAgent,
}));

function makeUsage() {
  return {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

describe('AgentLoop model contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastAgentConfig = null;
    lastAgentInstance = null;
  });

  it('uses the unwrapped pi-ai model across ProviderManager, create(), directComplete(), and setModel()', async () => {
    const resolvedRawModel = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      id: 'claude-sonnet-4-20250514',
      api: 'anthropic',
      contextWindow: 200_000,
    };
    const swappedRawModel = {
      provider: 'anthropic',
      name: 'claude-opus-4-20260101',
      id: 'claude-opus-4-20260101',
      api: 'anthropic',
      contextWindow: 200_000,
    };

    mockGetModel
      .mockReturnValueOnce(resolvedRawModel)
      .mockReturnValueOnce(swappedRawModel);

    mockComplete.mockResolvedValue({
      content: [{ type: 'text', text: 'direct completion ok' }],
      usage: makeUsage(),
    });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await AgentLoop.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    expect(lastAgentConfig).not.toBeNull();
    expect((lastAgentConfig!['initialState'] as Record<string, unknown>)['model']).toBe(resolvedRawModel);

    const text = await agent.directComplete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(text).toBe('direct completion ok');
    expect(mockComplete).toHaveBeenCalledWith(
      resolvedRawModel,
      expect.objectContaining({
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      { ambientCredentials: false },
    );

    const nextModel = await providerManager.resolveModel('anthropic', 'claude-opus-4-20260101');
    agent.setModel(nextModel);

    expect(lastAgentInstance!.state['model']).toBe(swappedRawModel);
  });

  it('applies the agent cache retention to directComplete calls by default', async () => {
    const rawModel = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      id: 'claude-sonnet-4-20250514',
      api: 'anthropic',
      contextWindow: 200_000,
    };

    mockGetModel.mockReturnValue(rawModel);
    mockComplete.mockResolvedValue({
      content: [{ type: 'text', text: 'direct completion ok' }],
      usage: makeUsage(),
    });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await AgentLoop.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    agent.setCacheRetention('long');

    await agent.directComplete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(mockComplete).toHaveBeenCalledWith(
      rawModel,
      expect.objectContaining({
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      { cacheRetention: 'long', ambientCredentials: false },
    );
  });

  it('applies the agent cache retention to structuredComplete calls by default', async () => {
    const rawModel = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      id: 'claude-sonnet-4-20250514',
      api: 'anthropic',
      contextWindow: 200_000,
    };

    mockGetModel.mockReturnValue(rawModel);
    mockComplete.mockResolvedValue({
      content: [],
      usage: makeUsage(),
    });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await AgentLoop.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    agent.setCacheRetention('long');

    await agent.structuredComplete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      { type: 'object', properties: {}, required: [] },
      'structured_output',
      'Produce structured output',
    );

    expect(mockComplete).toHaveBeenCalledWith(
      rawModel,
      expect.objectContaining({
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [expect.objectContaining({ name: 'structured_output' })],
      }),
      expect.objectContaining({
        toolChoice: 'any',
        cacheRetention: 'long',
      }),
    );
  });

  it('forwards a caller abort signal to direct and structured completions', async () => {
    const rawModel = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      id: 'claude-sonnet-4-20250514',
      api: 'anthropic',
      contextWindow: 200_000,
    };

    mockGetModel.mockReturnValue(rawModel);
    mockComplete.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: makeUsage(),
    });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await AgentLoop.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    const controller = new AbortController();

    await agent.directComplete(
      { systemPrompt: 'System', messages: [{ role: 'user', content: 'Hello' }] },
      { signal: controller.signal },
    );

    expect(mockComplete).toHaveBeenLastCalledWith(
      rawModel,
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );

    mockComplete.mockResolvedValue({ content: [], usage: makeUsage() });

    await agent.structuredComplete(
      { systemPrompt: 'System', messages: [{ role: 'user', content: 'Hello' }] },
      { type: 'object', properties: {}, required: [] },
      'structured_output',
      'Produce structured output',
      { signal: controller.signal },
    );

    expect(mockComplete).toHaveBeenLastCalledWith(
      rawModel,
      expect.anything(),
      expect.objectContaining({ signal: controller.signal, toolChoice: 'any' }),
    );
  });

  it('rejects a direct completion with an AbortError when pi-ai reports it aborted', async () => {
    const rawModel = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      id: 'claude-sonnet-4-20250514',
      api: 'anthropic',
      contextWindow: 200_000,
    };

    mockGetModel.mockReturnValue(rawModel);
    mockComplete.mockResolvedValue({
      stopReason: 'aborted',
      content: [],
      usage: makeUsage(),
    });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await AgentLoop.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    await expect(
      agent.directComplete({ systemPrompt: 'System', messages: [{ role: 'user', content: 'Hello' }] }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a structured completion with an AbortError when the caller signal is already aborted', async () => {
    const rawModel = {
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      id: 'claude-sonnet-4-20250514',
      api: 'anthropic',
      contextWindow: 200_000,
    };

    mockGetModel.mockReturnValue(rawModel);
    // A valid result still resolves, but an aborted caller signal discards it.
    mockComplete.mockResolvedValue({ content: [], usage: makeUsage() });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await AgentLoop.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      agent.structuredComplete(
        { systemPrompt: 'System', messages: [{ role: 'user', content: 'Hello' }] },
        { type: 'object', properties: {}, required: [] },
        'structured_output',
        'Produce structured output',
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  // -----------------------------------------------------------------------
  // Error surfacing from direct (non-agentic) completion paths.
  // THOUGHT / REFLECT / utility calls run through directComplete /
  // structuredComplete / utilityComplete. Their failures must reach onError
  // just like agentic-loop failures, so consumers can detect auth problems.
  // -----------------------------------------------------------------------

  const ANTHROPIC_MODEL = {
    provider: 'anthropic',
    name: 'claude-sonnet-4-20250514',
    id: 'claude-sonnet-4-20250514',
    api: 'anthropic',
    contextWindow: 200_000,
  };

  it('emits an authentication onError and rethrows when a direct completion fails with an auth error', async () => {
    mockGetModel.mockReturnValue(ANTHROPIC_MODEL);
    mockComplete.mockRejectedValue(new Error('Request failed with status code 401'));

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await AgentLoop.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    const errors: Array<{ category: string; severity: string; originalMessage: string }> = [];
    agent.onError((e) => errors.push(e));

    await expect(
      agent.directComplete({ systemPrompt: 'System', messages: [{ role: 'user', content: 'Hello' }] }),
    ).rejects.toThrow(/401/);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.category).toBe('authentication');
    expect(errors[0]!.severity).toBe('fatal');
  });

  it('prefers the credential-resolution error as the cause when a direct completion fails', async () => {
    mockGetModel.mockReturnValue(ANTHROPIC_MODEL);
    // With no usable key, pi-ai fails generically; the credential error is more actionable.
    mockComplete.mockRejectedValue(new Error('Could not resolve API key'));

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await AgentLoop.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
      getApiKey: async () => {
        throw new Error('OAuth token refresh failed for provider anthropic');
      },
    });

    const errors: Array<{ category: string; severity: string; originalMessage: string }> = [];
    agent.onError((e) => errors.push(e));

    await expect(
      agent.directComplete({ systemPrompt: 'System', messages: [{ role: 'user', content: 'Hello' }] }),
    ).rejects.toThrow(/OAuth token refresh failed/);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.category).toBe('authentication');
    expect(errors[0]!.originalMessage).toMatch(/OAuth token refresh failed/);
  });

  it('does not surface an error when credential resolution fails but env fallback succeeds', async () => {
    mockGetModel.mockReturnValue(ANTHROPIC_MODEL);
    mockComplete.mockResolvedValue({
      content: [{ type: 'text', text: 'ok via env' }],
      usage: makeUsage(),
    });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await AgentLoop.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
      getApiKey: async () => {
        throw new Error('No credentials configured for provider anthropic');
      },
    });

    const errors: Array<{ category: string }> = [];
    agent.onError((e) => errors.push(e));

    const text = await agent.directComplete({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(text).toBe('ok via env');
    expect(errors).toHaveLength(0);
  });

  it('classifies an aborted direct completion as cancelled, not a fatal error', async () => {
    mockGetModel.mockReturnValue(ANTHROPIC_MODEL);
    mockComplete.mockResolvedValue({ stopReason: 'aborted', content: [], usage: makeUsage() });

    const providerManager = new ProviderManager();
    const model = await providerManager.resolveModel('anthropic', 'claude-sonnet-4-20250514');
    const agent = await AgentLoop.create({
      model,
      workingDirectory: '/tmp/cortex-model-contract',
      initialBasePrompt: 'Test prompt',
    });

    const errors: Array<{ category: string }> = [];
    agent.onError((e) => errors.push(e));

    await expect(
      agent.directComplete({ systemPrompt: 'System', messages: [{ role: 'user', content: 'Hello' }] }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(errors.every((e) => e.category === 'cancelled')).toBe(true);
  });
});
