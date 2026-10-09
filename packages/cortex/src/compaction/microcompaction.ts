/**
 * Layer 1: Microcompaction (tool result trimming).
 *
 * Progressively reduces the footprint of old tool results in conversation
 * history. Operates in-memory only via transformContext; never modifies
 * the persisted conversation history (agent.state.messages).
 *
 * Two sub-mechanisms:
 *   1. Insertion-time cap: Truncate large tool results at insertion time.
 *   2. Cache-aware token-offset trimming: When the prompt cache has gone
 *      cold and context utilization is above the trim floor, walk history
 *      from newest to oldest accumulating token offsets. Tool results
 *      within the hot zone stay full; beyond it, bookend size shrinks
 *      linearly across the degradation span; beyond the span, results
 *      become placeholder or clear based on tool category.
 *
 * When a persistResult callback is configured, full content is persisted
 * to disk before any destructive trim (bookend, placeholder, clear) for
 * non-reproducible and computational tools, and the in-context replacement
 * includes the disk path so the agent can Read the content back.
 *
 * References:
 *   - compaction-strategy.md (Layer 1: Tool Result Trimming)
 *   - observational-memory-architecture.md (cache-aware L1)
 *   - tool-result-persistence.md (proactive persistence at execution)
 */

import type { AgentMessage } from '../context-manager.js';
import type { MicrocompactionConfig, ToolCategory } from '../types.js';
import { estimateTokens } from '../token-estimator.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const MICROCOMPACTION_DEFAULTS: MicrocompactionConfig = {
  maxResultTokens: 50_000,
  trimFloorRatio: 0.25,
  prefixTrimRatio: 0.70,
  hotZoneMinTokens: 16_000,
  hotZoneRatio: 0.05,
  bookendMaxChars: 2_000,
  bookendMinChars: 256,
  degradationSpanRatio: 0.40,
  // extendedRetentionMultiplier intentionally undefined; resolved per-engine
  // based on whether a persister is configured (1.0 with, 1.5 without).
};

/** Default extended retention multiplier when no persister is configured. */
const EXTENDED_RETENTION_NO_PERSISTER = 1.5;
/** Default extended retention multiplier when a persister is configured. */
const EXTENDED_RETENTION_WITH_PERSISTER = 1.0;

// ---------------------------------------------------------------------------
// Tool category defaults
// ---------------------------------------------------------------------------

/**
 * Default tool categories for built-in tools.
 * Consumers can override and extend via config.toolCategories.
 */
const DEFAULT_TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: 'rereadable',
  Glob: 'rereadable',
  Grep: 'rereadable',
  WebFetch: 'non-reproducible',
  Bash: 'non-reproducible',
  SubAgent: 'ephemeral',
  TaskOutput: 'ephemeral',
};

// ---------------------------------------------------------------------------
// Trim state cache
// ---------------------------------------------------------------------------

/**
 * Trim instruction for a single tool result message.
 * Describes how to transform the message content for the LLM context.
 */
export type TrimAction =
  | { kind: 'full' }
  | { kind: 'bookend'; headChars: number; tailChars: number; originalTokens: number }
  | { kind: 'placeholder'; toolName: string; preview: string }
  | { kind: 'clear' };

/**
 * Cached trim state. Keyed on history length and a coarse utilization band
 * so the engine can replay identical trim decisions across consecutive
 * transformContext calls when the underlying conversation hasn't changed
 * meaningfully.
 */
export interface TrimState {
  /** History length at the time the state was computed. */
  historyLength: number;
  /** Coarse utilization band: floor(usageRatio * 10). */
  utilizationBand: number;
  /** Map from conversation history index to trim action. */
  actions: Map<number, TrimAction>;
}

// ---------------------------------------------------------------------------
// Insertion-time cap (Tier 1)
// ---------------------------------------------------------------------------

