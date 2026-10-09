/**
 * The loop-owned delivery queues behind deliver(), plus the public
 * steer/follow-up paths onto pi's own queues. Design: "Delivery and
 * Steering" in docs/cortex/cortex-architecture.md.
 *
 * Content never waits in pi's steering queue, which cannot be inspected or
 * selectively drained and surfaces whatever it holds at the next poll.
 * Parked wake content is spliced into the next real prompt's batch or
 * delivered by a sweep run; splicing clears the queue, so exactly one run
 * receives each delivery.
 */

import type { AgentMessage } from '../context-manager.js';
import { classifyError, errorMessageOf, toError } from '../error-classifier.js';
import { payloadOf } from '../event-bridge.js';
import type { CortexEvent } from '../event-bridge.js';
import type { CortexLogger, RetryPolicy } from '../types.js';
import {
  boundedPolicyFor,
  partitionExhausted,
  WAKE_DELIVERY_LIMITS,
} from './delivery-failure.js';
import type { DeadLetterStore } from './delivery-failure.js';
import type { DirectCompletionOptions } from './direct-completion.js';
import type { PiAgent, QueueDrainMode } from './pi-agent.js';
import type { AbortState, LoopGate } from './run-control.js';
import { unwindFailedDelivery, unwindSplicedBatch } from './transcript-repair.js';
import type { DeliverOptions, DeliverResult, PendingWakeDelivery } from './api/delivery.js';

/** A delivery held on a loop-owned queue until a run consumes it. */
export interface QueuedDelivery {
  /** The delivery's handle (DeliverResult.deliveryId). */
  id: string;
  content: string;
  timestamp: number;
  /** Failed delivery-run attempts so far (wake parking only). */
  deliveryAttempts?: number;
  /** When the first delivery run for this item started (the elapsed budget). */
  firstDeliveryAttemptAt?: number;
  /** The abort epoch when this item parked; a stale epoch means abort() cancelled it. */
  abortEpoch?: number;
  /** Causation tag riding with the content (see DeliverOptions.causeTag). */
  causeTag?: unknown;
  /** A live run may take it at its next turn boundary (see DeliverOptions). */
  atTurnBoundary?: boolean;
}

export interface DeliveryQueuePorts {
  gate: LoopGate;
  abort: AbortState;
  isAborted(): boolean;
  isShuttingDown(): boolean;
  assertNotShuttingDown(): void;
  hasSystemPrompt(): boolean;
  /** Whether a logical turn is in flight. */
  isPrompting(): boolean;
  budgetBreached(): boolean;
  /** The loop's prompt(), carrying the delivery's cause tag into its run. */
  startPrompt(content: string, options: DirectCompletionOptions | undefined, causeTag: unknown): Promise<unknown>;
  /** A drain-style run (no silent flush) carrying `causeTags`. */
  runDeliveryTurn(message: string, retryPolicy: RetryPolicy, causeTags: unknown[]): Promise<unknown>;
  /** Add causation to the run in flight (content steered into it). */
  appendActiveCauseTags(tags: unknown[]): void;
  transcript: {
    messages(): AgentMessage[];
    /** Where this run's leading batch starts (live: compaction moves it). */
    boundary(): number;
    notifyTailTrimmed(): void;
  };
  piQueues: Pick<
    PiAgent,
    'steer' | 'followUp' | 'steeringMode' | 'followUpMode' | 'clearSteeringQueue' | 'clearFollowUpQueue' | 'hasQueuedMessages'
  >;
  deadLetters: DeadLetterStore;
  retryPolicy: RetryPolicy;
  emitError(error: Error): void;
  logger: CortexLogger;
}

export class DeliveryQueues {
  private readonly silent: QueuedDelivery[] = [];
  /** Parked wake deliveries (mutated in place; tests hold the array). */
  readonly wake: QueuedDelivery[] = [];
  /** waitForWakeDrained() callers, released whenever the parked queue empties. */
  private drainWaiters: Array<() => void> = [];

  constructor(private readonly ports: DeliveryQueuePorts) {}

