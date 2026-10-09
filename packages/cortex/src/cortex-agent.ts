/**
 * CortexAgent: the composite facade over the AgentLoop primitive
 * (docs/cortex/duplex/facade-api.md, architecture.md).
 *
 * Consumers interact with one CortexAgent. It owns what every session
 * shares: the session log, composite persistence and usage, settlement,
 * the resolution report, and teardown. What depends on the mode is a
 * SessionMode (facade/session-mode.ts):
 *
 * - `duplex` (decisions.md D14): a fast talker loop fronting the persistent
 *   reasoner (DuplexSession). The talker carries the fixed control toolset
 *   only; the reasoner does all real work and reports back through the
 *   router's wake policy.
 * - `passthrough`: a single reasoner loop, reproducing direct AgentLoop
 *   behavior exactly (PassthroughSession). This is the consumer opt-out and
 *   the parity baseline for tests.
 *
 * An omitted `mode` resolves to duplex when both loops' models are served
 * concurrently, and to passthrough otherwise (facade/mode-resolution.ts,
 * decisions.md D21).
 *
 * The talker/reasoner split is never exposed in this API; consumer config
 * is routed internally per CONFIG_ROUTING (facade/config.ts), and the
 * members fully determined by which loop owns them live on LoopSurface.
 */

import { AgentLoop } from './agent-loop.js';
import type { DeliverResult, DirectCompletionOptions } from './agent-loop.js';
import type { CortexLogger, PendingAsk, SessionUsage, SkillConfig } from './types.js';
import type { CortexModel } from './model-wrapper.js';
import type { ContextManager } from './context-manager.js';
import type { EventBridge } from './event-bridge.js';
import type { BudgetGuard } from './budget-guard.js';
import type { SessionLogEntry, SessionLogEvent, SessionLogSubscriber } from './session-log.js';
import { NOOP_LOGGER } from './noop-logger.js';
import type { ResolutionNote } from './resolution-report.js';
import type { ResolveNetworkAccess, SandboxRung } from './sandbox/types.js';
import type { SandboxState } from './sandbox/options.js';
import { isSandboxProvider } from './sandbox/options.js';
import { SandboxSession } from './sandbox/session.js';
import { buildReasonerConfig } from './facade/config.js';
import type { CortexAgentConfig, ResolvedCortexAgentConfig } from './facade/config.js';
import { LoopSurface, loopTopology } from './facade/loop-surface.js';
import type { ForwardedLoopMember } from './facade/loop-delegation.js';
import type { CortexAgentPersistedState, CortexAgentStateV2 } from './facade/persisted-state.js';
import { CompositeState } from './facade/composite-state.js';
import { StateEmitter } from './facade/state-emitter.js';
import { LogRecorder } from './facade/log-recorder.js';
import { ResolutionRecorder } from './facade/resolution-recorder.js';
import { resolveFacadeMode } from './facade/mode-resolution.js';
import type { ModeResolution } from './facade/mode-resolution.js';
import { PromptTracker, Settlement } from './facade/settlement.js';
import { PassthroughSession } from './facade/passthrough-session.js';
import type {
  CortexAbortScope,
  CortexCompactNowResult,
  CortexDeliverOptions,
  FacadeServices,
  SessionMode,
} from './facade/session-mode.js';
import type { CompactNowOptions } from './compaction/index.js';
import { assembleDuplexLoops } from './duplex/assembly.js';
import { DuplexSession } from './duplex/session.js';

// The facade's public types live with their owners; re-exported here so the
// facade module stays the one import site for them.
export { CONFIG_ROUTING, buildReasonerConfig } from './facade/config.js';
export type {
  CortexAgentConfig,
  CortexAgentMode,
  CortexSessionLogConfig,
  ConfigDestination,
  DuplexTuningConfig,
  TalkerConfig,
} from './facade/config.js';
export { AGENT_LOOP_DELEGATION } from './facade/loop-delegation.js';
export type { AgentLoopMemberDisposition, ForwardedLoopMember } from './facade/loop-delegation.js';
export type {
  CortexAgentPersistedState,
  CortexAgentStateV1,
  CortexAgentStateV2,
  CortexAgentUsageBreakdown,
  _V1OptionalFieldsAcceptNull,
} from './facade/persisted-state.js';
export type { CortexAbortScope, CortexCompactNowResult, CortexDeliverOptions } from './facade/session-mode.js';

