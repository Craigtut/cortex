/**
 * LoopSurface: the part of CortexAgent's public surface that is fully
 * determined by which loop owns it (docs/cortex/duplex/facade-api.md).
 *
 * CortexAgent exposes AgentLoop's public members so a consumer can switch
 * from a bare loop to the facade without relearning the API. Most of those
 * members mean the same thing on the facade as on a loop; what differs in a
 * multi-loop session is only WHICH loop answers. A {@link LoopTopology} says
 * that, and every member here reads it and nothing else: work-routed
 * members reach the reasoner, conversation-routed ones the loop the user
 * talks to, and resident fan-outs every resident loop. Members whose
 * behavior depends on more than the topology (prompt, deliver, setModel,
 * setBasePrompt, getPendingAsks, ...) are composite and live on CortexAgent
 * itself.
 *
 * The contract over AgentLoop's public surface is AGENT_LOOP_DELEGATION
 * (loop-delegation.ts); this class implements its topology-determined part.
 */

import type {
  AgentLoop,
  LoopCompletionApi,
  LoopContextApi,
  LoopDeliveryApi,
  LoopEventApi,
  LoopModelApi,
  LoopPromptApi,
  LoopRunApi,
} from '../agent-loop.js';

/**
 * The conversation loop as the facade reaches it: its queues, transcript,
 * events, run state, prompt, model and usage. Never its tools or
 * sub-agents: in duplex those are the talker's control toolset and nothing
 * the consumer surface may drive.
 */
export type ConversationLoop = LoopDeliveryApi & LoopContextApi & LoopEventApi & LoopRunApi
  & LoopPromptApi & LoopModelApi & LoopCompletionApi;

/** A resident loop as session-wide waits, triggers and fan-out settings reach it. */
export type ResidentLoop = LoopRunApi & LoopEventApi & LoopContextApi & LoopModelApi & LoopPromptApi;
import type {
  DirectCompletionOptions,
  IdleDigestionOptions,
  IdleDigestionResult,
  QueueDrainMode,
} from '../agent-loop.js';
import type { McpClientManager } from '../mcp-client.js';
import type { CompactionManager } from '../compaction/index.js';
import type { DirectCompletionContext } from '../cache-breakpoints.js';
import type {
  AgentTextOutput,
  ClassifiedError,
  CompactionDegradedInfo,
  CompactionExhaustedInfo,
  CompactionResult,
  CompactionTarget,
  CortexLifecycleState,
  CortexUsage,
  DeadLetteredBackgroundResult,
  LoadedSkill,
  LoopOriginContext,
  McpConnectionState,
  McpToolCallProgress,
  McpTransportConfig,
  ModelThinkingCapabilities,
  RetryExhaustedInfo,
  RetryScheduledInfo,
  RetrySucceededInfo,
  SubAgentSnapshot,
  SubAgentSpawnConfig,
  ThinkingLevel,
} from '../types.js';
import type { CortexTool } from '../tool-contract.js';
import type { CortexModel } from '../model-wrapper.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { BudgetGuard } from '../budget-guard.js';
import type { SkillRegistry } from '../skill-registry.js';
import type {
  MemoryErrorInfo,
  MemoryGapInfo,
  MemoryRecoveredInfo,
  ObservationEvent,
  ObservationalMemoryState,
  ReflectionEvent,
} from '../compaction/index.js';

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/** Which loop owns each surface of a session. */
export interface LoopTopology {
  /** The loop that does the work: the reasoner in both modes. */
  readonly work: AgentLoop;
  /** The loop the user talks to: the talker in duplex, the reasoner in passthrough. */
  readonly conversation: ConversationLoop;
  /** Every resident loop, work loop first. */
  readonly resident: readonly ResidentLoop[];
}

/** The topology of a session: one loop in passthrough, the pair in duplex. */
export function loopTopology(reasoner: AgentLoop, talker: AgentLoop | null): LoopTopology {
  return {
    work: reasoner,
    conversation: talker ?? reasoner,
    resident: talker ? [reasoner, talker] : [reasoner],
  };
}

// ---------------------------------------------------------------------------
// LoopSurface
// ---------------------------------------------------------------------------

/**
 * The forwarded members whose behavior the topology alone determines.
 * Getters stay getters, so the declaration surface is unchanged.
 */
