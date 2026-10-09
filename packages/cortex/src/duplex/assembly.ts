/**
 * Duplex assembly: the per-loop configs the facade builds from one consumer
 * config (talker, reasoner, quick lookups), the permission brokering they
 * share, and the construction of the resident loop pair
 * (docs/cortex/duplex/architecture.md, facade-api.md routing table).
 */

import { AgentLoop } from '../agent-loop.js';
import { McpClientManager } from '../mcp-client.js';
import type { AgentLoopConfig, CortexCompactionConfig, RetryPolicy } from '../types.js';
import type { CortexTool } from '../tool-contract.js';
import type { CortexModel } from '../model-wrapper.js';
import { COMPACTION_DEFAULTS } from '../compaction/compaction.js';
import { OBSERVATIONAL_MEMORY_DEFAULTS } from '../compaction/observational/constants.js';
import { TOOL_NAMES } from '../tools/index.js';
import type { SandboxSession } from '../sandbox/session.js';
import { buildReasonerConfig } from '../facade/config.js';
import type { ResolvedCortexAgentConfig } from '../facade/config.js';
import {
  buildBrokeredNetworkResolver,
  buildBrokeredPermissionResolver,
} from './brokered-resolvers.js';
import type { PermissionBroker } from './permission-broker.js';
import {
  buildQuickLookupPrompt,
  REASONER_ROLE_PROMPT,
  TALKER_ROLE_PROMPT,
} from './prompts.js';

/**
 * The talker's facade-set hard turn cap per exchange (decisions.md D17).
 * Consumer budget config cannot raise it: an unbounded talker plus any
 * result missing `terminate` is an unbounded retry cycle with no attacker
 * involved (review-findings F9). Low but with room for the deliberate
 * recovery turns the guards force (empty-spoken-text follow-up, truncation
 * repair, one malformed-call recovery).
 */
export const TALKER_MAX_TURNS = 8;

/**
 * Fail-fast talker retries (facade-api.md): a transient provider error on
 * the presence loop must never become minutes of silent backoff. The
 * reasoner keeps the consumer's (or default) long-haul policy.
 */
const TALKER_RETRY_POLICY: Partial<RetryPolicy> = {
  maxAttempts: 2,
  backoffMs: [1_000, 2_000],
  maxBackoffMs: 2_000,
  maxElapsedMs: 10_000,
};

/**
 * Threshold stagger between the loops (log-and-context.md): the talker
 * compacts slightly earlier than the reasoner so blocking work on one
 * never coincides with an activation on the other.
 */
const COMPACTION_THRESHOLD_STAGGER = 0.05;

/**
 * Stagger a talker threshold below the reasoner's effective value. The
 * pair is clamped together rather than one side against a fixed floor: the
 * talker gets the full stagger whenever the reasoner's threshold leaves
 * room for it, and a pathologically low reasoner threshold shrinks the
 * stagger to half the reasoner's value instead of letting the pair
 * collapse to equality or invert. Strictly below the reasoner for every
 * input in (0, 1], which is the property the stagger exists for.
 *
 * The input is clamped into [0, 1] first (thresholds are fractions of the
 * context window) rather than trusting the caller: below zero the raw
 * arithmetic INVERTS (a negative half-value stagger lands the talker ABOVE
 * the reasoner), and a non-finite or non-positive threshold is
 * misconfiguration where both loops degenerate to the same always-compact
 * posture anyway.
 */
function staggerBelow(reasonerThreshold: number): number {
  const clamped = reasonerThreshold > 0 ? Math.min(reasonerThreshold, 1) : 0;
  const stagger = Math.min(COMPACTION_THRESHOLD_STAGGER, clamped / 2);
  return clamped - stagger;
}

/** Suffix appended to the consumer session id for the talker's cache key. */
export const TALKER_SESSION_ID_SUFFIX = ':talker';

/**
 * Hard token cap on the talker's headline block (log-and-context.md):
 * injected user-role content is never trimmed by microcompaction, so an
 * unbounded block would inflate utilization and trigger early source
 * compaction without itself shrinking. Enforced with truncation by the
 * loop's headline provider machinery.
 */
