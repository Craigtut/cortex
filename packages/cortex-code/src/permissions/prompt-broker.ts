/**
 * The session's answer to every "may the agent do this?" question: tool
 * permissions (rules, then an inline TUI prompt) and network egress (grants,
 * then the unified network prompt).
 *
 * Both kinds of prompt share one lock, so a tool ask and a network ask never
 * overlap on screen, and both are recorded in the activity stream so a
 * companion app can answer out-of-band through the session's decision files.
 */

import type {
  CortexToolPermissionResult,
  NetworkAccessDecision,
  NetworkAccessRequest,
  SandboxPolicy,
  SandboxStatus,
  ToolPermissionRequestContext,
} from '@animus-labs/cortex';
import {
  watchDecisionFile,
  type FileSessionActivityReporter,
  type PermissionResolution,
} from '../activity/session-activity.js';
import type { App } from '../tui/app.js';
import { PermissionRuleManager } from './rules.js';
import { PromptLock } from './prompt-lock.js';
import { preflightPermission, type PreflightDeps } from './preflight.js';
import { isPathWithinRealCwd } from './path-containment.js';
import {
  NetworkAccessController,
  NetworkGrantStore,
  type NetworkPromptChoice,
} from './network.js';

export interface PermissionBrokerDeps {
  cwd: string;
  /** The workspace settings file persisted network grants live in. */
  settingsPath: string;
  activity: Pick<
    FileSessionActivityReporter,
    'recordPermissionRequested' | 'recordPermissionResolved' | 'decisionPath' | 'recordError'
  >;
  /** The sandbox state that widens or narrows what auto-approves. */
  sandbox: { getStatus(): SandboxStatus | undefined; getPolicy(): SandboxPolicy | undefined };
  getApp: () => Pick<App, 'showPermissionPrompt' | 'showNetworkPrompt'> | null;
  getYoloMode: () => boolean;
}

export class PermissionBroker {
  private readonly rules: PermissionRuleManager;
  private readonly networkGrants: NetworkGrantStore;
  private readonly networkAccess: NetworkAccessController;
  /** One prompt on screen at a time, tool and network asks alike. */
  private readonly promptLock = new PromptLock();
  private readonly cwd: string;
  private readonly activity: PermissionBrokerDeps['activity'];
  private readonly sandbox: PermissionBrokerDeps['sandbox'];
  private readonly getApp: PermissionBrokerDeps['getApp'];
  private readonly getYoloMode: () => boolean;

  constructor(deps: PermissionBrokerDeps) {
    this.cwd = deps.cwd;
    this.activity = deps.activity;
    this.sandbox = deps.sandbox;
    this.getApp = deps.getApp;
    this.getYoloMode = deps.getYoloMode;
    this.rules = new PermissionRuleManager(deps.cwd);
    this.networkGrants = new NetworkGrantStore(deps.settingsPath);
    this.networkAccess = new NetworkAccessController({
      getPolicy: () => this.sandbox.getPolicy()?.network,
      prompt: (req) => this.promptNetworkAccess(req),
      store: this.networkGrants,
    });
  }

  /** Load persisted permission rules and network domain grants. */
  async load(): Promise<void> {
    await this.rules.loadPersistedRules();
    await this.networkGrants.load();
  }

  /** Domain grants for transparency surfaces (/sandbox status). */
  getNetworkGrantInfo(): { persisted: readonly string[]; session: readonly string[] } {
    return {
      persisted: this.networkGrants.getDomains(),
      session: this.networkAccess.getSessionGrants(),
    };
  }

