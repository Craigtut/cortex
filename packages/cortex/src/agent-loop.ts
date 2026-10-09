/**
 * AgentLoop: production-grade wrapper for pi-agent-core's Agent, and the
 * loop primitive CortexAgent composes.
 *
 * The class is the public surface and the orchestration seam. Its
 * behavior lives in the modules under ./agent-loop/, wired together by
 * assembly.ts; the documented contract of each public member lives on the
 * slice interfaces in ./agent-loop/api/ that this class implements.
 *
 * Lifecycle: CREATED -> ACTIVE (first prompt()) -> DESTROYED (destroy()).
 *
 * Reference: cortex-architecture.md
 */

import type { BudgetGuard } from './budget-guard.js';
import type { DirectCompletionContext } from './cache-breakpoints.js';
import type { CompactionManager } from './compaction/index.js';
import type { ObservationalMemoryState, ObservationEvent, ReflectionEvent } from './compaction/observational/types.js';
import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentContext, AgentMessage, ContextManager } from './context-manager.js';
import { classifyError } from './error-classifier.js';
import type { EventBridge } from './event-bridge.js';
import type { McpClientManager } from './mcp-client.js';
import type { CortexModel } from './model-wrapper.js';
import { NOOP_LOGGER } from './noop-logger.js';
import { withPlaceholderContent } from './pi-message.js';
import { isSystemMessage, spliceHistory } from './system-transcript.js';
import type { SkillRegistry } from './skill-registry.js';
import type { SubAgentManager } from './sub-agent-manager.js';
import type { CortexTool } from './tool-contract.js';
import type {
  AgentLoopConfig,
  AgentTextOutput,
  ClassifiedError,
  CompactionDegradedInfo,
  CompactionExhaustedInfo,
  CompactionResult,
  CompactionTarget,
  CortexLifecycleState,
  CortexLogger,
  CortexUsage,
  DeadLetteredBackgroundResult,
  LoadedSkill,
  LoopOriginContext,
  McpConnectionState,
  McpToolCallProgress,
  McpTransportConfig,
  ModelThinkingCapabilities,
  PendingAsk,
  RetryExhaustedInfo,
  RetryScheduledInfo,
  RetrySucceededInfo,
  SessionUsage,
  SubAgentSnapshot,
  SubAgentSpawnConfig,
  ThinkingLevel,
} from './types.js';
import { DEFAULT_LOOP_PATH } from './types.js';
import type { LoopCompletionApi } from './agent-loop/api/completions.js';
import type { LoopContextApi } from './agent-loop/api/context.js';
import type { LoopDeliveryApi } from './agent-loop/api/delivery.js';
import type { LoopEventApi } from './agent-loop/api/events.js';
import type { LoopModelApi } from './agent-loop/api/models.js';
import type { LoopPromptApi } from './agent-loop/api/prompt.js';
import type { LoopRunApi, LoopRunInfo, PromptOptions } from './agent-loop/api/run.js';
import type { LoopSubAgentApi } from './agent-loop/api/sub-agents.js';
import type { LoopToolApi } from './agent-loop/api/tools.js';
import { assembleLoop } from './agent-loop/assembly.js';
import type { LoopParts } from './agent-loop/assembly.js';
import { CHILD_SEED_CONTEXT_SLOT, prepareChildLoop } from './agent-loop/child-loop-config.js';
import type { ChildLoopParams } from './agent-loop/child-loop-config.js';
import type { IdleDigestionOptions, IdleDigestionResult } from './agent-loop/context-pipeline.js';
import type { DeliverOptions, DeliverResult, PendingWakeDelivery } from './agent-loop/api/delivery.js';
import type { DirectCompletionOptions } from './agent-loop/direct-completion.js';
import { mirrorChildPermissionResolver } from './agent-loop/permissions.js';
import {
  clampToSupported,
  fromPiThinkingLevel,
  modelThinkingCapabilities,
  toPiThinkingLevel,
} from './agent-loop/pi-agent.js';
import type {
  AgentLoopConstructorOptions,
  ManagedLoopParams,
  PiAgent,
  QueueDrainMode,
  RegisteredTool,
} from './agent-loop/pi-agent.js';
import { buildPiAgentConfig, loadAgentClass, wirePiTransformContext } from './agent-loop/pi-hooks.js';
import type { PiHookHost, ToolResultInterceptor } from './agent-loop/pi-hooks.js';
import { isAbortShapedError } from './agent-loop/run-control.js';