type AssertExtends<A extends B, B> = A;

/**
 * Compile-time check: every forwarded member exists on CortexAgent. Fails
 * to typecheck when a member marked 'forwarded' has no facade counterpart.
 */
export type _ForwardedMembersExistOnFacade = AssertExtends<
  ForwardedLoopMember,
  keyof CortexAgent
>;

export class CortexAgent extends LoopSurface {
  private readonly recorder: LogRecorder;
  private readonly logger: CortexLogger;
  /** Everything whose behavior depends on the mode. */
  private readonly session: SessionMode;
  /**
   * The network egress decision function the facade actually enforces: the
   * broker-routed wrapper in duplex, the consumer's own function in
   * passthrough. Exposed via getNetworkAccessResolver() for the sandbox
   * ask-callback wiring.
   */
  private readonly networkResolver: ResolveNetworkAccess | null;
  private ownedSandbox: SandboxSession | undefined;
  /** Facade prompts accepted but not yet settled (chain-queued or running). */
  private readonly prompts = new PromptTracker();
  private readonly settlement: Settlement;
  private readonly composite: CompositeState;
  private readonly stateEmitter: StateEmitter;

  private destroyPromise: Promise<void> | null = null;
  private destroyed = false;

  private readonly resolution: ResolutionRecorder;

  private constructor(
    reasoner: AgentLoop,
    config: ResolvedCortexAgentConfig,
    talker?: AgentLoop,
    modeResolution: ModeResolution = resolveFacadeMode(config),
  ) {
    const { mode } = modeResolution;
    if (mode === 'duplex' && !talker) {
      throw new Error('CortexAgent duplex mode requires a talker loop.');
    }
    super(loopTopology(reasoner, mode === 'duplex' ? talker! : null));
    const baseLogger = config.logger ?? NOOP_LOGGER;
    this.logger = {
      debug: (message, data) => baseLogger.debug(`[CortexAgent] ${message}`, data),
      info: (message, data) => baseLogger.info(`[CortexAgent] ${message}`, data),
      warn: (message, data) => baseLogger.warn(`[CortexAgent] ${message}`, data),
      error: (message, data) => baseLogger.error(`[CortexAgent] ${message}`, data),
    };

    this.recorder = new LogRecorder({
      sessionLog: config.sessionLog,
      causation: { tags: (surface) => this.session.causation.tags(surface) },
      conversationLoopPath: this.topology.conversation.loopPath,
      persistResult: config.persistResult,
      spillLoopPath: reasoner.loopPath,
      logger: this.logger,
    });

    this.stateEmitter = new StateEmitter({
      snapshot: () => this.getState(),
      shuttingDown: () => this.topology.resident.some(
        (loop) => loop.state === 'destroying' || loop.state === 'destroyed',
      ),
      debounceMs: config.stateChangeDebounceMs,
      logger: this.logger,
    });
    this.recorder.onAppend(() => this.stateEmitter.markDirty());
    this.composite = new CompositeState({
      topology: this.topology,
      recorder: this.recorder,
      session: () => this.session,
    });
    // In duplex, create() has already wrapped this in the broker pipeline.
    this.networkResolver = config.resolveNetworkAccess ?? null;
    this.resolution = ResolutionRecorder.forAssembly({
      config,
      modeResolution,
      topology: this.topology,
      aggregateGuard: () => this.session.aggregateBudgetGuard,
      append: (input) => this.recorder.append(input),
      logger: this.logger,
    });

    const services: FacadeServices = {
      recorder: this.recorder,
      prompts: this.prompts,
      logger: this.logger,
      markStateDirty: () => this.stateEmitter.markDirty(),
      destroyed: () => this.destroyed,
      assertPromptable: () => this.assertPromptable('prompt'),
      conversationIdle: () => this.conversationIdle,
      prompt: (input) => this.prompt(input),
      noteInputArriving: () => this.resolution.noteUnwiredIfNeeded(),
      refreshModelNotes: () => this.resolution.refreshModelNotes(),
    };
    this.session = mode === 'duplex'
      ? new DuplexSession(reasoner, talker!, config, services)
      : new PassthroughSession(reasoner, services);
    this.stateEmitter.watch(this.topology.resident);
    this.settlement = new Settlement(this.session.settlementTerms(this.prompts.term()));
    // Last, because it reads the assembly back: the loops are built, the
    // aggregate guard exists, and every note below is a statement about what
    // this constructor just produced.
    this.resolution.collectAssembly();
  }

