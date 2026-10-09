import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import { DEFAULT_TOOL_THRESHOLDS, MAX_RESULT_TOKENS } from '../../src/tool-result-persistence.js';
import { fromPiAgentTool } from '../../src/tool-contract.js';
import type { CortexTool } from '../../src/tool-contract.js';
import { TOOL_NAMES } from '../../src/tools/index.js';
import { partsOf } from './agent-loop/parts.js';
import { backgroundTaskState } from '../../src/agent-loop/background-task-text.js';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript';
import type { LoosePiEvent } from '../helpers/pi-events.js';

// ---------------------------------------------------------------------------
// Mock PiAgent factory
// ---------------------------------------------------------------------------

interface MockPiAgent extends PiAgent {
  /** Manually emit a pi-agent-core event */
  emitEvent: (event: LoosePiEvent) => void;
  /** Track whether abort was called */
  abortCalled: boolean;
  /** Track whether reset was called */
  resetCalled: boolean;
  /** Control what agent.prompt() returns or throws */
  promptResult: unknown;
  promptError: Error | null;
}

function createMockPiAgent(options?: {
  runResult?: unknown;
  runError?: Error | null;
}): MockPiAgent {
  let eventHandler: ((event: PiEvent) => void) | null = null;
  let idleResolve: (() => void) | null = null;
  // Mirrors pi-agent-core: waitForIdle() resolves immediately when no run is
  // active, and only pends (until the run finishes or aborts) while one is.
  let running = false;

  const agent: MockPiAgent = {
    state: {
      messages: [],
      systemPrompt: '',
      tools: [],
    },
    abortCalled: false,
    resetCalled: false,
    promptResult: options?.runResult ?? { content: 'Mock response' },
    promptError: options?.runError ?? null,

    subscribe(handler: (event: PiEvent) => void): () => void {
      eventHandler = handler;
      return () => {
        eventHandler = null;
      };
    },

    emitEvent(event: LoosePiEvent): void {
      if (eventHandler) {
        eventHandler(event as unknown as PiEvent);
      }
    },

    async prompt(input: string): Promise<unknown> {
      running = true;
      try {
        // Emit agent_start
        agent.emitEvent({ type: 'agent_start' });

        // Mirrors pi-agent-core: the prompt message is pushed into
        // state.messages at run start, BEFORE any model call, so it is in
        // the transcript even when the run fails immediately after.
        agent.state.messages.push({ role: 'user', content: input } as never);

        if (agent.promptError) {
          // pi appends a synthetic assistant failure stub for a failed run.
          agent.state.messages.push({
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: agent.promptError.message,
          } as never);
          // Emit agent_end before throwing
          agent.emitEvent({ type: 'agent_end', messages: [] });
          throw agent.promptError;
        }

        // Simulate a turn
        agent.emitEvent({ type: 'turn_start' });
        const responseText = typeof agent.promptResult === 'string'
          ? agent.promptResult
          : 'Mock response text';
        agent.emitEvent({ type: 'turn_end', text: responseText });
        agent.state.messages.push({
          role: 'assistant',
          content: responseText,
          stopReason: 'end_turn',
        } as never);

        // Emit agent_end
        agent.emitEvent({ type: 'agent_end', messages: [] });

        return agent.promptResult;
      } finally {
        running = false;
        idleResolve?.();
        idleResolve = null;
      }
    },

    abort(): void {
      agent.abortCalled = true;
      if (idleResolve) {
        idleResolve();
        idleResolve = null;
      }
    },

    async waitForIdle(): Promise<void> {
      // Resolve immediately when idle (matches pi's activeRun == null path).
      if (!running) return;
      return new Promise<void>((resolve) => {
        idleResolve = resolve;
      });
    },

    reset(): void {
      agent.resetCalled = true;
      agent.state.messages = [];
    },
  };

  return agent;
}

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: CortexTool[],
  options?: {
    enableSubAgentTool?: boolean;
    enableLoadSkillTool?: boolean;
  },
) => AgentLoop;