/**
 * Cap a tool result at insertion time. If the result exceeds maxResultTokens,
 * truncate to head + tail bookend format using bookendMaxChars per side.
 *
 * This runs at insertion, NOT in transformContext. The truncated result is
 * stored in conversation history.
 */
export function capToolResult(
  content: string,
  config: Pick<MicrocompactionConfig, 'maxResultTokens' | 'bookendMaxChars'>,
): string {
  const tokens = estimateTokens(content);
  if (tokens <= config.maxResultTokens) {
    return content;
  }

  const headSize = config.bookendMaxChars;
  const tailSize = config.bookendMaxChars;

  // Ensure we don't exceed the content length
  if (headSize + tailSize >= content.length) {
    return content;
  }

  const head = content.slice(0, headSize);
  const tail = content.slice(-tailSize);
  const trimmedTokens = tokens - estimateTokens(head) - estimateTokens(tail);

  return `${head}\n\n... [~${trimmedTokens} tokens trimmed at insertion] ...\n\n${tail}`;
}

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

/**
 * Render tool call arguments as a compact JSON string.
 * Returns '' for empty/missing arguments. Full fidelity (no truncation):
 * the output feeds token estimation and Layer 2 summarization, both of
 * which need the real size and content of the arguments.
 */
function formatToolCallArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args;
  try {
    const json = JSON.stringify(args);
    return json === '{}' || json === undefined ? '' : json;
  } catch {
    return String(args);
  }
}

/**
 * Extract the text content from a message's content field.
 * Handles both string content and content arrays.
 *
 * For content arrays:
 *   - 'text' parts (and legacy 'tool_result' parts with a text field)
 *     contribute their text verbatim.
 *   - 'toolCall' parts (pi-ai assistant tool call blocks) render as
 *     "[Tool call: <name> <args JSON>]" so tool activity is visible to
 *     the Layer 2 summarizer and counted by token estimation. A turn
 *     that is purely tool calls no longer renders empty.
 */
export function extractTextContent(message: AgentMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  // Guard: content may be undefined/null (corrupted toolResult) or empty
  if (!Array.isArray(message.content) || message.content.length === 0) {
    return '';
  }

  const segments: string[] = [];
  for (const part of message.content) {
    if (part.type === 'toolCall') {
      const name = typeof part['name'] === 'string' ? part['name'] : 'unknown';
      const args = formatToolCallArgs(part['arguments']);
      segments.push(args ? `[Tool call: ${name} ${args}]` : `[Tool call: ${name}]`);
      continue;
    }
    if (typeof part.text === 'string') {
      segments.push(part.text);
    }
  }
  return segments.join('\n');
}

/**
 * Check if a message is a tool result.
 * Pi-agent-core stores tool results as messages with content arrays
 * containing tool_result type parts.
 */
