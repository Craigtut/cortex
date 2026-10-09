/**
 * Working tags parser.
 *
 * Separates agent text into user-facing and working (internal reasoning)
 * content based on <working> XML tag delimiters.
 *
 * Parsing rules:
 * - Tags are flat delimiters: <working> opens, </working> closes. No nesting.
 * - Multiple <working> blocks are concatenated (newline-separated) in `working`.
 * - Whitespace between closing </working> tag and subsequent text is normalized.
 * - Unclosed <working> tag: all content after the opening tag is treated as working.
 * - Simple regex, not a full XML parser.
 *
 * `<thinking>` is accepted as an alias everywhere `<working>` is: models with
 * reasoning disabled routinely fall back to their trained scratchpad tag
 * instead of the prompted one (observed on the duplex talker, which runs
 * thinkingLevel 'off' and does its thinking in-band), and an unrecognized
 * delimiter leaks the reasoning verbatim to the consumer. The alias list is
 * deliberately short and explicit; stripping unknown XML generically would
 * eat legitimate quoted content.
 *
 * Reference: working-tags.md
 */

import type { AgentTextOutput } from './types.js';
import { assistantText } from './pi-message.js';

/**
 * Tag names treated as internal-reasoning delimiters. `working` is the
 * prompted contract; `thinking` is the trained-habit alias.
 */
export const INTERNAL_TAG_NAMES = ['working', 'thinking'] as const;

const TAG_ALTERNATION = INTERNAL_TAG_NAMES.join('|');

/**
 * Regex pattern for matching internal-tag blocks.
 *
 * Matches <working>...</working> or <thinking>...</thinking> pairs
 * (non-greedy, close must match open) and captures the content in group 2.
 * The `s` flag makes `.` match newlines so content can span multiple lines.
 * The `g` flag finds all blocks in the text.
 */
const WORKING_TAG_PATTERN = new RegExp(`<(${TAG_ALTERNATION})>(.*?)</\\1>`, 'gs');

/**
 * Pattern for detecting an unclosed internal tag at the end of the text.
 * Captures everything after the last unclosed opening tag. Applied after
 * closed blocks are removed, so a mismatched pair (e.g. <working>...</thinking>)
 * falls through to this rule and is treated as unclosed.
 */
const UNCLOSED_TAG_PATTERN = new RegExp(`<(?:${TAG_ALTERNATION})>([\\s\\S]*)$`);

/**
 * Strip all <working> tag content from text, returning only user-facing content.
 * Whitespace is normalized: consecutive whitespace collapsed, trimmed.
 *
 * @param text - Raw agent text potentially containing <working> tags
 * @returns User-facing text with all working content removed
 */
export function stripWorkingTags(text: string): string {
  // Replace closed <working>...</working> blocks with a newline sentinel.
  // This ensures a clean break between content that was separated by a working block.
  // The sentinel is used instead of directly removing to enable whitespace normalization.
  let result = text.replace(WORKING_TAG_PATTERN, '\n');

  // Handle any unclosed <working> tag at the end
  result = result.replace(UNCLOSED_TAG_PATTERN, '');

  // Normalize whitespace:
  // 1. Collapse spaces/tabs around newlines into just the newline
  // 2. Collapse 3+ newlines to 2 (preserve paragraph breaks)
  result = result
    .replace(/[ \t]*\n[ \t]*/g, '\n')  // normalize spaces around newlines
    .replace(/\n{3,}/g, '\n\n')         // collapse 3+ newlines to 2
    .trim();

  return result;
}

/**
 * User-facing text of a pi assistant message: its text with working content
 * stripped. Empty means the message spoke nothing.
 */
export function spokenText(assistantMessage: unknown): string {
  return stripWorkingTags(assistantText(assistantMessage));
}

/**
 * Extract content from inside <working> tags.
 * Multiple blocks are concatenated with newline separators.
 * Returns null if no working tags are found.
 *
 * @param text - Raw agent text potentially containing <working> tags
 * @returns Concatenated working content, or null if none found
 */
export function extractWorkingContent(text: string): string | null {
  const blocks: string[] = [];

  // Reset regex lastIndex since we reuse the global pattern
  WORKING_TAG_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = WORKING_TAG_PATTERN.exec(text)) !== null) {
    const content = match[2];
    if (content !== undefined && content.trim().length > 0) {
      blocks.push(content.trim());
    }
  }

  // Check for unclosed tag: an opening tag of any alias AFTER the last
  // closing tag of any alias.
  let lastOpeningIndex = -1;
  let openingTagLength = 0;
  let lastClosingIndex = -1;
  for (const name of INTERNAL_TAG_NAMES) {
    const openTag = `<${name}>`;
    const openIdx = text.lastIndexOf(openTag);
    if (openIdx > lastOpeningIndex) {
      lastOpeningIndex = openIdx;
      openingTagLength = openTag.length;
    }
    lastClosingIndex = Math.max(lastClosingIndex, text.lastIndexOf(`</${name}>`));
  }

  if (lastOpeningIndex > lastClosingIndex) {
    // There is an unclosed tag after all closed blocks
    const unclosedContent = text.slice(lastOpeningIndex + openingTagLength);
    if (unclosedContent.trim().length > 0) {
      blocks.push(unclosedContent.trim());
    }
  }

  if (blocks.length === 0) {
    return null;
  }

  return blocks.join('\n');
}

