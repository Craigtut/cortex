/**
 * DuplexSession: a fast talker loop fronting the persistent reasoner
 * (docs/cortex/duplex/architecture.md), as the facade's SessionMode. The
 * parts it is made of, and the ordered wiring between them and the loops,
 * are session-parts.ts; this is what the facade's surface means in duplex.
 */

import type { AgentLoop, DeliverResult, DirectCompletionOptions } from '../agent-loop.js';
import type { McpClientManager } from '../mcp-client.js';
import type { CortexLogger, PendingAsk, SessionUsage } from '../types.js';
import type { CortexModel } from '../model-wrapper.js';
import type { ContextManager } from '../context-manager.js';
import type { CompactNowOptions } from '../compaction/index.js';
import type { BudgetGuard } from '../budget-guard.js';
import type { EventBridge } from '../event-bridge.js';
import type { LogRecorder } from '../facade/log-recorder.js';
import {
  gateTerm,
  loopAsksTerm,
  parkedWakesTerm,
  subAgentsTerm,
  yieldMacrotask,
} from '../facade/settlement.js';
import type { SettlementTerm } from '../facade/settlement.js';
import type { ResolvedCortexAgentConfig } from '../facade/config.js';
import { requeueSilent } from '../facade/composite-state.js';
import type {
  CortexAbortScope,
  CortexCompactNowResult,
  CortexDeliverOptions,
  FacadeServices,
  RestoredSessionParts,
  SessionMode,
  SessionStateParts,
} from '../facade/session-mode.js';
import { collectCauseTags } from './cause-tags.js';
import type { CausationSource } from './cause-tags.js';
import type { DuplexRouter } from './router.js';
import type { DuplexRouterState } from './router-contract.js';
import type { PermissionBroker } from './permission-broker.js';
import { FanOutContextManager } from './fanout-context-manager.js';
import { highestTaskAlias } from './delegations.js';
import { appendRolePrompt, TALKER_SESSION_ID_SUFFIX } from './assembly.js';
import { REASONER_ROLE_PROMPT, TALKER_ROLE_PROMPT } from './prompts.js';
import { assembleSessionParts } from './session-parts.js';
import type { DuplexParts } from './session-parts.js';

export class DuplexSession implements SessionMode {
  readonly reasoner: AgentLoop;
  readonly talker: AgentLoop;
  readonly router: DuplexRouter;
  /** The consent boundary for every permission ask in the session (D16). */
  readonly broker: PermissionBroker;
  /**
   * Causation read off the loops' live runs, never off session fields: the
   * tags travel with the content, so a barge-in parked behind a live run
   * keeps its utterance seq through the sweep run (B1).
   */
  readonly causation: CausationSource;
  private readonly parts: DuplexParts;
  private readonly services: FacadeServices;
  private readonly recorder: LogRecorder;
  private readonly logger: CortexLogger;
  /**
   * The facade-minted shared MCP manager: loops sharing it never close it,
   * so the session does at destroy. Null when the consumer supplied their
   * own manager (their lifecycle, not ours).
   */
  private ownedMcpManager: McpClientManager | null = null;
  /**
   * Whether the consumer pinned `talker.model`. An unpinned talker mirrors
   * the reasoner's auto-resolved fast tier, at assembly and again on every
   * facade setModel(); a pinned one keeps the consumer's choice.
   */
  private readonly talkerModelPinned: boolean;
  /** The consumer's base prompt without the appended role prompts. */
  private consumerBasePrompt: string | null;
  /** Lazily-built D6 fan-out view over both loops' context managers. */
  private fanOutContextManager: FanOutContextManager | null = null;

  constructor(
    reasoner: AgentLoop,
    talker: AgentLoop,
    config: ResolvedCortexAgentConfig,
    services: FacadeServices,
  ) {
    this.reasoner = reasoner;
    this.talker = talker;
    this.services = services;
    this.recorder = services.recorder;
    this.logger = services.logger;
    this.talkerModelPinned = config.talker?.model !== undefined;
    this.consumerBasePrompt = config.initialBasePrompt ?? null;
    this.causation = {
      tags: (surface) =>
        collectCauseTags((surface === 'conversation' ? talker : reasoner).activeRunCauseTags),
    };
    this.parts = assembleSessionParts({ reasoner, talker }, config, services, this.causation);
    this.router = this.parts.router;
    this.broker = this.parts.broker;
  }