export abstract class LoopSurface {
  protected readonly topology: LoopTopology;

  protected constructor(topology: LoopTopology) {
    this.topology = topology;
  }

  // Work-routed: prompt and model reads --------------------------------------

  getCurrentSystemPrompt(): string { return this.topology.work.getCurrentSystemPrompt(); }

  /**
   * Compose the full system prompt from a base prompt. Reasoner composition
   * in both modes; in duplex the talker appends its role prompt to the same
   * base (CONFIG_ROUTING initialBasePrompt: both loops in full).
   */
  composeSystemPrompt(basePrompt: string): string {
    return this.topology.work.composeSystemPrompt(basePrompt);
  }

  getSystemPromptSections(): Array<{ name: string; content: string }> {
    return this.topology.work.getSystemPromptSections();
  }

  getModel(): CortexModel { return this.topology.work.getModel(); }

  // Utility-model reads are per loop in duplex (CONFIG_ROUTING utilityModel:
  // per-loop); these report the reasoner's dial, matching the setters.
  getUtilityModel(): CortexModel { return this.topology.work.getUtilityModel(); }
  getAutoResolvedUtilityModel(): CortexModel { return this.topology.work.getAutoResolvedUtilityModel(); }
  isUtilityModelOverridden(): boolean { return this.topology.work.isUtilityModelOverridden(); }

  // Thinking is reasoner-only: the talker's model is different and its
  // thinking is fixed off.
  getThinkingLevel(): ThinkingLevel { return this.topology.work.getThinkingLevel(); }
  setThinkingLevel(level: ThinkingLevel): void { this.topology.work.setThinkingLevel(level); }

  async getModelThinkingCapabilities(): Promise<ModelThinkingCapabilities> { return this.topology.work.getModelThinkingCapabilities(); }
  async clampThinkingLevel(level: ThinkingLevel): Promise<ThinkingLevel> { return this.topology.work.clampThinkingLevel(level); }

  getCacheRetention(): 'none' | 'short' | 'long' | null { return this.topology.work.getCacheRetention(); }
  getSessionId(): string | null { return this.topology.work.getSessionId(); }

  // Work-routed: context window and token accounting -------------------------

  /** The configured limit. Identical on every resident loop; the clamp is per loop. */
  get contextWindowLimit(): number | null { return this.topology.work.contextWindowLimit; }
  get effectiveContextWindow(): number { return this.topology.work.effectiveContextWindow; }

  // Context-window values are per loop in duplex (each derived from its own
  // loop's model); the facade reports the reasoner's.
  get modelContextWindow(): number { return this.topology.work.modelContextWindow; }

  /**
   * Model metadata for the primary model, so reasoner only: the talker runs
   * a different model with its own window, set from its own metadata when
   * setModel() re-mirrors it.
   */
  setContextWindow(contextWindow: number): void { this.topology.work.setContextWindow(contextWindow); }

  get currentContextTokenCount(): number { return this.topology.work.currentContextTokenCount; }

  updateCurrentContextTokenCount(inputTokens: number): void { this.topology.work.updateCurrentContextTokenCount(inputTokens); }

  estimateCurrentContextTokens(): number { return this.topology.work.estimateCurrentContextTokens(); }
  capToolResult(content: string): string { return this.topology.work.capToolResult(content); }

  // Work-routed: direct completions ------------------------------------------

  async directComplete(
    context: DirectCompletionContext,
    options?: DirectCompletionOptions,
  ): Promise<string> {
    return this.topology.work.directComplete(context, options);
  }

  async structuredComplete(
    context: DirectCompletionContext,
    schema: unknown,
    toolName?: string,
    toolDescription?: string,
    options?: DirectCompletionOptions,
  ): Promise<Record<string, unknown> | null> {
    return this.topology.work.structuredComplete(context, schema, toolName, toolDescription, options);
  }

  async utilityComplete(
    context: DirectCompletionContext,
    options?: DirectCompletionOptions,
  ): Promise<string> {
    return this.topology.work.utilityComplete(context, options);
  }

  getLastDirectUsage(): CortexUsage | null { return this.topology.work.getLastDirectUsage(); }

  // Work-routed: tools, MCP, skills ------------------------------------------
  //
  // Consumer tools, MCP and skills project to the reasoner and its
  // sub-agents, never the talker (D5, facade-api.md routing table). In
  // duplex the MCP manager is the facade's shared one (one connection per
  // server total); in passthrough it is the reasoner's own.

