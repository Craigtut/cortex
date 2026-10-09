/**
 * @animus-labs/cortex
 *
 * Production-grade agent wrapper for pi-agent-core.
 * Provides context management, MCP tool support, tool permissions,
 * budget guards, compaction, skill system, and event logging.
 *
 * Phase 1A exports: types and pure utility modules.
 * Phase 1B exports: AgentLoop, ContextManager, EventBridge, BudgetGuard.
 * Phase 1C exports: Built-in tools (Read, Write, Edit, Glob, Grep, Bash, TaskOutput, WebFetch).
 * Phase 1D exports: ProviderManager, model wrapper, provider registry.
 */

// Types
export type {
  CortexLogger,
  CortexUsage,
  SessionUsage,
  UtilityUsageBucket,
  UtilityUsagePayload,
  TalkerDeltaPayload,
  CortexLifecycleState,
  CortexToolPermissionDecision,
  CortexToolPermissionResult,
  ToolPermissionRequestContext,
  PendingAsk,
  LoopOriginContext,
  AgentLoopConfig,
  CortexDiagnosticsConfig,
  ContextManagerConfig,
  ErrorCategory,
  ErrorSeverity,
  ClassifiedError,
  RetryPolicy,
  RetryScheduledInfo,
  RetrySucceededInfo,
  RetryExhaustedInfo,
  AgentTextOutput,
  ToolContentDetails,
  BudgetGuardConfig,
  BudgetScope,
  ToolCategory,
  MicrocompactionConfig,
  CompactionConfig,
  FailsafeConfig,
  AdaptiveThresholdConfig,
  CortexCompactionConfig,
  CompactionTarget,
  CompactionResult,
  CompactionDegradedInfo,
  CompactionExhaustedInfo,
  PersistResultFn,
  CortexEvents,
  UtilityModelDefaults,
  McpTransportConfig,
  McpStdioConfig,
  McpHttpConfig,
  McpConnectionState,
  McpRedactedTransportConfig,
  McpRedactedStdioConfig,
  McpRedactedHttpConfig,
  McpToolCallProgress,
  SkillConfig,
  SkillEntry,
  LoadedSkill,
  CortexScriptContext,
  SubAgentSpawnConfig,
  SubAgentSpawnRequest,
  SubAgentSpawnAugmentation,
  SubAgentSnapshot,
  SubAgentResult,
  SubAgentHandle,
  SubAgentBudgetView,
  DeadLetteredBackgroundResult,
  TrackedSubAgent,
  ThinkingLevel,
  ModelThinkingCapabilities,
  ToolExecuteContext,
  ToolCallStartPayload,
  ToolCallUpdatePayload,
  ToolCallEndPayload,
  TurnEndPayload,
  LoopEndPayload,
  LoopMessageView,
  PromptWatchdogDiagnosticsConfig,
} from './types.js';
// Value export: consumers building an effort picker need the canonical
// ordering to sort or compare a model's supported levels.
export { THINKING_LEVEL_ORDER } from './types.js';

// Logger
export { NOOP_LOGGER } from './noop-logger.js';

// Schema Converter
export { zodToTypebox } from './schema-converter.js';

// Token Estimator
export { estimateTokens } from './token-estimator.js';

// Working Tags Parser
export {
  stripWorkingTags,
  extractWorkingContent,
  parseWorkingTags,
  WorkingTagStreamFilter,
  INTERNAL_TAG_NAMES,
} from './working-tags.js';

// Error Classifier
export { classifyError, extractCauseDetail } from './error-classifier.js';
export type { ClassifyErrorOptions } from './error-classifier.js';

// Retry Policy
export {
  DEFAULT_RETRY_POLICY,
  resolveRetryPolicy,
  backoffForAttempt,
  shouldRetry,
  isRetryableCategory,
} from './retry-policy.js';
export type { RetryDecisionContext } from './retry-policy.js';

// pi's own message and agent types. Conversation history, events, and the
// agent Cortex drives are pi's; consumers type against them through Cortex.
export type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentState,
} from '@earendil-works/pi-agent-core';
export type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  StopReason,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from '@earendil-works/pi-ai';

