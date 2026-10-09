/**
 * Type definitions for the observational memory system.
 *
 * Observational memory is an alternative compaction strategy that replaces
 * Layers 1 and 2 (microcompaction + conversation summarization) with a
 * continuous, background-driven compression system. Two background LLM agents
 * (Observer and Reflector) maintain a compressed event log of the conversation.
 *
 * References:
 *   - observational-memory-architecture.md
 *   - compaction-strategy.md
 *   - context-manager.md
 */

import type { AgentMessage } from '../../context-manager.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Consumer-facing configuration for the observational memory system.
 *
 * All fields are optional with sensible defaults. The system adapts to any
 * context window size from 32k to 1M+ through percentage-based thresholds.
 */
export interface ObservationalMemoryConfig {
  /**
   * Percentage of total context window utilization that triggers observation
   * activation. When total context (system prompt + slots + observations +
   * messages) exceeds this fraction of the context window, buffered
   * observations activate and raw messages are trimmed.
   * @default 0.9
   */
  activationThreshold: number;

  /**
   * Maximum token count per async buffer observation. Caps how many tokens
   * of unobserved messages a single observer call will process. Prevents
   * oversized observer calls on large context windows.
   * The actual interval is computed dynamically (see Observer System section
   * in architecture doc).
   * Internally clamped to utilityModelContextWindow * 0.6 to ensure the
   * observer input fits within the utility model's context window.
   * @default 30_000
   */
  bufferTokenCap: number;

  /**
   * Minimum tokens of unobserved messages before a buffer observation runs.
   * Prevents thrashing when the context window is nearly full or on very
   * small windows.
   * @default 5_000
   */
  bufferMinTokens: number;

  /**
   * Target number of buffer cycles between current utilization and the
   * activation threshold. Higher values mean more frequent, smaller observer
   * calls. Lower values mean fewer, larger observer calls.
   * @default 4
   */
  bufferTargetCycles: number;

  /**
   * Fraction of the context window at which reflection triggers.
   * When the observation slot exceeds this percentage of the context window,
   * the Reflector condenses it. Scales naturally across all window sizes.
   * Internally clamped to utilityModelContextWindow * 0.5 to ensure the
   * reflector input fits within the utility model's context window.
   * @default 0.20
   */
  reflectionThreshold: number;

  /**
   * Fraction of reflectionThreshold at which async reflection buffering
   * begins. For example, 0.5 means start background reflection at 50% of
   * the threshold.
   * @default 0.5
   */
  reflectionBufferActivation: number;

  /**
   * Token budget for previous observations sent to the Observer as context.
   * Provides continuity between observation cycles so the observer does not
   * duplicate already-captured information.
   * @default 2_000
   */
  previousObserverTokens: number;

  /**
   * Fraction of the context window kept verbatim when observations swap
   * in: the most recent messages stay as they are, never split between a
   * tool call and its result, and the latest user message always stays.
   * @default 0.2
   */
  tailRatio: number;

  /**
   * Cap on the verbatim tail in tokens, so a large window does not keep a
   * large raw tail. The last unit of history stays whatever its size.
   * @default 64_000
   */
  tailMaxTokens: number;

  /**
   * Wall-clock bound on each attempt of an observer or reflector call.
   * @default 60_000
   */
  callTimeoutMs: number;

  /**
   * Attempts per observer or reflector call, the first included. Retries are
   * quick (1 s, then 2 s) and skip failures that would repeat
   * (authentication, an input too large for the utility model).
   * @default 3
   */
  maxAttempts: number;

  /**
   * Upper bound on how long one in-band activation pass may block a request
   * on memory calls (observing and reflecting together). When it runs out,
   * the pass swaps in what is already observed and the request goes out.
   * @default 60_000
   */
  blockingBudgetMs: number;

  /**
   * Custom instructions appended to the Observer's system prompt.
   * Use for domain-specific observation behavior. Cannot replace the core
   * prompt, only extend it.
   */
  observerInstruction?: string;

  /**
   * Custom instructions appended to the Reflector's system prompt.
   * Use for domain-specific reflection behavior. Cannot replace the core
   * prompt, only extend it.
   */
  reflectorInstruction?: string;

  /**
   * Optional recall tool configuration. When provided, Cortex registers a
   * recall tool that enables the agent to search through persisted
   * conversation history. The consumer owns message persistence and search
   * implementation.
   */
  recall?: RecallConfig;
}

