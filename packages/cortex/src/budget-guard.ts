/**
 * Budget guard: enforces turn count and cost limits during the agentic loop.
 *
 * Monitors turn_end events for turn counting and cost accumulation.
 * On breach, calls the provided abort function to stop the loop.
 * Defaults to Infinity for both limits (no enforcement unless configured).
 *
 * Counters are reset by AgentLoop (via reset()) once per logical prompt
 * turn, NOT on loop_start: pi-agent-core emits a fresh agent_start for every
 * run, including each background-retry continuation, so resetting there
 * would make maxTurns/maxCost per-attempt instead of per logical turn.
 *
 * Reference: cortex-architecture.md (Budget Guards section)
 */

import type { BudgetGuardConfig, BudgetScope, CortexLogger } from './types.js';
import { NOOP_LOGGER } from './noop-logger.js';
import { payloadOf } from './event-bridge.js';
import type { CortexEvent, EventBridge } from './event-bridge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether a turn_end event carries pi-agent-core's synthetic failure message
 * (stopReason 'error'/'aborted', or errorMessage set). These are emitted once
 * per failed or cancelled attempt and must not count toward maxTurns.
 */
function isFailureTurnEnd(event: CortexEvent): boolean {
  const message = payloadOf(event, 'turn_end')?.message;
  if (!message) return false;
  return (
    message.stopReason === 'error' ||
    message.stopReason === 'aborted' ||
    message.errorMessage !== undefined
  );
}

// ---------------------------------------------------------------------------
// BudgetGuard
// ---------------------------------------------------------------------------

export class BudgetGuard {
  private readonly maxTurns: number;
  private readonly maxCost: number;
  private readonly scope: BudgetScope;
  private readonly includeChildUsage: boolean;
  private readonly includeUtilityUsage: boolean;
  private readonly abortFn: () => void;
  private readonly logger: CortexLogger;

  private turnCount = 0;
  private totalCost = 0;
  private breached = false;

  private unsubscribers: Array<() => void> = [];

  /**
   * Create a BudgetGuard.
   *
   * @param config - Budget limits (maxTurns, maxCost). Both default to Infinity.
   * @param abortFn - Function to call when a limit is breached (typically agent.abort())
   * @param logger - Optional logger for diagnostics (defaults to silent no-op)
   */
  constructor(config: Partial<BudgetGuardConfig>, abortFn: () => void, logger?: CortexLogger) {
    this.maxTurns = config.maxTurns ?? Infinity;
    this.maxCost = config.maxCost ?? Infinity;
    this.scope = config.scope ?? 'prompt';
    this.includeChildUsage = config.includeChildUsage ?? false;
    this.includeUtilityUsage = config.includeUtilityUsage ?? false;
    this.abortFn = abortFn;
    this.logger = logger ?? NOOP_LOGGER;
  }

  /**
   * Wire the guard to an event bridge.
   * Subscribes to turn_end (for turn counting and cost). Counter resets are
   * NOT event-driven: the owner calls reset() once per logical turn, because
   * loop_start fires per pi-agent-core run and a retried turn spans several.
   *
   * @param bridge - The EventBridge to subscribe to
   */
  wire(bridge: EventBridge): void {
    // Clean up any previous wiring
    this.unwire();

    // Track turns and cost on turn_end. Forwarded child events arrive on the
    // same bridge with childTaskId set; by default skip them so a parent's
    // budget counts only its own turns and cost (matching the childTaskId
    // branching in AgentLoop's own turn_end handlers). An aggregate guard
    // opts into counting them via includeChildUsage.
    this.unsubscribers.push(
      bridge.on('turn_end', (event) => {
        if (event.childTaskId && !this.includeChildUsage) return;
        // Skip synthetic failure/abort turns. pi-agent-core emits a turn_end
        // for its synthetic failure message (empty usage, stopReason
        // error/aborted) on every failed or cancelled attempt; counting it
        // would burn a maxTurns slot per retry attempt rather than per real
        // model turn.
        if (isFailureTurnEnd(event)) return;
        this.turnCount++;

        // Read cost from typed usage (extracted by EventBridge)
        const cost = event.usage?.cost?.total ?? 0;
        if (cost > 0) {
          this.totalCost += cost;
        }

        // Check limits
        this.checkLimits();
      }),
    );

    // Utility spend (observer, reflector, WebFetch, Bash utility calls)
    // counts toward maxCost when opted in. Never toward
    // maxTurns: these are internal completions, not loop turns. The same
    // child gate applies: forwarded child utility events carry childTaskId.
    if (this.includeUtilityUsage) {
      this.unsubscribers.push(
        bridge.on('utility_usage', (event) => {
          if (event.childTaskId && !this.includeChildUsage) return;
          const cost = event.usage?.cost?.total ?? 0;
          if (cost > 0) {
            this.totalCost += cost;
            this.checkLimits();
          }
        }),
      );
    }
  }

  /**
   * Disconnect from the event bridge.
   */
  unwire(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }

  /**
   * Get the current turn count.
   */
  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * Get the accumulated cost.
   */
  getTotalCost(): number {
    return this.totalCost;
  }

  /**
   * Get the maximum turn limit.
   */
  getMaxTurns(): number {
    return this.maxTurns;
  }

  /**
   * Get the maximum cost limit.
   */
  getMaxCost(): number {
    return this.maxCost;
  }

  /**
   * Whether any limit has been breached.
   */
  isBreached(): boolean {
    return this.breached;
  }

  /**
   * Reset counters. Called by AgentLoop at the start of each logical
   * prompt turn, so limits span all retry attempts of that turn.
   */
  reset(): void {
    this.turnCount = 0;
    this.totalCost = 0;
    this.breached = false;
  }

  /**
   * Clean up all subscriptions.
   */
  destroy(): void {
    this.unwire();
  }

  /**
   * Check if any limits have been exceeded and abort if so.
   *
   * Under 'prompt' scope a breach aborts once; the owner resets the guard at
   * the next prompt, clearing the flag. Under 'lifetime' scope nothing ever
   * resets it, so the guard keeps aborting every turn past the limit: a
   * prompt started after the breach must be stopped too, not waved through
   * because the flag was already set.
   */
  private checkLimits(): void {
    if (this.breached && this.scope === 'prompt') {
      return; // Already breached, don't abort multiple times
    }

    if (this.turnCount >= this.maxTurns) {
      if (!this.breached) {
        this.breached = true;
        this.logger.warn('[BudgetGuard] turn limit breached', {
          turnCount: this.turnCount,
          maxTurns: this.maxTurns,
        });
      }
      this.abortFn();
      return;
    }

    if (this.totalCost >= this.maxCost) {
      if (!this.breached) {
        this.breached = true;
        this.logger.warn('[BudgetGuard] cost limit breached', {
          totalCost: this.totalCost,
          maxCost: this.maxCost,
        });
      }
      this.abortFn();
    }
  }

}
