/**
 * The composition root: builds one loop's parts and wires them together.
 *
 * Construction-order invariants (each is load-bearing):
 * - The loop's own event listeners register BEFORE the budget guard wires
 *   itself, and the turn-boundary steer listener AFTER it, so a turn that
 *   breaches the budget is seen as breached before content is steered into
 *   a run that is about to be aborted (listener order is registration
 *   order).
 * - The SubAgentManager exists before the spawner wires its hooks, and the
 *   spawner before the SubAgent tool that calls it.
 * - The skill binding exists before the load_skill tool.
 * - The ContextManager exists before the first tool refresh (the deferred
 *   tools slot is written there).
 * - The CompactionManager is built after the first tool refresh (so the
 *   skill summary falls back to the model window until then) and before
 *   the model settings sync it and the recall tool is registered from it.
 *
 * Ports resolve through `host` at call time wherever a consumer or test
 * may spy on or replace the loop's own method (prompt, refreshTools, the
 * completions, restoreConversationHistory, isAborted, createChildAgent,
 * getTransformContextHook). The tool syncs during construction are the
 * exception: they run before the loop has parts to resolve through.
 */

import { BudgetGuard } from '../budget-guard.js';
import type { DirectCompletionContext } from '../cache-breakpoints.js';
import { CompactionManager, buildCompactionConfig } from '../compaction/index.js';
import { createRecallTool } from '../compaction/observational/recall-tool.js';
import { ContextManager } from '../context-manager.js';
import type { AgentContext, AgentMessage } from '../context-manager.js';
import { EventBridge } from '../event-bridge.js';
import { PromptWatchdogDiagnostics } from '../prompt-diagnostics.js';
import { resolveRetryPolicy } from '../retry-policy.js';
import { SubAgentManager } from '../sub-agent-manager.js';
import { createSubAgentTool } from '../tools/sub-agent.js';
import type {
  AgentLoopConfig,
  AgentTextOutput,
  BudgetScope,
  ClassifiedError,
  CortexLogger,
  LoopOriginContext,
  RetryPolicy,
} from '../types.js';
import { BackgroundDelivery } from './background-delivery.js';
import { backgroundTaskState } from './background-task-text.js';
import { createBuiltinTools } from './builtin-tools.js';
import type { ChildLoopParams } from './child-loop-config.js';
import { ContextPipeline } from './context-pipeline.js';
import { DeadLetterStore } from './delivery-failure.js';
import { DeliveryQueues } from './delivery-queues.js';
import { DirectCompletions } from './direct-completion.js';
import type { DirectCompletionOptions } from './direct-completion.js';
import type { PromptOptions } from './api/run.js';
import { wireLoopEvents } from './event-wiring.js';
import { HandlerList } from './handler-list.js';
import { LoopLifecycle } from './lifecycle.js';
import { McpAttachment } from './mcp-attachment.js';
import { ModelSettings } from './model-settings.js';
import { PendingAskRegistry } from './permissions.js';
import type { AgentLoopConstructorOptions, PiAgent, RegisteredTool } from './pi-agent.js';
import { ToolResultFinalizer } from './pi-hooks.js';
import { ProcessTracker } from './process-tracker.js';
import { AbortState, LoopGate } from './run-control.js';
import { SkillBinding } from './skills.js';
import { SubAgentSpawner } from './sub-agent-spawner.js';
import type { ChildLoop } from './sub-agent-spawner.js';
import { SystemPromptState } from './system-prompt.js';
import { ToolRegistry } from './tool-registry.js';
import { TurnRunner } from './turn-runner.js';
import { LoopUsage } from './loop-usage.js';