export const TALKER_HEADLINE_MAX_TOKENS = 1_500;

export function appendRolePrompt(basePrompt: string | undefined, rolePrompt: string): string | undefined {
  // An absent or blank base prompt stays absent so the facade's
  // prompt-not-configured guard still trips; the role prompt alone is not
  // a usable identity.
  if (basePrompt === undefined || basePrompt.trim().length === 0) return basePrompt;
  return `${basePrompt}\n\n${rolePrompt}`;
}

/**
 * The reasoner's config in duplex mode: consumer routing per the table,
 * plus the duplex posture. Exported for tests.
 */
export function buildDuplexReasonerConfig(
  config: ResolvedCortexAgentConfig,
): AgentLoopConfig & { tools?: CortexTool[] } {
  const routed = buildReasonerConfig(config);
  const duplexed: AgentLoopConfig & { tools?: CortexTool[] } = {
    ...routed,
    loopPath: 'reasoner',
    // A resident reasoner woken repeatedly by dispatches continues one
    // logical working session; wiping tool-runtime state (cwd,
    // read-before-edit, undo) per prompt would break it mid-task. An
    // explicit consumer value still wins.
    persistentRuntime: config.persistentRuntime ?? true,
  };
  const basePrompt = appendRolePrompt(config.initialBasePrompt, REASONER_ROLE_PROMPT);
  if (basePrompt !== undefined) duplexed.initialBasePrompt = basePrompt;
  // The reasoner keeps the bare consumer sessionId (routing table): a
  // session that flips modes keeps its reasoner prefix cache warm.
  return duplexed;
}

/**
 * Drop explicitly-undefined keys before spreading, so a consumer object
 * like `{ threshold: 0.8, preserveRecentTurns: undefined }` cannot clobber
 * a default with `undefined` (the spread copies the key; `?? default`
 * downstream never runs because the key exists).
 */
function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as Partial<T>;
}

/**
 * The talker's compaction posture: the consumer's config forced
 * non-blocking (a synchronous observer call inside transformContext is
 * multi-second dead air on the presence loop, review-findings F7) with
 * activation staggered ahead of the reasoner's.
 */
function buildTalkerCompactionConfig(
  consumer: Partial<CortexCompactionConfig> | undefined,
): Partial<CortexCompactionConfig> {
  // Stagger relative to the reasoner's EFFECTIVE thresholds: the consumer's
  // value when set, the strategy default otherwise. Defaults stagger too;
  // an unset classic threshold still lands 0.70 on the reasoner, and the
  // talker must sit below whatever the reasoner actually runs.
  const reasonerActivation = consumer?.observational?.activationThreshold
    ?? OBSERVATIONAL_MEMORY_DEFAULTS.activationThreshold;
  const reasonerClassic = consumer?.compaction?.threshold ?? COMPACTION_DEFAULTS.threshold;
  return {
    ...stripUndefined(consumer),
    nonBlocking: true,
    observational: {
      ...stripUndefined(consumer?.observational),
      activationThreshold: staggerBelow(reasonerActivation),
    },
    compaction: {
      ...COMPACTION_DEFAULTS,
      ...stripUndefined(consumer?.compaction),
      threshold: staggerBelow(reasonerClassic),
    },
  };
}

/**
 * The talker's AgentLoop config (architecture.md): fast model, the fixed
 * control toolset only (registered by the facade after construction), no
 * built-in tools, no permission resolver, a facade-set hard maxTurns that
 * consumer config cannot raise, fail-fast retries, non-blocking compaction
 * with a staggered threshold, and a derived stable session id. Exported
 * for tests.
 */
