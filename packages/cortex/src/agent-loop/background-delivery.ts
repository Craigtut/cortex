/**
 * Delivering finished background work (sub-agents, backgrounded Bash) back
 * to the loop: each completion is queued and a gated drain delivers the
 * queue with a run of its own. Failed runs are unwound and re-attempted
 * within the delivery budget; what the loop gives up on is dead-lettered.
 * A user abort does not cancel background completions. See "Background
 * delivery budgets and dead letters" in docs/cortex/cortex-architecture.md.
 */

import { classifyError, toError } from '../error-classifier.js';
import type { BackgroundTaskStore } from '../tools/runtime.js';
import type { CortexLogger, RetryPolicy, SubAgentResult } from '../types.js';
import { formatBashCompletion, formatSubAgentCompletion } from './background-task-text.js';
import {
  BACKGROUND_DELIVERY_LIMITS,
  boundedPolicyFor,
  partitionExhausted,
} from './delivery-failure.js';
import type { DeadLetterStore } from './delivery-failure.js';
import { HandlerList } from './handler-list.js';
import type { AbortState, LoopGate } from './run-control.js';

/**
 * A finished background task awaiting delivery. A Bash item is read live
 * from the task store at delivery time, so dedup against poll/kill holds.
 */
export type PendingBackgroundCompletion = (
  | { kind: 'subagent'; taskId: string; result: SubAgentResult }
  | { kind: 'bash'; taskId: string }
) & {
  /** Failed delivery attempts so far. */
  deliveryAttempts?: number;
  /** Set when given up on (the capped dead-letter list can evict entries). */
  deadLettered?: boolean;
  /** When the first delivery attempt started (the elapsed budget). */
  firstDeliveryAttemptAt?: number;
  /** Formatted on the first attempt; formatting marks Bash tasks notified, so it runs once. */
  formattedMessage?: string;
  /**
   * Cause tags of the run that started the task. The drain run delivering
   * the completion carries them, so the result is attributed to the work
   * that asked for it rather than to nothing.
   */
  causeTags?: readonly unknown[];
};

export interface BackgroundDeliveryPorts {
  gate: LoopGate;
  abort: AbortState;
  isAborted(): boolean;
  isShuttingDown(): boolean;
  /** Whether a sub-agent was cancelled (its result is discarded, not delivered). */
  isCancelled(taskId: string): boolean;
  /**
   * A drain run: delivers `message` even after an abort, flushing no
   * silent content, and carrying `causeTags` as its causation.
   */
  runDeliveryTurn(message: string, retryPolicy: RetryPolicy, causeTags: unknown[]): Promise<unknown>;
  /** Unwind a failed delivery run (true: the content must be re-queued). */
  unwindFailedDelivery(deliveryContent: string, runAbortEpoch: number): boolean;
  backgroundTasks: Pick<BackgroundTaskStore, 'get'>;
  deadLetters: DeadLetterStore;
  retryPolicy: RetryPolicy;
  emitError(error: Error): void;
  logger: CortexLogger;
}

export class BackgroundDelivery {
  readonly deliveryHandlers: HandlerList<[taskIds: string[]]>;
  /** Completions awaiting delivery (mutated in place; tests hold the array). */
  readonly pending: PendingBackgroundCompletion[] = [];
  /** Causation of the run that backgrounded each Bash task still running. */
  private readonly bashOrigins = new Map<string, readonly unknown[]>();

  constructor(private readonly ports: BackgroundDeliveryPorts) {
    this.deliveryHandlers = new HandlerList('onBackgroundResultDelivery', ports.logger);
  }

  /**
   * Queue a completed background task and schedule a gated drain. A running
   * cycle's own end-of-cycle drain usually delivers it first, leaving the
   * scheduled drain a no-op. Scheduling unconditionally closes the race
   * where a completion lands between that final drain check and the gate
   * release.
   */
  async enqueue(
    item: PendingBackgroundCompletion,
  ): Promise<void> {
    // A cancelled sub-agent can still settle; its result is discarded, not
    // dead-lettered, even mid-teardown.
    if (item.kind === 'subagent' && this.ports.isCancelled(item.taskId)) {
      this.ports.logger.info('dropping result of cancelled subagent', {
        taskId: item.taskId,
      });
      return;
    }
    if (this.ports.isShuttingDown()) {
      this.deadLetter(item, 'agent shut down before delivery');
      return;
    }

    this.pending.push(item);
    await this.schedule();
  }

  /** A run backgrounded a Bash task: its completion carries that run's causation. */
  noteBashStarted(taskId: string, causeTags: readonly unknown[]): void {
    if (causeTags.length > 0) this.bashOrigins.set(taskId, causeTags);
  }

  /** A backgrounded Bash task finished (killed and polled ones too). */
  bashCompleted(taskId: string): Promise<void> {
    const causeTags = this.bashOrigins.get(taskId);
    this.bashOrigins.delete(taskId);
    return this.enqueue({ kind: 'bash', taskId, ...(causeTags ? { causeTags } : {}) });
  }

  /** Enqueue a gated drain. No caller can catch its failure, so it goes to onError. */
  schedule(): Promise<void> {
    return this.ports.gate.enqueue(async () => {
      if (this.ports.isShuttingDown()) return;
      try {
        await this.drain();
      } catch (err) {
        this.ports.emitError(toError(err));
      }
    });
  }