// Context Manager (Phase 1B)
export { ContextManager } from './context-manager.js';
export type {
  AgentStateAccessor,
  AgentContext,
} from './context-manager.js';

// Cache Breakpoints (shared by the agentic loop and direct completions)
export {
  computeCacheBreakpointIndices,
  applyCacheBreakpoints,
  addCacheControlToMessage,
  resolveDirectCompletionContext,
} from './cache-breakpoints.js';
export type {
  CacheBreakpointIndices,
  CacheBreakpointRegions,
  RawCompletionContext,
  StructuredCompletionContext,
  DirectCompletionContext,
  ResolvedCompletionContext,
} from './cache-breakpoints.js';

// Event Bridge (Phase 1B)
export { EventBridge, extractResponseChunkText, payloadOf } from './event-bridge.js';
export type {
  CortexEventType,
  CortexEvent,
  CortexEventListener,
  PiEventSource,
  CortexEventPayloads,
} from './event-bridge.js';

// Budget Guard (Phase 1B)
export { BudgetGuard } from './budget-guard.js';

// AgentLoop (Phase 1B)
export { AgentLoop, MINIMUM_CONTEXT_WINDOW, TOOL_RESULT_WORKING_TAGS_REMINDER } from './agent-loop.js';
export type {
  PiAgent,
  PiModel,
  DirectCompletionOptions,
  DeliverOptions,
  DeliverOutcome,
  DeliverResult,
  PendingWakeDelivery,
  PromptOptions,
  LoopRunInfo,
  IdleDigestionResult,
  QueueDrainMode,
  ToolResultInterceptor,
  ToolResultInterceptorInfo,
  ToolResultInterceptorResult,
} from './agent-loop.js';

// CortexAgent (the composite facade over AgentLoop: passthrough and duplex
// modes). AgentLoop remains the loop primitive and the package's primary
// agent surface until the duplex default flips (Phase 3).
export { CortexAgent } from './cortex-agent.js';
export { CONFIG_ROUTING, buildReasonerConfig } from './facade/config.js';
export type {
  CortexAgentMode,
  CortexAgentConfig,
  CortexSessionLogConfig,
  TalkerConfig,
  DuplexTuningConfig,
  ConfigDestination,
} from './facade/config.js';
export type { CortexAbortScope, CortexDeliverOptions } from './facade/session-mode.js';
export type {
  CortexAgentStateV1,
  CortexAgentStateV2,
  CortexAgentPersistedState,
  CortexAgentQueuedDeliveries,
  CortexAgentUsageBreakdown,
} from './facade/persisted-state.js';
export type { DuplexRouterState } from './duplex/router-contract.js';
// What DuplexRouterState is made of, so a consumer can type what it persists.
export type { DelegationRegistryState, DelegationSnapshot } from './duplex/delegations.js';
export type { ConversationDeltasState } from './duplex/conversation-deltas.js';
export type { ConversationDelta } from './duplex/prompts.js';

// Resolution report (what a CortexAgent assembly resolved to, where that
// differs from what the consumer asked for)
export { RESOLUTION_NOTE_CODES } from './resolution-report.js';
export type {
  ResolutionNote,
  ResolutionNoteCode,
  ResolutionSeverity,
} from './resolution-report.js';

// Session Log (the CortexAgent composite's append-only session record)
export { SessionLog } from './session-log.js';
export type {
  SessionLogEntry,
  SessionLogEntryType,
  SessionLogAppendInput,
  SessionLogEvent,
  SessionLogGap,
  SessionLogReset,
  SessionLogSubscriber,
  SessionLogOptions,
  WakeClass,
} from './session-log.js';

// Tool Contracts
export { fromPiAgentTool, assertValidCortexTool } from './tool-contract.js';
export type { CortexTool, PiAgentTool } from './tool-contract.js';

// MCP Client Manager (Phase 3)
export { McpClientManager } from './mcp-client.js';
export type { AgentTool } from './mcp-client.js';

