/**
 * Core types for the @animus-labs/cortex package.
 *
 * These types define the public API surface for AgentLoop configuration,
 * context management, error classification, working tags, budget guards,
 * compaction, events, and model tiers.
 *
 * References:
 *   - cortex-architecture.md
 *   - context-manager.md
 *   - model-tiers.md
 *   - error-recovery.md
 *   - working-tags.md
 */

import type { ModelAuth } from '@earendil-works/pi-ai';
import type { CortexModel } from './model-wrapper.js';
import type {
  ObservationalMemoryConfig,
  ObservationEvent,
  ReflectionEvent,
} from './compaction/observational/types.js';
import type { SandboxProvider, ResolveNetworkAccess } from './sandbox/types.js';
// Type-only: mcp-client.ts imports this module's types, so a runtime import
// here would be a cycle; the erased type import is not.
import type { McpClientManager } from './mcp-client.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Pluggable logger interface for Cortex diagnostics.
 *
 * Cortex never decides where logs go. The consumer provides an implementation
 * via AgentLoopConfig.logger. If omitted, all logging is silently discarded.
 *
 * All methods share the same signature for uniformity. The optional `data`
 * parameter carries structured context (token counts, server names, error
 * objects, etc.) that the consumer can serialize or inspect as needed.
 *
 * Compatible with `console` for quick development: `logger: console` works
 * because console methods accept variadic args and ignore the extra object.
 */
export interface CortexLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Token usage and cost data from a single LLM call.
 * Mirrors the pi-ai AssistantMessage.usage structure but is decoupled
 * from pi-ai's types to avoid hard runtime dependencies.
 */
export interface CortexUsage {
  /** Input (prompt) tokens. */
  input: number;
  /** Output (completion) tokens. */
  output: number;
  /** Cache-read tokens (tokens served from cache). */
  cacheRead: number;
  /** Cache-write tokens (tokens written to cache). */
  cacheWrite: number;
  /** Total tokens (input + output). */
  totalTokens: number;
  /** Cost breakdown in USD. */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  /** Model identifier string (if available from the response). */
  model?: string;
}

// ---------------------------------------------------------------------------
// Session Usage
// ---------------------------------------------------------------------------

/**
 * Accumulated usage data across the lifetime of a session.
 *
 * Unlike BudgetGuard (which resets per agentic loop for enforcement),
 * SessionUsage accumulates across all loops for reporting and persistence.
 * Cortex tracks this in memory; consumers persist and restore as needed.
 */
export interface SessionUsage {
  /**
   * Total cost in USD across all recorded spend: loop turns (this loop's
   * and forwarded children's) plus direct/utility completions.
   */
  totalCost: number;
  /** Total number of LLM turns across all loops. */
  totalTurns: number;
  /** Accumulated token counts across all recorded spend. */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /**
   * Direct/utility completion spend broken down by category tag (e.g.
   * 'observer', 'reflector', 'summarization', 'webfetch', 'bash_utility',
   * or a consumer-supplied tag). Absent until the first tagged completion
   * is recorded. Bucket contents are also included in the top-level totals.
   */
  utility?: Record<string, UtilityUsageBucket>;
}

/**
 * Accumulated spend of one direct/utility completion category within
 * {@link SessionUsage}.
 */
export interface UtilityUsageBucket {
  /** Number of completions recorded under this category. */
  calls: number;
  /** Accumulated cost in USD. */
  cost: number;
  /** Accumulated token counts. */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The lifecycle state of an AgentLoop instance.
 *
 * CREATED -> ACTIVE -> DESTROYING -> DESTROYED
 *
 * abort() returns the agent to ACTIVE (still usable).
 * destroy() transitions to DESTROYING synchronously (no new loops can
 * start), then to DESTROYED once all resources are released.
 */
export type CortexLifecycleState = 'created' | 'active' | 'destroying' | 'destroyed';

// ---------------------------------------------------------------------------
// Thinking / Effort Level
// ---------------------------------------------------------------------------

/**
 * Consumer-facing thinking/effort level. Names and ordering match pi-ai's
 * vocabulary exactly, so a level passes through to the provider unmapped.
 *
 * Which of these a given model actually accepts is a per-model fact, not a
 * global one: ask {@link AgentLoop.getModelThinkingCapabilities}. Cortex used
 * to collapse "xhigh" and "max" into a single "max", which silently
 * under-requested on models that expose both.
 *
 * "off" disables extended thinking entirely.
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Every thinking level, weakest to strongest, with "off" first.
 *
 * The single source of ordering truth. Use it to compare or clamp levels;
 * do not hardcode a ladder at a call site, because which entries are valid
 * depends on the model.
 */
export const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

/**
 * Describes a model's thinking/reasoning capabilities.
 * Returned by AgentLoop.getModelThinkingCapabilities().
 */
export interface ModelThinkingCapabilities {
  /** Whether the model supports extended thinking at all. */
  supportsThinking: boolean;
  /**
   * Whether this model accepts the literal "max" level.
   *
   * Not a synonym for "has a top level": a model whose ceiling is "xhigh"
   * reports false here. Prefer reading {@link supportedLevels} directly.
   */
  supportsMax: boolean;
  /** Exact thinking levels this model accepts, strongest last. */
  supportedLevels: ThinkingLevel[];
}

// ---------------------------------------------------------------------------
// Tool Permissions
// ---------------------------------------------------------------------------

export type CortexToolPermissionDecision = 'allow' | 'block' | 'ask';

export interface CortexToolPermissionResult {
  decision: CortexToolPermissionDecision;
  reason?: string;
}

/**
 * Context passed to resolvePermission alongside the tool name and args.
 */
export interface ToolPermissionRequestContext {
  /**
   * Fires when the run that asked is aborted. Cortex stops waiting for the
   * resolver's answer at that point, so a consumer UI showing an approval
   * prompt should listen and dismiss the now-moot prompt.
   */
  signal?: AbortSignal;
  /**
   * Unique nonce for this specific ask. Always set when Cortex invokes the
   * resolver; two asks never share an id, even for identical tool calls.
   * Consumers can key pending-prompt UI state on it.
   */
  askId?: string;
  /**
   * Path identity of the loop that raised the ask (e.g. 'main' for a
   * standalone loop, 'main/<taskId>' for a sub-agent it spawned). Always set
   * when Cortex invokes the resolver, so a consumer fielding asks from
   * several concurrent loops can attribute each prompt.
   */
  loopPath?: string;
  /**
   * Verbatim rendering of what is being asked: the permission name plus the
   * actual command, path, or URL from the tool arguments, truncated but
   * never summarized. Always set when Cortex invokes the resolver. Surfaces
   * that present the ask to a human (a TUI prompt, a voice loop reading the
   * request aloud) should use this text rather than re-deriving their own,
   * so what the human hears is what the tool will actually do.
   */
  renderedRequest?: string;
}

/**
 * A permission ask currently blocked on a decision, as surfaced by
 * AgentLoop.getPendingAsks(). Each entry corresponds to one resolver
 * invocation still awaiting its answer; entries disappear when the ask
 * settles (answered, blocked, or aborted).
 */
export interface PendingAsk {
  /**
   * The ask's per-ask nonce (also delivered to the resolver as
   * ToolPermissionRequestContext.askId). Security-relevant: consent binding
   * keys on it, so ids are crypto-random, never reused, and never derived
   * from guessable data.
   */
  askId: string;
  /** Path identity of the loop that raised the ask. */
  loopPath: string;
  /** Permission name presented to the resolver (tool name or synthetic escalation name). */
  toolName: string;
  /** Verbatim request rendering (see ToolPermissionRequestContext.renderedRequest). */
  renderedRequest: string;
  /** Epoch ms when the ask was raised. */
  requestedAt: number;
  /**
   * Whether the ask has been presented to the human. Set via
   * AgentLoop.markAskVoiced(); a consent router should accept an allow only
   * for the most recently voiced ask.
   */
  voiced: boolean;
}

/**
 * Origin identity passed as the second argument to loop-scoped callbacks
 * (onError, onTurnComplete). Identifies which loop produced the signal when
 * several AgentLoops share consumer-level handlers.
 */
export interface LoopOriginContext {
  /**
   * The loop's path identity: its configured `loopPath` (default 'main'),
   * extended with '/<taskId>' segments for spawned sub-agents.
   */
  readonly loopPath: string;
}

/** Loop identity used when the consumer does not configure one. */
export const DEFAULT_LOOP_PATH = 'main';

// ---------------------------------------------------------------------------
// Agent Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for creating an AgentLoop instance.
 *
 * The `model` field uses CortexModel as the public boundary.
 * Consumers obtain these handles from ProviderManager and pass them back to
 * AgentLoop. Raw pi-ai model objects stay inside Cortex.
 */
export interface AgentLoopConfig {
  /** Primary model for the agentic loop, THOUGHT, REFLECT, and all consumer-facing work. */
  model: CortexModel;