export function isToolResultMessage(message: AgentMessage): boolean {
  if (message.role === 'toolResult') {
    return true;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some(part => part.type === 'tool_result');
}

/**
 * Check if an assistant message contains a tool call.
 * Real pi-ai assistant messages carry tool calls as content blocks of
 * type 'toolCall' ({ type: 'toolCall', id, name, arguments }).
 */
export function isToolCallMessage(message: AgentMessage): boolean {
  if (message.role !== 'assistant') {
    return false;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.some(part => part.type === 'toolCall');
}

/**
 * Extract the tool name from a tool result or tool call message.
 * Returns null if the message is not a tool-related message.
 */
export function extractToolName(message: AgentMessage): string | null {
  if (typeof message.toolName === 'string') {
    return message.toolName;
  }

  if (!Array.isArray(message.content)) {
    return null;
  }

  for (const part of message.content) {
    if (part.type === 'toolCall' && typeof part['name'] === 'string') {
      return part['name'];
    }
    if (part.type === 'tool_result' && typeof part['name'] === 'string') {
      return part['name'];
    }
  }

  return null;
}

/**
 * Get the effective tool category for a tool name.
 */
export function getToolCategory(
  toolName: string,
  customCategories?: Record<string, ToolCategory>,
): ToolCategory | undefined {
  // Custom categories take precedence
  if (customCategories?.[toolName]) {
    return customCategories[toolName];
  }
  return DEFAULT_TOOL_CATEGORIES[toolName];
}

// ---------------------------------------------------------------------------
// Token-offset trimming (cache-aware, progressive degradation)
// ---------------------------------------------------------------------------

/**
 * Compute the effective hot zone size in tokens.
 * Protect recent results, but leave at least half of a small budget available
 * for older history to degrade. The preferred minimum must not protect the
 * entire context from trimming.
 */
export function computeHotZone(
  contextWindow: number,
  config: Pick<MicrocompactionConfig, 'hotZoneMinTokens' | 'hotZoneRatio'>,
): number {
  return Math.min(contextWindow * 0.5, Math.max(config.hotZoneMinTokens, contextWindow * config.hotZoneRatio));
}

/**
 * Resolve the effective extended retention multiplier. When the config value
 * is undefined, use 1.0 if a persister is configured (content recoverable
 * from disk) or 1.5 if not (content is truly lost on trim).
 */
export function resolveExtendedRetentionMultiplier(config: MicrocompactionConfig): number {
  if (typeof config.extendedRetentionMultiplier === 'number') {
    return config.extendedRetentionMultiplier;
  }
  return config.persistResult
    ? EXTENDED_RETENTION_WITH_PERSISTER
    : EXTENDED_RETENTION_NO_PERSISTER;
}

/**
 * Determine the trim action for a tool result based on its token offset
 * from the most recent message.
 *
 * @param message - The tool result message
 * @param tokenOffset - Cumulative tokens between this message and the end of history
 * @param hotZone - Hot zone size in tokens (preserved fully)
 * @param degradationSpan - Degradation span in tokens (bookend size shrinks across this span)
 * @param config - Microcompaction config
 * @param extendedMultiplier - Resolved extended retention multiplier for non-reproducible tools
 */
export function computeAction(
  message: AgentMessage,
  tokenOffset: number,
  hotZone: number,
  degradationSpan: number,
  config: MicrocompactionConfig,
  extendedMultiplier: number,
): TrimAction {
  const toolName = extractToolName(message);
  const category = toolName ? getToolCategory(toolName, config.toolCategories) : undefined;

  // Non-reproducible tools get an extended hot zone
  const effectiveHotZone = category === 'non-reproducible'
    ? hotZone * extendedMultiplier
    : hotZone;

  // Within hot zone: keep full
  if (tokenOffset < effectiveHotZone) {
    return { kind: 'full' };
  }

  const distanceBeyondHotZone = tokenOffset - effectiveHotZone;
  const t = degradationSpan > 0
    ? Math.min(distanceBeyondHotZone / degradationSpan, 1.0)
    : 1.0;

  // Within degradation span: interpolated bookend
  if (t < 1.0) {
    const bookendChars = Math.max(
      config.bookendMinChars,
      Math.round(config.bookendMaxChars * (1 - t) + config.bookendMinChars * t),
    );
    const content = extractTextContent(message);
    const tokens = estimateTokens(content);
    return {
      kind: 'bookend',
      headChars: bookendChars,
      tailChars: bookendChars,
      originalTokens: tokens,
    };
  }

  // Beyond degradation span: placeholder or clear based on tool category
  if (category === 'ephemeral') {
    return { kind: 'clear' };
  }

  // Default for rereadable, non-reproducible, computational, and unknown:
  // placeholder preserves the breadcrumb of what was tried.
  const content = extractTextContent(message);
  const preview = content.slice(0, 80).replace(/\n/g, ' ').trim();
  return {
    kind: 'placeholder',
    toolName: toolName ?? 'unknown',
    preview,
  };
}

/**
 * Compute the full trim state by walking history from newest to oldest,
 * accumulating token offsets.
 */
export function computeTrimState(
  history: AgentMessage[],
  contextWindow: number,
  usageRatio: number,
  config: MicrocompactionConfig,
): TrimState {
  const actions = new Map<number, TrimAction>();
  const hotZone = computeHotZone(contextWindow, config);
  const degradationSpan = contextWindow * config.degradationSpanRatio;
  const extendedMultiplier = resolveExtendedRetentionMultiplier(config);

  let tokenOffset = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;

    if (isToolResultMessage(message)) {
      const action = computeAction(
        message,
        tokenOffset,
        hotZone,
        degradationSpan,
        config,
        extendedMultiplier,
      );
      if (action.kind !== 'full') {
        actions.set(i, action);
      }
    }

    // Accumulate tokens regardless of message type so non-tool-result
    // messages (assistant text, user messages) push older results further
    // down the timeline correctly.
    tokenOffset += estimateTokens(extractTextContent(message));
  }

  return {
    historyLength: history.length,
    utilizationBand: Math.floor(usageRatio * 10),
    actions,
  };
}

/**
 * Apply a bookend trim to content.
 */
export function applyBookend(
  content: string,
  headChars: number,
  tailChars: number,
  originalTokens: number,
): string {
  if (headChars + tailChars >= content.length) {
    return content;
  }

  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);
  const trimmedTokens = originalTokens - estimateTokens(head) - estimateTokens(tail);

  return `${head}\n\n... [~${trimmedTokens} tokens trimmed] ...\n\n${tail}`;
}

