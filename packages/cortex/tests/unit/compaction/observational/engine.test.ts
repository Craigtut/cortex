import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObservationalMemoryEngine } from '../../../../src/compaction/observational/index.js';
import {
  OBSERVATION_CONTEXT_PREAMBLE,
  OBSERVATION_RECALL_INSTRUCTIONS,
} from '../../../../src/compaction/observational/constants.js';
import type { CompleteFn } from '../../../../src/compaction/compaction.js';
import type { AgentMessage } from '../../../../src/context-manager.js';
import type {
  ObservationalMemoryState,
  ObservationEvent,
  ReflectionEvent,
} from '../../../../src/compaction/observational/types.js';
import type { AgentContext } from '../../../../src/context-manager.js';
import {
  makeUserMsg,
  makeToolCallMsg,
  makeToolResultMsg,
  assertNoOrphans,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });
const assistantMsg = (content: string): AgentMessage => ({ role: 'assistant', content, timestamp: 0 });

const OBSERVER_OUTPUT =
  '<observations>\nDate: Apr 10, 2026\n\n* \u{1F7E1} (14:30) Test observation\n</observations>\n\n' +
  '<current-task>\nTesting the observational memory engine with sample fixtures.\n</current-task>\n\n' +
  '<suggested-response>\nContinue testing the engine with the next scenario.\n</suggested-response>';

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Record `history` in the log through the explicit entry point. */
function observeNow(engine: ObservationalMemoryEngine, history: AgentMessage[]) {
  return engine.observeNow(() => history, { tokensBefore: 0 });
}

// ---------------------------------------------------------------------------
// Tests: Constructor
// ---------------------------------------------------------------------------