// Built-in Tools (Phase 1C)
export {
  ReadRegistry,
  CwdTracker,
  CortexToolRuntime,
  BackgroundTaskStore,
  WebFetchRuntimeState,
  globalBackgroundTaskStore,
  attachRuntimeAwareTool,
  getRuntimeAwareToolMetadata,
  cloneRuntimeAwareTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createBashTool,
  BASH_ESCALATION_PERMISSION_NAME,
  isBashEscalationRequest,
  createTaskOutputTool,
  createWebFetchTool,
  WebFetchCache,
  getBackgroundTask,
  getAllBackgroundTasks,
  buildSafeEnv,
  isCriticalPath,
  classifyCommand,
  checkObfuscation,
  stripInvisibleChars,
  checkScriptPreflight,
  checkAutoModeClassifier,
  runSafetyChecks,
  validateWritePaths,
  extractWritePaths,
  findCatastrophicCommand,
  splitBashCommand,
  isCompoundBash,
  isPathSameOrDescendant,
  realpathIfExists,
  resolveThroughExistingAncestor,
  resolveThroughExistingAncestorSync,
  TOOL_NAMES,
} from './tools/index.js';
export type {
  ReadDetails,
  ReadParamsType,
  ReadToolConfig,
  WriteDetails,
  WriteParamsType,
  WriteToolConfig,
  DiffHunk,
  EditDetails,
  EditParamsType,
  EditToolConfig,
  GlobDetails,
  GlobParamsType,
  GlobToolConfig,
  GrepDetails,
  GrepParamsType,
  GrepToolConfig,
  BashDetails,
  BashStreamUpdate,
  BashParamsType,
  BashToolConfig,
  BackgroundTask,
  TaskOutputDetails,
  TaskOutputParamsType,
  TaskOutputToolConfig,
  WebFetchDetails,
  WebFetchParamsType,
  WebFetchToolConfig,
  CacheEntry,
  CommandClassification,
  SafetyCheckResult,
  CatastrophicCategory,
  CatastrophicContext,
  CatastrophicFinding,
  SplitBashOptions,
  BuiltInToolName,
  SubAgentToolConfig,
  SubAgentDetails,
  SubAgentParamsType,
} from './tools/index.js';

// Skill System (Phase 4)
export { SkillRegistry, parseFrontmatter } from './skill-registry.js';
export { preprocessSkillBody, substituteVariables, executeShellCommand, executeScript } from './skill-preprocessor.js';
export { createLoadSkillTool, buildLoadSkillDescription, LOAD_SKILL_TOOL_NAME } from './skill-tool.js';
export type { LoadSkillToolConfig, LoadSkillParamsType } from './skill-tool.js';
export { LoadSkillParams } from './skill-tool.js';

// Sub-Agent Manager (Phase 4)
export { SubAgentManager } from './sub-agent-manager.js';
export type { SubAgentManagerConfig, SubAgentLifecycleHooks } from './sub-agent-manager.js';

// Deferred Tool Loading / ToolSearch
export { DeferredToolRegistry } from './tools/tool-search/registry.js';
export type { ToolSearchResult } from './tools/tool-search/registry.js';
export {
  createToolSearchTool,
  TOOL_SEARCH_TOOL_NAME,
  ToolSearchParams,
} from './tools/tool-search/index.js';
export type {
  ToolSearchToolConfig,
  ToolSearchDetails,
  ToolSearchParamsType,
} from './tools/tool-search/index.js';
export type { DeferredToolsConfig } from './types.js';

// Sandbox policy and provider contract.
export type {
  SandboxRung,
  SandboxFilesystemPolicy,
  SandboxNetworkMode,
  SandboxNetworkPolicy,
  SandboxPolicy,
  SandboxEnforcement,
  SandboxBackend,
  SandboxStatus,
  SandboxSpawnSpec,
  SandboxExecSpec,
  WrappedSpawn,
  SandboxDenial,
  SandboxCommandFailure,
  SandboxProvider,
  NetworkAccessRequest,
  NetworkAccessScope,
  NetworkAccessDecision,
  ResolveNetworkAccess,
} from './sandbox/index.js';

