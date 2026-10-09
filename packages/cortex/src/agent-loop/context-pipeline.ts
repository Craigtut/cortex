/**
 * The context pipeline: what the model sees on each call. The composed
 * transformContext hook (insertion cap, view injections at the history
 * boundary, sanitization, compaction, cache-breakpoint indices), the
 * consumer-fed headline block, idle digestion (the same pipeline run
 * outside a prompt, in idle windows), and explicit compaction. Digestion,
 * compactNow and observeNow all hold the loop gate, so none races a turn.
 *
 * The digestion generation guards abandoned passes: a timed-out or
 * preempted digestion pass is abandoned, not cancelled (nothing can
 * cancel its utility call), so it can settle minutes later, after the gate
 * released and a real prompt appended messages. Advancing the generation
 * at abandonment makes that late continuation discard itself: it must
 * neither rewrite history from its stale snapshot nor lower the blocking
 * flag under a later pass. digest() and runThresholdPass own this race
 * together with digestionGeneration and forceBlockingCompaction.
 *
 * Reference: context-manager.md, observational-memory-architecture.md,
 * cortex-architecture.md (idle digestion)
 */

import { computeCacheBreakpointIndices } from '../cache-breakpoints.js';
import type { CacheBreakpointIndices } from '../cache-breakpoints.js';
import type { CompactionManager, CompactNowOptions, CompactNowResult, ObserveNowResult } from '../compaction/index.js';
import { DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS } from '../compaction/observational/index.js';
import type { AgentContext, AgentMessage, ContextManager } from '../context-manager.js';
import { errorMessageOf } from '../error-classifier.js';
import { withPlaceholderContent } from '../pi-message.js';
import { isSystemMessage, spliceHistory } from '../system-transcript.js';
import { estimateTokens } from '../token-estimator.js';
import type { CortexLogger } from '../types.js';
import { ABORTED, raceAbort, raceTimeout } from './run-control.js';
import type { LoopGate } from './run-control.js';

/** Options for {@link AgentLoop.digestIdle}. */
export interface IdleDigestionOptions {
  /**
   * Wall-clock budget applied to EACH bounded phase of the digestion
   * (default 60s): the observer catch-up wait, then the blocking threshold
   * pass (activation, reflection). Digestion holds the loop gate, so a hung
   * utility request times the digestion out instead of wedging it. If the
   * hung call settles later, its history mutations are discarded rather
   * than applied over live state.
   */
  observerTimeoutMs?: number;
  /**
   * Preempts the digestion: when it aborts, the pass stops waiting exactly
   * as a timeout would and releases the gate at once. An owner that digests
   * in idle windows aborts it when input arrives, so a user's next words
   * never wait behind background compaction.
   */
  signal?: AbortSignal;
}

/** Result of {@link AgentLoop.digestIdle}. */
export interface IdleDigestionResult {
  /**
   * Whether an observer call ran to completion to buffer unobserved
   * history. False also covers a wait abandoned at observerTimeoutMs.
   */
  observerRan: boolean;
  /**
   * Whether the threshold pass changed the durable history (observation
   * activation swapped observations in for older messages).
   */
  historyCompacted: boolean;
  /** Whether the pass was cut short by {@link IdleDigestionOptions.signal}. */
  preempted?: boolean;
}

/**
 * Default hard token cap for the consumer-fed headline block. Injected
 * user-role content is never trimmed by microcompaction, so an unbounded
 * block would inflate utilization (triggering early source compaction)
 * without itself shrinking; the cap is enforced here, not downstream.
 */
const DEFAULT_HEADLINE_MAX_TOKENS = 2_000;

/** Marker appended when a headline block is cut at its token cap. */
const HEADLINE_TRUNCATION_MARKER = '\n[headline block truncated]';

/**
 * The consumer-fed headline block: rebuilt from the provider on every LLM
 * call, view-injected after the BP3 cache boundary (never in the cached
 * prefix, never in the transcript), hard token-capped.
 */