  /** See AgentLoop.steer: pi's steering queue, reached only while a run can poll it. */
  steer(message: string): void {
    // prompt() dequeues from the gate a microtask later, so a non-empty gate
    // counts as prompting: a same-frame prompt()+steer() must not drop.
    if (!this.ports.isPrompting() && !this.ports.gate.isActive) return;
    this.ports.piQueues.steer({ role: 'user', content: message, timestamp: Date.now() });
  }

  /** See AgentLoop.deliver: the silent / parked / prompted state machine. */
  deliver(content: string, options?: DeliverOptions): DeliverResult & { deliveryId: string } {
    this.ports.assertNotShuttingDown();
    if (typeof content !== 'string' || content.trim().length === 0) {
      // Provider conversion drops whitespace-only content. Fail loudly.
      throw new Error('deliver() requires non-whitespace string content');
    }
    if (!this.ports.hasSystemPrompt()) {
      // prompt() would reject only asynchronously, after an outcome for a
      // turn that can never run was reported. Fail at the point of misuse.
      throw new Error(
        'AgentLoop prompt is not configured. Call setBasePrompt() before deliver(), ' +
        'or provide initialBasePrompt during creation.',
      );
    }
    const wake = options?.wake ?? true;
    const deliveryId = options?.deliveryId ?? crypto.randomUUID();

    if (!wake) {
      // Queued in every run state: steered into a live run it would surface
      // at the next tool batch as an unprompted response.
      this.silent.push({ id: deliveryId, content, timestamp: Date.now() });
      this.ports.logger.debug('silent delivery queued', {
        queued: this.silent.length,
      });
      return { outcome: 'queued', deliveryId };
    }

    if (this.ports.gate.isActive) {
      // Gate held, with or without a live run. The sweep guarantees a run.
      this.wake.push({
        id: deliveryId,
        content,
        timestamp: Date.now(),
        abortEpoch: this.ports.abort.epoch,
        ...(options?.causeTag !== undefined ? { causeTag: options.causeTag } : {}),
        ...(options?.atTurnBoundary ? { atTurnBoundary: true } : {}),
      });
      this.scheduleSweep();
      this.ports.logger.debug('wake delivery parked for the next run', {
        parked: this.wake.length,
      });
      return { outcome: 'parked', deliveryId };
    }

    // The gate is empty in this frame, so the run prompt() enqueues is the
    // next run task. The catch keeps a fire-and-forget caller from an
    // unhandled rejection.
    const turn = this.ports.startPrompt(content, options?.promptOptions, options?.causeTag);
    turn.catch((err) => {
      this.ports.logger.warn('deliver-started turn failed', {
        error: errorMessageOf(err),
      });
    });
    return { outcome: 'prompted', turn, deliveryId };
  }

  /**
   * Dequeue parked wake deliveries, dead-lettering what an abort cancelled:
   * everything while an abort is completing, and items from a previous
   * epoch. See "Loop gate, turn unwind, abort epoch" in
   * docs/cortex/cortex-architecture.md.
   */
  takeDeliverableWake(): QueuedDelivery[] {
    const taken = this.wake.splice(0);
    if (taken.length === 0) return taken;
    this.releaseIfDrained();
    const epoch = this.ports.abort.epoch;
    const deliverable = this.ports.abort.inFlight
      ? []
      : taken.filter((item) => (item.abortEpoch ?? epoch) === epoch);
    const dropped = taken.filter((item) => !deliverable.includes(item));
    if (dropped.length > 0) {
      this.ports.logger.info('dropped wake deliveries parked during abort', {
        count: dropped.length,
      });
      this.ports.deadLetters.recordWake(dropped, 'cancelled by abort (parked during the abort window)');
    }
    return deliverable;
  }