  /**
   * Create a CortexAgent. Routes consumer config per {@link CONFIG_ROUTING}
   * and constructs the resident loop(s): the reasoner alone in passthrough
   * (reproducing direct AgentLoop behavior exactly), or the talker plus the
   * persistent reasoner in duplex.
   */
  static async create(config: CortexAgentConfig): Promise<CortexAgent> {
    const { sandbox, ...rest } = config;
    // The facade owns the managed session; loops only receive its provider wrapper.
    const managed = sandbox !== undefined && !isSandboxProvider(sandbox)
      ? await SandboxSession.create(sandbox, config.workingDirectory, config.resolveNetworkAccess)
      : undefined;
    const resolved: ResolvedCortexAgentConfig = {
      ...rest,
      ...(managed ? { sandbox: managed, resolveNetworkAccess: managed.resolveNetworkAccess }
        : isSandboxProvider(sandbox) ? { sandbox } : {}),
    };
    try {
      const agent = await CortexAgent.createResolved(resolved, managed);
      agent.ownedSandbox = managed;
      return agent;
    } catch (error) {
      await managed?.dispose().catch(() => {});
      throw error;
    }
  }

  private static async createResolved(config: ResolvedCortexAgentConfig, managed?: SandboxSession): Promise<CortexAgent> {
    // Decided once, before any loop exists: the loops are built from it.
    const modeResolution = resolveFacadeMode(config);
    if (modeResolution.mode === 'duplex') {
      const loops = await assembleDuplexLoops(config, managed);
      const agent = new CortexAgent(loops.reasoner, loops.config, loops.talker, modeResolution);
      if (managed) agent.resolution.handOutNetworkResolver();
      const session = agent.session as DuplexSession;
      loops.bindBroker(session.broker);
      if (loops.ownedMcp) session.adoptMcpManager(loops.ownedMcp);
      return agent;
    }
    const reasoner = await AgentLoop.create(buildReasonerConfig(config));
    return new CortexAgent(reasoner, config, undefined, modeResolution);
  }

  // -------------------------------------------------------------------------
  // Interaction surface
  // -------------------------------------------------------------------------

  /**
   * Mirror AgentLoop.prompt()'s synchronous validation (teardown state and
   * a configured system prompt) before anything is logged or queued, so the
   * log never records an utterance for input the loop rejects. The loop
   * performs the same checks itself; hoisting them keeps phantom entries
   * out of the log, exactly as deliver() validates at the point of misuse.
   */
  private assertPromptable(action: 'prompt' | 'deliver'): void {
    this.assertNotDestroyed();
    const loopState = this.topology.conversation.state;
    if (loopState === 'destroying') {
      throw new Error('Agent is being destroyed');
    }
    if (loopState === 'destroyed') {
      throw new Error('Agent has been destroyed');
    }
    if (this.topology.conversation.getCurrentSystemPrompt().trim().length === 0) {
      throw new Error(
        `CortexAgent prompt is not configured. Call setBasePrompt() before ${action}(), ` +
        'or provide initialBasePrompt during creation.',
      );
    }
  }

