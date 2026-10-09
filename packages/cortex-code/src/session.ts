/**
 * Session: the composition root for one interactive cortex-code session.
 *
 * Builds the CortexAgent and the TUI, and wires the collaborators that each
 * own one part of a session:
 * - model, provider and effort selection (session/model-selection)
 * - the agent's getAuth credentials (providers/api-key-resolver)
 * - tool and network permission prompts (permissions/prompt-broker)
 * - the sandbox rung and status (session/sandbox-state)
 * - trust gates for project MCP servers, hooks and skills (session/trust-gates)
 * - busy state keyed on work settlement (session/work-tracker)
 * - turn submission (session/turn-runner)
 * - event routing to the TUI, activity stream and transcript (session/agent-events)
 * - persistence and checkpoints (persistence/session-checkpoints)
 * - the footer and the model's environment block (session/status-view)
 *
 * What stays here is lifecycle (start, input dispatch, resume, abort,
 * shutdown) and the accessors slash commands use.
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

import {
  CortexAgent,
  ProviderManager,
  type CortexModel,
  type CortexAgentConfig,
  type ResolutionNote,
  type SandboxPolicy,
  type SandboxRung,
  type SandboxStatus,
  type ThinkingLevel,
} from '@animus-labs/cortex';
import { FileSessionActivityReporter } from './activity/session-activity.js';
import { getCommand, registerBuiltinCommands } from './commands/index.js';
import { resolveAgentMode, type CortexCodeConfig } from './config/config.js';
import { CredentialStore } from './config/credentials.js';
import { FreezeDiagnostics } from './diagnostics/freeze.js';
import { discoverProjectContext } from './discovery/context.js';
import { applyPreTurnHooks } from './hooks/pre-turn.js';
import type { HookEvent, HookHandler } from './hooks/types.js';
import { log } from './logger.js';
import { McpReloadScheduler } from './mcp/reload-scheduler.js';
import type { Mode } from './modes/types.js';
import { PermissionBroker } from './permissions/prompt-broker.js';
import { workspaceSettingsPath } from './permissions/rules.js';
import { SessionCheckpoints } from './persistence/session-checkpoints.js';
import { generateSessionId } from './persistence/sessions.js';
import { TranscriptWriter } from './persistence/transcript-writer.js';
import { AuthResolver } from './providers/api-key-resolver.js';
import { buildAgentConfig } from './session/agent-config.js';
import { wireAgentEvents } from './session/agent-events.js';
import { AssistantStream } from './session/assistant-stream.js';
import { LoopRouting } from './session/loop-routing.js';
import { ModelSelection } from './session/model-selection.js';
import { RetryStatusLine } from './session/retry-status.js';
import { SessionSandbox } from './session/sandbox-state.js';
import { SessionStatusView, readGitBranch } from './session/status-view.js';
import { SubAgentActivity } from './session/sub-agent-activity.js';
import { ProjectTrustGates } from './session/trust-gates.js';
import { TurnRunner } from './session/turn-runner.js';
import { WorkTracker } from './session/work-tracker.js';
import { TitleManager } from './terminal/title-manager.js';
import { App, type AppCallbacks } from './tui/app.js';
import type { UpdateInfo } from './updates/checker.js';
import { UpdatePrompt } from './updates/update-prompt.js';

export interface SessionOptions {
  config: CortexCodeConfig;
  mode: Mode;
  model: CortexModel;
  provider: string;
  modelId: string;
  providerManager: ProviderManager;
  credentialStore: CredentialStore;
  cwd: string;
  yoloMode: boolean;
  /**
   * The `--duplex` / `--no-duplex` flag, or undefined when neither was passed.
   * Undefined hands the decision to the `agentMode` config key.
   */
  duplex?: boolean | undefined;
  initialEffort: ThinkingLevel;
  initialUtilityModelId?: string | undefined;
  resumeSessionId: string | undefined;
  compactionStrategy?: 'observational' | 'classic';
  /** Update availability resolved at startup, or null when up to date / disabled. */
  updateInfo?: UpdateInfo | null;
}

export class Session {
  // Created by start(). Collaborators read both through getters, never a
  // captured value, because they are built here in the constructor.
  private agent: CortexAgent | null = null;
  private app: App | null = null;
  private titleManager: TitleManager | null = null;
  private hookHandlers: Record<HookEvent, HookHandler[]> | null = null;