export function buildTalkerConfig(
  config: ResolvedCortexAgentConfig,
  talkerModel: CortexModel,
): AgentLoopConfig & { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean } {
  const talker: AgentLoopConfig & {
    enableSubAgentTool?: boolean;
    enableLoadSkillTool?: boolean;
  } = {
    model: talkerModel,
    workingDirectory: config.workingDirectory,
    loopPath: 'talker',
    // The talker separates thinking from speech with working tags in-band;
    // API-level reasoning would sit on the presence loop's latency budget.
    thinkingLevel: 'off',
    budgetGuard: { maxTurns: TALKER_MAX_TURNS, scope: 'prompt' },
    retryPolicy: TALKER_RETRY_POLICY,
    compaction: buildTalkerCompactionConfig(config.compaction),
    // No built-in toolset: the talker's turns are structurally incapable of
    // blocking on tool execution (D5). The observational Recall tool is the
    // one allowed non-control tool (review-findings F19) and registers via
    // the compaction config like anywhere else.
    disableTools: Object.values(TOOL_NAMES),
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
    // Deliberately absent: resolvePermission (wiring the broker as the
    // talker's resolver would deadlock answer_ask against the ask it is
    // answering, communication.md), resolveNetworkAccess, consumer tools,
    // MCP, skills, sub-agent config, and the consumer's budget guard.
  };

  // Consumer slots go to both loops, identical content (D6); the base
  // prompt goes to both in full with the role prompt appended.
  if (config.slots) talker.slots = config.slots;
  const basePrompt = appendRolePrompt(config.initialBasePrompt, TALKER_ROLE_PROMPT);
  if (basePrompt !== undefined) talker.initialBasePrompt = basePrompt;
  if (config.workingTags) talker.workingTags = config.workingTags;
  // Per-loop, not reasoner-only (CONFIG_ROUTING contextWindowLimit): the
  // same consumer number, clamped inside each loop against its own model
  // window and the safe floor. The talker's context IS the conversation, so
  // leaving it uncapped means the surface that grows fastest is the one the
  // consumer's compaction budget never reaches.
  if (config.contextWindowLimit !== undefined) {
    talker.contextWindowLimit = config.contextWindowLimit;
  }
  // Per loop as well (CONFIG_ROUTING utilityModel), but with the
  // same-provider constraint checked here rather than assumed.
  //
  // A loop THROWS at construction when its utility model's provider differs
  // from its own primary model's (AgentLoop.resolveUtilityModels), so
  // copying this one blind would not degrade duplex, it would fail assembly
  // outright on any consumer whose talker runs elsewhere. Copying nothing is
  // wrong too: the talker defaults to the fast tier of the PRIMARY provider,
  // so the providers match for most consumers and the setting is exactly
  // what they meant. So: copy when it can apply, and skip when it cannot.
  //
  // The skip is the one case where the talker's observational spend silently
  // goes to a model the consumer did not choose, and it is reported as a
  // 'talker-utility-model-skipped' resolution note. That note is read off
  // the ASSEMBLED loops rather than announced from here, so it cannot claim
  // a skip this branch did not make (resolution-report.ts).
  if (config.utilityModel === 'default') {
    // Not a model, so no provider to disagree with: it means auto-resolve,
    // which is what the talker would do anyway. Copied so the two loops
    // report the same dial.
    talker.utilityModel = 'default';
  } else if (
    config.utilityModel !== undefined &&
    config.utilityModel.provider === talkerModel.provider
  ) {
    talker.utilityModel = config.utilityModel;
  }

  // Shared environment-level wiring.
  if (config.getApiKey) talker.getApiKey = config.getApiKey;
  if (config.ambientCredentials !== undefined) talker.ambientCredentials = config.ambientCredentials;
  if (config.sandbox) talker.sandbox = config.sandbox;
  if (config.envOverrides) talker.envOverrides = config.envOverrides;
  if (config.logger) talker.logger = config.logger;
  if (config.diagnostics) talker.diagnostics = config.diagnostics;
  if (config.persistResult) talker.persistResult = config.persistResult;

  // Distinct stable per-loop cache identity derived from the consumer's.
  if (config.sessionId) talker.sessionId = `${config.sessionId}${TALKER_SESSION_ID_SUFFIX}`;

  return talker;
}

/**
 * The lookup loop's hard turn cap. Small by design: a lookup is a few read
 * tool calls plus an answer; anything longer belongs on the reasoner.
 */
