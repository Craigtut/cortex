/**
 * The delegation contract over AgentLoop's public surface: how every public
 * loop member maps onto CortexAgent (docs/cortex/duplex/facade-api.md).
 */

import type { AgentLoop } from '../agent-loop.js';

/**
 * How a public AgentLoop member maps onto the facade.
 *
 * - `forwarded`: same-name member on CortexAgent, delegating to the loop
 *   (pure delegation in passthrough; duplex routing notes live at each
 *   delegation site).
 * - `subsumed`: no same-name member; the capability exists on the facade
 *   under a composite-aware surface (named in the table comment).
 * - `withheld`: deliberately not exposed (reason in the table comment).
 */
export type AgentLoopMemberDisposition = 'forwarded' | 'subsumed' | 'withheld';

/**
 * The complete delegation table over AgentLoop's public surface. Like
 * CONFIG_ROUTING, this mapped object is the contract: adding a public
 * member to AgentLoop without routing it here is a compile error, and the
 * structural test in tests/unit/cortex-agent.test.ts asserts the runtime
 * facade matches every disposition, so a delegation gap cannot silently
 * reappear. The rule is: forward everything that is pure delegation;
 * subsume or withhold only with a stated reason.
 */
export const AGENT_LOOP_DELEGATION = {
  // Interaction surface (facade semantics documented on each method).
  prompt: 'forwarded',
  deliver: 'forwarded',
  steer: 'forwarded',
  abort: 'forwarded',
  destroy: 'forwarded',
  followUp: 'forwarded',
  isPrompting: 'forwarded',
  // Subsumed: the settlement predicates (conversationIdle / workSettled and
  // their awaitable forms) are the composite-aware forms of the loop-gate
  // reads; in duplex a single loop's gate is not "the agent is idle".
  isLoopActive: 'subsumed',
  waitForLoopIdle: 'subsumed',
  waitForAskSettlement: 'subsumed',
  waitForWakeDeliveriesDrained: 'subsumed',
  // Withheld: one loop's run identity, which has no single composite
  // meaning in duplex (two resident loops, each with its own runs). The
  // duplex session reads the reasoner's through ReasonerRunTracker.
  currentRun: 'withheld',
  lastRunEndedAt: 'withheld',
  // Queues.
  setSteeringQueueMode: 'forwarded',
  setFollowUpQueueMode: 'forwarded',
  clearSteeringQueue: 'forwarded',
  clearFollowUpQueue: 'forwarded',
  clearQueuedDeliveries: 'forwarded',
  getQueuedDeliveries: 'forwarded',
  queuedDeliveryCount: 'forwarded',
  pendingWakeDeliveryCount: 'forwarded',
  // Subsumed: facade abort() and restore() clear every queue themselves
  // and record what they drop in the session log (queued_content_dropped),
  // which is where dropped content is recoverable from. The facade surfaces
  // clearQueuedDeliveries() (silent only) and pendingWakeDeliveryCount (a
  // count) for the rest.
  clearAllQueues: 'subsumed',
  // Withheld: a retraction primitive the facade uses to drop permission
  // voicings whose ask an abort already settled. It asks the caller to
  // recognize its own deliveries by handle, which is a composition concern;
  // a consumer wanting to drop queued content has clearQueuedDeliveries().
  dropPendingWakeDeliveries: 'withheld',
  // Asks and headlines.
  getPendingAsks: 'forwarded',
  // Forwarded in passthrough, where the consumer presents asks; a refused
  // no-op in duplex, where the broker is the only writer of `voiced`.
  markAskVoiced: 'forwarded',
  setHeadlineProvider: 'forwarded',
  // Withheld: the facade owns this hook in duplex (the control-tool
  // terminate guards install through it, D17); exposing it would let a
  // consumer displace those guards. Direct AgentLoop users keep it.
  setToolResultInterceptor: 'withheld',
  // Prompt and model surface. In duplex the setters for model, utility
  // model, cache retention, context-window limit and session id reach both
  // resident loops (setModel re-mirrors an unpinned talker); thinking level
  // and setContextWindow stay reasoner-only (the talker's model is different
  // and its thinking is fixed off). Getters report the reasoner.
  setBasePrompt: 'forwarded',
  getBasePrompt: 'forwarded',
  getCurrentSystemPrompt: 'forwarded',
  composeSystemPrompt: 'forwarded',
  getSystemPromptSections: 'forwarded',
  getModel: 'forwarded',
  setModel: 'forwarded',
  getUtilityModel: 'forwarded',
  setUtilityModel: 'forwarded',
  resetUtilityModel: 'forwarded',
  getAutoResolvedUtilityModel: 'forwarded',
  isUtilityModelOverridden: 'forwarded',
  getThinkingLevel: 'forwarded',
  setThinkingLevel: 'forwarded',
  getModelThinkingCapabilities: 'forwarded',
  clampThinkingLevel: 'forwarded',
  setCacheRetention: 'forwarded',
  getCacheRetention: 'forwarded',
  setSessionId: 'forwarded',
  getSessionId: 'forwarded',
  // Context window and token accounting.
  setContextWindow: 'forwarded',
  setContextWindowLimit: 'forwarded',
  contextWindowLimit: 'forwarded',
  effectiveContextWindow: 'forwarded',
  modelContextWindow: 'forwarded',
  currentContextTokenCount: 'forwarded',
  updateCurrentContextTokenCount: 'forwarded',
  estimateCurrentContextTokens: 'forwarded',
  capToolResult: 'forwarded',
  // Direct completions and usage.
  directComplete: 'forwarded',
  structuredComplete: 'forwarded',
  utilityComplete: 'forwarded',
  getLastDirectUsage: 'forwarded',
  getSessionUsage: 'forwarded',
  // Subsumed: restore() takes the versioned composite artifact and applies
  // per-loop ordering internally; piecemeal per-loop restores would bypass
  // the guard and the baseline-plus-delta usage model.
  restoreConversationHistory: 'subsumed',
  restoreObservationalMemoryState: 'subsumed',
  restoreSessionUsage: 'subsumed',
  // History, memory, digestion, compaction.
  getConversationHistory: 'forwarded',
  getObservationalMemoryState: 'forwarded',
  digestIdle: 'forwarded',
  checkAndRunCompaction: 'forwarded',
  triggerObservation: 'forwarded',
  getCompactionManager: 'forwarded',
  // Tools, MCP, skills.
  addConsumerTool: 'forwarded',
  removeConsumerTool: 'forwarded',
  refreshTools: 'forwarded',
  connectMcpServer: 'forwarded',
  disconnectMcpServer: 'forwarded',
  getMcpServerStates: 'forwarded',
  mcpConfigMatches: 'forwarded',
  setMcpToolCallProgressHandler: 'forwarded',
  getMcpClientManager: 'forwarded',
  getMcpTools: 'forwarded',
  getSkillRegistry: 'forwarded',
  loadSkill: 'forwarded',
  clearSkillBuffer: 'forwarded',
  getSkillBuffer: 'forwarded',
  setPreprocessorVariables: 'forwarded',
  setScriptContext: 'forwarded',
  // Sub-agents.
  spawnBackgroundSubAgent: 'forwarded',
  cancelSubAgent: 'forwarded',
  steerSubAgent: 'forwarded',
  getActiveSubAgents: 'forwarded',
  getDeadLetteredBackgroundResults: 'forwarded',
  // Withheld: raw manager internals. Consumers have getActiveSubAgents,
  // spawnBackgroundSubAgent, cancelSubAgent, and steerSubAgent; handing out
  // the manager would let a consumer mutate tracking state the facade's
  // lifecycle log depends on.
  getSubAgentManager: 'withheld',
  // State reads and misc.
  isRunning: 'forwarded',
  state: 'forwarded',
  isWorkingTagsEnabled: 'forwarded',
  setWorkingTagsEnabled: 'forwarded',
  setLastInteractionTime: 'forwarded',
  getEnvOverrides: 'forwarded',
  getEventBridge: 'forwarded',
  getBudgetGuard: 'forwarded',
  getContextManager: 'forwarded',
  // Withheld: no single composite value exists in duplex (each loop has its
  // own path); origin reaches consumers via LoopOriginContext on callbacks.
  loopPath: 'withheld',
  // Withheld: internal causation plumbing (the facade stamps log-entry
  // causedBy from it); the log's causedBy field is the consumer surface.
  activeRunCauseTags: 'withheld',
  // Withheld: cache-breakpoint internal (the boundary between cacheable
  // history and tick content); meaningless as a composite value.
  prePromptMessageCount: 'withheld',
  // Withheld: context-composition internals; the hook is wiring between the
  // loop and pi, not a consumer surface.
  getTransformContextHook: 'withheld',
  // Withheld: permission-gate internal (which registered tools bypass the
  // resolver); per-loop by construction, meaningless as a composite value.
  isToolPermissionExempt: 'withheld',
  // Callback registration.
  onLoopComplete: 'forwarded',
  onError: 'forwarded',
  onTurnComplete: 'forwarded',
  onRetryScheduled: 'forwarded',
  onRetrySucceeded: 'forwarded',
  onRetryExhausted: 'forwarded',
  onBeforeCompaction: 'forwarded',
  onPostCompaction: 'forwarded',
  onCompactionError: 'forwarded',
  onCompactionDegraded: 'forwarded',
  onCompactionExhausted: 'forwarded',
  onSubAgentSpawned: 'forwarded',
  onSubAgentCompleted: 'forwarded',
  onSubAgentFailed: 'forwarded',
  onBackgroundResultDelivery: 'forwarded',
  onBackgroundResultDeadLettered: 'forwarded',
  onObservation: 'forwarded',
  onReflection: 'forwarded',
  onMemoryError: 'forwarded',
  onMemoryRecovered: 'forwarded',
} as const satisfies Record<keyof AgentLoop, AgentLoopMemberDisposition>;

type DelegationTable = typeof AGENT_LOOP_DELEGATION;

/**
 * The keys the table marks 'forwarded'. Exported so the behavioural
 * delegation test can be exhaustive over it: the structural test only sees
 * that a forwarded member EXISTS on the facade, never that it behaves the
 * same.
 */
export type ForwardedLoopMember = {
  [K in keyof DelegationTable]: DelegationTable[K] extends 'forwarded' ? K : never;
}[keyof DelegationTable];