export type { PiAgent, PiModel, QueueDrainMode } from './agent-loop/pi-agent.js';
export type { DirectCompletionOptions } from './agent-loop/direct-completion.js';
export type {
  DeliverOptions,
  DeliverOutcome,
  DeliverResult,
  PendingWakeDelivery,
} from './agent-loop/api/delivery.js';
export type { LoopRunInfo, PromptOptions } from './agent-loop/api/run.js';
// The public surface by concern, for dependents that need one slice of it.
export type {
  LoopCompletionApi,
  LoopContextApi,
  LoopDeliveryApi,
  LoopEventApi,
  LoopModelApi,
  LoopPromptApi,
  LoopRunApi,
  LoopSubAgentApi,
  LoopToolApi,
};
export type { IdleDigestionOptions, IdleDigestionResult } from './agent-loop/context-pipeline.js';
export { TOOL_RESULT_WORKING_TAGS_REMINDER } from './agent-loop/pi-hooks.js';
export type {
  ToolResultInterceptor,
  ToolResultInterceptorInfo,
  ToolResultInterceptorResult,
} from './agent-loop/pi-hooks.js';

/**
 * Legacy fallback for unknown capacity. Explicit budgets have no minimum floor.
 */
export { MINIMUM_CONTEXT_WINDOW } from './context-budget.js';

/** Prefix every message with the loop's path so concurrent loops stay distinguishable in shared logs. */
function prefixLoggerWithLoopPath(logger: CortexLogger, loopPath: string): CortexLogger {
  const prefix = `[AgentLoop:${loopPath}]`;
  return {
    debug: (message, data) => logger.debug(`${prefix} ${message}`, data),
    info: (message, data) => logger.info(`${prefix} ${message}`, data),
    warn: (message, data) => logger.warn(`${prefix} ${message}`, data),
    error: (message, data) => logger.error(`${prefix} ${message}`, data),
  };
}