/** The loop's own methods the parts call back into (resolved per call). */
export interface LoopHost {
  workingTagsEnabled(): boolean;
  prompt(input: string, options?: PromptOptions): Promise<unknown>;
  refreshTools(): void;
  directComplete(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string>;
  utilityComplete(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string>;
  isAborted(): boolean;
  emitError(error: Error, wasAborted?: boolean): ClassifiedError;
  getConversationHistory(): AgentMessage[];
  getTransformContextHook(): (context: AgentContext) => Promise<AgentContext>;
  createChildAgent(params: ChildLoopParams): Promise<ChildLoop>;
}

export interface LoopParts {
  agent: PiAgent;
  logger: CortexLogger;
  retryPolicy: RetryPolicy;
  origin: LoopOriginContext;
  lifecycle: LoopLifecycle;
  gate: LoopGate;
  abortState: AbortState;
  runner: TurnRunner;
  queues: DeliveryQueues;
  background: BackgroundDelivery;
  deadLetters: DeadLetterStore;
  asks: PendingAskRegistry;
  finalizer: ToolResultFinalizer;
  pipeline: ContextPipeline;
  systemPrompt: SystemPromptState;
  models: ModelSettings;
  tools: ToolRegistry;
  completions: DirectCompletions;
  usage: LoopUsage;
  processes: ProcessTracker;
  mcp: McpAttachment;
  subAgentManager: SubAgentManager;
  subAgents: SubAgentSpawner;
  skills: SkillBinding;
  contextManager: ContextManager;
  eventBridge: EventBridge;
  budgetGuard: BudgetGuard;
  compactionManager: CompactionManager;
  diagnostics: PromptWatchdogDiagnostics;
  loopComplete: HandlerList<[LoopOriginContext]>;
  errorHandlers: HandlerList<[ClassifiedError, LoopOriginContext]>;
  turnComplete: HandlerList<[AgentTextOutput, LoopOriginContext]>;
  /** The loop's own event-bridge subscriptions, removed on teardown. */
  unsubscribeEvents(): void;
}

export function assembleLoop(params: {
  agent: PiAgent;
  config: AgentLoopConfig;
  tools: RegisteredTool[] | undefined;
  options: AgentLoopConstructorOptions | undefined;
  loopPath: string;
  logger: CortexLogger;
  host: LoopHost;
}): LoopParts {
  const { agent, config, options, loopPath, logger, host } = params;
  if (!config.model) {
    throw new Error('AgentLoopConfig.model is required but was undefined. Pass a CortexModel.');
  }
  // One object reaches every consumer callback, so it is frozen: a handler
  // that wrote to it would relabel the loop for every handler after it.
  const origin: LoopOriginContext = Object.freeze({ loopPath });
  const retryPolicy = resolveRetryPolicy(config.retryPolicy);
  const eventUnsubscribers: Array<() => void> = [];
  // Parts built further down, referenced by ports that only run later.
  let parts!: LoopParts;

  const gate = new LoopGate();
  const abortState = new AbortState();
  const lifecycle = new LoopLifecycle(() => parts);
  const loopComplete = new HandlerList<[LoopOriginContext]>('onLoopComplete', logger);
  const errorHandlers = new HandlerList<[ClassifiedError, LoopOriginContext]>('onError', logger);
  const turnComplete = new HandlerList<[AgentTextOutput, LoopOriginContext]>('onTurnComplete', logger);
  const deadLetters = new DeadLetterStore(logger);
  const asks = new PendingAskRegistry();
  const usage = new LoopUsage();
  const processes = new ProcessTracker();
  const transcript = () => agent.state.messages;
  const notifyTailTrimmed = (): void => {
    // The observational buffer watermark (and any in-flight observer's end
    // index) is clamped to the surviving post-slot length: pi emits
    // turn_end for trimmed messages before Cortex removes them.
    const postSlotLength = Math.max(0, agent.state.messages.length - contextManager.historyStart);
    compactionManager.onSourceHistoryTailTrimmed(postSlotLength);
  };

  const queues: DeliveryQueues = new DeliveryQueues({
    gate,
    abort: abortState,
    isAborted: () => host.isAborted(),
    isShuttingDown: () => lifecycle.isShuttingDown,
    assertNotShuttingDown: () => lifecycle.assertNotShuttingDown(),
    hasSystemPrompt: () => systemPrompt.isConfigured(),
    isPrompting: () => runner.isPrompting,
    budgetBreached: () => budgetGuard.isBreached(),
    startPrompt: (content, promptOptions, causeTag) =>
      host.prompt(content, causeTag !== undefined ? { ...promptOptions, causeTag } : promptOptions),
    runDeliveryTurn: (message, policy, causeTags) =>
      runner.run(message, undefined, true, policy, causeTags),
    appendActiveCauseTags: (tags) => runner.appendActiveCauseTags(tags),
    transcript: {
      messages: transcript,
      boundary: () => runner.boundary,
      notifyTailTrimmed,
    },
    piQueues: agent,
    deadLetters,
    retryPolicy,
    emitError: (error) => host.emitError(error),
    logger,
  });
  const background = new BackgroundDelivery({
    gate,
    abort: abortState,
    isAborted: () => host.isAborted(),
    isShuttingDown: () => lifecycle.isShuttingDown,
    isCancelled: (taskId) => subAgentManager.isCancelled(taskId),
    runDeliveryTurn: (message, policy, causeTags) => runner.run(message, undefined, true, policy, causeTags),
    unwindFailedDelivery: (deliveryContent, runAbortEpoch) =>
      queues.unwindFailedDelivery(deliveryContent, runAbortEpoch),
    backgroundTasks: { get: (taskId) => tools.runtime.backgroundTasks.get(taskId) },
    deadLetters,
    retryPolicy,
    emitError: (error) => host.emitError(error),
    logger,
  });
  const diagnostics = new PromptWatchdogDiagnostics(
    config.diagnostics?.promptWatchdog,
    logger,
    {
      isPrompting: () => runner.isPrompting,
      isAbortRequested: () => host.isAborted(),
    },
    loopPath,
  );
  const tools = new ToolRegistry(config, {
    mcpTools: () => mcp.manager.getTools(),
    writeAgentTools: (piTools) => {
      (agent.state as Record<string, unknown>)['tools'] = piTools;
    },
    onToolsChanged: () => systemPrompt.refresh(),
    refreshTools: () => host.refreshTools(),
    slots: {
      getSlot: (name) => contextManager.getSlot(name),
      setSlot: (name, content) => contextManager.setSlot(name, content),
    },
    logger,
    loopPath,
  });
  const finalizer = new ToolResultFinalizer({
    workingTagsEnabled: () => host.workingTagsEnabled(),
    logger,
  });
  const systemPrompt = new SystemPromptState({
    initialPrompt: () => {
      const existing = agent.state.systemPrompt;
      return typeof existing === 'string' ? existing : '';
    },
    hasTool: (name) => tools.has(name),
    workingTagsEnabled: () => host.workingTagsEnabled(),
    workingDirectory: config.workingDirectory,
  });
  const models = new ModelSettings(config, {
    writeAgentModel: (model) => {
      (agent.state as Record<string, unknown>)['model'] = model;
    },
    // Null until built below; the settings sync it once it exists.
    compaction: () => parts?.compactionManager ?? null,
    onModelChanged: () => skills.rebuildDescription(),
    logger,
  });
  const completions = new DirectCompletions({
    models: () => ({
      primary: models.primary,
      primaryPi: models.primaryPi,
      utility: models.utility,
      utilityPi: models.utilityPi,
    }),
    getApiKey: config.getApiKey,
    ambientCredentials: config.ambientCredentials === true,
    cacheRetention: () => models.cacheRetention,
    sessionId: () => models.sessionId,
    isAborted: () => host.isAborted(),
    emitError: (error, wasAborted) => host.emitError(error, wasAborted),
    emitUtilityUsage: (category, spend) => eventBridge.emitUtilityUsage(category, spend),
    ledger: usage,
    logger,
  });

  // Built-in tools (minus disableTools), then the consumer's.
  const builtinTools = createBuiltinTools({
    workingDirectory: config.workingDirectory,
    runtime: tools.runtime,
    config,
    utilityComplete: (context, usageCategory) => host.utilityComplete(context, { usageCategory }),
    imageInputLimits: () => models.primary.capabilities?.imageInput,
    processes,
    // Inside the tool call, so the live run is the one backgrounding it.
    onBackgroundTaskStarted: (taskId) => background.noteBashStarted(taskId, runner.activeCauseTags),
    onBackgroundTaskComplete: (taskId) => {
      void background.bashCompleted(taskId);
    },
    ...(tools.deferredEnabled
      ? { deferred: { registry: tools.deferredRegistry, onAfterDiscovery: () => host.refreshTools() } }
      : {}),
  }, new Set(config.disableTools ?? []));
  tools.register([...builtinTools, ...(params.tools ?? [])]);
  models.applyToAgent();

  const compactionConfig = buildCompactionConfig(config.compaction);
  tools.bindPersistence(config, compactionConfig.microcompaction);

  // Slot ordering by stability (most stable first):
  //   1. `_available_tools` (changes only on MCP server connect/disconnect)
  //   2. consumer slots (consumer decides their own ordering)
  //   3. `_observations`   (changes potentially every turn)
  const slots: string[] = [];
  if (tools.deferredEnabled) slots.push('_available_tools');
  slots.push(...(config.slots ?? []));
  if ((compactionConfig.strategy ?? 'observational') === 'observational') slots.push('_observations');
  const contextManager = new ContextManager(agent, { slots });

  const eventBridge = new EventBridge(host.workingTagsEnabled(), logger);
  eventBridge.wire(agent);
  eventUnsubscribers.push(wireLoopEvents(eventBridge, {
    logger,
    diagnostics,
    ledger: usage,
    agentState: () => agent.state as unknown as { messages: AgentMessage[]; errorMessage?: unknown },
    historyStart: () => contextManager.historyStart,
    compaction: () => compactionManager,
    effectiveContextWindow: () => compactionManager.contextWindow,
    budgetSummary: () => ({
      turns: budgetGuard.getTurnCount(),
      totalCost: budgetGuard.getTotalCost(),
    }),
    onLoopEnd: () => skills.clear(),
    loopComplete,
    turnComplete,
    origin,
  }));

  const budgetGuard = new BudgetGuard(budgetGuardConfig(config), () => agent.abort(), logger);
  budgetGuard.wire(eventBridge);
  eventUnsubscribers.push(
    eventBridge.on('turn_end', (event) => {
      if (event.childTaskId) return;
      queues.steerTurnBoundary(event);
    }),
  );

  const runner: TurnRunner = new TurnRunner({
    agent,
    config,
    retryPolicy,
    abort: abortState,
    isAborted: () => host.isAborted(),
    activate: () => lifecycle.activate(),
    assertNotShuttingDown: () => lifecycle.assertNotShuttingDown(),
    emitError: (error, wasAborted) => host.emitError(error, wasAborted),
    cacheRetention: () => models.cacheRetention,
    model: () => models.primary,
    queues,
    toolRuntime: tools.runtime,
    budget: budgetGuard,
    diagnostics,
    compaction: () => compactionManager,
    handleOverflow: () => compactionManager.handleOverflowError(
      () => host.getConversationHistory(),
      (history) => pipeline.writeSource(history),
    ),
    historyStart: () => contextManager.historyStart,
    notifyTailTrimmed,
    pendingBackgroundCount: () => background.pending.length,
    drainBackground: () => background.drain(),
    origin,
    logger,
  });

  const mcp = new McpAttachment(config, logger, {
    onSubprocessSpawned: (pid) => processes.track(pid),
    onSubprocessExited: (pid) => processes.untrack(pid),
    onToolsChanged: () => host.refreshTools(),
  });

  const subAgentManager = new SubAgentManager({
    maxConcurrent: config.maxConcurrentSubAgents ?? 4,
    ...(config.subAgentPools ? { pools: config.subAgentPools } : {}),
  });
  const skills = new SkillBinding({
    contextWindow: () => parts?.compactionManager?.contextWindow ?? Math.min(
      models.primary.contextWindow,
      models.contextWindowLimit ?? models.primary.contextWindow,
    ),
    refreshTools: () => host.refreshTools(),
    logger,
    sandbox: config.sandbox,
  });
  const pipeline = new ContextPipeline({
    agentState: () => agent.state,
    setAgentMessages: (messages) => {
      agent.state.messages = messages;
    },
    slots: contextManager,
    compaction: () => compactionManager,
    injections: () => {
      const stable: string[] = [];
      const ephemeral = contextManager.getEphemeral();
      if (ephemeral) stable.push(ephemeral);
      const skillText = skills.renderInjection();
      if (skillText) stable.push(skillText);
      // Background task state gives the agent visibility into running
      // sub-agents and background bash processes.
      const backgroundState = backgroundTaskState(subAgentManager, tools);
      return { stable, volatile: backgroundState ? [backgroundState] : [] };
    },
    boundary: () => runner.boundary,
    setBoundary: (boundary) => {
      runner.boundary = boundary;
    },
    isPrompting: () => runner.isPrompting,
    gate,
    assertNotShuttingDown: () => lifecycle.assertNotShuttingDown(),
    isShuttingDown: () => lifecycle.isShuttingDown,
    transformHook: () => host.getTransformContextHook(),
    logger,
  });
  const subAgents = new SubAgentSpawner({
    manager: subAgentManager,
    createChild: (childParams) => host.createChildAgent(childParams),
    eventBridge,
    onBackgroundComplete: (item) => background.enqueue(item),
    purgePendingResult: (taskId) => background.purgeSubAgent(taskId),
    logger,
  });

  if (options?.enableSubAgentTool !== false) {
    tools.registerInternal(createSubAgentTool({
      spawnSubAgent: (spawn) => subAgents.spawnForeground(spawn),
      // A tool call, so the live run is the one spawning it.
      spawnBackgroundSubAgent: (spawn) => subAgents.spawnBackground(spawn, runner.activeCauseTags),
      // Tool spawns count against the default pool.
      canSpawn: () => subAgentManager.canSpawn(),
      checkConsumerSpawn: () => {
        const verdict = config.canSpawnSubAgent?.();
        if (verdict === undefined) return { allowed: true };
        if (typeof verdict === 'boolean') return { allowed: verdict };
        return verdict;
      },
      getConcurrencyInfo: () => ({
        active: subAgentManager.activeCount,
        limit: subAgentManager.limit,
      }),
      getModelId: () => models.primary.modelId,
    }) as RegisteredTool);
  }
  if (options?.enableLoadSkillTool !== false) {
    tools.registerInternal(skills.createLoadSkillTool());
  }

  // First sync of the adapted tool set to pi (compaction not built yet).
  // Direct, not through host.refreshTools(): the loop's parts are not
  // assigned until this function returns, and nothing can have replaced the
  // loop's refreshTools before its constructor finished. Every later
  // refresh goes through the host.
  tools.refresh();

  const compactionManager = new CompactionManager(compactionConfig, contextManager.historyStart);
  compactionManager.setLogger(logger);
  // Summarization runs on the primary model, observation and reflection on
  // the utility model; each is tagged so its spend lands in its own
  // session-usage bucket (the engine's purpose is the category).
  compactionManager.setCompleteFn(async (context) =>
    host.directComplete(context, { usageCategory: 'summarization' }));
  compactionManager.setObservationalCompleteFn(async (context, completeOptions) =>
    host.utilityComplete(
      {
        systemPrompt: context.systemPrompt,
        messages: context.messages as Array<{ role: string; content: string }>,
      },
      { usageCategory: completeOptions?.purpose ?? 'observation' },
    ));

  parts = {
    agent, logger, retryPolicy, origin, lifecycle, gate, abortState, runner, queues, background, deadLetters,
    asks, finalizer, pipeline, systemPrompt, models, tools, completions, usage, processes, mcp,
    subAgentManager, subAgents, skills, contextManager, eventBridge, budgetGuard,
    compactionManager, diagnostics, loopComplete, errorHandlers, turnComplete,
    unsubscribeEvents: () => {
      for (const unsubscribe of eventUnsubscribers.splice(0)) unsubscribe();
    },
  };
  // Context windows and cache TTL follow the model settings from here on.
  models.syncCompaction();

  const recallConfig = compactionManager.hasRecallTool() ? compactionManager.getRecallConfig() : null;
  if (recallConfig) {
    tools.registerInternal(createRecallTool(recallConfig) as RegisteredTool);
    tools.refresh();
  }
  return parts;
}

/** BudgetGuard's config from the loop's (only the fields the consumer set). */
function budgetGuardConfig(config: AgentLoopConfig): {
  maxTurns?: number;
  maxCost?: number;
  scope?: BudgetScope;
  includeChildUsage?: boolean;
  includeUtilityUsage?: boolean;
} {
  const budget = config.budgetGuard;
  return {
    ...(budget?.maxTurns !== undefined ? { maxTurns: budget.maxTurns } : {}),
    ...(budget?.maxCost !== undefined ? { maxCost: budget.maxCost } : {}),
    ...(budget?.scope !== undefined ? { scope: budget.scope } : {}),
    ...(budget?.includeChildUsage !== undefined ? { includeChildUsage: budget.includeChildUsage } : {}),
    ...(budget?.includeUtilityUsage !== undefined ? { includeUtilityUsage: budget.includeUtilityUsage } : {}),
  };
}