  private readonly config: CortexCodeConfig;
  /**
   * The Cortex facade mode, resolved once from the flag and config (see
   * `resolveAgentMode` for why passthrough is the default). Every
   * mode-dependent decision in this session reads this one value, and it is
   * never reassigned: the loops are assembled from it, so a change would leave
   * the routing describing an agent that does not exist.
   */
  private readonly agentMode: NonNullable<CortexAgentConfig['mode']>;
  private readonly mode: Mode;
  private readonly model: CortexModel;
  private readonly providerManager: ProviderManager;
  private readonly credentialStore: CredentialStore;
  private readonly cwd: string;
  private yoloMode: boolean;
  private readonly initialUtilityModelId: string | undefined;
  private readonly compactionStrategy: 'observational' | 'classic';
  private readonly updateInfo: UpdateInfo | null;
  private readonly sessionId: string;
  /** True when this session was launched to resume a saved one. */
  private readonly isResume: boolean;

  private readonly freezeDiagnostics: FreezeDiagnostics;
  private readonly activity: FileSessionActivityReporter;
  /**
   * Durable append-only conversation log, separate from the lossy state
   * snapshot. Read by sibling apps to summarize where a session left off.
   */
  private readonly transcriptWriter: TranscriptWriter;

  private readonly routing: LoopRouting;
  private readonly models: ModelSelection;
  private readonly auth: AuthResolver;
  private readonly sandbox: SessionSandbox;
  private readonly permissions: PermissionBroker;
  private readonly status: SessionStatusView;
  private readonly checkpoints: SessionCheckpoints;
  private readonly work: WorkTracker;
  private readonly trust: ProjectTrustGates;
  private readonly mcpReload: McpReloadScheduler;
  private readonly turns: TurnRunner;
  private readonly updatePrompt: UpdatePrompt;
  private readonly retry = new RetryStatusLine(() => this.app);
  private readonly subAgents = new SubAgentActivity(() => this.app);
  private readonly stream = new AssistantStream(() => this.app);