  addConsumerTool(tool: CortexTool): void { this.topology.work.addConsumerTool(tool); }
  removeConsumerTool(toolName: string): void { this.topology.work.removeConsumerTool(toolName); }
  refreshTools(): void { this.topology.work.refreshTools(); }

  async connectMcpServer(serverName: string, config: McpTransportConfig): Promise<void> {
    return this.topology.work.connectMcpServer(serverName, config);
  }

  async disconnectMcpServer(serverName: string): Promise<void> { return this.topology.work.disconnectMcpServer(serverName); }

  getMcpServerStates(): McpConnectionState[] { return this.topology.work.getMcpServerStates(); }

  mcpConfigMatches(serverName: string, config: McpTransportConfig): boolean {
    return this.topology.work.mcpConfigMatches(serverName, config);
  }

  setMcpToolCallProgressHandler(handler: ((progress: McpToolCallProgress) => void) | undefined): void {
    this.topology.work.setMcpToolCallProgressHandler(handler);
  }

  getMcpClientManager(): McpClientManager { return this.topology.work.getMcpClientManager(); }
  getMcpTools(): CortexTool[] { return this.topology.work.getMcpTools(); }
  getSkillRegistry(): SkillRegistry { return this.topology.work.getSkillRegistry(); }

  async loadSkill(name: string, args?: string): Promise<void> { return this.topology.work.loadSkill(name, args); }

  clearSkillBuffer(): void { this.topology.work.clearSkillBuffer(); }
  getSkillBuffer(): LoadedSkill[] { return this.topology.work.getSkillBuffer(); }

  setPreprocessorVariables(variables: Record<string, string>): void {
    this.topology.work.setPreprocessorVariables(variables);
  }

  setScriptContext(context: Record<string, unknown>): void { this.topology.work.setScriptContext(context); }

  // Work-routed: sub-agents, asks, headlines ---------------------------------

  async spawnBackgroundSubAgent(params: Omit<SubAgentSpawnConfig, 'background'>): Promise<{ taskId: string }> {
    return this.topology.work.spawnBackgroundSubAgent(params);
  }

  async cancelSubAgent(taskId: string): Promise<boolean> { return this.topology.work.cancelSubAgent(taskId); }
  steerSubAgent(taskId: string, message: string): boolean { return this.topology.work.steerSubAgent(taskId, message); }

  getActiveSubAgents(): SubAgentSnapshot[] { return this.topology.work.getActiveSubAgents(); }

  getDeadLetteredBackgroundResults(): DeadLetteredBackgroundResult[] {
    return this.topology.work.getDeadLetteredBackgroundResults();
  }

  /**
   * Feed a consumer-built headline block into the reasoner's context (view
   * injection outside the cache boundary). In duplex the facade owns the
   * talker's headline block itself; this keeps the consumer capability on
   * the work loop in both modes.
   */
  setHeadlineProvider(
    provider: (() => string | null) | null,
    options?: { maxTokens?: number },
  ): void {
    this.topology.work.setHeadlineProvider(provider, options);
  }

  /**
   * The guard built from the consumer's `budgetGuard` config, in both modes:
   * what the caller configured is the only thing a `getMaxCost()` /
   * `isBreached()` read can be checked against. The duplex session's
   * aggregate guard is a different fact with its own scope and cap, and has
   * CortexAgent.getAggregateBudgetGuard().
   */
  getBudgetGuard(): BudgetGuard { return this.topology.work.getBudgetGuard(); }

  // Work-routed: memory, digestion, compaction, state ------------------------

  /**
   * The REASONER's observational state, in both modes.
   *
   * Deliberately not the conversation loop's, unlike
   * {@link getConversationHistory}: observational memory is what the agent
   * learned while working, and the reasoner is the loop that works. The
   * consequence to know about is that in duplex these two reads are no
   * longer an order-coupled pair, so they must not be assembled into a v1
   * artifact together (the watermark would align to the wrong history).
   * CortexAgent.getState() is the coherent composite and the only
   * supported persistence surface.
   */
  getObservationalMemoryState(): ObservationalMemoryState | null {
    return this.topology.work.getObservationalMemoryState();
  }