describe('ObservationalMemoryEngine', () => {
  describe('constructor', () => {
    it('merges partial config with defaults', () => {
      const engine = new ObservationalMemoryEngine(
        { activationThreshold: 0.85 },
        0,
      );

      // Verify the engine works with merged config by checking slot content
      const slot = engine.buildSlotContent();
      expect(slot).toContain(OBSERVATION_CONTEXT_PREAMBLE);
    });

    it('works with empty config', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const slot = engine.buildSlotContent();
      expect(slot).toContain(OBSERVATION_CONTEXT_PREAMBLE);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: buildSlotContent
  // -------------------------------------------------------------------------

  describe('buildSlotContent', () => {
    it('includes preamble and empty observations', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const slot = engine.buildSlotContent();

      expect(slot).toContain(OBSERVATION_CONTEXT_PREAMBLE);
      expect(slot).toContain('<observations>');
      expect(slot).toContain('</observations>');
    });

    it('includes recall instructions when recall is configured', () => {
      const engine = new ObservationalMemoryEngine(
        {
          recall: {
            search: vi.fn().mockResolvedValue([]),
          },
        },
        0,
      );

      const slot = engine.buildSlotContent();
      expect(slot).toContain(OBSERVATION_RECALL_INSTRUCTIONS);
    });

    it('excludes recall instructions when recall is not configured', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const slot = engine.buildSlotContent();
      expect(slot).not.toContain('Recall Tool');
    });

    it('includes continuation hints when present', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      // Observe to set continuation hints
      await observeNow(engine, [userMsg('Hello')]);

      const slot = engine.buildSlotContent();
      expect(slot).toContain('<current-task>');
      expect(slot).toContain('Testing');
      expect(slot).toContain('<suggested-response>');
      expect(slot).toContain('Continue testing');
    });

    it('includes observations after they are generated', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      await observeNow(engine, [userMsg('Hello')]);

      const slot = engine.buildSlotContent();
      expect(slot).toContain('Test observation');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: getState / restoreState
  // -------------------------------------------------------------------------

  describe('getState / restoreState', () => {
    it('returns initial empty state', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const state = engine.getState();

      expect(state.observations).toBe('');
      expect(state.continuationHint).toBeNull();
      expect(state.observationTokenCount).toBe(0);
      expect(state.generationCount).toBe(0);
      expect(state.bufferedChunks).toEqual([]);
    });

    it('round-trips state through save and restore', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      await observeNow(engine, [userMsg('Hello')]);
      const savedState = engine.getState();

      // Create a new engine and restore state
      const newEngine = new ObservationalMemoryEngine({}, 0);
      newEngine.restoreState(savedState);

      const restoredState = newEngine.getState();
      expect(restoredState.observations).toBe(savedState.observations);
      expect(restoredState.continuationHint).toEqual(savedState.continuationHint);
      expect(restoredState.observationTokenCount).toBe(savedState.observationTokenCount);
      expect(restoredState.generationCount).toBe(savedState.generationCount);
    });

    it('restored engine produces same slot content', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      await observeNow(engine, [userMsg('Hello')]);
      const originalSlot = engine.getSlotContent();
      const savedState = engine.getState();

      const newEngine = new ObservationalMemoryEngine({}, 0);
      newEngine.restoreState(savedState);

      expect(newEngine.getSlotContent()).toBe(originalSlot);
    });

    it('includes the buffer watermark in initial state', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      expect(engine.getState().bufferWatermark).toBe(0);
    });

    // Build an engine with one completed buffer chunk via onTurnEnd.
    async function engineWithBufferedChunk(): Promise<ObservationalMemoryEngine> {
      const engine = new ObservationalMemoryEngine({
        activationThreshold: 0.9,
        bufferMinTokens: 1_000,
        bufferTargetCycles: 4,
        bufferTokenCap: 30_000,
      }, 0);
      engine.setCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT));
      engine.setContextWindow(100_000);
      engine.setUtilityModelContextWindow(200_000);

      // ~12500 tokens of unobserved messages exceeds the ~10000 buffer interval
      engine.onTurnEnd(50_000, 100_000, [userMsg('x'.repeat(50_000))], 0);
      await flushPromises();
      return engine;
    }

    it('round-trips buffered chunks and watermark', async () => {
      const engine = await engineWithBufferedChunk();
      const savedState = engine.getState();

      expect(savedState.bufferedChunks).toHaveLength(1);
      expect(savedState.bufferWatermark).toBe(1);

      const newEngine = new ObservationalMemoryEngine({}, 0);
      newEngine.restoreState(savedState, 1);

      const restored = newEngine.getState();
      expect(restored.bufferedChunks).toHaveLength(1);
      expect(restored.bufferedChunks[0]!.observations).toBe(savedState.bufferedChunks[0]!.observations);
      expect(restored.bufferWatermark).toBe(1);
    });

    it('survives JSON serialization and rehydrates chunk createdAt as a Date', async () => {
      const engine = await engineWithBufferedChunk();
      const persisted: ObservationalMemoryState = JSON.parse(JSON.stringify(engine.getState()));

      // After JSON round-trip, createdAt is a string on the wire.
      expect(typeof persisted.bufferedChunks[0]!.createdAt).toBe('string');

      const newEngine = new ObservationalMemoryEngine({}, 0);
      newEngine.restoreState(persisted, 1);

      expect(newEngine.getState().bufferedChunks[0]!.createdAt).toBeInstanceOf(Date);
    });

    it('discards chunks from legacy state without a watermark', async () => {
      const engine = await engineWithBufferedChunk();
      const legacyState = engine.getState();
      // Simulate a session saved before buffer persistence existed.
      delete (legacyState as { bufferWatermark?: number }).bufferWatermark;
      expect(legacyState.bufferedChunks).toHaveLength(1);

      const newEngine = new ObservationalMemoryEngine({}, 0);
      newEngine.restoreState(legacyState);

      const restored = newEngine.getState();
      expect(restored.bufferedChunks).toEqual([]);
      expect(restored.bufferWatermark).toBe(0);
    });

    it('clamps a watermark that drifted ahead of the restored history', async () => {
      const engine = await engineWithBufferedChunk();
      const savedState = engine.getState();
      savedState.bufferWatermark = 99; // stale: history only has 1 message

      const newEngine = new ObservationalMemoryEngine({}, 0);
      newEngine.restoreState(savedState, 1);

      expect(newEngine.getState().bufferWatermark).toBe(1);
    });

    it('launches no observer on restore; the tail is observed lazily on turn_end', async () => {
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      const engine = new ObservationalMemoryEngine({
        activationThreshold: 0.9,
        bufferMinTokens: 1_000,
        bufferTargetCycles: 4,
        bufferTokenCap: 30_000,
      }, 0);
      engine.setCompleteFn(mockComplete);
      engine.setContextWindow(100_000);
      engine.setUtilityModelContextWindow(200_000);

      // Resume a session whose watermark sits behind the conversation tail.
      engine.restoreState(
        {
          observations: 'prior observations',
          continuationHint: null,
          observationTokenCount: 4,
          generationCount: 0,
          bufferedChunks: [],
          bufferWatermark: 0,
        },
        0,
      );
      await flushPromises();

      // Reopening a session must not cost a utility-model call.
      expect(mockComplete).not.toHaveBeenCalled();
      expect(engine.isObserverInFlight()).toBe(false);

      // The unobserved tail is still picked up lazily through normal operation,
      // once it crosses the dynamic buffer interval (~10k here).
      engine.onTurnEnd(50_000, 100_000, [userMsg('x'.repeat(50_000))], 0);
      expect(engine.isObserverInFlight()).toBe(true);
      await flushPromises();
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: onObservation / onReflection handlers
  // -------------------------------------------------------------------------

  describe('onObservation / onReflection', () => {
    it('fires observation handler with correct payload on observeNow', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      const handler = vi.fn();
      engine.onObservation(handler);

      await observeNow(engine, [userMsg('Hello'), assistantMsg('Hi')]);

      expect(handler).toHaveBeenCalledOnce();
      const event: ObservationEvent = handler.mock.calls[0]![0];
      expect(event.trigger).toBe('observe-now');
      expect(event.observedMessages.length).toBe(2);
      expect(event.removedMessages).toEqual([]);
      expect(event.observations).toContain('Test observation');
      expect(event.sync).toBe(true);
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it('supports multiple observation handlers', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      engine.onObservation(handler1);
      engine.onObservation(handler2);

      await observeNow(engine, [userMsg('Hello')]);

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('isolates handler errors so one does not break others', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);
      engine.setLogger({ warn: vi.fn(), info: vi.fn() });

      const throwingHandler = vi.fn(() => { throw new Error('handler error'); });
      const goodHandler = vi.fn();
      engine.onObservation(throwingHandler);
      engine.onObservation(goodHandler);

      await observeNow(engine, [userMsg('Hello')]);

      expect(throwingHandler).toHaveBeenCalledOnce();
      expect(goodHandler).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Tests: onTurnEnd
  // -------------------------------------------------------------------------

  describe('onTurnEnd', () => {
    let engine: ObservationalMemoryEngine;
    let mockComplete: ReturnType<typeof vi.fn<CompleteFn>>;

    beforeEach(() => {
      engine = new ObservationalMemoryEngine({
        activationThreshold: 0.9,
        bufferMinTokens: 1_000,
        bufferTargetCycles: 4,
        bufferTokenCap: 30_000,
      }, 0);

      mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);
      engine.setContextWindow(100_000);
      engine.setUtilityModelContextWindow(200_000);
    });

    it('triggers buffer when unobserved tokens exceed interval', () => {
      // Current utilization: 50000/100000 = 50%
      // Tokens until activation: (0.9 - 0.5) * 100000 = 40000
      // Buffer interval: 40000 / 4 = 10000 (within cap and above floor)
      // Need messages with more than 10000 tokens
      const largeMsg = userMsg('x'.repeat(50_000)); // ~12500 tokens
      engine.onTurnEnd(50_000, 100_000, [largeMsg], 0);

      expect(mockComplete).toHaveBeenCalled();
    });

    it('does not trigger when unobserved tokens are below interval', () => {
      // With small messages, tokens will be below the buffer interval
      const smallMsg = userMsg('hello');
      engine.onTurnEnd(50_000, 100_000, [smallMsg], 0);

      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('keeps buffering past the activation threshold, at the floor interval', () => {
      // Utilization = 95000/100000 = 95%, above 90% threshold. Activation
      // can only swap in what is observed, so observing continues.
      engine.onTurnEnd(95_000, 100_000, [userMsg('x'.repeat(50_000))], 0);

      expect(mockComplete).toHaveBeenCalledTimes(1);
    });

    it('past the threshold, still skips an unobserved tail below the floor', () => {
      engine.onTurnEnd(95_000, 100_000, [userMsg('x'.repeat(400))], 0);

      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('does not trigger when contextWindow is 0', () => {
      const msg = userMsg('x'.repeat(50_000));
      engine.onTurnEnd(50_000, 0, [msg], 0);

      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('does not trigger when completeFn is not set', () => {
      const noCompleteEngine = new ObservationalMemoryEngine({}, 0);
      noCompleteEngine.setContextWindow(100_000);
      noCompleteEngine.setUtilityModelContextWindow(200_000);

      const msg = userMsg('x'.repeat(50_000));
      noCompleteEngine.onTurnEnd(50_000, 100_000, [msg], 0);

      // No error should be thrown, just silently skips
    });
  });

  // -------------------------------------------------------------------------
  // Tests: misc
  // -------------------------------------------------------------------------

  describe('digestPendingBuffers', () => {
    it('reports false when the coordinator is aborted and no observer launches', async () => {
      const engine = new ObservationalMemoryEngine({ bufferMinTokens: 10 }, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);
      engine.abort();

      // launchObserver declines on the aborted coordinator, so no observer
      // ran; reporting true here would be a false positive to digestIdle.
      const ran = await engine.digestPendingBuffers(
        [userMsg('long enough content '.repeat(50))],
        0,
      );

      expect(ran).toBe(false);
      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  describe('miscellaneous', () => {
    it('hasRecall returns false when not configured', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      expect(engine.hasRecall()).toBe(false);
    });

    it('hasRecall returns true when configured', () => {
      const engine = new ObservationalMemoryEngine({
        recall: { search: vi.fn().mockResolvedValue([]) },
      }, 0);
      expect(engine.hasRecall()).toBe(true);
    });

    it('getRecallConfig returns the config when provided', () => {
      const search = vi.fn().mockResolvedValue([]);
      const engine = new ObservationalMemoryEngine({
        recall: { search },
      }, 0);

      const config = engine.getRecallConfig();
      expect(config).toBeDefined();
      expect(config!.search).toBe(search);
    });

    it('getRecallConfig returns undefined when not configured', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      expect(engine.getRecallConfig()).toBeUndefined();
    });

    it('abort does not throw', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      expect(() => engine.abort()).not.toThrow();
    });

    it('getObservations returns empty string initially', () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      expect(engine.getObservations()).toBe('');
    });

    it('getObservations returns observations after trigger', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT);
      engine.setCompleteFn(mockComplete);

      await observeNow(engine, [userMsg('Hello')]);
      expect(engine.getObservations()).toContain('Test observation');
    });

    it('observeNow fails without a memory model and leaves the log empty', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const result = await observeNow(engine, [userMsg('Hello')]);
      expect(result.status).toBe('failed');
      expect(engine.getObservations()).toBe('');
    });

    it('observeNow has nothing to observe with empty history', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      const mockComplete = vi.fn<CompleteFn>();
      engine.setCompleteFn(mockComplete);

      expect(await observeNow(engine, [])).toEqual({ status: 'nothing-to-observe' });
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('appends only what is new on a later observeNow', async () => {
      const engine = new ObservationalMemoryEngine({}, 0);
      let callCount = 0;
      const mockComplete = vi.fn<CompleteFn>().mockImplementation(async () => {
        callCount++;
        return `<observations>\nObservation batch ${callCount}\n</observations>`;
      });
      engine.setCompleteFn(mockComplete);

      const history = [userMsg('First')];
      await observeNow(engine, history);
      history.push(userMsg('Second'));
      await observeNow(engine, history);

      const observations = engine.getObservations();
      expect(observations).toContain('Observation batch 1');
      expect(observations).toContain('Observation batch 2');
      const secondInput = JSON.stringify(mockComplete.mock.calls[1]![0].messages);
      expect(secondInput).toContain('Second');
      expect(secondInput).not.toContain('First');
    });
  });

  // -------------------------------------------------------------------------
  // Tests: onSourceHistoryTruncated (H-4, emergency-truncation reconciliation)
  // -------------------------------------------------------------------------

  describe('onSourceHistoryTruncated', () => {
    // Two plain user messages, then a Read group, then an unobserved Bash group.
    // The observer runs over the first 4 messages (watermark = 4), which is a
    // clean group boundary. Emergency truncation then drops the two leading
    // user messages (group-clean: both are plain user turns).
    const U0 = makeUserMsg('x'.repeat(50_000)); // large: exceeds buffer interval
    const U1 = makeUserMsg('second setup message');
    const callA = makeToolCallMsg([{ id: 'call_A', name: 'Read', arguments: { path: '/a' } }]);
    // Large result so activation's post-chunk utilization drops below the
    // activation threshold, keeping the Step 2 sync observer from firing and
    // letting us inspect the surviving unobserved source directly.
    const resultA = makeToolResultMsg('call_A', 'Read', 'y'.repeat(80_000));
    const U2 = makeUserMsg('unobserved follow-up request');
    const callB = makeToolCallMsg([{ id: 'call_B', name: 'Bash', arguments: { command: 'ls' } }]);
    const resultB = makeToolResultMsg('call_B', 'Bash', 'dir listing');

    // Source AFTER emergency truncation dropped the two leading user messages.
    const truncatedSource = [callA, resultA, U2, callB, resultB];

    async function buildEngineWatermark4(): Promise<ObservationalMemoryEngine> {
      const engine = new ObservationalMemoryEngine({
        activationThreshold: 0.9,
        bufferMinTokens: 1_000,
        bufferTargetCycles: 4,
        // One observer call takes all four messages.
        bufferTokenCap: 100_000,
      }, 0);
      engine.setCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT));
      engine.setContextWindow(100_000);
      engine.setUtilityModelContextWindow(200_000);

      // Observe the first 4 messages; the async observer sets watermark = 4.
      engine.onTurnEnd(50_000, 100_000, [U0, U1, callA, resultA], 0);
      await flushPromises();
      expect(engine.getState().bufferWatermark).toBe(4);
      return engine;
    }

    async function activate(
      engine: ObservationalMemoryEngine,
    ): Promise<AgentMessage[]> {
      const slotCount = 1;
      let source: AgentMessage[] = [...truncatedSource];
      const context: AgentContext = {
        systemPrompt: '',
        model: {},
        messages: [makeUserMsg('<observation-slot>')],
        tools: [],
        thinkingLevel: 'none',
      };
      const getHistory = (ctx: AgentContext) => ctx.messages.slice(slotCount);
      const setHistory = (ctx: AgentContext, hist: AgentMessage[]): AgentContext => ({
        ...ctx,
        messages: [...ctx.messages.slice(0, slotCount), ...hist],
      });
      const getSourceHistory = () => source;
      const setSourceHistory = (h: AgentMessage[]) => { source = h; };

      await engine.applyInTransformContext(
        context, 0.95, slotCount, getHistory, setHistory, getSourceHistory, setSourceHistory,
      );
      return source;
    }

    it('shifts the buffer watermark down by the dropped-front count', async () => {
      const engine = await buildEngineWatermark4();
      engine.onSourceHistoryTruncated(2);
      expect(engine.getState().bufferWatermark).toBe(2);
    });

    it('next activation neither destroys unobserved messages nor orphans a tool result', async () => {
      const engine = await buildEngineWatermark4();

      // Reconcile the buffer with the front-truncated source (the fix).
      engine.onSourceHistoryTruncated(2);

      const survivingSource = await activate(engine);

      // No orphaned tool call or tool result at the head (would be a hard 400).
      assertNoOrphans(survivingSource);
      expect(survivingSource[0]!.role).not.toBe('toolResult');

      // The genuinely unobserved tail is preserved intact, not silently trimmed.
      expect(survivingSource).toContain(U2);
      expect(survivingSource).toContain(callB);
      expect(survivingSource).toContain(resultB);
    });

    it('even without reconciliation, a stale watermark cannot orphan a tool result', async () => {
      const engine = await buildEngineWatermark4();

      // Skip the reconciliation: the watermark stays at the pre-truncation 4,
      // inside the [callB, resultB] group. Swaps cut on unit boundaries, so
      // the group stays whole.
      const survivingSource = await activate(engine);

      assertNoOrphans(survivingSource);
      expect(survivingSource).toContain(callB);
      expect(survivingSource).toContain(resultB);
    });
  });

  // -------------------------------------------------------------------------
  // Tests: onSourceHistoryTailTrimmed (S2, abort/failure tail-trim
  // reconciliation)
  // -------------------------------------------------------------------------

  describe('onSourceHistoryTailTrimmed', () => {
    // The observer runs over [U0, U1, STUB] (watermark = 3), where STUB is
    // the aborted assistant stub pi appended and emitted turn_end for.
    // Cortex then trims the stub (surviving length 2), and the conversation
    // continues with a tool group and a follow-up:
    //   [U0, U1, callB, resultB, U2]
    // A stale watermark of 3 would slice [U0, U1, callB], destroying the
    // unobserved callB and leaving resultB orphaned at the head.
    const U0 = makeUserMsg('x'.repeat(50_000)); // large: exceeds buffer interval
    const U1 = makeUserMsg('second setup message');
    const STUB: AgentMessage = {
      role: 'assistant',
      content: [],
      timestamp: 0,
    };
    const callB = makeToolCallMsg([{ id: 'call_B', name: 'Bash', arguments: { command: 'ls' } }]);
    // Large result keeps post-chunk utilization below the activation
    // threshold so the Step 2 sync observer does not fire and the surviving
    // unobserved source can be inspected directly.
    const resultB = makeToolResultMsg('call_B', 'Bash', 'y'.repeat(80_000));
    const U2 = makeUserMsg('unobserved follow-up request');

    // Source at the next activation, after the stub trim and further turns.
    const postTrimSource = [U0, U1, callB, resultB, U2];

    async function buildEngineWatermark3(): Promise<ObservationalMemoryEngine> {
      const engine = new ObservationalMemoryEngine({
        activationThreshold: 0.9,
        bufferMinTokens: 1_000,
        bufferTargetCycles: 4,
        bufferTokenCap: 30_000,
      }, 0);
      engine.setCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVER_OUTPUT));
      engine.setContextWindow(100_000);
      engine.setUtilityModelContextWindow(200_000);

      // Observe through the stub; the async observer sets watermark = 3.
      engine.onTurnEnd(50_000, 100_000, [U0, U1, STUB], 0);
      await flushPromises();
      expect(engine.getState().bufferWatermark).toBe(3);
      return engine;
    }

    async function activate(
      engine: ObservationalMemoryEngine,
    ): Promise<AgentMessage[]> {
      const slotCount = 1;
      let source: AgentMessage[] = [...postTrimSource];
      const context: AgentContext = {
        systemPrompt: '',
        model: {},
        messages: [makeUserMsg('<observation-slot>')],
        tools: [],
        thinkingLevel: 'none',
      };
      const getHistory = (ctx: AgentContext) => ctx.messages.slice(slotCount);
      const setHistory = (ctx: AgentContext, hist: AgentMessage[]): AgentContext => ({
        ...ctx,
        messages: [...ctx.messages.slice(0, slotCount), ...hist],
      });
      const getSourceHistory = () => source;
      const setSourceHistory = (h: AgentMessage[]) => { source = h; };

      await engine.applyInTransformContext(
        context, 0.95, slotCount, getHistory, setHistory, getSourceHistory, setSourceHistory,
      );
      return source;
    }

    it('clamps the buffer watermark to the surviving source length', async () => {
      const engine = await buildEngineWatermark3();
      engine.onSourceHistoryTailTrimmed(2);
      expect(engine.getState().bufferWatermark).toBe(2);
    });

    it('next activation neither destroys unobserved messages nor orphans a tool result', async () => {
      const engine = await buildEngineWatermark3();

      // Reconcile the buffer with the tail-trimmed source (the fix).
      engine.onSourceHistoryTailTrimmed(2);

      const survivingSource = await activate(engine);

      // No orphaned tool call or tool result at the head (would be a hard 400).
      assertNoOrphans(survivingSource);
      expect(survivingSource[0]!.role).not.toBe('toolResult');

      // The genuinely unobserved tail is preserved intact, not silently trimmed.
      expect(survivingSource).toContain(callB);
      expect(survivingSource).toContain(resultB);
      expect(survivingSource).toContain(U2);
    });

    it('even without reconciliation, a stale watermark cannot orphan a tool result', async () => {
      const engine = await buildEngineWatermark3();

      // Skip the reconciliation: the watermark still counts the trimmed stub
      // and points inside the [callB, resultB] group. Swaps cut on unit
      // boundaries, so the group stays whole.
      const survivingSource = await activate(engine);

      assertNoOrphans(survivingSource);
      expect(survivingSource).toContain(callB);
      expect(survivingSource).toContain(resultB);
    });
  });
});
