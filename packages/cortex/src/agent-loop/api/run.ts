/**
 * AgentLoop's public surface, running turns (prompting, run state, idle
 * digestion, abort, teardown). AgentLoop implements this interface; the
 * member docs here are AgentLoop's documentation.
 */

import type { CortexLifecycleState } from '../../types.js';
import type { IdleDigestionOptions, IdleDigestionResult } from '../context-pipeline.js';
import type { DirectCompletionOptions } from '../direct-completion.js';

/**
 * One logical run: a prompt, a delivery sweep or a background drain, from
 * its first pi attempt through its retry continuations until it unwinds.
 */
export interface LoopRunInfo {
  /** Increases by one per logical run, loop-lifetime. */
  readonly id: number;
  /** When the run started (epoch ms). */
  readonly startedAt: number;
  /**
   * The current or most recent pi attempt, 1-based: 1 for the first, one
   * more for each retry continuation. 0 before the first attempt starts.
   */
  readonly attempt: number;
  /** When the live attempt started, or null between attempts (retry backoff). */
  readonly attemptStartedAt: number | null;
}

/** Options for {@link LoopRunApi.prompt}. */
export interface PromptOptions extends DirectCompletionOptions {
  /**
   * Opaque causation tag for this prompt's input, exposed through
   * {@link LoopRunApi.activeRunCauseTags} for exactly the run it starts,
   * the same way a delivery's DeliverOptions.causeTag is. Bound to the
   * call, so no later run can inherit it.
   */
  causeTag?: unknown;
}

export interface LoopRunApi {
  /**
   * Send a prompt to the agent and run the agentic loop.
   *
   * Transitions from CREATED to ACTIVE on first call. Errors are classified
   * and emitted through onError; transient failures are retried in the
   * background per the retry policy.
   *
   * Every loop start is serialized through an internal gate. A prompt()
   * issued while a loop is active or queued fails fast BEFORE any shared
   * state is touched; use steer() or deliver() to reach a running loop.
   *
   * @param input - The prompt text
   * @returns The agent's response (opaque, from pi-agent-core)
   * @throws Error if the agent has been destroyed or is already prompting
   */
  prompt(input: string, options?: PromptOptions): Promise<unknown>;

  /**
   * True while any gate task is running or queued: a prompt cycle, a
   * background-completion drain, an idle digestion pass, or a delivery
   * sweep. While true, prompt() fails fast and deliver() steers or queues
   * instead of starting a turn.
   */
  readonly isLoopActive: boolean;

  /**
   * True while a logical turn is in flight: from the first agent.prompt
   * attempt through its retry continuations until the turn unwinds.
   * Narrower than {@link isLoopActive}, which also covers gate tasks that
   * never run pi (idle digestion, an empty drain). A steer() only reaches a
   * run while this is true; otherwise it waits for the next run.
   */
  readonly isPrompting: boolean;

  /**
   * The logical run in flight, or null when none is: its id, when it
   * started, and which attempt of its retry ladder is live. Non-null
   * exactly while {@link isPrompting} is true. A snapshot; read it again for
   * later state.
   */
  readonly currentRun: LoopRunInfo | null;

  /** When the last logical run ended (epoch ms), or null before any has. */
  readonly lastRunEndedAt: number | null;

  /**
   * Cause tags of the run currently holding the gate: the tags of every
   * wake delivery this run consumed (its own prompt input, spliced parked
   * content, or a sweep batch). Empty while no run is live and for runs
   * that carry no tagged content. Always exactly the live run's; a later
   * run never inherits a previous run's tags. The duplex facade stamps
   * log-entry causation from this (D16, docs/cortex/duplex/log-and-context.md).
   */
  readonly activeRunCauseTags: readonly unknown[];

  /**
   * Resolve once the loop gate is empty: no gate task running or queued.
   * The awaitable form of {@link isLoopActive} (not {@link isPrompting},
   * which reads idle while drains, sweeps or digestion are pending). Tasks
   * enqueued by tasks extend the wait.
   *
   * The caller's continuation runs a microtask after the gate emptied, and
   * another task can enqueue in between. For check-then-act atomicity,
   * re-check {@link isLoopActive} synchronously before acting and wait again
   * if the gate refilled.
   */
  waitForLoopIdle(): Promise<void>;

  /**
   * Abort the current agentic loop without destroying the agent.
   * The agent remains usable for subsequent prompts.
   */
  abort(): Promise<void>;

  /**
   * Ordered cleanup of all resources. Called by the consumer when the
   * agent is no longer needed. Idempotent; concurrent calls share one
   * teardown.
   *
   * Steps: abort the in-progress loop and wait for it to unwind;
   * dead-letter undelivered background completions and loop-owned
   * deliveries (parked wake, queued silent); destroy all
   * sub-agents; emit onLoopComplete for a final checkpoint (best-effort);
   * close owned MCP connections; release skills, listeners, agent state and
   * compaction; mark as destroyed. Background processes are force-killed
   * if cleanup exceeds the timeout.
   *
   * @param timeoutMs - Maximum time to wait for cleanup (default: 8000ms)
   */
  destroy(timeoutMs?: number): Promise<void>;

  /**
   * Whether the agent is currently running an agentic loop.
   */
  readonly isRunning: boolean;

  /**
   * Get the current lifecycle state.
   */
  readonly state: CortexLifecycleState;

  /**
   * The number of messages in agent.state.messages before the current
   * prompt() call. Used by the cache breakpoint system to distinguish
   * "old history" (cacheable) from "new tick content" (ephemeral).
   */
  readonly prePromptMessageCount: number;

  /**
   * Run deferred digestion OUTSIDE a prompt: pending observation buffering
   * plus the threshold pass (observation activation and reflection), with
   * blocking work allowed even under the non-blocking posture. The
   * primitive behind digesting in idle windows; otherwise observation only
   * triggers on turn_end and compaction only runs inside transformContext.
   *
   * Serialized through the loop gate: called during a turn, it runs after
   * that turn. prompt() fails fast while digestion holds the gate (deliver()
   * parks or queues as usual). Each phase is bounded by
   * options.observerTimeoutMs and preemptible via options.signal; a hung
   * utility request times the digestion out instead of wedging the gate,
   * and its late history rewrite is discarded.
   */
  digestIdle(options?: IdleDigestionOptions): Promise<IdleDigestionResult>;
}