  async digestIdle(options?: IdleDigestionOptions): Promise<IdleDigestionResult> {
    return this.topology.work.digestIdle(options);
  }

  async checkAndRunCompaction(): Promise<CompactionResult | null> { return this.topology.work.checkAndRunCompaction(); }

  async triggerObservation(): Promise<void> { return this.topology.work.triggerObservation(); }

  /**
   * The reasoner's compaction manager. Each loop runs its own in duplex
   * (CONFIG_ROUTING compaction: both-loops).
   */
  getCompactionManager(): CompactionManager { return this.topology.work.getCompactionManager(); }

  get state(): CortexLifecycleState { return this.topology.work.state; }
  getEnvOverrides(): Record<string, string> | undefined { return this.topology.work.getEnvOverrides(); }
  get isWorkingTagsEnabled(): boolean { return this.topology.work.isWorkingTagsEnabled; }

  // Work-routed: sub-agent callbacks (the only loop that spawns) -------------

  onSubAgentSpawned(handler: (taskId: string, instructions: string, background: boolean) => void): void {
    this.topology.work.onSubAgentSpawned(handler);
  }

  onSubAgentCompleted(handler: (taskId: string, result: string, status: string, usage: unknown) => void): void {
    this.topology.work.onSubAgentCompleted(handler);
  }

  onSubAgentFailed(handler: (taskId: string, error: string) => void): void { this.topology.work.onSubAgentFailed(handler); }
  onBackgroundResultDelivery(handler: (taskIds: string[]) => void): void { this.topology.work.onBackgroundResultDelivery(handler); }

  onBackgroundResultDeadLettered(handler: (result: DeadLetteredBackgroundResult) => void): void {
    this.topology.work.onBackgroundResultDeadLettered(handler);
  }

  // Conversation-routed --------------------------------------------------------
  //
  // The pi queue surface targets the conversation loop: the single reasoner
  // in passthrough, the talker in duplex (directives reach the duplex
  // reasoner through the router, never through these).

  /** Queue a follow-up that drains at the run's would-stop point. */
  followUp(message: string): void { this.topology.conversation.followUp(message); }
  setSteeringQueueMode(mode: QueueDrainMode): void { this.topology.conversation.setSteeringQueueMode(mode); }
  setFollowUpQueueMode(mode: QueueDrainMode): void { this.topology.conversation.setFollowUpQueueMode(mode); }
  clearSteeringQueue(): void { this.topology.conversation.clearSteeringQueue(); }
  clearFollowUpQueue(): void { this.topology.conversation.clearFollowUpQueue(); }
  get queuedDeliveryCount(): number { return this.topology.conversation.queuedDeliveryCount; }
  get pendingWakeDeliveryCount(): number { return this.topology.conversation.pendingWakeDeliveryCount; }
  clearQueuedDeliveries(): string[] { return this.topology.conversation.clearQueuedDeliveries(); }
  getQueuedDeliveries(): string[] { return this.topology.conversation.getQueuedDeliveries(); }

  /**
   * The CONVERSATION loop's post-slot transcript: the talker in duplex, the
   * reasoner in passthrough.
   *
   * The name is the contract. In duplex the reasoner's transcript is the
   * WORK transcript, in which the user's own words appear only as
   * `<conversation-context>` fragments quoted inside dispatch messages, so a
   * consumer rendering or exporting "the conversation" from it got dispatch
   * scaffolding and directives instead of the dialogue. Both transcripts,
   * plus the log and per-loop usage, are on CortexAgent.getState().
   */
  getConversationHistory(): AgentMessage[] { return this.topology.conversation.getConversationHistory(); }

  /**
   * The CONVERSATION loop only, unlike the fan-out callbacks below.
   *
   * onTurnComplete is not a diagnostic: it is the "the assistant finished
   * saying something" signal consumers build user-visible output on (a TUI
   * finalizes the assistant bubble, a voice app speaks the text). In duplex
   * the reasoner's assistant text is internal working prose that reaches the
   * user only after the talker performs a delivery, so fanning out fires
   * twice per exchange and the reasoner's private text is one of the two.
   * The facade's own log producer already draws `reply` entries from the
   * talker alone; this is the same rule on the consumer surface.
   *
   * Diagnostics (onError, onRetryScheduled, the merged event bridge) stay
   * fanned out and loopPath-labeled: a consumer WANTS to see a reasoner
   * failure, and those surfaces carry the origin needed to tell the loops
   * apart. Passthrough is unchanged (the conversation loop is the reasoner).
   */
  onTurnComplete(handler: (output: AgentTextOutput, origin: LoopOriginContext) => void): void {
    this.topology.conversation.onTurnComplete(handler);
  }

