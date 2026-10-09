/**
 * The tool-result interceptor: an owner-installed hook inside pi's
 * afterToolCall that can replace result content, override the terminate
 * flag, or suppress the working-tags reminder appendix. Built for the
 * duplex facade's control-tool terminate guards (decisions.md D17): the
 * empty-spoken-text suppression must flip a tool-set terminate to false,
 * and control-tool receipts must stay bare (no reminder appendix).
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop, TOOL_RESULT_WORKING_TAGS_REMINDER } from '../../src/agent-loop.js';
import type { PiAgent, PiModel, ToolResultInterceptor } from '../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';

type AfterToolCallHook = (ctx: {
  toolCall: { name: string };
  assistantMessage?: unknown;
  args?: unknown;
  result: { content: unknown };
  isError: boolean;
  context?: unknown;
}) => Promise<{ content?: unknown; terminate?: boolean } | undefined>;

type TestAgentLoopConstructor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

function makeModel(raw: PiModel) {
  return wrapModel(raw, raw.provider, raw.name, raw.contextWindow);
}

function createMockPiAgent(): PiAgent {
  return {
    state: { messages: [], systemPrompt: '', tools: [] },
    subscribe() { return () => {}; },
    async prompt() { return { content: 'ok' }; },
    abort() {},
    async waitForIdle() {},
    reset() { this.state.messages = []; },
    steer() {},
  } as unknown as PiAgent;
}

/**
 * Build a real AgentLoop plus the pi afterToolCall hook wired to it, the
 * way createManagedAgent does in production.
 */
function buildLoopWithHook(
  configOverrides?: Partial<AgentLoopConfig>,
): { loop: AgentLoop; hook: AfterToolCallHook } {
  const cortexConfig: AgentLoopConfig = {
    model: makeModel({
      provider: 'anthropic',
      name: 'claude-sonnet-4-20250514',
      contextWindow: 200_000,
    } as PiModel),
    workingDirectory: '/tmp/test-workspace',
    initialBasePrompt: 'Test prompt',
    slots: [],
    // The reminder path under test exists only with working tags on (off by default).
    workingTags: { enabled: true },
    ...configOverrides,
  };
  const Ctor = AgentLoop as unknown as TestAgentLoopConstructor;
  const loop = new Ctor(createMockPiAgent(), cortexConfig, [], {
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
  });
  const statics = AgentLoop as unknown as {
    buildPiAgentConfig: (params: {
      cortexConfig: AgentLoopConfig;
      cacheBreakpointState: { agentLoop: AgentLoop | null };
    }) => Record<string, unknown>;
  };
  const agentConfig = statics.buildPiAgentConfig({
    cortexConfig,
    cacheBreakpointState: { agentLoop: loop },
  });
  return { loop, hook: agentConfig['afterToolCall'] as AfterToolCallHook };
}

const REMINDER = '\n\n' + TOOL_RESULT_WORKING_TAGS_REMINDER;

function textResult(text: string): { content: unknown } {
  return { content: [{ type: 'text', text }] };
}

describe('afterToolCall without an interceptor (pre-existing behavior)', () => {
  it('appends the working-tags reminder to a successful array result', async () => {
    const { hook } = buildLoopWithHook();
    const out = await hook({
      toolCall: { name: 'Bash' },
      result: textResult('file list'),
      isError: false,
    });
    expect(out).toBeDefined();
    const blocks = out!.content as Array<{ type: string; text: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.text).toBe(REMINDER);
    expect(out!.terminate).toBeUndefined();
  });

  it('appends the reminder to a string result', async () => {
    const { hook } = buildLoopWithHook();
    const out = await hook({
      toolCall: { name: 'Bash' },
      result: { content: 'plain output' },
      isError: false,
    });
    expect(out!.content).toBe('plain output' + REMINDER);
  });

  it('leaves error results untouched', async () => {
    const { hook } = buildLoopWithHook();
    const out = await hook({
      toolCall: { name: 'Bash' },
      result: textResult('boom'),
      isError: true,
    });
    expect(out).toBeUndefined();
  });

  it('leaves results untouched when working tags are disabled', async () => {
    const { hook } = buildLoopWithHook({ workingTags: { enabled: false } });
    const out = await hook({
      toolCall: { name: 'Bash' },
      result: textResult('output'),
      isError: false,
    });
    expect(out).toBeUndefined();
  });

  it('leaves results untouched by default (working tags are off)', async () => {
    const { hook } = buildLoopWithHook({ workingTags: undefined });
    const out = await hook({
      toolCall: { name: 'Bash' },
      result: textResult('output'),
      isError: false,
    });
    expect(out).toBeUndefined();
  });
});