  constructor(options: SessionOptions) {
    this.config = options.config;
    this.agentMode = resolveAgentMode(options.duplex, options.config.agentMode);
    this.mode = options.mode;
    this.model = options.model;
    this.providerManager = options.providerManager;
    this.credentialStore = options.credentialStore;
    this.cwd = options.cwd;
    this.yoloMode = options.yoloMode;
    this.initialUtilityModelId = options.initialUtilityModelId;
    this.compactionStrategy = options.compactionStrategy ?? 'observational';
    this.updateInfo = options.updateInfo ?? null;
    this.sessionId = options.resumeSessionId ?? generateSessionId();
    this.isResume = options.resumeSessionId !== undefined;

    const getAgent = () => this.agent;
    const getApp = () => this.app;
    const settingsPath = workspaceSettingsPath(options.cwd);

    this.freezeDiagnostics = new FreezeDiagnostics(this.config.diagnostics?.freeze);
    this.activity = new FileSessionActivityReporter(this.sessionId, this.cwd, {
      onWriteError: (error) => {
        log.warn('Session activity write failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    this.transcriptWriter = new TranscriptWriter(this.sessionId, this.cwd, {
      cliVersion: PKG_VERSION,
      provider: options.provider,
      model: options.modelId,
      resume: this.isResume,
      onWriteError: (error) => {
        log.warn('Session transcript write failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });

    this.routing = new LoopRouting(this.agentMode);
    this.models = new ModelSelection({
      provider: options.provider,
      modelId: options.modelId,
      initialEffort: options.initialEffort,
      config: options.config,
      providerManager: options.providerManager,
      credentialStore: options.credentialStore,
      getAgent,
      getApp,
    });
    this.auth = new AuthResolver(options.credentialStore, options.providerManager, () => this.models.provider);
    this.sandbox = new SessionSandbox({
      config: options.config,
      cwd: options.cwd,
      settingsPath,
      getAgent,
      getApp,
      onRungChanged: () => this.status.refreshEnvironment(),
    });
    this.permissions = new PermissionBroker({
      cwd: options.cwd,
      settingsPath,
      activity: this.activity,
      sandbox: this.sandbox,
      getApp,
      getYoloMode: () => this.yoloMode,
    });
    this.status = new SessionStatusView({
      cwd: options.cwd,
      modeName: options.mode.name,
      agentMode: this.agentMode,
      compactionStrategy: this.compactionStrategy,
      models: this.models,
      sandbox: this.sandbox,
      getYoloMode: () => this.yoloMode,
      getAgent,
      getApp,
    });
    this.checkpoints = new SessionCheckpoints({
      sessionId: this.sessionId,
      agentMode: this.agentMode,
      compactionStrategy: this.compactionStrategy,
      getAgent,
      describe: () => ({
        mode: this.mode.name,
        provider: this.models.provider,
        model: this.models.modelId,
        cwd: this.cwd,
        contextTokenCount: this.status.displayedContextTokens(),
      }),
    });
    this.work = new WorkTracker({
      getAgent,
      freezeDiagnostics: this.freezeDiagnostics,
      onSettled: () => this.applyWorkSettledUi(),
    });
    this.trust = new ProjectTrustGates(options.cwd, getAgent, getApp);
    this.mcpReload = new McpReloadScheduler({
      cwd: options.cwd,
      getAgent,
      getApp,
      isBusy: () => this.work.isRunning,
      resolveProjectTrust: (cwd, servers) => this.trust.resolveProjectMcpTrust(cwd, servers.map(s => s.name)),
    });
    this.turns = new TurnRunner({
      getAgent,
      getApp,
      getTitleManager: () => this.titleManager,
      activity: this.activity,
      transcriptWriter: this.transcriptWriter,
      retry: this.retry,
      status: this.status,
      work: this.work,
      applyPreTurnHooks: (text) => applyPreTurnHooks(
        this.hookHandlers?.pre_turn ?? [],
        { sessionId: this.sessionId, cwd: this.cwd },
        text,
      ),
    });
    this.updatePrompt = new UpdatePrompt({
      getApp,
      activity: this.activity,
      flushTranscript: () => this.transcriptWriter.flush(),
    });
  }

  /** Start the session: create agent, set up context, wire events, start TUI. */
  async start(): Promise<void> {
    log.info('Session starting', { provider: this.models.provider, model: this.models.modelId, cwd: this.cwd });
    await this.activity.initialize();

    // Register commands
    registerBuiltinCommands();

    // Load persisted permission rules and network domain grants
    await this.permissions.load();

    // Create TUI
    const callbacks: AppCallbacks = {
      onSubmit: (text) => this.handleInput(text),
      onAbort: () => this.abort(),
      onExit: () => this.shutdown(),
    };
    this.app = new App(callbacks, this.cwd, this.freezeDiagnostics);

    // Initialize the OS sandbox (on by default at the Workspace rung) before the
    // agent so its Bash tool spawns are contained. Warn-and-continue if the host
    // cannot enforce; status is surfaced and the agent still runs.
    await this.sandbox.init();

    // Create agent (built-in tools are auto-registered by Cortex)
    this.agent = await CortexAgent.create(this.buildAgentConfig());
    this.sandbox.applyState(this.agent.getSandboxState());

    if (this.initialUtilityModelId) {
      await this.models.applyInitialUtilityModel(this.initialUtilityModelId);
    }

    // Set up context slots
    const projectContext = await discoverProjectContext(this.cwd);
    const ctx = this.agent.getContextManager();
    ctx.setSlot('system-prompt', this.mode.systemPrompt);
    if (projectContext) {
      ctx.setSlot('project-context', projectContext);
    }

    // Set up ephemeral context
    await this.status.refreshEnvironment();

    // Terminal title: name the tab after what the user is working on. Runs on
    // the utility model and is best-effort, so a failure never disrupts the
    // session. Must be created before wireEvents (onLoopComplete drives it).
    this.titleManager = new TitleManager({
      mode: this.config.terminalTitle ?? 'dynamic',
      cwd: this.cwd,
      setTitle: (title) => this.app?.terminal.setTitle(title),
      complete: async (ctx) => (this.agent ? this.agent.utilityComplete(ctx) : null),
      onError: (err) => log.debug('Terminal title generation failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    });
    this.titleManager.start();

    // Wire events
    this.wireEvents();

    // Connect MCP servers (with trust-on-first-use for project-local configs)
    await this.trust.connectMcpServers();

    // Watch ~/.cortex/mcp.json and {cwd}/.cortex/mcp.json for changes so we
    // can pick them up between turns without a restart.
    await this.mcpReload.start();

    // Load lifecycle hook handlers from ~/.cortex/hooks.json and
    // {cwd}/.cortex/hooks.json. Loading is non-fatal: a malformed config or
    // missing files yields an empty handler set rather than blocking
    // startup. Project hooks pass through the trust gate first: an untrusted
    // project's hooks are NOT loaded, so a cloned repo cannot run its
    // hooks.json on the first turn.
    try {
      this.hookHandlers = await this.trust.loadHooks();
    } catch (err) {
      log.warn('Hook loader failed; running without hooks', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.hookHandlers = null;
    }

    // Register skills. Global skills (~/.cortex/skills) are user-authored and
    // always registered. Project skills (.cortex/skills) run shell on load, so
    // they pass through the trust gate first: an untrusted project's skills are
    // NOT registered and are therefore not model-invocable.
    await this.trust.registerSkills();
    // Refresh autocomplete after skills are registered
    this.app.refreshCommands(this.cwd);

    // Apply initial thinking level
    const { effective: initialEffort } = await this.models.reconcileEffort();

    // Show banner. The split-flap settle plays only for a fresh session; a
    // resumed session opens straight to the settled logo.
    const branch = await readGitBranch(this.cwd);
    // Settle the transcript header now that the git branch is known, before any
    // turn events can fire. session_meta is the first line of a fresh transcript.
    await this.transcriptWriter.initialize({ gitBranch: branch });
    const project = this.cwd.split('/').pop() ?? '';
    this.app.transcript.addBanner(PKG_VERSION, project, branch, this.updateInfo ?? undefined, {
      animate: !this.isResume,
    });

    // Update footer
    this.status.pushInitialFooter(branch, initialEffort);

    // Recommend (never apply) /sandbox off when already inside a container.
    void this.sandbox.surfaceContainerRecommendation();

    // Put the session on disk before it can do any work. Everything after
    // this point can crash without the session becoming unlistable. A
    // resumed session already has an artifact and resume() has not read it
    // yet, so it checkpoints itself once the restore lands instead.
    if (!this.isResume) await this.checkpoints.writeInitial();

    // Start TUI event loop
    this.app.start();
    void this.activity.recordAwaitingInput();

    // Surface the interactive update prompt once the input loop is live, and
    // only when this version has not already been skipped. The subtle banner
    // line above remains regardless. Non-blocking so resume can proceed.
    if (this.updateInfo?.shouldPrompt) {
      void this.promptForUpdate(this.updateInfo);
    }
  }

  /** Show the interactive "update available" overlay (startup and /update). */
  promptForUpdate(info: UpdateInfo): Promise<void> {
    return this.updatePrompt.show(info);
  }

  /** Handle user input: a slash command, or a turn for the agent. */
  private async handleInput(text: string): Promise<void> {
    // Check for slash commands
    if (text.startsWith('/')) {
      const parts = text.slice(1).split(/\s+/);
      const cmdName = parts[0];
      if (cmdName) {
        const cmd = getCommand(cmdName);
        if (cmd) {
          await this.activity.recordWorking();
          try {
            await cmd.handler(this, parts.slice(1).filter((p) => p.length > 0));
          } finally {
            void this.activity.recordAwaitingInput();
          }
          return;
        }
      }
    }

    await this.turns.submit(text);
  }

  /**
   * The end-of-work UI: everything the user reads as "the agent is done and
   * waiting for me". Fires once per settled exchange, not once per loop.
   */
  private applyWorkSettledUi(): void {
    this.app?.transcript.closeActiveToolGroups();
    this.app?.hideStatusSpinner();
    this.app?.focusEditor();
    void this.activity.recordAwaitingInput();
    // One completed exchange: advance the title cadence (regenerates every
    // N turns, idle here so it never competes with the main loop).
    this.titleManager?.onUserTurnComplete();
    // If the MCP config changed during the turn, apply it now. Doing this
    // here (vs mid-turn) avoids invalidating the tool snapshot that
    // pi-agent-core captured at prompt() entry.
    this.mcpReload.runIfPending();
  }

  /** The `/mcp-reload` entry point: same gating as a watcher-driven reload. */
  async triggerMcpReload(): Promise<void> {
    this.mcpReload.schedule('manual');
  }

  /** Wire all agent events to the TUI, the activity stream and the durable transcript. */
  private wireEvents(): void {
    if (!this.agent || !this.app) return;
    wireAgentEvents(this.agent, this.app, {
      routing: this.routing,
      stream: this.stream,
      subAgents: this.subAgents,
      retry: this.retry,
      work: this.work,
      status: this.status,
      checkpoints: this.checkpoints,
      turns: this.turns,
      activity: this.activity,
      transcriptWriter: this.transcriptWriter,
      freezeDiagnostics: this.freezeDiagnostics,
    });
  }

  /** Abnormal-exit teardown. Cortex owns its sandbox and temporary directory. */
  async disposeSandbox(): Promise<void> {
    await this.agent?.destroy();
  }

  /**
   * Resume a previous session.
   *
   * Composite (v2) saves are preferred; a session written before the
   * composite format existed still loads through the v1 pair, which the
   * facade upgrades transparently. Both go in through the one all-or-nothing
   * `restore()`, which subsumes the three separate loop-level restore calls
   * (history, observational state, usage): those could each land
   * independently and mid-run, while `restore()` applies them in order and
   * refuses outright while a loop is running, so a /resume typed during a
   * turn fails loudly instead of splicing history out from under it.
   */
  async resume(sessionId: string): Promise<void> {
    if (!this.agent) return;

    const loaded = await this.checkpoints.loadResumable(sessionId);
    if (!loaded) {
      this.app?.transcript.addNotification('Resume Failed', `Session ${sessionId} not found.`);
      // There was nothing under this id, so the session start() skipped a
      // checkpoint for is effectively a fresh one. Give it the artifact it
      // would have had, or it stays invisible to listSessions().
      await this.checkpoints.writeInitial();
      return;
    }

    try {
      // Awaited: restore() reports its guards as a rejection, so an
      // unawaited call would leave a /resume typed during a turn escaping
      // this catch as an unhandled rejection.
      await this.agent.restore(loaded.artifact);
    } catch (err) {
      log.warn('Resume restore rejected', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.app?.transcript.addNotification(
        'Resume Failed',
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    this.checkpoints.adoptCreatedAt(loaded.meta.createdAt);
    this.status.refreshObservationalMemory();

    // Replay message history into the transcript so the user sees the
    // previous conversation. Cortex already has the history in context; this
    // is purely visual rehydration.
    if (this.app) {
      const { replayHistoryToTranscript } = await import('./utils/replay-history.js');
      this.app.transcript.addNotification(
        'Session Resumed',
        `Replaying ${loaded.dialogue.length} messages from previous session.`,
      );
      replayHistoryToTranscript(loaded.dialogue, this.app.transcript);
    }
    this.status.refreshContextUsage();
    // Re-baseline: start() checkpointed an empty agent, so without this the
    // crash checkpoint's base would still be that empty snapshot and would
    // blank the restored talker side on the first turn.
    await this.checkpoints.writeInitial();
  }

  /**
   * Abort the current agent loop without destroying.
   *
   * Skipped once teardown has begun: the editor discards the promise this
   * returns (Ctrl+C is fire-and-forget), so anything that rejects in here
   * rejects unhandled. CortexAgent.abort() is itself a no-op after destroy,
   * but abort() during shutdown still has nothing to cancel and its activity
   * record would land after the "done" record, so skip the whole body.
   *
   * The `isRunning` gate is what makes Ctrl+C work at all, which is why that
   * flag is keyed on the facade's settlement predicate and not on any single
   * loop's completion.
   */
  async abort(): Promise<void> {
    this.freezeDiagnostics.recordAbortRequested('session.abort');
    const tearingDown = this.agent?.state === 'destroying' || this.agent?.state === 'destroyed';
    if (this.agent && this.work.isRunning && !tearingDown) {
      await this.agent.abort();
      void this.activity.recordError({
        category: 'cancelled',
        severity: 'recoverable',
        originalMessage: 'Agent loop cancelled by user',
      });
    }
    this.work.markIdle();
    this.app?.hideStatusSpinner();
    this.app?.focusEditor();
    void this.activity.recordAwaitingInput();
  }

  /** Graceful shutdown: save, destroy agent, stop TUI. */
  async shutdown(): Promise<void> {
    // Stop the retry countdown timer so it cannot fire after teardown.
    this.retry.stopTicker();

    // Tear down MCP config watcher first so a late filesystem event cannot
    // schedule work against the agent we're about to destroy.
    await this.mcpReload.stop();

    // Flush pending saves
    await this.checkpoints.flush();
    // Drain any queued transcript appends (best-effort; never throws).
    await this.transcriptWriter.flush();

    // Immediate final save
    if (this.agent) {
      await this.checkpoints.saveFinal(this.agent);
      await this.agent.destroy();
      this.agent = null;
    }

    // Reset the terminal title before tearing down the TUI.
    this.titleManager?.dispose();

    await this.activity.recordDone({ code: 0, signal: null, reason: 'normal_shutdown' });
    await this.activity.flush();
    this.app?.stop();
    process.exit(0);
  }

  /**
   * Restore the terminal out of raw mode. Called from crash/signal paths in the
   * entry point before the process exits so a fatal error never leaves the
   * user's terminal wedged. App.stop() is idempotent, so this is safe to call
   * alongside a normal shutdown().
   */
  restoreTerminal(): void {
    this.app?.stop();
  }

  async recordFatalActivityError(error: unknown): Promise<void> {
    await this.activity.recordError(error instanceof Error ? error : String(error), true);
    await this.activity.flush();
  }

  async recordSignalActivityError(signal: NodeJS.Signals): Promise<void> {
    await this.activity.recordError({
      category: 'cancelled',
      severity: 'recoverable',
      originalMessage: `Process terminated by ${signal}`,
    }, true);
    await this.activity.flush();
  }

  /**
   * The config handed to CortexAgent.create(). Separate from start() so the
   * mode is assertable without standing up a TUI and a sandbox.
   */
  private buildAgentConfig(): CortexAgentConfig {
    return buildAgentConfig({
      agentMode: this.agentMode,
      model: this.model,
      cwd: this.cwd,
      mode: this.mode,
      config: this.config,
      sessionId: this.sessionId,
      compactionStrategy: this.compactionStrategy,
      sandbox: this.sandbox.getAgentOptions(),
      resolvePermission: (toolName, toolArgs, context) =>
        this.permissions.resolvePermission(toolName, toolArgs, context),
      resolveNetworkAccess: (req) => this.permissions.resolveNetworkAccess(req),
      isAutoApprove: () => this.yoloMode,
      getAuth: (provider) => this.auth.getAuth(provider),
    });
  }

  // -------------------------------------------------------------------------
  // Public accessors for command handlers
  // -------------------------------------------------------------------------

  getAgent(): CortexAgent | null { return this.agent; }
  getApp(): App | null { return this.app; }

  /** What the assembly resolved to where it differs from the config. Read live. */
  getResolutionReport(): ResolutionNote[] { return this.status.resolutionReport(); }
  getYoloMode(): boolean { return this.yoloMode; }
  /** The facade mode in force, resolved at construction. See {@link agentMode}. */
  getAgentMode(): NonNullable<CortexAgentConfig['mode']> { return this.agentMode; }
  getCompactionStrategy(): 'observational' | 'classic' { return this.compactionStrategy; }
  setYoloMode(enabled: boolean): void {
    this.yoloMode = enabled;
    this.app?.updateStatus({ yoloMode: enabled });
  }
  getPreferredEffort(): ThinkingLevel { return this.models.getPreferredEffort(); }
  getEffectiveEffort(): ThinkingLevel { return this.models.getEffectiveEffort(); }
  setPreferredEffort(level: ThinkingLevel): Promise<void> { return this.models.setPreferredEffort(level); }

  /** Reset the terminal title on a fresh-start signal (e.g. /clear). */
  resetTitle(): void { this.titleManager?.reset(); }
  getSandboxRung(): SandboxRung { return this.sandbox.getRung(); }
  getSandboxStatus(): SandboxStatus | undefined { return this.sandbox.getStatus(); }
  getSandboxPolicy(): SandboxPolicy | undefined { return this.sandbox.getPolicy(); }
  isSandboxConfigEnabled(): boolean { return this.sandbox.isConfigEnabled(); }
  /**
   * Change the trust rung. A HUMAN action only: the sole caller is the
   * /sandbox slash command, never a tool, so an agent cannot widen its own
   * containment.
   */
  setSandboxRung(rung: SandboxRung): Promise<{ changed: boolean; reason?: string }> {
    return this.sandbox.setRung(rung);
  }
  /** Domain grants for transparency surfaces (/sandbox status). */
  getNetworkGrantInfo(): { persisted: readonly string[]; session: readonly string[] } {
    return this.permissions.getNetworkGrantInfo();
  }
  getProviderManager(): ProviderManager { return this.providerManager; }
  getCredentialStore(): CredentialStore { return this.credentialStore; }
  getProvider(): string { return this.models.provider; }
  getModelId(): string { return this.models.modelId; }
  getCwd(): string { return this.cwd; }

  setUtilityModel(modelId: string): Promise<void> { return this.models.setUtilityModel(modelId); }
  resetUtilityModel(): Promise<void> { return this.models.resetUtilityModel(); }
  switchModel(modelId: string): Promise<void> { return this.models.switchModel(modelId); }
  switchProvider(provider: string, modelId: string): Promise<void> { return this.models.switchProvider(provider, modelId); }
}
