/**
 * Typed event payloads: what each normalized event type carries in
 * CortexEvent.payload, extracted once from pi's raw event by the bridge
 * that emits it, and read back narrowed by type through payloadOf(). The
 * one place a raw pi event is cast, so no subscriber casts `event.data`.
 */

import type { CortexEvent, PiEvent } from './event-bridge.js';
import type {
  LoopEndPayload,
  TalkerDeltaPayload,
  ToolCallEndPayload,
  ToolCallStartPayload,
  ToolCallUpdatePayload,
  ToolContentDetails,
  LoopMessageView,
  TurnEndPayload,
  UtilityUsagePayload,
} from './types.js';
import type { MemoryEventPayload } from './compaction/observational/types.js';

/** The payload each event type carries. */
export interface CortexEventPayloads {
  tool_call_start: ToolCallStartPayload;
  tool_call_update: ToolCallUpdatePayload;
  tool_call_end: ToolCallEndPayload;
  turn_end: TurnEndPayload;
  loop_end: LoopEndPayload;
  utility_usage: UtilityUsagePayload;
  talker_delta: TalkerDeltaPayload;
  memory: MemoryEventPayload;
}

/**
 * The event's payload when it is a `type` event, typed for that type, else
 * undefined.
 */
export function payloadOf<T extends keyof CortexEventPayloads>(
  event: CortexEvent,
  type: T,
): CortexEventPayloads[T] | undefined {
  if (event.type !== type) return undefined;
  return event.payload as CortexEventPayloads[T] | undefined;
}

/** The typed payload a pi event carries, if its type has one. */
export function extractPayload(piEvent: PiEvent): CortexEvent['payload'] {
  switch (piEvent.type) {
    case 'turn_end': {
      const message = messageView(piEvent.message);
      return (message ? { message } : {}) satisfies TurnEndPayload;
    }
    case 'agent_end': {
      const messages = piEvent.messages
        .map(messageView)
        .filter((message): message is LoopMessageView => message !== undefined);
      return { messages } satisfies LoopEndPayload;
    }
    case 'tool_execution_start':
      return {
        toolCallId: piEvent.toolCallId,
        toolName: piEvent.toolName,
        args: toolArgs(piEvent.args),
      } satisfies ToolCallStartPayload;
    case 'tool_execution_update':
      return {
        toolCallId: piEvent.toolCallId,
        toolName: piEvent.toolName,
        args: toolArgs(piEvent.args),
        partialResult: toolContent(piEvent.partialResult),
      } satisfies ToolCallUpdatePayload;
    case 'tool_execution_end':
      return toolEndPayload(piEvent);
    default:
      return undefined;
  }
}

function messageView(raw: unknown): LoopMessageView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const source = raw as Record<string, unknown>;
  const message: LoopMessageView = {};
  if (typeof source['role'] === 'string') message.role = source['role'];
  if ('content' in source) message.content = source['content'];
  if (typeof source['stopReason'] === 'string') message.stopReason = source['stopReason'];
  const errorMessage = source['errorMessage'];
  if (errorMessage != null) message.errorMessage = String(errorMessage);
  return message;
}

/** pi types tool arguments and results as `any`: whatever the tool produced. */
function toolArgs(args: unknown): Record<string, unknown> {
  return (args ?? {}) as Record<string, unknown>;
}

function toolContent(result: unknown): ToolContentDetails<unknown> {
  return (result as ToolContentDetails<unknown> | undefined) ?? { content: [], details: {} };
}

function toolEndPayload(piEvent: Extract<PiEvent, { type: 'tool_execution_end' }>): ToolCallEndPayload {
  const result = toolContent(piEvent.result);
  const payload: ToolCallEndPayload = {
    toolCallId: piEvent.toolCallId,
    toolName: piEvent.toolName,
    result,
    // What execute() took; absent when the tool never ran (unknown tool,
    // invalid arguments, a blocked call).
    durationMs: piEvent.durationMs ?? 0,
    isError: piEvent.isError,
  };
  if (piEvent.isError) {
    // pi puts the failure text in the result content, for thrown errors and
    // for results the tool flagged `isError` alike.
    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    payload.error = text.length > 0 ? text : 'unknown error';
  }
  return payload;
}
