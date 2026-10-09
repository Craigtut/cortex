import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '../../../src/context-manager.js';
import {
  isResumableAfterTrim,
  isTrimmableFailureMessage,
  trailingFailureCount,
  trimTrailingFailures,
  unwindFailedDelivery,
  unwindSplicedBatch,
} from '../../../src/agent-loop/transcript-repair.js';

const user = (content: string) => ({ role: 'user', content }) as unknown as AgentMessage;
const stub = () => ({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'x' }) as unknown as AgentMessage;
const answer = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }) as unknown as AgentMessage;
const toolCallTurn = () => ({ role: 'assistant', content: [{ type: 'toolCall', name: 'Bash' }], stopReason: 'toolUse' }) as unknown as AgentMessage;

describe('failure stubs', () => {
  it('keeps an aborted message that carries text the user saw', () => {
    expect(isTrimmableFailureMessage({ role: 'assistant', stopReason: 'aborted', content: [{ type: 'text', text: 'partial' }] })).toBe(false);
    expect(isTrimmableFailureMessage({ role: 'assistant', stopReason: 'aborted', content: [] })).toBe(true);
    expect(isTrimmableFailureMessage({ role: 'assistant', stopReason: 'aborted', content: [{ type: 'text', text: 't' }, { type: 'toolCall' }] })).toBe(true);
    expect(isTrimmableFailureMessage({ role: 'assistant', stopReason: 'error', content: [] })).toBe(true);
    expect(isTrimmableFailureMessage({ role: 'user', stopReason: 'error' })).toBe(false);
  });

  it('counts and trims trailing stubs down to a floor', () => {
    const messages = [user('a'), stub(), user('b'), stub(), stub()];
    expect(trailingFailureCount(messages)).toBe(2);
    expect(trailingFailureCount(messages, 4)).toBe(1);
    expect(trimTrailingFailures(messages)).toBe(true);
    expect(messages).toHaveLength(3);
    expect(trimTrailingFailures(messages)).toBe(false);
  });

  it('is resumable only past the slot region and never on an assistant tail', () => {
    expect(isResumableAfterTrim([user('slot'), user('q'), stub()], 1)).toBe(true);
    expect(isResumableAfterTrim([user('slot'), stub()], 1)).toBe(false);
    expect(isResumableAfterTrim([user('slot'), user('q'), toolCallTurn(), stub()], 1)).toBe(false);
  });

  it('looks past a trailing system update to the last turn', () => {
    const update = { role: 'system', content: '', toolsAdded: [], timestamp: 1 } as unknown as AgentMessage;
    const result = { role: 'toolResult', content: [{ type: 'text', text: 'r' }] } as unknown as AgentMessage;
    expect(isResumableAfterTrim([user('slot'), toolCallTurn(), result, update], 1)).toBe(true);
    expect(isResumableAfterTrim([user('slot'), user('q'), answer('done'), update], 1)).toBe(false);
    expect(isResumableAfterTrim([user('slot'), update], 1)).toBe(false);
  });
});

