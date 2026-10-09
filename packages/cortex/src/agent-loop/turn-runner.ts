/**
 * Runs one logical turn: the first agent.prompt attempt plus transparent
 * background retries of transient failures (RetryPolicy), with the
 * turn-scoped state around it: whether a turn is in flight, the run's cause
 * tags, the history boundary the cache breakpoints key on, and the unwind
 * promise abort() waits on.
 *
 * Reference: error-recovery.md, cortex-architecture.md "Loop gate, turn
 * unwind, abort epoch"
 */

import type { AgentMessage } from '../context-manager.js';
import type { BudgetGuard } from '../budget-guard.js';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { classifyError, overflowedSilently, toError } from '../error-classifier.js';
import type { CompactionManager } from '../compaction/index.js';
import type { CortexModel } from '../model-wrapper.js';
import type { PromptWatchdogDiagnostics } from '../prompt-diagnostics.js';
import { isRetryableCategory, retryDelayForAttempt, shouldRetry } from '../retry-policy.js';
import type { CortexToolRuntime } from '../tools/runtime.js';
import type {
  AgentLoopConfig,
  CortexLogger,
  LoopOriginContext,
  RetryExhaustedInfo,
  RetryPolicy,
  RetryScheduledInfo,
  RetrySucceededInfo,
} from '../types.js';
import type { DeliveryQueues, QueuedDelivery } from './delivery-queues.js';
import type { LoopRunInfo, PromptOptions } from './api/run.js';
import { HandlerList } from './handler-list.js';
import type { CacheRetention, PiAgent } from './pi-agent.js';
import type { AbortState } from './run-control.js';
import { sleepUnlessAborted } from './run-control.js';
import { isResumableAfterTrim, trimTrailingFailures } from './transcript-repair.js';

export interface TurnRunnerPorts {
  agent: Pick<PiAgent, 'prompt' | 'continue' | 'state'>;
  config: Pick<AgentLoopConfig, 'persistentRuntime' | 'budgetGuard'>;
  retryPolicy: RetryPolicy;
  abort: AbortState;
  isAborted(): boolean;
  /** First run moves the loop from created to active. */
  activate(): void;
  assertNotShuttingDown(): void;
  emitError(error: Error, wasAborted?: boolean): void;
  cacheRetention(): CacheRetention | null;
  model(): CortexModel;
  queues: Pick<DeliveryQueues, 'takeSilent' | 'takeDeliverableWake' | 'settleSplicedBatch'>;
  toolRuntime: Pick<CortexToolRuntime, 'resetForLoop'>;
  budget: Pick<BudgetGuard, 'reset' | 'getTurnCount' | 'getTotalCost'>;
  diagnostics: Pick<PromptWatchdogDiagnostics, 'startPrompt' | 'finishPrompt'>;
  compaction(): CompactionManager;
  /** Reactive context-overflow handling (emergency truncation). */
  handleOverflow(): void;
  /** Index of the first history message (past the system head and slots). */
  historyStart(): number;
  notifyTailTrimmed(): void;
  pendingBackgroundCount(): number;
  /** Deliver background completions that arrived while the turn ran. */
  drainBackground(): Promise<void>;
  origin: LoopOriginContext;
  logger: CortexLogger;
}

export class TurnRunner {
  readonly retryScheduled: HandlerList<[RetryScheduledInfo, LoopOriginContext]>;
  readonly retrySucceeded: HandlerList<[RetrySucceededInfo, LoopOriginContext]>;
  readonly retryExhausted: HandlerList<[RetryExhaustedInfo, LoopOriginContext]>;

  private prompting = false;
  // The logical run in flight (see LoopRunApi.currentRun).
  private liveRun: { -readonly [K in keyof LoopRunInfo]: LoopRunInfo[K] } | null = null;
  private runCount = 0;
  private lastEndedAt: number | null = null;
  // Cause tags of the run in flight (see DeliverOptions.causeTag).
  private activeTags: readonly unknown[] = [];
  private activeRetention: CacheRetention | null = null;
  // Messages before the current prompt: stable, cacheable history versus
  // new tick content. Compaction moves it mid-run.
  private boundaryIndex = 0;
  // abort() awaits the turn's unwind so its controller reset never lands
  // before the cancelled turn's error classification observes the abort.
  private unwoundPromise: Promise<void> = Promise.resolve();
  private resolveUnwound: (() => void) | null = null;

  constructor(private readonly ports: TurnRunnerPorts) {
    this.retryScheduled = new HandlerList('onRetryScheduled', ports.logger);
    this.retrySucceeded = new HandlerList('onRetrySucceeded', ports.logger);
    this.retryExhausted = new HandlerList('onRetryExhausted', ports.logger);
  }