  /**
   * Initial application/base prompt.
   * Cortex composes its operational sections around this prompt.
   */
  initialBasePrompt?: string;

  /**
   * Utility model for internal operations (WebFetch summarization, safety classifier).
   * - `'default'`: Cortex selects from a built-in mapping based on the primary model's provider.
   * - A CortexModel: explicit utility model (must be same provider as primary).
   * - `undefined`: same as `'default'`.
   */
  utilityModel?: CortexModel | 'default';

  /** Working directory for file operations (Bash, Read, Write, Edit, Glob, Grep). */
  workingDirectory: string;

  /**
   * Callback to resolve API keys by provider name.
   * Throws on failure (classified as authentication error).
   * Returns the API key string on success. Must never return empty string.
   */
  getApiKey?: (provider: string) => Promise<string>;

  /**
   * Callback to resolve a request's auth by provider name: an API key, auth
   * headers, and a base URL, any of which a provider may need. Kimi Coding's
   * OAuth authorizes with a header and GitHub Copilot's with a per-account
   * base URL, which a plain key cannot carry. Takes precedence over
   * `getApiKey`, which stays the simple path. `ProviderManager.getAuth()`
   * has this shape. Throws on failure (classified as authentication error);
   * resolving `undefined` means no credentials.
   */
  getAuth?: (provider: string) => Promise<ModelAuth | undefined>;

  /**
   * Let pi-ai resolve credentials from the environment for a request that
   * carries no key from `getApiKey`: provider env vars (`ANTHROPIC_API_KEY`
   * and the like), Anthropic workload identity federation, AWS profiles,
   * and gcloud ADC. Default false: without a key from `getApiKey` a request
   * to a provider that needs credentials fails, and ambient credentials are
   * never picked up silently.
   */
  ambientCredentials?: boolean;

  /** Ordered list of context slot names. Order defines position in the message array. */
  slots?: string[];

  /** Working tags configuration. */
  workingTags?: {
    /**
     * Whether to enable working tags. Default: false. Claude models with
     * Anthropic's `reasoning_extraction` classifier (the Claude 5 family)
     * refuse requests carrying the working-tags instructions, which ask the
     * model to write its reasoning into the response.
     */
    enabled?: boolean;
  };

  /** Budget guard configuration. */
  budgetGuard?: {
    /** Maximum number of LLM turns before force-stopping the loop. Default: Infinity. */
    maxTurns?: number;
    /** Maximum cost in USD before force-stopping the loop. Default: Infinity. */
    maxCost?: number;
    /**
     * What the limits span. `'prompt'` (default) resets the counters at each
     * prompt, so limits bound one logical turn. `'lifetime'` never resets
     * them, so limits bound the loop's whole life: the mode for a resident
     * loop prompted many times per session, where a per-prompt `maxCost`
     * would never trip. Once breached, a lifetime guard aborts every further
     * turn, including turns of later prompts.
     */
    scope?: BudgetScope;
    /**
     * Whether forwarded sub-agent turn usage counts against this guard's
     * limits. Default false (a loop's own guard bounds only its own turns;
     * child spend is bounded by the child's guard). An aggregate guard that
     * must cover a loop and everything it spawns sets this true.
     */
    includeChildUsage?: boolean;
    /**
     * Whether direct/utility completion spend (observer, reflector,
     * summarization, WebFetch, Bash utility calls) counts against maxCost.
     * Default false. See BudgetGuardConfig.includeUtilityUsage.
     */
    includeUtilityUsage?: boolean;
  };

  /**
   * Keep tool-runtime workspace state (working directory, read-before-edit
   * registry, undo history) across prompts instead of resetting it at each
   * prompt start. For long-lived loops woken repeatedly by deliveries, where
   * each wake continues one logical working session. Transient per-loop
   * state (mutation lock, WebFetch rate-limit counter) still resets every
   * prompt. Default false.
   */
  persistentRuntime?: boolean;

  /**
   * Background retry policy for transient turn failures. Sits above pi-ai's
   * fast HTTP retries; resumes the failed turn with exponential backoff. Merged
   * over the built-in defaults, so a consumer can override just one field
   * (e.g. `{ enabled: false }` or `{ maxAttempts: 30 }`). See {@link RetryPolicy}.
   */
  retryPolicy?: Partial<RetryPolicy>;

  /** Maximum number of concurrent sub-agents. */
  maxConcurrentSubAgents?: number;

  /**
   * Named, independent sub-agent concurrency pools. A spawn that names a
   * pool counts only against that pool's limit, so a saturated default pool
   * (long task fleet) can never starve a small dedicated pool (quick
   * lookups) and vice versa. A named pool missing from this map falls back
   * to the maxConcurrentSubAgents limit while still being counted
   * separately. Spawns without a pool use maxConcurrentSubAgents.
   */
  subAgentPools?: Record<string, number>;

  /**
   * Tool execution strategy for assistant messages with multiple tool calls.
   * Defaults to sequential for deterministic permission, logging, and UI order.
   */
  toolExecution?: 'sequential' | 'parallel';

  /** WebFetch tool configuration. */
  webFetch?: {
    /** Maximum number of web fetches per agentic loop. */
    maxPerLoop?: number;
  };

  /** Bash tool configuration. */
  bash?: {
    /**
     * Milliseconds after which a still-running Bash command auto-yields into
     * a background task (the agent is notified on completion). Default: 10000.
     */
    autoYieldThreshold?: number;
    /** Path to the shell executable. */
    shellPath?: string;
  };

  /**
   * Advanced loop primitive: a borrowed, initialized sandbox provider.
   * The caller owns its lifecycle. Most consumers should use CortexAgent
   * with sandbox: true or SandboxOptions for automatic setup and cleanup.
   */
  sandbox?: SandboxProvider;

  /**
   * Single network egress decision, mirroring resolvePermission's shape. When
   * configured, in-process egress points (WebFetch) call it before reaching the
   * network and honor a deny with a policy-blocked tool result. The consumer
   * should wire the same function into its SandboxProvider's ask-callback so
   * shell egress and WebFetch share one allowlist and one prompt. Independent
   * of the always-on SSRF guard: a private IP stays blocked even when the host
   * is allowed. When omitted, in-process egress is ungated (as before).
   */
  resolveNetworkAccess?: ResolveNetworkAccess;

  /**
   * Whether the consumer is currently auto-approving tool calls.
   * Used by built-in tool safety gates that need stricter checks in auto mode.
   */
  isAutoApprove?: () => boolean;

  /**
   * Disable specific built-in tools by name.
   * Built-in tools (Read, Write, Edit, Glob, Grep, Bash, WebFetch, TaskOutput)
   * are registered automatically. Use this to exclude tools the agent should not have.
   * SubAgent and load_skill are controlled separately via enableSubAgentTool/enableLoadSkillTool.
   */
  disableTools?: string[];