  /**
   * Hand parked turn-boundary deliveries to the live run in the turn_end
   * frame. pi polls steering right after its turn_end listeners (unless the
   * turn failed), so content steered into empty queues here is exactly what
   * that poll drains. Only leading flagged items go: a redirect must not
   * overtake an ordinary delivery parked ahead of it.
   */
  steerTurnBoundary(event: CortexEvent): void {
    if (this.wake.length === 0) return;
    if (!this.wake[0]!.atTurnBoundary) return;
    if (!this.ports.isPrompting() || this.ports.isShuttingDown()) return;
    if (this.ports.abort.inFlight) return;
    if (this.ports.budgetBreached()) return;
    const message = payloadOf(event, 'turn_end')?.message;
    if (!message) return;
    if (message.stopReason === 'error' || message.stopReason === 'aborted' || message.errorMessage != null) {
      return;
    }
    // Unknown queue state is not provably empty.
    if (this.ports.piQueues.hasQueuedMessages?.() !== false) return;

    let count = 0;
    while (
      count < this.wake.length &&
      this.wake[count]!.atTurnBoundary &&
      (this.wake[count]!.abortEpoch ?? this.ports.abort.epoch) === this.ports.abort.epoch
    ) {
      count += 1;
    }
    if (count === 0) return;
    const taken = this.wake.splice(0, count);
    this.releaseIfDrained();
    this.ports.piQueues.steer({
      role: 'user',
      content: taken.map((item) => item.content).join('\n\n'),
      timestamp: Date.now(),
    });
    // The run now answers this content, so it carries its causation too.
    const tags = taken.map((item) => item.causeTag).filter((tag) => tag !== undefined);
    if (tags.length > 0) this.ports.appendActiveCauseTags(tags);
    this.ports.logger.debug('parked deliveries steered into the live run', { count });
  }

  /**
   * Enqueue a sweep behind every gate task present now. A real prompt that
   * dequeues first splices the parked list into its batch and leaves the
   * sweep nothing. Sweep runs have no caller, so failures go to onError.
   */
  private scheduleSweep(): void {
    void this.ports.gate.enqueue(async () => {
      if (this.ports.isShuttingDown()) return;
      try {
        await this.sweep();
      } catch (err) {
        this.ports.emitError(toError(err));
      }
    });
  }

  /**
   * Deliver whatever is still parked (content no run has consumed) with a
   * run of its own. On failure, like the background drain: unwind and
   * re-park within the delivery budget.
   */
  private async sweep(): Promise<void> {
    if (this.wake.length === 0) return;
    const pending = this.takeDeliverableWake();
    if (pending.length === 0) return;
    const message = pending.map((item) => item.content).join('\n\n');
    this.ports.logger.info('delivering parked wake deliveries with a run', {
      count: pending.length,
    });
    const now = Date.now();
    for (const item of pending) item.firstDeliveryAttemptAt ??= now;
    const boundedRetryPolicy = boundedPolicyFor(this.ports.retryPolicy, pending, WAKE_DELIVERY_LIMITS, now);
    // pi pushes the delivery message at run start, before any model call.
    const preDeliveryCount = this.ports.transcript.messages().length;
    const runAbortEpoch = this.ports.abort.epoch;
    try {
      // Drain semantics: never flush the silent queue, whose extras would
      // corrupt the unwind's boundary count.
      await this.ports.runDeliveryTurn(
        message,
        boundedRetryPolicy,
        pending.map((item) => item.causeTag).filter((tag) => tag !== undefined),
      );
    } catch (err) {
      const error = toError(err);
      if (!this.unwindFailedDelivery(preDeliveryCount, runAbortEpoch)) {
        // Delivered: the run progressed past it. Only the failure surfaces.
        throw error;
      }
      // An abort cancels parked content with the turn that carried it.
      const classified = classifyError(error, { wasAborted: this.ports.isAborted() });
      if (classified.category === 'cancelled') {
        this.ports.logger.info('wake delivery run aborted; parked content cancelled', {
          count: pending.length,
        });
        this.ports.deadLetters.recordWake(pending, 'cancelled by abort (carrying run aborted)');
        return;
      }
      // A fatal failure (an auth error) exhausts the batch at once, like
      // background completions: an identical re-attempt cannot succeed.
      const { retry: requeue, exhausted: droppedItems } = partitionExhausted(
        pending, WAKE_DELIVERY_LIMITS, Date.now(), { fatal: classified.severity === 'fatal' },
      );
      if (droppedItems.length > 0) {
        this.ports.logger.error('dropping parked wake deliveries after repeated failed runs', {
          dropped: droppedItems.length,
          attempts: WAKE_DELIVERY_LIMITS.maxAttempts,
        });
        this.ports.deadLetters.recordWake(droppedItems, error.message);
      }
      if (requeue.length > 0) {
        // Ahead of anything that parked meanwhile, preserving arrival order.
        this.wake.unshift(...requeue);
        this.scheduleSweep();
      }
      if (requeue.length === pending.length) {
        // Not terminal yet, so it does not surface.
        this.ports.logger.warn('wake delivery run failed; re-parked for another sweep', {
          error: error.message,
          count: requeue.length,
        });
        return;
      }
      throw error;
    }
  }