// Compaction (Phase 5)
export {
  CompactionManager,
  buildCompactionConfig,
  DEFAULT_COMPACTION_CONFIG,
  ADAPTIVE_DEFAULTS,
  computeAdaptiveThreshold,
  MicrocompactionEngine,
  capToolResult,
  runCompaction,
  shouldCompact,
  partitionHistory,
  buildSummaryMessage,
  emergencyTruncate,
  shouldTruncate,
  isContextOverflow,
} from './compaction/index.js';

// Tool Result Persistence (proactive interceptor at the tool execution boundary)
export {
  applyResultPersistence,
  processToolResult,
  resolveThreshold,
  MAX_RESULT_TOKENS,
  BOOKEND_CHARS,
  SKIP_RESULT_PERSISTENCE,
  DEFAULT_TOOL_THRESHOLDS,
} from './tool-result-persistence.js';
export type {
  ApplyPersistenceOptions,
  ProcessResultOptions,
} from './tool-result-persistence.js';
export type {
  TrimAction,
  TrimState,
  CompleteFn,
  FailsafeTruncationResult,
  ObservationalMemoryConfig,
  ObservationalMemoryState,
  ObservationEvent,
  ReflectionEvent,
  RecallConfig,
  RecallResult,
} from './compaction/index.js';

// Model Wrapper (Phase 1D)
export { wrapModel, unwrapModel, isCortexModel } from './model-wrapper.js';
export type { CortexModel } from './model-wrapper.js';
export { inferUtilityModel, inferUtilityModelId } from './utility-model-inference.js';

// Model requests outside an agent loop (one-shot completions)
export { completeModel } from './model-runtime.js';
export type { ModelRequestOptions } from './model-runtime.js';

// Provider Registry (Phase 1D)
export {
  PROVIDER_REGISTRY,
  OAUTH_PROVIDER_IDS,
  UTILITY_MODEL_OVERRIDES,
  UTILITY_MODEL_DEFAULTS,
  PROVIDER_CACHE_CONFIG,
  resolveCacheRetention,
  resolvePromptCacheTtlMs,
} from './provider-registry.js';
export type {
  AuthMethod,
  ProviderInfo,
  ModelInfo,
  ProviderCacheConfig,
  CacheRetention,
} from './provider-registry.js';

// Default primary models, resolved from the installed pi-ai catalog
export { PRIMARY_MODEL_DEFAULTS, resolveDefaultModelId } from './model-defaults.js';

// Provider Manager (Phase 1D)
export { ProviderManager, OAuthError } from './provider-manager.js';
export type {
  OAuthErrorCode,
  IProviderManager,
  ProviderManagerOptions,
  OAuthCallbackRoute,
  OAuthCallbacks,
  OAuthAuthInfo,
  OAuthFlowType,
  OAuthPromptInfo,
  OAuthCallbackPageContext,
  OAuthCallbackPageRenderer,
  OAuthCallbackPageStatus,
  OAuthMeta,
  OAuthResult,
  OAuthRefreshResult,
  CustomModelConfig,
  ApiKeyValidationStatus,
  ApiKeyValidationResult,
} from './provider-manager.js';
export { forcedToolChoiceFor } from './tool-choice.js';

// Built-in sandbox backends and policy settings.
export { createSandboxProvider, buildDefaultPolicy, matchesAnyDomainPattern, matchesDomainPattern, SEEDED_REGISTRY_DOMAINS, DEFAULT_CREDENTIAL_ENV_VARS, MxcSandboxProvider } from './sandbox/index.js';
export type { SandboxConfig, SandboxOptions, SandboxState, CreateSandboxProviderOptions, DefaultPolicyOptions, MxcSandboxProviderOptions } from './sandbox/index.js';
export { getOllamaHost, detectOllama, getOllamaContextWindow } from './providers/ollama/discovery.js';
export { getOllamaRuntimeInfo } from './providers/ollama/model.js';
export type { OllamaModelConfig, OllamaMetrics } from './providers/ollama/runtime.js';
export type {
  ModelCapabilities,
  ModelConcurrency,
  ModelImageInputLimits,
  ModelPromptCacheLifetimes,
} from './model-wrapper.js';
export { structuredCompletionRequest, parseSchemaCompletion } from './structured-completion.js';