  /**
   * Restrict the read-surface built-in tools (Read, Glob, Grep) to paths
   * under these roots, enforced in-tool with symlink resolution and a
   * visible refusal. For read-restricted loops (duplex quick lookups spawn
   * with `[workingDirectory]`): their answers become conversation, so an
   * unrestricted read is an exfiltration path. Gates only the read tools;
   * combine with `disableTools` (write/exec tools) and the sandbox for a
   * fully restricted loop. Inherited by spawned sub-agents. Undefined or
   * empty = unrestricted, exactly as before.
   */
  readPathAllowlist?: string[];

  /**
   * Structured permission result for a tool call.
   * - `allow`: proceed immediately
   * - `block`: deny the call
   * - `ask`: consumer requires approval before the call can proceed
   *
   * The context carries the run's abort signal. Cortex races the returned
   * promise against that signal (an abort blocks the call and unblocks the
   * loop immediately), so a resolver awaiting human input should dismiss its
   * prompt when the signal fires: the answer is no longer consulted.
   */
  resolvePermission?: (
    toolName: string,
    toolArgs: unknown,
    context?: ToolPermissionRequestContext,
  ) => Promise<boolean | CortexToolPermissionResult>;

  /**
   * Initial thinking/effort level for the agentic loop.
   * Omit to use the pi-agent-core default (medium).
   * "max" maps to pi-ai/pi-agent-core's "xhigh" internally.
   * Consumers can use getModelThinkingCapabilities() and clampThinkingLevel()
   * to avoid exposing unsupported levels.
   */
  thinkingLevel?: ThinkingLevel;

  /**
   * Limit the effective context window for compaction calculations.
   * Positive integer, clamped to backend capacity without a minimum budget floor.
   * This is a compaction budget. Set OllamaModelConfig.contextWindowLimit to also cap server allocation.
   * null or undefined = use the model's full context window.
   */
  contextWindowLimit?: number | null;

  /** Compaction configuration. All layers are always active. */
  compaction?: Partial<CortexCompactionConfig>;

  /**
   * Deferred tool loading. When enabled, tools marked for deferral are NOT
   * included in the `tools` array sent on every API turn. Instead, their
   * names appear in an internally-managed `_available_tools` slot, and the
   * agent uses the auto-registered `ToolSearch` tool to load specific tools
   * on demand.
   *
   * Useful when consumers connect MCP servers with many tools: schemas are
   * only paid for once a tool is actually needed, instead of every turn.
   */
  deferredTools?: DeferredToolsConfig;

  /**
   * Persists oversized tool results to disk and returns the file path.
   *
   * When configured, large tool results (>25K tokens by default) are
   * replaced in the conversation with a bookend preview (head + tail)
   * plus a file reference, so the model can use the Read tool to access
   * the full content on demand.
   *
   * Used by both the proactive tool execution interceptor and the
   * reactive compaction paths (microcompaction trim, aggregate budget
   * enforcement). Consumer owns the storage location and cleanup.
   *
   * If both this and `compaction.microcompaction.persistResult` are set,
   * this top-level setting wins (and is propagated to microcompaction).
   */
  persistResult?: PersistResultFn;

  /**
   * Per-tool token threshold overrides for the result-persistence interceptor.
   *
   * Tools not listed here use the built-in defaults (Bash: 7,500 to keep
   * verbose command output tight; everything else: 25,000).
   *
   * Useful for tuning specific MCP tools or custom tools whose output has
   * unusual size characteristics (e.g., a tool that returns large JSON payloads
   * where you want a smaller cap, or a research tool whose output you want to
   * keep more of in context).
   */
  toolResultThresholds?: Record<string, number>;

  /**
   * Consumer-set environment variables that propagate to ALL subprocesses
   * (Bash tool, MCP stdio servers), bypassing the security blocklist.
   *
   * Use case: macOS dock icon suppression requires DYLD_INSERT_LIBRARIES
   * and ANIMUS_DOCK_SUPPRESS_ADDON to propagate to child processes, but
   * the safe-env blocklist strips DYLD_ prefixed variables by default.
   * envOverrides are merged ON TOP of the sanitized environment, restoring
   * these specific variables.
   */
  envOverrides?: Record<string, string>;

  /**
   * Optional logger for Cortex internal diagnostics.
   * If omitted, all internal logging is silently discarded (no-op).
   * The library never decides where logs go; only the consumer does.
   *
   * Compatible with `console` for quick development: `{ logger: console }`.
   */
  logger?: CortexLogger;

  /**
   * Optional diagnostics for investigating prompt or provider stalls.
   * All diagnostics are opt-in and should remain disabled in normal use.
   */
  diagnostics?: CortexDiagnosticsConfig;

  /**
   * Stable identifier for prefix-cache routing. Passed to the provider as its
   * cache/session key (e.g. OpenAI's prompt_cache_key) so requests sharing a
   * long common prefix are routed to the same inference machine and reuse
   * cached KV state. Use a value that is stable across the calls that share a
   * prefix (e.g. one per logical session). Can also be set later via
   * setSessionId(). Optional.
   */
  sessionId?: string;

  /**
   * Path identity for this loop, threaded through consumer-visible signals
   * (permission asks, onError/onTurnComplete origin context, persistResult
   * metadata, log prefixes) so several loops behind one owner stay
   * distinguishable. Sub-agents spawned by this loop extend it with
   * '/<taskId>'. Default: 'main'.
   */
  loopPath?: string;

  /**
   * Called before a sub-agent is spawned (foreground or background), giving
   * the consumer a chance to record the spawn and curate the child's starting
   * context. Receives the requested spawn parameters plus the generated taskId,
   * and may return an augmentation that overrides the child's system prompt or
   * tool set and injects an initial background-context slot. Purely additive:
   * if omitted, sub-agents spawn with the default inherited context.
   */
  onBeforeSubAgentSpawn?: (
    req: SubAgentSpawnRequest,
  ) => SubAgentSpawnAugmentation | void | Promise<SubAgentSpawnAugmentation | void>;

  /**
   * Optional consumer gate consulted before a sub-agent spawn, in addition to
   * the built-in concurrency limit. Return false (or { allowed: false, reason })
   * to refuse the spawn, e.g. when a budget or policy ceiling has been hit. The
   * reason is surfaced to the model as the SubAgent tool result so it knows why
   * it could not delegate. Omit to always allow (subject to concurrency).
   */
  canSpawnSubAgent?: () => boolean | { allowed: boolean; reason?: string };

  /**
   * External shared MCP client manager. When provided, this loop uses it
   * instead of constructing its own: one connection (and one stdio
   * subprocess) per server total, shared across every loop holding the same
   * manager. Registration is additive (listener arrays), so several loops
   * observe tool changes and subprocess lifecycle without displacing each
   * other. Ownership stays with the provider: the loop unsubscribes its own
   * listeners on destroy but never closes the shared connections, and the
   * owner configures the manager's logger, envOverrides, and sandbox. The
   * duplex facade uses this to multiplex one manager into the reasoner
   * (docs/cortex/duplex/sub-agents.md "MCP and Shared Services"). When
   * omitted, the loop owns a private manager exactly as before.
   */
  mcpClientManager?: McpClientManager;
}

/**
 * Prompt watchdog diagnostics configuration.
 *
 * Emits bounded lifecycle and heartbeat logs around prompt() and abort().
 * Intended for investigating freezes or hung provider calls.
 */
export interface PromptWatchdogDiagnosticsConfig {
  /** Whether prompt watchdog diagnostics are enabled. Default: false. */
  enabled?: boolean;
  /** Heartbeat interval while a prompt is in flight. Default: 1000ms. */
  heartbeatIntervalMs?: number;
  /** Warn if abort waits longer than this for idle. Default: 2000ms. */
  abortWaitWarningMs?: number;
}

/**
 * Optional diagnostics for Cortex internals.
 *
 * These are intentionally narrow and structured so consumers can opt into
 * targeted investigations without turning normal debug logging into trace spam.
 */
export interface CortexDiagnosticsConfig {
  /** Prompt and abort watchdog logs for freeze investigation. */
  promptWatchdog?: PromptWatchdogDiagnosticsConfig;
}

// ---------------------------------------------------------------------------
// Deferred Tools
// ---------------------------------------------------------------------------

/**
 * Configuration for deferred tool loading.
 *
 * Reference: docs/cortex/tools/tool-search.md (TBD)
 */
export interface DeferredToolsConfig {
  /**
   * Master switch. When false (default), all tools are sent on every turn
   * exactly as before. When true, tools marked for deferral are pulled out
   * of the per-turn tools array and announced by name in the
   * `_available_tools` slot instead.
   */
  enabled?: boolean;