export class HeadlineFeed {
  private provider: (() => string | null) | null = null;
  private maxTokens = DEFAULT_HEADLINE_MAX_TOKENS;

  constructor(private readonly logger: CortexLogger) {}

  get current(): (() => string | null) | null {
    return this.provider;
  }

  set(
    provider: (() => string | null) | null,
    options?: { maxTokens?: number },
  ): void {
    this.provider = provider;
    if (options?.maxTokens !== undefined) {
      if (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0) {
        throw new Error('setHeadlineProvider maxTokens must be a positive finite number');
      }
      this.maxTokens = options.maxTokens;
    }
  }

  /** The capped block for the current LLM call, or null when none was provided. */
  build(): string | null {
    if (!this.provider) return null;
    let content: string | null;
    try {
      content = this.provider();
    } catch (err) {
      this.logger.warn('headline provider threw', {
        error: errorMessageOf(err),
      });
      return null;
    }
    if (!content || content.trim().length === 0) return null;
    if (estimateTokens(content) <= this.maxTokens) return content;
    // Hard cap: cut at the estimator's character budget, marker included.
    const budgetChars = Math.max(
      0,
      this.maxTokens * 4 - HEADLINE_TRUNCATION_MARKER.length,
    );
    return content.slice(0, budgetChars) + HEADLINE_TRUNCATION_MARKER;
  }
}

export interface ContextPipelinePorts {
  agentState(): {
    systemPrompt?: string;
    model?: unknown;
    messages: AgentMessage[];
    tools?: unknown[];
    thinkingLevel?: unknown;
  };
  setAgentMessages(messages: AgentMessage[]): void;
  slots: Pick<ContextManager, 'historyStart' | 'setSlot'>;
  compaction(): CompactionManager;
  /**
   * View injections for the next call: `stable` content (ephemeral context,
   * loaded skills) holds within a turn and may sit inside the cached
   * prefix; `volatile` content (background task state) churns every tick.
   */
  injections(): { stable: string[]; volatile: string[] };
  /** Where old history ends and the current tick's messages begin. */
  boundary(): number;
  setBoundary(boundary: number): void;
  isPrompting(): boolean;
  /** The current run's abort signal: aborting ends a pass's memory calls. */
  runSignal(): AbortSignal;
  gate: LoopGate;
  assertNotShuttingDown(): void;
  isShuttingDown(): boolean;
  /**
   * The loop's transform hook as the loop hands it out (its
   * getTransformContextHook, resolved per call), so a wrapper installed there
   * sees idle digestion too, not only pi's calls.
   */
  transformHook(): (context: AgentContext) => Promise<AgentContext>;
  logger: CortexLogger;
}

export class ContextPipeline {
  readonly headline: HeadlineFeed;
  // Set while digest() runs the pipeline: the idle window is where blocking
  // compaction work belongs, whatever the configured posture.
  private forceBlockingCompaction = false;
  // See the module doc.
  private digestionGeneration = 0;
  // Computed in the hook, read by pi's onPayload: the API message indices
  // for the BP2 and BP3 cache_control breakpoints.
  private breakpointIndices: CacheBreakpointIndices | null = null;

  constructor(private readonly ports: ContextPipelinePorts) {
    this.headline = new HeadlineFeed(ports.logger);
  }

  get cacheBreakpointIndices(): CacheBreakpointIndices | null {
    return this.breakpointIndices;
  }

  set cacheBreakpointIndices(indices: CacheBreakpointIndices | null) {
    this.breakpointIndices = indices;
  }

  hook(): (context: AgentContext) => Promise<AgentContext> {
    const historyStart = this.ports.slots.historyStart;

    return async (context: AgentContext): Promise<AgentContext> => {
      // pi requires transformContext never to throw: a throw fails the run
      // with a synthetic error. Fall back to the context as it stands.
      try {
        return await this.transform(context, historyStart);
      } catch (err) {
        this.ports.logger.error('transformContext failed; sending the context unchanged', {
          error: errorMessageOf(err),
        });
        return context;
      }
    };
  }

