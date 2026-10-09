/**
 * ContextManager: slot-based persistent context + ephemeral per-call injection.
 *
 * Manages the content an agent sees through two mechanisms:
 * - **Slots**: Named content blocks at the start of the message array.
 *   Persistent, updated immediately via setSlot(). Ordered by stability
 *   (most stable first) for prefix cache optimization.
 * - **Ephemeral context**: Per-call content injected via transformContext.
 *   Never stored in agent.state.messages. Rebuilt every LLM call.
 *
 * Message array layout:
 *   [SYSTEM HEAD (0)] [SLOT REGION (1..N)] [CONVERSATION HISTORY] [EPHEMERAL (in transformContext)] [PROMPT]
 *
 * The head is pi's leading system message (prompt and initial tools). History
 * may carry later system messages inline (see system-transcript.ts), so the
 * history region starts at {@link ContextManager.historyStart}, not at the
 * slot count.
 *
 * Reference: context-manager.md
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { emptySystemHead, isSystemMessage } from './system-transcript.js';
import type { ContextManagerConfig } from './types.js';

// ---------------------------------------------------------------------------
// pi-agent-core's transcript types
// ---------------------------------------------------------------------------

/**
 * One entry of pi's transcript (`Agent.state.messages`): pi's own message
 * union. Messages restored from a consumer's persisted history are not
 * guaranteed to match it; the readers in pi-message.ts check what they read.
 */
export type { AgentMessage } from '@earendil-works/pi-agent-core';

/**
 * The part of pi-agent-core's agent state the loop reads and writes. A
 * port rather than pi's `AgentState` so a scripted test agent can supply
 * it; pi's own state satisfies it (checked in agent-loop/pi-agent.ts).
 */
export interface AgentStateAccessor {
  state: {
    messages: AgentMessage[];
    /** Read-only in pi: the prompt replayed from the transcript's system messages. */
    readonly systemPrompt?: string;
    model?: unknown;
    thinkingLevel?: string;
    tools?: unknown[];
    error?: string;
    errorMessage?: string;
  };
}

/**
 * What a transformContext hook sees of one request: pi's transcript for it
 * (`messages`) plus the agent state that shapes it. Cortex's own type; pi's
 * `AgentContext` carries only messages and tools.
 */
export interface AgentContext {
  systemPrompt: string;
  model: unknown;
  messages: AgentMessage[];
  tools: unknown[];
  thinkingLevel: string;
}

// ---------------------------------------------------------------------------
// ContextManager
// ---------------------------------------------------------------------------

/** Where pi's leading system message sits; the slots follow it. */
export const SYSTEM_HEAD_INDEX = 0;

export class ContextManager {
  private readonly agent: AgentStateAccessor;
  private readonly slotNames: readonly string[];
  private readonly slotIndexMap: ReadonlyMap<string, number>;
  private ephemeralContent: string | null = null;

  /**
   * Create a ContextManager.
   *
   * @param agent - The pi-agent-core Agent instance (or any object with state.messages)
   * @param config - Configuration with ordered slot names
   */
  constructor(agent: AgentStateAccessor, config: ContextManagerConfig) {
    this.agent = agent;
    this.slotNames = Object.freeze([...config.slots]);

    // Build index map: slot name -> position in messages array (behind the head)
    const indexMap = new Map<string, number>();
    for (let i = 0; i < config.slots.length; i++) {
      const name = config.slots[i]!;
      if (indexMap.has(name)) {
        throw new Error(`Duplicate slot name: "${name}"`);
      }
      indexMap.set(name, SYSTEM_HEAD_INDEX + 1 + i);
    }
    this.slotIndexMap = indexMap;

    // Put the head and the slot positions in place so every index is fixed
    // from construction on.
    this.initializeLayout();
  }

  /**
   * The number of context slots.
   */
  get slotCount(): number {
    return this.slotNames.length;
  }

  /**
   * Index of the first history message: past the system head and the slots.
   * Everything before it is the fixed prefix.
   */
  get historyStart(): number {
    return SYSTEM_HEAD_INDEX + 1 + this.slotNames.length;
  }

  /**
   * The ordered slot names (frozen copy).
   */
  get slots(): readonly string[] {
    return this.slotNames;
  }

  /**
   * Update a slot's content. Immediately updates the corresponding
   * message in agent.state.messages at the slot's position.
   *
   * @param name - The slot name (must match a name from the config)
   * @param content - The raw string content (consumer handles formatting)
   * @throws Error if the slot name is not recognized
   */
  setSlot(name: string, content: string): void {
    const index = this.slotIndexMap.get(name);
    if (index === undefined) {
      throw new Error(`Unknown slot name: "${name}". Valid slots: ${[...this.slotIndexMap.keys()].join(', ')}`);
    }

    this.agent.state.messages[index] = {
      role: 'user',
      content,
      timestamp: Date.now(),
    };
  }

  /**
   * Read current slot content.
   *
   * @param name - The slot name
   * @returns The slot's content string, or null if the slot has not been set
   * @throws Error if the slot name is not recognized
   */
  getSlot(name: string): string | null {
    const index = this.slotIndexMap.get(name);
    if (index === undefined) {
      throw new Error(`Unknown slot name: "${name}". Valid slots: ${[...this.slotIndexMap.keys()].join(', ')}`);
    }

    const message = this.agent.state.messages[index];
    if (!message) {
      return null;
    }

    // Content can be a string or a content array
    if (typeof message.content === 'string') {
      return message.content;
    }

    // For content arrays, concatenate text parts
    return message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }

  /**
   * Set ephemeral content for the next LLM call(s).
   * Injected at the end of the message array inside the transformContext hook.
   * Never written to agent.state.messages.
   * Pass null to clear.
   *
   * @param content - The ephemeral content string, or null to clear
   */
  setEphemeral(content: string | null): void {
    this.ephemeralContent = content;
  }

  /**
   * Get the current ephemeral content.
   *
   * @returns The ephemeral content, or null if not set
   */
  getEphemeral(): string | null {
    return this.ephemeralContent;
  }

  /**
   * Returns a transformContext hook function that appends ephemeral content.
   *
   * The hook is composable: the consumer can chain it with other transformContext
   * logic (compaction, skill buffer, etc.).
   *
   * The ephemeral content is appended as a user-role message at the end of
   * the messages array, after all conversation history but before the prompt.
   * This placement ensures it does not invalidate the prefix cache for
   * content above it.
   *
   * @returns A function suitable for use as a transformContext hook
   */
  getTransformContextHook(): (context: AgentContext) => AgentContext {
    return (context: AgentContext): AgentContext => {
      if (this.ephemeralContent === null) {
        return context;
      }

      // Append ephemeral content as a user-role message at the end
      return {
        ...context,
        messages: [
          ...context.messages,
          {
            role: 'user' as const,
            content: this.ephemeralContent,
            timestamp: Date.now(),
          },
        ],
      };
    };
  }

  /**
   * Ensure the system head at index 0 (pi creates one only for a non-empty
   * initial prompt) and empty user-role messages at every slot position.
   */
  private initializeLayout(): void {
    const messages = this.agent.state.messages;
    if (!isSystemMessage(messages[SYSTEM_HEAD_INDEX])) {
      messages.unshift(emptySystemHead());
    }
    // Not the historyStart getter: this runs inside the constructor, where
    // a subclass override (the duplex fan-out view) is not initialized yet.
    const historyStart = SYSTEM_HEAD_INDEX + 1 + this.slotNames.length;
    while (messages.length < historyStart) {
      messages.push({
        role: 'user',
        content: '',
        timestamp: 0,
      });
    }
  }
}
