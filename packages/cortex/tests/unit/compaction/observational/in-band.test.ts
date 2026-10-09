/**
 * Observation while a caller waits: the background observer goes first and
 * is never repeated, each piece lands as it completes, a failure stops the
 * catch-up with what came before it kept, and an abort is not a failure.
 */
import { describe, it, expect, vi } from 'vitest';
import { BufferingCoordinator } from '../../../../src/compaction/observational/buffering.js';
import { MemoryHealth } from '../../../../src/compaction/observational/health.js';
import { InBandObserver } from '../../../../src/compaction/observational/in-band.js';
import { SINGLE_ATTEMPT } from '../../../../src/compaction/observational/calls.js';
import type { CompleteFn } from '../../../../src/compaction/observational/types.js';
import type { AgentMessage } from '../../../../src/context-manager.js';

const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: 0 });
const OBSERVED = '<observations>\n* (10:00) observed\n</observations>';
const CONFIG = { previousObserverTokens: 2_000, maxInputTokens: 1_000 };

function setup(complete: CompleteFn): { buffering: BufferingCoordinator; health: MemoryHealth; inBand: InBandObserver } {
  const buffering = new BufferingCoordinator();
  const health = new MemoryHealth();
  const inBand = new InBandObserver({
    buffering,
    health,
    completeFn: () => complete,
    logText: () => '',
    observerConfig: () => CONFIG,
    policy: () => SINGLE_ATTEMPT,
    logger: () => null,
  });
  return { buffering, health, inBand };
}

describe('InBandObserver.catchUp', () => {
  it('waits for the background observer and observes only what it did not cover', async () => {
    let release: (reply: string) => void = () => {};
    const complete = vi.fn<CompleteFn>()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue(OBSERVED);
    const { buffering, inBand } = setup(complete);
    const history = [userMsg('alpha'), userMsg('bravo'), userMsg('charlie')];
    buffering.launchObserver(complete, history.slice(0, 2), 2, null, CONFIG);

    const caughtUp = inBand.catchUp(history, 3, 'compact-now', new AbortController().signal);
    release(OBSERVED);
    const result = await caughtUp;

    expect(result).toEqual({ observed: true, error: null });
    expect(complete).toHaveBeenCalledTimes(2);
    const second = JSON.stringify(complete.mock.calls[1]![0].messages);
    expect(second).toContain('charlie');
    expect(second).not.toContain('bravo');
    expect(buffering.getWatermark()).toBe(3);
  });

  it('stops at a failed piece and keeps the pieces before it', async () => {
    const complete = vi.fn<CompleteFn>()
      .mockResolvedValueOnce(OBSERVED)
      .mockRejectedValue(new Error('500 internal server error'));
    const { buffering, health, inBand } = setup(complete);
    // Two pieces: each message fills the input cap.
    const history = [userMsg('a'.repeat(3_000)), userMsg('b'.repeat(3_000))];

    const result = await inBand.catchUp(history, 2, 'compact-now', new AbortController().signal);

    expect(result.observed).toBe(true);
    expect(result.error?.message).toContain('500');
    expect(buffering.getWatermark()).toBe(1);
    expect(health.isDegraded).toBe(true);
  });

  it('reports an abort as the reason it stopped, not as a memory failure', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    const { buffering, health, inBand } = setup(complete);
    const controller = new AbortController();
    controller.abort(new Error('the user stopped it'));

    const result = await inBand.catchUp([userMsg('a')], 1, 'compact-now', controller.signal);

    expect(result).toEqual({ observed: false, error: new Error('the user stopped it') });
    expect(complete).not.toHaveBeenCalled();
    expect(buffering.getWatermark()).toBe(0);
    expect(health.isDegraded).toBe(false);
  });
});
