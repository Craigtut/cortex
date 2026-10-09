/**
 * The CortexAgentConfig an interactive session hands to CortexAgent.create().
 */

import type {
  CortexAgentConfig,
  CortexDiagnosticsConfig,
  CortexModel,
  PromptWatchdogDiagnosticsConfig,
  SandboxOptions,
} from '@animus-labs/cortex';
import type { CortexCodeConfig } from '../config/config.js';
import type { Mode } from '../modes/types.js';
import { createToolResultPersistor } from '../persistence/sessions.js';
import { log } from '../logger.js';

export interface AgentConfigInput {
  /**
   * Passed explicitly rather than left to the facade default, which is
   * duplex. See `resolveAgentMode` for why passthrough is this CLI's default.
   */
  agentMode: NonNullable<CortexAgentConfig['mode']>;
  model: CortexModel;
  cwd: string;
  mode: Mode;
  config: CortexCodeConfig;
  sessionId: string;
  sandbox: SandboxOptions | undefined;
  resolvePermission: NonNullable<CortexAgentConfig['resolvePermission']>;
  /**
   * WebFetch's egress gate: the same decision function the sandbox egress
   * proxy consults for shell commands, so one grant covers both paths.
   */
  resolveNetworkAccess: NonNullable<CortexAgentConfig['resolveNetworkAccess']>;
  isAutoApprove: NonNullable<CortexAgentConfig['isAutoApprove']>;
  getAuth: NonNullable<CortexAgentConfig['getAuth']>;
}

export function buildAgentConfig(input: AgentConfigInput): CortexAgentConfig {
  const diagnostics = buildDiagnosticsConfig(input.config);
  return {
    // No `duplex.maxTotalCost`, deliberately. Without it the facade's
    // aggregate guard is uncapped, so a duplex session (two resident loops,
    // sub-agents, lookups, doubled observational spend) has no session
    // ceiling. This CLI sets no `budgetGuard.maxCost` either, so a session cap
    // would be the only cost limit in the product, and it would hard-stop a
    // long coding session mid-task with no prior warning. Cost limits here
    // want a warning tier before a stop, which is a product decision rather
    // than a constant to pick. The absence is visible instead:
    // `duplex-cost-cap-unset` is in the resolution report `/status` prints.
    mode: input.agentMode,
    model: input.model,
    utilityModel: 'default',
    workingDirectory: input.cwd,
    initialBasePrompt: input.mode.systemPrompt,
    slots: input.mode.contextSlots,
    resolvePermission: input.resolvePermission,
    resolveNetworkAccess: input.resolveNetworkAccess,
    isAutoApprove: input.isAutoApprove,
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    getAuth: input.getAuth,
    contextWindowLimit: input.config.contextWindowLimit ?? null,
    persistResult: createToolResultPersistor(input.sessionId),
    logger: log,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function buildDiagnosticsConfig(config: CortexCodeConfig): CortexDiagnosticsConfig | undefined {
  const freeze = config.diagnostics?.freeze;
  if (!freeze?.enabled) return undefined;
  const watchdog: PromptWatchdogDiagnosticsConfig = { enabled: true };
  if (freeze.promptWatchdogIntervalMs !== undefined) watchdog.heartbeatIntervalMs = freeze.promptWatchdogIntervalMs;
  if (freeze.abortWaitWarningMs !== undefined) watchdog.abortWaitWarningMs = freeze.abortWaitWarningMs;
  return { promptWatchdog: watchdog };
}
