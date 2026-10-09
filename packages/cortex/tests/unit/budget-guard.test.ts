import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BudgetGuard } from '../../src/budget-guard.js';
import { EventBridge } from '../../src/event-bridge.js';
import type { PiEvent, PiEventSource } from '../../src/event-bridge.js';

/** A partially written pi event: only the fields a test reads. */
type LoosePiEvent = { type: PiEvent['type']; [key: string]: unknown };

/**
 * Create a mock pi-agent-core event source.
 */
function createMockSource(): PiEventSource & { emit: (event: LoosePiEvent) => void } {
  let handler: ((event: PiEvent) => void) | null = null;

  return {
    subscribe(h: (event: PiEvent) => void): () => void {
      handler = h;
      return () => {
        handler = null;
      };
    },
    emit(event): void {
      if (handler) {
        handler(event as unknown as PiEvent);
      }
    },
  };
}

/**
 * Build a pi-ai-shaped turn_end event with usage and cost data.
 * Mimics the real AssistantMessage.usage structure from pi-ai.
 */
function turnEndWithCost(total: number): LoosePiEvent {
  return {
    type: 'turn_end',
    message: {
      usage: {
        input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
      },
    },
  };
}

describe('BudgetGuard', () => {
  let bridge: EventBridge;
  let source: ReturnType<typeof createMockSource>;
  let abortFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bridge = new EventBridge(false); // working tags off for simpler testing
    source = createMockSource();
    bridge.wire(source);
    abortFn = vi.fn();
  });

  // -----------------------------------------------------------------------
  // Turn counting
  // -----------------------------------------------------------------------

  describe('turn counting', () => {
    it('increments turn count on each turn_end', () => {
      const guard = new BudgetGuard({ maxTurns: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      source.emit({ type: 'turn_end' });
      source.emit({ type: 'turn_end' });

      expect(guard.getTurnCount()).toBe(3);
    });

    it('aborts when maxTurns is exceeded', () => {
      const guard = new BudgetGuard({ maxTurns: 3 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      expect(abortFn).not.toHaveBeenCalled();

      source.emit({ type: 'turn_end' });
      expect(abortFn).not.toHaveBeenCalled();

      source.emit({ type: 'turn_end' });
      expect(abortFn).toHaveBeenCalledTimes(1);
    });

    it('does not abort when maxTurns is Infinity', () => {
      const guard = new BudgetGuard({ maxTurns: Infinity }, abortFn);
      guard.wire(bridge);

      for (let i = 0; i < 100; i++) {
        source.emit({ type: 'turn_end' });
      }

      expect(abortFn).not.toHaveBeenCalled();
      expect(guard.getTurnCount()).toBe(100);
    });

    it('does not call abort multiple times after breach', () => {
      const guard = new BudgetGuard({ maxTurns: 2 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      source.emit({ type: 'turn_end' }); // Breach
      source.emit({ type: 'turn_end' }); // Should not abort again

      expect(abortFn).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Cost tracking
  // -----------------------------------------------------------------------

  describe('cost tracking', () => {
    it('accumulates cost from turn_end events (pi-ai AssistantMessage structure)', () => {
      const guard = new BudgetGuard({ maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({
        type: 'turn_end',
        message: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.05 } } },
      });
      source.emit({
        type: 'turn_end',
        message: { usage: { input: 80, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } },
      });

      expect(guard.getTotalCost()).toBeCloseTo(0.08);
    });

    it('aborts when maxCost is exceeded', () => {
      const guard = new BudgetGuard({ maxCost: 0.10 }, abortFn);
      guard.wire(bridge);

      source.emit({
        type: 'turn_end',
        message: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.06 } } },
      });
      expect(abortFn).not.toHaveBeenCalled();

      source.emit({
        type: 'turn_end',
        message: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.04, cacheRead: 0, cacheWrite: 0, total: 0.05 } } },
      });
      expect(abortFn).toHaveBeenCalledTimes(1);
    });

    it('does not abort when maxCost is Infinity', () => {
      const guard = new BudgetGuard({ maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      for (let i = 0; i < 100; i++) {
        source.emit({
          type: 'turn_end',
          message: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0, total: 1.0 } } },
        });
      }

      expect(abortFn).not.toHaveBeenCalled();
    });

    it('extracts cost from result.usage.cost.total', () => {
      const guard = new BudgetGuard({ maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({
        type: 'turn_end',
        result: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.02, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.07 } } },
      });

      expect(guard.getTotalCost()).toBeCloseTo(0.07);
    });

    it('extracts cost from direct usage on event', () => {
      const guard = new BudgetGuard({ maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({
        type: 'turn_end',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.01, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.04 } },
      });

      expect(guard.getTotalCost()).toBeCloseTo(0.04);
    });

    it('handles turn_end with no usage data (zero cost)', () => {
      const guard = new BudgetGuard({ maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });

      expect(guard.getTotalCost()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Forwarded child (sub-agent) events
  // -----------------------------------------------------------------------

  describe('forwarded child events', () => {
    it('does not count forwarded child turn_end events toward the parent budget', () => {
      const guard = new BudgetGuard({ maxTurns: Infinity, maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      // A child agent's own bridge, forwarded onto the parent bridge with a
      // childTaskId. This is how sub-agent events reach the parent in practice.
      const childBridge = new EventBridge(false);
      const childSource = createMockSource();
      childBridge.wire(childSource);
      const stopForwarding = bridge.forwardFrom(childBridge, 'child-1');

      // Child turns and cost must not touch the parent's counters.
      childSource.emit(turnEndWithCost(0.05));
      childSource.emit(turnEndWithCost(0.05));

      expect(guard.getTurnCount()).toBe(0);
      expect(guard.getTotalCost()).toBe(0);

      // Parent's own turns/cost still count.
      source.emit(turnEndWithCost(0.02));

      expect(guard.getTurnCount()).toBe(1);
      expect(guard.getTotalCost()).toBeCloseTo(0.02);

      stopForwarding();
    });

    it('does not abort the parent when child turns exceed the parent limit', () => {
      const guard = new BudgetGuard({ maxTurns: 2 }, abortFn);
      guard.wire(bridge);

      const childBridge = new EventBridge(false);
      const childSource = createMockSource();
      childBridge.wire(childSource);
      bridge.forwardFrom(childBridge, 'child-1');

      // Ten child turns would blow past maxTurns=2 if counted.
      for (let i = 0; i < 10; i++) {
        childSource.emit({ type: 'turn_end' });
      }

      expect(abortFn).not.toHaveBeenCalled();
      expect(guard.getTurnCount()).toBe(0);
      expect(guard.isBreached()).toBe(false);
    });

    it('does not reset the parent counters on a forwarded child loop_start', () => {
      const guard = new BudgetGuard({ maxTurns: Infinity, maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      // Accumulate parent state.
      source.emit(turnEndWithCost(0.05));
      expect(guard.getTurnCount()).toBe(1);
      expect(guard.getTotalCost()).toBeCloseTo(0.05);

      const childBridge = new EventBridge(false);
      const childSource = createMockSource();
      childBridge.wire(childSource);
      bridge.forwardFrom(childBridge, 'child-1');

      // A child starting its own loop must not wipe the parent's counters.
      childSource.emit({ type: 'agent_start' });

      expect(guard.getTurnCount()).toBe(1);
      expect(guard.getTotalCost()).toBeCloseTo(0.05);
    });
  });

  // -----------------------------------------------------------------------
  // Reset per logical turn
  // -----------------------------------------------------------------------

  describe('reset per logical turn', () => {
    it('reset() clears counters and breach state', () => {
      const guard = new BudgetGuard({ maxTurns: Infinity, maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.05));
      source.emit(turnEndWithCost(0.05));

      expect(guard.getTurnCount()).toBe(2);
      expect(guard.getTotalCost()).toBeCloseTo(0.10);

      guard.reset();

      expect(guard.getTurnCount()).toBe(0);
      expect(guard.getTotalCost()).toBe(0);
      expect(guard.isBreached()).toBe(false);
    });

    it('allows new turns after reset', () => {
      const guard = new BudgetGuard({ maxTurns: 2 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      source.emit({ type: 'turn_end' }); // Breach
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(guard.isBreached()).toBe(true);

      guard.reset();
      expect(guard.isBreached()).toBe(false);

      // Should be able to run 2 more turns
      source.emit({ type: 'turn_end' });
      expect(abortFn).toHaveBeenCalledTimes(1); // Still just the 1 from before
    });

    it('does not reset on loop_start (retry continuations emit one per attempt)', () => {
      const guard = new BudgetGuard({ maxTurns: Infinity, maxCost: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.05));
      expect(guard.getTurnCount()).toBe(1);

      // pi-agent-core emits agent_start for every run, including each
      // background-retry continue(); the budget must keep accumulating
      // across attempts of the same logical turn.
      source.emit({ type: 'agent_start' });

      expect(guard.getTurnCount()).toBe(1);
      expect(guard.getTotalCost()).toBeCloseTo(0.05);

      source.emit(turnEndWithCost(0.05));
      expect(guard.getTurnCount()).toBe(2);
      expect(guard.getTotalCost()).toBeCloseTo(0.10);
    });
  });

  // -----------------------------------------------------------------------
  // Synthetic failure / abort turns (not real model turns)
  // -----------------------------------------------------------------------

  describe('synthetic failure turns', () => {
    it('does not count a turn_end carrying a stopReason error message', () => {
      const guard = new BudgetGuard({ maxTurns: Infinity }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end', message: { stopReason: 'error', errorMessage: 'Connection error.' } });
      source.emit({ type: 'turn_end', message: { stopReason: 'aborted' } });
      source.emit({ type: 'turn_end', message: { errorMessage: 'boom' } });

      expect(guard.getTurnCount()).toBe(0);
    });

    it('counts real turns but skips synthetic failures across a retried logical turn', () => {
      // maxTurns caps a whole logical turn. Emit real turns spanning the
      // synthetic failure + retry agent_start and confirm accumulation with
      // no per-attempt reset and no synthetic-turn counting.
      const guard = new BudgetGuard({ maxTurns: 5 }, abortFn);
      guard.wire(bridge);

      // Attempt 1: two real turns, then a synthetic failure.
      source.emit(turnEndWithCost(0.01));
      source.emit(turnEndWithCost(0.01));
      source.emit({ type: 'turn_end', message: { stopReason: 'error', errorMessage: 'Connection error.' } });
      // Retry continuation starts a new pi run.
      source.emit({ type: 'agent_start' });
      // Attempt 2: one real turn.
      source.emit(turnEndWithCost(0.01));

      expect(guard.getTurnCount()).toBe(3);
      expect(guard.getTotalCost()).toBeCloseTo(0.03);
      expect(abortFn).not.toHaveBeenCalled();
    });

    it('a real turn following a synthetic failure still triggers the limit', () => {
      const guard = new BudgetGuard({ maxTurns: 2 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' }); // real turn 1
      source.emit({ type: 'turn_end', message: { stopReason: 'error' } }); // skipped
      expect(abortFn).not.toHaveBeenCalled();
      source.emit({ type: 'turn_end' }); // real turn 2 -> breach
      expect(abortFn).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Defaults
  // -----------------------------------------------------------------------

  describe('defaults', () => {
    it('defaults to Infinity for both limits', () => {
      const guard = new BudgetGuard({}, abortFn);
      guard.wire(bridge);

      for (let i = 0; i < 50; i++) {
        source.emit(turnEndWithCost(10.0));
      }

      expect(abortFn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Combined limits
  // -----------------------------------------------------------------------

  describe('combined limits', () => {
    it('aborts on whichever limit is hit first (turns)', () => {
      const guard = new BudgetGuard({ maxTurns: 3, maxCost: 100.0 }, abortFn);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.01));
      source.emit(turnEndWithCost(0.01));
      source.emit(turnEndWithCost(0.01));

      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(guard.getTotalCost()).toBeCloseTo(0.03); // Well under cost limit
    });

    it('aborts on whichever limit is hit first (cost)', () => {
      const guard = new BudgetGuard({ maxTurns: 100, maxCost: 0.05 }, abortFn);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.03));
      source.emit(turnEndWithCost(0.03));

      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(guard.getTurnCount()).toBe(2); // Well under turn limit
    });
  });

  // -----------------------------------------------------------------------
  // Breach state
  // -----------------------------------------------------------------------

  describe('breach state', () => {
    it('reports not breached initially', () => {
      const guard = new BudgetGuard({ maxTurns: 5 }, abortFn);
      expect(guard.isBreached()).toBe(false);
    });

    it('reports breached after turn limit', () => {
      const guard = new BudgetGuard({ maxTurns: 1 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      expect(guard.isBreached()).toBe(true);
    });

    it('reports breached after cost limit', () => {
      const guard = new BudgetGuard({ maxCost: 0.01 }, abortFn);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.02));
      expect(guard.isBreached()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  describe('cleanup', () => {
    it('unwire stops tracking events', () => {
      const guard = new BudgetGuard({ maxTurns: 5 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      expect(guard.getTurnCount()).toBe(1);

      guard.unwire();

      source.emit({ type: 'turn_end' });
      expect(guard.getTurnCount()).toBe(1); // No longer tracking
    });

    it('destroy stops tracking events', () => {
      const guard = new BudgetGuard({ maxTurns: 5 }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      guard.destroy();

      source.emit({ type: 'turn_end' });
      expect(guard.getTurnCount()).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Logger integration
  // -----------------------------------------------------------------------

  describe('logger', () => {
    it('logs warn on turn limit breach', () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const guard = new BudgetGuard({ maxTurns: 2 }, abortFn, logger);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      expect(logger.warn).not.toHaveBeenCalled();

      source.emit({ type: 'turn_end' });
      expect(logger.warn).toHaveBeenCalledWith(
        '[BudgetGuard] turn limit breached',
        expect.objectContaining({ turnCount: 2, maxTurns: 2 }),
      );
    });

    it('logs warn on cost limit breach', () => {
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const guard = new BudgetGuard({ maxCost: 0.05 }, abortFn, logger);
      guard.wire(bridge);

      source.emit(turnEndWithCost(0.06));
      expect(logger.warn).toHaveBeenCalledWith(
        '[BudgetGuard] cost limit breached',
        expect.objectContaining({ totalCost: 0.06, maxCost: 0.05 }),
      );
    });

    it('works without logger (default NOOP)', () => {
      const guard = new BudgetGuard({ maxTurns: 1 }, abortFn);
      guard.wire(bridge);

      // Should not throw
      expect(() => source.emit({ type: 'turn_end' })).not.toThrow();
      expect(guard.isBreached()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Child usage inclusion (aggregate-guard plumbing)
  // -----------------------------------------------------------------------

  describe('includeChildUsage', () => {
    it('counts forwarded child turns and cost when opted in', () => {
      const guard = new BudgetGuard(
        { maxTurns: Infinity, maxCost: Infinity, includeChildUsage: true },
        abortFn,
      );
      guard.wire(bridge);

      const childBridge = new EventBridge(false);
      const childSource = createMockSource();
      childBridge.wire(childSource);
      bridge.forwardFrom(childBridge, 'child-1');

      childSource.emit(turnEndWithCost(0.05));
      source.emit(turnEndWithCost(0.02));

      expect(guard.getTurnCount()).toBe(2);
      expect(guard.getTotalCost()).toBeCloseTo(0.07);
    });

    it('aborts on child spend crossing the limit when opted in', () => {
      const guard = new BudgetGuard(
        { maxCost: 0.05, includeChildUsage: true },
        abortFn,
      );
      guard.wire(bridge);

      const childBridge = new EventBridge(false);
      const childSource = createMockSource();
      childBridge.wire(childSource);
      bridge.forwardFrom(childBridge, 'child-1');

      childSource.emit(turnEndWithCost(0.06));

      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(guard.isBreached()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Lifetime scope
  // -----------------------------------------------------------------------

  describe('lifetime scope', () => {
    it('keeps aborting turns after a breach (a later prompt must not slip through)', () => {
      const guard = new BudgetGuard({ maxTurns: 2, scope: 'lifetime' }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      source.emit({ type: 'turn_end' }); // Breach
      expect(abortFn).toHaveBeenCalledTimes(1);

      // A prompt started after the breach: under lifetime scope nothing
      // resets the guard, so its first turn must be aborted too.
      source.emit({ type: 'turn_end' });
      expect(abortFn).toHaveBeenCalledTimes(2);
    });

    it('prompt scope still aborts only once per breach window', () => {
      const guard = new BudgetGuard({ maxTurns: 2, scope: 'prompt' }, abortFn);
      guard.wire(bridge);

      source.emit({ type: 'turn_end' });
      source.emit({ type: 'turn_end' }); // Breach
      source.emit({ type: 'turn_end' });

      expect(abortFn).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Utility usage (aggregate guard visibility, duplex D19)
  // -----------------------------------------------------------------------

  describe('includeUtilityUsage', () => {
    function emitUtility(total: number, childTaskId?: string): void {
      const usage = {
        input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
      };
      if (childTaskId) {
        const childBridge = new EventBridge(false);
        bridge.forwardFrom(childBridge, childTaskId);
        childBridge.emitUtilityUsage('observer', usage);
      } else {
        bridge.emitUtilityUsage('observer', usage);
      }
    }

    it('ignores utility spend by default (per-loop guards bound turns only)', () => {
      const guard = new BudgetGuard({ maxCost: 0.05 }, abortFn);
      guard.wire(bridge);

      emitUtility(0.06);

      expect(guard.getTotalCost()).toBe(0);
      expect(abortFn).not.toHaveBeenCalled();
    });

    it('counts utility spend toward maxCost when opted in', () => {
      const guard = new BudgetGuard(
        { maxCost: 0.05, includeUtilityUsage: true },
        abortFn,
      );
      guard.wire(bridge);

      emitUtility(0.03);
      expect(guard.getTotalCost()).toBeCloseTo(0.03);
      expect(abortFn).not.toHaveBeenCalled();

      emitUtility(0.03); // Crosses the limit on utility spend alone.
      expect(abortFn).toHaveBeenCalledTimes(1);
      expect(guard.isBreached()).toBe(true);
    });

    it('never counts utility events toward maxTurns', () => {
      const guard = new BudgetGuard(
        { maxTurns: 1, includeUtilityUsage: true },
        abortFn,
      );
      guard.wire(bridge);

      emitUtility(0.01);
      expect(guard.getTurnCount()).toBe(0);
      expect(abortFn).not.toHaveBeenCalled();
    });

    it('applies the child gate to forwarded utility events', () => {
      const ownOnly = new BudgetGuard(
        { maxCost: Infinity, includeUtilityUsage: true },
        abortFn,
      );
      ownOnly.wire(bridge);
      emitUtility(0.02, 'child-1');
      expect(ownOnly.getTotalCost()).toBe(0);

      const aggregate = new BudgetGuard(
        { maxCost: Infinity, includeUtilityUsage: true, includeChildUsage: true },
        abortFn,
      );
      aggregate.wire(bridge);
      emitUtility(0.02, 'child-2');
      expect(aggregate.getTotalCost()).toBeCloseTo(0.02);
    });
  });
});
