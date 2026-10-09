/**
 * What the session reports about itself: the footer the user reads and the
 * `<environment>` block the model reads. Both are views over the same facts
 * (provider and model, context usage, yolo, sandbox rung, resolution notes),
 * so they are computed in one place and cannot disagree.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CortexAgent, CortexAgentConfig, ResolutionNote, ThinkingLevel } from '@animus-labs/cortex';
import type { App } from '../tui/app.js';
import { AVAILABLE_MODES } from '../modes/index.js';
import type { ModelSelection } from './model-selection.js';
import type { SessionSandbox } from './sandbox-state.js';

const execFileAsync = promisify(execFile);

export type StatusAgent = Pick<
  CortexAgent,
  | 'effectiveContextWindow'
  | 'currentContextTokenCount'
  | 'estimateCurrentContextTokens'
  | 'getResolutionReport'
  | 'getCompactionManager'
  | 'getContextManager'
>;

export interface SessionStatusViewDeps {
  cwd: string;
  modeName: string;
  agentMode: NonNullable<CortexAgentConfig['mode']>;
  models: Pick<ModelSelection, 'provider' | 'modelId'>;
  sandbox: Pick<SessionSandbox, 'indicatorState' | 'getRung'>;
  getYoloMode: () => boolean;
  getAgent: () => StatusAgent | null;
  getApp: () => Pick<App, 'updateStatus'> | null;
}

export class SessionStatusView {
  private readonly cwd: string;
  private readonly modeName: string;
  private readonly agentMode: SessionStatusViewDeps['agentMode'];
  private readonly models: SessionStatusViewDeps['models'];
  private readonly sandbox: SessionStatusViewDeps['sandbox'];
  private readonly getYoloMode: () => boolean;
  private readonly getAgent: () => StatusAgent | null;
  private readonly getApp: SessionStatusViewDeps['getApp'];

  constructor(deps: SessionStatusViewDeps) {
    this.cwd = deps.cwd;
    this.modeName = deps.modeName;
    this.agentMode = deps.agentMode;
    this.models = deps.models;
    this.sandbox = deps.sandbox;
    this.getYoloMode = deps.getYoloMode;
    this.getAgent = deps.getAgent;
    this.getApp = deps.getApp;
  }

  /**
   * The session's resolution report: what the assembly actually resolved to
   * where that differs from what was configured.
   *
   * Read live rather than snapshotted at startup. Most notes are assembly
   * facts, but `network-resolver-unwired` is recorded when the check first
   * runs, which is at the first prompt, so a report captured once at startup
   * would permanently miss the one note this CLI can currently produce.
   */
  resolutionReport(): ResolutionNote[] {
    return this.getAgent()?.getResolutionReport() ?? [];
  }
  async refreshEnvironment(): Promise<void> {
    const agent = this.getAgent();
    if (!agent) return;

    const branch = await readGitBranch(this.cwd);
    const currentContextTokens = this.displayedContextTokens();
    // The rung is stated so the model can adapt to denials instead of blindly
    // retrying; changing it stays human-only (there is no tool for it).
    const enforcementLabel = {
      enforced: 'OS-enforced',
      partial: 'partially OS-enforced',
      none: 'not OS-enforced',
    }[this.sandbox.indicatorState().sandboxEnforcement];
    const lines = [
      `Current date: ${new Date().toISOString().split('T')[0]}`,
      `Current working directory: ${this.cwd}`,
      branch ? `Git branch: ${branch}` : '',
      `Model: ${this.models.provider}/${this.models.modelId}`,
      this.getYoloMode() ? 'YOLO mode is active: all tools auto-approved' : '',
      this.sandbox.getRung() !== 'off'
        ? `Sandbox: ${this.sandbox.getRung()} rung, ${enforcementLabel}`
        : '',
      currentContextTokens > 0
        ? `Current context usage: ${(currentContextTokens / 1000).toFixed(1)}k / ${(agent.effectiveContextWindow / 1000).toFixed(0)}k`
        : '',
    ].filter(Boolean);

    agent.getContextManager().setEphemeral(
      `<environment>\n${lines.join('\n')}\n</environment>`,
    );
  }

  /**
   * The footer's full opening state. Separate from start() so a test can put
   * the footer in the state a real session opens with by calling the same
   * code, rather than by assembling a state object of its own and proving
   * only that the renderer works.
   */
  pushInitialFooter(branch: string, effortLevel: ThinkingLevel): void {
    const agent = this.getAgent();
    const app = this.getApp();
    if (!agent || !app) return;
    app.updateStatus({
      mode: this.modeName,
      modeCount: AVAILABLE_MODES.length,
      agentMode: this.agentMode,
      provider: this.models.provider,
      model: this.models.modelId,
      contextTokenCount: this.displayedContextTokens(),
      contextTokenLimit: agent.effectiveContextWindow,
      gitBranch: branch,
      yoloMode: this.getYoloMode(),
      effortLevel,
      ...this.sandbox.indicatorState(),
      ...this.resolutionIndicatorState(),
    });
  }

  refreshContextUsage(): void {
    const agent = this.getAgent();
    const app = this.getApp();
    if (!agent || !app) return;
    app.updateStatus({
      contextTokenCount: this.displayedContextTokens(),
      contextTokenLimit: agent.effectiveContextWindow,
      ...this.resolutionIndicatorState(),
    });
  }

  /**
   * The footer's degraded marker. Recomputed on every footer refresh rather
   * than set once: `network-resolver-unwired` is appended at the first
   * prompt, so a flag written only at startup would never light for it.
   *
   * `info` notes are excluded deliberately. `duplex-cost-cap-unset` is an
   * info note that fires on every default duplex session, so counting info
   * here would leave the marker permanently on and carrying no information.
   */
  private resolutionIndicatorState(): { resolutionDegraded: boolean } {
    return {
      resolutionDegraded: this.resolutionReport()
        .some((note) => note.severity === 'degraded'),
    };
  }

  refreshObservationalMemory(): void {
    const agent = this.getAgent();
    const app = this.getApp();
    if (!agent || !app) return;
    const cm = agent.getCompactionManager();
    app.updateStatus({
      observationTokenCount: cm.getObservationTokenCount(),
      observerActive: cm.isObserverInFlight(),
      reflectorActive: cm.isReflectorInFlight(),
    });
  }

  displayedContextTokens(): number {
    const agent = this.getAgent();
    if (!agent) return 0;
    return Math.max(
      agent.currentContextTokenCount,
      agent.estimateCurrentContextTokens(),
    );
  }
}

/** The current git branch, or empty outside a repository. */
export async function readGitBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd,
      timeout: 2000,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}