describe('unwinding around system messages', () => {
  const declaration = () => ({ role: 'system', content: '', toolsAdded: [{ name: 't' }], timestamp: 1 }) as unknown as AgentMessage;
  const patch = () => ({ role: 'system', content: '', sections: { A: 'b' }, timestamp: 1 }) as unknown as AgentMessage;

  it('requeues a delivery pi declared a tool change ahead of, keeping the declaration', () => {
    const messages = [user('old'), declaration(), user('delivery'), stub()];
    expect(unwindFailedDelivery(messages, 1)).toMatchObject({ outcome: 'requeue', removed: [2, 3] });
    expect(messages.map((m) => m.role)).toEqual(['user', 'system']);
  });

  it('requeues a delivery a prompt patch followed', () => {
    const messages = [user('old'), user('delivery'), patch(), stub()];
    // The delivery leaves from before the patch, which stays.
    expect(unwindFailedDelivery(messages, 1)).toMatchObject({ outcome: 'requeue', removed: [1, 3] });
    expect(messages.map((m) => m.role)).toEqual(['user', 'system']);
  });

  it('never hands the delivery itself back as injected text', () => {
    const messages = [user('old'), declaration(), user('delivery'), user('steered'), toolCallTurn(), stub()];
    const result = unwindFailedDelivery(messages, 1);
    expect(result).toEqual({ outcome: 'requeue', injectedUserTexts: ['steered'], removed: [2, 3, 4, 5] });
    expect(messages.map((m) => m.role)).toEqual(['user', 'system']);
  });

  it('reparks a spliced batch pi declared a tool change ahead of', () => {
    const messages = [user('old'), declaration(), user('wake'), user('prompt'), stub()];
    expect(unwindSplicedBatch(messages, [{ content: 'wake' }], 1, 0))
      .toEqual({ outcome: 'repark', removed: [2] });
    expect(messages.map((m) => (m.role === 'user' ? m.content : m.role))).toEqual(['old', 'system', 'prompt', 'assistant']);
  });

  it('does not count a prompt patch as progress past a spliced batch', () => {
    const messages = [user('old'), user('wake'), user('prompt'), patch(), stub()];
    expect(unwindSplicedBatch(messages, [{ content: 'wake' }], 1, 0).outcome).toBe('repark');
  });
});

describe('unwindFailedDelivery', () => {
  it('removes the delivery message and its stub when the run made no progress', () => {
    const messages = [user('old'), user('delivery'), stub()];
    expect(unwindFailedDelivery(messages, 1)).toEqual({ outcome: 'requeue', injectedUserTexts: [], removed: [1, 2] });
    expect(messages).toEqual([user('old')]);
  });

  it('requeues content that never landed, and keeps durable progress', () => {
    expect(unwindFailedDelivery([user('old')], 1).outcome).toBe('requeue');
    const toolResult = { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] } as unknown as AgentMessage;
    const progressed = [user('old'), user('delivery'), toolCallTurn(), toolResult, stub()];
    // Only the stub leaves.
    expect(unwindFailedDelivery(progressed, 1)).toMatchObject({ outcome: 'durable', removed: [4] });
    expect(progressed).toHaveLength(4);
  });

  it('unwinds an unpaired tool call and hands back injected user text', () => {
    const messages = [user('old'), user('delivery'), toolCallTurn(), user('steered'), toolCallTurn(), stub()];
    const unwind = unwindFailedDelivery(messages, 1);
    expect(unwind).toEqual({ outcome: 'requeue', injectedUserTexts: ['steered'], removed: [1, 2, 3, 4, 5] });
    expect(messages).toEqual([user('old')]);
  });
});

describe('unwindSplicedBatch', () => {
  const batch = [{ content: 'w1' }, { content: 'w2' }];

  it('splices the wake messages back out when nothing answered them', () => {
    const messages = [user('old'), user('w1'), user('w2'), user('silent'), user('prompt'), stub()];
    expect(unwindSplicedBatch(messages, batch, 1, 1)).toEqual({ outcome: 'repark', removed: [1, 2] });
    expect(messages).toEqual([user('old'), user('silent'), user('prompt'), stub()]);
  });

  it('reparks without touching history when the batch never landed', () => {
    const messages = [user('old')];
    expect(unwindSplicedBatch(messages, batch, 1, 0)).toEqual({ outcome: 'repark', removed: [] });
  });

  it('leaves durable and rewritten transcripts alone', () => {
    const progressed = [user('old'), user('w1'), user('w2'), user('prompt'), answer('a')];
    expect(unwindSplicedBatch(progressed, batch, 1, 0).outcome).toBe('durable');
    const rewritten = [user('old'), user('w1'), user('other')];
    expect(unwindSplicedBatch(rewritten, batch, 1, 0).outcome).toBe('rewritten');
    expect(rewritten).toHaveLength(3);
  });
});