  /**
   * When true (default), all MCP tools are deferred. When false, MCP tools
   * are sent in full like built-ins. Has no effect when `enabled` is false.
   */
  deferMcp?: boolean;

  /**
   * Tool names that should never be deferred even if they match deferral
   * criteria (overrides `shouldDefer` and `deferMcp` for the named tools).
   * Use this to keep specific MCP tools always loaded.
   */
  alwaysLoad?: string[];
}

// ---------------------------------------------------------------------------
// Context Manager
// ---------------------------------------------------------------------------

/**
 * Configuration for the ContextManager.
 *
 * Slots define the ordered list of persistent content blocks at the start
 * of the message array. Order determines position (first = most stable,
 * best prefix cache hit rate).
 */
export interface ContextManagerConfig {
  /** Ordered list of slot names. */
  slots: string[];
}

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

/**
 * Error categories for classifying LLM and network errors.
 * Checked in priority order (first match wins).
 */
export type ErrorCategory =
  | 'authentication'
  | 'rate_limit'
  | 'context_overflow'
  | 'server_error'
  | 'network'
  | 'cancelled'
  | 'unknown';

/**
 * Error severity levels.
 * - fatal: unrecoverable, stop processing (e.g., invalid API key)
 * - retry: transient, can be retried (e.g., rate limit, server error, network)
 * - recoverable: can be handled without retry (e.g., context overflow triggers compaction)
 */
export type ErrorSeverity = 'fatal' | 'retry' | 'recoverable';

/**
 * A classified error with category, severity, original message, and suggested action.
 */
export interface ClassifiedError {
  /** The error category determined by pattern matching. */
  category: ErrorCategory;
  /** The severity level for the category. */
  severity: ErrorSeverity;
  /** The original error message string. */
  originalMessage: string;
  /**
   * Concise detail extracted from the error's `cause` chain, when the
   * top-level message is generic. Node's fetch (undici) and the Anthropic SDK
   * bury the real reason several `cause` levels below an opaque message like
   * "Connection error." (e.g. "fetch failed: read ECONNRESET"). Undefined when
   * the cause chain adds nothing over `originalMessage`.
   */
  causeDetail?: string;
  /** Human-readable suggested action, or undefined if no action is needed. */
  suggestedAction?: string;
}

// ---------------------------------------------------------------------------
// Retry Policy
// ---------------------------------------------------------------------------

/**
 * Policy for cortex's background retry loop, which sits ABOVE pi-ai's
 * HTTP-level retries. pi-ai retries fast (seconds, honoring `Retry-After`).
 * Cortex only sees an error after that is exhausted, and retries on the scale
 * of minutes by resuming the failed turn (pi-agent-core `continue()`), so no
 * tool calls re-run and the user message is not duplicated.
 *
 * Only transient categories retry. Fatal or human-actionable failures
 * (authentication, context overflow, a 404 classified as unknown) surface
 * immediately for the user to fix.
 */
export interface RetryPolicy {
  /** Master switch. Default: true. */
  enabled: boolean;
  /**
   * Error categories eligible for background retry.
   * Default: ['network', 'server_error', 'rate_limit'].
   */
  retryableCategories: ErrorCategory[];
  /**
   * Backoff before each retry, indexed by retry number (0-based). Entries past
   * the end of the array fall back to `maxBackoffMs`. Default:
   * [120_000, 240_000, 480_000] (2m, 4m, 8m), then capped at 10m.
   */
  backoffMs: number[];
  /** Hard cap on any single backoff delay. Default: 600_000 (10m). */
  maxBackoffMs: number;
  /** Maximum number of retries before giving up. Default: 20. */
  maxAttempts: number;
  /**
   * Optional ceiling on total elapsed time since the first failure. When set,
   * no retry is scheduled once this is exceeded, regardless of attempt count.
   */
  maxElapsedMs?: number;
}

/** Payload for the onRetryScheduled hook, fired before each backoff wait. */
export interface RetryScheduledInfo {
  /** The classified category that triggered the retry. */
  category: ErrorCategory;
  /** 1-based index of the retry about to be waited for. */
  attempt: number;
  /** Total retries allowed (from the policy). */
  maxAttempts: number;
  /** Backoff delay, in ms, before this attempt. */
  delayMs: number;
  /** Wall-clock timestamp (ms) the next attempt is expected to start. */
  nextAttemptAt: number;
  /** The original (top-level) error message. */
  originalMessage: string;
  /** Detail extracted from the error's cause chain, when available. */
  causeDetail?: string;
}

/** Payload for the onRetrySucceeded hook, fired when a retry resolves the turn. */
export interface RetrySucceededInfo {
  /** Number of retries it took to succeed. */
  attempts: number;
}

/** Payload for the onRetryExhausted hook, fired when retries are given up on. */
export interface RetryExhaustedInfo {
  /** Number of retries attempted before giving up. */
  attempts: number;
  /** The category of the final failure. */
  category: ErrorCategory;
}

// ---------------------------------------------------------------------------
// Working Tags
// ---------------------------------------------------------------------------

/**
 * Structured output from parsing working tags in agent text.
 *
 * Working tags separate internal reasoning (<working>...</working>) from
 * user-facing communication. Both remain in conversation history; the
 * difference is only in delivery.
 */
export interface AgentTextOutput {
  /** Text intended for the user (working tag content stripped, whitespace normalized). */
  userFacing: string;
  /** Content from inside <working> tags, concatenated. Null if no working tags present. */
  working: string | null;
  /** The original unparsed text exactly as the agent produced it. */
  raw: string;
}

// ---------------------------------------------------------------------------
// Tool Results
// ---------------------------------------------------------------------------

/**
 * Structured tool result with content array and typed details.
 */
export interface ToolContentDetails<T> {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >;
  details: T;
}

// ---------------------------------------------------------------------------
// Tool Execute Context
// ---------------------------------------------------------------------------

/**
 * Context passed to tool execute functions by the pi-agent-core adapter.
 *
 * Tools that want streaming support accept this as an optional second parameter.
 * Tools that don't need it simply ignore it (backward compatible).
 */
export interface ToolExecuteContext {
  /** Unique identifier for this tool call. */
  toolCallId: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /**
   * Callback for emitting incremental results during execution.
   * Pi-agent-core emits these as tool_execution_update events.
   * Useful for long-running tools (bash, sub-agents) that want to
   * stream progress to the consumer's UI.
   */
  onUpdate?: (partialResult: ToolContentDetails<unknown>) => void;
}

// ---------------------------------------------------------------------------
// Event Payloads
// ---------------------------------------------------------------------------

/**
 * Typed payload for tool_call_start events.
 */
export interface ToolCallStartPayload {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * A message of the run as turn_end and loop_end payloads carry it, typed to
 * the fields Cortex reads (the raw pi message, with everything else, stays
 * on `event.data`). A failed or aborted attempt ends with pi's synthetic
 * assistant stub: stopReason 'error' or 'aborted', or an errorMessage.
 */
export interface LoopMessageView {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

/** Typed payload for turn_end events. */
export interface TurnEndPayload {
  /** The assistant message the turn ended with; absent when pi's event carried none. */
  message?: LoopMessageView;
}

/** Typed payload for loop_end events: the messages the run added, in order. */
export interface LoopEndPayload {
  messages: LoopMessageView[];
}

/**
 * Typed payload for tool_call_update events.
 */
export interface ToolCallUpdatePayload {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  partialResult: ToolContentDetails<unknown>;
}

/**
 * Typed payload for tool_call_end events.
 */
export interface ToolCallEndPayload {
  toolCallId: string;
  toolName: string;
  result: ToolContentDetails<unknown>;
  durationMs: number;
  isError: boolean;
  error?: string;
}

/**
 * Typed payload for utility_usage events, emitted once per direct/utility
 * completion (observer, reflector, summarization, WebFetch summarization,
 * Bash utility calls, consumer-tagged calls). The usage itself rides the
 * event's `usage` field.
 */
export interface UtilityUsagePayload {
  /** The category tag the spend was recorded under. */
  category: string;
}

/**
 * Typed payload for the duplex facade's sanitized talker-delta events
 * ('talker_delta'): the voice-safe streaming text of the talker's current
 * assistant message, with working-tag content removed by holdback buffering
 * across chunk boundaries. Voice consumers route THIS to TTS, never raw
 * response_chunk (whose deltas carry `<working>` content verbatim).
 */
export interface TalkerDeltaPayload {
  /** Sanitized delta text, safe to speak. */
  text: string;
}

// ---------------------------------------------------------------------------
// Budget Guard
// ---------------------------------------------------------------------------

/**
 * What a budget guard's limits span.
 * - `'prompt'`: the owner resets counters at each prompt; limits bound one
 *   logical turn (the historical behavior).
 * - `'lifetime'`: counters are never reset; limits bound the guard's whole
 *   life, and a breached guard keeps aborting turns started after the breach.
 */
export type BudgetScope = 'prompt' | 'lifetime';

/**
 * Budget guard configuration with explicit limits.
 * Both default to Infinity (no enforcement).
 */
export interface BudgetGuardConfig {
  /** Maximum number of LLM turns. Default: Infinity. */
  maxTurns: number;
  /** Maximum cost in USD. Default: Infinity. */
  maxCost: number;
  /** What the limits span. Default: 'prompt'. */
  scope?: BudgetScope;
  /**
   * Count forwarded child (sub-agent) turn_end usage against this guard's
   * limits instead of skipping it. Default false. The plumbing an aggregate
   * guard needs to bound a loop plus everything it spawns.
   */
  includeChildUsage?: boolean;
  /**
   * Count direct/utility completion spend (observer, reflector,
   * summarization, WebFetch, Bash utility calls) against maxCost, via the
   * utility_usage event. Default false. Without it an aggregate guard is
   * blind to exactly the spend class duplex doubles (two resident loops
   * observing overlapping content), so the facade's aggregate guard sets it.
   */
  includeUtilityUsage?: boolean;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Tool category for microcompaction retention decisions.
 * - rereadable: agent can re-read the source (files, directories)
 * - non-reproducible: output may change or cost to re-fetch (web, APIs)
 * - ephemeral: stale quickly, trivially re-runnable (ls, git status)
 * - computational: small results from computations, non-reproducible without re-running
 */
export type ToolCategory = 'rereadable' | 'non-reproducible' | 'ephemeral' | 'computational';

/**
 * Microcompaction configuration: progressive tool result trimming.
 */
/**
 * Callback invoked when microcompaction persists a cleared tool result to disk.
 * The consumer implements the actual I/O and returns the file path.
 *
 * @param content - The full original tool result content
 * @param metadata - Information about the result being persisted
 * @returns The file path where the content was saved
 */
export type PersistResultFn = (
  content: string,
  metadata: {
    toolName: string;
    category: ToolCategory;
    /** Present when called from the proactive tool execution interceptor. */
    toolCallId?: string;
    /** Present when called from compaction (reactive paths). */
    messageIndex?: number;
    /**
     * Path identity of the loop whose tool result is being persisted (e.g.
     * 'main', or 'main/<taskId>' for a sub-agent). Always set when the
     * callback is invoked through an AgentLoop.
     */
    loopPath?: string;
  },
) => Promise<string>;

export interface MicrocompactionConfig {
  /** Maximum tokens for a single tool result at insertion time. Default: 50000. */
  maxResultTokens: number;