/**
 * Configuration for the optional recall tool.
 *
 * The consumer provides a search function that Cortex wraps into a tool
 * registered on the agent. Observations include timestamps, enabling
 * temporal anchoring for precise recall queries.
 */
export interface RecallConfig {
  /**
   * Search function provided by the consumer. Accepts a query string and
   * optional time range for narrowing results.
   *
   * The consumer owns the search implementation (vector DB, full-text
   * search, SQL, etc.). Cortex only wraps it into a tool.
   */
  search: (
    query: string,
    options?: { timeRange?: { start?: Date; end?: Date } },
  ) => Promise<RecallResult[]>;
}

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

/**
 * Serializable session state for the observational memory system.
 *
 * Saved via `agent.getObservationalMemoryState()` and restored via
 * `agent.restoreObservationalMemoryState()`. The consumer decides where
 * and when to persist this (same pattern as `getConversationHistory()`).
 */
export interface ObservationalMemoryState {
  /** Current observation text (the content stored in the _observations slot). */
  observations: string;

  /** Continuation hints from the last observer run. */
  continuationHint: ContinuationHint | null;

  /** Current observation token estimate. */
  observationTokenCount: number;

  /** How many reflection cycles have occurred in this session. */
  generationCount: number;

  /** Buffered observation chunks not yet activated. */
  bufferedChunks: ObservationChunk[];

  /**
   * Index into post-slot conversation history up to which messages are
   * observed: `[0, observedPrefix)` already in the log, then the buffered
   * chunks up to here.
   * Persisted so the buffer can be restored without re-observing already
   * buffered messages. Absent on sessions saved before buffer persistence
   * was added; in that case chunks are discarded on restore (legacy safe).
   */
  bufferWatermark?: number;

  /**
   * Messages at the front of post-slot history that are already in
   * `observations` and still in history (a swap kept them verbatim).
   * Buffered chunks cover `[observedPrefix, bufferWatermark)`. Absent on
   * older sessions: 0.
   */
  observedPrefix?: number;
}

// ---------------------------------------------------------------------------
// Observation Chunks
// ---------------------------------------------------------------------------

/**
 * A buffered observation chunk produced by an async observer call.
 *
 * Chunks accumulate between activation cycles. On activation, completed
 * chunks are merged into the observation slot and their corresponding
 * raw messages are removed from context.
 */
export interface ObservationChunk {
  /** The observation text produced by the observer. */
  observations: string;

  /** Token count of messages that were observed in this chunk. */
  messageTokensObserved: number;

  /** When this chunk was created. */
  createdAt: Date;

  /**
   * End (exclusive) of the post-slot history range the chunk covers; it
   * starts where the previous chunk ended. Absent on chunks saved before
   * ranges were recorded, which restore merged into one chunk.
   */
  endIndex?: number;

  /** Current task extracted from this observation. Latest chunk wins on activation. */
  currentTask?: string;

  /** Suggested response extracted from this observation. Latest chunk wins on activation. */
  suggestedResponse?: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Event payload fired when observations are recorded into the log, and
 * when a swap removes observed messages from context.
 *
 * Registered via `agent.onObservation()`. Multiple handlers are supported.
 * Consumers can use this to persist removed messages or coordinate their
 * own compression systems.
 */
export interface ObservationEvent {
  /** What recorded them: a threshold activation, compactNow, or observeNow. */
  trigger: 'activation' | 'compact-now' | 'observe-now';

  /** Messages whose observations this event added to the log. */
  observedMessages: AgentMessage[];

  /**
   * Messages that left context. Empty when nothing was swapped out
   * (observeNow records without removing).
   */
  removedMessages: AgentMessage[];

  /** The whole observation log after this event. */
  observations: string;

  /** Total context utilization (0-1) at the time of activation. */
  contextUtilization: number;

  /** Estimated context size before and after, in tokens. */
  tokensBefore: number;
  tokensAfter: number;

  /** Whether observations were made while a caller waited (in-band). */
  sync: boolean;

  /** Timestamp of the observation. */
  timestamp: Date;
}

/**
 * Event payload fired after a reflection cycle completes (observations
 * are condensed by the reflector).
 *
 * Registered via `agent.onReflection()`. Multiple handlers are supported.
 * Consumers can use this to coordinate their own compaction timing with
 * Cortex's reflection cycles.
 */
export interface ReflectionEvent {
  /** Observations before reflection. */
  previousObservations: string;

  /** Observations after reflection (condensed). */
  newObservations: string;

  /** How many reflection generations have occurred in this session. */
  generationCount: number;