/**
 * Apply a bookend trim with a persisted file reference. The agent can
 * Read the path to recover the trimmed middle portion.
 */
export function applyBookendWithPersistence(
  content: string,
  headChars: number,
  tailChars: number,
  originalTokens: number,
  toolName: string,
  path: string,
): string {
  const totalChars = content.length;
  const header = `[Result persisted: ${path} (${totalChars} chars, ~${originalTokens} tokens) -- ${toolName}]`;

  if (headChars + tailChars >= content.length) {
    return `${header}\n\n${content}`;
  }

  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);
  const trimmedTokens = originalTokens - estimateTokens(head) - estimateTokens(tail);

  return `${header}\n\n${head}\n\n... [~${trimmedTokens} tokens trimmed; full content at ${path}] ...\n\n${tail}`;
}

/**
 * Compute the replacement text for a trim action (no persistence).
 */
function getTrimmedText(content: string, action: TrimAction): string {
  if (action.kind === 'bookend') {
    return applyBookend(content, action.headChars, action.tailChars, action.originalTokens);
  }
  if (action.kind === 'placeholder') {
    return `[Tool result trimmed -- ${action.toolName}: "${action.preview}" -- see assistant response below for findings]`;
  }
  if (action.kind === 'clear') {
    return '[Tool result cleared]';
  }
  return content;
}

/**
 * Apply a trim action to a message, returning a new message.
 *
 * Preserves the content array structure for tool_result messages so that
 * tool_use_id linkage is maintained. The Anthropic API requires every
 * tool_use block to have a matching tool_result with the same tool_use_id;
 * replacing the content with a plain string would break this contract.
 */
export function applyTrimAction(message: AgentMessage, action: TrimAction): AgentMessage {
  if (action.kind === 'full') {
    return message;
  }

  // If the message has a structured content array (e.g., runtime toolResult
  // messages with text parts, or legacy tool_result parts), preserve the array
  // structure and only replace text within each part.
  if (Array.isArray(message.content) && message.content.length > 0) {
    const newContent = message.content.map(part => {
      const shouldTrim = typeof part.text === 'string' && (
        part.type === 'tool_result' ||
        (part.type === 'text' && isToolResultMessage(message))
      );
      if (!shouldTrim) {
        return part;
      }
      const trimmed = getTrimmedText(part.text as string, action);
      return { ...part, text: trimmed };
    });
    return { ...message, content: newContent };
  }

  // Plain string content: replace directly (backward compat for non-tool messages)
  const content = typeof message.content === 'string' ? message.content : '';
  const trimmed = getTrimmedText(content, action);
  return { ...message, content: trimmed };
}