  /**
   * Permission resolution: rules check, then serialized inline TUI prompt.
   *
   * Concurrent permission requests (from parallel tool execution) are
   * serialized so only one prompt is active at a time. After waiting,
   * rules are re-checked because a previous prompt may have created a
   * rule that now covers this request.
   */
  async resolvePermission(
    toolName: string,
    toolArgs: unknown,
    context?: ToolPermissionRequestContext,
  ): Promise<boolean | CortexToolPermissionResult> {
    const abortSignal = context?.signal;
    const sandboxStatus = this.sandbox.getStatus();
    const sandboxPolicy = this.sandbox.getPolicy();
    const preflightDeps: PreflightDeps = {
      yoloMode: this.getYoloMode(),
      cwd: this.cwd,
      matchRule: (t, a) => this.rules.matchRule(t, a),
      isReadOnlyInProject: (t, a) => this.isReadOnlyInProject(t, a),
      // Sandboxed shell commands past the catastrophic floor and any deny rule
      // auto-run inside the OS boundary instead of prompting. Gate on BOTH axes:
      // a filesystem-only backend (fs enforced but network none) must keep
      // prompting rather than auto-run with open egress.
      sandboxBashEnforced:
        sandboxStatus?.filesystem === 'enforced' &&
        sandboxStatus?.network === 'enforced',
      // Broad read auto-approve for Read/Grep/Glob, matching the sandboxed
      // shell's view: reads are broad by policy design, denyRead is the only
      // read-side restriction. Requires FULL filesystem enforcement, not
      // partial: a partial backend may not deny secret-file reads to
      // subprocesses, and Grep's denyRead guarantee is the kernel containing
      // ripgrep. Network enforcement is irrelevant to reads, so this is
      // deliberately looser than sandboxBashEnforced's both-axes gate.
      sandboxReadsBroad:
        sandboxStatus?.filesystem === 'enforced' &&
        sandboxPolicy !== undefined,
      // With an active sandbox policy, WebFetch is gated per host by the same
      // network decision as shell egress; that gate replaces the per-call tool
      // prompt. Purely policy-level, so it applies even where OS enforcement
      // is degraded (the gate runs in-process).
      webFetchNetworkGated: sandboxPolicy !== undefined,
      // Project the policy's filesystem deny sets onto the in-process file
      // tools (Write/Edit/UndoEdit/Read/Glob), which bypass the OS boundary the
      // shell is contained by. writableRoots is the positive floor: the shell
      // may write only inside it, so an in-process write escaping it must not
      // auto-approve either. Absent when the sandbox is off.
      ...(sandboxPolicy
        ? {
            sandboxDenyWrite: sandboxPolicy.filesystem.denyWrite,
            sandboxDenyRead: sandboxPolicy.filesystem.denyRead,
            sandboxWritableRoots: sandboxPolicy.filesystem.writableRoots,
          }
        : {}),
    };

    // Fast path: deterministic decision (catastrophic floor > yolo > deny rule
    // > read-only-in-project > allow rule) before acquiring the prompt lock.
    const pre = await preflightPermission(toolName, toolArgs, preflightDeps);
    if (pre.decision === 'allow') return true;
    if (pre.decision === 'block') {
      return pre.reason ? { decision: 'block', reason: pre.reason } : { decision: 'block' };
    }

    const app = this.getApp();
    if (!app) return { decision: 'block', reason: 'TUI not initialized' };

    // Serialize: take the lock in arrival order, tool and network asks alike.
    const releaseLock = await this.promptLock.acquire();
    try {
      // The asking run may have been aborted while this ask waited behind
      // another prompt (or before it arrived). Cortex has already stopped
      // waiting for this resolver, so never show a prompt for dead work.
      if (abortSignal?.aborted) {
        return { decision: 'block', reason: 'Run aborted before the permission prompt was shown' };
      }

      // Re-check: a previous prompt may have added an "always allow"/deny rule.
      const preAfterWait = await preflightPermission(toolName, toolArgs, preflightDeps);
      if (preAfterWait.decision === 'allow') return true;
      if (preAfterWait.decision === 'block') {
        return preAfterWait.reason
          ? { decision: 'block', reason: preAfterWait.reason }
          : { decision: 'block' };
      }
      return await this.promptTool(app, toolName, toolArgs, context);
    } finally {
      releaseLock();
    }
  }

  /** Show the tool prompt; the caller holds the prompt lock. */
  private async promptTool(
    app: Pick<App, 'showPermissionPrompt'>,
    toolName: string,
    toolArgs: unknown,
    context: ToolPermissionRequestContext | undefined,
  ): Promise<boolean | CortexToolPermissionResult> {
    const abortSignal = context?.signal;
    const permission = this.activity.recordPermissionRequested(
      toolName,
      toolArgs,
      context?.askId !== undefined ? { askId: context.askId } : undefined,
    );
    await permission.written;
    let permissionResolution: PermissionResolution = 'denied';

    // Allow answering out-of-band (e.g. a companion app writing a decision to
    // the session's control directory) as well as from the inline TUI prompt:
    // watch for an external decision and let whichever lands first win. Aborting
    // the controller stops the watcher once the prompt resolves, however it
    // resolved.
    const externalController = new AbortController();
    const fileDecision = watchDecisionFile(
      this.activity.decisionPath(permission.id),
      externalController.signal,
    );

    // Dismiss the prompt when the asking run is aborted. Cortex races the
    // resolver against the run's abort signal and proceeds with a block, so
    // an unanswered prompt would sit on screen for dead work while holding
    // the prompt lock, serializing the next live ask behind it. The
    // abort settles the prompt through the same external-decision channel a
    // companion app uses, which removes it from the TUI and releases the lock.
    let abortDismissed = false;
    let onAbort: (() => void) | undefined;
    let externalDecision = fileDecision;
    if (abortSignal) {
      // The aborted pre-check above ran BEFORE recordPermissionRequested and
      // the awaited state write, and addEventListener never fires for a
      // signal that is already aborted. An abort landing inside that window
      // must settle the decision here, or the prompt sits on screen for
      // dead work holding the prompt lock forever, serializing every
      // later ask behind it.
      let abortDecision: Promise<'deny'>;
      if (abortSignal.aborted) {
        abortDismissed = true;
        abortDecision = Promise.resolve('deny');
      } else {
        abortDecision = new Promise<'deny'>((resolve) => {
          onAbort = () => {
            abortDismissed = true;
            resolve('deny');
          };
          abortSignal.addEventListener('abort', onAbort, { once: true });
        });
      }
      externalDecision = Promise.race([fileDecision, abortDecision]);
    }

    try {
      const result = await app.showPermissionPrompt(toolName, toolArgs, externalDecision);
      if (abortDismissed) {
        permissionResolution = 'cancelled';
        return {
          decision: 'block',
          reason: 'Run aborted before the permission prompt was answered',
        };
      }
      permissionResolution = result.decision === 'allow' ? 'allowed' : 'denied';

      if (result.scope === 'project-edits') {
        // Project-wide edit/write permission: add rules for both tools
        const cwdPattern = `${this.cwd}/*`;
        await this.rules.addRule('project', 'allow', 'Edit', cwdPattern);
        await this.rules.addRule('project', 'allow', 'Write', cwdPattern);
      } else if (result.pattern && result.scope) {
        await this.rules.addRule(result.scope, result.decision, toolName, result.pattern);
      }

      return result.decision === 'allow' ? true : { decision: 'block' };
    } catch (error) {
      permissionResolution = 'error';
      void this.activity.recordError(error instanceof Error ? error : String(error));
      throw error;
    } finally {
      if (abortSignal && onAbort) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      externalController.abort();
      await this.activity.recordPermissionResolved(permission.id, toolName, permissionResolution);
    }
  }

