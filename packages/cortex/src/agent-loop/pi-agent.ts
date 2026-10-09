/**
 * The pi-agent-core / pi-ai boundary AgentLoop is written against: the
 * part of pi's Agent the loop drives, pi's Model, and the one crossing
 * point for thinking levels. Types come from pi itself, so a pi release
 * that changes them fails the build here; the classes still load lazily.
 */

import type { Agent } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentMessage, AgentStateAccessor } from '../context-manager.js';
import type { PiEventSource } from '../event-bridge.js';
import type { CortexTool } from '../tool-contract.js';
import type { AgentLoopConfig, ModelThinkingCapabilities, ThinkingLevel } from '../types.js';
import { THINKING_LEVEL_ORDER } from '../types.js';

// ---------------------------------------------------------------------------
// The pi-agent-core/pi-ai contracts
// ---------------------------------------------------------------------------

/**
 * A user message the loop queues on pi's steering or follow-up queue. pi
 * pushes it into the transcript as given, so it carries its own timestamp.
 */
export interface QueuedUserMessage {
  role: 'user';
  content: string;
  timestamp: number;
}

/**
 * The part of pi-agent-core's Agent that AgentLoop drives. Signatures are
 * written so pi's Agent satisfies them (checked below, so a pi release that
 * changes one fails the build here) and a scripted test agent can too:
 * results are `unknown` because the loop never reads them. Messages are the
 * loop's view of pi's transcript ({@link AgentMessage}), read through
 * {@link AgentStateAccessor}.
 */
export interface PiAgent extends AgentStateAccessor, PiEventSource {
  /**
   * Start a run from a prompt, or from a prepared batch of messages that pi
   * pushes into the transcript at run start (Cortex flushes queued silent
   * deliveries this way, ahead of the real prompt).
   */
  prompt(input: string | AgentMessage[]): Promise<unknown>;
  /**
   * Resume the agentic loop from the current transcript without adding a
   * message. Used for background retries; the last message must be a user
   * or tool-result (Cortex trims pi's synthetic failure message first).
   */
  continue(): Promise<unknown>;
  abort(): void;
  waitForIdle(): Promise<void>;
  reset(): void;
  /**
   * Queue a message pi applies after the current assistant turn and tool
   * batch finish. Only effective while a run is in progress.
   */
  steer(message: QueuedUserMessage): void;
  /** Queue a message pi injects only where the run would otherwise stop. */
  followUp?(message: QueuedUserMessage): void;
  /** Drain mode of pi's steering queue. */
  steeringMode?: QueueDrainMode;
  /** Drain mode of pi's follow-up queue. */
  followUpMode?: QueueDrainMode;
  /** Remove all queued steering messages. */
  clearSteeringQueue?(): void;
  /** Remove all queued follow-up messages. */
  clearFollowUpQueue?(): void;
  /**
   * True when pi's steering or follow-up queue still holds messages. Wake
   * parking cannot use it: it answers "is anything queued", not "is this
   * content still queued".
   */
  hasQueuedMessages?(): boolean;
  /** Context transformation hook installed by Cortex. */
  transformContext?: (messages: unknown[]) => Promise<unknown[]>;
}

/** The methods of {@link PiAgent} that pi's Agent provides. */
type PiAgentMethods = Exclude<keyof PiAgent, keyof AgentStateAccessor | 'transformContext' | 'subscribe'>;

/** Compile-time check: pi's Agent satisfies every method the loop drives. */
type AgentSatisfies<T extends Pick<PiAgent, PiAgentMethods>> = T;
export type PiAgentContractCheck = AgentSatisfies<Pick<Agent, PiAgentMethods>>;

/** Drain mode for pi's steering and follow-up queues. */
export type QueueDrainMode = 'all' | 'one-at-a-time';

/** pi-ai's chat model, as the loop and provider validation hold it. */
export type PiModel = Model<Api>;

export type RegisteredTool = CortexTool;

export interface AgentLoopConstructorOptions {
  enableSubAgentTool?: boolean;
  enableLoadSkillTool?: boolean;
}

export type CacheRetention = 'none' | 'short' | 'long';

/** What the managed factory (AgentLoop.create and sub-agent spawning) builds a loop from. */
export interface ManagedLoopParams {
  cortexConfig: AgentLoopConfig;
  tools?: RegisteredTool[];
  initialBasePrompt?: string;
  initialSystemPrompt?: string;
  constructorOptions?: AgentLoopConstructorOptions;
  missingDependencyMessage: string;
}

// ---------------------------------------------------------------------------
// ThinkingLevel crossing to pi
// ---------------------------------------------------------------------------

/**
 * Cortex's level names are pi's, so this is identity. Keep it as the single
 * crossing point: any remapping here silently changes the requested level.
 */
export function toPiThinkingLevel(level: ThinkingLevel): string {
  return level;
}

/** Narrow a pi level name to Cortex's union, or null if pi added one we don't model. */
export function fromPiThinkingLevel(level: string): ThinkingLevel | null {
  return (THINKING_LEVEL_ORDER as readonly string[]).includes(level)
    ? (level as ThinkingLevel)
    : null;
}

/**
 * Strongest supported level no stronger than `level`; the weakest supported
 * level if the request is below all of them, 'off' if none. Ranks by
 * THINKING_LEVEL_ORDER so an unordered provider list still compares correctly.
 */
export function clampToSupported(
  level: ThinkingLevel,
  supported: readonly ThinkingLevel[],
): ThinkingLevel {
  if (supported.includes(level)) return level;
  if (supported.length === 0) return 'off';

  const rank = (l: ThinkingLevel): number => THINKING_LEVEL_ORDER.indexOf(l);
  const wanted = rank(level);
  const ranked = [...supported].sort((a, b) => rank(a) - rank(b));

  let best: ThinkingLevel | null = null;
  for (const candidate of ranked) {
    if (rank(candidate) <= wanted) best = candidate;
  }
  return best ?? ranked[0]!;
}

/**
 * Narrow pi's per-model level list to Cortex's union, preserving pi's order
 * and dropping anything Cortex does not model. Order matters: callers clamp
 * against this list, so it must run weakest to strongest.
 */
export function fromPiThinkingLevels(levels: readonly string[]): ThinkingLevel[] {
  const mapped: ThinkingLevel[] = [];
  for (const level of levels) {
    const cortexLevel = fromPiThinkingLevel(level);
    if (cortexLevel !== null && !mapped.includes(cortexLevel)) {
      mapped.push(cortexLevel);
    }
  }
  return mapped;
}

/**
 * Thinking support of a pi model, from pi-ai's per-model level list, or a
 * conservative guess from its `reasoning` flag when pi-ai cannot answer.
 */
export async function modelThinkingCapabilities(piModel: PiModel): Promise<ModelThinkingCapabilities> {
  try {
    const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
    const supportedLevels = fromPiThinkingLevels(
      getSupportedThinkingLevels(piModel),
    );
    return {
      supportsThinking: supportedLevels.some(level => level !== 'off'),
      supportsMax: supportedLevels.includes('max'),
      supportedLevels,
    };
  } catch {
    const supportsThinking = piModel.reasoning === true;
    const supportedLevels: ThinkingLevel[] = supportsThinking
      ? ['minimal', 'low', 'medium', 'high']
      : ['off'];
    return {
      supportsThinking,
      supportsMax: false,
      supportedLevels,
    };
  }
}
