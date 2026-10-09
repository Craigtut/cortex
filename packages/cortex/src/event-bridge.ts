/**
 * Event bridge: maps pi-agent-core events to normalized consumer events.
 *
 * Pi-agent-core emits 10 events across 4 scopes (agent, turn, message, tool).
 * The event bridge normalizes these into a consumer-facing event stream for
 * logging, monitoring, and lifecycle hooks.
 *
 * Key mappings:
 *   agent_start  -> loop_start
 *   agent_end    -> loop_end (onLoopComplete fires here)
 *   turn_start   -> turn_start
 *   turn_end     -> turn_end + AgentTextOutput (parse working tags)
 *   message_start  -> response_start
 *   message_update -> response_chunk
 *   message_end    -> response_end
 *   tool_execution_start  -> tool_call_start
 *   tool_execution_update -> tool_call_update
 *   tool_execution_end    -> tool_call_end
 *
 * Child event forwarding:
 *   forwardFrom(childBridge, childTaskId) subscribes to a child agent's
 *   event bridge and re-emits events on this bridge with childTaskId set.
 *   Consumers use event.childTaskId to distinguish parent vs child events.
 *
 * Reference: cortex-architecture.md (Event Bridge section)
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type {
  AgentTextOutput,
  CortexLogger,
  CortexUsage,
  TalkerDeltaPayload,
  UtilityUsagePayload,
} from './types.js';
import { extractPayload } from './event-payloads.js';
import type { CortexEventPayloads } from './event-payloads.js';
import { NOOP_LOGGER } from './noop-logger.js';
import { parseWorkingTags, plainTextOutput } from './working-tags.js';
import { turnText, turnUsage } from './pi-message.js';

export { payloadOf } from './event-payloads.js';
export type { CortexEventPayloads } from './event-payloads.js';

// ---------------------------------------------------------------------------
// Normalized event types emitted to consumers
// ---------------------------------------------------------------------------

export type CortexEventType =
  | 'loop_start'
  | 'loop_end'
  | 'turn_start'
  | 'turn_end'
  | 'response_start'
  | 'response_chunk'
  | 'response_end'
  | 'tool_call_start'
  | 'tool_call_update'
  | 'tool_call_end'
  | 'utility_usage'
  | 'talker_delta';

/**
 * Normalized event data emitted by the event bridge.
 */
export interface CortexEvent {
  type: CortexEventType;
  /** The original pi-agent-core event data (opaque to the bridge). */
  data?: unknown;
  /**
   * The turn's text output, on turn_end events that carry text. Working tags
   * are parsed out only when they are enabled; otherwise all of it is
   * user-facing.
   */
  textOutput?: AgentTextOutput;
  /**
   * Typed payload for tool events (tool_call_start, tool_call_update,
   * tool_call_end), turn_end and loop_end, utility_usage events, and the
   * duplex facade's talker_delta events. Read it with {@link payloadOf},
   * which narrows by event type, instead of casting `data`.
   */
  payload?: CortexEventPayloads[keyof CortexEventPayloads];
  /**
   * Extracted usage data from the LLM response, present on turn_end events
   * (from pi-ai's AssistantMessage.usage) and on utility_usage events (from
   * the direct/utility completion that was just recorded). Centralized so
   * subscribers (BudgetGuard, AgentLoop, consumers) read typed data instead
   * of parsing the opaque `data` field themselves.
   */
  usage?: CortexUsage;
  /**
   * Present when this event originates from a child (sub-agent) event bridge.
   * For a direct child this is the sub-agent's task ID; for an event that was
   * re-forwarded through intermediate bridges it is the path of IDs from this
   * bridge down to the originating loop (e.g. 'task-7/task-42'), so nested
   * origins are preserved instead of overwritten. Absent for parent agent
   * events. Consumers routing per child should use the first path segment.
   *
   * This means "came from a sub-agent" and nothing else: a composite
   * facade's merged stream labels resident-loop origin in `loopPath`, never
   * here, so the long-standing `if (event.childTaskId) return;` consumer
   * idiom keeps working against a duplex facade.
   */
  childTaskId?: string;
  /**
   * Loop-path label on a composite facade's merged stream ('talker',
   * 'reasoner', 'reasoner/task-7' for a sub-agent of the reasoner). Absent
   * on a loop's own bridge; set by {@link forwardLoopFrom}.
   */
  loopPath?: string;
}

/**
 * Callback type for event listeners.
 */
export type CortexEventListener = (event: CortexEvent) => void;

// ---------------------------------------------------------------------------
// Pi-agent-core events
// ---------------------------------------------------------------------------

