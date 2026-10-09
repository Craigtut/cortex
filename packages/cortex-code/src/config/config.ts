import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CortexAgentMode, SandboxRung, OllamaModelConfig } from '@animus-labs/cortex';

export interface CortexCodeConfig {
  /** Local runtime preferences. Allocation is also capped by contextWindowLimit. */
  ollama?: Pick<OllamaModelConfig, 'contextWindow' | 'keepAlive' | 'thinking' | 'maxOutputTokens'>;
  /** Default model override. */
  defaultModel?: string;
  /** Default provider override. */
  defaultProvider?: string;
  /** Artificial context window limit. */
  contextWindowLimit?: number | null;
  /** Max cost budget per agentic loop. */
  maxCost?: number;
  /** Max turns budget per agentic loop. */
  maxTurns?: number;
  /** Default thinking effort level. Default: 'medium'. */
  defaultEffort?: string;
  /** Default utility model override for the active provider. */
  defaultUtilityModel?: string;
  /** Check npm for a newer Cortex Code on startup. Default: true. */
  updateCheck?: boolean;
  /**
   * Terminal tab title behavior. Default: 'dynamic'.
   * - 'dynamic': name the tab after what the user is working on (utility model).
   * - 'static': set the tab to the working directory name once.
   * - 'off': never change the terminal title.
   */
  terminalTitle?: 'dynamic' | 'static' | 'off';
  /**
   * Cortex facade mode. Default: 'passthrough'. See {@link resolveAgentMode}
   * for what each mode buys and why the default is not the framework's.
   * Overridden for one session by `--duplex` / `--no-duplex`.
   */
  agentMode?: CortexAgentMode;
  /** Optional diagnostics for investigating TUI or prompt freezes. */
  diagnostics?: CortexCodeDiagnosticsConfig;
  /**
   * OS-level sandbox for shell commands. On by default at the Workspace rung.
   * See docs/cortex/sandboxing.md.
   */
  sandbox?: SandboxCodeConfig;
}

export interface SandboxCodeConfig {
  /** Enable the sandbox feature at all. Default: true. False hides /sandbox re-enabling too. */
  enabled?: boolean;
  /**
   * Starting rung for a FRESH workspace. Default: 'workspace'. Once a workspace
   * has been opened (or the user runs /sandbox <rung>), the per-workspace
   * remembered rung wins over this value.
   */
  rung?: SandboxRung;
  /** Extra domains to pre-allow beyond the seeded package registries. */
  allowedDomains?: string[];
  /**
   * Refuse-to-run instead of the default warn-and-continue. When true, at a
   * contained rung (anything but 'off') where the OS sandbox is NOT actually
   * enforcing (backend 'none' — e.g. Windows without MXC BaseContainer or its
   * SDK, or Linux without a usable bubblewrap), shell commands are BLOCKED
   * rather than run uncontained. A partially enforcing backend is refused too.
   * For consumers who would rather fail closed than silently drop containment.
   * Default: false.
   */
  requireEnforcement?: boolean;
}

export interface FreezeDiagnosticsConfig {
  /** Whether freeze diagnostics are enabled. Default: false. */
  enabled?: boolean;
  /** Heartbeat interval for TUI diagnostics. Default: 1000ms. */
  heartbeatIntervalMs?: number;
  /** Event-loop delay monitor resolution in milliseconds. Default: 20ms. */
  eventLoopResolutionMs?: number;
  /** Log renders slower than this threshold in milliseconds. Default: 32ms. */
  slowRenderThresholdMs?: number;
  /** Cortex prompt watchdog heartbeat interval in milliseconds. Default: 1000ms. */
  promptWatchdogIntervalMs?: number;
  /** Warn if abort is still waiting after this many milliseconds. Default: 2000ms. */
  abortWaitWarningMs?: number;
}

export interface CortexCodeDiagnosticsConfig {
  freeze?: FreezeDiagnosticsConfig;
}

const GLOBAL_CONFIG_PATH = join(homedir(), '.cortex', 'config.json');
const PROJECT_CONFIG_NAME = '.cortex/config.json';

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Load and merge configuration from global and project-local config files.
 * Project config overrides global config for overlapping keys.
 */
export async function loadConfig(cwd: string): Promise<CortexCodeConfig> {
  const [globalConfig, projectConfig] = await Promise.all([
    readJsonFile<CortexCodeConfig>(GLOBAL_CONFIG_PATH),
    readJsonFile<CortexCodeConfig>(join(cwd, PROJECT_CONFIG_NAME)),
  ]);

  const globalDiagnostics = globalConfig?.diagnostics;
  const projectDiagnostics = projectConfig?.diagnostics;

  const diagnostics = globalDiagnostics || projectDiagnostics
    ? {
        ...globalDiagnostics,
        ...projectDiagnostics,
        freeze: {
          ...globalDiagnostics?.freeze,
          ...projectDiagnostics?.freeze,
        },
      }
    : undefined;

  // Sandbox posture is security-sensitive and must come from TRUSTED config
  // only (the user's global config), never from the project working tree. A
  // cloned untrusted repo could otherwise ship `.cortex/config.json` that
  // disables or weakens the sandbox before the user acts, defeating the whole
  // "safe to open untrusted code" premise. Drop any project-level sandbox block.
  const projectRest: CortexCodeConfig = { ...(projectConfig ?? {}) };
  if (projectRest.sandbox !== undefined) {
    delete projectRest.sandbox;
  }

  return {
    ...globalConfig,
    ...projectRest,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

/**
 * The Cortex facade mode one session runs: the `--duplex` / `--no-duplex`
 * flag, else the `agentMode` config key, else passthrough.
 *
 * The default is deliberately not the framework's (duplex). A coding CLI
 * streams the reasoner's tool calls live, so there is no dead air for a talker
 * to fill, and duplex puts a second model and a paraphrase layer between a
 * precisely typed instruction and the loop holding the tools. Duplex buys
 * responsiveness while the reasoner is busy: a session that can answer a
 * question or take a correction mid-task instead of queueing it. Worth opting
 * into, not worth inheriting.
 *
 * Total by construction: an unrecognized config value resolves to the default
 * rather than throwing at startup. `/status` names the mode actually in force,
 * so a typo shows up there rather than as a silent surprise.
 */
export function resolveAgentMode(
  flag: boolean | undefined,
  configured: CortexCodeConfig['agentMode'],
): CortexAgentMode {
  if (flag !== undefined) return flag ? 'duplex' : 'passthrough';
  return configured === 'duplex' ? 'duplex' : 'passthrough';
}