  /** Compression level used (0-4). */
  compressionLevel: number;

  /** Timestamp of the reflection. */
  timestamp: Date;
}

/** What started a memory (observer or reflector) call. */
export type MemoryCallTrigger = 'buffer' | 'activation' | 'idle' | 'compact-now' | 'observe-now';

/**
 * An observer or reflector call that failed after all its attempts.
 *
 * Registered via `agent.onMemoryError()`. Nothing is lost when this fires:
 * an observation that failed leaves its messages in context, and a
 * reflection that failed keeps the current log. While failures continue
 * the loop stops blocking requests on memory calls; background calls keep
 * trying, and `onMemoryRecovered` fires on the first success.
 */
export interface MemoryErrorInfo {
  operation: 'observe' | 'reflect';
  trigger: MemoryCallTrigger;
  /** The last attempt's error. */
  error: Error;
  attempts: number;
  /** Failed calls in a row, this one included: 1 when memory just became degraded. */
  consecutiveFailures: number;
  /**
   * What the failure left behind:
   * - 'retry-later': nothing changed; a later background call tries again.
   * - 'partial-swap': the activation swapped in only what was already
   *   observed; the request went out as it stood.
   * - 'unchanged': the log and history are as they were (a failed
   *   reflection, or an explicit call that reports the failure itself).
   */
  outcome: 'retry-later' | 'partial-swap' | 'unchanged';
}

/** The first successful memory call after one or more failures. */
export interface MemoryRecoveredInfo {
  /** Failed calls in a row before this success. */
  failures: number;
  /** How long memory was degraded. */
  degradedForMs: number;
}

/**
 * The `memory` event on the event bridge: the same reports as the memory
 * callbacks, so they forward from sub-agents (with `childTaskId`) and carry
 * the loop's path on a composite facade's merged stream.
 */
export type MemoryEventPayload =
  | { kind: 'error'; info: MemoryErrorInfo }
  | { kind: 'recovered'; info: MemoryRecoveredInfo };

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

/**
 * A single result returned from the consumer's recall search function.
 *
 * Contains the content of a past message or tool result along with
 * temporal and classification metadata.
 */
export interface RecallResult {
  /** The message or tool result content. */
  content: string;

  /** When the message occurred. */
  timestamp: Date;

  /** Type of content returned. */
  type: 'message' | 'tool-result' | 'tool-call';

  /** Message role, if applicable. */
  role?: 'user' | 'assistant';
}

// ---------------------------------------------------------------------------
// LLM Output Types
// ---------------------------------------------------------------------------

/**
 * Parsed output from the observer LLM call.
 *
 * The observer produces XML with three sections: observations, current-task,
 * and suggested-response. This type represents the parsed result.
 */
export interface ObserverOutput {
  /** Extracted observations in the structured bulleted format. */
  observations: string;

  /** The agent's current task, if identified by the observer. */
  currentTask?: string;

  /** A suggested response hint for the agent after observation activates. */
  suggestedResponse?: string;
}

/**
 * Parsed output from the reflector LLM call.
 *
 * The reflector produces consolidated observations and reports the
 * compression level it applied.
 */
export interface ReflectorOutput {
  /** Consolidated and reorganized observations. */
  observations: string;

  /** The compression level that was applied (0-4). */
  compressionLevel: number;
}

// ---------------------------------------------------------------------------
// Internal Types
// ---------------------------------------------------------------------------

/**
 * Continuation hint carried between observer runs and across sessions.
 *
 * Provides the agent with awareness of what it was working on and what
 * it should say next, particularly valuable on session resumption.
 */
export interface ContinuationHint {
  /** What the agent is currently working on. */
  currentTask: string;

  /** Hint for the agent's next message after observation activates. */
  suggestedResponse: string;
}

/**
 * Internal state for the buffering coordinator.
 *
 * Tracks the observation watermark, accumulated chunks, and in-flight
 * async operations for both the observer and reflector.
 */
export interface BufferState {
  /**
   * Index into agent.state.messages marking where the last completed
   * observation ended. Messages from this index onward are "unobserved."
   */
  watermark: number;

  /** Completed observation chunks awaiting activation. */
  chunks: ObservationChunk[];

  /** Promise for the currently in-flight async observer call, or null. */
  inFlightObserver: Promise<ObserverOutput | null> | null;

  /** Promise for the currently in-flight async reflector call, or null. */
  inFlightReflector: Promise<ReflectorOutput | null> | null;
}
