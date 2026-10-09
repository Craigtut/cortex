/**
 * The session's OS sandbox preferences and the state Cortex reports back.
 *
 * Cortex owns backend construction, policy and teardown. This owns the
 * product side: which trust rung a workspace runs at (remembered per
 * workspace, the folder-trust pattern), the footer indicator, and the one-time
 * container notice. The rung changes only by a human through /sandbox.
 */

import path from 'node:path';
import { homedir } from 'node:os';
import type {
  CortexAgent,
  SandboxOptions,
  SandboxPolicy,
  SandboxRung,
  SandboxState,
  SandboxStatus,
} from '@animus-labs/cortex';
import type { CortexCodeConfig } from '../config/config.js';
import { SandboxSettingsStore } from '../config/sandbox-settings.js';
import type { App } from '../tui/app.js';
import type { TranscriptManager } from '../tui/transcript.js';
import { detectContainer } from '../utils/container.js';
import { log } from '../logger.js';

export type SandboxAgent = Pick<CortexAgent, 'setSandboxRung' | 'getSandboxState'>;

export type SandboxApp = Pick<App, 'updateStatus'> & {
  transcript: Pick<TranscriptManager, 'addNotification'>;
};

export interface SessionSandboxDeps {
  config: CortexCodeConfig;
  cwd: string;
  /** The workspace settings file the rung is remembered in. */
  settingsPath: string;
  getAgent: () => SandboxAgent | null;
  getApp: () => SandboxApp | null;
  /** Called after a human rung change lands, so the model's view refreshes. */
  onRungChanged: () => Promise<void>;
}

export class SessionSandbox {
  /** The options handed to CortexAgent.create(), or undefined when disabled. */
  private agentOptions: SandboxOptions | undefined;
  private status: SandboxStatus | undefined;
  /**
   * The policy handed to the provider. Kept even when OS enforcement is
   * degraded or failed: it still projects into in-process egress (WebFetch),
   * so the rung's network intent holds policy-only where the OS cannot.
   */
  private policy: SandboxPolicy | undefined;
  /**
   * The active trust rung. 'off' means no containment (user choice, config
   * kill switch, or before init() has resolved it). Changed only by a
   * human through /sandbox; never exposed to the model.
   */
  private rung: SandboxRung = 'off';
  /** Per-workspace remembered rung and one-time notice flags. */
  private readonly settings: SandboxSettingsStore;
  private readonly config: CortexCodeConfig;
  private readonly cwd: string;
  private readonly getAgent: () => SandboxAgent | null;
  private readonly getApp: () => SandboxApp | null;
  private readonly onRungChanged: () => Promise<void>;

  constructor(deps: SessionSandboxDeps) {
    this.settings = new SandboxSettingsStore(deps.settingsPath);
    this.config = deps.config;
    this.cwd = deps.cwd;
    this.getAgent = deps.getAgent;
    this.getApp = deps.getApp;
    this.onRungChanged = deps.onRungChanged;
  }

  getRung(): SandboxRung { return this.rung; }
  getStatus(): SandboxStatus | undefined { return this.status; }
  getPolicy(): SandboxPolicy | undefined { return this.policy; }
  getAgentOptions(): SandboxOptions | undefined { return this.agentOptions; }
  /** False when the config kill switch (sandbox.enabled=false) is set. */
  isConfigEnabled(): boolean { return this.config.sandbox?.enabled !== false; }

  /** Resolve product preferences; Cortex owns backend construction and policy setup. */
  async init(): Promise<SandboxOptions | undefined> {
    this.agentOptions = await this.buildAgentOptions();
    return this.agentOptions;
  }

  private async buildAgentOptions(): Promise<SandboxOptions | undefined> {
    if (this.config.sandbox?.enabled === false) {
      this.rung = 'off';
      return undefined;
    }
    await this.settings.load();
    this.rung = await this.resolveInitialRung();
    const cortexHome = path.join(homedir(), '.cortex');
    return {
      rung: this.rung,
      // Keep the CLI's availability choice explicit; the framework defaults to refusal.
      requireEnforcement: this.config.sandbox?.requireEnforcement ?? false,
      denyWrite: [cortexHome, path.join(this.cwd, '.cortex')],
      denyRead: [path.join(cortexHome, 'credentials.json')],
      ...(this.config.sandbox?.allowedDomains ? { allowedDomains: this.config.sandbox.allowedDomains } : {}),
      onStatusChange: (state) => this.applyState(state),
    };
  }

  applyState(state: SandboxState | undefined): void {
    this.rung = state?.rung ?? 'off';
    this.policy = state?.policy;
    this.status = state?.rung === 'off' ? undefined : state?.status;
    this.getApp()?.updateStatus(this.indicatorState());
  }

