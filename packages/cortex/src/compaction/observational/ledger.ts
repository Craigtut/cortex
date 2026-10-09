/**
 * Which messages of the post-slot source history observational memory has
 * observed, and where.
 *
 * The observed messages are always a prefix of the source, in two parts:
 *
 *   [0, observedPrefix)        in the log already, still in history (a swap
 *                               kept them verbatim)
 *   [observedPrefix, watermark) covered by buffered chunks, in order, each
 *                               chunk ending at its own `endIndex`
 *   [watermark, ...)           not observed; at most one observer call is
 *                               pending over [watermark, pending.end)
 *
 * Every rewrite of the source reports here, and the ledger moves every index
 * with the messages it points at, so a pending observer survives a swap and
 * lands at its shifted range instead of being thrown away. A pending call is
 * invalidated (by token) only when its range can no longer be mapped: a
 * restore, a reset, or messages in its range dropped unobserved.
 */

import type { ObservationChunk } from './types.js';

/** A buffered chunk with the end of the source range it covers. */
export interface RangedChunk extends ObservationChunk {
  endIndex: number;
}

/** The ledger as persisted alongside the conversation history. */
export interface LedgerState {
  chunks: RangedChunk[];
  watermark: number;
  observedPrefix: number;
}

export class ObservationLedger {
  private prefix = 0;
  private chunks: RangedChunk[] = [];
  private pending: { token: number; start: number; end: number } | null = null;
  private nextToken = 1;

  /** End of the observed region: the next observation starts here. */
  get watermark(): number {
    return this.chunks.length > 0 ? this.chunks[this.chunks.length - 1]!.endIndex : this.prefix;
  }

  /** Messages at the front that are in the log and still in history. */
  get observedPrefix(): number {
    return this.prefix;
  }

  /** The buffered chunks, oldest first (copies). */
  completedChunks(): RangedChunk[] {
    return this.chunks.map((chunk) => ({ ...chunk }));
  }

  /** The range of the pending observer call, if one is pending. */
  pendingRange(): { start: number; end: number } | null {
    return this.pending ? { start: this.pending.start, end: this.pending.end } : null;
  }

  // -------------------------------------------------------------------------
  // Observation lifecycle
  // -------------------------------------------------------------------------

  /**
   * An observer call starts over [watermark, end). Returns its token, which
   * `land` needs: a call whose range was invalidated meanwhile lands nothing.
   */
  begin(end: number): number {
    const token = this.nextToken++;
    this.pending = { token, start: this.watermark, end: Math.max(end, this.watermark) };
    return token;
  }

  /**
   * The pending call produced its chunk. False when the token is stale (the
   * range was invalidated), in which case nothing changes.
   */
  land(token: number, chunk: ObservationChunk): boolean {
    if (!this.pending || this.pending.token !== token) return false;
    this.chunks.push({ ...chunk, endIndex: this.pending.end });
    this.pending = null;
    return true;
  }

  /** The pending call failed: its range is unobserved again. */
  drop(token: number): void {
    if (this.pending?.token === token) this.pending = null;
  }

  /** Forget the pending call: its result, whenever it arrives, lands nothing. */
  invalidatePending(): void {
    this.pending = null;
  }

  /**
   * Record a chunk observed while a caller waited, over [watermark, end).
   * A pending call over the same messages is invalidated: they are covered.
   */
  record(chunk: ObservationChunk, end: number): void {
    this.invalidatePending();
    this.chunks.push({ ...chunk, endIndex: Math.max(end, this.watermark) });
  }

  // -------------------------------------------------------------------------
  // Source rewrites
  // -------------------------------------------------------------------------

  /**
   * The source lost its first `cut` messages, except the message at `keep`
   * when one is given (it moves to index 0). Every removed message must be
   * observed: `cut` never exceeds the watermark.
   *
   * Returns the chunks to merge into the log: every chunk covering a
   * removed message. A merged chunk that reaches past `cut` leaves its
   * remaining messages observed-and-kept. Chunks wholly past `cut` stay
   * buffered at shifted indices, as does the pending call.
   */
  removePrefix(cut: number, keep?: number): RangedChunk[] {
    const end = Math.min(Math.max(0, cut), this.watermark);
    const kept = keep !== undefined && keep < end ? 1 : 0;
    const shift = end - kept;
    const merged: RangedChunk[] = [];
    const remaining: RangedChunk[] = [];
    let start = this.prefix;
    let observedEnd = this.prefix;
    for (const chunk of this.chunks) {
      if (start < end) {
        merged.push(chunk);
        observedEnd = chunk.endIndex;
      } else {
        remaining.push({ ...chunk, endIndex: chunk.endIndex - shift });
      }
      start = chunk.endIndex;
    }
    this.prefix = kept + Math.max(0, observedEnd - end);
    this.chunks = remaining;
    if (this.pending) {
      this.pending = this.pending.start >= end
        ? { ...this.pending, start: this.pending.start - shift, end: this.pending.end - shift }
        : null;
    }
    return merged;
  }

