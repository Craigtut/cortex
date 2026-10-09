import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig, ThinkingLevel } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import type { LoosePiEvent } from '../helpers/pi-events.js';

// ---------------------------------------------------------------------------
// Mock pi-ai module
// ---------------------------------------------------------------------------

const mockGetSupportedThinkingLevels = vi.fn();
const mockClampThinkingLevel = vi.fn();

vi.mock('@earendil-works/pi-ai', () => ({
  getSupportedThinkingLevels: (...args: unknown[]) => mockGetSupportedThinkingLevels(...args),
  clampThinkingLevel: (...args: unknown[]) => mockClampThinkingLevel(...args),
}));

// agent-loop's static catalog import now resolves from providers/all (pi-ai
// 0.80). Stub it so agent construction stays hermetic instead of hitting the
// real model catalog; the utility-model inference guards against undefined.
vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinModel: vi.fn(),
  getBuiltinModels: vi.fn(),
  // Read by wrapModel's concurrency classification, which nothing here checks.
  builtinProviders: () => [],
}));

// ---------------------------------------------------------------------------
// Mock PiAgent factory (minimal, focused on thinking level)
// ---------------------------------------------------------------------------

interface MockPiAgent extends PiAgent {
  emitEvent: (event: LoosePiEvent) => void;
}

function createMockPiAgent(): MockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;

  const agent: MockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },

    subscribe(handler: (event: PiEvent) => void): () => void {
      eventHandler = handler;
      return () => { eventHandler = null; };
    },

    emitEvent(event: LoosePiEvent): void {
      if (eventHandler) eventHandler(event as unknown as PiEvent);
    },

    async prompt(): Promise<unknown> {
      agent.emitEvent({ type: 'agent_start' });
      agent.emitEvent({ type: 'turn_start' });
      agent.emitEvent({ type: 'turn_end', text: 'Mock response' });
      agent.emitEvent({ type: 'agent_end', messages: [] });
      return { content: 'Mock response' };
    },

    abort(): void { /* no-op */ },
    async waitForIdle(): Promise<void> { /* no-op */ },
    reset(): void { agent.state.messages = []; },
    steer(): void { /* no-op */ },
  };

  return agent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
) => AgentLoop;

function createTestAgentLoop(agent: PiAgent, config: AgentLoopConfig): AgentLoop {
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  return new AgentLoopCtor(agent, config);
}

function makeModel(raw: PiModel): CortexModel {
  const rawRecord = raw as Record<string, unknown>;
  const modelId = typeof rawRecord['id'] === 'string'
    ? rawRecord['id']
    : typeof raw.name === 'string'
      ? raw.name
      : 'test-model';
  const contextWindow = typeof raw.contextWindow === 'number' ? raw.contextWindow : undefined;
  return wrapModel(raw, raw.provider, modelId, contextWindow);
}

function createDefaultConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model: makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test prompt',
    slots: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ThinkingLevel', () => {
  let piAgent: MockPiAgent;
  let agent: AgentLoop;

  beforeEach(() => {
    piAgent = createMockPiAgent();
    agent = createTestAgentLoop(piAgent, createDefaultConfig());
    vi.clearAllMocks();
    mockGetSupportedThinkingLevels.mockReturnValue([]);
    mockClampThinkingLevel.mockImplementation((_model, level) => level);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setThinkingLevel', () => {
    it('writes "max" through to agent state unmapped', () => {
      agent.setThinkingLevel('max');
      expect(piAgent.state.thinkingLevel).toBe('max');
    });

    it('writes "xhigh" through to agent state unmapped', () => {
      agent.setThinkingLevel('xhigh');
      expect(piAgent.state.thinkingLevel).toBe('xhigh');
    });

    it('passes through "high" unchanged', () => {
      agent.setThinkingLevel('high');
      expect(piAgent.state.thinkingLevel).toBe('high');
    });

    it('passes through "medium" unchanged', () => {
      agent.setThinkingLevel('medium');
      expect(piAgent.state.thinkingLevel).toBe('medium');
    });

    it('passes through "low" unchanged', () => {
      agent.setThinkingLevel('low');
      expect(piAgent.state.thinkingLevel).toBe('low');
    });

    it('passes through "minimal" unchanged', () => {
      agent.setThinkingLevel('minimal');
      expect(piAgent.state.thinkingLevel).toBe('minimal');
    });

    it('passes through "off" unchanged', () => {
      agent.setThinkingLevel('off');
      expect(piAgent.state.thinkingLevel).toBe('off');
    });
  });

  describe('getThinkingLevel', () => {
    it('returns "xhigh" when pi-agent state has "xhigh"', () => {
      // Was 'max': the old build renamed pi's xhigh on the way out, which is
      // what made the two rungs indistinguishable to callers.
      (piAgent.state as Record<string, unknown>).thinkingLevel = 'xhigh';
      expect(agent.getThinkingLevel()).toBe('xhigh');
    });

    it('falls back to "medium" for a pi level this build does not model', () => {
      (piAgent.state as Record<string, unknown>).thinkingLevel = 'ultra';
      expect(agent.getThinkingLevel()).toBe('medium');
    });

    it('returns "high" when pi-agent state has "high"', () => {
      (piAgent.state as Record<string, unknown>).thinkingLevel = 'high';
      expect(agent.getThinkingLevel()).toBe('high');
    });

    it('returns "medium" when pi-agent state has "medium"', () => {
      (piAgent.state as Record<string, unknown>).thinkingLevel = 'medium';
      expect(agent.getThinkingLevel()).toBe('medium');
    });

    it('returns "off" when pi-agent state has "off"', () => {
      (piAgent.state as Record<string, unknown>).thinkingLevel = 'off';
      expect(agent.getThinkingLevel()).toBe('off');
    });

    it('defaults to "medium" when thinkingLevel is not set', () => {
      expect(agent.getThinkingLevel()).toBe('medium');
    });

    it('defaults to "medium" when thinkingLevel is not a string', () => {
      (piAgent.state as Record<string, unknown>).thinkingLevel = 42;
      expect(agent.getThinkingLevel()).toBe('medium');
    });
  });

  describe('round-trip mapping', () => {
    const levels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

    for (const level of levels) {
      it(`round-trips "${level}" through set and get`, () => {
        agent.setThinkingLevel(level);
        expect(agent.getThinkingLevel()).toBe(level);
      });
    }
  });

  describe('getModelThinkingCapabilities', () => {
    it('returns supportsThinking: false for non-reasoning models', async () => {
      const model = { provider: 'anthropic', name: 'claude-haiku', reasoning: false } as PiModel;
      const cortexModel = makeModel(model);
      const testAgent = createTestAgentLoop(piAgent, createDefaultConfig({ model: cortexModel }));

      const caps = await testAgent.getModelThinkingCapabilities();
      expect(caps).toEqual({ supportsThinking: false, supportsMax: false, supportedLevels: [] });
      expect(mockGetSupportedThinkingLevels).toHaveBeenCalled();
    });

    it('reports xhigh as xhigh, not as max', async () => {
      // The old build folded xhigh into max. On a model that exposes BOTH,
      // that collapse made the ceiling unreachable: asking for Cortex "max"
      // sent "xhigh" and the real max was never requestable.
      const model = { provider: 'anthropic', name: 'claude-opus-4-6', id: 'claude-opus-4-6', reasoning: true } as PiModel;
      const cortexModel = makeModel(model);
      const testAgent = createTestAgentLoop(piAgent, createDefaultConfig({ model: cortexModel }));
      mockGetSupportedThinkingLevels.mockReturnValue(['off', 'medium', 'high', 'xhigh']);

      const caps = await testAgent.getModelThinkingCapabilities();
      expect(caps).toEqual({
        supportsThinking: true,
        supportsMax: false,
        supportedLevels: ['off', 'medium', 'high', 'xhigh'],
      });
      expect(mockGetSupportedThinkingLevels).toHaveBeenCalled();
    });

    it('reports both rungs when a model exposes xhigh and max', async () => {
      const model = { provider: 'anthropic', name: 'claude-opus-4-8', id: 'claude-opus-4-8', reasoning: true } as PiModel;
      const cortexModel = makeModel(model);
      const testAgent = createTestAgentLoop(piAgent, createDefaultConfig({ model: cortexModel }));
      mockGetSupportedThinkingLevels.mockReturnValue(['off', 'high', 'xhigh', 'max']);

      const caps = await testAgent.getModelThinkingCapabilities();
      expect(caps.supportedLevels).toEqual(['off', 'high', 'xhigh', 'max']);
      expect(caps.supportsMax).toBe(true);
    });

    it('returns supportsMax: false for standard reasoning models', async () => {
      const model = { provider: 'anthropic', name: 'claude-sonnet-4-6', id: 'claude-sonnet-4-6', reasoning: true } as PiModel;
      const cortexModel = makeModel(model);
      const testAgent = createTestAgentLoop(piAgent, createDefaultConfig({ model: cortexModel }));
      mockGetSupportedThinkingLevels.mockReturnValue(['medium', 'high']);

      const caps = await testAgent.getModelThinkingCapabilities();
      expect(caps).toEqual({
        supportsThinking: true,
        supportsMax: false,
        supportedLevels: ['medium', 'high'],
      });
    });

    it('clamps down to the model ceiling without consulting pi', async () => {
      // pi's own clamp ranks by position in ITS global ladder, so a level the
      // installed pi does not know is unrecognized rather than "too high":
      // pi 0.80.3 answers clamp("max") with "off". Cortex's vocabulary can
      // legitimately run ahead of the installed pi, so clamping is done here
      // against the model's advertised list instead.
      mockGetSupportedThinkingLevels.mockReturnValue(['off', 'medium', 'high', 'xhigh']);

      const clamped = await agent.clampThinkingLevel('max');

      expect(clamped).toBe('xhigh');
      expect(mockClampThinkingLevel).not.toHaveBeenCalled();
    });

    it('never silently clamps a top request to off', async () => {
      // The specific pi footgun this replaces: 'max' -> 'off' turns a request
      // for the most thinking into none at all.
      mockGetSupportedThinkingLevels.mockReturnValue(['off', 'minimal', 'low']);

      expect(await agent.clampThinkingLevel('max')).toBe('low');
    });

    it('passes a supported level through untouched', async () => {
      mockGetSupportedThinkingLevels.mockReturnValue(['off', 'medium', 'high', 'xhigh']);

      expect(await agent.clampThinkingLevel('high')).toBe('high');
    });

    it('clamps up to the weakest level when the request is below the floor', async () => {
      mockGetSupportedThinkingLevels.mockReturnValue(['high', 'xhigh']);

      expect(await agent.clampThinkingLevel('minimal')).toBe('high');
    });
  });
});