  /** Adopt the facade-minted MCP manager this session must close. */
  adoptMcpManager(manager: McpClientManager): void {
    this.ownedMcpManager = manager;
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  prompt(input: string, options?: DirectCompletionOptions): Promise<unknown> {
    return this.parts.input.prompt(input, options);
  }

  deliver(content: string, options?: CortexDeliverOptions): DeliverResult {
    return this.parts.input.deliver(content, options);
  }

  steer(message: string): void {
    this.parts.input.steer(message);
  }

  /**
   * Abort per the facade-api.md abort table: each scope aborts its loop's
   * in-flight turn, drops queued deliveries to that target, and clears its
   * pi queues; router-held deliveries are dropped but stay in the log
   * (retained, not delivered). Pending asks resolve as deny through the
   * abort race on the aborted loop.
   */
  async abort(scope: CortexAbortScope): Promise<void> {
    const { talker, reasoner, router } = this;
    const work: Array<Promise<unknown>> = [];
    if (scope === 'conversation' || scope === 'all') {
      router.dropPendingDeliveries();
      this.recorder.recordDroppedQueue(talker, 'abort', talker.clearAllQueues());
      // Everything parked is gone, voicings included.
      this.broker.noteParkedCleared();
      work.push(talker.abort());
      // Quick lookups belong to the conversation surface (abort table):
      // cancelled here, untouched by a 'work' abort.
      work.push(this.parts.lookups.cancelAll());
    }
    if (scope === 'work' || scope === 'all') {
      router.dropWorkContext();
      // Held deliveries are results of the work being stopped: per the
      // abort table they are retained in the log, not delivered, for
      // every scope. Without this a completed-but-undelivered when_idle
      // result from the stopped work would degrade and still be voiced.
      router.dropPendingDeliveries();
      this.recorder.recordDroppedQueue(reasoner, 'abort', reasoner.clearAllQueues());
      this.parts.outcomes.expectAbort('user');
      work.push(reasoner.abort());
      for (const taskId of reasoner.getSubAgentManager().getActiveTaskIds()) {
        work.push(reasoner.cancelSubAgent(taskId));
      }
      // All work is stopped, parked dispatches included, so no task may
      // go on being described as in progress. The user asked for this
      // and it was acknowledged on the conversation surface: retired
      // quietly, never announced back.
      router.retireAllDelegations();
      // Pending asks belong to the stopped work and settle as deny: tool
      // asks through each aborted run's own signal race, network asks
      // (which carry no signal) here. Double settlement is guarded.
      this.broker.settleAll('abort');
      // Settling an ask kills the request; it does not kill the voicing
      // that was already handed to the talker. A voicing parked behind a
      // busy talker outlives its ask, gets read out afterwards, and the
      // user's answer then lands in an empty registry and is told there
      // is nothing pending. Retract the voicings with their asks.
      this.broker.retractParkedVoicings('abort');
    }
    try {
      await Promise.all(work);
    } finally {
      this.parts.outcomes.abortUnwound('user');
    }
    // The user said stop, so a request whose voicing went with the
    // talker's queues is held silent rather than read straight back out.
    if (scope === 'conversation') {
      this.broker.holdVoicing();
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Every permission ask currently blocked on a decision, from both
   * registries, deduplicated by askId. The reasoner's holds its own and its
   * sub-agents' (children mirror in through the child resolver wrapper); the
   * broker's holds everything routed through the conversation. They overlap
   * for reasoner tool asks, and each holds asks the other never sees: a
   * quick lookup is a facade-owned peer on the conversation side (D13), not
   * in the reasoner's subtree, so its asks reach the broker alone.
   */
  pendingAsks(): PendingAsk[] {
    // Whether the user was ever read an ask the broker holds is the broker's
    // fact alone (markAskVoiced below refuses to write the loop registry's
    // flag in duplex), so it replaces the registry's value, never merges.
    const brokered = new Map(this.broker.getPendingAsks().map((ask) => [ask.askId, ask.voiced]));
    const asks = this.reasoner.getPendingAsks().map((ask) => {
      const voiced = brokered.get(ask.askId);
      return voiced === undefined ? ask : { ...ask, voiced };
    });
    const mirrored = new Set(asks.map((ask) => ask.askId));
    const brokerOnly = this.broker.getPendingAsks()
      .filter((ask) => !mirrored.has(ask.askId))
      .map(({ kind: _kind, ...ask }) => ask);
    return [...asks, ...brokerOnly];
  }

  /**
   * Refused: in duplex the session voices every ask itself (the broker, D16),
   * and a second writer of "the user heard it" would let the consumer surface
   * report a request as heard that the broker never read out.
   */
  markAskVoiced(_askId: string): boolean {
    return false;
  }

  settlementTerms(prompts: SettlementTerm): { conversation: SettlementTerm[]; work: SettlementTerm[] } {
    const { talker, reasoner, router, broker } = this;
    const { lookups } = this.parts;
    return {
      conversation: [prompts, gateTerm(talker)],
      work: [
        prompts,
        gateTerm(reasoner),
        gateTerm(talker),
        // Held wake deliveries start talker runs when they land; wait
        // event-driven on the router rather than spinning.
        {
          name: 'router-deliveries',
          pending: () => router.pendingDeliveryCount > 0,
          settled: () => router.waitForDeliveriesSettled(),
        },
        subAgentsTerm(reasoner),
        // Active quick lookups: their settlement enqueues router deliveries
        // and talker wakes, so the wait re-checks everything afterwards.
        {
          name: 'quick-lookups',
          pending: () => lookups.activeCount > 0,
          settled: async () => {
            await lookups.waitForIdle();
            await yieldMacrotask();
          },
        },
        // Pending asks block on a settlement signal, never on a polling
        // yield: an ask can outlive the child that raised it, and a
        // setImmediate spin would otherwise run hot for as long as it stays
        // unanswered. Two registries, each with its own signal: the
        // reasoner's (its own and its sub-agents' asks) and the broker's,
        // which alone holds network and quick-lookup asks.
        loopAsksTerm(reasoner),
        {
          name: 'broker-asks',
          pending: () => broker.pendingAskCount > 0,
          settled: () => broker.waitForSettlement(),
        },
        parkedWakesTerm(reasoner),
        parkedWakesTerm(talker),
      ],
    };
  }

  /** Quick lookups in flight: a restore refuses to run under them. */
  restoreBlocked(): boolean {
    return this.parts.lookups.activeCount > 0;
  }

  /** Settled quick-lookup spend, for the usage ledger. */
  lookupUsage(): SessionUsage {
    return this.parts.lookups.getSettledUsage();
  }

  /**
   * The merged event stream: every event carries its loop path in its own
   * loopPath field ('talker', 'reasoner', 'reasoner/task-7'), while
   * childTaskId keeps meaning "this came from a sub-agent".
   */
  get eventBridge(): EventBridge {
    return this.parts.merged.bridge;
  }

  /**
   * A fan-out view over both loops' context managers (D6: mid-session slot
   * writes reach both loops so they never diverge; reads come from the
   * reasoner; no per-slot routing knob exists).
   */
  get contextManager(): ContextManager {
    this.fanOutContextManager ??= new FanOutContextManager(
      this.reasoner.getContextManager(),
      this.talker.getContextManager(),
    );
    return this.fanOutContextManager;
  }

  get aggregateBudgetGuard(): BudgetGuard {
    return this.parts.aggregate.guard;
  }

  // -------------------------------------------------------------------------
  // Composite setters
  // -------------------------------------------------------------------------

  /**
   * Each loop gets the consumer base prompt with its own role prompt
   * appended (the consumer supplies one undifferentiated prompt,
   * facade-api.md); the returned composition is the reasoner's.
   */
  setBasePrompt(basePrompt: string): string {
    this.consumerBasePrompt = basePrompt;
    const talkerPrompt = appendRolePrompt(basePrompt, TALKER_ROLE_PROMPT);
    this.talker.setBasePrompt(talkerPrompt ?? basePrompt);
    const reasonerPrompt = appendRolePrompt(basePrompt, REASONER_ROLE_PROMPT);
    return this.reasoner.setBasePrompt(reasonerPrompt ?? basePrompt);
  }

  /** The consumer's base prompt, role prompts excluded. */
  getBasePrompt(): string {
    return this.consumerBasePrompt ?? '';
  }

  /**
   * Swap the primary (reasoner) model. An unpinned talker is re-mirrored to
   * the fast tier of the new model, exactly as create() picked it; without
   * that a provider switch would leave the presence loop (and every quick
   * lookup, which builds from the talker's model) on the old provider. A
   * pinned `talker.model` is the consumer's choice and stays.
   */
  setModel(model: CortexModel): void {
    this.reasoner.setModel(model);
    if (!this.talkerModelPinned) this.talker.setModel(this.reasoner.getAutoResolvedUtilityModel());
    // Pinned or not, the reasoner's model changed, and its concurrency is
    // one of the model notes.
    this.services.refreshModelNotes();
  }

  /**
   * Set the utility model on both loops under the same rule assembly
   * applies: the talker takes it when it shares the talker's provider and
   * skips it otherwise, because a loop rejects a utility model from another
   * provider. The talker's primary model is not affected.
   */
  setUtilityModel(model: CortexModel): void {
    this.reasoner.setUtilityModel(model);
    if (model.provider === this.talker.getModel().provider) {
      this.talker.setUtilityModel(model);
    } else {
      this.logger.warn('talker keeps its own utility model: the new one is from another provider', {
        utilityProvider: model.provider,
        talkerProvider: this.talker.getModel().provider,
      });
    }
  }

  /**
   * The talker's stable cache id derives from the same value (distinct
   * per-loop prefix caches, log-and-context.md); the reasoner keeps the
   * bare id so mode flips keep its cache warm.
   */
  setSessionId(value: string | null): void {
    this.reasoner.setSessionId(value);
    this.talker.setSessionId(value === null ? null : `${value}${TALKER_SESSION_ID_SUFFIX}`);
  }

  /**
   * Both loops compact, since a consumer never sees the split. The reasoner
   * runs the full compactNow. The talker is the latency-critical loop: it
   * swaps in what it has already observed and never waits on an observer
   * call. An idle digestion pass holding either gate yields first.
   */
  async compactNow(options?: CompactNowOptions): Promise<CortexCompactNowResult> {
    this.parts.digestion.preempt();
    const [reasoner, talker] = await Promise.all([
      this.reasoner.compactNow(options),
      this.talker.compactNow({ ...(options?.signal ? { signal: options.signal } : {}), observe: false }),
    ]);
    return { reasoner, talker };
  }

  // -------------------------------------------------------------------------
  // Persistence and teardown
  // -------------------------------------------------------------------------

  /** The talker side and router state of the persisted artifact. */
  captureState(): SessionStateParts {
    return {
      talkerHistory: this.talker.getConversationHistory(),
      talkerMemory: this.talker.getObservationalMemoryState(),
      router: this.router.exportState(),
      talkerQueuedDeliveries: this.talker.getQueuedDeliveries(),
    };
  }

  /** Hydrate the talker from a restored artifact (history before memory). */
  hydrate(parts: SessionStateParts): void {
    this.talker.restoreConversationHistory(parts.talkerHistory);
    if (parts.talkerMemory) {
      this.talker.restoreObservationalMemoryState(parts.talkerMemory);
    }
  }

  /**
   * Everything the session holds describes the replaced session: queued
   * talker content, router state (delegations, deltas, held deliveries,
   * dedup), the aggregate spend, the repair streak, and the voicings of
   * asks the router reset has already settled. What the artifact carries of
   * the talker's queue and the router's state comes back, queue first: those
   * deliveries reached the talker before anything the router still held.
   */
  resetForRestore(restored: RestoredSessionParts): void {
    this.recorder.recordDroppedQueue(this.talker, 'restore', this.talker.clearAllQueues());
    // Pending asks belong to the replaced session; every resolver settles
    // as deny so no loop stays blocked on an ask nobody can answer anymore.
    this.broker.reset();
    this.router.resetForRestore();
    requeueSilent(this.talker, restored.talkerQueuedDeliveries, this.recorder);
    this.restoreRouterState(restored.router);
    this.parts.aggregate.resetForRestore();
    this.parts.guards.resetForRestore();
  }

  /**
   * Re-apply the artifact's router state. Tasks that were still outstanding
   * lost the run serving them, so they are reported as interrupted instead
   * of left listed as live work: a lifecycle entry each, and one silent
   * note for the talker, which surfaces with the user's next turn rather
   * than waking the conversation on restore.
   */
  private restoreRouterState(state: DuplexRouterState | undefined): void {
    const router = this.router;
    const logAliases = this.recorder.log.getLog()
      .filter((entry) => entry.type === 'directive')
      .map((entry) => (entry.data as { alias?: unknown } | undefined)?.alias);
    const interrupted = router.restoreState(state, highestTaskAlias(logAliases));
    if (interrupted.length === 0) return;
    for (const delegation of interrupted) {
      this.recorder.append({
        type: 'lifecycle',
        loopPath: this.reasoner.loopPath,
        content: `Task ${delegation.alias} interrupted by the session restore`,
        data: { event: 'delegation_interrupted', alias: delegation.alias },
        causedBy: delegation.seq,
      });
    }
    const list = interrupted
      .map((delegation) => `${delegation.alias} (${delegation.instructions})`)
      .join(', ');
    this.parts.outcomes.notify(
      `The session was restored. Background work that was in progress is no longer running: ${list}. ` +
      'If the user asks about it, say it was interrupted and offer to start it again.',
      'silent',
      { synthetic: true },
    );
  }

  /** Stop the session's timers and settle its asks, synchronously. */
  beginDestroy(): void {
    this.parts.digestion.destroy();
    this.parts.watchdog.destroy();
    // Settle every pending ask first so no resolver promise outlives the
    // session: a hanging ask would block its loop into the force-kill path.
    this.broker.destroy();
    this.router.destroy();
    this.parts.aggregate.destroy();
  }

  /** The teardowns that run alongside the loops' own. */
  teardowns(): Array<Promise<void>> {
    return [this.parts.lookups.destroy()];
  }

  /**
   * After the loops detach their listeners: the shared connections (and
   * stdio subprocesses) are facade-owned, so the loops never close them.
   */
  async closeOwnedResources(): Promise<void> {
    if (this.ownedMcpManager) {
      await this.ownedMcpManager.closeAll().catch(() => {});
    }
  }

  /** Last: nothing forwards events after teardown. */
  finishDestroy(): void {
    this.parts.merged.destroy();
  }
}
