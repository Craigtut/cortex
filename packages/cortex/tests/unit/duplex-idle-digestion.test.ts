/**
 * Idle digestion is background work in a quiet moment. It holds a loop's
 * gate while it runs, so the moment the user speaks again it has to get out
 * of the way: the user's input must not wait out observer catch-up and
 * forced compaction, and a steer that lands while the talker has no run in
 * flight must become a real, logged utterance.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createDuplexScenario,
  destroyLiveFacades,
  entriesOfType,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { DuplexScenarioHarness } from './duplex-scenario-harness.js';
import type { AgentMessage } from '../../src/context-manager.js';
import type { CompleteFn } from '../../src/compaction/observational/types.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

/**
 * Run one exchange, then let the scheduled digestion start on the talker
 * against an observer call that never settles, so the pass holds the gate
 * for its full timeout unless something preempts it.
 */
async function talkerDigestingOnAHungObserver(): Promise<DuplexScenarioHarness> {
  const h = createDuplexScenario({ duplex: { idleDigestionDelayMs: 5 } });
  const hung = vi.fn(() => new Promise<string>(() => {}));
  h.talkerLoop.getCompactionManager().setObservationalCompleteFn(hung as unknown as CompleteFn);
  h.talkerPi.state.messages.push(
    { role: 'user', content: 'talk '.repeat(3_000), timestamp: 1 } as AgentMessage,
    { role: 'assistant', content: 'reply '.repeat(3_000), timestamp: 2 } as AgentMessage,
  );
  h.talkerPi.script = [{ text: 'Hello.' }];
  await h.facade.prompt('hi');
  await waitUntil(() => hung.mock.calls.length === 1, 2000, 'digestion started');
  // Precondition: the digestion pass is what holds the talker's gate now.
  expect(h.talkerLoop.isLoopActive).toBe(true);
  expect(h.talkerLoop.isPrompting).toBe(false);
  return h;
}

describe('user input during idle digestion', () => {
  it('preempts the pass instead of waiting behind it', async () => {
    const h = await talkerDigestingOnAHungObserver();
    h.talkerPi.script = [{ text: 'Sure, here it is.' }];
    // Well inside the 60s observer timeout the pass would otherwise wait.
    void h.facade.prompt('what was that file called?');
    await waitUntil(() => h.talkerPi.promptCalls.length === 2, 500, 'the talker answered');
    expect(entriesOfType(h.facade, 'reply').map((entry) => entry.content))
      .toEqual(['Hello.', 'Sure, here it is.']);
  });

  it('turns a steer with no talker turn in flight into a logged utterance', async () => {
    const h = await talkerDigestingOnAHungObserver();
    h.talkerPi.script = [{ text: 'Got it.' }];
    h.facade.steer('actually, use the staging database');
    await waitUntil(() => h.talkerPi.promptCalls.length === 2, 500, 'the steer reached a run');
    expect(entriesOfType(h.facade, 'utterance').map((entry) => entry.content))
      .toEqual(['hi', 'actually, use the staging database']);
    await waitUntil(() => entriesOfType(h.facade, 'reply').length === 2, 500, 'answered');
  });
});