  get isPrompting(): boolean {
    return this.prompting;
  }

  get currentRun(): LoopRunInfo | null {
    return this.liveRun ? { ...this.liveRun } : null;
  }

  get lastRunEndedAt(): number | null {
    return this.lastEndedAt;
  }

  get activeCauseTags(): readonly unknown[] {
    return this.activeTags;
  }

  get activeCacheRetention(): CacheRetention | null {
    return this.activeRetention;
  }

  get boundary(): number {
    return this.boundaryIndex;
  }

  set boundary(value: number) {
    this.boundaryIndex = value;
  }

  /** The current turn's unwind (captured by abort() before it aborts). */
  get unwound(): Promise<void> {
    return this.unwoundPromise;
  }

  /** Content steered into the run in flight carries its causation too. */
  appendActiveCauseTags(tags: unknown[]): void {
    this.activeTags = [...this.activeTags, ...tags];
  }

  /**
   * One gate-owned loop cycle: run the logical turn, then deliver any
   * background completions that arrived while it ran. Lifecycle is
   * re-checked at dequeue so a destroy() after enqueue never starts a loop.
   */
  async runCycle(input: string, options?: PromptOptions): Promise<unknown> {
    this.ports.assertNotShuttingDown();
    try {
      return await this.run(input, options);
    } finally {
      // Still under the same gate acquisition, before the consumer's await
      // resolves. A terminal delivery failure surfaces through onError once,
      // never by rejecting or replacing the consumer turn's own outcome.
      try {
        await this.ports.drainBackground();
      } catch (err) {
        this.ports.emitError(toError(err));
      }
    }
  }

  /**
   * Run one logical prompt turn. Must be called while holding the loop gate;
   * all mutation of shared loop state happens here.
   *
   * @param fromDrain - Background delivery path: starts a fresh loop even
   *   after an abort, where a consumer turn aborted before dequeue cancels.
   * @param retryPolicyOverride - The drain's policy, capped at its remaining
   *   delivery budget.
   * @param causeTags - Tags for content a drain-started run carries itself.
   *   A consumer run's input carries its own in `options.causeTag`.
   */
  async run(
    input: string,
    options?: PromptOptions,
    fromDrain = false,
    retryPolicyOverride?: RetryPolicy,
    causeTags?: unknown[],
  ): Promise<unknown> {
    this.ports.activate();

    // prompt() installs a fresh controller synchronously, so an aborted one
    // here means abort() landed between enqueue and dequeue.
    if (this.ports.abort.signal.aborted) {
      if (fromDrain) {
        this.ports.abort.renewIfAborted();
      } else {
        const abortErr = new Error('Prompt aborted before it started');
        abortErr.name = 'AbortError';
        this.ports.emitError(abortErr, true);
        throw abortErr;
      }
    }

    const effectiveRetention = options?.cacheRetention ?? this.ports.cacheRetention();
    this.activeRetention = effectiveRetention ?? null;

    // Silent and parked wake deliveries ride ahead of the prompt in one
    // batch. Taken after the abort check (a pre-start cancel leaves them
    // queued) and synchronously with the run start, so a later sweep finds
    // nothing to re-deliver. Drain-started runs take neither: their failure
    // unwind counts from the pre-delivery boundary.
    const silentBatch = fromDrain ? [] : this.ports.queues.takeSilent();
    const wakeBatch = fromDrain ? [] : this.ports.queues.takeDeliverableWake();

    // Assigned as the first statement of the try below, so the clearing
    // finally pairs with the set by construction: a throwing logger before
    // the try cannot leave a dead run's tags live.
    const runCauseTags: readonly unknown[] = [
      ...(causeTags ?? []),
      ...wakeBatch.map((item) => item.causeTag).filter((tag) => tag !== undefined),
      ...(options?.causeTag !== undefined ? [options.causeTag] : []),
    ];

    // Long-lived mode keeps workspace state (cwd, read registry, undo).
    this.ports.toolRuntime.resetForLoop(
      this.ports.config.persistentRuntime ? { preserveWorkspaceState: true } : undefined,
    );
    // Reset once per prompt, not on loop_start (which pi emits again for
    // every retry continuation). A lifetime scope never resets.
    if ((this.ports.config.budgetGuard?.scope ?? 'prompt') === 'prompt') {
      this.ports.budget.reset();
    }
    this.prompting = true;
    const loopStartMs = Date.now();
    this.runCount += 1;
    this.liveRun = { id: this.runCount, startedAt: loopStartMs, attempt: 0, attemptStartedAt: null };

    this.boundaryIndex = this.ports.agent.state.messages.length;

    this.ports.logger.debug('loop start', {
      messageCount: this.boundaryIndex,
      inputLength: input.length,
    });

    this.ports.diagnostics.startPrompt({
      inputLength: input.length,
      messageCount: this.boundaryIndex,
      provider: this.ports.model().provider,
      modelId: this.ports.model().modelId,
    });

    // Created immediately before the try so the finally always resolves it;
    // abort() awaits it and must never hang.
    this.unwoundPromise = new Promise<void>((resolve) => {
      this.resolveUnwound = resolve;
    });

    let promptStatus: 'resolved' | 'rejected' | 'cancelled' = 'resolved';
    try {
      this.activeTags = runCauseTags;
      const result = await this.runWithRetry(
        input, fromDrain, retryPolicyOverride, silentBatch, wakeBatch,
      );
      // An abort can end the run without a throw; its spliced content was
      // no more answered than on the throwing path.
      if (this.ports.isAborted()) {
        this.ports.queues.settleSplicedBatch(wakeBatch, silentBatch.length, null, true);
      }
      return result;
    } catch (err) {
      const error = toError(err);
      promptStatus = this.ports.isAborted() ? 'cancelled' : 'rejected';
      // Parked content must end in a run that answers it: a failed prompt
      // re-parks its wake batch, and an aborted one cancels it.
      this.ports.queues.settleSplicedBatch(
        wakeBatch, silentBatch.length, error, promptStatus === 'cancelled',
      );
      throw error;
    } finally {
      this.activeRetention = null;
      this.prompting = false;
      this.liveRun = null;
      this.lastEndedAt = Date.now();
      this.activeTags = [];

      this.ports.logger.debug('loop complete', {
        durationMs: Date.now() - loopStartMs,
        turns: this.ports.budget.getTurnCount(),
        totalCost: this.ports.budget.getTotalCost(),
        currentContextTokens: this.ports.compaction().currentContextTokenCount,
      });

      this.ports.diagnostics.finishPrompt({
        status: promptStatus,
        durationMs: Date.now() - loopStartMs,
        turns: this.ports.budget.getTurnCount(),
        totalCost: this.ports.budget.getTotalCost(),
        currentContextTokens: this.ports.compaction().currentContextTokenCount,
        pendingBackgroundResults: this.ports.pendingBackgroundCount(),
      });

      this.resolveUnwound?.();
      this.resolveUnwound = null;
    }
  }