/** pi-agent-core's agent event, as the bridge receives it. */
export type PiEvent = AgentEvent;

/** A pi-agent-core event type. */
export type PiEventType = AgentEvent['type'];

/**
 * The event side of pi-agent-core's Agent: subscribe, and get back an
 * unsubscribe function.
 */
export interface PiEventSource {
  subscribe(handler: (event: PiEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// Event type mapping
// ---------------------------------------------------------------------------

/**
 * Extract the streaming text delta from a response_chunk event's raw pi
 * data. Pi-agent-core message_update events carry the delta inside
 * `assistantMessageEvent` (type 'text_delta'); the fallbacks cover other
 * provider shapes. Shared by the duplex facade's sanitized delta stream and
 * available to consumers rendering raw chunks.
 */
export function extractResponseChunkText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;

  const assistantEvent = record['assistantMessageEvent'] as Record<string, unknown> | undefined;
  if (assistantEvent && assistantEvent['type'] === 'text_delta') {
    const delta = assistantEvent['delta'];
    if (typeof delta === 'string') return delta;
  }

  if (typeof record['text'] === 'string') return record['text'];
  if (typeof record['delta'] === 'string') return record['delta'];
  if (typeof record['content'] === 'string') return record['content'];
  const delta = record['delta'] as Record<string, unknown> | undefined;
  if (delta && typeof delta['text'] === 'string') return delta['text'];
  return null;
}

const PI_TO_CORTEX_MAP: Partial<Record<PiEventType, CortexEventType>> = {
  agent_start: 'loop_start',
  agent_end: 'loop_end',
  turn_start: 'turn_start',
  turn_end: 'turn_end',
  message_start: 'response_start',
  message_update: 'response_chunk',
  message_end: 'response_end',
  tool_execution_start: 'tool_call_start',
  tool_execution_update: 'tool_call_update',
  tool_execution_end: 'tool_call_end',
};

// ---------------------------------------------------------------------------
// EventBridge
// ---------------------------------------------------------------------------

export class EventBridge {
  private readonly listeners = new Map<CortexEventType, Set<CortexEventListener>>();
  private readonly allListeners = new Set<CortexEventListener>();
  private unsubscribeFromPi: (() => void) | null = null;
  private workingTagsEnabled: boolean;
  private readonly logger: CortexLogger;

  /**
   * Create an EventBridge.
   *
   * @param workingTagsEnabled - Whether to parse working tags on turn_end (default false, as AgentLoop)
   * @param logger - Optional logger for diagnostics (defaults to silent no-op)
   */
  constructor(workingTagsEnabled = false, logger?: CortexLogger) {
    this.workingTagsEnabled = workingTagsEnabled;
    this.logger = logger ?? NOOP_LOGGER;
  }

  /**
   * Wire the bridge to a pi-agent-core Agent's event stream.
   * Stores the unsubscribe function for cleanup.
   *
   * @param source - The pi-agent-core Agent (or any PiEventSource)
   */
  wire(source: PiEventSource): void {
    // Clean up previous wiring if any
    this.unwire();

    this.unsubscribeFromPi = source.subscribe((piEvent: PiEvent) => {
      this.handlePiEvent(piEvent);
    });
  }

  /**
   * Disconnect from the pi-agent-core event stream.
   */
  unwire(): void {
    if (this.unsubscribeFromPi) {
      this.unsubscribeFromPi();
      this.unsubscribeFromPi = null;
    }
  }

  /**
   * Register a listener for a specific event type.
   *
   * @param type - The event type to listen for
   * @param listener - The callback function
   * @returns An unsubscribe function
   */
  on(type: CortexEventType, listener: CortexEventListener): () => void {
    let typeListeners = this.listeners.get(type);
    if (!typeListeners) {
      typeListeners = new Set();
      this.listeners.set(type, typeListeners);
    }
    typeListeners.add(listener);

    return () => {
      typeListeners!.delete(listener);
    };
  }

  /**
   * Register a listener for all event types.
   *
   * @param listener - The callback function
   * @returns An unsubscribe function
   */
  onAll(listener: CortexEventListener): () => void {
    this.allListeners.add(listener);
    return () => {
      this.allListeners.delete(listener);
    };
  }

  /**
   * Forward all events from a child agent's event bridge onto this bridge.
   *
   * Each forwarded event gets `childTaskId` set so consumers can distinguish
   * parent events from child events. An event that already carries a
   * `childTaskId` (the child forwarded it from its own descendant) keeps it,
   * prefixed with this child's ID, so the origin arrives as a path
   * ('task-7/task-42') instead of being overwritten. Returns an unsubscribe
   * function that stops forwarding (call when the child agent completes or
   * is destroyed).
   *
   * @param childBridge - The child agent's EventBridge
   * @param childTaskId - The sub-agent task ID to tag forwarded events with
   * @returns An unsubscribe function
   */
  forwardFrom(childBridge: EventBridge, childTaskId: string): () => void {
    return childBridge.onAll((event) => {
      this.emit({
        ...event,
        childTaskId: event.childTaskId
          ? `${childTaskId}/${event.childTaskId}`
          : childTaskId,
      });
    });
  }

  /**
   * Forward all events from a resident loop's bridge onto this (merged
   * facade) bridge, labeled with the loop's path in the event's own
   * `loopPath` field. `childTaskId` is passed through untouched: it keeps
   * meaning "this event came from a sub-agent", so a main-loop event
   * arrives with `loopPath: 'reasoner'` and no childTaskId, while a
   * sub-agent's arrives with `loopPath: 'reasoner/task-7'` and
   * `childTaskId: 'task-7'`. Reusing the child slot for loop labels would
   * silently kill the `if (event.childTaskId) return;` consumer idiom.
   *
   * @param loopBridge - The resident loop's EventBridge
   * @param loopPath - The loop's path label ('talker', 'reasoner')
   * @returns An unsubscribe function
   */
  forwardLoopFrom(loopBridge: EventBridge, loopPath: string): () => void {
    return loopBridge.onAll((event) => {
      this.emit({
        ...event,
        loopPath: event.childTaskId
          ? `${loopPath}/${event.childTaskId}`
          : loopPath,
      });
    });
  }

  /**
   * Emit a utility_usage event for one direct/utility completion. Cortex
   * calls this once per recorded completion; it also propagates to parent
   * bridges through forwardFrom (with childTaskId set), exactly like pi
   * events, so an aggregate consumer sees a subtree's utility spend.
   */
  emitUtilityUsage(category: string, usage: CortexUsage): void {
    this.emit({
      type: 'utility_usage',
      usage,
      payload: { category } satisfies UtilityUsagePayload,
    });
  }

  /**
   * Emit a sanitized talker-delta event (the duplex facade's voice-safe
   * stream): text with working-tag content removed by holdback buffering,
   * labeled with the conversation loop's path. Voice consumers subscribe to
   * 'talker_delta' instead of routing raw response_chunk to TTS.
   */
  emitTalkerDelta(text: string, loopPath: string): void {
    this.emit({
      type: 'talker_delta',
      loopPath,
      payload: { text } satisfies TalkerDeltaPayload,
    });
  }

  /**
   * Update whether working tags parsing is enabled.
   */
  setWorkingTagsEnabled(enabled: boolean): void {
    this.workingTagsEnabled = enabled;
  }

  /**
   * Clean up all listeners and disconnect from the pi-agent-core event stream.
   */
  destroy(): void {
    this.unwire();
    this.listeners.clear();
    this.allListeners.clear();
  }

  /**
   * Handle a pi-agent-core event by mapping and emitting to consumers.
   */
  private handlePiEvent(piEvent: PiEvent): void {
    const cortexType = PI_TO_CORTEX_MAP[piEvent.type];
    if (!cortexType) {
      return;
    }

    const cortexEvent: CortexEvent = {
      type: cortexType,
      data: piEvent,
    };

    const payload = extractPayload(piEvent);
    if (payload) {
      cortexEvent.payload = payload;
    }

    // For turn_end, extract typed usage and parse working tags
    if (cortexType === 'turn_end') {
      const usage = this.extractUsage(piEvent);
      if (usage) {
        cortexEvent.usage = usage;
      }

      const text = turnText(piEvent);
      if (text) {
        cortexEvent.textOutput = this.workingTagsEnabled ? parseWorkingTags(text) : plainTextOutput(text);
      }
    }

    this.emit(cortexEvent);
  }

  /**
   * Extract typed CortexUsage from a turn_end event, so all subscribers
   * receive clean usage without navigating the opaque event data.
   */
  private extractUsage(piEvent: PiEvent): CortexUsage | null {
    return turnUsage(piEvent, { requireNonZero: true });
  }


  /**
   * Emit a normalized event to all matching listeners.
   * Each listener is wrapped in try/catch so a throwing listener
   * does not prevent subsequent listeners from receiving the event.
   */
  private emit(event: CortexEvent): void {
    // Notify type-specific listeners
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(event);
        } catch (err) {
          this.logger.error('[EventBridge] listener threw', {
            eventType: event.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Notify catch-all listeners
    for (const listener of this.allListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.error('[EventBridge] catch-all listener threw', {
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