  private async transform(context: AgentContext, historyStart: number): Promise<AgentContext> {
    const sourceMessages = context.messages;
    const passGeneration = this.digestionGeneration;
    const passIsStale = (): boolean => passGeneration !== this.digestionGeneration;

    // Step 0: Tier 1 insertion cap. pi keeps its own in-loop messages
    // array and ignores the returned context for it, so source mutations
    // must hit this array to persist. Staleness is threaded because the
    // cap awaits a consumer persistResult.
    await this.ports.compaction().applyInsertionCap(
      sourceMessages,
      historyStart,
      passIsStale,
    );
    if (passIsStale()) return context;
    this.ports.setAgentMessages([...sourceMessages]);

    // Step 1: Injections go at the boundary, not the end: the tick prompt
    // stays last, and history before it stays cache-readable (pi-ai puts
    // BP4 on the last user message).
    const boundary = this.ports.boundary();
    const view = this.injectedSnapshot(context, boundary);
    let result = view.context;

    // Step 2: Compaction. Source-history rewrites land in pi's loop
    // transcript and agent.state; the returned context only affects this
    // call. Both rewrites fold the system messages they drop into the head
    // (spliceHistory), so this call and every later one still declare the
    // tools and prompt those messages carried.
    result = await this.ports.compaction().applyInTransformContext(
      result,
      (ctx) => ctx.messages.slice(historyStart),
      (ctx, history) => {
        // The source head is canonical (a source rewrite may have just
        // folded into it); folding the view's own drops on top is
        // idempotent, since Cortex and pi write system updates with empty
        // content.
        const messages = [...ctx.messages];
        messages[0] = sourceMessages[0]!;
        spliceHistory(messages, historyStart, history);
        return { ...ctx, messages };
      },
      () => sourceMessages.slice(historyStart),
      // setSourceHistory: every compaction rewrite lands here.
      (history) => {
        if (passIsStale()) {
          // A late abandoned pass would destroy messages appended since.
          this.ports.logger.warn('discarding history rewrite from an abandoned digestion pass');
          return false;
        }
        // Exact only while every rewrite keeps the current tick's messages
        // as a contiguous suffix of `history`; a strategy that breaks that
        // skews the boundary silently.
        const currentTickCount = sourceMessages.length - this.ports.boundary();
        spliceHistory(sourceMessages, historyStart, history);
        this.ports.setAgentMessages([...sourceMessages]);
        this.ports.setBoundary(Math.max(
          historyStart,
          sourceMessages.length - currentTickCount,
        ));
        return true;
      },
      // Staleness also suppresses event dispatch: a consumer must never
      // see a compaction reported for a rewrite that never landed.
      {
        ...(this.forceBlockingCompaction ? { allowBlocking: true } : {}),
        isStale: passIsStale,
        signal: this.ports.runSignal(),
        injections: view.injections,
      },
    );
    if (passIsStale()) return result;

    // The slot carries the log once there is one; until then it stays
    // empty rather than holding a preamble about nothing.
    if (this.ports.compaction().hasObservations()) {
      const slotContent = this.ports.compaction().getObservationSlotContent();
      this.ports.slots.setSlot('_observations', slotContent);
      // The observation slot is the last one, right before history.
      const obsSlotIndex = this.ports.slots.historyStart - 1;
      if (obsSlotIndex >= 0 && obsSlotIndex < result.messages.length) {
        result.messages[obsSlotIndex] = { role: 'user', content: slotContent, timestamp: Date.now() };
      }
    }

    // Step 3: BP3 covers old history plus the stable injections; volatile
    // injections sit after it, outside the cached prefix.
    const stableInjectionCount = this.ports.injections().stable.length;
    this.breakpointIndices = computeCacheBreakpointIndices(result.messages, {
      slotEnd: historyStart,
      boundary: this.ports.boundary() + stableInjectionCount,
    });

    return result;
  }