  /**
   * After a prompt whose batch carried spliced wake deliveries ended without
   * answering them (a terminal failure, or an abort), settle them so
   * 'parked' content never demotes to inert context. Only content the run
   * never progressed past is touched; it leaves the transcript and then:
   *
   * - an abort cancels it with the run that carried it, dead-lettered like
   *   a sweep run's aborted content (nothing starts a run after a stop);
   * - a fatal failure dead-letters it at once;
   * - any other failure re-parks it within the delivery budget.
   *
   * The prompt's own input stays in every case.
   *
   * @param error - The failure, or null for an abort that ended the run
   *   without throwing.
   */
  settleSplicedBatch(
    wakeBatch: QueuedDelivery[],
    trailingBatchCount: number,
    error: Error | null,
    aborted: boolean,
  ): void {
    if (wakeBatch.length === 0) return;
    const messages = this.ports.transcript.messages();

    // The live boundary, not the run-start one: a mid-run front trim
    // (observational activation) shifts every message down, and from the
    // stale offset the batch would read as never pushed and be duplicated.
    const boundary = this.ports.transcript.boundary();

    const unwind = unwindSplicedBatch(messages, wakeBatch, boundary, trailingBatchCount);
    if (unwind.trimmed) this.ports.transcript.notifyTailTrimmed();
    if (unwind.outcome !== 'repark') return;

    if (aborted || error === null) {
      this.ports.logger.info('prompt aborted; spliced wake deliveries cancelled', {
        count: wakeBatch.length,
      });
      this.ports.deadLetters.recordWake(wakeBatch, 'cancelled by abort (carrying run aborted)');
      return;
    }
    const fatal = classifyError(error, { wasAborted: this.ports.isAborted() }).severity === 'fatal';
    const { retry: requeue, exhausted: droppedItems } =
      partitionExhausted(wakeBatch, WAKE_DELIVERY_LIMITS, Date.now(), { fatal });
    if (droppedItems.length > 0) {
      this.ports.logger.error('dropping wake deliveries after repeated failed carrying runs', {
        dropped: droppedItems.length,
        attempts: WAKE_DELIVERY_LIMITS.maxAttempts,
      });
      this.ports.deadLetters.recordWake(droppedItems, error.message);
    }
    if (requeue.length > 0) {
      // Ahead of anything that parked meanwhile, preserving arrival order.
      this.wake.unshift(...requeue);
      this.scheduleSweep();
    }
  }

  /**
   * After a failed delivery run, remove the delivery message and failure
   * stub when the run never progressed past them. Returns true when the
   * message is no longer in the transcript (re-queue the batch), false when
   * the run progressed past it (it counts as delivered).
   */
  unwindFailedDelivery(preDeliveryCount: number, runAbortEpoch: number): boolean {
    const unwind = unwindFailedDelivery(this.ports.transcript.messages(), preDeliveryCount);
    if (unwind.trimmed) this.ports.transcript.notifyTailTrimmed();
    if (unwind.injectedUserTexts.length > 0) {
      // Content pi injected inside the failed run opens the next run.
      for (const content of unwind.injectedUserTexts) {
        this.wake.push({
          // Content pi drained, not a deliver() call: a handle of its own.
          id: crypto.randomUUID(),
          content,
          timestamp: Date.now(),
          // The run's start epoch: read now, it could already be past an
          // abort that should cancel this content.
          abortEpoch: runAbortEpoch,
        });
      }
      this.scheduleSweep();
    }
    return unwind.outcome === 'requeue';
  }