  // --- Cache-aware gating ---
  /**
   * Minimum context utilization ratio below which L1 never trims, even when
   * the cache is cold. Prevents pointless work on nearly empty contexts.
   * Default: 0.25 (25%).
   */
  trimFloorRatio: number;

  /**
   * Under a provider that caches the prompt prefix automatically (no
   * explicit breakpoints, unknown lifetime), the context utilization ratio
   * from which L1 trims anyway: below it the prefix is worth more than the
   * tokens trimming would free. Default: 0.70 (70%).
   */
  prefixTrimRatio: number;

  // --- Hot zone (token-offset recency window) ---
  /**
   * Absolute floor for the hot zone size (in tokens). Tool results within the
   * hot zone of the most recent message are never trimmed. The effective hot
   * zone is `min(contextWindow / 2, max(hotZoneMinTokens, contextWindow * hotZoneRatio))`.
   * Default: 16000.
   */
  hotZoneMinTokens: number;
  /**
   * Hot zone as a fraction of the context window. Wins over the floor on
   * very large windows. Default: 0.05 (5%).
   */
  hotZoneRatio: number;
  /**
   * Multiplier applied to the hot zone for non-reproducible tools. When
   * undefined, resolves to 1.0 if a persistResult callback is configured
   * (full content recoverable from disk) or 1.5 if not (some buffer since
   * content is lost on trim).
   */
  extendedRetentionMultiplier?: number;

  // --- Progressive bookend degradation ---
  /** Bookend size at the hot zone boundary (chars per side). Default: 2000. */
  bookendMaxChars: number;
  /** Bookend size at the far end of the degradation span (chars per side). Default: 256. */
  bookendMinChars: number;
  /**
   * The degradation span as a fraction of the context window. Bookend size
   * interpolates linearly from bookendMaxChars to bookendMinChars across this
   * span. Beyond the span, results become placeholder or clear based on tool
   * category. Default: 0.40 (40%).
   */
  degradationSpanRatio: number;

  // --- Tool categorization ---
  /** Tool name to category mapping. Unregistered tools default to standard retention. */
  toolCategories?: Record<string, ToolCategory>;

  // --- Persistence ---
  /**
   * Callback to persist tool results to disk before destructive trim actions
   * (bookend, placeholder, clear). When set, the in-context replacement
   * includes a file path reference the agent can Read to recover full content.
   * Only fires for non-reproducible and computational tools.
   *
   * Typically set at the top-level AgentLoopConfig.persistResult and
   * propagated here automatically.
   */
  persistResult?: PersistResultFn;