  /**
   * Replace post-slot history outside a transform pass (reactive overflow
   * truncation, an explicit compaction). Compaction rewrites keep the current
   * turn's messages as a contiguous suffix, so the history boundary moves
   * with them, exactly as for a rewrite inside the pass.
   */
  writeSource(history: AgentMessage[]): void {
    const historyStart = this.ports.slots.historyStart;
    const messages = this.ports.agentState().messages;
    const currentTickCount = messages.length - this.ports.boundary();
    spliceHistory(messages, historyStart, history);
    this.ports.setAgentMessages([...messages]);
    this.ports.setBoundary(Math.max(historyStart, messages.length - currentTickCount));
  }

  /** The loop's live context as pi would hand it to transformContext. */
  snapshot(): AgentContext {
    const state = this.ports.agentState();
    return {
      systemPrompt: state.systemPrompt ?? '',
      model: state.model ?? null,
      messages: state.messages,
      tools: (state.tools ?? []) as unknown[],
      thinkingLevel: typeof state.thinkingLevel === 'string'
        ? state.thinkingLevel
        : 'medium',
    };
  }

  /**
   * `context` with the view injections inserted at `boundary` (after old
   * history, before the current tick's messages), then sanitized, and the
   * injected messages themselves: compaction must tell them from the
   * transcript.
   */
  private injectedSnapshot(
    context: AgentContext,
    boundary: number,
  ): { context: AgentContext; injections: ReadonlySet<AgentMessage> } {
    let result = context;
    // Ordered by stability so BP3 can sit after the stable ones. Volatile
    // content is still built here so estimation and compaction see it.
    const { stable, volatile } = this.ports.injections();
    const headline = this.headline.build();
    const injections: AgentMessage[] = [...stable, ...volatile, ...(headline ? [headline] : [])]
      .map((content) => ({ role: 'user' as const, content, timestamp: Date.now() }));

    let insertIdx = 0;
    if (injections.length > 0) {
      const messages = [...result.messages];
      // Never ahead of history: the system head must stay first (pi reads
      // the prompt only from index 0) and the slots right behind it. The
      // boundary may also exceed the array on the first tick or after reset.
      insertIdx = Math.min(Math.max(boundary, this.ports.slots.historyStart), messages.length);
      messages.splice(insertIdx, 0, ...injections);
      result = { ...result, messages };
    }

    // System messages are declarations, not turns: an empty one is valid.
    const messages = result.messages.map((message) =>
      isSystemMessage(message) ? message : withPlaceholderContent(message));
    return {
      context: { ...result, messages },
      injections: new Set(messages.slice(insertIdx, insertIdx + injections.length)),
    };
  }

  /** Heuristic token size of the context the next LLM call would send. */
  estimateTokens(): number {
    const boundary = this.ports.isPrompting()
      ? this.ports.boundary()
      : this.ports.agentState().messages.length;
    const { context } = this.injectedSnapshot(
      this.snapshot(),
      boundary,
    );
    return this.ports.compaction().estimateCurrentContextTokens(context);
  }

  /** {@link CompactionManager.compactNow} under the loop gate. */
  compactNow(options?: CompactNowOptions): Promise<CompactNowResult> {
    this.ports.assertNotShuttingDown();
    return this.ports.gate.enqueue(async () => {
      if (this.ports.isShuttingDown()) return { status: 'failed', error: new Error('The loop is shutting down') };
      const historyStart = this.ports.slots.historyStart;
      const result = await this.ports.compaction().compactNow(
        () => this.ports.agentState().messages.slice(historyStart),
        (history) => this.writeSource(history),
        { ...options, tokensBefore: this.estimateTokens() },
      );
      this.refreshObservationSlot();
      return result;
    });
  }

