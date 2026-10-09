/**
 * Fan-out callback origin: can a duplex consumer tell the two loops apart?
 *
 * A composite agent registers one consumer handler on several loops, so every
 * fan-out callback fires once per loop. That is correct (both loops really do
 * complete turns, retry, and compact), but until each carried a
 * LoopOriginContext the two arrivals were indistinguishable, and a consumer
 * could only render both: two retry countdowns for one provider hiccup, two
 * compaction notifications for one compaction, an onLoopComplete that did not
 * even say which loop had finished.
 *
 * These drive the REAL facade and the REAL loops, then assert the origin the
 * consumer actually receives. Asserting on what a registration helper does
 * with the handler would pass against wiring that never fires.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AgentMessage } from '../../src/context-manager.js';
import type { CompleteFn } from '../../src/compaction/observational/types.js';
import {
  createDuplexScenario,
  createRealDuplexScenario,
  destroyLiveFacades,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { ScriptedPiAgent } from './duplex-scenario-harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

const OBSERVER_OUTPUT = [
  '<observations>',
  'Date: Apr 10, 2026',
  '',
  '* \u{1F7E1} (10:00) The work so far.',
  '</observations>',
].join('\n');

/** Enough history on a loop to put it over its compaction threshold. */
function seedHistory(pi: ScriptedPiAgent, chars = 30_000): void {
  pi.state.messages.push(
    { role: 'user', content: 'work '.repeat(Math.ceil(chars / 10)), timestamp: 1 } as AgentMessage,
    { role: 'assistant', content: 'done '.repeat(Math.ceil(chars / 10)), timestamp: 2 } as AgentMessage,
  );
}

/** A loop reachable for the compaction-manager seams these tests drive. */
interface DigestibleLoop {
  getCompactionManager: () => {
    setObservationalCompleteFn: (fn: CompleteFn) => void;
    updateCurrentContextTokenCount: (count: number) => void;
  };
  digestIdle: (options?: { observerTimeoutMs?: number }) => Promise<unknown>;
}

/** Drive one real observational pass on one loop. */
async function observeOn(loop: unknown, pi: ScriptedPiAgent): Promise<void> {
  const digestible = loop as DigestibleLoop;
  digestible.getCompactionManager().setObservationalCompleteFn(
    (async () => OBSERVER_OUTPUT) as unknown as CompleteFn,
  );
  // Two exchanges: the older one can leave; the latest stays verbatim.
  seedHistory(pi);
  seedHistory(pi);
  digestible.getCompactionManager().updateCurrentContextTokenCount(19_500);
  await digestible.digestIdle({ observerTimeoutMs: 5_000 });
}

describe('fan-out callback origin', () => {
  it('says which loop finished, on a callback that used to take no arguments', async () => {
    const h = createDuplexScenario();
    const completions: string[] = [];
    h.facade.onLoopComplete((origin) => completions.push(origin.loopPath));

    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'build the release' } }],
    }];
    h.reasonerPi.script = [{ text: 'Built.' }];
    await h.facade.prompt('build the release');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work dispatched');
    await waitUntil(() => completions.length >= 2, 2000, 'both loops completed');

    // The fan-out is intact: both loops report. What is new is that they are
    // now distinguishable, where before the handler took no arguments at all
    // and a consumer was told only that "a" loop had finished.
    expect(new Set(completions)).toEqual(new Set(['talker', 'reasoner']));
  });

  it('labels a retry ladder with the loop that is actually retrying', async () => {
    // A provider hiccup on the reasoner is ONE event. Fanned out unlabelled,
    // a consumer's retry UI cannot tell it from a second, simultaneous
    // failure on the talker, so it renders two countdowns.
    const h = createDuplexScenario({
      retryPolicy: { backoffMs: [1], maxBackoffMs: 1, maxAttempts: 3 },
    });
    const scheduled: Array<{ loopPath: string; attempt: number }> = [];
    const succeeded: string[] = [];
    h.facade.onRetryScheduled((info, origin) => {
      scheduled.push({ loopPath: origin.loopPath, attempt: info.attempt });
    });
    h.facade.onRetrySucceeded((_info, origin) => succeeded.push(origin.loopPath));

    h.reasonerPi.script = [
      { text: '', runErrorMessage: '500 internal server error' },
      { text: 'Recovered.' },
    ];
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'build the release' } }],
    }];
    await h.facade.prompt('build the release');
    await waitUntil(() => succeeded.length === 1, 3000, 'the ladder recovered');

    expect(scheduled).toEqual([{ loopPath: 'reasoner', attempt: 1 }]);
    expect(succeeded).toEqual(['reasoner']);
    // The talker never retried, so nothing may claim it did.
    expect(scheduled.map((entry) => entry.loopPath)).not.toContain('talker');
  });

  it('labels observations with the loop whose context was observed', async () => {
    // Both resident loops run observational compaction by default (D4), so a
    // long session produces observation events from both. Unlabelled, a
    // consumer surfacing "memory updated" shows it twice for two unrelated
    // compactions of two different transcripts.
    // Built through the REAL create(), because that is the path that
    // assembles each loop's compaction config from the consumer's; the
    // hand-built harness constructs loops with a fixed config and the
    // threshold below would never be crossed.
    const h = await createRealDuplexScenario({
      contextWindowLimit: 20_000,
      compaction: { observational: { activationThreshold: 0.35 } },
    });
    const observed: string[] = [];
    h.facade.onObservation((_event, origin) => observed.push(origin.loopPath));

    await observeOn(h.reasonerLoop, h.reasonerPi);
    await waitUntil(() => observed.length === 1, 3000, 'the reasoner observed');
    // Precondition for the assertion below: one loop has reported, and it is
    // the one that actually ran a pass.
    expect(observed).toEqual(['reasoner']);

    await observeOn(h.talkerLoop, h.talkerPi);
    await waitUntil(() => observed.length === 2, 3000, 'the talker observed');

    // Two events, two loops, each naming itself. Before, these were two
    // identical arrivals.
    expect(observed).toEqual(['reasoner', 'talker']);
  });

  it('labels memory failures with the loop whose memory call failed', async () => {
    // A failing talker memory model is a conversation about to degrade; the
    // consumer must be able to tell it from the reasoner's.
    const h = await createRealDuplexScenario({
      contextWindowLimit: 20_000,
      compaction: { observational: { maxAttempts: 1 } },
    });
    const failed: string[] = [];
    h.facade.onMemoryError((_info, origin) => failed.push(origin.loopPath));
    const talker = h.talkerLoop as DigestibleLoop;
    talker.getCompactionManager().setObservationalCompleteFn(
      (async () => { throw new Error('500 internal server error'); }) as unknown as CompleteFn,
    );
    seedHistory(h.talkerPi);

    await talker.digestIdle({ observerTimeoutMs: 5_000 });

    expect(failed).toEqual(['talker']);
  });

  it('keeps one-argument handlers working, which is what made the omission survivable', async () => {
    // Consumers wrote `(info) => ...` against the old signatures. Adding a
    // trailing argument must not break them, or every consumer breaks on
    // upgrade for a fix they did not ask for.
    const h = createDuplexScenario();
    const completions: number[] = [];
    const oneArg = (): void => { completions.push(1); };
    h.facade.onLoopComplete(oneArg);

    h.talkerPi.script = [{ text: 'Done.' }];
    await h.facade.prompt('hello');
    await waitUntil(() => completions.length >= 1, 2000, 'the handler still fires');
    expect(completions.length).toBeGreaterThan(0);
  });
});