  /**
   * The single network egress decision, shared by sandboxed shell commands
   * (the provider's ask-callback) and WebFetch (Cortex's resolveNetworkAccess
   * seam). Auto-allows the seeded registry allowlist and prior grants;
   * otherwise prompts once per host with once/session/always scope.
   */
  resolveNetworkAccess(req: NetworkAccessRequest): Promise<NetworkAccessDecision> {
    return this.networkAccess.resolve(req);
  }

  /**
   * Show the unified network prompt, serialized with tool permission prompts
   * through the same lock so shell and WebFetch asks never overlap. Recorded
   * in the activity stream so a companion app can answer out-of-band.
   */
  private async promptNetworkAccess(req: NetworkAccessRequest): Promise<NetworkPromptChoice> {
    // Yolo mode never prompts. Allow this request only (no lasting grant);
    // deniedDomains and the restricted rung are enforced before we get here.
    if (this.getYoloMode()) return 'once';
    const app = this.getApp();
    if (!app) return 'deny';

    // Serialize: take the lock in arrival order, tool and network asks alike.
    const releaseLock = await this.promptLock.acquire();
    try {
      return await this.showNetworkPrompt(app, req);
    } finally {
      releaseLock();
    }
  }

  /** Show the network prompt; the caller holds the prompt lock. */
  private async showNetworkPrompt(
    app: Pick<App, 'showNetworkPrompt'>,
    req: NetworkAccessRequest,
  ): Promise<NetworkPromptChoice> {
    const permission = this.activity.recordPermissionRequested('NetworkAccess', {
      host: req.host,
      via: req.via,
      ...(req.url ? { url: req.url } : {}),
    });
    await permission.written;
    let permissionResolution: PermissionResolution = 'denied';

    const externalController = new AbortController();
    const externalDecision = watchDecisionFile(
      this.activity.decisionPath(permission.id),
      externalController.signal,
    );

    try {
      const choice = await app.showNetworkPrompt(req, externalDecision);
      permissionResolution = choice === 'deny' ? 'denied' : 'allowed';
      return choice;
    } catch (error) {
      permissionResolution = 'error';
      void this.activity.recordError(error instanceof Error ? error : String(error));
      throw error;
    } finally {
      externalController.abort();
      await this.activity.recordPermissionResolved(permission.id, 'NetworkAccess', permissionResolution);
    }
  }

  /** Check if a tool call is a read-only operation within the project directory. */
  private async isReadOnlyInProject(toolName: string, toolArgs: unknown): Promise<boolean> {
    const args = toolArgs as Record<string, unknown>;
    switch (toolName) {
      case 'Read': {
        // Mirror getMatchValue/matchRule's `file_path ?? path` so the read-only
        // auto-approve and the rule layer can never disagree on the target.
        const filePath = String(args['file_path'] ?? args['path'] ?? '');
        return this.isWithinCwd(filePath);
      }
      case 'Glob':
      case 'Grep': {
        const searchPath = String(args['path'] ?? this.cwd);
        return this.isWithinCwd(searchPath);
      }
      default:
        return false;
    }
  }

  /** Check if a path resolves within the current working directory. */
  private async isWithinCwd(targetPath: string): Promise<boolean> {
    return isPathWithinRealCwd(targetPath, this.cwd);
  }
}