describe('setToolResultInterceptor', () => {
  it('suppresses the reminder appendix when the interceptor asks', async () => {
    const { loop, hook } = buildLoopWithHook();
    loop.setToolResultInterceptor(() => ({ suppressWorkingTagsReminder: true }));
    const out = await hook({
      toolCall: { name: 'spawn_task' },
      result: textResult('Task started.'),
      isError: false,
    });
    // Nothing to override: bare receipt passes through untouched.
    expect(out).toBeUndefined();
  });

  it('overrides terminate to false, forcing a follow-up turn', async () => {
    const { loop, hook } = buildLoopWithHook();
    loop.setToolResultInterceptor(() => ({
      terminate: false,
      suppressWorkingTagsReminder: true,
    }));
    const out = await hook({
      toolCall: { name: 'spawn_task' },
      result: textResult('Task started.'),
      isError: false,
    });
    // pi merges afterResult.terminate ?? result.terminate, so an explicit
    // false here beats the tool's terminate: true.
    expect(out).toEqual({ terminate: false });
  });

  it('replaces content and still appends the reminder when not suppressed', async () => {
    const { loop, hook } = buildLoopWithHook();
    loop.setToolResultInterceptor(() => ({ content: 'replaced' }));
    const out = await hook({
      toolCall: { name: 'Bash' },
      result: textResult('original'),
      isError: false,
    });
    expect(out!.content).toBe('replaced' + REMINDER);
  });

  it('receives the assistant message, args, and error flag', async () => {
    const { loop, hook } = buildLoopWithHook();
    const seen: unknown[] = [];
    loop.setToolResultInterceptor((info) => {
      seen.push(info);
      return undefined;
    });
    const assistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] };
    await hook({
      toolCall: { name: 'steer_task' },
      assistantMessage,
      args: { message: 'go north' },
      result: textResult('Redirect sent.'),
      isError: false,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      toolName: 'steer_task',
      assistantMessage,
      args: { message: 'go north' },
      isError: false,
    });
  });

  it('is consulted for error results too (reminder still skipped)', async () => {
    const { loop, hook } = buildLoopWithHook();
    const interceptor = vi.fn<ToolResultInterceptor>(() => undefined);
    loop.setToolResultInterceptor(interceptor);
    const out = await hook({
      toolCall: { name: 'Bash' },
      result: textResult('boom'),
      isError: true,
    });
    expect(interceptor).toHaveBeenCalledTimes(1);
    expect(out).toBeUndefined();
  });

  it('swallows a throwing interceptor and keeps the reminder path intact', async () => {
    const { loop, hook } = buildLoopWithHook();
    loop.setToolResultInterceptor(() => {
      throw new Error('interceptor bug');
    });
    const out = await hook({
      toolCall: { name: 'Bash' },
      result: textResult('output'),
      isError: false,
    });
    // The throw must not produce an error result (pi's error results omit
    // terminate); the normal reminder path proceeds.
    const blocks = out!.content as Array<{ type: string; text: string }>;
    expect(blocks[1]!.text).toBe(REMINDER);
  });

  it('swallows a throwing consumer logger inside the interceptor catch (N5)', async () => {
    // The catch for a throwing interceptor reports through the consumer's
    // logger; if that logger also throws, the error must not escape
    // afterToolCall (pi would wrap it into an error result without
    // terminate, the exact D17 shape the catch exists to prevent).
    const { loop, hook } = buildLoopWithHook({
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {
          throw new Error('logger bug');
        },
      },
    });
    loop.setToolResultInterceptor(() => {
      throw new Error('interceptor bug');
    });
    const out = await hook({
      toolCall: { name: 'Bash' },
      result: textResult('output'),
      isError: false,
    });
    // Both throws swallowed; the normal reminder path proceeds.
    const blocks = out!.content as Array<{ type: string; text: string }>;
    expect(blocks[1]!.text).toBe(REMINDER);
  });

  it('is removable with null', async () => {
    const { loop, hook } = buildLoopWithHook();
    const interceptor = vi.fn<ToolResultInterceptor>(() => ({
      suppressWorkingTagsReminder: true,
    }));
    loop.setToolResultInterceptor(interceptor);
    loop.setToolResultInterceptor(null);
    const out = await hook({
      toolCall: { name: 'Bash' },
      result: textResult('output'),
      isError: false,
    });
    expect(interceptor).not.toHaveBeenCalled();
    expect(out!.content).toBeDefined();
  });
});