  /**
   * Deliver all pending completions with one combined run. Call while
   * holding the loop gate. Completions already observed (Bash poll/kill)
   * are skipped; with nothing left, no run starts.
   */
  async drain(): Promise<void> {
    if (this.ports.isShuttingDown()) return;
    if (this.pending.length === 0) return;

    const pending = this.pending.splice(0);
    const batch: PendingBackgroundCompletion[] = [];
    const parts: string[] = [];
    const causeTags: unknown[] = [];
    const firstAttemptTaskIds: string[] = [];
    for (const item of pending) {
      if (item.kind === 'subagent' && this.ports.isCancelled(item.taskId)) {
        continue;
      }
      const message = item.formattedMessage ?? this.format(item);
      if (message === null) continue;
      item.formattedMessage = message;
      item.firstDeliveryAttemptAt ??= Date.now();
      batch.push(item);
      parts.push(message);
      causeTags.push(...(item.causeTags ?? []));
      if (!item.deliveryAttempts) firstAttemptTaskIds.push(item.taskId);
    }
    if (batch.length === 0) return;

    const boundedRetryPolicy = boundedPolicyFor(
      this.ports.retryPolicy, batch, BACKGROUND_DELIVERY_LIMITS, Date.now(),
    );

    const message = parts.join('\n\n---\n\n');
    // Once per completion, not again on re-attempts.
    if (firstAttemptTaskIds.length > 0) {
      this.deliveryHandlers.emit(firstAttemptTaskIds);
    }
    const runAbortEpoch = this.ports.abort.epoch;
    let attemptError: Error | null = null;
    let requeuedForRetry = false;
    try {
      await this.ports.runDeliveryTurn(message, boundedRetryPolicy, causeTags);
    } catch (err) {
      // Re-queue only content the unwind removed; content the run
      // progressed past is already history.
      attemptError = toError(err);
      if (this.ports.unwindFailedDelivery(message, runAbortEpoch)) {
        this.requeueOrDeadLetter(batch, err);
        requeuedForRetry = true;
      }
    }

    // Deliver what arrived meanwhile, re-queued items included. Bounded by
    // the attempt cap; a failure here replaces this attempt's error.
    await this.drain();

    if (attemptError !== null) {
      // A later attempt delivered the re-queued batch: recovered, so the
      // failure does not surface.
      if (requeuedForRetry && this.batchRecoveredAfterRequeue(batch)) {
        this.ports.logger.info('background delivery recovered after re-queue', {
          taskIds: batch.map((item) => item.taskId),
          error: attemptError.message,
        });
        return;
      }
      throw attemptError;
    }
  }

  /** Whether a re-queued batch has since left the queue without being dead-lettered. */
  batchRecoveredAfterRequeue(batch: PendingBackgroundCompletion[]): boolean {
    return batch.every(
      (item) => !this.pending.includes(item) && !item.deadLettered,
    );
  }

  /**
   * Put a failed batch back at the front of the queue, dead-lettering items
   * out of attempts or budget, or failed with a fatal error (retrying an
   * auth failure is futile until the consumer acts).
   */
  requeueOrDeadLetter(batch: PendingBackgroundCompletion[], err: unknown): void {
    const error = toError(err);
    const lastError = error.message;
    const classified = classifyError(error, { wasAborted: this.ports.isAborted() });
    const fatal = classified.severity === 'fatal';
    // An abort does not consume an attempt: quick aborts would otherwise
    // dead-letter work that never failed.
    const { retry: requeue, exhausted } = partitionExhausted(
      batch,
      BACKGROUND_DELIVERY_LIMITS,
      Date.now(),
      { countAttempt: classified.category !== 'cancelled', fatal },
    );
    for (const item of exhausted) this.deadLetter(item, lastError);
    this.pending.unshift(...requeue);
  }

  /** Drop a cancelled sub-agent's queued result. */
  purgeSubAgent(taskId: string): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const item = this.pending[i]!;
      if (item.kind === 'subagent' && item.taskId === taskId) this.pending.splice(i, 1);
    }
  }

  /** Teardown: queued drains no-op now, so record what will never be delivered. */
  deadLetterAllPending(reason: string): void {
    this.bashOrigins.clear();
    for (const item of this.pending.splice(0)) {
      this.deadLetter(item, reason);
    }
  }

  /** Record a completion the agent gives up on delivering. */
  private deadLetter(
    item: PendingBackgroundCompletion,
    lastError: string,
  ): void {
    const attempts = item.deliveryAttempts ?? 0;
    item.deadLettered = true;
    this.ports.logger.error('background result dead-lettered', {
      kind: item.kind,
      taskId: item.taskId,
      attempts,
      lastError,
    });
    // Items that never entered a drain are formatted here. Empty only when
    // the source is gone (Bash after runtime teardown).
    const message = item.formattedMessage ?? this.format(item) ?? '';
    this.ports.deadLetters.record({
      kind: item.kind,
      taskId: item.taskId,
      attempts,
      lastError,
      deadLetteredAt: Date.now(),
      message,
    });
  }

  /** The delivery message, or null if nothing is left. Marks Bash tasks notified. */
  private format(item: PendingBackgroundCompletion): string | null {
    if (item.kind === 'subagent') {
      return formatSubAgentCompletion(item.taskId, item.result);
    }
    const task = this.ports.backgroundTasks.get(item.taskId);
    if (!task || !task.completed || task.notified) return null;
    task.notified = true;
    return formatBashCompletion(task);
  }
}