function createTestAgentLoop(
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: CortexTool[],
  options?: {
    enableSubAgentTool?: boolean;
    enableLoadSkillTool?: boolean;
  },
): AgentLoop {
  const AgentLoopCtor = AgentLoop as unknown as TestAgentLoopConstructor;
  return new AgentLoopCtor(agent, config, tools, options);
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

function normalizeModel(model: PiModel | CortexModel): CortexModel {
  const asRecord = model as Record<string, unknown>;
  return asRecord['__brand'] === 'CortexModel'
    ? model as CortexModel
    : makeModel(model as PiModel);
}

function createDefaultConfig(
  overrides?: Partial<AgentLoopConfig> & {
    model?: PiModel | CortexModel;
    utilityModel?: PiModel | CortexModel | 'default';
  },
): AgentLoopConfig {
  const { model, utilityModel, ...rest } = overrides ?? {};
  return {
    model: model
      ? normalizeModel(model)
      : makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test base prompt',
    slots: [],
    ...(utilityModel !== undefined
      ? {
          utilityModel: utilityModel === 'default'
            ? 'default'
            : normalizeModel(utilityModel),
        }
      : {}),
    ...rest,
  };
}

describe('AgentLoop', () => {
  let piAgent: MockPiAgent;
  let config: ReturnType<typeof createDefaultConfig>;

  beforeEach(() => {
    piAgent = createMockPiAgent();
    config = createDefaultConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe('construction', () => {
    it('creates with valid config', () => {
      const agent = createTestAgentLoop(piAgent, config);
      expect(agent.state).toBe('created');
    });

    it('exposes the context manager', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        slots: ['a', 'b'],
        compaction: { strategy: 'classic' },
      });

      const cm = agent.getContextManager();
      expect(cm.slotCount).toBe(2);
    });

    it('infers utility model dynamically for anthropic', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const utilityModel = agent.getUtilityModel();
      expect(utilityModel.provider).toBe('anthropic');
      expect(utilityModel.modelId).toBe('claude-haiku-5-5');
    });

    it('infers utility model dynamically for openai', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        model: makeModel({ provider: 'openai', name: 'gpt-4o' } as PiModel),
      });
      const utilityModel = agent.getUtilityModel();
      expect(utilityModel.provider).toBe('openai');
      expect(utilityModel.modelId).toBe('gpt-5.4-nano');
    });

    it('uses primary model when no default mapping exists', () => {
      const customModel = makeModel({ provider: 'custom-provider', name: 'custom-model' } as PiModel);
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        model: customModel,
      });
      const utilityModel = agent.getUtilityModel();
      expect(utilityModel).toBe(customModel);
    });

    it('uses explicit utility model when provided', () => {
      const explicitUtility = makeModel({ provider: 'anthropic', name: 'claude-haiku-3' } as PiModel);
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        utilityModel: explicitUtility,
      });
      const utilityModel = agent.getUtilityModel();
      expect(utilityModel).toBe(explicitUtility);
    });

    it('throws on same-provider constraint violation', () => {
      expect(() => {
        createTestAgentLoop(piAgent, {
          ...config,
          model: makeModel({ provider: 'anthropic', name: 'claude-sonnet' } as PiModel),
          utilityModel: makeModel({ provider: 'openai', name: 'gpt-4o-mini' } as PiModel),
        });
      }).toThrow('does not match primary model provider');
    });

    it('allows utilityModel: "default" explicitly', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        utilityModel: 'default',
      });
      const utilityModel = agent.getUtilityModel();
      expect(utilityModel.provider).toBe('anthropic');
    });
  });

  // -----------------------------------------------------------------------
  // getAutoResolvedUtilityModel (pure peek for UI labelling)
  // -----------------------------------------------------------------------

  describe('getAutoResolvedUtilityModel', () => {
    it('returns the inferred utility model for an enumerable provider', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const auto = agent.getAutoResolvedUtilityModel();
      expect(auto.provider).toBe('anthropic');
      expect(auto.modelId).toBe('claude-haiku-5-5');
    });

    it('returns the primary model for providers Cortex cannot enumerate (Ollama/custom)', () => {
      // Ollama and custom OpenAI-compatible endpoints surface as a provider
      // with no pi-ai registry, so auto-resolution falls back to the primary.
      const customModel = makeModel({ provider: 'custom', name: 'llama3.3:70b' } as PiModel);
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        model: customModel,
      });
      expect(agent.getAutoResolvedUtilityModel()).toBe(customModel);
    });

    it('reflects auto-resolution even while a manual override is active, without clearing it', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const override = makeModel({ provider: 'anthropic', name: 'claude-haiku-3' } as PiModel);
      agent.setUtilityModel(override);

      // The active utility model is the override...
      expect(agent.getUtilityModel()).toBe(override);
      expect(agent.isUtilityModelOverridden()).toBe(true);

      // ...but the peek still reports what Auto would resolve to, and does not
      // mutate the override state.
      const auto = agent.getAutoResolvedUtilityModel();
      expect(auto.modelId).toBe('claude-haiku-5-5');
      expect(agent.getUtilityModel()).toBe(override);
      expect(agent.isUtilityModelOverridden()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // envOverrides
  // -----------------------------------------------------------------------

  describe('envOverrides', () => {
    it('stores envOverrides from config', () => {
      const overrides = {
        DYLD_INSERT_LIBRARIES: '/app/dock.dylib',
        ANIMUS_DOCK_SUPPRESS_ADDON: '/app/addon.node',
      };
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        envOverrides: overrides,
      });

      expect(agent.getEnvOverrides()).toBe(overrides);
    });

    it('returns undefined when no envOverrides configured', () => {
      const agent = createTestAgentLoop(piAgent, config);
      expect(agent.getEnvOverrides()).toBeUndefined();
    });

    it('passes envOverrides to McpClientManager', () => {
      const overrides = { DYLD_INSERT_LIBRARIES: '/app/dock.dylib' };
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        envOverrides: overrides,
      });

      const mcpManager = agent.getMcpClientManager();
      expect(mcpManager.envOverrides).toBe(overrides);
    });

    it('does not set McpClientManager envOverrides when not configured', () => {
      const agent = createTestAgentLoop(piAgent, config);

      const mcpManager = agent.getMcpClientManager();
      expect(mcpManager.envOverrides).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // prompt()
  // -----------------------------------------------------------------------

  describe('prompt', () => {
    it('runs the agent and returns a result', async () => {
      piAgent.promptResult = { content: 'Hello world' };
      const agent = createTestAgentLoop(piAgent, config);

      const result = await agent.prompt('Say hello');
      expect(result).toEqual({ content: 'Hello world' });
    });

    it('transitions from CREATED to ACTIVE on first prompt', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      expect(agent.state).toBe('created');

      await agent.prompt('Hello');
      expect(agent.state).toBe('active');
    });

    it('remains ACTIVE on subsequent prompts', async () => {
      const agent = createTestAgentLoop(piAgent, config);

      await agent.prompt('First');
      expect(agent.state).toBe('active');

      await agent.prompt('Second');
      expect(agent.state).toBe('active');
    });

    it('throws when destroyed', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      await agent.destroy();

      await expect(agent.prompt('Hello')).rejects.toThrow('Agent has been destroyed');
    });

    it('classifies and emits errors on failure', async () => {
      piAgent.promptError = new Error('invalid api key');
      const agent = createTestAgentLoop(piAgent, config);

      const errorHandler = vi.fn();
      agent.onError(errorHandler);

      await expect(agent.prompt('Hello')).rejects.toThrow('invalid api key');

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'authentication',
          severity: 'fatal',
          originalMessage: 'invalid api key',
        }),
        { loopPath: 'main' },
      );
    });

    it('classifies rate limit errors', async () => {
      piAgent.promptError = new Error('Rate limit exceeded');
      // Retry disabled: the mock leaves a resumable transcript, so a
      // retryable category would otherwise schedule a real backoff wait.
      const agent = createTestAgentLoop(piAgent, { ...config, retryPolicy: { enabled: false } });

      const errorHandler = vi.fn();
      agent.onError(errorHandler);

      await expect(agent.prompt('Hello')).rejects.toThrow();

      expect(errorHandler.mock.calls[0][0].category).toBe('rate_limit');
    });

    it('classifies network errors', async () => {
      piAgent.promptError = new Error('ECONNREFUSED');
      const agent = createTestAgentLoop(piAgent, { ...config, retryPolicy: { enabled: false } });

      const errorHandler = vi.fn();
      agent.onError(errorHandler);

      await expect(agent.prompt('Hello')).rejects.toThrow();

      expect(errorHandler.mock.calls[0][0].category).toBe('network');
    });

    it('swallows error handler exceptions', async () => {
      piAgent.promptError = new Error('Rate limit exceeded');
      const agent = createTestAgentLoop(piAgent, { ...config, retryPolicy: { enabled: false } });

      agent.onError(() => {
        throw new Error('Handler blew up');
      });

      // Should still throw the original error, not the handler error
      await expect(agent.prompt('Hello')).rejects.toThrow('Rate limit exceeded');
    });

    it('emits prompt watchdog lifecycle logs when diagnostics are enabled', async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        logger,
        diagnostics: {
          promptWatchdog: {
            enabled: true,
            heartbeatIntervalMs: 1000,
          },
        },
      });

      await agent.prompt('Hello');

      expect(logger.info).toHaveBeenCalledWith(
        '[AgentLoop:main] [Diagnostics] prompt_started',
        expect.objectContaining({
          inputLength: 5,
          provider: 'anthropic',
          loopPath: 'main',
        }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        '[AgentLoop:main] [Diagnostics] prompt_finished',
        expect.objectContaining({
          status: 'resolved',
        }),
      );
    });

    it('emits abort watchdog logs when diagnostics are enabled', async () => {
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        logger,
        diagnostics: {
          promptWatchdog: {
            enabled: true,
            abortWaitWarningMs: 1000,
          },
        },
      });

      await agent.abort();

      expect(logger.info).toHaveBeenCalledWith(
        '[AgentLoop:main] [Diagnostics] abort_requested',
        expect.objectContaining({
          isPrompting: false,
          loopPath: 'main',
        }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        '[AgentLoop:main] [Diagnostics] abort_wait_finished',
        expect.objectContaining({
          elapsedMs: expect.any(Number),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // System prompt
  // -----------------------------------------------------------------------

  describe('composeSystemPrompt', () => {
    it('puts consumer content first', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const prompt = agent.composeSystemPrompt('You are a helpful assistant.');

      expect(prompt.startsWith('You are a helpful assistant.')).toBe(true);
    });

    it('omits Response Delivery and every working-tags instruction by default', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const prompt = agent.composeSystemPrompt('Consumer content');

      expect(agent.isWorkingTagsEnabled).toBe(false);
      expect(prompt).toContain('# Tool Usage');
      expect(prompt).not.toContain('# Response Delivery');
      expect(prompt).not.toContain('<working>');
    });

    it('includes Response Delivery when working tags are enabled', () => {
      const agent = createTestAgentLoop(piAgent, { ...config, workingTags: { enabled: true } });
      const prompt = agent.composeSystemPrompt('Consumer content');

      expect(prompt).toContain('# Response Delivery');
      expect(prompt).toContain('<working>');
    });

    it('omits Response Delivery when working tags disabled', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        workingTags: { enabled: false },
      });
      const prompt = agent.composeSystemPrompt('Consumer content');

      expect(prompt).not.toContain('# Response Delivery');
    });

    it('never mentions working tags anywhere when they are disabled', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        workingTags: { enabled: false },
      });
      const prompt = agent.composeSystemPrompt('Consumer content');

      // A disabled tag that the prompt still asks for is worse than no tag
      // at all: nothing parses or strips it, so the delimiter and the
      // reasoning inside it reach the consumer verbatim.
      expect(prompt).not.toContain('<working>');
      expect(prompt).not.toContain('</working>');
    });

    it('keeps the shared Tool Usage rules in both working-tag modes', () => {
      const tagged = createTestAgentLoop(piAgent, config)
        .composeSystemPrompt('Consumer');
      const untagged = createTestAgentLoop(piAgent, {
        ...config,
        workingTags: { enabled: false },
      }).composeSystemPrompt('Consumer');

      for (const prompt of [tagged, untagged]) {
        expect(prompt).toContain('# Tool Usage');
        expect(prompt).toContain('## IMPORTANT: Text output during tool use');
        expect(prompt).toContain('When calling a tool, produce ONLY the tool call.');
      }
    });

    it('tells the model to withhold its analysis when working tags are disabled', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        workingTags: { enabled: false },
      });
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).toContain('keep your analysis to yourself');
    });

    it('swaps the Tool Usage variant when working tags are toggled at runtime', () => {
      const agent = createTestAgentLoop(piAgent, { ...config, workingTags: { enabled: true } });
      agent.setBasePrompt('Consumer');
      expect(agent.getCurrentSystemPrompt()).toContain('<working>');

      agent.setWorkingTagsEnabled(false);
      expect(agent.getCurrentSystemPrompt()).not.toContain('<working>');
      expect(agent.getCurrentSystemPrompt()).toContain('keep your analysis to yourself');

      agent.setWorkingTagsEnabled(true);
      expect(agent.getCurrentSystemPrompt()).toContain('<working>');
      expect(agent.getCurrentSystemPrompt()).not.toContain('keep your analysis to yourself');
    });

    it('reports the matching Tool Usage variant in getSystemPromptSections', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        workingTags: { enabled: false },
      });
      const sections = agent.getSystemPromptSections();
      const toolUsage = sections.find(s => s.name === 'Tool Usage');

      expect(sections.some(s => s.name === 'Response Delivery')).toBe(false);
      expect(toolUsage?.content).not.toContain('<working>');
    });

    it('includes System Rules section', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).toContain('# System Rules');
    });

    it('includes Taking Action section', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).toContain('# Taking Action');
    });

    it('includes Tool Usage section', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).toContain('# Tool Usage');
    });

    it('includes Executing with Care section', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).toContain('# Executing with Care');
    });

    // Tool-aware sections: a prompt naming an absent tool is an instruction
    // to hallucinate it (the duplex talker followed "use Glob" straight into
    // an unknown-tool error narrated to the user).

    it('omits Tool Usage and Executing with Care when every built-in tool is disabled', () => {
      const agent = createTestAgentLoop(
        piAgent,
        { ...config, disableTools: Object.values(TOOL_NAMES) },
        undefined,
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).not.toContain('# Tool Usage');
      expect(prompt).not.toContain('# Executing with Care');
      expect(prompt).not.toContain('use Glob');
      expect(prompt).not.toContain('use Bash');
      expect(prompt).not.toContain('[tool_use:');
      // Section names disappear from the inspector surface too.
      const names = agent.getSystemPromptSections().map(s => s.name);
      expect(names).not.toContain('Tool Usage');
      expect(names).not.toContain('Executing with Care');
    });

    it('drops file-handling guidance when the loop cannot mutate files', () => {
      const agent = createTestAgentLoop(
        piAgent,
        { ...config, disableTools: Object.values(TOOL_NAMES) },
        undefined,
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).toContain('# Taking Action');
      expect(prompt).not.toContain('Do not create files unless necessary');
      expect(prompt).not.toContain('Do not modify files you haven\'t read');
    });

    it('names only registered tools in the Tool Usage bullets', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        disableTools: [TOOL_NAMES.Glob, TOOL_NAMES.WebFetch],
      });
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).toContain('# Tool Usage');
      expect(prompt).toContain('To read files: use Read');
      expect(prompt).not.toContain('To find files by name: use Glob');
      expect(prompt).not.toContain('To fetch web content: use WebFetch');
    });

    it('drops the Bash redirection list when Bash is disabled', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        disableTools: [TOOL_NAMES.Bash],
      });
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).toContain('# Tool Usage');
      expect(prompt).not.toContain('Do NOT use Bash');
    });

    it('drops the same-file serialization bullet when Edit and Write are disabled', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        disableTools: [TOOL_NAMES.Edit, TOOL_NAMES.Write, TOOL_NAMES.UndoEdit],
      });
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).not.toContain('Multiple Edit or Write calls');
      // Still capable of file mutation elsewhere? No: file bullets go too.
      expect(prompt).not.toContain('Do not create files unless necessary');
    });

    it('includes Environment section with platform info', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).toContain('# Environment');
      expect(prompt).toContain('Platform:');
      expect(prompt).toContain('Shell:');
      expect(prompt).toContain('Working Directory: /tmp/test-workspace');
    });

    it('preserves consumer content exactly', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const consumerContent = `You are Animus.
Your personality is warm and curious.
You have 12 emotions.`;
      const prompt = agent.composeSystemPrompt(consumerContent);

      expect(prompt.startsWith(consumerContent)).toBe(true);
    });

    it('does not mutate the live system prompt', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const prompt = agent.composeSystemPrompt('Consumer');

      expect(prompt).toContain('Consumer');
      expect(agent.getCurrentSystemPrompt()).toContain('Test base prompt');
      expect(agent.getCurrentSystemPrompt()).not.toContain('Consumer');
    });
  });

  describe('setBasePrompt', () => {
    it('updates the live system prompt and tracks the base prompt', () => {
      const agent = createTestAgentLoop(piAgent, config);

      const prompt = agent.setBasePrompt('Base prompt');

      expect(prompt).toContain('Base prompt');
      expect(agent.getBasePrompt()).toBe('Base prompt');
      expect(agent.getCurrentSystemPrompt()).toContain('Base prompt');

      // pi reads the prompt from the transcript, where the loop writes it
      // before each request (pi's prepareRequest).
      expect(getCurrentSystemPrompt(piAgent.state.messages)).not.toContain('Base prompt');
      partsOf(agent).systemPrompt.syncTranscript(piAgent.state.messages);
      expect(getCurrentSystemPrompt(piAgent.state.messages)).toBe(agent.getCurrentSystemPrompt());
    });
  });

  describe('setBasePrompt with existing history', () => {
    it('updates the system prompt without losing conversation history', async () => {
      const agent = createTestAgentLoop(piAgent, config);

      // Build initial prompt
      agent.setBasePrompt('Original persona');

      // Simulate some conversation history
      piAgent.state.messages.push(
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      );

      // Rebuild with new content
      agent.setBasePrompt('Updated persona');

      // Conversation should still be there
      const history = agent.getConversationHistory();
      expect(history.length).toBe(2);
      expect(history[0]!.content).toBe('Hello');

      // New prompt should contain updated content
      const currentPrompt = agent.getCurrentSystemPrompt();
      expect(currentPrompt).toContain('Updated persona');
      expect(currentPrompt).not.toContain('Original persona');
    });
  });

  // -----------------------------------------------------------------------
  // Conversation history persistence
  // -----------------------------------------------------------------------

  describe('conversation history', () => {
    it('getConversationHistory excludes slot region', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        slots: ['slot1', 'slot2'],
      });

      const cm = agent.getContextManager();
      cm.setSlot('slot1', 'Slot content 1');
      cm.setSlot('slot2', 'Slot content 2');

      // Simulate conversation history after slots
      piAgent.state.messages.push(
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi!' },
      );

      const history = agent.getConversationHistory();

      expect(history.length).toBe(2);
      expect(history[0]!.content).toBe('Hello');
      expect(history[1]!.content).toBe('Hi!');
    });

    it('getConversationHistory returns empty when only slots exist', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        slots: ['slot1'],
      });

      const cm = agent.getContextManager();
      cm.setSlot('slot1', 'Content');

      const history = agent.getConversationHistory();
      expect(history.length).toBe(0);
    });

    it('restoreConversationHistory injects after slots', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        slots: ['slot1', 'slot2'],
        compaction: { strategy: 'classic' },
      });

      const cm = agent.getContextManager();
      cm.setSlot('slot1', 'Slot 1');
      cm.setSlot('slot2', 'Slot 2');

      // Restore some saved conversation
      agent.restoreConversationHistory([
        { role: 'user', content: 'Restored message 1' },
        { role: 'assistant', content: 'Restored response 1' },
        { role: 'user', content: 'Restored message 2' },
      ]);

      // The head and slots should be intact
      expect(piAgent.state.messages[0]!.role).toBe('system');
      expect(piAgent.state.messages[1]!.content).toBe('Slot 1');
      expect(piAgent.state.messages[2]!.content).toBe('Slot 2');

      // Conversation should be after slots
      expect(piAgent.state.messages[3]!.content).toBe('Restored message 1');
      expect(piAgent.state.messages[4]!.content).toBe('Restored response 1');
      expect(piAgent.state.messages[5]!.content).toBe('Restored message 2');
    });

    it('restoreConversationHistory replaces existing conversation', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        slots: ['slot1'],
      });

      const cm = agent.getContextManager();
      cm.setSlot('slot1', 'Slot content');

      // Add some existing conversation
      piAgent.state.messages.push(
        { role: 'user', content: 'Old message' },
      );

      // Restore should replace
      agent.restoreConversationHistory([
        { role: 'user', content: 'New message' },
      ]);

      const history = agent.getConversationHistory();
      expect(history.length).toBe(1);
      expect(history[0]!.content).toBe('New message');
    });
  });

  // -----------------------------------------------------------------------
  // Observational memory restore
  // -----------------------------------------------------------------------

  describe('restoreObservationalMemoryState slot population', () => {
    it('leaves the observation slot empty when restored observations are empty', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        compaction: { strategy: 'observational' },
      });
      const cm = agent.getContextManager();

      agent.restoreObservationalMemoryState({
        observations: '',
        continuationHint: null,
        observationTokenCount: 0,
        generationCount: 0,
        bufferedChunks: [],
        bufferWatermark: 0,
      });

      // A resumed-but-never-observed session must look like a fresh one: no
      // observation preamble injected around an empty <observations> block.
      expect(cm.getSlot('_observations')).toBe('');
    });

    it('populates the observation slot when restored observations are present', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        compaction: { strategy: 'observational' },
      });
      const cm = agent.getContextManager();

      agent.restoreObservationalMemoryState({
        observations: 'User prefers TypeScript.',
        continuationHint: null,
        observationTokenCount: 6,
        generationCount: 1,
        bufferedChunks: [],
        bufferWatermark: 0,
      });

      expect(cm.getSlot('_observations')).toContain('User prefers TypeScript.');
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe('lifecycle', () => {
    it('starts in CREATED state', () => {
      const agent = createTestAgentLoop(piAgent, config);
      expect(agent.state).toBe('created');
    });

    it('transitions to ACTIVE after first prompt', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      await agent.prompt('Hello');
      expect(agent.state).toBe('active');
    });

    it('transitions to DESTROYED after destroy', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      await agent.destroy();
      expect(agent.state).toBe('destroyed');
    });

    it('destroy is idempotent', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      await agent.destroy();
      await agent.destroy(); // Should not throw
      expect(agent.state).toBe('destroyed');
    });

    it('abort calls agent.abort() and waitForIdle()', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      await agent.prompt('Hello');

      await agent.abort();

      expect(piAgent.abortCalled).toBe(true);
    });

    it('abort keeps the agent in ACTIVE state', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      await agent.prompt('Hello');

      await agent.abort();

      expect(agent.state).toBe('active');
    });

    it('prompt() issued right after abort() resolves does not fail fast on a stale gate', async () => {
      const agent = createTestAgentLoop(piAgent, config);

      // Hold a turn open; release it when abort() reaches pi (as a real
      // abort would settle the in-flight run).
      let release!: () => void;
      const originalPrompt = piAgent.prompt.bind(piAgent);
      const calls: string[] = [];
      piAgent.prompt = async (input: string): Promise<unknown> => {
        calls.push(input);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return originalPrompt(input);
      };
      const originalAbort = piAgent.abort.bind(piAgent);
      piAgent.abort = (): void => {
        originalAbort();
        release();
      };

      const first = agent.prompt('one');
      await new Promise((resolve) => setImmediate(resolve));

      await agent.abort();
      await first;

      // The gate has fully released the aborted cycle by the time abort()
      // resolves, so a follow-up prompt starts a fresh, non-cancelled turn.
      await expect(agent.prompt('two')).resolves.toBeDefined();
      expect(calls).toEqual(['one', 'two']);
    });

    it('does not add an exit listener per agent instance', async () => {
      const before = process.listenerCount('exit');

      const first = createTestAgentLoop(createMockPiAgent(), config);
      const second = createTestAgentLoop(createMockPiAgent(), config);
      const third = createTestAgentLoop(createMockPiAgent(), config);

      const after = process.listenerCount('exit');
      expect(after - before).toBeLessThanOrEqual(1);

      await first.destroy();
      await second.destroy();
      await third.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  describe('events', () => {
    it('onLoopComplete fires on loop_end (agent_end)', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const handler = vi.fn();
      agent.onLoopComplete(handler);

      await agent.prompt('Hello');

      // agent.run() emits agent_end which maps to loop_end -> onLoopComplete
      expect(handler).toHaveBeenCalled();
    });

    it('suppresses onLoopComplete for a run that ended in error (retry may follow)', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const handler = vi.fn();
      agent.onLoopComplete(handler);

      // pi-agent-core emits agent_end even when a run fails, leaving the failure
      // in state.errorMessage. With background retry that agent_end belongs to an
      // intermediate attempt, not the logical turn boundary, so onLoopComplete
      // must NOT fire (firing it would let a consumer mark the turn idle while a
      // retry is still pending, desyncing its run-state).
      piAgent.state.errorMessage = 'Connection error.';
      piAgent.emitEvent({ type: 'agent_end', messages: [] });
      expect(handler).not.toHaveBeenCalled();

      // The run that finally succeeds clears errorMessage; onLoopComplete fires once.
      piAgent.state.errorMessage = undefined;
      piAgent.emitEvent({ type: 'agent_end', messages: [] });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('isRunning is true only while a turn is in flight', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      expect(agent.isRunning).toBe(false);
      let during: boolean | undefined;
      agent.onTurnComplete(() => {
        during = agent.isRunning;
      });

      await agent.prompt('Hello');

      expect(during).toBe(true);
      expect(agent.isRunning).toBe(false);
    });

    it('onTurnComplete fires with AgentTextOutput', async () => {
      piAgent.promptResult = 'Hello <working>internal</working> world';
      const agent = createTestAgentLoop(piAgent, config);

      const handler = vi.fn();
      agent.onTurnComplete(handler);

      await agent.prompt('Hello');

      expect(handler).toHaveBeenCalled();
      const output = handler.mock.calls[0][0];
      expect(output.raw).toBe('Hello <working>internal</working> world');
    });

    it('onTurnComplete fires for array-content turns with working tags disabled', () => {
      const agent = createTestAgentLoop(piAgent, { ...config, workingTags: { enabled: false } });
      const handler = vi.fn();
      agent.onTurnComplete(handler);

      // pi-agent-core's real turn_end shape: the assistant message with its
      // content as typed parts, no top-level text.
      piAgent.emitEvent({
        type: 'turn_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
          ],
          stopReason: 'stop',
        },
        toolResults: [],
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].raw).toBe('Hello world');
    });

    it('onError fires for classified errors', async () => {
      piAgent.promptError = new Error('Rate limit exceeded');
      // Retry disabled: the mock leaves a resumable transcript, so a
      // retryable category would otherwise schedule a real backoff wait.
      const agent = createTestAgentLoop(piAgent, { ...config, retryPolicy: { enabled: false } });

      const handler = vi.fn();
      agent.onError(handler);

      await expect(agent.prompt('Hello')).rejects.toThrow();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].category).toBe('rate_limit');
    });

    it('onTurnComplete and onError carry the loop origin context', async () => {
      piAgent.promptResult = 'Hello world';
      const agent = createTestAgentLoop(piAgent, { ...config, loopPath: 'reasoner' });

      const turnHandler = vi.fn();
      agent.onTurnComplete(turnHandler);
      await agent.prompt('Hello');
      expect(turnHandler).toHaveBeenCalled();
      expect(turnHandler.mock.calls[0][1]).toEqual({ loopPath: 'reasoner' });

      piAgent.promptError = new Error('invalid api key');
      const errorHandler = vi.fn();
      agent.onError(errorHandler);
      await expect(agent.prompt('Again')).rejects.toThrow();
      expect(errorHandler.mock.calls[0][1]).toEqual({ loopPath: 'reasoner' });
    });

    it('defaults the loop identity to main and honors a configured loopPath', () => {
      const defaultAgent = createTestAgentLoop(piAgent, config);
      expect(defaultAgent.loopPath).toBe('main');

      const named = createTestAgentLoop(createMockPiAgent(), { ...config, loopPath: 'talker' });
      expect(named.loopPath).toBe('talker');
    });

    it('prefixes log lines with the loop identity', async () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const agent = createTestAgentLoop(piAgent, { ...config, logger, loopPath: 'reasoner' });

      await agent.prompt('Hello');

      expect(logger.debug).toHaveBeenCalledWith(
        '[AgentLoop:reasoner] loop start',
        expect.any(Object),
      );
    });

    it('multiple handlers can be registered for the same event', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      agent.onLoopComplete(handler1);
      agent.onLoopComplete(handler2);

      await agent.prompt('Hello');

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('auto-wires current-context token tracking from turn_end usage data', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        model: makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel),
      });

      expect(agent.currentContextTokenCount).toBe(0);

      // Emit a turn_end event with usage data (pattern: event.usage.input)
      piAgent.emitEvent({
        type: 'turn_end',
        text: 'response text',
        usage: { input: 85_000 },
      });

      expect(agent.currentContextTokenCount).toBe(85_000);
    });

    it('auto-wires current-context token tracking from message.usage.input pattern', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        model: makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel),
      });

      piAgent.emitEvent({
        type: 'turn_end',
        message: {
          content: 'response text',
          usage: { input: 42_000 },
        },
      });

      expect(agent.currentContextTokenCount).toBe(42_000);
    });

    it('does not update token count when turn_end has no usage data', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        model: makeModel({ provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000 } as PiModel),
      });

      // Manually set a known value
      agent.updateCurrentContextTokenCount(50_000);

      // Emit a turn_end with no usage data
      piAgent.emitEvent({
        type: 'turn_end',
        text: 'response without usage',
      });

      // Should remain unchanged since no usage data was available
      expect(agent.currentContextTokenCount).toBe(50_000);
    });

    it('estimates current context tokens from the live agent snapshot', () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        slots: ['project-context'],
      });

      agent.getContextManager().setSlot('project-context', 'Project context goes here');
      agent.getContextManager().setEphemeral('Ephemeral context');

      const estimate = agent.estimateCurrentContextTokens();

      expect(estimate).toBeGreaterThan(0);
    });

    it('uses the larger of the post-hoc count and heuristic estimate', () => {
      const agent = createTestAgentLoop(piAgent, config);
      agent.updateCurrentContextTokenCount(50_000);

      expect(agent.estimateCurrentContextTokens()).toBe(50_000);
    });
  });

  // -----------------------------------------------------------------------
  // Destroy cleanup
  // -----------------------------------------------------------------------

  describe('destroy cleanup', () => {
    it('calls agent.abort() during destroy', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      await agent.destroy();

      expect(piAgent.abortCalled).toBe(true);
    });

    it('calls agent.reset() during destroy', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      await agent.destroy();

      expect(piAgent.resetCalled).toBe(true);
    });

    it('emits onLoopComplete during destroy for final checkpoint', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const handler = vi.fn();
      agent.onLoopComplete(handler);

      await agent.destroy();

      // onLoopComplete should fire once during destroy (the checkpoint emission)
      expect(handler).toHaveBeenCalled();
    });

    it('logs a checkpoint handler that throws during destroy and keeps tearing down', async () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const agent = createTestAgentLoop(piAgent, { ...config, logger });
      const later = vi.fn();
      agent.onLoopComplete(() => {
        throw new Error('checkpoint write failed');
      });
      agent.onLoopComplete(later);

      await agent.destroy();

      expect(later).toHaveBeenCalled();
      expect(agent.state).toBe('destroyed');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('onLoopComplete handler threw'),
        expect.objectContaining({ error: 'checkpoint write failed' }),
      );
    });

    it('clears handlers after destroy', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const errorHandler = vi.fn();
      agent.onError(errorHandler);

      await agent.destroy();

      // After destroy, handlers should be cleared
      // Attempting to prompt should throw "destroyed" not trigger error handlers
      await expect(agent.prompt('Hello')).rejects.toThrow('Agent has been destroyed');
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it('respects destroy timeout', async () => {
      // Create an agent where waitForIdle never resolves quickly
      const slowAgent = createMockPiAgent();
      const originalWaitForIdle = slowAgent.waitForIdle;
      slowAgent.waitForIdle = () => new Promise((resolve) => {
        setTimeout(resolve, 60000); // Very slow
      });

      const agent = createTestAgentLoop(slowAgent, config);

      // Destroy with a short timeout
      const startTime = Date.now();
      await agent.destroy(100);
      const elapsed = Date.now() - startTime;

      // Should complete within the timeout (plus some margin)
      expect(elapsed).toBeLessThan(500);
      expect(agent.state).toBe('destroyed');
    });

    it('concurrent destroy() calls share one teardown', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const resetSpy = vi.spyOn(piAgent, 'reset');

      await Promise.all([agent.destroy(), agent.destroy()]);

      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(agent.state).toBe('destroyed');
    });

    it('rejects prompt() issued while destroy is in progress', async () => {
      const agent = createTestAgentLoop(piAgent, config);

      const teardown = agent.destroy();
      expect(agent.state).toBe('destroying');
      await expect(agent.prompt('Hello')).rejects.toThrow('Agent is being destroyed');

      await teardown;
      expect(agent.state).toBe('destroyed');
    });

    it('kills a background bash process and untracks its pid on destroy', async () => {
      const isAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };

      const agent = createTestAgentLoop(
        piAgent,
        createDefaultConfig({ workingDirectory: process.cwd() }),
        [],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );
      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<{
          details: { taskId: string | null };
        }>;
      }>;
      const bashTool = allTools.find((tool) => tool.name === 'Bash');
      expect(bashTool).toBeDefined();

      const result = await bashTool!.execute('tc-bash-bg', { command: 'sleep 30', background: true });
      const taskId = result.details.taskId as string;

      const internal = partsOf(agent);
      const pid = internal.tools.runtime.backgroundTasks.get(taskId)?.process.pid;
      expect(pid).toBeGreaterThan(0);
      // The spawned shell entered PID tracking (destroy/exit safety nets).
      expect(internal.processes.pids.has(pid!)).toBe(true);
      expect(isAlive(pid!)).toBe(true);

      await agent.destroy();

      // SIGKILL delivery, reaping, and the close-event untrack are async.
      const deadline = Date.now() + 3000;
      while ((isAlive(pid!) || internal.processes.pids.has(pid!)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(isAlive(pid!)).toBe(false);
      expect(internal.processes.pids.has(pid!)).toBe(false);
    }, 10000);

    it('does not start a new loop for a background completion pending at destroy', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      internal.tools.runtime.backgroundTasks.set({
        id: 'task_d',
        command: 'sleep 1',
        process: {} as never,
        stdout: 'late result',
        stderr: '',
        exitCode: 0,
        completed: true,
        notified: false,
        startTime: Date.now() - 1000,
      });

      // Hold a turn open so the completion is queued behind a live loop.
      let release!: () => void;
      const originalPrompt = piAgent.prompt.bind(piAgent);
      const promptCalls: string[] = [];
      piAgent.prompt = async (input: string): Promise<unknown> => {
        promptCalls.push(input);
        if (promptCalls.length === 1) {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return originalPrompt(input);
      };

      const turn = agent.prompt('long turn');
      await new Promise((resolve) => setImmediate(resolve));
      const delivery = internal.background.enqueue({ kind: 'bash', taskId: 'task_d' });

      const teardown = agent.destroy();
      release();
      await turn;
      await delivery;
      await teardown;

      // The pending completion never restarted the loop mid-teardown.
      expect(promptCalls).toHaveLength(1);
      expect(internal.background.pending).toHaveLength(0);
      expect(agent.state).toBe('destroyed');
    });
  });

  // -----------------------------------------------------------------------
  // transformContext hook
  // -----------------------------------------------------------------------

  describe('transformContext', () => {
    it('returns a composable hook function', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const hook = agent.getTransformContextHook();
      expect(typeof hook).toBe('function');
    });

    it('the hook passes through context when no ephemeral content', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const hook = agent.getTransformContextHook();

      const context = {
        systemPrompt: 'test',
        model: {},
        messages: [{ role: 'user' as const, content: 'Hello' }],
        tools: [],
        thinkingLevel: 'medium',
      };

      const result = await hook(context);
      // With no ephemeral, compaction stub, and skill stub are all no-ops
      expect(result.messages.length).toBe(1);
    });

    it('the hook injects ephemeral content', async () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        slots: [],
      });

      const cm = agent.getContextManager();
      cm.setEphemeral('Ephemeral data');

      const hook = agent.getTransformContextHook();
      const historyStart = cm.historyStart;
      piAgent.state.messages.push({ role: 'user', content: 'Hello', timestamp: 1 });
      const context = {
        systemPrompt: 'test',
        model: {},
        messages: piAgent.state.messages,
        tools: [],
        thinkingLevel: 'medium',
      };

      // Injected at the boundary, which never precedes the head and slots.
      const result = await hook(context);
      expect(result.messages.length).toBe(historyStart + 2);
      expect(result.messages[0]!.role).toBe('system');
      expect(result.messages[historyStart]!.content).toBe('Ephemeral data');
      expect(result.messages[historyStart + 1]!.content).toBe('Hello');
    });

    it('persists compaction source mutations into the active transform context', async () => {
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        slots: [],
        compaction: { strategy: 'classic' },
      });

      const head = piAgent.state.messages[0]!;
      const history = [
        { role: 'user' as const, content: 'old message' },
        { role: 'assistant' as const, content: 'old response' },
      ];
      const sourceMessages = [head, ...history];
      piAgent.state.messages = [...sourceMessages];

      const summary = { role: 'assistant' as const, content: 'summary' };
      const compacted = [head, summary];
      const manager = agent.getCompactionManager();
      vi.spyOn(manager, 'applyInsertionCap').mockResolvedValue();
      vi.spyOn(manager, 'applyInTransformContext').mockImplementation(async (
        ctx,
        getHistory,
        setHistory,
        getSourceHistory,
        setSourceHistory,
      ) => {
        expect(getSourceHistory?.()).toEqual(history);
        setSourceHistory?.([summary]);
        return setHistory(ctx, [summary]);
      });

      const hook = agent.getTransformContextHook();
      const result = await hook({
        systemPrompt: 'test',
        model: {},
        messages: sourceMessages,
        tools: [],
        thinkingLevel: 'medium',
      });

      expect(sourceMessages).toEqual(compacted);
      expect(piAgent.state.messages).toEqual(compacted);
      expect(result.messages).toEqual(compacted);
    });
  });

  // -----------------------------------------------------------------------
  // Model access
  // -----------------------------------------------------------------------

  describe('model access', () => {
    it('getModel returns the primary model', () => {
      const model = makeModel({ provider: 'anthropic', name: 'claude-sonnet-4' } as PiModel);
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        model,
      });

      expect(agent.getModel()).toBe(model);
    });

    it('getUtilityModel returns resolved utility model', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const utility = agent.getUtilityModel();

      expect(utility.provider).toBe('anthropic');
      expect(utility.modelId).toBeDefined();
    });

    it('utilityComplete uses utility model for completion', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      // utilityComplete requires a real pi-ai complete() call which needs a valid model
      // Just verify the method exists and is callable
      expect(typeof agent.utilityComplete).toBe('function');
    });
  });

  // -----------------------------------------------------------------------
  // Effective context window
  // -----------------------------------------------------------------------

  describe('effective context window', () => {
    function loggerStub() {
      return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    }

    /** The warn call about an unhonored limit, if one was made. */
    function overrideWarning(logger: ReturnType<typeof loggerStub>) {
      return logger.warn.mock.calls.find(
        (call) => String(call[0]).includes('contextWindowLimit is not the value in force'),
      );
    }

    it('honors a limit the model has room for, and says nothing', () => {
      const logger = loggerStub();
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        logger,
        model: makeModel({
          provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000,
        } as PiModel),
        contextWindowLimit: 50_000,
      });

      expect(agent.effectiveContextWindow).toBe(50_000);
      expect(overrideWarning(logger)).toBeUndefined();
    });

    it.each(['anthropic', 'openai', 'google', 'custom'])('honors a small explicit budget for %s', provider => {
      const logger = loggerStub();
      const agent = createTestAgentLoop(piAgent, {
        ...config, logger,
        model: makeModel({ provider, name: 'test', contextWindow: 200_000 } as PiModel),
        contextWindowLimit: 8_192,
      });
      expect(agent.effectiveContextWindow).toBe(8_192);
      expect(agent.modelContextWindow).toBe(200_000);
      expect(overrideWarning(logger)).toBeUndefined();
      agent.setContextWindowLimit(4_096);
      expect(agent.effectiveContextWindow).toBe(4_096);
      expect(() => agent.setContextWindowLimit(0)).toThrow();
      expect(agent.contextWindowLimit).toBe(4_096);
      agent.setContextWindowLimit(null);
      expect(agent.effectiveContextWindow).toBe(200_000);
    });

    it('warns when a limit above the model window is clamped down to it', () => {
      const logger = loggerStub();
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        logger,
        model: makeModel({
          provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000,
        } as PiModel),
        contextWindowLimit: 400_000,
      });

      expect(agent.effectiveContextWindow).toBe(200_000);
      expect(String((overrideWarning(logger)![1] as { reason: string }).reason))
        .toContain("exceeds the model's own context window");
    });

    it('warns once per distinct outcome, not on every recompute', () => {
      const logger = loggerStub();
      const agent = createTestAgentLoop(piAgent, {
        ...config,
        logger,
        model: makeModel({
          provider: 'anthropic', name: 'claude-sonnet-4-20250514', contextWindow: 200_000,
        } as PiModel),
        contextWindowLimit: 400_000,
      });
      const afterConstruction = logger.warn.mock.calls.length;

      agent.setContextWindowLimit(400_000);
      agent.setContextWindowLimit(400_000);
      expect(logger.warn.mock.calls.length).toBe(afterConstruction);

      // A different outcome is a different fact, and is reported.
      agent.setContextWindowLimit(500_000);
      expect(logger.warn.mock.calls.length).toBe(afterConstruction + 1);
    });
  });

  // -----------------------------------------------------------------------
  // setModel / setThinkingLevel / refreshTools
  // -----------------------------------------------------------------------

  describe('setModel', () => {
    it('updates the primary model', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const newModel = makeModel({ provider: 'openai', name: 'gpt-4o', contextWindow: 128_000 } as PiModel);

      agent.setModel(newModel);

      expect(agent.getModel()).toBe(newModel);
    });

    it('updates agent.state.model', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const newModel = makeModel({ provider: 'openai', name: 'gpt-4o' } as PiModel);

      agent.setModel(newModel);

      expect(piAgent.state.model).toEqual(
        expect.objectContaining({ provider: 'openai', name: 'gpt-4o' }),
      );
    });

    it('does not throw when agent lacks setModel', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const newModel = makeModel({ provider: 'openai', name: 'gpt-4o' } as PiModel);

      // Should not throw even though piAgent has no setModel
      expect(() => agent.setModel(newModel)).not.toThrow();
    });
  });

  describe('setThinkingLevel', () => {
    it('updates agent.state.thinkingLevel', () => {
      const agent = createTestAgentLoop(piAgent, config);
      agent.setThinkingLevel('high');

      expect(piAgent.state.thinkingLevel).toBe('high');
    });

    it('writes max to agent state unmapped', () => {
      // Cortex level names are pi level names; the old max -> xhigh rewrite
      // made a model's real ceiling unrequestable.
      const agent = createTestAgentLoop(piAgent, config);

      agent.setThinkingLevel('max');

      expect(piAgent.state.thinkingLevel).toBe('max');
    });
  });

  describe('refreshTools', () => {
    it('updates agent.state.tools with registered + MCP tools', () => {
      const agent = createTestAgentLoop(
        piAgent,
        config,
        [], // No additional tools; built-in tools auto-register
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );

      // refreshTools merges auto-registered built-in tools with MCP tools (empty in this test)
      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{ name: string }>;
      // 9 built-in tools auto-registered: Read, Write, Edit, UndoEdit,
      // Glob, Grep, Bash, TaskOutput, WebFetch
      expect(allTools.length).toBe(9);
      const toolNames = allTools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain('Read');
      expect(toolNames).toContain('UndoEdit');
      expect(toolNames).toContain('Bash');
      expect(toolNames).toContain('Glob');
    });

    it('adapts Bash using the canonical Cortex tool contract', async () => {
      const agent = createTestAgentLoop(
        piAgent,
        createDefaultConfig({ workingDirectory: process.cwd() }),
        [],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );

      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }>;
      const bashTool = allTools.find((tool) => tool.name === 'Bash');

      expect(bashTool).toBeDefined();

      const result = await bashTool!.execute('tc-bash', { command: 'echo "adapter ok"' });
      expect(result.content[0]?.text).toContain('adapter ok');
    });

    it('persists oversized Bash output before it reaches conversation history', async () => {
      const persistResult = vi.fn().mockResolvedValue('/tmp/bash-oversized.txt');

      const agent = createTestAgentLoop(
        piAgent,
        createDefaultConfig({
          workingDirectory: process.cwd(),
          persistResult,
        }),
        [],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );

      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }>;
      const bashTool = allTools.find((tool) => tool.name === 'Bash');

      expect(bashTool).toBeDefined();

      const result = await bashTool!.execute('tc-bash-oversized', {
        command: `node -e "process.stdout.write('x'.repeat(${DEFAULT_TOOL_THRESHOLDS.Bash * 4 + 5_000}))"`,
      });
      const text = result.content[0]?.text ?? '';

      expect(persistResult).toHaveBeenCalledOnce();
      expect(persistResult).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          toolName: 'Bash',
          toolCallId: 'tc-bash-oversized',
          loopPath: 'main',
        }),
      );
      expect(text).toContain('[Result persisted: /tmp/bash-oversized.txt');
      expect(text).toContain('Use the Read tool with offset/limit');
      expect(text).toContain('tokens trimmed');

      piAgent.state.messages.push({
        role: 'tool',
        content: [{ type: 'tool_result', name: 'Bash', toolCallId: 'tc-bash-oversized', text }],
      });

      const history = agent.getConversationHistory();
      expect(history).toHaveLength(1);
      expect(((history[0]!.content as Array<{ text?: string }>)[0]?.text) ?? '').toContain(
        '[Result persisted: /tmp/bash-oversized.txt',
      );
      expect(((history[0]!.content as Array<{ text?: string }>)[0]?.text) ?? '').toContain('tokens trimmed');
    });

    it('persists oversized WebFetch output before returning from the wrapped tool', async () => {
      const persistResult = vi.fn().mockResolvedValue('/tmp/webfetch-oversized.txt');

      const agent = createTestAgentLoop(
        piAgent,
        createDefaultConfig({
          workingDirectory: process.cwd(),
          persistResult,
        }),
        [],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );
      vi.spyOn(agent, 'utilityComplete').mockResolvedValue('y'.repeat(MAX_RESULT_TOKENS * 4 + 5_000));
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        status: 200,
        headers: {
          get(name: string) {
            return name.toLowerCase() === 'content-type' ? 'text/plain' : null;
          },
        },
        text: async () => 'small page body',
      } as unknown as Response);

      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }>;
      const webFetchTool = allTools.find((tool) => tool.name === 'WebFetch');

      expect(webFetchTool).toBeDefined();

      const result = await webFetchTool!.execute('tc-webfetch-oversized', {
        url: 'https://1.1.1.1/test',
        prompt: 'Summarize the page',
      });
      const text = result.content[0]?.text ?? '';

      expect(persistResult).toHaveBeenCalledOnce();
      expect(persistResult).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          toolName: 'WebFetch',
          toolCallId: 'tc-webfetch-oversized',
        }),
      );
      expect(text).toContain('[Result persisted: /tmp/webfetch-oversized.txt');
      expect(text).toContain('Use the Read tool with offset/limit');
      expect(text).toContain('tokens trimmed');
    });

    it('supports raw pi-agent-core tools when explicitly wrapped', async () => {
      const legacyTool = fromPiAgentTool({
        name: 'LegacyTool',
        description: 'Legacy execution contract',
        parameters: {},
        execute: vi.fn(async (toolCallId: string, params: unknown) => ({
          content: [{ type: 'text', text: `${toolCallId}:${String((params as { value: string }).value)}` }],
          details: {},
        })),
      });

      const agent = createTestAgentLoop(
        piAgent,
        config,
        [legacyTool],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      );

      agent.refreshTools();

      const allTools = piAgent.state.tools as Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      }>;
      const tool = allTools.find((entry) => entry.name === 'LegacyTool');

      expect(tool).toBeDefined();

      const result = await tool!.execute('legacy-call', { value: 'ok' });
      expect(result.content[0]?.text).toBe('legacy-call:ok');
    });

    it('rejects raw pi-agent-core tools unless explicitly wrapped', () => {
      const legacyTool = {
        name: 'LegacyTool',
        description: 'Legacy execution contract',
        parameters: {},
        execute: async (
          toolCallId: string,
          params: unknown,
          _signal?: AbortSignal,
          _onUpdate?: (partialResult: unknown) => void,
        ) => ({
          content: [{ type: 'text', text: `${toolCallId}:${String(params)}` }],
          details: {},
        }),
      };

      expect(() => createTestAgentLoop(
        piAgent,
        config,
        [legacyTool as unknown as CortexTool],
        { enableSubAgentTool: false, enableLoadSkillTool: false },
      )).toThrow(/fromPiAgentTool/);
    });

    it('does not throw when agent lacks setTools', () => {
      const agent = createTestAgentLoop(piAgent, config);

      expect(() => agent.refreshTools()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Event bridge access
  // -----------------------------------------------------------------------

  describe('event bridge access', () => {
    it('exposes the event bridge', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const bridge = agent.getEventBridge();
      expect(bridge).toBeDefined();
    });

    it('exposes the budget guard', () => {
      const agent = createTestAgentLoop(piAgent, config);
      const guard = agent.getBudgetGuard();
      expect(guard).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // steer()
  // -----------------------------------------------------------------------

  describe('steer', () => {
    it('calls agent.steer() with user role message when prompting', async () => {
      const steerCalls: Array<{ role: string; content: string }> = [];
      piAgent.steer = (msg: { role: string; content: string }) => {
        steerCalls.push(msg);
      };

      const agent = createTestAgentLoop(piAgent, config);

      // Override run to hold open the prompting state so we can steer
      const originalPrompt = piAgent.prompt.bind(piAgent);
      piAgent.prompt = async (input: string): Promise<unknown> => {
        // Agent is now "prompting". Steer during this window.
        agent.steer('New context from user');
        return originalPrompt(input);
      };

      await agent.prompt('Hello');

      expect(steerCalls.length).toBe(1);
      expect(steerCalls[0]!.role).toBe('user');
      expect(steerCalls[0]!.content).toBe('New context from user');
      // pi pushes a steered message into the transcript as given.
      expect(steerCalls[0]).toMatchObject({ timestamp: expect.any(Number) });
    });

    it('is a no-op when not prompting', () => {
      const steerCalls: Array<{ role: string; content: string }> = [];
      piAgent.steer = (msg: { role: string; content: string }) => {
        steerCalls.push(msg);
      };

      const agent = createTestAgentLoop(piAgent, config);

      // Not prompting, should be a no-op
      agent.steer('This should be ignored');

      expect(steerCalls.length).toBe(0);
    });

    it('is a no-op after prompt completes', async () => {
      const steerCalls: Array<{ role: string; content: string }> = [];
      piAgent.steer = (msg: { role: string; content: string }) => {
        steerCalls.push(msg);
      };

      const agent = createTestAgentLoop(piAgent, config);
      await agent.prompt('Hello');

      // Prompt is done, should be a no-op
      agent.steer('Late message');

      expect(steerCalls.length).toBe(0);
    });

    it('delivers a steer issued in the same frame as prompt()', async () => {
      const steerCalls: Array<{ role: string; content: string }> = [];
      piAgent.steer = (msg: { role: string; content: string }) => {
        steerCalls.push(msg);
      };

      const agent = createTestAgentLoop(piAgent, config);

      // The turn is deferred one microtask (it dequeues from the loop gate),
      // so isPrompting is still false here. steer() must treat the non-empty
      // gate as "prompting" and forward to pi instead of dropping the message.
      const turn = agent.prompt('Hello');
      agent.steer('same-frame steer');
      await turn;

      expect(steerCalls).toHaveLength(1);
      expect(steerCalls[0]!.content).toBe('same-frame steer');
    });
  });

  // -----------------------------------------------------------------------
  // Prompt serialization (loop gate)
  // -----------------------------------------------------------------------

  describe('prompt serialization', () => {
    function holdPromptOpen(mock: MockPiAgent): { release: () => void; calls: string[] } {
      const originalPrompt = mock.prompt.bind(mock);
      const calls: string[] = [];
      let release!: () => void;
      mock.prompt = async (input: string): Promise<unknown> => {
        calls.push(input);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return originalPrompt(input);
      };
      return { release: () => release(), calls };
    }

    it('a concurrent prompt() fails fast without touching the running loop', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const { release, calls } = holdPromptOpen(piAgent);

      const first = agent.prompt('first turn');
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).toHaveLength(1);

      const boundaryDuringLoop = internal.runner.boundary;
      const resetSpy = vi.spyOn(internal.tools.runtime, 'resetForLoop');

      await expect(agent.prompt('second turn')).rejects.toThrow(/already processing/i);

      // The loser never reset the live loop's tool runtime, never moved its
      // history boundary, and never reached pi-agent-core.
      expect(resetSpy).not.toHaveBeenCalled();
      expect(internal.runner.boundary).toBe(boundaryDuringLoop);
      expect(calls).toHaveLength(1);

      // The running loop is still live: steer() reaches it.
      const steerCalls: Array<{ role: string; content: string }> = [];
      piAgent.steer = (msg: { role: string; content: string }) => {
        steerCalls.push(msg);
      };
      expect(internal.runner.isPrompting).toBe(true);
      agent.steer('mid-loop steer');
      expect(steerCalls).toHaveLength(1);

      // And the first loop completes normally.
      release();
      await expect(first).resolves.toBeDefined();
    });

    it('a background completion arriving while idle does not race a consumer prompt()', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      internal.tools.runtime.backgroundTasks.set({
        id: 'task_9',
        command: 'sleep 1',
        process: {} as never,
        stdout: 'done',
        stderr: '',
        exitCode: 0,
        completed: true,
        notified: false,
        startTime: Date.now() - 1000,
      });
      const promptSpy = vi.spyOn(piAgent, 'prompt');

      // Delivery is scheduled (gate becomes busy synchronously), so a
      // consumer prompt in the same tick fails fast instead of interleaving.
      const delivery = internal.background.enqueue({ kind: 'bash', taskId: 'task_9' });
      await expect(agent.prompt('user turn')).rejects.toThrow(/already processing/i);

      await delivery;
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy.mock.calls[0][0] as string).toContain('task_9');
    });

    it('a same-frame prompt() + abort() cancels the queued turn without running pi', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const promptSpy = vi.spyOn(piAgent, 'prompt');
      const errored = vi.fn();
      agent.onError(errored);

      // prompt() only enqueues; the cycle dequeues next microtask. A same-
      // frame abort() must be visible to that not-yet-started cycle, which
      // cancels it before it ever calls pi (matching main, which cancels in
      // ~1ms rather than running the whole turn un-aborted).
      const turn = agent.prompt('do work');
      const settled = turn.then(
        () => 'resolved',
        (e: Error) => e.name,
      );
      const aborting = agent.abort();

      const [outcome] = await Promise.all([settled, aborting]);

      expect(outcome).toBe('AbortError');
      expect(promptSpy).not.toHaveBeenCalled();
      expect(agent.state).toBe('active');
      expect(errored).toHaveBeenCalledTimes(1);
      expect(errored.mock.calls[0][0].category).toBe('cancelled');

      // The agent stays usable: a fresh prompt runs normally afterward.
      await expect(agent.prompt('next')).resolves.toBeDefined();
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy.mock.calls[0][0] as string).toBe('next');
    });
  });

  // -----------------------------------------------------------------------
  // directComplete()
  // -----------------------------------------------------------------------

  describe('directComplete', () => {
    it('directComplete method exists and is callable', () => {
      const agent = createTestAgentLoop(piAgent, config);
      expect(typeof agent.directComplete).toBe('function');
    });
  });

  // -----------------------------------------------------------------------
  // AgentLoop.create() factory
  // -----------------------------------------------------------------------

  describe('create factory', () => {
    it('create factory method exists', () => {
      expect(typeof AgentLoop.create).toBe('function');
    });
  });

  // -----------------------------------------------------------------------
  // Background bash task completion wake-up
  // -----------------------------------------------------------------------

  describe('background bash task completion', () => {
    function seedCompletedTask(
      agent: AgentLoop,
      overrides?: { exitCode?: number; stdout?: string; notified?: boolean; id?: string },
    ): string {
      const id = overrides?.id ?? 'task_1';
      partsOf(agent).tools.runtime.backgroundTasks.set({
        id,
        command: 'npm run check',
        process: {} as never,
        stdout: overrides?.stdout ?? 'all tests green',
        stderr: '',
        exitCode: overrides?.exitCode ?? 0,
        completed: true,
        notified: overrides?.notified ?? false,
        startTime: Date.now() - 1000,
      });
      return id;
    }

    it('wakes the loop when a bash task completes while idle', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const id = seedCompletedTask(agent, { stdout: 'all tests green' });
      const promptSpy = vi.spyOn(piAgent, 'prompt');

      await internal.background.enqueue({ kind: 'bash', taskId: id });

      expect(promptSpy).toHaveBeenCalledTimes(1);
      const delivered = promptSpy.mock.calls[0][0] as string;
      expect(delivered).toContain(id);
      expect(delivered).toContain('completed');
      expect(delivered).toContain('exit code: 0');
      expect(delivered).toContain('all tests green');
    });

    it('marks a failed task and reports the exit code', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const id = seedCompletedTask(agent, { exitCode: 2, stdout: 'boom' });
      const promptSpy = vi.spyOn(piAgent, 'prompt');

      await internal.background.enqueue({ kind: 'bash', taskId: id });

      const delivered = promptSpy.mock.calls[0][0] as string;
      expect(delivered).toContain('failed');
      expect(delivered).toContain('exit code: 2');
    });

    it('queues the completion while prompting and delivers it on drain', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const id = seedCompletedTask(agent);

      // Hold the first loop open so the completion arrives mid-prompt.
      let releaseFirst!: () => void;
      const originalPrompt = piAgent.prompt.bind(piAgent);
      const promptCalls: string[] = [];
      piAgent.prompt = async (input: string): Promise<unknown> => {
        promptCalls.push(input);
        if (promptCalls.length === 1) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return originalPrompt(input);
      };

      const firstTurn = agent.prompt('kick off a long turn');
      await new Promise((resolve) => setImmediate(resolve));
      expect(promptCalls).toHaveLength(1);

      const delivery = internal.background.enqueue({ kind: 'bash', taskId: id });
      // The completion is queued while the loop runs, not delivered
      // immediately with a competing loop start.
      expect(internal.background.pending).toHaveLength(1);
      expect(promptCalls).toHaveLength(1);

      // Loop ends; the end-of-cycle drain delivers the queued completion
      // before the consumer's await resolves.
      releaseFirst();
      await firstTurn;
      await delivery;

      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1]).toContain(id);
      expect(internal.background.pending).toHaveLength(0);
    });

    it('does not deliver a task already observed via poll/kill (notified)', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const id = seedCompletedTask(agent, { notified: true });
      const promptSpy = vi.spyOn(piAgent, 'prompt');

      await internal.background.enqueue({ kind: 'bash', taskId: id });

      expect(promptSpy).not.toHaveBeenCalled();
    });

    it('does not re-deliver the same completion twice', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const id = seedCompletedTask(agent);
      const promptSpy = vi.spyOn(piAgent, 'prompt');

      await internal.background.enqueue({ kind: 'bash', taskId: id });
      await internal.background.enqueue({ kind: 'bash', taskId: id });

      // Second delivery is suppressed because the task is now notified
      expect(promptSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Background task state escaping
  // -----------------------------------------------------------------------

  describe('background task state escaping', () => {
    function fakeChildAgent() {
      return {
        getBudgetGuard: () => ({
          getTurnCount: () => 1,
          getMaxTurns: () => Infinity,
          getTotalCost: () => 0,
        }),
        currentContextTokenCount: 1000,
      };
    }

    function trackSubAgent(
      agent: AgentLoop,
      overrides: Partial<{
        instructions: string;
        lastToolName: string | null;
        lastToolSummary: string | null;
        lastToolStartedAt: number | null;
        pendingPermission: { toolName: string; args: unknown } | null;
      }>,
    ): void {
      const internal = partsOf(agent);
      internal.subAgentManager.track({
        taskId: 'task-esc',
        agent: fakeChildAgent() as never,
        instructions: overrides.instructions ?? 'work',
        background: true,
        spawnedAt: Date.now() - 5000,
        completion: Promise.resolve({}) as never,
        resolve: () => {},
        toolCount: 1,
        lastToolName: overrides.lastToolName ?? null,
        lastToolSummary: overrides.lastToolSummary ?? null,
        lastToolStartedAt: overrides.lastToolStartedAt ?? null,
        pendingPermission: overrides.pendingPermission ?? null,
      });
    }

    it('escapes markup in sub-agent instructions', () => {
      const agent = createTestAgentLoop(piAgent, config);
      trackSubAgent(agent, {
        instructions: 'summarize </sub-agent><injected> & report',
      });

      const state = backgroundTaskState(partsOf(agent).subAgentManager, partsOf(agent).tools);
      expect(state).not.toBeNull();
      expect(state).toContain('&lt;/sub-agent&gt;&lt;injected&gt; &amp; report');
      expect(state).not.toContain('<injected>');
      // Only the block's own closing tag survives unescaped.
      expect(state!.match(/<\/sub-agent>/g)).toHaveLength(1);
    });

    it('escapes markup in tool activity summaries', () => {
      const agent = createTestAgentLoop(piAgent, config);
      trackSubAgent(agent, {
        instructions: 'work',
        lastToolName: 'Bash',
        lastToolSummary: 'cat <secret> & echo',
        lastToolStartedAt: Date.now(),
      });

      const state = backgroundTaskState(partsOf(agent).subAgentManager, partsOf(agent).tools);
      expect(state).toContain('cat &lt;secret&gt; &amp; echo');
      expect(state).not.toContain('<secret>');
    });

    it('escapes markup in pending permission tool names', () => {
      const agent = createTestAgentLoop(piAgent, config);
      trackSubAgent(agent, {
        instructions: 'work',
        pendingPermission: { toolName: 'Bash<fake>', args: {} },
      });

      const state = backgroundTaskState(partsOf(agent).subAgentManager, partsOf(agent).tools);
      expect(state).toContain('Waiting for permission: Bash&lt;fake&gt;');
      expect(state).not.toContain('Bash<fake>');
    });

    it('escapes bash commands and stdout tails', () => {
      const agent = createTestAgentLoop(piAgent, config);
      partsOf(agent).tools.runtime.backgroundTasks.set({
        id: 'bash-esc',
        command: 'echo "hi" > out.txt',
        process: {} as never,
        stdout: 'line1\n<fake-tag attr="x">\n</bash>',
        stderr: '',
        exitCode: null,
        completed: false,
        notified: false,
        startTime: Date.now() - 1000,
      });

      const state = backgroundTaskState(partsOf(agent).subAgentManager, partsOf(agent).tools);
      expect(state).not.toBeNull();
      // The command sits inside a quoted attribute: quotes escape too.
      expect(state).toContain('command="echo &quot;hi&quot; &gt; out.txt"');
      // Stdout tail is body text: angle brackets neutralized.
      expect(state).toContain('&lt;fake-tag attr="x"&gt;');
      expect(state).not.toContain('<fake-tag');
      // Only the block's own closing tag survives unescaped.
      expect(state!.match(/<\/bash>/g)).toHaveLength(1);
    });

    it('leaves clean values untouched', () => {
      const agent = createTestAgentLoop(piAgent, config);
      trackSubAgent(agent, { instructions: 'summarize the quarterly report' });

      const state = backgroundTaskState(partsOf(agent).subAgentManager, partsOf(agent).tools);
      expect(state).toContain('Instructions: summarize the quarterly report');
    });
  });

  // -----------------------------------------------------------------------
  // Background result delivery durability (re-queue + dead-letter)
  // -----------------------------------------------------------------------

  describe('background result delivery durability', () => {
    function seedCompletedTask(agent: AgentLoop, id: string, stdout: string): void {
      partsOf(agent).tools.runtime.backgroundTasks.set({
        id,
        command: 'npm run check',
        process: {} as never,
        stdout,
        stderr: '',
        exitCode: 0,
        completed: true,
        notified: false,
        startTime: Date.now() - 1000,
      });
    }

    /**
     * Replace piAgent.prompt with one that fails the first `failures` calls.
     * Failures mutate state.messages the way a real pi run does: the prompt
     * message is pushed at run start (before any model call), then the
     * synthetic assistant failure stub. Every realistic delivery failure
     * happens after that push, so a re-queued delivery that does not unwind
     * the transcript duplicates the completion body.
     */
    function installFailingPrompt(failures: number): string[] {
      const originalPrompt = piAgent.prompt.bind(piAgent);
      const promptCalls: string[] = [];
      let remaining = failures;
      piAgent.prompt = async (input: string): Promise<unknown> => {
        promptCalls.push(input);
        if (remaining > 0) {
          remaining -= 1;
          piAgent.state.messages.push({ role: 'user', content: input } as never);
          piAgent.state.messages.push({
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'delivery misconfigured',
          } as never);
          throw new Error('delivery misconfigured');
        }
        return originalPrompt(input);
      };
      return promptCalls;
    }

    /** Role sequence of the post-slot transcript, for asserting on history. */
    function historyRoles(agent: AgentLoop): string[] {
      return (agent.getConversationHistory() as Array<{ role: string }>).map(m => m.role);
    }

    /** How many post-slot transcript messages contain `text` in their content. */
    function historyOccurrences(agent: AgentLoop, text: string): number {
      return (agent.getConversationHistory() as Array<{ content: unknown }>).filter(
        m => typeof m.content === 'string' && m.content.includes(text),
      ).length;
    }

    beforeEach(() => {
      // Disable background retry so delivery failures surface immediately
      // instead of scheduling multi-minute backoff waits.
      config = createDefaultConfig({ retryPolicy: { enabled: false } });
    });

    it('re-queues a failed bash delivery and delivers it on the next attempt', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      seedCompletedTask(agent, 'task_r1', 'durable output');
      const promptCalls = installFailingPrompt(1);

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_r1' });

      // First attempt failed, second delivered the same formatted message
      // (Bash tasks are marked notified on first format, so the re-queued
      // item must carry the message rather than re-formatting to null).
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1]).toContain('task_r1');
      expect(promptCalls[1]).toContain('durable output');
      expect(internal.background.pending).toHaveLength(0);
      expect(agent.getDeadLetteredBackgroundResults()).toHaveLength(0);

      // The failed attempt's transcript additions were unwound before the
      // re-queue: the completion body appears exactly once, and no failure
      // stub or duplicate user message survives.
      expect(historyRoles(agent)).toEqual(['user', 'assistant']);
      expect(historyOccurrences(agent, 'durable output')).toBe(1);
    });

    it('does not duplicate the completion message in history across re-queued attempts', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      seedCompletedTask(agent, 'task_dup', 'sixty-thousand-token payload');
      installFailingPrompt(2);

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_dup' });

      // Two failed attempts, then success. Each failed attempt pushed the
      // delivery message into the transcript (pi does this at run start,
      // before any model call); without unwinding, attempts 2 and 3 would
      // append the identical body again and history would read
      // user, user, user, assistant.
      expect(internal.background.pending).toHaveLength(0);
      expect(historyRoles(agent)).toEqual(['user', 'assistant']);
      expect(historyOccurrences(agent, 'sixty-thousand-token payload')).toBe(1);
    });

    it('tells the compaction manager the post-slot length after unwinding a failed delivery', async () => {
      // pi emits turn_end for the delivery message and failure stub before
      // the unwind removes them, so an observational buffer watermark may
      // already count them. The unwind must notify the compaction manager
      // with the surviving post-slot length (here: back to the empty
      // pre-delivery transcript) so the watermark is clamped.
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const spy = vi.spyOn(
        partsOf(agent).compactionManager,
        'onSourceHistoryTailTrimmed',
      );
      seedCompletedTask(agent, 'task_wm', 'watermark payload');
      installFailingPrompt(1);

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_wm' });

      expect(spy).toHaveBeenCalled();
      const lastCall = spy.mock.calls[spy.mock.calls.length - 1]!;
      expect(lastCall[0]).toBe(0);
      // The retry then delivered normally.
      expect(historyRoles(agent)).toEqual(['user', 'assistant']);
    });

    it('re-queues a failed sub-agent result delivery without losing the result', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const promptCalls = installFailingPrompt(1);

      await internal.background.enqueue({
        kind: 'subagent',
        taskId: 'sa_1',
        result: {
          output: 'research findings',
          status: 'completed',
          usage: { turns: 2, cost: 0.01, durationMs: 500, contextTokens: 100 },
        },
      });

      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1]).toContain('sa_1');
      expect(promptCalls[1]).toContain('research findings');
      expect(internal.background.pending).toHaveLength(0);
      // The sub-agent result reaches the transcript exactly once.
      expect(historyRoles(agent)).toEqual(['user', 'assistant']);
      expect(historyOccurrences(agent, 'research findings')).toBe(1);
    });

    it('dead-letters a completion after repeated delivery failures', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      seedCompletedTask(agent, 'task_dead', 'lost output');
      const promptCalls = installFailingPrompt(Infinity);

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_dead' });

      // Exactly the capped number of attempts, then the item leaves the queue
      // permanently instead of redelivering forever.
      expect(promptCalls).toHaveLength(3);
      expect(internal.background.pending).toHaveLength(0);
      // Every failed attempt was unwound; the dead-lettered body does not
      // linger in the transcript (in any copy) after the final failure.
      expect(historyRoles(agent)).toEqual([]);

      const dead = agent.getDeadLetteredBackgroundResults();
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({
        kind: 'bash',
        taskId: 'task_dead',
        attempts: 3,
        lastError: 'delivery misconfigured',
      });
      expect(dead[0].message).toContain('lost output');
    });

    it('recovers a public steer destroyed by the failed-delivery unwind via wake parking', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);

      // Give the mock a real steering queue: pi drains it at run start.
      const steeringQueue: Array<{ role: string; content: string }> = [];
      let steerCalls = 0;
      piAgent.steer = (message: { role: string; content: string }): void => {
        steerCalls += 1;
        steeringQueue.push(message);
      };

      let failuresLeft = 1;
      piAgent.prompt = async (input: string): Promise<unknown> => {
        piAgent.state.messages.push({ role: 'user', content: input } as never);
        piAgent.state.messages.push(...(steeringQueue.splice(0) as never[]));
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          // The run fails after an assistant tool-call turn but before its
          // tool results: the surviving tail carries an unpaired tool call,
          // so the unwind splices the whole delivery range.
          piAgent.state.messages.push({
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call_1', name: 'Bash', arguments: {} }],
          } as never);
          throw new Error('provider dropped mid-batch');
        }
        piAgent.state.messages.push({
          role: 'assistant',
          content: 'delivered',
          stopReason: 'end_turn',
        } as never);
        return { content: 'delivered' };
      };

      // The steer lands while the drain holds the gate, so pi injects it
      // right after the delivery message inside the doomed run.
      const delivery = internal.background.enqueue({
        kind: 'subagent',
        taskId: 'sa_steer',
        result: {
          output: 'research findings',
          status: 'completed',
          usage: { turns: 1, cost: 0.01, durationMs: 100, contextTokens: 10 },
        },
      });
      agent.steer('steered mid-drain');
      await delivery;

      // The unwind recovered the spliced steer as a parked wake delivery
      // (never guessing a pi queue for it); the sweep delivers it in a run
      // of its own after the re-attempted delivery run. Exactly one copy
      // of each content survives.
      const deadline = Date.now() + 2000;
      while (historyOccurrences(agent, 'steered mid-drain') !== 1 || agent.isLoopActive) {
        if (Date.now() > deadline) throw new Error('sweep did not deliver the recovered steer');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(historyOccurrences(agent, 'steered mid-drain')).toBe(1);
      expect(historyOccurrences(agent, 'research findings')).toBe(1);
      // Only the test's own public steer() touched pi's queue. The unwind
      // must not re-inject recovered content with steering semantics: the
      // spliced range can also hold follow-up-injected messages, and pi's
      // transcript cannot tell the two apart.
      expect(steerCalls).toBe(1);
    });

    it('does not fire onError when a re-queued delivery eventually succeeds', async () => {
      // The failed first attempt is re-queued and the drain chain's next
      // attempt delivers it. A recovered failure must not surface: no
      // per-attempt emission, and the pending throw from the failed attempt
      // is suppressed instead of reaching the scheduled-drain onError root.
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const errored = vi.fn();
      agent.onError(errored);
      seedCompletedTask(agent, 'task_s3a', 'eventually delivered output');
      installFailingPrompt(1);

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_s3a' });

      expect(historyOccurrences(agent, 'eventually delivered output')).toBe(1);
      expect(internal.background.pending).toHaveLength(0);
      expect(errored).not.toHaveBeenCalled();
    });

    it('fires onError exactly once when a delivery exhausts all attempts', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const errored = vi.fn();
      agent.onError(errored);
      seedCompletedTask(agent, 'task_s3b', 'never delivered output');
      installFailingPrompt(10);

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_s3b' });

      // Terminal failure: dead-lettered, and the chain root reports it once
      // (not once per attempt, and not doubled by the propagated re-throw).
      expect(agent.getDeadLetteredBackgroundResults()).toHaveLength(1);
      expect(errored).toHaveBeenCalledTimes(1);
      expect(errored.mock.calls[0][0].originalMessage).toContain('delivery misconfigured');
    });

    it('does not reject a successful consumer prompt when its end-of-cycle delivery fails', async () => {
      // A completion is already pending when the consumer prompts, so
      // runPromptCycle's finally drains it after the consumer turn
      // succeeds. The delivery fails terminally; that is a background
      // concern surfaced through onError, never a rejection of the
      // consumer's own successful turn.
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      seedCompletedTask(agent, 'task_s3c', 'cycle-drain output');
      (internal.background.pending as Array<Record<string, unknown>>).push(
        { kind: 'bash', taskId: 'task_s3c' },
      );

      const originalPrompt = piAgent.prompt.bind(piAgent);
      piAgent.prompt = async (input: string): Promise<unknown> => {
        if (input.includes('[Background command')) {
          piAgent.state.messages.push({ role: 'user', content: input } as never);
          piAgent.state.messages.push({
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'delivery down',
          } as never);
          throw new Error('delivery down');
        }
        return originalPrompt(input);
      };

      const errored = vi.fn();
      agent.onError(errored);

      // Must resolve even though every delivery attempt fails.
      await agent.prompt('hello there');

      expect(agent.getDeadLetteredBackgroundResults()).toHaveLength(1);
      expect(errored).toHaveBeenCalledTimes(1);
      expect(errored.mock.calls[0][0].originalMessage).toContain('delivery down');
    });

    it('dead-letters immediately on a fatal authentication error instead of re-attempting', async () => {
      // An identical immediate re-attempt of an auth failure is futile: the
      // consumer must fix credentials first. Burning the attempt cap in
      // milliseconds would only hide the real failure mode.
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const errored = vi.fn();
      agent.onError(errored);
      seedCompletedTask(agent, 'task_s4a', 'auth-blocked output');

      const promptCalls: string[] = [];
      piAgent.prompt = async (input: string): Promise<unknown> => {
        promptCalls.push(input);
        piAgent.state.messages.push({ role: 'user', content: input } as never);
        piAgent.state.messages.push({
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'Invalid API key provided',
        } as never);
        throw new Error('Invalid API key provided');
      };

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_s4a' });

      expect(promptCalls).toHaveLength(1);
      const dead = agent.getDeadLetteredBackgroundResults();
      expect(dead).toHaveLength(1);
      expect(dead[0].attempts).toBe(1);
      expect(errored).toHaveBeenCalledTimes(1);
    });

    it('dead-letters a delivery whose total elapsed budget is exhausted, before the attempt cap', async () => {
      // The item's first delivery attempt started five hours ago (earlier
      // attempts burned the in-run retry ladder). Even though attempts
      // remain, the elapsed budget bounds total delivery time; without it,
      // this re-queue would succeed on the next immediate attempt and a
      // real outage could hold the loop gate for three full ladders.
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      seedCompletedTask(agent, 'task_s4b', 'over-budget output');
      const promptCalls = installFailingPrompt(1);

      await internal.background.enqueue({
        kind: 'bash',
        taskId: 'task_s4b',
        firstDeliveryAttemptAt: Date.now() - 5 * 60 * 60 * 1000,
      });

      expect(promptCalls).toHaveLength(1);
      const dead = agent.getDeadLetteredBackgroundResults();
      expect(dead).toHaveLength(1);
      expect(dead[0].attempts).toBe(1);
      expect(internal.background.pending).toHaveLength(0);
    });

    it('caps the in-run retry ladder by the remaining delivery budget', async () => {
      // Retry enabled: a network failure would normally schedule an in-run
      // retry. The delivery budget is exhausted, so the bounded policy the
      // drain passes down must fail fast instead of re-entering the ladder.
      config = createDefaultConfig({
        retryPolicy: { backoffMs: [1], maxBackoffMs: 1, maxAttempts: 3 },
      });
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const scheduled = vi.fn();
      agent.onRetryScheduled(scheduled);
      seedCompletedTask(agent, 'task_s4c', 'ladder-capped output');

      piAgent.prompt = async (input: string): Promise<unknown> => {
        piAgent.state.messages.push({ role: 'user', content: input } as never);
        piAgent.state.messages.push({
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'connect ECONNREFUSED',
        } as never);
        throw new Error('connect ECONNREFUSED');
      };

      await internal.background.enqueue({
        kind: 'bash',
        taskId: 'task_s4c',
        firstDeliveryAttemptAt: Date.now() - 5 * 60 * 60 * 1000,
      });

      expect(scheduled).not.toHaveBeenCalled();
      expect(agent.getDeadLetteredBackgroundResults()).toHaveLength(1);
    });

    it('does not fire onRetryExhausted when a drain attempt ladder ends but the re-queue recovers', async () => {
      // A delivery attempt's in-run retry ladder ending is not terminal for
      // a drain: the batch is re-queued and the next attempt may succeed.
      // "Gave up after N attempts" must not reach the consumer for an
      // attempt the chain recovered from, mirroring how onError is deferred
      // to the chain root for drain deliveries.
      config = createDefaultConfig({
        retryPolicy: { backoffMs: [1], maxBackoffMs: 1, maxAttempts: 1 },
      });
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const exhausted = vi.fn();
      const errored = vi.fn();
      agent.onRetryExhausted(exhausted);
      agent.onError(errored);
      seedCompletedTask(agent, 'task_n1', 'ladder-then-recovered output');

      // First drain attempt: prompt fails, its one in-run retry (continue)
      // fails too, exhausting the ladder. The re-queued second attempt
      // delivers.
      const originalPrompt = piAgent.prompt.bind(piAgent);
      const promptCalls: string[] = [];
      let failuresRemaining = 2;
      const pushFailure = (): never => {
        failuresRemaining -= 1;
        piAgent.state.messages.push({
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: 'connect ECONNREFUSED',
        } as never);
        throw new Error('connect ECONNREFUSED');
      };
      piAgent.prompt = async (input: string): Promise<unknown> => {
        promptCalls.push(input);
        if (failuresRemaining > 0) {
          piAgent.state.messages.push({ role: 'user', content: input } as never);
          pushFailure();
        }
        return originalPrompt(input);
      };
      (piAgent as unknown as { continue: () => Promise<unknown> }).continue =
        async (): Promise<unknown> => {
          if (failuresRemaining > 0) pushFailure();
          piAgent.state.messages.push({
            role: 'assistant',
            content: 'delivered',
            stopReason: 'end_turn',
          } as never);
          return { content: 'delivered' };
        };

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_n1' });

      // The chain recovered: the completion was delivered and nothing
      // surfaced to the consumer, exhaustion included.
      expect(promptCalls).toHaveLength(2);
      expect(historyOccurrences(agent, 'ladder-then-recovered output')).toBe(1);
      expect(agent.getDeadLetteredBackgroundResults()).toHaveLength(0);
      expect(exhausted).not.toHaveBeenCalled();
      expect(errored).not.toHaveBeenCalled();
    });

    it('notifies onBackgroundResultDeadLettered when delivery gives up', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const deadLettered = vi.fn();
      agent.onBackgroundResultDeadLettered(deadLettered);
      seedCompletedTask(agent, 'task_s5a', 'undeliverable output');
      installFailingPrompt(10);

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_s5a' });

      expect(deadLettered).toHaveBeenCalledTimes(1);
      expect(deadLettered.mock.calls[0][0]).toMatchObject({
        kind: 'bash',
        taskId: 'task_s5a',
        attempts: 3,
      });
      expect(deadLettered.mock.calls[0][0].message).toContain('undeliverable output');
    });

    it('dead-letters completions still queued when the agent is destroyed', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const deadLettered = vi.fn();
      agent.onBackgroundResultDeadLettered(deadLettered);
      // Queue directly without scheduling a drain, simulating a completion
      // the shutdown raced.
      (internal.background.pending as Array<Record<string, unknown>>).push(
        { kind: 'bash', taskId: 'task_s5b' },
      );

      await agent.destroy();

      // Recorded and announced (handlers were still registered when the
      // teardown dead-lettered it), not silently dropped.
      expect(deadLettered).toHaveBeenCalledTimes(1);
      expect(deadLettered.mock.calls[0][0]).toMatchObject({
        kind: 'bash',
        taskId: 'task_s5b',
        lastError: 'agent shut down before delivery',
      });
      // The record survives destroy() for post-mortem inspection.
      expect(agent.getDeadLetteredBackgroundResults()).toHaveLength(1);
    });

    it('records the formatted message body when teardown dead-letters a queued completion', async () => {
      // A completion dead-lettered by teardown never went through a drain,
      // so it has no formattedMessage yet. The dead-letter record must
      // format it on the spot: teardown runs before the tool runtime is
      // destroyed, so the Bash output is still readable there, and an empty
      // message would make the output unrecoverable.
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      seedCompletedTask(agent, 'task_sf1a', 'shutdown-orphaned output');
      (internal.background.pending as Array<Record<string, unknown>>).push(
        { kind: 'bash', taskId: 'task_sf1a' },
      );

      await agent.destroy();

      const dead = agent.getDeadLetteredBackgroundResults();
      expect(dead).toHaveLength(1);
      expect(dead[0].message).toContain('task_sf1a');
      expect(dead[0].message).toContain('shutdown-orphaned output');
    });

    it('records the formatted message for a sub-agent result arriving after shutdown', async () => {
      // Same gap on the other shutdown path: a completion arriving after
      // teardown began is dead-lettered directly without a drain, so its
      // message must be formatted at dead-letter time. Sub-agent items carry
      // their result, so this works even after full teardown.
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      await agent.destroy();

      await internal.background.enqueue({
        kind: 'subagent',
        taskId: 'sa_sf1b',
        result: {
          output: 'late findings',
          status: 'completed',
          usage: { turns: 1, cost: 0.01, durationMs: 100, contextTokens: 50 },
        },
      });

      const dead = agent.getDeadLetteredBackgroundResults();
      expect(dead).toHaveLength(1);
      expect(dead[0].message).toContain('sa_sf1b');
      expect(dead[0].message).toContain('late findings');
    });

    it('discards, not dead-letters, a cancelled sub-agent result settling after destroy', async () => {
      // The user cancelled this sub-agent on purpose. Its completion
      // continuation can settle after the parent's teardown (it awaits its
      // own child destroy), so the cancelled-ID set must survive
      // SubAgentManager.destroy() for the late result to stay a purposeful
      // discard instead of dead-lettering as "shut down before delivery".
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      internal.subAgentManager.track({
        taskId: 'sa_cancelled_late',
        agent: { destroy: async () => {} } as never,
        instructions: 'work',
        background: true,
        spawnedAt: Date.now(),
        completion: Promise.resolve({}) as never,
        resolve: () => {},
        toolCount: 0,
        lastToolName: null,
        lastToolSummary: null,
        lastToolStartedAt: null,
        pendingPermission: null,
      });
      await agent.cancelSubAgent('sa_cancelled_late');

      await agent.destroy();

      await internal.background.enqueue({
        kind: 'subagent',
        taskId: 'sa_cancelled_late',
        result: {
          output: 'finished right as it was cancelled',
          status: 'completed',
          usage: { turns: 1, cost: 0.01, durationMs: 100, contextTokens: 50 },
        },
      });

      expect(agent.getDeadLetteredBackgroundResults()).toHaveLength(0);
    });

    it('dead-letters a completion that arrives after shutdown begins', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      await agent.destroy();

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_s5c' });

      const dead = agent.getDeadLetteredBackgroundResults();
      expect(dead).toHaveLength(1);
      expect(dead[0]).toMatchObject({
        taskId: 'task_s5c',
        lastError: 'agent shut down before delivery',
      });
    });

    it('evicts the oldest dead-letter entries once the cap is exceeded', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      await agent.destroy();

      // Every arrival during shutdown dead-letters; push past the 50 cap.
      for (let i = 0; i < 55; i++) {
        await internal.background.enqueue({ kind: 'bash', taskId: `task_cap_${i}` });
      }

      const dead = agent.getDeadLetteredBackgroundResults();
      expect(dead).toHaveLength(50);
      // Oldest five were evicted; the list keeps the newest 50 in order.
      expect(dead[0].taskId).toBe('task_cap_5');
      expect(dead[49].taskId).toBe('task_cap_54');
    });

    it('fires onBackgroundResultDelivery once per completion, not per attempt', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      seedCompletedTask(agent, 'task_h1', 'output');
      installFailingPrompt(1);

      const seen: string[][] = [];
      agent.onBackgroundResultDelivery((taskIds) => seen.push(taskIds));

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_h1' });

      expect(seen).toEqual([['task_h1']]);
    });

    it('delivers completions that arrive during a failed delivery', async () => {
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      seedCompletedTask(agent, 'task_a', 'first output');
      seedCompletedTask(agent, 'task_b', 'second output');

      const originalPrompt = piAgent.prompt.bind(piAgent);
      const promptCalls: string[] = [];
      let failed = false;
      piAgent.prompt = async (input: string): Promise<unknown> => {
        promptCalls.push(input);
        if (!failed) {
          failed = true;
          // A second completion lands while the first delivery is failing.
          (internal.background.pending as Array<Record<string, unknown>>).push(
            { kind: 'bash', taskId: 'task_b' },
          );
          // Mirror pi: the prompt message and failure stub reach the
          // transcript before the failure surfaces.
          piAgent.state.messages.push({ role: 'user', content: input } as never);
          piAgent.state.messages.push({
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'delivery misconfigured',
          } as never);
          throw new Error('delivery misconfigured');
        }
        return originalPrompt(input);
      };

      await internal.background.enqueue({ kind: 'bash', taskId: 'task_a' });

      // The re-queued first completion is delivered ahead of the new one,
      // both in the same follow-up message.
      expect(promptCalls).toHaveLength(2);
      expect(promptCalls[1]).toContain('task_a');
      expect(promptCalls[1]).toContain('task_b');
      expect(internal.background.pending).toHaveLength(0);
      // One combined delivery in history; each body exactly once.
      expect(historyRoles(agent)).toEqual(['user', 'assistant']);
      expect(historyOccurrences(agent, 'first output')).toBe(1);
      expect(historyOccurrences(agent, 'second output')).toBe(1);
    });

    it('does not spend a delivery attempt when the user aborts mid-delivery', async () => {
      // An abort is the user stopping the agent, not the delivery failing on
      // its own terms. Charging it an attempt means a few quick aborts
      // permanently dead-letter completed work that never actually failed.
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      vi.spyOn(agent as unknown as { isAborted: () => boolean }, 'isAborted').mockReturnValue(true);
      const item = { kind: 'bash' as const, taskId: 'task_abort' };

      for (let i = 0; i < 4; i++) {
        internal.background.pending.length = 0;
        internal.background.requeueOrDeadLetter([item], new Error('Operation aborted'));
      }

      expect((item as { deliveryAttempts?: number }).deliveryAttempts).toBe(0);
      expect(internal.background.pending).toContain(item);
      expect(agent.getDeadLetteredBackgroundResults()).toHaveLength(0);
    });

    it('reports a dead-lettered batch as terminal even after cap eviction', async () => {
      // The recovered/terminal decision reads a flag on the item, not a
      // lookup in the capped dead-letter list: an entry evicted by later
      // dead-letters would otherwise read as "recovered" and swallow the
      // consumer's onError for a delivery that never landed.
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const item = { kind: 'bash' as const, taskId: 'task_evicted', deliveryAttempts: 3 };

      internal.background.requeueOrDeadLetter([item], new Error('delivery down'));
      expect(internal.background.batchRecoveredAfterRequeue([item])).toBe(false);

      // Push it out of the bounded dead-letter list.
      for (let i = 0; i < 55; i++) {
        internal.background.requeueOrDeadLetter(
          [{ kind: 'bash' as const, taskId: `filler_${i}`, deliveryAttempts: 3 }],
          new Error('delivery down'),
        );
      }
      const dead = agent.getDeadLetteredBackgroundResults();
      expect(dead.some(d => d.taskId === 'task_evicted')).toBe(false);
      expect(internal.background.batchRecoveredAfterRequeue([item])).toBe(false);
    });

    it('unwinds a delivery whose run left an unpaired assistant tool call', async () => {
      // A failure between an assistant tool-call turn and its tool results
      // leaves a transcript the provider rejects outright. Treating that as
      // "delivered" would strand the completion AND wedge the next request.
      const agent = createTestAgentLoop(piAgent, config);
      const internal = partsOf(agent);
      const preDeliveryCount = piAgent.state.messages.length;
      piAgent.state.messages.push({ role: 'user', content: 'delivery body' } as never);
      piAgent.state.messages.push({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc_1', name: 'Read', arguments: {} }],
        stopReason: 'toolUse',
      } as never);

      // The run started where the delivery message landed.
      internal.runner.boundary = preDeliveryCount;
      const requeue = internal.queues.unwindFailedDelivery('delivery body', 0);

      expect(requeue).toBe(true);
      expect(piAgent.state.messages).toHaveLength(preDeliveryCount);
    });
  });
});