  /** abort() entry: cancel (and dead-letter) everything parked. */
  dropAllWakeForAbort(): void {
    const droppedWake = this.wake.splice(0);
    this.releaseIfDrained();
    if (droppedWake.length > 0) {
      this.ports.logger.info('abort dropped parked wake deliveries', {
        count: droppedWake.length,
      });
      this.ports.deadLetters.recordWake(droppedWake, 'cancelled by abort');
    }
  }

  /** Queue a follow-up on pi's follow-up queue (drains at a would-stop point). */
  followUp(message: string): void {
    if (!this.ports.piQueues.followUp) {
      throw new Error('The underlying agent does not expose followUp()');
    }
    this.ports.piQueues.followUp({ role: 'user', content: message, timestamp: Date.now() });
  }

  setSteeringQueueMode(mode: QueueDrainMode): void {
    this.ports.piQueues.steeringMode = mode;
  }

  setFollowUpQueueMode(mode: QueueDrainMode): void {
    this.ports.piQueues.followUpMode = mode;
  }

  clearSteeringQueue(): void {
    this.ports.piQueues.clearSteeringQueue?.();
  }

  clearFollowUpQueue(): void {
    this.ports.piQueues.clearFollowUpQueue?.();
  }

  /** Clear pi's queues and both loop queues; returns the loop-owned content (silent, then wake). */
  clearAll(): string[] {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
    const wake = this.wake.splice(0).map((item) => item.content);
    this.releaseIfDrained();
    return [...this.clearSilent(), ...wake];
  }

  /**
   * Resolve once no wake delivery is parked (at once when none is). Every
   * path that empties the queue releases it: a run taking the batch, a
   * turn-boundary hand-over, a retraction, an abort or teardown drop.
   */
  waitForWakeDrained(): Promise<void> {
    if (this.wake.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private releaseIfDrained(): void {
    if (this.wake.length > 0 || this.drainWaiters.length === 0) return;
    for (const release of this.drainWaiters.splice(0)) release();
  }

  get silentCount(): number {
    return this.silent.length;
  }

  get wakeCount(): number {
    return this.wake.length;
  }

  /** Take the silent queue for a real prompt's batch. */
  takeSilent(): QueuedDelivery[] {
    return this.silent.splice(0);
  }

  /** The silent queue's content in queue order, left in place. */
  silentContents(): string[] {
    return this.silent.map((item) => item.content);
  }

  clearSilent(): string[] {
    return this.silent.splice(0).map((item) => item.content);
  }

  /** Retract parked wake deliveries matching `predicate` (see AgentLoop.dropPendingWakeDeliveries). */
  dropWake(predicate: (content: string, delivery: PendingWakeDelivery) => boolean): string[] {
    // Decide for every item before removing any, so a throwing predicate
    // leaves the queue exactly as it was.
    const drop = new Set(this.wake.filter((item) => predicate(item.content, {
      id: item.id,
      content: item.content,
      ...(item.causeTag !== undefined ? { causeTag: item.causeTag } : {}),
    })));
    if (drop.size === 0) return [];
    const kept = this.wake.filter((item) => !drop.has(item));
    const dropped = this.wake.filter((item) => drop.has(item)).map((item) => item.content);
    this.wake.splice(0, this.wake.length, ...kept);
    this.releaseIfDrained();
    return dropped;
  }

  /**
   * Teardown, once queued sweeps have no-opped: nothing held here will be
   * delivered, so it is dead-lettered like abort's drops and pending
   * background completions (deliver() refuses new content from here on).
   */
  deadLetterForTeardown(reason: string): void {
    const wake = this.wake.splice(0);
    const silent = this.silent.splice(0);
    this.releaseIfDrained();
    if (wake.length > 0) this.ports.deadLetters.recordWake(wake, reason);
    if (silent.length > 0) this.ports.deadLetters.recordSilent(silent, reason);
  }
}