export class AgentLoop implements
  LoopRunApi,
  LoopDeliveryApi,
  LoopContextApi,
  LoopPromptApi,
  LoopModelApi,
  LoopCompletionApi,
  LoopToolApi,
  LoopSubAgentApi,
  LoopEventApi {
  private readonly agent: PiAgent;
  private readonly config: AgentLoopConfig;
  private readonly logger: CortexLogger;
  readonly loopPath: string;
  private workingTagsEnabled: boolean;
  /** The loop's modules, wired by assembly.ts. */
  private readonly parts: LoopParts;

  /**
   * Create an AgentLoop. Prefer AgentLoop.create().
   *
   * @param agent - A pi-agent-core Agent instance
   * @param config - AgentLoop configuration
   * @throws Error if the utility model violates the same-provider constraint
   */
  private constructor(
    agent: PiAgent,
    config: AgentLoopConfig,
    tools?: RegisteredTool[],
    options?: AgentLoopConstructorOptions,
  ) {
    this.agent = agent;
    this.config = config;
    this.loopPath = config.loopPath ?? DEFAULT_LOOP_PATH;
    this.logger = prefixLoggerWithLoopPath(config.logger ?? NOOP_LOGGER, this.loopPath);
    this.workingTagsEnabled = config.workingTags?.enabled ?? false;
    this.parts = assembleLoop({
      agent,
      config,
      tools,
      options,
      loopPath: this.loopPath,
      logger: this.logger,
      // Resolved per call, so a spy or stand-in on the loop's own method
      // sees every internal use too.
      host: {
        workingTagsEnabled: () => this.workingTagsEnabled,
        prompt: (input, promptOptions) => this.prompt(input, promptOptions),
        refreshTools: () => this.refreshTools(),
        directComplete: (context, completeOptions) => this.directComplete(context, completeOptions),
        utilityComplete: (context, completeOptions) => this.utilityComplete(context, completeOptions),
        isAborted: () => this.isAborted(),
        emitError: (error, wasAborted) => this.emitError(error, wasAborted),
        getConversationHistory: () => this.loopHistory(),
        getTransformContextHook: () => this.getTransformContextHook(),
        createChildAgent: (params) => this.createChildAgent(params),
      },
    });
    if (typeof config.initialBasePrompt === 'string') {
      this.setBasePrompt(config.initialBasePrompt);
    }
  }

  // -----------------------------------------------------------------------
  // Construction (static factory)
  // -----------------------------------------------------------------------

  /**
   * Create an AgentLoop with a pi-agent-core Agent constructed internally,
   * so consumers never import pi-agent-core themselves.
   *
   * @param config - AgentLoop configuration (model, tools, options)
   * @returns A new AgentLoop wrapping an internally-created pi-agent-core Agent
   * @throws Error if pi-agent-core or pi-ai is not installed
   */
  static async create(config: AgentLoopConfig & {
    /**
     * Additional consumer-provided tools to register alongside the built-in tools.
     * Built-in tools (Read, Write, Edit, Glob, Grep, Bash, WebFetch, TaskOutput)
     * are registered automatically. Tools passed here must use Cortex's
     * execute(params, context?) contract. Wrap raw pi-agent-core tools with
     * fromPiAgentTool() before passing them to AgentLoop.create().
     */
    tools?: CortexTool[];
    /**
     * Whether to auto-register the SubAgent tool. Default true. Set false
     * for a loop that must not spawn; with disableTools it has no built-ins.
     */
    enableSubAgentTool?: boolean;
    /** Whether to auto-register the load_skill tool. Default true. */
    enableLoadSkillTool?: boolean;
  }): Promise<AgentLoop> {
    const params: ManagedLoopParams = {
      cortexConfig: config,
      missingDependencyMessage:
        'AgentLoop.create() requires @earendil-works/pi-agent-core to be installed. ' +
        'Install it as a dependency or peer dependency.',
    };
    if (config.tools) params.tools = config.tools;
    if (config.initialBasePrompt !== undefined) params.initialBasePrompt = config.initialBasePrompt;
    if (config.enableSubAgentTool !== undefined || config.enableLoadSkillTool !== undefined) {
      params.constructorOptions = {
        ...(config.enableSubAgentTool !== undefined ? { enableSubAgentTool: config.enableSubAgentTool } : {}),
        ...(config.enableLoadSkillTool !== undefined ? { enableLoadSkillTool: config.enableLoadSkillTool } : {}),
      };
    }
    return AgentLoop.createManagedAgent(params);
  }

  /** Build a pi Agent and the loop that owns it (create() and sub-agent spawning). */
  private static async createManagedAgent(params: ManagedLoopParams): Promise<AgentLoop> {
    const { cortexConfig, initialBasePrompt, initialSystemPrompt } = params;
    const AgentClass = await loadAgentClass(params.missingDependencyMessage);
    // The Agent is built before the loop that owns it; its hooks resolve
    // the loop through this holder once it exists.
    const cacheBreakpointState = { agentLoop: null as AgentLoop | null };
    const piAgent = new AgentClass(AgentLoop.buildPiAgentConfig({
      cortexConfig,
      cacheBreakpointState,
    }));
    const agentLoop = new AgentLoop(piAgent, cortexConfig, params.tools ?? [], params.constructorOptions);
    cacheBreakpointState.agentLoop = agentLoop;
    AgentLoop.wireManagedPiAgent(agentLoop, piAgent);

    if (typeof initialBasePrompt === 'string') {
      agentLoop.setBasePrompt(initialBasePrompt);
    } else if (typeof initialSystemPrompt === 'string' && initialSystemPrompt.trim()) {
      agentLoop.parts.systemPrompt.apply(initialSystemPrompt);
    }
    return agentLoop;
  }

  private static buildPiAgentConfig(params: {
    cortexConfig: AgentLoopConfig;
    cacheBreakpointState: { agentLoop: AgentLoop | null };
  }): Record<string, unknown> {
    const { cacheBreakpointState } = params;
    return buildPiAgentConfig({
      cortexConfig: params.cortexConfig,
      host: () => cacheBreakpointState.agentLoop?.piHookHost() ?? null,
    });
  }

  private static wireManagedPiAgent(agentLoop: AgentLoop, piAgent: PiAgent): void {
    wirePiTransformContext(piAgent, agentLoop.getTransformContextHook());
  }

  /** The loop as pi's hooks see it (see pi-hooks.ts). */
  private piHookHost(): PiHookHost {
    const { parts } = this;
    return {
      isToolPermissionExempt: (toolName) => this.isToolPermissionExempt(toolName),
      asks: parts.asks,
      streamOptions: () => ({
        retention: parts.runner.activeCacheRetention ?? parts.models.cacheRetention ?? null,
        sessionId: parts.models.sessionId ?? null,
      }),
      syncActiveLoopTools: (ctx) => parts.tools.syncActiveLoopTools(ctx),
      syncSystemTranscript: (transcript) => {
        parts.systemPrompt.syncTranscript(transcript);
      },
      finalizer: parts.finalizer,
      cacheBreakpointIndices: () => parts.pipeline.cacheBreakpointIndices,
    };
  }

  // -----------------------------------------------------------------------
  // Running turns (LoopRunApi)
  // -----------------------------------------------------------------------

  async prompt(input: string, options?: PromptOptions): Promise<unknown> {
    const { lifecycle, gate, abortState, runner } = this.parts;
    lifecycle.assertNotShuttingDown();
    if (!this.parts.systemPrompt.isConfigured()) {
      throw new Error(
        'AgentLoop prompt is not configured. Call setBasePrompt() before prompt(), ' +
        'or provide initialBasePrompt during creation.',
      );
    }
    if (gate.isActive) {
      // A re-prompt chained synchronously on a resolved prompt() can hit a
      // still-queued no-op drain task; it clears after one macrotask.
      throw new Error(
        'Agent is already processing a prompt. Use steer() to inject input into ' +
        'the running loop, or wait for the current turn to complete.',
      );
    }
    // Renew synchronously so a same-frame abort() lands on this turn's
    // controller (see "Loop gate, turn unwind, abort epoch").
    abortState.renewIfAborted();
    return gate.enqueue(() => runner.runCycle(input, options));
  }

  get isLoopActive(): boolean { return this.parts.gate.isActive; }
  get isPrompting(): boolean { return this.parts.runner.isPrompting; }
  get currentRun(): LoopRunInfo | null { return this.parts.runner.currentRun; }
  get lastRunEndedAt(): number | null { return this.parts.runner.lastRunEndedAt; }
  get activeRunCauseTags(): readonly unknown[] { return this.parts.runner.activeCauseTags; }
  async waitForLoopIdle(): Promise<void> { return this.parts.gate.waitForIdle(); }
  get isRunning(): boolean { return this.parts.lifecycle.state === 'active' && this.parts.runner.isPrompting; }
  get state(): CortexLifecycleState { return this.parts.lifecycle.state; }
  get prePromptMessageCount(): number { return this.parts.runner.boundary; }
  async digestIdle(options?: IdleDigestionOptions): Promise<IdleDigestionResult> {
    return this.parts.pipeline.digest(options);
  }
  async abort(): Promise<void> { return this.parts.lifecycle.abort(); }
  async destroy(timeoutMs = 8000): Promise<void> { return this.parts.lifecycle.destroy(timeoutMs); }

  // -----------------------------------------------------------------------
  // Delivery and permission asks (LoopDeliveryApi)
  // -----------------------------------------------------------------------

  steer(message: string): void { this.parts.queues.steer(message); }
  deliver(content: string, options?: DeliverOptions): DeliverResult & { readonly deliveryId: string } {
    return this.parts.queues.deliver(content, options);
  }
  followUp(message: string): void { this.parts.queues.followUp(message); }
  setSteeringQueueMode(mode: QueueDrainMode): void { this.parts.queues.setSteeringQueueMode(mode); }
  setFollowUpQueueMode(mode: QueueDrainMode): void { this.parts.queues.setFollowUpQueueMode(mode); }
  clearSteeringQueue(): void { this.parts.queues.clearSteeringQueue(); }
  clearFollowUpQueue(): void { this.parts.queues.clearFollowUpQueue(); }
  clearAllQueues(): string[] { return this.parts.queues.clearAll(); }
  get queuedDeliveryCount(): number { return this.parts.queues.silentCount; }
  get pendingWakeDeliveryCount(): number { return this.parts.queues.wakeCount; }
  async waitForWakeDeliveriesDrained(): Promise<void> { return this.parts.queues.waitForWakeDrained(); }
  clearQueuedDeliveries(): string[] { return this.parts.queues.clearSilent(); }
  getQueuedDeliveries(): string[] { return this.parts.queues.silentContents(); }
  dropPendingWakeDeliveries(predicate: (content: string, delivery: PendingWakeDelivery) => boolean): string[] {
    return this.parts.queues.dropWake(predicate);
  }
  getPendingAsks(): PendingAsk[] { return this.parts.asks.list(); }
  markAskVoiced(askId: string): boolean { return this.parts.asks.markVoiced(askId); }
  async waitForAskSettlement(): Promise<void> { return this.parts.asks.waitForSettlement(); }

  // -----------------------------------------------------------------------
  // Context, compaction, observational memory (LoopContextApi)
  // -----------------------------------------------------------------------

  getContextManager(): ContextManager { return this.parts.contextManager; }

  getConversationHistory(): PiAgentMessage[] {
    return this.loopHistory() as PiAgentMessage[];
  }

  /**
   * Everything after the slots, system messages included: they declare the
   * prompt and tools in effect at their point, and the observational
   * watermark counts them. A restore replays them; the loop then patches
   * the prompt and pi the tools to what is live now. The transcript is pi's;
   * the loop's internals read it through the looser view in
   * context-manager.ts, and this and restoreConversationHistory() are where
   * the two meet.
   */
  private loopHistory(): AgentMessage[] {
    return this.agent.state.messages.slice(this.parts.contextManager.historyStart);
  }

  restoreConversationHistory(history: PiAgentMessage[]): void {
    const messages = history as AgentMessage[];
    const { compactionManager, contextManager } = this.parts;
    // Replace everything after the slots, folding the replaced history's
    // system messages into the head so the transcript still declares the
    // loop's tools. Empty turn content gets a placeholder and messages
    // without a timestamp are stamped now.
    const now = Date.now();
    spliceHistory(
      this.agent.state.messages,
      contextManager.historyStart,
      messages.map((msg) => {
        const patched = isSystemMessage(msg) ? msg : withPlaceholderContent(msg);
        return patched.timestamp == null ? { ...patched, timestamp: now } : patched;
      }),
    );
    // Observational memory described the replaced history: its watermark
    // indexes into it and its log summarizes it. Start empty; a restore with
    // memory follows with restoreObservationalMemoryState().
    compactionManager.resetObservationalMemory();
    compactionManager.invalidateContextTokenCount();
    if (compactionManager.strategy === 'observational') {
      contextManager.setSlot('_observations', '');
    }
  }

  setHeadlineProvider(provider: (() => string | null) | null, options?: { maxTokens?: number }): void {
    this.parts.pipeline.headline.set(provider, options);
  }
  getTransformContextHook(): (context: AgentContext) => Promise<AgentContext> { return this.parts.pipeline.hook(); }
  estimateCurrentContextTokens(): number { return this.parts.pipeline.estimateTokens(); }
  updateCurrentContextTokenCount(inputTokens: number): void {
    this.parts.compactionManager.updateCurrentContextTokenCount(inputTokens);
  }
  get currentContextTokenCount(): number { return this.parts.compactionManager.currentContextTokenCount; }
  setLastInteractionTime(timestamp: number): void { this.parts.compactionManager.setLastInteractionTime(timestamp); }
  capToolResult(content: string): string { return this.parts.compactionManager.capToolResult(content); }
  getCompactionManager(): CompactionManager { return this.parts.compactionManager; }

  async checkAndRunCompaction(): Promise<CompactionResult | null> {
    return this.parts.compactionManager.checkAndRunCompaction(
      () => this.loopHistory(),
      (history) => this.parts.pipeline.writeSource(history),
    );
  }

  getObservationalMemoryState(): ObservationalMemoryState | null {
    return this.parts.compactionManager.getObservationalMemoryState();
  }

  restoreObservationalMemoryState(state: ObservationalMemoryState): void {
    const { compactionManager, contextManager } = this.parts;
    // History is restored first, so the post-slot length is what the
    // buffer watermark must align with.
    const historyLength = Math.max(0, this.agent.state.messages.length - contextManager.historyStart);
    compactionManager.restoreObservationalMemoryState(state, historyLength);
    // Fill the slot only for real observations (its content always has a
    // preamble). The observer catches up on the next turn_end.
    if (compactionManager.hasObservations()) {
      contextManager.setSlot('_observations', compactionManager.getObservationSlotContent());
    }
  }

  async triggerObservation(): Promise<void> {
    const { compactionManager, contextManager } = this.parts;
    await compactionManager.triggerObservation(this.agent.state.messages, contextManager.historyStart);
    const slotContent = compactionManager.getObservationSlotContent();
    if (slotContent) contextManager.setSlot('_observations', slotContent);
  }

  onObservation(handler: (event: ObservationEvent, origin: LoopOriginContext) => void): void {
    this.parts.compactionManager.onObservation((event) => handler(event, this.parts.origin));
  }
  onReflection(handler: (event: ReflectionEvent, origin: LoopOriginContext) => void): void {
    this.parts.compactionManager.onReflection((event) => handler(event, this.parts.origin));
  }
  onBeforeCompaction(handler: (target: CompactionTarget, origin: LoopOriginContext) => Promise<void>): void {
    this.parts.compactionManager.onBeforeCompaction((target) => handler(target, this.parts.origin));
  }
  onPostCompaction(handler: (result: CompactionResult, origin: LoopOriginContext) => void): void {
    this.parts.compactionManager.onPostCompaction((result) => handler(result, this.parts.origin));
  }
  onCompactionError(handler: (error: Error, origin: LoopOriginContext) => void): void {
    this.parts.compactionManager.onCompactionError((error) => handler(error, this.parts.origin));
  }
  onCompactionDegraded(handler: (info: CompactionDegradedInfo, origin: LoopOriginContext) => void): void {
    this.parts.compactionManager.onCompactionDegraded((info) => handler(info, this.parts.origin));
  }
  onCompactionExhausted(handler: (info: CompactionExhaustedInfo, origin: LoopOriginContext) => void): void {
    this.parts.compactionManager.onCompactionExhausted((info) => handler(info, this.parts.origin));
  }

  // -----------------------------------------------------------------------
  // System prompt (LoopPromptApi)
  // -----------------------------------------------------------------------

  composeSystemPrompt(basePrompt: string): string { return this.parts.systemPrompt.compose(basePrompt); }
  setBasePrompt(basePrompt: string): string { return this.parts.systemPrompt.setBase(basePrompt); }
  getBasePrompt(): string { return this.parts.systemPrompt.base() ?? ''; }
  getCurrentSystemPrompt(): string { return this.parts.systemPrompt.current(); }
  getSystemPromptSections(): Array<{ name: string; content: string }> { return this.parts.systemPrompt.sections(); }
  get isWorkingTagsEnabled(): boolean { return this.workingTagsEnabled; }

  setWorkingTagsEnabled(enabled: boolean): void {
    if (this.workingTagsEnabled === enabled) return;
    this.workingTagsEnabled = enabled;
    this.parts.eventBridge.setWorkingTagsEnabled(enabled);
    const base = this.parts.systemPrompt.base();
    if (base !== null) this.setBasePrompt(base);
  }

  // -----------------------------------------------------------------------
  // Models and settings (LoopModelApi)
  // -----------------------------------------------------------------------

  getModel(): CortexModel { return this.parts.models.primary; }
  getUtilityModel(): CortexModel { return this.parts.models.utility; }
  getAutoResolvedUtilityModel(): CortexModel { return this.parts.models.autoResolvedUtility(); }
  setModel(model: CortexModel): void { this.parts.models.setModel(model); }
  setUtilityModel(model: CortexModel): void { this.parts.models.setUtilityModel(model); }
  resetUtilityModel(): void { this.parts.models.resetUtilityModel(); }
  isUtilityModelOverridden(): boolean { return this.parts.models.isUtilityOverridden; }

  setThinkingLevel(level: ThinkingLevel): void {
    (this.agent.state as Record<string, unknown>)['thinkingLevel'] = toPiThinkingLevel(level);
  }

  getThinkingLevel(): ThinkingLevel {
    const piLevel = (this.agent.state as Record<string, unknown>)['thinkingLevel'];
    if (typeof piLevel !== 'string') return 'medium';
    return fromPiThinkingLevel(piLevel) ?? 'medium';
  }

  async getModelThinkingCapabilities(): Promise<ModelThinkingCapabilities> {
    return modelThinkingCapabilities(this.parts.models.primaryPi);
  }

  async clampThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> {
    const caps = await this.getModelThinkingCapabilities();
    return clampToSupported(level, caps.supportedLevels);
  }

  setCacheRetention(value: 'none' | 'short' | 'long'): void { this.parts.models.setCacheRetention(value); }
  getCacheRetention(): 'none' | 'short' | 'long' | null { return this.parts.models.cacheRetention; }
  setSessionId(value: string | null): void { this.parts.models.setSessionId(value); }
  getSessionId(): string | null { return this.parts.models.sessionId; }
  setContextWindow(contextWindow: number): void { this.parts.models.setContextWindow(contextWindow); }
  setContextWindowLimit(limit: number | null): void { this.parts.models.setContextWindowLimit(limit); }
  get contextWindowLimit(): number | null { return this.parts.models.contextWindowLimit; }
  get effectiveContextWindow(): number { return this.parts.compactionManager.contextWindow; }
  get modelContextWindow(): number { return this.parts.compactionManager.modelContextWindow; }

  // -----------------------------------------------------------------------
  // Direct completions and usage (LoopCompletionApi)
  // -----------------------------------------------------------------------

  async directComplete(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string> {
    return this.parts.completions.direct(context, options);
  }

  async structuredComplete(
    context: DirectCompletionContext,
    schema: unknown,
    toolName: string = 'structured_output',
    toolDescription: string = 'Produce structured output',
    options?: DirectCompletionOptions,
  ): Promise<Record<string, unknown> | null> {
    return this.parts.completions.structured(context, schema, toolName, toolDescription, options);
  }

  async utilityComplete(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string> {
    return this.parts.completions.utility(context, options);
  }

  getLastDirectUsage(): CortexUsage | null { return this.parts.usage.lastDirect; }
  getSessionUsage(): SessionUsage { return this.parts.usage.snapshot(); }
  restoreSessionUsage(usage: SessionUsage): void { this.parts.usage.restore(usage); }

  // -----------------------------------------------------------------------
  // Tools, MCP, skills (LoopToolApi)
  // -----------------------------------------------------------------------

  refreshTools(): void { this.parts.tools.refresh(); }
  isToolPermissionExempt(toolName: string): boolean { return this.parts.tools.isPermissionExempt(toolName); }
  addConsumerTool(tool: CortexTool): void { this.parts.tools.add(tool); }
  removeConsumerTool(toolName: string): void { this.parts.tools.remove(toolName); }
  setToolResultInterceptor(interceptor: ToolResultInterceptor | null): void {
    this.parts.finalizer.setInterceptor(interceptor);
  }
  getEnvOverrides(): Record<string, string> | undefined { return this.config.envOverrides; }
  getMcpClientManager(): McpClientManager { return this.parts.mcp.manager; }
  async connectMcpServer(serverName: string, config: McpTransportConfig): Promise<void> {
    await this.parts.mcp.manager.connect(serverName, config);
  }
  async disconnectMcpServer(serverName: string): Promise<void> {
    await this.parts.mcp.manager.disconnect(serverName);
  }
  getMcpServerStates(): McpConnectionState[] { return this.parts.mcp.manager.getConnectionStates(); }
  mcpConfigMatches(serverName: string, config: McpTransportConfig): boolean {
    return this.parts.mcp.manager.configMatches(serverName, config);
  }
  setMcpToolCallProgressHandler(handler: ((progress: McpToolCallProgress) => void) | undefined): void {
    this.parts.mcp.setProgressHandler(handler);
  }
  getMcpTools(): CortexTool[] { return this.parts.mcp.manager.getTools(); }
  getSkillRegistry(): SkillRegistry { return this.parts.skills.registry; }
  async loadSkill(name: string, args?: string): Promise<void> { await this.parts.skills.load(name, args); }
  clearSkillBuffer(): void { this.parts.skills.clear(); }
  getSkillBuffer(): LoadedSkill[] { return this.parts.skills.snapshot(); }
  setPreprocessorVariables(variables: Record<string, string>): void {
    this.parts.skills.registry.setPreprocessorVariables(variables);
  }
  setScriptContext(context: Record<string, unknown>): void { this.parts.skills.registry.setScriptContext(context); }

  // -----------------------------------------------------------------------
  // Sub-agents and background work (LoopSubAgentApi)
  // -----------------------------------------------------------------------

  getSubAgentManager(): SubAgentManager { return this.parts.subAgentManager; }
  async spawnBackgroundSubAgent(params: Omit<SubAgentSpawnConfig, 'background'>): Promise<{ taskId: string }> {
    return this.parts.subAgents.spawnBackgroundChecked(params);
  }
  async cancelSubAgent(taskId: string): Promise<boolean> { return this.parts.subAgents.cancel(taskId); }
  steerSubAgent(taskId: string, message: string): boolean { return this.parts.subAgents.steer(taskId, message); }
  getActiveSubAgents(): SubAgentSnapshot[] { return this.parts.subAgents.snapshots(); }
  onSubAgentSpawned(handler: (taskId: string, instructions: string, background: boolean) => void): void {
    this.parts.subAgents.spawnedHandlers.add(handler);
  }
  onSubAgentCompleted(handler: (taskId: string, result: string, status: string, usage: unknown) => void): void {
    this.parts.subAgents.completedHandlers.add(handler);
  }
  onSubAgentFailed(handler: (taskId: string, error: string) => void): void {
    this.parts.subAgents.failedHandlers.add(handler);
  }
  onBackgroundResultDelivery(handler: (taskIds: string[]) => void): void {
    this.parts.background.deliveryHandlers.add(handler);
  }
  onBackgroundResultDeadLettered(handler: (result: DeadLetteredBackgroundResult) => void): void {
    this.parts.deadLetters.handlers.add(handler);
  }
  getDeadLetteredBackgroundResults(): DeadLetteredBackgroundResult[] { return this.parts.deadLetters.list(); }

  /** Build a sub-agent's loop (the spawner's factory; tests stand in for it). */
  private async createChildAgent(params: ChildLoopParams): Promise<AgentLoop> {
    const { models, systemPrompt, tools } = this.parts;
    const { createParams, seedContext } = await prepareChildLoop(() => ({
      config: this.config,
      model: models.primary,
      workingTagsEnabled: this.workingTagsEnabled,
      contextWindowLimit: models.contextWindowLimit,
      loopPath: this.loopPath,
      prompt: { base: systemPrompt.base(), current: systemPrompt.current() },
      rawPersistResult: tools.rawPersistResult,
      resultThresholds: tools.resultThresholds,
      inheritableTools: (requested) => tools.childInheritable(requested),
      childResolver: (taskId) => this.config.resolvePermission
        ? this.wrapChildPermissionResolver(this.config.resolvePermission, taskId)
        : undefined,
      logger: this.logger,
    }), params);
    const childAgent = await AgentLoop.createManagedAgent(createParams);
    // Background context seeds the child's leading slot: reference material,
    // not its objective, positioned before history for prefix-cache stability.
    if (seedContext) {
      childAgent.getContextManager().setSlot(CHILD_SEED_CONTEXT_SLOT, seedContext);
    }
    childAgent.setCacheRetention(this.getCacheRetention() ?? 'none');
    return childAgent;
  }

  /** The consumer's resolver as a child sees it: mirrored into this loop's asks. */
  private wrapChildPermissionResolver(
    parentResolver: NonNullable<AgentLoopConfig['resolvePermission']>,
    childTaskId: string,
  ): NonNullable<AgentLoopConfig['resolvePermission']> {
    return mirrorChildPermissionResolver(parentResolver, {
      asks: this.parts.asks,
      subAgents: this.parts.subAgentManager,
      childTaskId,
      childLoopPath: `${this.loopPath}/${childTaskId}`,
    });
  }

  // -----------------------------------------------------------------------
  // Events and errors (LoopEventApi)
  // -----------------------------------------------------------------------

  onLoopComplete(handler: (origin: LoopOriginContext) => void): void { this.parts.loopComplete.add(handler); }
  onError(handler: (error: ClassifiedError, origin: LoopOriginContext) => void): void {
    this.parts.errorHandlers.add(handler);
  }
  onRetryScheduled(handler: (info: RetryScheduledInfo, origin: LoopOriginContext) => void): void {
    this.parts.runner.retryScheduled.add(handler);
  }
  onRetrySucceeded(handler: (info: RetrySucceededInfo, origin: LoopOriginContext) => void): void {
    this.parts.runner.retrySucceeded.add(handler);
  }
  onRetryExhausted(handler: (info: RetryExhaustedInfo, origin: LoopOriginContext) => void): void {
    this.parts.runner.retryExhausted.add(handler);
  }
  onTurnComplete(handler: (output: AgentTextOutput, origin: LoopOriginContext) => void): void {
    this.parts.turnComplete.add(handler);
  }
  getEventBridge(): EventBridge { return this.parts.eventBridge; }
  getBudgetGuard(): BudgetGuard { return this.parts.budgetGuard; }

  /**
   * Classify an error and dispatch it to every onError handler. The single
   * channel for failures of the agentic loop and of the direct completion
   * paths alike, whichever phase produced them.
   */
  private emitError(error: Error, wasAborted?: boolean): ClassifiedError {
    const classified = classifyError(error, {
      wasAborted: wasAborted ?? this.isAborted(),
    });
    this.logger.warn('error', {
      category: classified.category,
      severity: classified.severity,
      message: classified.originalMessage,
      ...(classified.causeDetail ? { cause: classified.causeDetail } : {}),
    });
    this.parts.errorHandlers.emit(classified, this.parts.origin);
    return classified;
  }

  /**
   * Whether the current run was aborted (user or system cancellation): the
   * run's controller, or an abort-shaped error in pi's run state. Never
   * true for arbitrary errors.
   */
  private isAborted(): boolean {
    return this.parts.abortState.signal.aborted ||
      isAbortShapedError(this.agent.state as Record<string, unknown>);
  }
}
