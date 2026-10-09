/**
 * The observation log: the text the `_observations` slot carries, the
 * continuation hint that follows it, and how both change.
 *
 * The log only grows by appending until a reflection condenses it. A
 * reflection condenses the log as it was when the reflector started, so it
 * lands onto that prefix and keeps whatever was appended since.
 */

import { estimateTokens } from '../../token-estimator.js';
import {
  OBSERVATION_CONTEXT_PREAMBLE,
  OBSERVATION_RECALL_INSTRUCTIONS,
} from './constants.js';
import { applyReflection } from './reflector.js';
import type { ContinuationHint, ObservationChunk } from './types.js';

export class ObservationLog {
  private log = '';
  private hint: ContinuationHint | null = null;
  private tokens = 0;
  private generations = 0;

  /** @param withRecall - whether the slot carries the recall instructions */
  constructor(private readonly withRecall: boolean) {}

  get text(): string {
    return this.log;
  }

  get continuationHint(): ContinuationHint | null {
    return this.hint;
  }

  get tokenCount(): number {
    return this.tokens;
  }

  /** How many reflections have condensed the log. */
  get generationCount(): number {
    return this.generations;
  }

  /**
   * Append observation text, and take `hint` as the current continuation
   * hint when one is given.
   */
  append(text: string, hint?: ContinuationHint | null): void {
    if (hint) this.hint = hint;
    if (!text) return;
    this.log = this.log ? this.log + '\n\n' + text : text;
    this.tokens = estimateTokens(this.log);
  }

  /**
   * Land a reflection of `input` (the log when the reflector started).
   * False when the log no longer starts with `input` (it was replaced
   * meanwhile) and nothing changed.
   */
  reflect(input: string, reflected: string): boolean {
    // A gap line records messages lost before memory saw them. It must
    // outlive every reflection, whatever the reflector kept.
    const lostGaps = input.split('\n').filter((line) => isGapLine(line) && !reflected.includes(line.trim()));
    const next = applyReflection(this.log, input, lostGaps.length > 0 ? `${reflected}\n\n${lostGaps.join('\n')}` : reflected);
    if (next === null) return false;
    this.log = next;
    this.tokens = estimateTokens(this.log);
    this.generations++;
    return true;
  }

  /**
   * Buffered chunks merged into one text, with the hint of the latest chunk
   * that produced one.
   *
   * Hint fields are not mixed across chunks: an earlier chunk's currentTask
   * may describe work the conversation has since moved on from. With no
   * hint in any chunk, the current hint stands: it came from the observer
   * that ran at the end of the previous cycle, more recent than anything
   * older. The parser already rejects placeholder-only hints.
   */
  merge(chunks: ObservationChunk[]): { observations: string; hint: ContinuationHint | null } {
    let latestHintChunk: ObservationChunk | null = null;
    for (const chunk of chunks) {
      if (chunk.currentTask || chunk.suggestedResponse) latestHintChunk = chunk;
    }
    return {
      observations: chunks.map((chunk) => chunk.observations).join('\n\n'),
      hint: latestHintChunk
        ? { currentTask: latestHintChunk.currentTask ?? '', suggestedResponse: latestHintChunk.suggestedResponse ?? '' }
        : this.hint,
    };
  }

  /**
   * The slot content: preamble, optional recall instructions, the log, and
   * the continuation hint. With `text`, the content the slot would carry
   * for that log text instead (for size estimates).
   */
  slotContent(text: string = this.log): string {
    let content = OBSERVATION_CONTEXT_PREAMBLE;
    if (this.withRecall) content += OBSERVATION_RECALL_INSTRUCTIONS;
    content += '\n\n<observations>\n' + text + '\n</observations>';
    if (this.hint) {
      content += '\n\n<current-task>\n' + this.hint.currentTask + '\n</current-task>';
      content += '\n\n<suggested-response>\n' + this.hint.suggestedResponse + '\n</suggested-response>';
    }
    return content;
  }

  restore(state: {
    observations: string;
    continuationHint: ContinuationHint | null;
    observationTokenCount: number;
    generationCount: number;
  }): void {
    this.log = state.observations;
    this.hint = state.continuationHint;
    this.tokens = state.observationTokenCount;
    this.generations = state.generationCount;
  }

  reset(): void {
    this.log = '';
    this.hint = null;
    this.tokens = 0;
    this.generations = 0;
  }
}

/** Whether a log line is a gap note (see emergency.ts gapNote). */
function isGapLine(line: string): boolean {
  return / GAP: \d+ messages /.test(line);
}