export const LOOKUP_MAX_TURNS = 6;

/** Read-surface toolset a quick lookup keeps (everything else disabled). */
const LOOKUP_TOOL_NAMES: ReadonlySet<string> = new Set([
  TOOL_NAMES.Read,
  TOOL_NAMES.Grep,
  TOOL_NAMES.Glob,
]);

/**
 * Config for one ephemeral quick-lookup loop (decisions.md D13, F12): fast
 * model, Read/Grep/Glob only, an in-tool path allowlist rooted at the
 * working directory, the shared sandbox, broker-gated permissions (the
 * config's resolvePermission is already the brokered wrapper in duplex),
 * fail-fast retries, and a hard turn cap. No conversation context by
 * design. Exported for tests.
 */
export function buildQuickLookupConfig(
  config: ResolvedCortexAgentConfig,
  model: CortexModel,
  alias: string,
): AgentLoopConfig & { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean } {
  const lookup: AgentLoopConfig & {
    enableSubAgentTool?: boolean;
    enableLoadSkillTool?: boolean;
  } = {
    model,
    workingDirectory: config.workingDirectory,
    loopPath: `lookup/${alias}`,
    thinkingLevel: 'off',
    budgetGuard: { maxTurns: LOOKUP_MAX_TURNS, scope: 'prompt' },
    retryPolicy: TALKER_RETRY_POLICY,
    initialBasePrompt: buildQuickLookupPrompt(config.workingDirectory),
    // Read-only toolset (D13): no write, exec, network, or spawn surface.
    disableTools: Object.values(TOOL_NAMES).filter((name) => !LOOKUP_TOOL_NAMES.has(name)),
    // The security half (F12), enforced in-tool rather than by prompt:
    // lookup answers become spoken conversation, so a read outside the
    // working directory is a direct exfiltration path.
    readPathAllowlist: [config.workingDirectory],
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
  };
  if (config.getApiKey) lookup.getApiKey = config.getApiKey;
  if (config.ambientCredentials !== undefined) lookup.ambientCredentials = config.ambientCredentials;
  if (config.sandbox) lookup.sandbox = config.sandbox;
  if (config.envOverrides) lookup.envOverrides = config.envOverrides;
  if (config.logger) lookup.logger = config.logger;
  if (config.diagnostics) lookup.diagnostics = config.diagnostics;
  if (config.persistResult) lookup.persistResult = config.persistResult;
  if (config.toolResultThresholds) lookup.toolResultThresholds = config.toolResultThresholds;
  // Broker-gated like any other loop: in duplex create() this is the
  // brokered wrapper, so an `ask` is voiced through the talker rather than
  // blocking the lookup invisibly (the lookup's timeout still bounds it).
  if (config.resolvePermission) lookup.resolvePermission = config.resolvePermission;
  if (config.isAutoApprove) lookup.isAutoApprove = config.isAutoApprove;
  return lookup;
}

/**
 * Route the blocking permission surfaces through the duplex broker
 * (communication.md "Full coverage"): the consumer's resolvePermission and
 * resolveNetworkAccess are wrapped so an `ask` becomes a voiced
 * conversation ask instead of blocking a loop invisibly, while allow and
 * block/deny decisions pass through untouched. The wrapped functions flow
 * to the reasoner and, by inheritance, its sub-agents; the talker receives
 * neither (buildTalkerConfig omits them: wiring the broker as the talker's
 * resolver would deadlock answer_ask against the ask it is answering).
 * Exported for tests.
 */
export function withBrokeredPermissions(
  config: ResolvedCortexAgentConfig,
  getBroker: () => PermissionBroker | null,
): ResolvedCortexAgentConfig {
  if (!config.resolvePermission && !config.resolveNetworkAccess) return config;
  const brokered: ResolvedCortexAgentConfig = { ...config };
  if (config.resolvePermission) {
    brokered.resolvePermission = buildBrokeredPermissionResolver(
      config.resolvePermission,
      config.isAutoApprove,
      getBroker,
    );
  }
  if (config.resolveNetworkAccess) {
    brokered.resolveNetworkAccess = buildBrokeredNetworkResolver(
      config.resolveNetworkAccess,
      getBroker,
      // Third argument, unlike the tool resolver's second. Both pipelines
      // must agree about what auto-approve means: a consumer that asked not
      // to be interrupted should not have egress asks voiced at it and then
      // time out to deny. The resolver consults this only AFTER the broker
      // lookup, so an unbound broker still fails closed.
      config.isAutoApprove,
    );
  }
  return brokered;
}