  /**
   * Prompt the agent. Never throws on a busy loop. Passthrough serializes
   * concurrent calls, each resolving against the turn that carries its
   * input, and logs the utterance when its run starts, so log order matches
   * execution order. Duplex hands the input to the talker, where a barge-in
   * parks behind the live run and resolves when the talker next quiesces.
   */
  async prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    this.assertPromptable('prompt');
    return this.session.prompt(input, options);
  }

  /**
   * Fire-and-forget input, with the same non-throwing guarantee as
   * prompt(): the loop's own deliver() state machine decides whether the
   * content starts a turn now ('prompted'), opens the next run ('parked'),
   * or waits silently for the next real prompt ('queued').
   *
   * In duplex, delivered content is fenced in an `<external-update>`
   * wrapper on both surfaces before it reaches a loop (content DELIVERED is
   * content about something, so relayed third-party text never sits in a
   * loop's instruction lane); the session log keeps it unwrapped. The one
   * exception is `speaker: 'user'` on the conversation surface: actual
   * human speech, prompt()'s trust class, which arrives bare like prompt().
   */
  deliver(content: string, options?: CortexDeliverOptions): DeliverResult {
    // Mirror AgentLoop.deliver's synchronous validation before appending,
    // so the log never records an utterance the loop rejected.
    this.assertPromptable('deliver');
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('deliver() requires non-whitespace string content');
    }
    return this.session.deliver(content, options);
  }

  /**
   * Queue a steering message into the running turn (drained at the next
   * turn boundary). Passthrough matches AgentLoop.steer(), including the
   * no-op while idle. Duplex: the conversation surface (the talker) is what
   * a consumer steers, and with no talker turn in flight the message is
   * handled as the user's next prompt() instead of being queued for a run
   * that may never come; directives reach the reasoner through the router.
   *
   * No-op after destroy, matching AgentLoop.steer(): a keystroke landing
   * while shutdown runs is an ordinary race, not a consumer error.
   */
  steer(message: string): void {
    if (this.destroyed) return;
    this.session.steer(message);
  }

  /**
   * Abort per facade-api.md scope semantics. In passthrough the single
   * reasoner is both the conversation surface and the work surface, so
   * every scope aborts its in-flight turn and clears queued deliveries and
   * pi's steering/follow-up queues; 'work' and 'all' additionally cancel
   * running sub-agents. Pending asks resolve as deny through the abort
   * race. Duplex follows the abort table per scope (DuplexSession.abort).
   *
   * No-op after destroy (and once teardown has begun), matching
   * AgentLoop.abort(): consumers wire abort to Ctrl+C fire-and-forget, where
   * a throw during shutdown would surface only as an unhandled rejection.
   */
  async abort(scope: CortexAbortScope = 'all'): Promise<void> {
    if (this.destroyed) return;
    this.recorder.append({
      type: 'lifecycle',
      loopPath: (scope === 'conversation' ? this.topology.conversation : this.topology.work).loopPath,
      content: `Abort requested (scope: ${scope})`,
      data: { event: 'abort', scope },
      causedBy: null,
    });

    await this.session.abort(scope);
  }

  /** Tear down the facade and its loops. Idempotent; shares one teardown. */
  async destroy(timeoutMs?: number): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyed = true;
    this.stateEmitter.destroy();
    this.session.beginDestroy();
    this.destroyPromise = (async () => {
      try {
        const teardowns: Array<Promise<void>> = [
          ...this.topology.resident.map((loop) => loop.destroy(timeoutMs)),
          ...this.session.teardowns(),
        ];
        const results = await Promise.allSettled(teardowns);
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      } finally {
        await this.session.closeOwnedResources();
        try {
          await this.ownedSandbox?.dispose();
        } finally {
          this.session.finishDestroy();
          this.recorder.destroy();
        }
      }
    })();
    return this.destroyPromise;
  }

  /** Snapshot of the effective managed sandbox policy and enforcement. */
  getSandboxState(): SandboxState | undefined { return this.ownedSandbox?.getState(); }

  /** Host-only policy change. Work must settle before changing an OS boundary. */
  async setSandboxRung(rung: SandboxRung): Promise<void> {
    this.assertNotDestroyed();
    if (!this.ownedSandbox) throw new Error('No Cortex-managed sandbox was configured');
    if (!this.workSettled) throw new Error('Wait for work to settle before changing sandbox policy');
    if (this.getMcpClientManager().getConnectionStates().some((connection) =>
      connection.connected && connection.config.transport === 'stdio',
    )) throw new Error('Disconnect stdio MCP servers before changing sandbox policy, then reconnect them under the new policy');
    await this.ownedSandbox.setRung(rung);
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error('CortexAgent has been destroyed');
    }
  }

  // -------------------------------------------------------------------------
  // Resolution report
  // -------------------------------------------------------------------------

  /**
   * What this assembly resolved to, where that differs from what was asked
   * for: the talker silently on the primary model, a utilityModel the talker
   * could not take, an unwired egress resolver, an uncapped session
   * (resolution-report.ts for the full rationale).
   *
   * Present in both modes. Two of the conditions are not duplex-specific,
   * and a consumer should not have to branch on mode to ask "did I get what
   * I configured?"; passthrough simply earns fewer notes.
   *
   * A snapshot copy, so a consumer cannot mutate the record the log entries
   * were derived from. Readable after destroy() on purpose: the report is an
   * immutable statement about an assembly with no live resource behind it,
   * and "why was that session slow or expensive" is asked after the session,
   * not during it.
   */
  getResolutionReport(): ResolutionNote[] {
    return this.resolution.report();
  }

  // -------------------------------------------------------------------------
  // Session log surface
  // -------------------------------------------------------------------------

  /**
   * Snapshot copy (never a live reference) of log entries with
   * seq >= fromSeq (all retained entries when omitted).
   */
  getLog(fromSeq?: number): SessionLogEntry[] {
    this.assertNotDestroyed();
    return this.recorder.log.getLog(fromSeq);
  }

  /**
   * The same range as {@link getLog}, as an event sequence: retained entries
   * interleaved with a gap marker for every hole, in seq order.
   *
   * This is the hole-aware read, and the one a timeline should use.
   * `getLog()` returns entries and nothing else, so retention that evicted
   * churn from the middle or the end of the range is invisible in it. Built
   * by the same function that builds a subscription's replay, so a one-shot
   * read and a reconnecting subscriber can never disagree about where the
   * holes are.
   */
  getLogEvents(fromSeq?: number): SessionLogEvent[] {
    this.assertNotDestroyed();
    return this.recorder.log.getLogEvents(fromSeq);
  }

  /**
   * Subscribe to log events with replay from a seq, so a reconnecting UI
   * can ask for everything since it last saw. Slow subscribers are
   * buffered to a bound and then dropped with a gap marker rather than
   * applying backpressure to the loops. Returns an idempotent unsubscribe.
   */
  subscribeLog(cb: SessionLogSubscriber, fromSeq?: number): () => void {
    this.assertNotDestroyed();
    return this.recorder.log.subscribeLog(cb, fromSeq);
  }

  // -------------------------------------------------------------------------
  // Composite persistence (v2 artifact)
  // -------------------------------------------------------------------------

  /**
   * Capture the composite state at a consistent point: the log, histories,
   * observational states, and usage are all read in one synchronous frame
   * with the loop gate empty, never mid-run. Resolves once the current run
   * (and any queued gate work) finishes; under continuous activity that is
   * the next quiescence window.
   */
  async getState(): Promise<CortexAgentStateV2> {
    this.assertNotDestroyed();
    for (;;) {
      for (const loop of this.topology.resident) await loop.waitForLoopIdle();
      if (!this.topology.resident.some((loop) => loop.isLoopActive)) {
        return this.composite.capture();
      }
    }
  }

  /**
   * Restore a persisted artifact: v2 composite, v1 single history, or a
   * bare message array (upgraded transparently). Rejected while any loop
   * is running: a restore under a live run would splice history out from
   * under pi's message mirror and desync the observation watermark.
   *
   * Per-loop restore ordering holds internally: history first, then
   * observational state (whose buffer watermark aligns to the post-slot
   * history length). Usage becomes the restored baseline; live counters
   * accumulate as deltas on top, so repeated restores are idempotent, not
   * additive.
   *
   * Async so every rejection is a rejection: the guards below are the
   * documented failure mode, and a synchronous throw next to the async
   * getState() means `await agent.restore(x).catch(...)` catches nothing.
   * The body still applies in one frame (there is no await inside it), so
   * the all-or-nothing property is unchanged.
   */
  async restore(state: CortexAgentPersistedState): Promise<void> {
    this.assertNotDestroyed();
    const { work } = this.topology;
    if (
      this.topology.resident.some((loop) => loop.isLoopActive) ||
      this.prompts.pending ||
      work.getSubAgentManager().activeCount > 0 ||
      this.session.restoreBlocked()
    ) {
      throw new Error(
        'CortexAgent.restore() rejected: a loop is running. Await workSettled before restoring.',
      );
    }
    this.resolution.recordRestore(this.composite.apply(state));
  }

  /**
   * Debounced composite persistence trigger: fires with a consistent
   * getState() snapshot after state-changing activity (log appends, run
   * completions, compaction, observation) settles for stateChangeDebounceMs.
   * This replaces persisting on onLoopComplete, which is ambiguous once
   * multiple loops exist.
   */
  onStateChanged(handler: (state: CortexAgentStateV2) => void): void {
    this.stateEmitter.subscribe(handler);
  }

  // -------------------------------------------------------------------------
  // Settlement predicates
  // -------------------------------------------------------------------------

  /**
   * Whether the conversation surface is quiet: no facade prompt queued or
   * running and the conversation loop's gate empty. Built on gate depth,
   * not the prompting flag, which reads idle while gate tasks are queued.
   * In passthrough the conversation loop is the reasoner; in duplex (2b)
   * this keys on the talker.
   */
  get conversationIdle(): boolean {
    return this.settlement.conversationIdle;
  }

  /**
   * Whether all work has settled: conversation idle, reasoner gate empty,
   * no active sub-agents or quick lookups, no parked wake deliveries on
   * either loop, no router-held deliveries, no pending permission asks.
   * Queued silent deliveries do not count: silent content deliberately
   * waits for the next prompt.
   *
   * The ask term reads the FACADE's merged registry, never the reasoner's
   * own. A broker-minted network ask (shell egress through the sandbox
   * callback, WebFetch) never enters a loop registry at all, so reading the
   * loop's would report settled with a resolver still blocked, which is the
   * one thing this predicate exists to rule out.
   */
  get workSettled(): boolean {
    return this.settlement.workSettled;
  }

  /** Resolve once {@link conversationIdle} holds. */
  async waitForConversationIdle(): Promise<void> {
    return this.settlement.waitForConversationIdle();
  }

  /**
   * Resolve once {@link workSettled} holds. Event-driven where a signal
   * exists (the loop gate, sub-agent completion promises); a single
   * macrotask yield between checks lets completion cascades (a finished
   * child scheduling its delivery drain) reach the gate before the final
   * verdict.
   */
  async waitForWorkSettled(): Promise<void> {
    return this.settlement.waitForWorkSettled();
  }

  // -------------------------------------------------------------------------
  // Composite surface (the topology-determined forwards are LoopSurface's)
  // -------------------------------------------------------------------------

  /**
   * The merged event stream. In passthrough this is the reasoner's bridge
   * verbatim, so event identity and ordering match direct AgentLoop use
   * exactly. In duplex it is the facade's merged bridge: every event
   * carries its loop path in its own loopPath field ('talker', 'reasoner',
   * 'reasoner/task-7'), while childTaskId keeps meaning "this came from a
   * sub-agent" exactly as on a loop's own bridge.
   */
  getEventBridge(): EventBridge {
    return this.session.eventBridge;
  }

  /**
   * The context manager. Passthrough returns the reasoner's manager
   * verbatim. Duplex returns a fan-out view (D6: mid-session slot writes
   * reach both loops so they never diverge; reads come from the reasoner;
   * no per-slot routing knob exists).
   */
  getContextManager(): ContextManager {
    return this.session.contextManager;
  }

  /**
   * The facade's aggregate guard: lifetime scope across both resident loops,
   * every sub-agent, quick lookups, and utility spend, capped by
   * `duplex.maxTotalCost`. This is the guard that stops a duplex session, so
   * a consumer showing "the agent halted on budget" reads `isBreached()`
   * here, not on the per-prompt guard above. Null in passthrough, where no
   * aggregate exists and the reasoner's own guard is the whole story.
   */
  getAggregateBudgetGuard(): BudgetGuard | null {
    return this.session.aggregateBudgetGuard;
  }

  /**
   * Register a skill with every loop that carries skills. The facade
   * registration API (docs/cortex/duplex/sub-agents.md): skills stay
   * per-loop (registry instances are never shared between loops), and this
   * fans the registration out so a consumer never reaches into a specific
   * loop's registry. Today the fan-out set is the reasoner; the talker
   * carries no skills by design (facade-api.md routing table), and any
   * future skill-carrying loop joins here without a consumer-visible
   * change.
   */
  addSkill(config: SkillConfig): void {
    for (const loop of this.skillLoops) {
      loop.getSkillRegistry().addSkill(config);
    }
  }

  /** Remove a skill from every loop that carries skills. */
  removeSkill(name: string): void {
    for (const loop of this.skillLoops) {
      loop.getSkillRegistry().removeSkill(name);
    }
  }

  /** The loops skills fan out to (never the talker). */
  private get skillLoops(): AgentLoop[] {
    return [this.topology.work];
  }

  // Prompt and model surface -----------------------------------------------

  /**
   * Set the consumer base prompt. Duplex appends each loop's role prompt
   * (the consumer supplies one undifferentiated prompt, facade-api.md);
   * the returned composition is the reasoner's, matching passthrough.
   */
  setBasePrompt(basePrompt: string): string {
    return this.session.setBasePrompt(basePrompt);
  }

  /** The consumer's base prompt (role prompts excluded in duplex). */
  getBasePrompt(): string {
    return this.session.getBasePrompt();
  }

  /**
   * Swap the primary (reasoner) model. In duplex an unpinned talker is
   * re-mirrored to the fast tier of the new model, exactly as create()
   * picked it; a pinned `talker.model` stays.
   */
  setModel(model: CortexModel): void {
    this.session.setModel(model);
  }

  /**
   * Set the utility model on every resident loop that can take it
   * (CONFIG_ROUTING utilityModel: per-loop): in duplex the talker takes it
   * only from its own provider, as at assembly.
   */
  setUtilityModel(model: CortexModel): void {
    this.session.setUtilityModel(model);
  }

  /**
   * Set the cache session id. Duplex derives the talker's stable id from
   * the same value (distinct per-loop prefix caches, log-and-context.md);
   * the reasoner keeps the bare id so mode flips keep its cache warm.
   */
  setSessionId(value: string | null): void {
    this.session.setSessionId(value);
  }

  /**
   * Compact now, whatever the context utilization (AgentLoop.compactNow),
   * on every resident loop, with each loop's result. The reasoner runs the
   * full sequence under `options`. In duplex the talker, the
   * latency-critical loop, swaps in only what it has already observed and
   * never waits on the memory model. A running idle digestion yields.
   */
  async compactNow(options?: CompactNowOptions): Promise<CortexCompactNowResult> {
    this.assertNotDestroyed();
    return this.session.compactNow(options);
  }

  /**
   * Accumulated session usage: the composite aggregate across both loops
   * and settled quick lookups (children counted once via each loop's own
   * accounting), under the baseline-plus-delta restore model, so totals
   * survive restores without double-counting.
   */
  getSessionUsage(): SessionUsage {
    return this.composite.totalUsage();
  }

  // Asks and queues ---------------------------------------------------------

  /**
   * Every permission ask currently blocked on a decision, deduplicated by
   * askId: the reasoner's own registry (its asks and its sub-agents') and,
   * in duplex, the broker's (everything routed through the conversation,
   * including network and quick-lookup asks no loop registry sees). `voiced`
   * reports whether the request was ever read out.
   */
  getPendingAsks(): PendingAsk[] {
    return this.session.pendingAsks();
  }

  /**
   * Mark a pending ask as presented to the human. In passthrough the
   * consumer presents asks, so this sets the loop registry's `voiced` flag
   * as AgentLoop.markAskVoiced does. In duplex the session voices every ask
   * itself and owns that fact, so this returns false and changes nothing.
   */
  markAskVoiced(askId: string): boolean {
    return this.session.markAskVoiced(askId);
  }

  /**
   * The network egress decision function this agent actually enforces: in
   * duplex it is the broker-routed wrapper (a consumer `ask` becomes a
   * voiced conversation ask), in passthrough the consumer's own function
   * unchanged, undefined when none was configured. Wire THIS function, not
   * the raw one from config, into the SandboxProvider's ask callback
   * (provider `onNetworkRequest`) with `via: 'shell'`, so shell
   * egress asks flow through the same broker pipeline as WebFetch instead
   * of blocking a loop invisibly.
   */
  getNetworkAccessResolver(): ResolveNetworkAccess | undefined {
    this.resolution.handOutNetworkResolver();
    return this.networkResolver ?? undefined;
  }
}
