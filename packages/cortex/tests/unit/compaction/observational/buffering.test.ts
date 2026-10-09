import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BufferingCoordinator } from '../../../../src/compaction/observational/buffering.js';
import type { CompleteFn } from '../../../../src/compaction/compaction.js';
import type { AgentMessage } from '../../../../src/context-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });
const assistantMsg = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: 0 });

const VALID_OBSERVER_OUTPUT =
  '<observations>\nDate: Apr 10, 2026\n\n* \u{1F7E1} (14:30) Test observation\n</observations>\n\n' +
  '<current-task>\nTesting the buffering coordinator with mock observer output.\n</current-task>\n\n' +
  '<suggested-response>\nContinue testing the next coordinator scenario.\n</suggested-response>';

const VALID_REFLECTOR_OUTPUT =
  '<observations>\nDate: Apr 10, 2026\n\n* \u{1F7E1} (14:30) Consolidated observation\n</observations>';

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests: computeBufferInterval
// ---------------------------------------------------------------------------

describe('BufferingCoordinator', () => {
  let coordinator: BufferingCoordinator;

  beforeEach(() => {
    coordinator = new BufferingCoordinator();
  });

  describe('computeBufferInterval', () => {
    it('lets utility capacity bound a minimum batch that cannot fit', () => {
      expect(coordinator.computeBufferInterval(100, {
        bufferTargetCycles: 4, bufferTokenCap: 30000, bufferMinTokens: 5000,
        utilityModelContextWindow: 4096,
      })).toBe(4096 * 0.6);
    });
    it('divides tokens until activation by target cycles', () => {
      const interval = coordinator.computeBufferInterval(40_000, {
        bufferTargetCycles: 4,
        bufferTokenCap: 30_000,
        bufferMinTokens: 5_000,
        utilityModelContextWindow: 200_000,
      });

      // 40000 / 4 = 10000, clamped between 5000 and min(30000, 200000*0.6=120000)
      expect(interval).toBe(10_000);
    });

    it('respects the cap (bufferTokenCap)', () => {
      const interval = coordinator.computeBufferInterval(200_000, {
        bufferTargetCycles: 2,
        bufferTokenCap: 30_000,
        bufferMinTokens: 5_000,
        utilityModelContextWindow: 200_000,
      });

      // 200000 / 2 = 100000, but capped at min(30000, 120000) = 30000
      expect(interval).toBe(30_000);
    });

    it('respects the floor (bufferMinTokens)', () => {
      const interval = coordinator.computeBufferInterval(10_000, {
        bufferTargetCycles: 4,
        bufferTokenCap: 30_000,
        bufferMinTokens: 5_000,
        utilityModelContextWindow: 200_000,
      });

      // 10000 / 4 = 2500, but floor is 5000
      expect(interval).toBe(5_000);
    });

    it('clamps effective cap to utility model context window', () => {
      const interval = coordinator.computeBufferInterval(200_000, {
        bufferTargetCycles: 2,
        bufferTokenCap: 100_000,
        bufferMinTokens: 5_000,
        utilityModelContextWindow: 30_000, // small utility model
      });

      // 200000 / 2 = 100000, effective cap = min(100000, 30000*0.6=18000) = 18000
      expect(interval).toBe(18_000);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: shouldBuffer
  // -------------------------------------------------------------------------

  describe('shouldBuffer', () => {
    it('returns true when tokens exceed interval and no observer in flight', () => {
      expect(coordinator.shouldBuffer(10_000, 5_000)).toBe(true);
    });

    it('returns false when tokens are below interval', () => {
      expect(coordinator.shouldBuffer(3_000, 5_000)).toBe(false);
    });

    it('returns true when tokens equal interval', () => {
      expect(coordinator.shouldBuffer(5_000, 5_000)).toBe(true);
    });

    it('returns false when observer is in flight', async () => {
      const neverResolve = new Promise<string>(() => {});
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(neverResolve);

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        5,
        null,
        { previousObserverTokens: 2000 },
      );

      expect(coordinator.shouldBuffer(10_000, 5_000)).toBe(false);
    });

    it('returns false when aborted', () => {
      coordinator.abort();
      expect(coordinator.shouldBuffer(10_000, 5_000)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: launchObserver
  // -------------------------------------------------------------------------

  describe('launchObserver', () => {
    it('stores chunk on completion and advances watermark', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(VALID_OBSERVER_OUTPUT);

      coordinator.launchObserver(
        mockComplete,
        [userMsg('Hello'), assistantMsg('Hi')],
        10,
        null,
        { previousObserverTokens: 2000 },
      );

      expect(coordinator.isObserverInFlight()).toBe(true);
      await flushPromises();

      expect(coordinator.isObserverInFlight()).toBe(false);
      expect(coordinator.hasCompletedChunks()).toBe(true);

      const { chunks, watermark } = coordinator.getCompletedChunks();
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.observations).toContain('Test observation');
      expect(chunks[0]!.currentTask).toContain('Testing');
      expect(chunks[0]!.suggestedResponse).toContain('Continue testing');
      expect(watermark).toBe(10);
    });

    it('handles errors without crashing', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockRejectedValue(new Error('API failure'));
      const logger = { warn: vi.fn() };

      coordinator.launchObserver(
        mockComplete,
        [userMsg('Hello')],
        5,
        null,
        { previousObserverTokens: 2000 },
        logger,
      );

      await flushPromises();

      expect(coordinator.isObserverInFlight()).toBe(false);
      expect(coordinator.hasCompletedChunks()).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Observer buffer call failed'),
      );
    });

    it('enforces at-most-one-in-flight by tracking state', () => {
      const neverResolve = new Promise<string>(() => {});
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(neverResolve);

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        5,
        null,
        { previousObserverTokens: 2000 },
      );

      expect(coordinator.isObserverInFlight()).toBe(true);
      // shouldBuffer prevents launching another
      expect(coordinator.shouldBuffer(10_000, 5_000)).toBe(false);
    });

    it('discards result if aborted before completion', async () => {
      let resolvePromise: ((value: string) => void) | undefined;
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(
        new Promise<string>((resolve) => { resolvePromise = resolve; }),
      );

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        5,
        null,
        { previousObserverTokens: 2000 },
      );

      coordinator.abort();
      resolvePromise!(VALID_OBSERVER_OUTPUT);
      await flushPromises();

      expect(coordinator.hasCompletedChunks()).toBe(false);
    });

    it('does not launch when aborted', () => {
      const mockComplete = vi.fn<CompleteFn>();
      coordinator.abort();

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        5,
        null,
        { previousObserverTokens: 2000 },
      );

      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Tests: chunk lifecycle
  // -------------------------------------------------------------------------

  describe('hasCompletedChunks / getCompletedChunks', () => {
    it('has no chunks initially', () => {
      expect(coordinator.hasCompletedChunks()).toBe(false);
      const { chunks } = coordinator.getCompletedChunks();
      expect(chunks.length).toBe(0);
    });

    it('getCompletedChunks returns copies of chunks', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(VALID_OBSERVER_OUTPUT);

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        5,
        null,
        { previousObserverTokens: 2000 },
      );
      await flushPromises();

      const first = coordinator.getCompletedChunks();
      const second = coordinator.getCompletedChunks();

      // Should return different array instances
      expect(first.chunks).not.toBe(second.chunks);
      // But same content
      expect(first.chunks.length).toBe(second.chunks.length);
    });

    it('removing every observed message consumes the chunks and resets the watermark', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(VALID_OBSERVER_OUTPUT);

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        5,
        null,
        { previousObserverTokens: 2000 },
      );
      await flushPromises();

      expect(coordinator.hasCompletedChunks()).toBe(true);
      expect(coordinator.getWatermark()).toBe(5);

      expect(coordinator.ledger.removePrefix(5)).toHaveLength(1);

      expect(coordinator.hasCompletedChunks()).toBe(false);
      expect(coordinator.getWatermark()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: shouldReflect
  // -------------------------------------------------------------------------

  describe('shouldReflect', () => {
    it('returns "none" when tokens are below both thresholds', () => {
      // asyncTrigger = 1000 * 0.5 = 500
      expect(coordinator.shouldReflect(100, 1000, 0.5)).toBe('none');
    });

    it('returns "async" at buffer activation point', () => {
      // asyncTrigger = 1000 * 0.5 = 500; tokens = 600 is between 500 and 1000
      expect(coordinator.shouldReflect(600, 1000, 0.5)).toBe('async');
    });

    it('returns "sync" at or above threshold', () => {
      expect(coordinator.shouldReflect(1000, 1000, 0.5)).toBe('sync');
      expect(coordinator.shouldReflect(1500, 1000, 0.5)).toBe('sync');
    });

    it('returns "none" for async when reflector is already in flight', () => {
      const neverResolve = new Promise<string>(() => {});
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(neverResolve);

      coordinator.launchReflector(
        mockComplete,
        'observations',
        { reflectionThreshold: 1000 },
      );

      // asyncTrigger = 1000 * 0.5 = 500; tokens = 600
      expect(coordinator.shouldReflect(600, 1000, 0.5)).toBe('none');
    });

    it('returns "none" for async when aborted', () => {
      coordinator.abort();
      expect(coordinator.shouldReflect(600, 1000, 0.5)).toBe('none');
    });

    it('still returns "sync" even when reflector is in flight', () => {
      const neverResolve = new Promise<string>(() => {});
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(neverResolve);

      coordinator.launchReflector(
        mockComplete,
        'observations',
        { reflectionThreshold: 1000 },
      );

      expect(coordinator.shouldReflect(1000, 1000, 0.5)).toBe('sync');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: launchReflector
  // -------------------------------------------------------------------------

  describe('launchReflector', () => {
    it('stores buffered reflection on completion', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(VALID_REFLECTOR_OUTPUT);

      coordinator.launchReflector(
        mockComplete,
        'observations to consolidate',
        { reflectionThreshold: 100_000 }, // generous so it passes validation
      );

      expect(coordinator.isReflectorInFlight()).toBe(true);
      await flushPromises();

      expect(coordinator.isReflectorInFlight()).toBe(false);
      expect(coordinator.hasBufferedReflection()).toBe(true);
    });

    it('handles errors without crashing', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockRejectedValue(new Error('Reflector failed'));
      const logger = { warn: vi.fn() };

      coordinator.launchReflector(
        mockComplete,
        'observations',
        { reflectionThreshold: 1000 },
        logger,
      );

      await flushPromises();

      expect(coordinator.isReflectorInFlight()).toBe(false);
      expect(coordinator.hasBufferedReflection()).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Reflector buffer call failed'),
      );
    });

    it('does not launch when aborted', () => {
      const mockComplete = vi.fn<CompleteFn>();
      coordinator.abort();

      coordinator.launchReflector(
        mockComplete,
        'observations',
        { reflectionThreshold: 1000 },
      );

      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Tests: reflection lifecycle
  // -------------------------------------------------------------------------

  describe('hasBufferedReflection / consumeBufferedReflection', () => {
    it('has no buffered reflection initially', () => {
      expect(coordinator.hasBufferedReflection()).toBe(false);
      expect(coordinator.consumeBufferedReflection()).toBeNull();
    });

    it('consumeBufferedReflection returns data and clears it', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(VALID_REFLECTOR_OUTPUT);

      coordinator.launchReflector(
        mockComplete,
        'observations',
        { reflectionThreshold: 100_000 },
      );
      await flushPromises();

      expect(coordinator.hasBufferedReflection()).toBe(true);

      const result = coordinator.consumeBufferedReflection();
      expect(result).not.toBeNull();
      expect(result!.observations).toContain('Consolidated observation');
      expect(result!.compressionLevel).toBe(0);

      // Should be cleared after consumption
      expect(coordinator.hasBufferedReflection()).toBe(false);
      expect(coordinator.consumeBufferedReflection()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Tests: state persistence
  // -------------------------------------------------------------------------

  describe('getState / restoreState', () => {
    it('returns empty state initially', () => {
      const state = coordinator.getState();
      expect(state.chunks).toEqual([]);
      expect(state.watermark).toBe(0);
    });

    it('returns current chunks and watermark', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(VALID_OBSERVER_OUTPUT);

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        7,
        null,
        { previousObserverTokens: 2000 },
      );
      await flushPromises();

      const state = coordinator.getState();
      expect(state.chunks.length).toBe(1);
      expect(state.watermark).toBe(7);
    });

    it('excludes in-flight operations from state', () => {
      const neverResolve = new Promise<string>(() => {});
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(neverResolve);

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        5,
        null,
        { previousObserverTokens: 2000 },
      );

      const state = coordinator.getState();
      // In-flight observer should not appear in state
      expect(state.chunks.length).toBe(0);
    });

    it('round-trips state through save and restore', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(VALID_OBSERVER_OUTPUT);

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        7,
        null,
        { previousObserverTokens: 2000 },
      );
      await flushPromises();

      const savedState = coordinator.getState();

      // Create a new coordinator and restore
      const newCoordinator = new BufferingCoordinator();
      newCoordinator.restoreState(savedState);

      const restoredState = newCoordinator.getState();
      expect(restoredState.chunks.length).toBe(savedState.chunks.length);
      expect(restoredState.chunks[0]!.observations).toBe(savedState.chunks[0]!.observations);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: abort
  // -------------------------------------------------------------------------

  describe('abort', () => {
    it('discards in-flight observer results', async () => {
      let resolvePromise: ((value: string) => void) | undefined;
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(
        new Promise<string>((resolve) => { resolvePromise = resolve; }),
      );

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        5,
        null,
        { previousObserverTokens: 2000 },
      );

      coordinator.abort();
      resolvePromise!(VALID_OBSERVER_OUTPUT);
      await flushPromises();

      expect(coordinator.hasCompletedChunks()).toBe(false);
    });

    it('discards in-flight reflector results', async () => {
      let resolvePromise: ((value: string) => void) | undefined;
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(
        new Promise<string>((resolve) => { resolvePromise = resolve; }),
      );

      coordinator.launchReflector(
        mockComplete,
        'observations',
        { reflectionThreshold: 1000 },
      );

      coordinator.abort();
      resolvePromise!(VALID_REFLECTOR_OUTPUT);
      await flushPromises();

      expect(coordinator.hasBufferedReflection()).toBe(false);
    });

    it('prevents new launches after abort', () => {
      coordinator.abort();

      const mockComplete = vi.fn<CompleteFn>();

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        5,
        null,
        { previousObserverTokens: 2000 },
      );

      coordinator.launchReflector(
        mockComplete,
        'observations',
        { reflectionThreshold: 1000 },
      );

      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Tests: watermark
  // -------------------------------------------------------------------------

  describe('watermark', () => {
    it('starts at 0', () => {
      expect(coordinator.getWatermark()).toBe(0);
    });

    it('restores with no chunks as an observed prefix', () => {
      coordinator.restoreState({ chunks: [], watermark: 42 });
      expect(coordinator.getWatermark()).toBe(42);
      expect(coordinator.getState().observedPrefix).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: onSourceTruncated (front-truncation reconciliation, H-4)
  // -------------------------------------------------------------------------

  describe('onSourceTruncated', () => {
    it('shifts the watermark down by the dropped-front count', () => {
      coordinator.restoreState({ chunks: [], watermark: 4 });
      coordinator.onSourceTruncated(2);
      expect(coordinator.getWatermark()).toBe(2);
    });

    it('clamps to 0 when more front messages are dropped than observed', () => {
      coordinator.restoreState({ chunks: [], watermark: 3 });
      coordinator.onSourceTruncated(10);
      expect(coordinator.getWatermark()).toBe(0);
    });

    it('is a no-op for zero or negative counts', () => {
      coordinator.restoreState({ chunks: [], watermark: 5 });
      coordinator.onSourceTruncated(0);
      expect(coordinator.getWatermark()).toBe(5);
      coordinator.onSourceTruncated(-3);
      expect(coordinator.getWatermark()).toBe(5);
    });

    it('moves an in-flight observer past the dropped messages with its range', async () => {
      let resolvePromise: ((value: string) => void) | undefined;
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(
        new Promise<string>((resolve) => { resolvePromise = resolve; }),
      );

      coordinator.restoreState({ chunks: [], watermark: 4 });
      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        10,
        null,
        { previousObserverTokens: 2000 },
      );

      // Front truncation of observed messages while the observer is in flight.
      coordinator.onSourceTruncated(2);

      resolvePromise!(VALID_OBSERVER_OUTPUT);
      await flushPromises();

      // Its messages moved down by 2 and so did its range: it lands aligned.
      expect(coordinator.hasCompletedChunks()).toBe(true);
      expect(coordinator.getWatermark()).toBe(8);
    });

    it('invalidates an in-flight observer whose messages were dropped', async () => {
      let resolvePromise: ((value: string) => void) | undefined;
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(
        new Promise<string>((resolve) => { resolvePromise = resolve; }),
      );

      coordinator.restoreState({ chunks: [], watermark: 4 });
      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        10,
        null,
        { previousObserverTokens: 2000 },
      );

      coordinator.onSourceTruncated(6);

      resolvePromise!(VALID_OBSERVER_OUTPUT);
      await flushPromises();

      expect(coordinator.hasCompletedChunks()).toBe(false);
      expect(coordinator.getWatermark()).toBe(0);
      expect(coordinator.isObserverInFlight()).toBe(false);
    });

    it('keeps the in-flight observer on a no-op count', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(VALID_OBSERVER_OUTPUT);

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        10,
        null,
        { previousObserverTokens: 2000 },
      );

      coordinator.onSourceTruncated(0);
      await flushPromises();

      // Nothing was dropped, so the in-flight observer must still land.
      expect(coordinator.hasCompletedChunks()).toBe(true);
      expect(coordinator.getWatermark()).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: onSourceTailTrimmed (tail-trim reconciliation, S2)
  // -------------------------------------------------------------------------

  describe('onSourceTailTrimmed', () => {
    it('clamps a watermark past the surviving source length', () => {
      coordinator.restoreState({ chunks: [], watermark: 5 });
      coordinator.onSourceTailTrimmed(3);
      expect(coordinator.getWatermark()).toBe(3);
    });

    it('leaves a watermark at or below the surviving length untouched', () => {
      coordinator.restoreState({ chunks: [], watermark: 3 });
      coordinator.onSourceTailTrimmed(3);
      expect(coordinator.getWatermark()).toBe(3);
      coordinator.onSourceTailTrimmed(7);
      expect(coordinator.getWatermark()).toBe(3);
    });

    it('treats a negative length as 0', () => {
      coordinator.restoreState({ chunks: [], watermark: 4 });
      coordinator.onSourceTailTrimmed(-1);
      expect(coordinator.getWatermark()).toBe(0);
    });

    it('clamps the end index of an in-flight observer so its landing watermark stays aligned', async () => {
      // The observer launches counting the aborted stub (endIndex 3), the
      // stub is trimmed while the call is in flight (surviving length 2),
      // then the observer completes. Its landing writes
      // `bufferWatermark = inFlightObserverEndIndex`, so without the
      // in-flight clamp the watermark would claim index 2 (a message that
      // arrives AFTER the trim) as observed.
      let resolvePromise: ((value: string) => void) | undefined;
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(
        new Promise<string>((resolve) => { resolvePromise = resolve; }),
      );

      coordinator.launchObserver(
        mockComplete,
        [userMsg('hello'), assistantMsg('working on it'), assistantMsg('(aborted stub)')],
        3,
        null,
        { previousObserverTokens: 2000 },
      );

      coordinator.onSourceTailTrimmed(2);

      resolvePromise!(VALID_OBSERVER_OUTPUT);
      await flushPromises();

      // The chunk lands (its text is still valid; describing a trimmed stub
      // is harmless) but the watermark reflects the surviving source only.
      expect(coordinator.hasCompletedChunks()).toBe(true);
      expect(coordinator.getWatermark()).toBe(2);
    });

    it('keeps an in-flight end index at or below the surviving length untouched', async () => {
      let resolvePromise: ((value: string) => void) | undefined;
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(
        new Promise<string>((resolve) => { resolvePromise = resolve; }),
      );

      coordinator.launchObserver(
        mockComplete,
        [userMsg('hello')],
        1,
        null,
        { previousObserverTokens: 2000 },
      );

      // The trim happened past the observed prefix; nothing to reconcile.
      coordinator.onSourceTailTrimmed(4);

      resolvePromise!(VALID_OBSERVER_OUTPUT);
      await flushPromises();

      expect(coordinator.getWatermark()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: activation epoch (race condition guard)
  // -------------------------------------------------------------------------

  describe('in-flight observer across rewrites', () => {
    it('lands at its shifted range after a swap removes observed messages before it', async () => {
      let resolvePromise: ((value: string) => void) | undefined;
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(
        new Promise<string>((resolve) => { resolvePromise = resolve; }),
      );
      coordinator.restoreState({
        chunks: [{ observations: 'first', messageTokensObserved: 1, createdAt: new Date(), endIndex: 4 }],
        watermark: 4,
      });

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        10,
        null,
        { previousObserverTokens: 2000 },
      );
      // A swap removes the four observed messages.
      expect(coordinator.ledger.removePrefix(4)).toHaveLength(1);

      resolvePromise!(VALID_OBSERVER_OUTPUT);
      await flushPromises();

      expect(coordinator.getCompletedChunks().chunks.map((c) => c.endIndex)).toEqual([6]);
      expect(coordinator.getWatermark()).toBe(6);
    });

    it('discards its result after invalidateObserver', async () => {
      let resolvePromise: ((value: string) => void) | undefined;
      const mockComplete = vi.fn<CompleteFn>().mockReturnValue(
        new Promise<string>((resolve) => { resolvePromise = resolve; }),
      );

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        10,
        null,
        { previousObserverTokens: 2000 },
      );

      // An in-band observation of the same messages takes over.
      coordinator.invalidateObserver();

      resolvePromise!(VALID_OBSERVER_OUTPUT);
      await flushPromises();

      expect(coordinator.hasCompletedChunks()).toBe(false);
      expect(coordinator.getWatermark()).toBe(0);
    });

    it('accepts the in-flight result when nothing changed', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(VALID_OBSERVER_OUTPUT);

      coordinator.launchObserver(
        mockComplete,
        [userMsg('test')],
        10,
        null,
        { previousObserverTokens: 2000 },
      );

      await flushPromises();

      // Nothing changed, so the result should land normally
      expect(coordinator.hasCompletedChunks()).toBe(true);
      expect(coordinator.getWatermark()).toBe(10);
    });
  });
});
