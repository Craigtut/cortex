/**
 * What history costs in tokens, two ways, both owned here.
 *
 * In context: what a message adds to a request, on pi-ai's estimate. That
 * counts images, a system message's sections and tool declarations, and
 * tool calls, and leaves thinking out, since providers mostly drop it from
 * earlier turns. The verbatim tail, the swap's accounting, Layer 1's hot
 * zone, the context estimate and the view cut measure history this way.
 *
 * To the observer: what the observer reads of a message, its text. System
 * messages are not conversation and an image's bytes are not text, so
 * neither counts. Observer pieces, the buffering and digestion floors, and a
 * chunk's observed size measure history this way, so a tool declaration
 * never wakes the observer for a piece it would not read.
 *
 * Restored history can hold shapes pi's estimate was not written for
 * (string assistant content, legacy `tool_result` parts, missing content,
 * custom roles); those are measured by their text, as before.
 */

import type { Message } from '@earendil-works/pi-ai';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { AgentMessage } from '../context-manager.js';
import { contentPartsOf, withContent } from '../pi-message.js';
import type { LoosePart } from '../pi-message.js';
import { isSystemMessage } from '../system-transcript.js';
import { estimateTokens } from '../token-estimator.js';
import { extractTextContent } from './tool-messages.js';

/** Estimated tokens `message` adds to a request. */
export function messageTokens(message: AgentMessage): number {
  const piMessage = asPiMessage(message);
  return piMessage ? estimateMessageTokens(piMessage) : textTokens(message);
}

/** Estimated tokens `messages` add to a request. */
export function historyTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

/** Estimated tokens of what the observer reads of `message`. */
export function observableTokens(message: AgentMessage): number {
  return isSystemMessage(message) ? 0 : textTokens(message);
}

/** Estimated tokens of what the observer reads of `messages`. */
export function observableHistoryTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((sum, message) => sum + observableTokens(message), 0);
}

function textTokens(message: AgentMessage): number {
  return estimateTokens(extractTextContent(message));
}

/**
 * `message` as pi's estimate reads it, thinking removed, or null when its
 * shape is not one the estimate handles.
 */
function asPiMessage(message: AgentMessage): Message | null {
  const raw = message as unknown as Record<string, unknown>;
  switch (raw['role']) {
    case 'user':
    case 'toolResult':
      return typeof raw['content'] === 'string' || everyPart(message, isTextOrImagePart) ? (message as Message) : null;
    case 'assistant': {
      if (!everyPart(message, isAssistantPart)) return null;
      const parts = contentPartsOf(message)!;
      return (parts.some((part) => part['type'] === 'thinking')
        ? withContent(message, parts.filter((part) => part['type'] !== 'thinking'))
        : message) as Message;
    }
    case 'system':
      return isSystemShape(raw) ? (message as Message) : null;
    default:
      return null;
  }
}

function everyPart(message: AgentMessage, isPart: (part: LoosePart) => boolean): boolean {
  return contentPartsOf(message)?.every(isPart) ?? false;
}

function isTextPart(part: LoosePart): boolean {
  return part['type'] === 'text' && typeof part['text'] === 'string';
}

function isTextOrImagePart(part: LoosePart): boolean {
  return isTextPart(part) || part['type'] === 'image';
}

function isAssistantPart(part: LoosePart): boolean {
  return isTextPart(part)
    || (part['type'] === 'thinking' && typeof part['thinking'] === 'string')
    || (part['type'] === 'toolCall' && typeof part['name'] === 'string');
}

function isSystemShape(raw: Record<string, unknown>): boolean {
  const content = raw['content'];
  const sections = raw['sections'];
  const optionalArray = (value: unknown): boolean => value === undefined || Array.isArray(value);
  return (typeof content === 'string' || (Array.isArray(content) && content.every((part) => isTextPart(part as LoosePart))))
    && (sections === undefined || (typeof sections === 'object' && sections !== null
      && Object.values(sections).every((value) => value === null || typeof value === 'string')))
    && optionalArray(raw['toolsAdded'])
    && optionalArray(raw['toolsRemoved']);
}