// ---------------------------------------------------------------------------
// MicrocompactionEngine
// ---------------------------------------------------------------------------

/**
 * Stateful engine for microcompaction. Caches trim state across consecutive
 * calls with the same history length and utilization band so the same trim
 * decisions are replayed when the conversation hasn't changed.
 */
export class MicrocompactionEngine {
  private readonly config: MicrocompactionConfig;
  private cachedState: TrimState | null = null;

  constructor(config: Partial<MicrocompactionConfig> = {}) {
    this.config = { ...MICROCOMPACTION_DEFAULTS, ...config };
  }

  /**
   * Whether a persist callback is configured.
   */
  get hasPersistCallback(): boolean {
    return typeof this.config.persistResult === 'function';
  }

  /**
   * Get the current config (for testing/inspection).
   */
  getConfig(): MicrocompactionConfig {
    return this.config;
  }

  /**
   * Cap a tool result at insertion time.
   */
  capAtInsertion(content: string): string {
    return capToolResult(content, this.config);
  }

  /**
   * Apply microcompaction to conversation history messages.
   * Called inside transformContext. Returns a new array; never modifies the input.
   *
   * Cache-aware gating:
   *   - When `cacheCold` is false (cache warm), L1 is dormant and history
   *     is returned untouched. This preserves cache hits during active use.
   *   - When `cacheCold` is true, L1 may run if utilization is at or above
   *     `trimFloorRatio` (default 25%).
   *
   * Token-offset trimming:
   *   Walks history from newest to oldest. Tool results within the hot zone
   *   stay full. Beyond the hot zone, bookend size shrinks linearly across
   *   the degradation span. Beyond the span, results become placeholder or
   *   clear based on tool category.
   *
   * Persistence:
   *   When a persistResult callback is configured, full content is saved to
   *   disk before any destructive action (bookend, placeholder, clear) for
   *   non-reproducible and computational tools. The in-context replacement
   *   includes the disk path so the agent can Read the content back.
   *
   * @param history - Conversation history messages (post-slot region)
   * @param contextWindow - Total context window size in tokens
   * @param currentTokens - Current estimated token count
   * @param options.cacheCold - Whether the prompt cache has expired (or is unused)
   * @returns Potentially trimmed conversation history
   */
  async apply(
    history: AgentMessage[],
    contextWindow: number,
    currentTokens: number,
    options: { cacheCold: boolean } = { cacheCold: true },
  ): Promise<AgentMessage[]> {
    if (contextWindow <= 0 || history.length === 0) {
      return history;
    }

    // Gate 1: Cache awareness. When the cache is warm, L1 is dormant.
    if (!options.cacheCold) {
      return history;
    }

    // Gate 2: Trim floor. Below this utilization, no trimming even if cold.
    const usageRatio = currentTokens / contextWindow;
    if (usageRatio < this.config.trimFloorRatio) {
      return history;
    }

    const utilizationBand = Math.floor(usageRatio * 10);

    // Replay cached state when nothing meaningful has changed.
    const canReplay = this.cachedState
      && this.cachedState.historyLength === history.length
      && this.cachedState.utilizationBand === utilizationBand;

    if (!canReplay) {
      this.cachedState = computeTrimState(history, contextWindow, usageRatio, this.config);
    }

    if (!this.cachedState || this.cachedState.actions.size === 0) {
      return history;
    }

    const result: AgentMessage[] = [];
    for (let i = 0; i < history.length; i++) {
      const action = this.cachedState.actions.get(i);
      if (action) {
        const persisted = await this.maybePersistBeforeTrim(history[i]!, action, i);
        result.push(persisted);
      } else {
        result.push(history[i]!);
      }
    }

    return result;
  }