  /**
   * The rung this session starts at: the workspace's remembered rung when one
   * exists, otherwise the configured default (Workspace unless config says
   * otherwise), which is then remembered so the rung is a stable per-workspace
   * fact from the first open on (the folder-trust pattern).
   */
  private async resolveInitialRung(): Promise<SandboxRung> {
    const saved = this.settings.getRung();
    if (saved) return saved;

    // An explicit consumer default is honored and remembered (folder-trust).
    const configured = this.config.sandbox?.rung;
    if (configured) {
      await this.persistInitialRung(configured);
      return configured;
    }

    // On Windows, containment (MXC BaseContainer) is opt-in until it has been
    // validated on a real Windows 11 host: default to 'off'. Do NOT persist
    // that 'off': leaving the remembered rung empty means a later consumer
    // default (sandbox.rung) or a future on-by-default flip still takes
    // effect, while `/sandbox workspace` remains the explicit, remembered
    // opt-in. Persisting it would make 'off' sticky and defeat that rollout.
    if (process.platform === 'win32') {
      return 'off';
    }

    // Every other platform is on-by-default at Workspace, remembered per
    // workspace (the folder-trust pattern).
    await this.persistInitialRung('workspace');
    return 'workspace';
  }

  private async persistInitialRung(rung: SandboxRung): Promise<void> {
    try {
      await this.settings.setRung(rung);
    } catch (err) {
      log.warn('Could not persist initial sandbox rung', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Change the trust rung for this session and remember it per-workspace.
   *
   * A HUMAN action only: the sole caller is the /sandbox slash command the user
   * types. It is never registered as a tool or otherwise reachable by the
   * model, matching the design rule that an agent cannot widen its own
   * containment.
   *
   * 'off' stands the provider down (dispose) so commands run uncontained and
   * drops the policy so in-process gating (WebFetch) opens up too. Moving from
   * off back to a contained rung re-initializes the same provider object with
   * a freshly built policy, which the agent's Bash tool already references.
   */
  async setRung(rung: SandboxRung): Promise<{ changed: boolean; reason?: string }> {
    const agent = this.getAgent();
    if (this.config.sandbox?.enabled === false || !agent) {
      return {
        changed: false,
        reason:
          'The sandbox is disabled by config (sandbox.enabled=false). Edit your config and restart to re-enable it.',
      };
    }
    if (rung === this.rung) {
      return { changed: false, reason: `Sandbox is already at the ${rung} rung.` };
    }

    try {
      await agent.setSandboxRung(rung);
      this.applyState(agent.getSandboxState());
    } catch (error) {
      return { changed: false, reason: error instanceof Error ? error.message : String(error) };
    }

    try {
      await this.settings.setRung(rung);
    } catch (err) {
      log.warn('Could not persist sandbox rung', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.getApp()?.updateStatus(this.indicatorState());
    // The model reads the rung from the ephemeral <environment> block; refresh
    // it now so the change is visible mid-session, not at the next user prompt.
    await this.onRungChanged();
    log.info('Sandbox rung changed', { rung, enforced: this.status?.backend ?? 'none' });
    return { changed: true };
  }

  /** The status-bar fields for the always-visible sandbox indicator. */
  indicatorState(): {
    sandboxRung: string;
    sandboxEnforcement: 'enforced' | 'partial' | 'none';
  } {
    const s = this.status;
    const enforcement =
      !s || s.backend === 'none'
        ? 'none'
        : s.filesystem === 'enforced' && s.network === 'enforced'
          ? 'enforced'
          : 'partial';
    return { sandboxRung: this.rung, sandboxEnforcement: enforcement };
  }

  /**
   * P1 container detection: when this session already runs inside a container,
   * the OS sandbox stacks a second boundary that mostly adds friction. Surface
   * a recommendation (log line always; transcript note once per workspace) that
   * the user may prefer /sandbox off. Detection is heuristic, so this NEVER
   * changes the rung automatically.
   */
  async surfaceContainerRecommendation(): Promise<void> {
    if (this.rung === 'off') return;
    try {
      const detection = await detectContainer();
      if (!detection.inContainer) return;
      log.info('Container detected; the OS sandbox is redundant inside an isolated environment', {
        marker: detection.marker,
      });
      if (this.settings.isContainerNoticeShown()) return;
      this.getApp()?.transcript.addNotification(
        'Container detected',
        `This session appears to be running inside a container (${detection.marker}).\n` +
          'The environment is already an isolation boundary, so the OS sandbox is\n' +
          'redundant here and can add friction. If that is intentional, keep it;\n' +
          'otherwise you may prefer /sandbox off for this workspace.\n' +
          'Detection is heuristic; nothing was changed automatically.',
      );
      await this.settings.markContainerNoticeShown();
    } catch (err) {
      log.debug('Container detection failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