  /**
   * Messages were dropped from the front without a swap (reactive overflow
   * truncation). Observed ones keep their chunk text, which stays buffered;
   * a pending call whose messages were dropped is invalidated.
   */
  onFrontDropped(count: number): void {
    if (count <= 0) return;
    this.prefix = Math.max(0, this.prefix - count);
    this.chunks = this.chunks.map((chunk) => ({ ...chunk, endIndex: Math.max(0, chunk.endIndex - count) }));
    if (this.pending) {
      this.pending = this.pending.start >= count
        ? { ...this.pending, start: this.pending.start - count, end: this.pending.end - count }
        : null;
    }
  }

  /**
   * The source was trimmed from the tail to `length` (a failed run's stub).
   * Every index past it is clamped; chunk text about a trimmed stub is
   * harmless.
   */
  onTailTrimmed(length: number): void {
    const max = Math.max(0, length);
    this.prefix = Math.min(this.prefix, max);
    this.chunks = this.chunks.map((chunk) => ({ ...chunk, endIndex: Math.min(chunk.endIndex, max) }));
    if (this.pending) {
      this.pending = { ...this.pending, start: Math.min(this.pending.start, max), end: Math.min(this.pending.end, max) };
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  getState(): LedgerState {
    return { chunks: this.completedChunks(), watermark: this.watermark, observedPrefix: this.prefix };
  }

  /**
   * Restore from persisted state, against a history of `historyLength`
   * post-slot messages. A pending call belongs to the replaced state and is
   * invalidated.
   *
   * State without per-chunk ranges (saved before they existed) restores its
   * chunks as one chunk ending at the watermark: lossless, since together
   * they covered exactly [0, watermark). State without a watermark cannot be
   * aligned at all: its chunks are dropped and the history is observed again.
   */
  restore(
    state: { chunks: Array<ObservationChunk & { endIndex?: number }>; watermark?: number; observedPrefix?: number },
    historyLength: number = Number.POSITIVE_INFINITY,
  ): void {
    this.invalidatePending();
    const clamp = (index: number): number => Math.max(0, Math.min(index, historyLength));
    if (typeof state.watermark !== 'number') {
      this.prefix = 0;
      this.chunks = [];
      return;
    }
    this.prefix = clamp(state.observedPrefix ?? 0);
    if (state.chunks.length === 0) {
      this.chunks = [];
      // A watermark with no chunks describes an observed-and-kept prefix.
      this.prefix = Math.max(this.prefix, clamp(state.watermark));
      return;
    }
    const ranged = state.chunks.every((chunk) => typeof chunk.endIndex === 'number');
    if (!ranged) {
      this.chunks = [mergeLegacyChunks(state.chunks, clamp(state.watermark))];
      return;
    }
    let previous = this.prefix;
    this.chunks = state.chunks.map((chunk) => {
      previous = Math.max(previous, clamp(chunk.endIndex!));
      return { ...chunk, endIndex: previous };
    });
  }

  /** Nothing observed, nothing buffered, nothing pending. */
  reset(): void {
    this.invalidatePending();
    this.prefix = 0;
    this.chunks = [];
  }
}

/** Legacy chunks merged in order into one ranged chunk; the latest hints win. */
function mergeLegacyChunks(chunks: ObservationChunk[], endIndex: number): RangedChunk {
  const latestHint = [...chunks].reverse().find((chunk) => chunk.currentTask || chunk.suggestedResponse);
  const merged: RangedChunk = {
    observations: chunks.map((chunk) => chunk.observations).join('\n\n'),
    messageTokensObserved: chunks.reduce((sum, chunk) => sum + chunk.messageTokensObserved, 0),
    createdAt: chunks[chunks.length - 1]!.createdAt,
    endIndex,
  };
  if (latestHint?.currentTask) merged.currentTask = latestHint.currentTask;
  if (latestHint?.suggestedResponse) merged.suggestedResponse = latestHint.suggestedResponse;
  return merged;
}
