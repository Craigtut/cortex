/**
 * The mode strategy behind CortexAgent: everything about a session whose
 * behavior depends on whether one loop runs it (passthrough) or a talker
 * fronts a reasoner (duplex). The facade owns what every mode shares (the
 * log, persistence, usage, settlement, teardown order) and delegates the
 * rest through this contract, so it never branches on mode.
 */

import type { DeliverResult, DirectCompletionOptions } from '../agent-loop.js';
import type { CortexLogger, PendingAsk, SessionUsage } from '../types.js';
import type { CortexModel } from '../model-wrapper.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ContextManager } from '../context-manager.js';
import type { CompactNowOptions, CompactNowResult, ObservationalMemoryState } from '../compaction/index.js';
import type { BudgetGuard } from '../budget-guard.js';
import type { EventBridge } from '../event-bridge.js';
import type { CausationSource } from '../duplex/cause-tags.js';
import type { DuplexRouterState } from '../duplex/router-contract.js';
import type { LogRecorder } from './log-recorder.js';
import type { PromptTracker, SettlementTerm } from './settlement.js';

/** Scope for CortexAgent.abort (facade-api.md abort table). */
export type CortexAbortScope = 'conversation' | 'work' | 'all';

/** Options for CortexAgent.deliver. */
export interface CortexDeliverOptions {
  /**
   * Whether the delivery may wake an idle loop by starting a turn.
   * Default true. See AgentLoop.deliver.
   */
  wake?: boolean;
  /**
   * Which surface the input addresses. In passthrough both resolve to the
   * reasoner; in duplex 'conversation' is the talker and 'work' the
   * reasoner. Default: 'conversation'.
   */
  target?: 'conversation' | 'work';
  /**
   * Who is speaking. Only 'user' mints a consent-qualifying cause tag, so a
   * caller relaying actual human speech must say so; everything else
   * (notifications, status, anything the application itself says) defaults
   * to 'system' and cannot satisfy a permission ask.
   *
   * The default is deliberately not 'user'. Defaulting the other way makes
   * every notification path a silent consent source: voice an escalation
   * ask, wait for any routine "your build finished", and a persuaded talker
   * can grant permission whose audit trail points at the build message.
   * Defaulting to 'system' costs at most one re-voice when a consumer
   * forgets to mark real speech. See docs/cortex/duplex/decisions.md D16.
   *
   * `prompt()` is unambiguous user speech and always mints the user tag.
   */
  speaker?: 'user' | 'system';
}

/** CortexAgent.compactNow's result: each resident loop's. */
export interface CortexCompactNowResult {
  /** The work loop: the reasoner, in both modes. */
  reasoner: CompactNowResult;
  /**
   * The talker, in duplex: a swap of what it had already observed, which
   * never waits on the memory model. Absent in passthrough.
   */
  talker?: CompactNowResult;
}

/** The non-reasoner side of the persisted artifact. */
export interface SessionStateParts {
  talkerHistory: AgentMessage[];
  talkerMemory: ObservationalMemoryState | null;
  router?: DuplexRouterState;
  /** Silent deliveries queued on the talker, oldest first. */
  talkerQueuedDeliveries?: string[];
}

/** What a restore hands the mode once its queues and router are reset. */
export type RestoredSessionParts = Pick<SessionStateParts, 'router' | 'talkerQueuedDeliveries'>;

/** What a mode needs of the facade that hosts it. */
export interface FacadeServices {
  readonly recorder: LogRecorder;
  readonly prompts: PromptTracker;
  readonly logger: CortexLogger;
  markStateDirty(): void;
  destroyed(): boolean;
  /** Re-run prompt()'s validation (a queued prompt reaching its turn). */
  assertPromptable(): void;
  /** Whether the conversation surface is quiet (facade settlement). */
  conversationIdle(): boolean;
  /** The facade's own prompt(), validation included. */
  prompt(input: string): Promise<unknown>;
  /** Input is arriving: the moment an unwired egress resolver is noted. */
  noteInputArriving(): void;
  /** The facade re-resolved a loop's model: its resolution notes change. */
  refreshModelNotes(): void;
}

export interface SessionMode {
  /** The live runs' causation, for log stamps. */
  readonly causation: CausationSource;
  readonly eventBridge: EventBridge;
  readonly contextManager: ContextManager;
  /** The session-wide cost guard, or null where none exists. */
  readonly aggregateBudgetGuard: BudgetGuard | null;

  prompt(input: string, options?: DirectCompletionOptions): Promise<unknown>;
  /** Content already validated and non-empty. */
  deliver(content: string, options?: CortexDeliverOptions): DeliverResult;
  steer(message: string): void;
  /** After the facade logged the request. */
  abort(scope: CortexAbortScope): Promise<void>;
  /** Every ask blocked on a decision, deduplicated by askId. */
  pendingAsks(): PendingAsk[];
  /**
   * The consumer says it presented an ask to the human. Only where the
   * consumer owns that fact; false where the session voices asks itself.
   */
  markAskVoiced(askId: string): boolean;
  /** The settlement terms in wait order, the facade's prompt term included. */
  settlementTerms(prompts: SettlementTerm): { conversation: SettlementTerm[]; work: SettlementTerm[] };

  setBasePrompt(basePrompt: string): string;
  getBasePrompt(): string;
  setModel(model: CortexModel): void;
  setUtilityModel(model: CortexModel): void;
  setSessionId(value: string | null): void;
  /** Compact every resident loop now (CortexAgent.compactNow). */
  compactNow(options?: CompactNowOptions): Promise<CortexCompactNowResult>;

  /** Settled spend of work outside the resident loops, or null if none can exist. */
  lookupUsage(): SessionUsage | null;
  /** Work beyond the resident loops a restore must not run under. */
  restoreBlocked(): boolean;
  /** Called with the loop gates empty. */
  captureState(): SessionStateParts;
  /** Restore, first half: the artifact's non-reasoner side (already copied). */
  hydrate(parts: SessionStateParts): void;
  /**
   * Restore, second half, after the log is restored: whatever else the mode
   * holds describes the replaced session.
   */
  resetForRestore(restored: RestoredSessionParts): void;

  /** Teardown, synchronously at destroy(): timers and pending asks. */
  beginDestroy(): void;
  /** Teardowns that run alongside the resident loops'. */
  teardowns(): Array<Promise<void>>;
  /** After the loops have detached: resources the mode owns. */
  closeOwnedResources(): Promise<void>;
  /** Last. */
  finishDestroy(): void;
}