  // Resident fan-out -----------------------------------------------------------

  /**
   * Cache retention is a provider-request policy, not a per-model dial, so
   * it reaches every resident loop. The talker's small cached prefix is
   * where retention buys the most latency.
   */
  setCacheRetention(value: 'none' | 'short' | 'long'): void {
    for (const loop of this.topology.resident) loop.setCacheRetention(value);
  }

  resetUtilityModel(): void {
    for (const loop of this.topology.resident) loop.resetUtilityModel();
  }

  /**
   * Set the consumer's context-window limit on every resident loop
   * (CONFIG_ROUTING contextWindowLimit: per-loop). Each loop clamps the same
   * number against its own backend capacity, so the talker's smaller
   * fast-tier window is respected without the consumer knowing the split
   * exists.
   */
  setContextWindowLimit(limit: number | null): void {
    for (const loop of this.topology.resident) loop.setContextWindowLimit(limit);
  }

  // Working tags route to every resident loop (CONFIG_ROUTING workingTags:
  // both-loops); the talker relies on them to separate thinking from speech.
  setWorkingTagsEnabled(enabled: boolean): void {
    for (const loop of this.topology.resident) loop.setWorkingTagsEnabled(enabled);
  }

  setLastInteractionTime(timestamp: number): void {
    for (const loop of this.topology.resident) loop.setLastInteractionTime(timestamp);
  }

  get isRunning(): boolean {
    return this.topology.resident.some((loop) => loop.isRunning);
  }

  /**
   * True while a logical turn is in flight on any resident loop. Narrower
   * than the settlement predicates: it reads idle while gate tasks are
   * still queued, so prefer conversationIdle / workSettled for settlement
   * decisions.
   */
  get isPrompting(): boolean {
    return this.topology.resident.some((loop) => loop.isPrompting);
  }

  // Loop-lifecycle and compaction callbacks register on every resident loop.
  //
  // EVERY fan-out callback takes a trailing LoopOriginContext, so a consumer
  // receiving one can tell which loop produced it. That is not decoration:
  // the fan-out is correct (both loops really do complete turns, retry, and
  // compact), so without the label a duplex consumer renders two retry
  // countdowns for one provider hiccup and two compaction notifications for
  // one compaction, with no way to collapse or attribute them.

  onLoopComplete(handler: (origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onLoopComplete(handler);
  }

  onError(handler: (error: ClassifiedError, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onError(handler);
  }

  onRetryScheduled(handler: (info: RetryScheduledInfo, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onRetryScheduled(handler);
  }

  onRetrySucceeded(handler: (info: RetrySucceededInfo, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onRetrySucceeded(handler);
  }

  onRetryExhausted(handler: (info: RetryExhaustedInfo, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onRetryExhausted(handler);
  }

  onBeforeCompaction(handler: (target: CompactionTarget, origin: LoopOriginContext) => Promise<void>): void {
    for (const loop of this.topology.resident) loop.onBeforeCompaction(handler);
  }

  onPostCompaction(handler: (result: CompactionResult, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onPostCompaction(handler);
  }

  onCompactionError(handler: (error: Error, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onCompactionError(handler);
  }

  onCompactionDegraded(handler: (info: CompactionDegradedInfo, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onCompactionDegraded(handler);
  }

  onCompactionExhausted(handler: (info: CompactionExhaustedInfo, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onCompactionExhausted(handler);
  }

  onObservation(handler: (event: ObservationEvent, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onObservation(handler);
  }

  onReflection(handler: (event: ReflectionEvent, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onReflection(handler);
  }

  onMemoryError(handler: (info: MemoryErrorInfo, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onMemoryError(handler);
  }

  onMemoryRecovered(handler: (info: MemoryRecoveredInfo, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onMemoryRecovered(handler);
  }

  onMemoryGap(handler: (info: MemoryGapInfo, origin: LoopOriginContext) => void): void {
    for (const loop of this.topology.resident) loop.onMemoryGap(handler);
  }
}