  /**
   * If a persistResult callback is configured and the action is destructive
   * (bookend, placeholder, or clear), persist each non-reproducible or
   * computational tool_result part's content to disk individually and
   * replace each part's text with a path-referencing representation.
   *
   * Multi-part messages (from parallel tool calls) get per-part treatment so
   * each part's disk path maps back to its own content.
   *
   * Parts that don't qualify for persistence (rereadable, ephemeral, no
   * callback, or non-tool-result parts) still get the standard trim action
   * applied to their own text.
   */
  private async maybePersistBeforeTrim(
    message: AgentMessage,
    action: TrimAction,
    messageIndex: number,
  ): Promise<AgentMessage> {
    if (action.kind === 'full') {
      return message;
    }

    // No persister: fall back entirely to the standard per-part trim.
    if (!this.config.persistResult) {
      return applyTrimAction(message, action);
    }

    // String content: treat as a single unit (non-tool-result message).
    if (!Array.isArray(message.content) || message.content.length === 0) {
      return applyTrimAction(message, action);
    }

    // Per-part processing: each tool result text part gets its own persistence
    // decision and its own replacement text.
    const messageToolName = typeof message.toolName === 'string' ? message.toolName : null;
    const newParts = await Promise.all(message.content.map(async part => {
      const isLegacyToolResult = part.type === 'tool_result' && typeof part.text === 'string';
      const isRuntimeToolResultText = message.role === 'toolResult' && part.type === 'text' && typeof part.text === 'string';
      const isToolResultText = isLegacyToolResult || isRuntimeToolResultText;
      if (!isToolResultText) {
        return part;
      }

      const partText = part.text as string;
      const toolName = typeof part['name'] === 'string' ? part['name'] as string : messageToolName;
      const category = toolName ? getToolCategory(toolName, this.config.toolCategories) : undefined;

      // Only persist non-reproducible and computational parts.
      const shouldPersist = category === 'non-reproducible' || category === 'computational';
      if (!shouldPersist) {
        return { ...part, text: getTrimmedText(partText, action) };
      }

      let path: string;
      try {
        path = await this.config.persistResult!(partText, {
          toolName: toolName ?? 'unknown',
          messageIndex,
          category,
        });
      } catch {
        // Persist failed; fall back to standard trim for this part.
        return { ...part, text: getTrimmedText(partText, action) };
      }

      const persistedText = formatPersistedReplacement(
        partText,
        action,
        toolName ?? 'unknown',
        path,
      );
      return { ...part, text: persistedText };
    }));

    return { ...message, content: newParts };
  }

  /**
   * Reset the cached trim state. Called after Layer 2 compaction
   * replaces conversation history.
   */
  resetCache(): void {
    this.cachedState = null;
  }

  /**
   * Get the cached state (for testing/inspection).
   */
  getCachedState(): TrimState | null {
    return this.cachedState;
  }
}

// ---------------------------------------------------------------------------
// Persistence formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format the in-context replacement when content has been persisted to disk.
 * - bookend: header + head + middle marker + tail
 * - placeholder: one-line breadcrumb with disk path
 * - clear: minimal marker with disk path
 */
function formatPersistedReplacement(
  content: string,
  action: TrimAction,
  toolName: string,
  path: string,
): string {
  if (action.kind === 'bookend') {
    return applyBookendWithPersistence(
      content, action.headChars, action.tailChars, action.originalTokens, toolName, path,
    );
  }
  if (action.kind === 'placeholder') {
    return `[Tool result persisted -- ${toolName}: "${action.preview}" -- use Read on ${path} for full content]`;
  }
  // clear
  return `[Tool result persisted -- ${toolName} -- use Read on ${path} for full content]`;
}