  /**
   * The first attempt uses `agent.prompt(input)`. Each retry resumes with
   * `agent.continue()` after trimming pi's synthetic failure message, so
   * completed tool calls do not re-run and the user message is never
   * duplicated. The promise stays pending across backoff; an abort during a
   * wait cancels it. A non-retryable or exhausted failure emits onError and
   * throws.
   *
   * @param fromDrain - Defers onError (and onRetryExhausted) to the drain
   *   chain root, which re-queues a failed delivery: a later success surfaces
   *   no error, and a terminal failure surfaces exactly once.
   */
  private async runWithRetry(
    input: string,
    fromDrain = false,
    retryPolicyOverride?: RetryPolicy,
    silentBatch: QueuedDelivery[] = [],
    wakeBatch: QueuedDelivery[] = [],
  ): Promise<unknown> {
    const policy = retryPolicyOverride ?? this.ports.retryPolicy;
    let retryIndex = 0;
    let firstFailureAt: number | undefined;

    // pi pushes the whole batch into the transcript at run start, so retries
    // (continue()) see it without re-sending.
    const leadingBatch = [...wakeBatch, ...silentBatch];
    const promptInput: string | AgentMessage[] = leadingBatch.length > 0
      ? [
          ...leadingBatch.map((item): AgentMessage => ({
            role: 'user',
            content: item.content,
            timestamp: item.timestamp,
          })),
          { role: 'user', content: input, timestamp: Date.now() },
        ]
      : input;

    for (;;) {
      try {
        const result = await this.attempt(
          () => (retryIndex === 0 ? this.ports.agent.prompt(promptInput) : this.ports.agent.continue()),
        );

        // pi stores streaming/provider errors in state.errorMessage without
        // re-throwing.
        const agentState = this.ports.agent.state as Record<string, unknown>;
        const stateError = agentState['errorMessage'] ?? agentState['error'];
        if (stateError) {
          throw new Error(String(stateError));
        }

        // An abort can end the run cleanly (stopReason 'aborted'). Trim the
        // stub so a later turn does not rewrite it to "(no output)".
        if (this.ports.isAborted()) {
          this.trimFailureStubs();
        }

        // A provider that truncates an oversized request instead of
        // rejecting it answers anyway; the next request would overflow too.
        const answer = this.lastAssistantMessage();
        if (answer && overflowedSilently(answer, this.ports.model().contextWindow)) {
          this.ports.handleOverflow();
        }

        if (retryIndex > 0) {
          this.retrySucceeded.emit({ attempts: retryIndex }, this.ports.origin);
        }
        return result;
      } catch (err) {
        const error = toError(err);
        const aborted = this.ports.isAborted();
        const failure = this.lastAssistantMessage();
        const classified = classifyError(error, {
          wasAborted: aborted,
          contextWindow: this.ports.model().contextWindow,
          ...(failure?.stopReason === 'error' ? { assistantMessage: failure } : {}),
        });

        if (classified.category === 'context_overflow') {
          this.ports.handleOverflow();
        }

        if (firstFailureAt === undefined) firstFailureAt = Date.now();
        const elapsedMs = Date.now() - firstFailureAt;

        // continue() rejects a transcript ending in a dangling assistant turn.
        const policyAllowsRetry = shouldRetry(
          classified,
          { retryIndex, elapsedMs, aborted },
          policy,
        );
        const willRetry = policyAllowsRetry && this.resumableAfterTrim();

        if (!willRetry) {
          // "Gave up" only when a transient retry budget genuinely ran out,
          // and never for a drain delivery (its chain root dead-letters).
          if (
            !fromDrain &&
            retryIndex > 0 &&
            !aborted &&
            !policyAllowsRetry &&
            isRetryableCategory(classified.category, policy)
          ) {
            this.retryExhausted.emit({ attempts: retryIndex, category: classified.category }, this.ports.origin);
          }
          // A cancellation is not a failure to keep. Non-abort failures keep
          // their stub.
          if (aborted) {
            this.trimFailureStubs();
          }
          if (!fromDrain) {
            this.ports.emitError(error, aborted);
          }
          throw error;
        }

        const delayMs = retryDelayForAttempt(policy, retryIndex, classified);
        const attemptNumber = retryIndex + 1;
        const scheduled: RetryScheduledInfo = {
          category: classified.category,
          attempt: attemptNumber,
          maxAttempts: policy.maxAttempts,
          delayMs,
          nextAttemptAt: Date.now() + delayMs,
          originalMessage: classified.originalMessage,
        };
        if (classified.causeDetail !== undefined) {
          scheduled.causeDetail = classified.causeDetail;
        }
        this.retryScheduled.emit(scheduled, this.ports.origin);
        this.ports.logger.warn('scheduling background retry', {
          category: classified.category,
          attempt: attemptNumber,
          maxAttempts: policy.maxAttempts,
          delayMs,
        });

        const completed = await sleepUnlessAborted(delayMs, this.ports.abort.signal);
        if (!completed) {
          // A fresh AbortError, so the consumer sees a cancellation rather
          // than the stale transient failure.
          this.trimFailureStubs();
          if (!fromDrain) {
            this.ports.emitError(error, true);
          }
          const abortErr = new Error('Prompt aborted during retry backoff');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        this.trimFailureStubs();
        retryIndex += 1;
      }
    }
  }

  /** One pi attempt of the live run, recorded on it while it runs. */
  private async attempt<T>(call: () => Promise<T>): Promise<T> {
    if (this.liveRun) {
      this.liveRun.attempt += 1;
      this.liveRun.attemptStartedAt = Date.now();
    }
    try {
      return await call();
    } finally {
      if (this.liveRun) this.liveRun.attemptStartedAt = null;
    }
  }

  /** The transcript's last message when it is a response: the run's answer or pi's failure record. */
  private lastAssistantMessage(): AssistantMessage | undefined {
    const last = this.ports.agent.state.messages.at(-1) as { role?: string } | undefined;
    return last?.role === 'assistant' ? (last as AssistantMessage) : undefined;
  }

  /** Whether trimming the failure stubs leaves a transcript continue() can resume. */
  private resumableAfterTrim(): boolean {
    return isResumableAfterTrim(this.ports.agent.state.messages, this.ports.historyStart());
  }

  /** Remove trailing synthetic failure messages so continue() can resume. */
  private trimFailureStubs(): void {
    if (trimTrailingFailures(this.ports.agent.state.messages)) {
      this.ports.notifyTailTrimmed();
    }
  }
}