/** The resident duplex loop pair, built and ready for the facade to wire. */
export interface AssembledDuplexLoops {
  reasoner: AgentLoop;
  talker: AgentLoop;
  /** The config the loops were built from: permissions brokered, MCP shared. */
  config: ResolvedCortexAgentConfig;
  /** Bind the broker the brokered resolvers route `ask` decisions through. */
  bindBroker(broker: PermissionBroker | null): void;
  /** The facade-minted shared MCP manager; null when the consumer supplied one. */
  ownedMcp: McpClientManager | null;
}

/**
 * Build the talker and the persistent reasoner from one consumer config.
 *
 * Broker the blocking permission surfaces before the loop configs are
 * built: the loops capture the resolver closures at creation, so the broker
 * reference is late-bound through a box the caller fills (bindBroker)
 * synchronously, before create() returns and before any tool call can run.
 * Allow/block/deny decisions pass through untouched; only `ask` routes
 * through the conversation (D16).
 */
export async function assembleDuplexLoops(
  config: ResolvedCortexAgentConfig,
  managed?: SandboxSession,
): Promise<AssembledDuplexLoops> {
  const brokerBox: { broker: PermissionBroker | null } = { broker: null };
  let brokered = withBrokeredPermissions(config, () => brokerBox.broker);
  if (managed && brokered.resolveNetworkAccess) managed.setNetworkResolver(brokered.resolveNetworkAccess);
  // The MCP multiplexer: one manager, one connection per server total,
  // projected to the reasoner (and its sub-agents via tool closures);
  // never the talker. A consumer-provided manager is adopted (and its
  // lifecycle stays the consumer's); otherwise the facade mints and
  // owns one, configured here because loops only configure managers
  // they own.
  const facadeMintedMcp = config.mcpClientManager === undefined;
  const sharedMcp = config.mcpClientManager ?? new McpClientManager();
  if (facadeMintedMcp) {
    if (config.logger) sharedMcp.logger = config.logger;
    if (config.envOverrides) sharedMcp.envOverrides = config.envOverrides;
    if (config.sandbox) sharedMcp.sandbox = config.sandbox;
  }
  brokered = { ...brokered, mcpClientManager: sharedMcp };
  const reasoner = await AgentLoop.create(buildDuplexReasonerConfig(brokered));
  let talker: AgentLoop;
  try {
    // Default talker model: the fast tier resolved from the primary
    // provider, which is exactly what the reasoner's utility-model
    // auto-resolution computes (and what mode resolution judged the
    // backends on). That resolution cannot fail; for a provider Cortex
    // cannot enumerate (Ollama, custom OpenAI-compatible endpoints) it
    // falls back to the primary model, so duplex still assembles and runs
    // but the talker is as slow as the reasoner, which is the whole
    // latency case gone. That outcome is reported as a
    // 'talker-model-fallback' resolution note, computed in the constructor
    // from the loops as assembled rather than from this local, so the
    // report describes the agent that exists.
    const talkerModel = brokered.talker?.model ?? reasoner.getAutoResolvedUtilityModel();
    talker = await AgentLoop.create(buildTalkerConfig(brokered, talkerModel));
  } catch (err) {
    // A half-assembled duplex must not leak a live reasoner.
    await reasoner.destroy().catch(() => {});
    if (facadeMintedMcp) await sharedMcp.closeAll().catch(() => {});
    throw err;
  }
  return {
    reasoner,
    talker,
    config: brokered,
    bindBroker: (broker) => {
      brokerBox.broker = broker;
    },
    ownedMcp: facadeMintedMcp ? sharedMcp : null,
  };
}