  /** Maximum aggregate tokens for all tool results in a single turn. Default: 150000. */
  maxAggregateTurnTokens?: number;
}

/**
 * Conversation summarization (Layer 2) configuration.
 */
export interface CompactionConfig {
  /** Context usage ratio that triggers summarization. Default: 0.70. */
  threshold: number;
  /** Number of recent turns preserved verbatim. Default: 6. */
  preserveRecentTurns: number;
  /** Custom summarization prompt. If provided, replaces the default prompt. */
  customPrompt?: string;
  /** Maximum Layer 2 retry attempts before falling through to Layer 3. Default: 3. */
  maxRetries?: number;
  /** Delay in ms between Layer 2 retry attempts. Default: 2000. */
  retryDelayMs?: number;
}

/**
 * Emergency truncation (Layer 3) configuration.
 */
export interface FailsafeConfig {
  /**
   * Context usage ratio that triggers emergency truncation. Default: 0.95.
   * Under observational memory it is measured against the effective window
   * and truncates only the request's view (the source keeps every message
   * for the observer); under the classic strategy, against the model's
   * window.
   */
  threshold: number;
}

/**
 * Adaptive threshold configuration for Layer 2 compaction.
 *
 * Adjusts the compaction trigger point based on how recently the user last
 * interacted. When the user is idle (no messages for a while), the threshold
 * is lowered so compaction fires earlier, reducing token costs during interval
 * ticks where the agent is thinking to itself.
 *
 * Three windows:
 * - Recent (< recentWindowMs): no threshold reduction
 * - Moderate (recentWindowMs .. idleWindowMs): moderateReduction applied
 * - Idle (> idleWindowMs): idleReduction applied
 *
 * The effective threshold is: config.compaction.threshold - reduction
 */
export interface AdaptiveThresholdConfig {
  /** Whether adaptive thresholds are enabled. Default: true. */
  enabled: boolean;
  /** Milliseconds within which interaction is considered "recent". Default: 300000 (5 min). */
  recentWindowMs: number;
  /** Milliseconds beyond which interaction is considered "idle". Default: 1800000 (30 min). */
  idleWindowMs: number;
  /** Threshold reduction when interaction is recent. Default: 0.0. */
  recentReduction: number;
  /** Threshold reduction when interaction is moderate. Default: 0.10. */
  moderateReduction: number;
  /** Threshold reduction when interaction is idle. Default: 0.20. */
  idleReduction: number;
}

/**
 * Full compaction configuration for AgentLoop.
 *
 * Supports two strategies:
 * - `'observational'` (default): Observer/Reflector background compression
 *   replaces L1 threshold trimming and L2 summarization. L3 emergency
 *   truncation remains active as a safety valve.
 * - `'classic'`: The existing L1 + L2 + L3 system operates unchanged.
 *
 * The failsafe (L3) is always active regardless of strategy.
 */
export interface CortexCompactionConfig {
  /**
   * Compaction strategy selection.
   * - `'observational'`: Background observer/reflector compression (default).
   * - `'classic'`: Traditional L1 microcompaction + L2 summarization.
   * @default 'observational'
   */
  strategy?: 'observational' | 'classic';

  /**
   * Non-blocking posture: disable every synchronous LLM call inside
   * transformContext, leaving emergency truncation as the only in-band
   * fallback. For a presence loop whose turns must never stall on a
   * multi-second observer or summarization call.
   *
   * - Observational strategy: activation still consumes already-buffered
   *   chunks (instant), but the forced synchronous observer on the
   *   unobserved tail and the pre-truncation catch-up observation are
   *   skipped, and reflection at threshold swaps in a buffered result or
   *   launches asynchronously instead of running inline.
   * - Classic strategy: L2 summarization is skipped in-band (L1 trimming
   *   and L3 truncation, both mechanical, still run).
   *
   * Explicit digestion entry points run the blocking work regardless, so an
   * owner can schedule it during idle windows.
   * @default false
   */
  nonBlocking?: boolean;

  /** Microcompaction (L1) configuration. Used when strategy is 'classic'. */
  microcompaction: MicrocompactionConfig;
  /** Conversation summarization (L2) configuration. Used when strategy is 'classic'. */
  compaction: CompactionConfig;
  /** Emergency truncation (L3) configuration. Always active regardless of strategy. */
  failsafe: FailsafeConfig;
  /** Adaptive threshold configuration. Adjusts Layer 2 trigger based on interaction recency. Used when strategy is 'classic'. */
  adaptive: AdaptiveThresholdConfig;