  /** {@link CompactionManager.observeNow} under the loop gate. */
  observeNow(options?: { signal?: AbortSignal }): Promise<ObserveNowResult> {
    this.ports.assertNotShuttingDown();
    return this.ports.gate.enqueue(async () => {
      if (this.ports.isShuttingDown()) return { status: 'failed', error: new Error('The loop is shutting down') };
      const historyStart = this.ports.slots.historyStart;
      const result = await this.ports.compaction().observeNow(
        () => this.ports.agentState().messages.slice(historyStart),
        { ...options, tokensBefore: this.estimateTokens() },
      );
      this.refreshObservationSlot();
      return result;
    });
  }

  /** Point the observation slot at the log, once there is one. */
  private refreshObservationSlot(): void {
    const compaction = this.ports.compaction();
    if (compaction.hasObservations()) {
      this.ports.slots.setSlot('_observations', compaction.getObservationSlotContent());
    }
  }

  digest(options?: IdleDigestionOptions): Promise<IdleDigestionResult> {
    this.ports.assertNotShuttingDown();
    return this.ports.gate.enqueue(async () => {
      if (this.ports.isShuttingDown()) {
        return { observerRan: false, historyCompacted: false };
      }
      const signal = options?.signal;
      if (signal?.aborted) {
        return { observerRan: false, historyCompacted: false, preempted: true };
      }

      // 1. Observer catch-up, so the next activation is a cheap merge.
      // Preempting abandons only the wait; the observer still lands its
      // chunk.
      const outcome = await raceAbort(
        this.ports.compaction().digestPendingObservationBuffers(
          this.ports.agentState().messages,
          this.ports.slots.historyStart,
          options?.observerTimeoutMs,
        ),
        signal,
      );
      if (outcome === ABORTED) {
        this.ports.logger.debug('idle digestion preempted during observer catch-up');
        return { observerRan: false, historyCompacted: false, preempted: true };
      }
      const observerRan = outcome;
      if (signal?.aborted) {
        return { observerRan, historyCompacted: false, preempted: true };
      }
      return this.runThresholdPass(observerRan, options);
    });
  }

  /**
   * Phase 2 of {@link digest}, under the gate it holds: the threshold
   * pass, bounded by the timeout and by preemption, which abandon it the
   * same way.
   */
  private async runThresholdPass(
    observerRan: boolean,
    options?: IdleDigestionOptions,
  ): Promise<IdleDigestionResult> {
    // 2. The transformContext pipeline over live history: source mutations
    // persist, the view is discarded.
    const lengthBefore = this.ports.agentState().messages.length;
    const hook = this.ports.transformHook();
    const passGeneration = this.digestionGeneration;
    this.forceBlockingCompaction = true;
    const thresholdPass = (async () => {
      try {
        await hook(this.snapshot());
      } finally {
        // An abandoned pass must not lower a LATER pass's flag.
        if (passGeneration === this.digestionGeneration) {
          this.forceBlockingCompaction = false;
        }
      }
    })();
    const timeoutMs = options?.observerTimeoutMs ?? DEFAULT_IDLE_DIGESTION_OBSERVER_TIMEOUT_MS;
    const outcome = await raceTimeout(thresholdPass, timeoutMs, options?.signal);
    const wasPreempted = outcome === 'aborted';
    if (outcome !== 'settled') {
      // Abandoned, not cancelled (see the module doc). The pass's own
      // finally is now stale, so lower the flag here.
      this.digestionGeneration += 1;
      this.forceBlockingCompaction = false;
      if (wasPreempted) {
        this.ports.logger.debug('idle digestion threshold pass preempted');
      } else {
        this.ports.logger.warn('idle digestion threshold pass timed out', { timeoutMs });
      }
    }
    const historyCompacted = this.ports.agentState().messages.length !== lengthBefore;

    this.ports.logger.debug('idle digestion complete', { observerRan, historyCompacted });
    return { observerRan, historyCompacted, ...(wasPreempted ? { preempted: true } : {}) };
  }
}
