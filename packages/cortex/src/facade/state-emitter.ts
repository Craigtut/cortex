/**
 * The debounced composite persistence trigger behind
 * CortexAgent.onStateChanged: fires with a consistent snapshot after
 * state-changing activity (log appends, run completions, compaction,
 * observation) settles for the debounce window.
 */

import type { LoopContextApi, LoopEventApi } from '../agent-loop.js';
import type { CortexLogger } from '../types.js';
import { errorMessageOf } from '../error-classifier.js';
import type { CortexAgentStateV2 } from './persisted-state.js';

const DEFAULT_DEBOUNCE_MS = 500;

export interface StateEmitterOptions {
  /** A consistent composite snapshot (CortexAgent.getState). */
  snapshot: () => Promise<CortexAgentStateV2>;
  /**
   * Whether a resident loop is tearing down without the facade knowing (a
   * direct AgentLoop.destroy()). Its final onLoopComplete checkpoint would
   * otherwise schedule a debounce timer that holds its handle for the full
   * window and then snapshots a torn-down loop.
   */
  shuttingDown: () => boolean;
  /** Quiet time before emitting (stateChangeDebounceMs). Default: 500. */
  debounceMs?: number | undefined;
  logger: CortexLogger;
}

export class StateEmitter {
  private readonly options: StateEmitterOptions;
  private readonly handlers: Array<(state: CortexAgentStateV2) => void> = [];
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private emitting = false;
  private destroyed = false;

  constructor(options: StateEmitterOptions) {
    this.options = options;
  }

  /** Whether an emission is scheduled and waiting out the debounce. */
  get scheduled(): boolean {
    return this.timer !== null;
  }

  subscribe(handler: (state: CortexAgentStateV2) => void): void {
    this.handlers.push(handler);
    if (this.dirty) {
      this.schedule();
    }
  }

  markDirty(): void {
    this.dirty = true;
    this.schedule();
  }

  /**
   * History can change without a log entry (a swap of observations for
   * older messages, a reflection, an overflow drop, a run completing);
   * these mark the composite state dirty so onStateChanged fires for them
   * too. Log appends mark it through the recorder's append listener.
   */
  watch(loops: ReadonlyArray<LoopEventApi & LoopContextApi>): void {
    for (const loop of loops) {
      loop.onLoopComplete(() => this.markDirty());
      loop.onObservation(() => this.markDirty());
      loop.onReflection(() => this.markDirty());
      loop.onMemoryGap(() => this.markDirty());
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.destroyed || this.timer !== null || this.emitting) return;
    if (this.handlers.length === 0) return;
    if (this.options.shuttingDown()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // No awaiter exists here: a snapshot rejection escaping this timer
      // would be an unhandled rejection and, under Node's default
      // --unhandled-rejections=throw, kill the host process from a
      // debounce timer. Route it to the consumer's logger instead.
      this.emit().catch((err: unknown) => {
        this.options.logger.error('onStateChanged snapshot failed', {
          error: errorMessageOf(err),
        });
      });
    }, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  private async emit(): Promise<void> {
    if (this.destroyed || this.handlers.length === 0) return;
    if (this.options.shuttingDown()) return;
    this.emitting = true;
    try {
      this.dirty = false;
      const state = await this.options.snapshot();
      if (this.destroyed) return;
      for (const handler of this.handlers) {
        try {
          handler(state);
        } catch (err) {
          this.options.logger.error('onStateChanged handler threw', {
            error: errorMessageOf(err),
          });
        }
      }
    } finally {
      this.emitting = false;
      // Changes that landed while snapshotting get their own cycle.
      if (this.dirty) {
        this.schedule();
      }
    }
  }
}