  /**
   * Observational memory configuration. Used when strategy is 'observational'
   * (or omitted, since observational is the default).
   */
  observational?: Partial<ObservationalMemoryConfig>;
}

/**
 * Information about the compaction target passed to onBeforeCompaction.
 */
export interface CompactionTarget {
  /** Number of turns that will be summarized. */
  turnsToCompact: number;
  /** Estimated tokens in the compaction target. */
  estimatedTokens: number;
}

/**
 * Result of a compaction operation.
 */
export interface CompactionResult {
  /** Total tokens before compaction. */
  tokensBefore: number;
  /** Total tokens after compaction. */
  tokensAfter: number;
  /** Number of conversation turns that were compacted (summarized/removed). */
  turnsCompacted: number;
  /** Number of conversation turns preserved after compaction. */
  turnsPreserved: number;
  /** Token count of the generated summary. */
  summaryTokens: number;
  /**
   * ISO timestamp of the oldest preserved turn, or null if no timestamp
   * could be determined. The consumer (backend) should use
   * `oldestPreservedIndex` to map back to a database timestamp when
   * this is null.
   */
  oldestPreservedTimestamp: string | null;
  /**
   * Index of the oldest preserved turn in the original (pre-compaction)
   * conversation history. The consumer can map this index back to a
   * database timestamp via messages.db. Always present and accurate.
   */
  oldestPreservedIndex: number;
  /** The generated summary text. */
  summary: string;
}

/**
 * Info passed to onCompactionDegraded when Layer 2 failed and Layer 3 was used.
 */
export interface CompactionDegradedInfo {
  /** Number of consecutive Layer 2 failures (including this episode). */
  layer2Failures: number;
  /** Number of turns dropped by emergency truncation. */
  turnsDropped: number;
}

/**
 * Info passed to onCompactionExhausted when all compaction layers have failed.
 */
export interface CompactionExhaustedInfo {
  /** The error from the last Layer 2 attempt. */
  error: Error;
  /** Number of consecutive Layer 2 failures. */
  layer2Failures: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Event handlers emitted by AgentLoop during the agentic loop lifecycle.
 */
export interface CortexEvents {
  /** Fired when the full agentic loop finishes (agent_end, not turn_end). */
  onLoopComplete: () => void;
  /** Fired before compaction starts. Awaited. Consumer should flush state. */
  onBeforeCompaction: (target: CompactionTarget) => Promise<void>;
  /** Fired after compaction completes. Consumer can re-seed messages, update state. */
  onPostCompaction: (result: CompactionResult) => void;
  /** Fired when context compaction fails. */
  onCompactionError: (error: Error) => void;
  /** Fired when Layer 2 compaction failed and Layer 3 (emergency truncation) was used as fallback. */
  onCompactionDegraded: (info: CompactionDegradedInfo) => void;
  /** Fired when all compaction layers have failed. Consumer should take recovery action. */
  onCompactionExhausted: (info: CompactionExhaustedInfo) => void;
  /** Fired when an error is classified during the agentic loop. */
  onError: (error: ClassifiedError, origin: LoopOriginContext) => void;
  /** Fired at the end of each turn with parsed working tag output. */
  onTurnComplete: (output: AgentTextOutput, origin: LoopOriginContext) => void;
  /** Fired when a sub-agent is spawned for delegated work. */
  onSubAgentSpawned: (taskId: string, instructions: string, background: boolean) => void;
  /** Fired when a sub-agent completes successfully. */
  onSubAgentCompleted: (taskId: string, result: string, status: string, usage: unknown) => void;
  /** Fired when a sub-agent fails. */
  onSubAgentFailed: (taskId: string, error: string) => void;
  /** Fired when observational memory activates (messages compressed and removed). Only fires when strategy is 'observational'. */
  onObservation: (event: ObservationEvent) => void;
  /** Fired when the reflector condenses observations. Only fires when strategy is 'observational'. */
  onReflection: (event: ReflectionEvent) => void;
}

// ---------------------------------------------------------------------------
// MCP Client
// ---------------------------------------------------------------------------

/**
 * Transport configuration for connecting to an MCP server.
 * Either stdio (spawn subprocess) or HTTP (connect to running server).
 */
export type McpTransportConfig = McpStdioConfig | McpHttpConfig;

/**
 * Stdio transport: spawn a subprocess and communicate via stdin/stdout.
 */
export interface McpStdioConfig {
  transport: 'stdio';
  /** The executable to run (e.g., 'node', '/path/to/tsx'). */
  command: string;
  /** Command line arguments. */
  args?: string[];
  /** Environment variables for the subprocess. */
  env?: Record<string, string>;
  /** Working directory for the subprocess. */
  cwd?: string;
  /**
   * Per-tool timeout for `tools/call`, in milliseconds. When set, this
   * overrides the MCP SDK default (60 seconds) and the call is rearmed on
   * every `notifications/progress` the server emits. Use higher values for
   * tools that legitimately block on external state (e.g. waiting for a
   * human decision). Omit to inherit the SDK default.
   */
  toolTimeoutMs?: number;
}

/**
 * HTTP transport: connect to an already-running MCP server via Streamable HTTP.
 */
export interface McpHttpConfig {
  transport: 'http';
  /** The URL of the MCP server endpoint. */
  url: string;
  /** Optional HTTP headers (e.g., for authentication). */
  headers?: Record<string, string>;
  /**
   * Per-tool timeout for `tools/call`, in milliseconds. See
   * {@link McpStdioConfig.toolTimeoutMs} for semantics.
   */
  toolTimeoutMs?: number;
}

/**
 * Progress event surfaced when an MCP server emits `notifications/progress`
 * during a long-running `tools/call`. Consumers can wire this to a UI
 * notification ("still waiting on connection accept...") without depending
 * on `@modelcontextprotocol/sdk` directly.
 */
export interface McpToolCallProgress {
  /** The MCP server that emitted the progress notification. */
  serverName: string;
  /** The tool name (without server namespace prefix). */
  toolName: string;
  /** Current progress value as reported by the server. Monotonically rising. */
  progress: number;
  /** Total expected progress if the server provided one. */
  total?: number;
  /** Optional human-readable progress message. */
  message?: string;
}

/**
 * Redacted stdio transport config. Identical to {@link McpStdioConfig} except
 * that the secret-bearing `env` map is dropped and replaced by a boolean
 * presence flag. Surfaced in {@link McpConnectionState} so connection state can
 * be shown to display/telemetry consumers without leaking credentials.
 */
export type McpRedactedStdioConfig = Omit<McpStdioConfig, 'env'> & {
  /** True when the original config supplied environment variables (values withheld). */
  hasEnv: boolean;
};

/**
 * Redacted HTTP transport config. Identical to {@link McpHttpConfig} except
 * that the secret-bearing `headers` map is dropped and replaced by a boolean
 * presence flag.
 */
export type McpRedactedHttpConfig = Omit<McpHttpConfig, 'headers'> & {
  /** True when the original config supplied HTTP headers (values withheld). */
  hasHeaders: boolean;
};

/**
 * Transport config with all secret-bearing fields redacted. Never carries
 * `env` (stdio) or `headers` (http) values; presence is conveyed by the
 * `hasEnv` / `hasHeaders` flags instead.
 */
export type McpRedactedTransportConfig = McpRedactedStdioConfig | McpRedactedHttpConfig;

/**
 * State of a single MCP server connection.
 *
 * The `config` is redacted: `env` (stdio) and `headers` (http) hold secrets
 * (API keys, auth tokens) and are never included. This lets consumers surface
 * connection state to logs, telemetry, or UI without leaking credentials.
 */
export interface McpConnectionState {
  /** The server name used for namespacing tools. */
  serverName: string;
  /** Redacted transport configuration for this connection (no secret values). */
  config: McpRedactedTransportConfig;
  /** Whether the connection is currently active. */
  connected: boolean;
  /** Number of reconnect attempts since last successful connection. */
  reconnectAttempts: number;
  /** Names of tools discovered from this server (namespaced). */
  toolNames: string[];
}

// ---------------------------------------------------------------------------
// Model Tiers
// ---------------------------------------------------------------------------

/**
 * Default utility model mapping per provider.
 * Keys are provider names, values are model IDs.
 */
export interface UtilityModelDefaults {
  [provider: string]: string;
}

// ---------------------------------------------------------------------------
// Skill System
// ---------------------------------------------------------------------------

/**
 * Configuration for registering a skill with the SkillRegistry.
 * The consumer provides these at startup and dynamically as plugins install/uninstall.
 */
export interface SkillConfig {
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Where this skill came from. Used for display and debugging. */
  source: string;  // e.g., 'plugin:weather', 'plugin:discord', 'user', 'builtin'
  /**
   * Per-skill variables for ${VAR} substitution in the SKILL.md body.
   * Merged into the preprocessor variables when getSkillBody() runs.
   * Useful for plugin skills that reference ${PLUGIN_ROOT}.
   */
  variables?: Record<string, string>;
}

/**
 * Internal skill index entry built from parsing a SKILL.md file.
 */
export interface SkillEntry {
  /** Skill name from frontmatter (kebab-case). */
  name: string;
  /** Skill description from frontmatter (for agent activation). */
  description: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Absolute path to the skill directory (parent of SKILL.md). */
  dir: string;
  /** Source identifier from SkillConfig. */
  source: string;
  /** Full parsed YAML frontmatter (preserved for forward compatibility). */
  frontmatter: Record<string, unknown>;
  /** Whether the agent can auto-load this skill. Derived from disable-model-invocation. */
  modelInvocable: boolean;
  /** Per-skill variables for ${VAR} substitution. */
  variables?: Record<string, string>;
}

/**
 * A loaded skill in the skill buffer (preprocessed body ready for injection).
 */
export interface LoadedSkill {
  /** The skill name. */
  name: string;
  /** The preprocessed SKILL.md body content. */
  content: string;
}

/**
 * Context object passed to skill preprocessor scripts (!{script: path}).
 * Cortex owns the built-in fields; the consumer provides everything else.
 */
export interface CortexScriptContext {
  /** Absolute path to the skill's directory. */
  skillDir: string;
  /** Arguments passed to the skill (split by whitespace). */
  args: string[];
  /** Raw arguments string. */
  rawArgs: string;
  /** Additional key-value pairs from !{script: path, key: value} syntax. */
  scriptArgs: Record<string, string>;
  /** Consumer-provided context fields (Cortex does not inspect these). */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sub-Agent
// ---------------------------------------------------------------------------

/**
 * Configuration for spawning a sub-agent via the SubAgent tool.
 */
export interface SubAgentSpawnConfig {
  /** What the sub-agent should do. Becomes the initial prompt. */
  instructions: string;
  /** Tool names to make available. Default: inherits parent's tools. */
  tools?: string[];
  /** Custom system prompt. Default: inherits parent's system prompt. */
  systemPrompt?: string;
  /** Maximum LLM turns. Default: inherits parent's budget guard config. */
  maxTurns?: number;
  /** Maximum cost in USD. Default: inherits parent's budget guard config. */
  maxCost?: number;
  /** Run asynchronously. Default: false (blocks until complete). */
  background?: boolean;
  /**
   * Wall-clock cap in milliseconds for the whole spawn. On expiry the child
   * is aborted and its result reports status 'timed_out' (with whatever
   * partial output its transcript holds). Default: no cap.
   */
  timeoutMs?: number;
  /**
   * Model for this spawn. Default: the parent's primary model. The child's
   * utility model re-resolves from this model's provider, so a fast-model
   * spawn stays fast end to end.
   */
  model?: CortexModel;
  /** Thinking level for this spawn. Default: pi-agent-core's default. */
  thinkingLevel?: ThinkingLevel;
  /** Compaction configuration for this spawn. Default: Cortex defaults. */
  compaction?: Partial<CortexCompactionConfig>;
  /**
   * Named concurrency pool this spawn counts against (see
   * AgentLoopConfig.subAgentPools). Spawns without a pool count against
   * maxConcurrentSubAgents. Pools are independent: work in one pool never
   * blocks capacity in another.
   */
  pool?: string;
}

/**
 * Describes a sub-agent about to be spawned. Passed to
 * AgentLoopConfig.onBeforeSubAgentSpawn so a consumer can record the spawn
 * and decide what background context to seed.
 */
export interface SubAgentSpawnRequest {
  /** The generated task ID for this sub-agent. */
  taskId: string;
  /** The instructions the sub-agent will run with (its sole objective). */
  instructions: string;
  /** Whether the sub-agent runs in the background. */
  background: boolean;
  /** Tool names the caller requested, if any. */
  requestedTools?: string[];
  /** Custom system prompt the caller requested, if any. */
  requestedSystemPrompt?: string;
}

/**
 * Optional augmentation returned from onBeforeSubAgentSpawn.
 * Every field is optional; unset fields fall back to inherited defaults.
 */
export interface SubAgentSpawnAugmentation {
  /** Override the child's system prompt. Default: inherit parent's. */
  systemPrompt?: string;
  /**
   * Background context to seed into the child as an initial context slot.
   * This is reference material, NOT the child's objective: the child's task
   * is defined solely by its instructions. Rendered verbatim and ordered
   * before conversation history for prefix-cache stability.
   */
  seedContext?: string;
  /** Override the child's tool set by name. Default: inherit parent's. */
  tools?: string[];
}

/**
 * Read-only snapshot of a running sub-agent, returned by getActiveSubAgents().
 */
export interface SubAgentSnapshot {
  taskId: string;
  instructions: string;
  background: boolean;
  spawnedAt: number;
  status: 'running' | 'waiting-for-permission';
  toolCount: number;
  lastToolName: string | null;
  lastToolSummary: string | null;
  lastToolStartedAt: number | null;
  /** Live accumulated cost of this sub-agent in USD. */
  liveCostUsd: number;
  /** Turns used so far. */
  turnsUsed: number;
}

/**
 * Result returned by a completed sub-agent.
 */
export interface SubAgentResult {
  /** The sub-agent's final text output. */
  output: string;
  /** Completion status. */
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  /** Usage summary. */
  usage: {
    turns: number;
    cost: number;
    durationMs: number;
    contextTokens: number;
  };
  /** Summary of tool calls made by the sub-agent (extracted from conversation history on completion). */
  toolCalls?: Array<{ name: string; durationMs: number; error?: string }>;
}

/**
 * Content the loop gave up on delivering after repeated failures: a
 * background completion (sub-agent result or backgrounded Bash command)
 * dropped from the delivery queue, or a parked wake delivery whose
 * carrying runs failed until its attempt cap or elapsed budget ran out.
 * Returned by getDeadLetteredBackgroundResults() so a consumer can surface
 * or re-drive the work; without this, a deterministic delivery failure
 * would either redeliver forever or vanish silently.
 */
export interface DeadLetteredBackgroundResult {
  /**
   * What kind of work produced the dropped content: a background sub-agent
   * or Bash command, or a loop-owned delivery (a parked wake delivery, or a
   * silent one queued for the next prompt when the loop was destroyed).
   */
  kind: 'subagent' | 'bash' | 'wake_delivery' | 'silent_delivery';
  /**
   * Task ID of the sub-agent or background Bash command. Loop-owned
   * deliveries have no task; they carry the synthetic id 'wake-delivery' or
   * 'silent-delivery'.
   */
  taskId: string;
  /** Delivery attempts made before giving up. */
  attempts: number;
  /** Message of the last delivery failure. */
  lastError: string;
  /** When the item was dead-lettered (epoch ms). */
  deadLetteredAt: number;
  /** The formatted delivery message that never reached the loop. */
  message: string;
  /**
   * Loop-owned deliveries only: the handle deliver() returned for this
   * content (DeliverResult.deliveryId). Content pi drained inside a failed
   * run and the loop re-parked has an id the loop minted, which no caller
   * saw. Absent for background completions.
   */
  deliveryId?: string;
  /** Loop-owned deliveries only: the DeliverOptions.causeTag it carried. */
  causeTag?: unknown;
}

/**
 * Budget counters a child handle exposes. A structural subset of BudgetGuard
 * so this file needs no import of the class.
 */
export interface SubAgentBudgetView {
  getTurnCount(): number;
  getTotalCost(): number;
  getMaxTurns(): number;
  getMaxCost(): number;
}

/**
 * Typed handle to a spawned child loop. A structural subset of AgentLoop
 * (which imports these types, so importing the class here would be
 * circular); every AgentLoop satisfies it. This is the surface the
 * sub-agent manager and status/steering paths rely on: delivery, teardown,
 * and live usage reads.
 */
export interface SubAgentHandle {
  /** The child's loop path identity ('parentPath/taskId'). */
  readonly loopPath: string;
  /** Post-hoc context token count from the child's most recent turn. */
  readonly currentContextTokenCount: number;
  /**
   * True while any gate task is running or queued on the child. False for a
   * tracked child means it is in the settle window (its run ended but
   * completion has not untracked it) or has not started its run yet; a
   * delivery there would start a turn that teardown destroys moments later.
   */
  readonly isLoopActive: boolean;
  /**
   * True while a logical turn is actually in flight on the child. Narrower
   * than isLoopActive, which also stays true through the child's
   * end-of-cycle drain window after its run ended; a steer accepted there
   * would never be polled again and dies with the child.
   */
  readonly isPrompting: boolean;
  /**
   * Deliver a message regardless of the child's run state. Mirrors
   * AgentLoop.deliver: prompted when idle with wake wanted, parked for the
   * child's next run when its gate is held, queued when silent.
   */
  deliver(content: string, options?: { wake?: boolean }): {
    outcome: 'prompted' | 'parked' | 'queued';
    turn?: Promise<unknown>;
  };
  /** Queue a steering message on the child's running loop (no-op when idle). */
  steer(message: string): void;
  /** Abort the child's current loop without destroying it. */
  abort(): Promise<void>;
  /** Tear the child down. */
  destroy(timeoutMs?: number): Promise<void>;
  /** Live budget counters for status surfaces. */
  getBudgetGuard(): SubAgentBudgetView;
}

/**
 * Tracked sub-agent record managed by SubAgentManager.
 */
export interface TrackedSubAgent {
  /** Unique task identifier. */
  taskId: string;
  /** Typed handle to the sub-agent's AgentLoop instance. */
  agent: SubAgentHandle;
  /** The instructions the sub-agent was spawned with. */
  instructions: string;
  /** Whether this is a background sub-agent. */
  background: boolean;
  /** Named concurrency pool this spawn counts against (default pool when absent). */
  pool?: string;
  /** Spawn timestamp. */
  spawnedAt: number;
  /** Promise that resolves when the sub-agent completes. */
  completion: Promise<SubAgentResult>;
  /** Resolve function for the completion promise. */
  resolve: (result: SubAgentResult) => void;

  // Live activity tracking (updated via EventBridge forwarding)
  /** Number of tool calls executed so far. */
  toolCount: number;
  /** Name of the most recently started tool. */
  lastToolName: string | null;
  /** Summary/args of the most recently started tool. */
  lastToolSummary: string | null;
  /** Timestamp when the most recent tool started. */
  lastToolStartedAt: number | null;
  /** Set while the sub-agent is blocked awaiting a permission decision. */
  pendingPermission: { toolName: string; args: unknown } | null;
}