/**
 * Parse text into structured AgentTextOutput with user-facing and working segments.
 *
 * This is the primary parsing function used by AgentLoop at turn completion.
 * It combines stripWorkingTags and extractWorkingContent into a single result.
 *
 * @param text - Raw agent text potentially containing <working> tags
 * @returns Structured output with userFacing, working, and raw properties
 */
export function parseWorkingTags(text: string): AgentTextOutput {
  return {
    userFacing: stripWorkingTags(text),
    working: extractWorkingContent(text),
    raw: text,
  };
}

/**
 * A turn's text output when working tags are off: nothing was asked to sit
 * inside tags, so the whole text is user-facing.
 */
export function plainTextOutput(text: string): AgentTextOutput {
  return { userFacing: text.trim(), working: null, raw: text };
}

// ---------------------------------------------------------------------------
// Streaming filter (voice-safe deltas)
// ---------------------------------------------------------------------------

/** Open/close tag pairs the stream filter recognizes, one per alias. */
const TAG_PAIRS = INTERNAL_TAG_NAMES.map((name) => ({
  open: `<${name}>`,
  close: `</${name}>`,
}));

/**
 * Streaming working-tag filter with holdback buffering, for the duplex
 * facade's sanitized talker-delta stream (review-findings F6): raw
 * `response_chunk` deltas carry `<working>` content that TTS would speak
 * aloud, and tags split across chunks at arbitrary positions, so consumers
 * cannot strip them chunk-by-chunk themselves.
 *
 * Contract per assistant message (reset between messages):
 * - `push(chunk)` returns the text safe to emit now. Text from any `<` is
 *   HELD until disambiguated: released verbatim once it provably is not a
 *   working tag, swallowed if it opens one.
 * - Inside a working block, content is suppressed until `</working>`
 *   closes it (a completed block emits one newline, matching
 *   stripWorkingTags' sentinel so words on either side never jam together).
 * - `flush()` at stream end releases a held prefix that never became a tag
 *   (a trailing `<` IS emitted) and drops unterminated working content
 *   (matching stripWorkingTags' unclosed-tag rule). flush() is synchronous
 *   and unconditional: there is nothing to deadlock on when a close tag
 *   never arrives, because nothing ever waits; text is merely held until
 *   the next push or the flush.
 *
 * Whitespace differs slightly from the batch stripWorkingTags (which
 * normalizes and trims whole messages); the invariants that matter for
 * voice hold exactly: no working content is ever emitted, and all
 * user-facing content is emitted by flush() time.
 */
export class WorkingTagStreamFilter {
  private mode: 'text' | 'working' = 'text';
  /**
   * Held text. In text mode: an ambiguous prefix of an opening tag starting
   * at its `<`. In working mode: an ambiguous prefix of the current block's
   * close tag (kept only for matching; never emitted unless the close
   * completes... it never is: close-tag prefixes are suppressed content if
   * they diverge).
   */
  private hold = '';
  /** Close tag of the block currently open (working mode only). */
  private closeTag = '';

  /** Filter one raw delta; returns the text safe to emit now. */
  push(chunk: string): string {
    const input = this.hold + chunk;
    this.hold = '';
    let out = '';
    let i = 0;
    while (i < input.length) {
      if (this.mode === 'text') {
        const lt = input.indexOf('<', i);
        if (lt === -1) {
          out += input.slice(i);
          break;
        }
        out += input.slice(i, lt);
        const rest = input.slice(lt);
        const opened = TAG_PAIRS.find((pair) => rest.startsWith(pair.open));
        if (opened) {
          this.mode = 'working';
          // The close must match the alias that opened the block.
          this.closeTag = opened.close;
          i = lt + opened.open.length;
          continue;
        }
        if (TAG_PAIRS.some((pair) => pair.open.startsWith(rest))) {
          // Ambiguous prefix at chunk end: hold until the next push or
          // flush decides.
          this.hold = rest;
          break;
        }
        // Provably not an open tag: the '<' is literal text.
        out += '<';
        i = lt + 1;
      } else {
        const lt = input.indexOf('<', i);
        if (lt === -1) break; // all suppressed
        const rest = input.slice(lt);
        if (rest.startsWith(this.closeTag)) {
          this.mode = 'text';
          // The completed block collapses to one newline, matching
          // stripWorkingTags' sentinel, so surrounding words stay separated.
          out += '\n';
          i = lt + this.closeTag.length;
          continue;
        }
        if (this.closeTag.startsWith(rest)) {
          this.hold = rest;
          break;
        }
        i = lt + 1; // a literal '<' inside working content: suppressed
      }
    }
    return out;
  }

  /**
   * End of stream: release a held text-mode prefix that never became a tag
   * (working-mode holds are suppressed content and are dropped, exactly as
   * stripWorkingTags drops an unclosed block).
   */
  flush(): string {
    const held = this.mode === 'text' ? this.hold : '';
    this.hold = '';
    return held;
  }

  /** Reset for the next assistant message. */
  reset(): void {
    this.mode = 'text';
    this.hold = '';
  }
}
