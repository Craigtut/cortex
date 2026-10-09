import { describe, it, expect, vi } from 'vitest';
import { EventBridge } from '../../../src/event-bridge.js';
import type { PiEvent } from '../../../src/event-bridge.js';
import { wireLoopEvents } from '../../../src/agent-loop/event-wiring.js';
import { HandlerList } from '../../../src/agent-loop/handler-list.js';
import { LoopUsage } from '../../../src/agent-loop/loop-usage.js';
import type { CompactionManager } from '../../../src/compaction/index.js';
import type { AgentMessage } from '../../../src/context-manager.js';

function setup(options?: { workingTags?: boolean; strategy?: 'observational' | 'classic' }) {
  let emit!: (event: PiEvent) => void;
  const bridge = new EventBridge(options?.workingTags ?? false);
  bridge.wire({ subscribe: (handler) => { emit = handler; return () => {}; } });
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const state: { messages: AgentMessage[]; errorMessage?: unknown } = { messages: [] };
  const compaction = {
    strategy: options?.strategy ?? 'observational',
    currentContextTokenCount: 0,
    updateCurrentContextTokenCount: vi.fn(),
    onTurnEnd: vi.fn(),
  };
  const ledger = new LoopUsage();
  const loopComplete = new HandlerList<[{ loopPath: string }]>('onLoopComplete', logger);
  const turnComplete = new HandlerList<[unknown, { loopPath: string }]>('onTurnComplete', logger);
  const onLoopEnd = vi.fn();
  const unwire = wireLoopEvents(bridge, {
    logger,
    diagnostics: { recordEvent: vi.fn() },
    ledger,
    agentState: () => state,
    historyStart: () => 0,
    compaction: () => compaction as unknown as CompactionManager,
    effectiveContextWindow: () => 100_000,
    budgetSummary: () => ({ turns: 1, totalCost: 0 }),
    onLoopEnd,
    loopComplete,
    turnComplete: turnComplete as never,
    origin: { loopPath: 'main' },
  });
  return { bridge, emit: (event: PiEvent) => emit(event), state, compaction, ledger, loopComplete, turnComplete, onLoopEnd, unwire };
}

const usage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 3, totalTokens: 15, cost: { total: 0.5 } };

describe('wireLoopEvents', () => {
  it('tracks context size, observation buffering, and session usage from typed turn usage', () => {
    const t = setup();
    t.emit({ type: 'turn_end', message: { role: 'assistant', content: [], usage } });
    expect(t.compaction.updateCurrentContextTokenCount).toHaveBeenCalledWith(33);
    expect(t.compaction.onTurnEnd).toHaveBeenCalledWith(33, 100_000, t.state.messages, 0);
    expect(t.ledger.snapshot().totalTurns).toBe(1);
    expect(t.ledger.totalCost).toBe(0.5);
  });

  it('falls back to raw event usage and still counts an unmetered turn', () => {
    const t = setup();
    // All-zero typed usage reads as absent to the bridge; the raw fallback
    // still finds cache-write input.
    t.emit({ type: 'turn_end', message: { role: 'assistant', content: [], usage: { cacheWrite: 7 } } });
    expect(t.compaction.updateCurrentContextTokenCount).toHaveBeenCalledWith(7);
    expect(t.compaction.onTurnEnd).toHaveBeenCalledWith(7, 100_000, t.state.messages, 0);
    expect(t.ledger.snapshot().totalTurns).toBe(1);
    expect(t.ledger.totalCost).toBe(0);
  });

  it('skips observation buffering when no usage is known at all', () => {
    const t = setup();
    t.emit({ type: 'turn_end', message: { role: 'assistant', content: [] } });
    expect(t.compaction.updateCurrentContextTokenCount).not.toHaveBeenCalled();
    expect(t.compaction.onTurnEnd).not.toHaveBeenCalled();
    expect(t.ledger.snapshot().totalTurns).toBe(1);
  });

  it('counts forwarded child usage without touching this loop\'s context or turn fan-out', () => {
    const t = setup();
    const onTurn = vi.fn();
    t.turnComplete.add(onTurn);
    const child = new EventBridge(false);
    let emitChild!: (event: PiEvent) => void;
    child.wire({ subscribe: (handler) => { emitChild = handler; return () => {}; } });
    t.bridge.forwardFrom(child, 'task-1');
    emitChild({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage } });
    expect(t.ledger.snapshot().totalTurns).toBe(1);
    expect(t.compaction.updateCurrentContextTokenCount).not.toHaveBeenCalled();
    expect(onTurn).not.toHaveBeenCalled();
    // A parent turn with the same shape does fan out.
    t.emit({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage } });
    expect(onTurn).toHaveBeenCalledTimes(1);
    expect(onTurn.mock.calls[0]![0].raw).toBe('hi');
  });

  it('suppresses onLoopComplete for a run that ended in error', () => {
    const t = setup();
    const onComplete = vi.fn();
    t.loopComplete.add(onComplete);
    t.state.errorMessage = 'boom';
    t.emit({ type: 'agent_end', messages: [] });
    expect(onComplete).not.toHaveBeenCalled();
    expect(t.onLoopEnd).not.toHaveBeenCalled();
    t.state.errorMessage = undefined;
    t.emit({ type: 'agent_end', messages: [] });
    expect(onComplete).toHaveBeenCalledWith({ loopPath: 'main' });
    expect(t.onLoopEnd).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes everything it wired', () => {
    const t = setup();
    t.unwire();
    t.emit({ type: 'turn_end', message: { role: 'assistant', content: [], usage } });
    expect(t.ledger.snapshot().totalTurns).toBe(0);
  });
});
