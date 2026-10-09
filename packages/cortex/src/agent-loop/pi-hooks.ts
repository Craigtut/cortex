/**
 * The seam between AgentLoop and pi's Agent: the Agent's construction
 * config and the hooks Cortex runs inside pi's loop (stream options, the
 * pre-request system prompt sync, the permission gate, tool-result
 * finalization, and cache-breakpoint payload stamping), plus the public
 * tool-result interceptor contract.
 */

import type { Context, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { applyCacheBreakpoints } from '../cache-breakpoints.js';
import type { CacheBreakpointIndices } from '../cache-breakpoints.js';
import type { AgentContext, AgentMessage } from '../context-manager.js';
import { errorMessageOf } from '../error-classifier.js';
import { streamModelSimple } from '../model-runtime.js';
import { unwrapModel } from '../model-wrapper.js';
import type { AgentLoopConfig, CortexLogger } from '../types.js';
import { createBeforeToolCall } from './permissions.js';
import type { PermissionHost } from './permissions.js';
import { toPiThinkingLevel } from './pi-agent.js';
import type { CacheRetention, PiAgent, PiModel } from './pi-agent.js';

/**
 * Operational reminder appended to tool results when working tags are enabled.
 * Exported so consumers (e.g., cortex-code TUI) can strip it from display text.
 */
export const TOOL_RESULT_WORKING_TAGS_REMINDER = '[Do not narrate. If analyzing these results, use <working> tags. Only text outside <working> tags is shown to the user.]';

/**
 * What the owner-installed tool-result interceptor receives per finalized
 * tool call (see {@link AgentLoop.setToolResultInterceptor}).
 */
export interface ToolResultInterceptorInfo {
  toolName: string;
  /** Validated tool arguments as pi passed them to execute. */
  args: unknown;
  /**
   * The assistant message that carried this tool call (pi's message shape,
   * opaque). Lets an interceptor inspect the spoken text alongside the call.
   */
  assistantMessage: unknown;
  /** The finalized result (content in pi's block shape). */
  result: { content: unknown };
  isError: boolean;
}

/**
 * Overrides returned by a tool-result interceptor. Absent fields leave the
 * result untouched.
 */
export interface ToolResultInterceptorResult {
  /** Replacement result content (pi block shape or plain string). */
  content?: unknown;
  /**
   * Explicit override of the result's terminate flag. `false` suppresses a
   * tool-set `terminate: true`, forcing a follow-up turn; `true` ends the
   * batch after this call.
   */
  terminate?: boolean;
  /** Skip the working-tags reminder appendix for this result. */
  suppressWorkingTagsReminder?: boolean;
}

/** Owner-installed hook over finalized tool results. */
export type ToolResultInterceptor = (
  info: ToolResultInterceptorInfo,
) => ToolResultInterceptorResult | undefined | null;

/** What the hooks read off the loop that owns the agent. */
export interface PiHookHost extends PermissionHost {
  /** Cache retention and session key for the next provider request. */
  streamOptions(): { retention: CacheRetention | null; sessionId: string | null };
  syncActiveLoopTools(ctx: unknown): void;
  /** Write the loop's system prompt into pi's in-loop transcript before a request. */
  syncSystemTranscript(transcript: AgentMessage[]): void;
  finalizer: ToolResultFinalizer;
  cacheBreakpointIndices(): CacheBreakpointIndices | null;
}

export async function loadAgentClass(errorMessage: string): Promise<new (config: Record<string, unknown>) => PiAgent> {
  try {
    const piAgentCore = await import('@earendil-works/pi-agent-core');
    return piAgentCore.Agent as unknown as new (config: Record<string, unknown>) => PiAgent;
  } catch {
    throw new Error(errorMessage);
  }
}

/**
 * The config pi's Agent is constructed with. `host` is resolved per call
 * because the Agent is built before the loop that owns it exists. No
 * system prompt: the loop owns the transcript's system head and writes it
 * before each request (prepareRequest below).
 */
export function buildPiAgentConfig(params: {
  cortexConfig: AgentLoopConfig;
  host: () => PiHookHost | null;
}): Record<string, unknown> {
  const { cortexConfig, host } = params;
  const rawModel = unwrapModel(cortexConfig.model) as PiModel;
  const agentConfig: Record<string, unknown> = {
    initialState: {
      model: rawModel,
      tools: [],
      messages: [],
      ...(cortexConfig.thinkingLevel !== undefined && {
        thinkingLevel: toPiThinkingLevel(cortexConfig.thinkingLevel),
      }),
    },
    getApiKey: cortexConfig.getApiKey,
    toolExecution: cortexConfig.toolExecution ?? 'sequential',
  };

  const ambientCredentials = cortexConfig.ambientCredentials === true;
  agentConfig['streamFn'] = (model: PiModel, context: Context, options?: SimpleStreamOptions) => {
    const { retention, sessionId } = host()?.streamOptions() ?? { retention: null, sessionId: null };
    return streamModelSimple(model, context, {
      ...options,
      ...(retention ? { cacheRetention: retention } : {}),
      ...(sessionId ? { sessionId } : {}),
      ambientCredentials,
    });
  };

  // Runs before every provider request, the first included, after pi has
  // appended the request's queued messages and tool declarations. The
  // context is pi's live in-loop one, so writes here persist for the run;
  // the transform hook mirrors them into agent.state right after.
  agentConfig['prepareRequest'] = (request: { context: { messages: AgentMessage[] } }) => {
    host()?.syncSystemTranscript(request.context.messages);
    return undefined;
  };

  const beforeToolCall = createBeforeToolCall(cortexConfig, host);
  if (beforeToolCall) agentConfig['beforeToolCall'] = beforeToolCall;

  agentConfig['afterToolCall'] = async (ctx: unknown) => {
    const agent = host();
    if (!agent) return undefined;
    agent.syncActiveLoopTools(ctx);
    return agent.finalizer.finalize(ctx);
  };

  agentConfig['onPayload'] = async (payload: Record<string, unknown>, model: Record<string, unknown>) => {
    const agent = host();
    if (!agent) return undefined;

    const provider = (model as Record<string, unknown>)['provider'];
    if (provider !== 'anthropic') return undefined;

    const indices = agent.cacheBreakpointIndices();
    if (!indices) return undefined;

    return applyCacheBreakpoints(payload, indices);
  };

  return agentConfig;
}

/** Route pi's transformContext through the loop's composed hook. */
export function wirePiTransformContext(
  piAgent: PiAgent,
  hook: (context: AgentContext) => Promise<AgentContext>,
): void {
  piAgent.transformContext = async (messages: unknown[]) => {
    const result = await hook({
      systemPrompt: piAgent.state.systemPrompt ?? '',
      model: piAgent.state.model ?? null,
      messages: messages as AgentMessage[],
      tools: (piAgent.state.tools ?? []) as unknown[],
      thinkingLevel: typeof piAgent.state.thinkingLevel === 'string'
        ? piAgent.state.thinkingLevel
        : 'medium',
    });
    return result.messages;
  };
}

/**
 * Finalizes every executed tool result inside pi's afterToolCall: the
 * owner-installed interceptor first, then the working-tags reminder.
 */
export class ToolResultFinalizer {
  private interceptor: ToolResultInterceptor | null = null;

  constructor(private readonly ports: { workingTagsEnabled(): boolean; logger: CortexLogger }) {}

  setInterceptor(interceptor: ToolResultInterceptor | null): void {
    this.interceptor = interceptor;
  }

  finalize(ctx: unknown): { content?: unknown; terminate?: boolean } | undefined {
    const { toolCall, assistantMessage, args, result, isError } = ctx as {
      toolCall: { name: string };
      assistantMessage?: unknown;
      args?: unknown;
      result: { content: unknown };
      isError: boolean;
      context: unknown;
    };

    // Runs first so it can suppress the reminder (bare receipts, D17). A
    // throw is swallowed: pi turns afterToolCall failures into error results
    // without terminate, reopening the loop the interceptor exists to bound.
    let intercept: ToolResultInterceptorResult | undefined;
    if (this.interceptor) {
      try {
        intercept = this.interceptor({
          toolName: toolCall.name,
          args,
          assistantMessage,
          result,
          isError,
        }) ?? undefined;
      } catch (err) {
        // The consumer's logger is untrusted too: a throw here would
        // escape afterToolCall into the same D17 shape.
        try {
          this.ports.logger.error('tool result interceptor threw; ignoring', {
            toolName: toolCall.name,
            error: errorMessageOf(err),
          });
        } catch {
          // Nothing safe left to report to.
        }
      }
    }

    const override: { content?: unknown; terminate?: boolean } = {};
    if (intercept?.content !== undefined) override.content = intercept.content;
    if (intercept?.terminate !== undefined) override.terminate = intercept.terminate;

    if (
      this.ports.workingTagsEnabled() &&
      !isError &&
      intercept?.suppressWorkingTagsReminder !== true
    ) {
      const reminder = '\n\n' + TOOL_RESULT_WORKING_TAGS_REMINDER;
      const content = override.content ?? result.content;
      if (typeof content === 'string') {
        override.content = content + reminder;
      } else if (Array.isArray(content)) {
        override.content = [...content, { type: 'text', text: reminder }];
      }
    }

    return override.content !== undefined || override.terminate !== undefined
      ? override
      : undefined;
  }
}
