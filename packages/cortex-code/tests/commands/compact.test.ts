/**
 * /compact and /model's "compact first" go through compactNow, which keeps
 * the recent messages and changes nothing when it fails, and the notice says
 * what each loop did.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CompactNowResult, CortexCompactNowResult } from '@animus-labs/cortex';
import { compactContext, describeCompaction } from '../../src/commands/compact.js';
import { applySwitchWarningChoice } from '../../src/commands/model.js';
import { CancellableCommands } from '../../src/session/cancellable-commands.js';
import { createFakeApp } from '../helpers/fake-app.js';

const compacted: CompactNowResult = {
  status: 'compacted',
  removedMessages: 12,
  tokensBefore: 48_200,
  tokensAfter: 9_100,
  reflection: { status: 'not-due' },
};

function fakeSession(
  result: CortexCompactNowResult,
  compactNow: (options?: { signal?: AbortSignal }) => Promise<CortexCompactNowResult> = async () => result,
) {
  const app = createFakeApp();
  const agent = { compactNow: vi.fn(compactNow) };
  const commands = new CancellableCommands();
  const session = {
    getAgent: () => agent as never,
    getApp: () => app as never,
    getProvider: () => 'anthropic',
    runCancellable: <T>(work: (signal: AbortSignal) => Promise<T>) => commands.run(work),
    switchModel: vi.fn(async () => {}),
    switchProvider: vi.fn(async () => {}),
  };
  return { app, agent, session, commands };
}

/** A compactNow that holds until its signal aborts, then reports it stopped. */
function heldUntilCancelled(talker?: CompactNowResult) {
  return (options?: { signal?: AbortSignal }) => new Promise<CortexCompactNowResult>((resolve) => {
    options?.signal?.addEventListener('abort', () => {
      const reasoner: CompactNowResult = { status: 'failed', error: options.signal!.reason as Error };
      resolve(talker ? { reasoner, talker } : { reasoner });
    }, { once: true });
  });
}

describe('describeCompaction', () => {
  it('says what moved and the new size', () => {
    expect(describeCompaction({ reasoner: compacted })).toEqual({
      title: 'Compaction',
      body: 'Moved 12 messages into memory, 48.2k to 9.1k tokens.',
      failed: false,
    });
  });

  it('reports both loops in duplex', () => {
    const report = describeCompaction({ reasoner: compacted, talker: { status: 'nothing-to-compact' } });
    expect(report.body).toBe(
      'Work: Moved 12 messages into memory, 48.2k to 9.1k tokens.\n'
      + 'Conversation: Nothing to compact: the recent messages already fit.',
    );
  });

  it('says nothing changed when it failed', () => {
    const report = describeCompaction({ reasoner: { status: 'failed', error: new Error('529 overloaded') } });
    expect(report).toEqual({ title: 'Compaction Failed', body: 'Nothing changed: 529 overloaded', failed: true });
  });

  it('says the swap stands when condensing memory failed', () => {
    const report = describeCompaction({
      reasoner: { ...compacted, reflection: { status: 'failed', error: new Error('timeout') } },
    });
    expect(report.body).toContain('Condensing memory failed (timeout)');
  });
});

describe('/compact', () => {
  it('compacts through compactNow and shows the result', async () => {
    const { app, agent, session } = fakeSession({ reasoner: compacted });

    await compactContext(session);

    expect(agent.compactNow).toHaveBeenCalledOnce();
    expect(app.spinnerVisible).toBe(false);
    expect(app.transcript['addNotification']).toHaveBeenCalledWith(
      'Compaction',
      'Moved 12 messages into memory, 48.2k to 9.1k tokens.',
      undefined,
    );
  });
});

describe('/compact cancelled with Esc', () => {
  it('stops compactNow through its signal and says nothing changed', async () => {
    const { app, agent, session, commands } = fakeSession({ reasoner: compacted }, heldUntilCancelled());

    const running = compactContext(session);
    await vi.waitFor(() => expect(agent.compactNow).toHaveBeenCalledOnce());
    expect(commands.cancel(new Error('cancelled'))).toBe(true);
    await running;

    expect(agent.compactNow.mock.calls[0]![0]!.signal!.aborted).toBe(true);
    expect(app.spinnerVisible).toBe(false);
    expect(app.transcript['addNotification']).toHaveBeenCalledWith('Compaction Cancelled', 'Nothing changed: cancelled', undefined);
  });

  it('reports what the conversation loop did before the cancel', async () => {
    const { app, agent, session, commands } = fakeSession({ reasoner: compacted }, heldUntilCancelled(compacted));

    const running = compactContext(session);
    await vi.waitFor(() => expect(agent.compactNow).toHaveBeenCalledOnce());
    commands.cancel(new Error('cancelled'));
    await running;

    expect(app.transcript['addNotification']).toHaveBeenCalledWith(
      'Compaction Cancelled',
      'Work: Nothing changed: cancelled\nConversation: Moved 12 messages into memory, 48.2k to 9.1k tokens.',
      undefined,
    );
  });

  it('reports a compaction the cancel came too late to stop', async () => {
    const { app, session, commands } = fakeSession({ reasoner: compacted }, async (options) => {
      // Done, then the cancel lands before the command reads the result.
      commands.cancel(new Error('cancelled'));
      expect(options?.signal?.aborted).toBe(true);
      return { reasoner: compacted };
    });

    await compactContext(session);

    expect(app.transcript['addNotification']).toHaveBeenCalledWith(
      'Compaction', 'Moved 12 messages into memory, 48.2k to 9.1k tokens.', undefined,
    );
  });

  it('cancels nothing once it has finished', async () => {
    const { session, commands } = fakeSession({ reasoner: compacted });

    await compactContext(session);

    expect(commands.cancel(new Error('cancelled'))).toBe(false);
  });
});

describe("/model's compact first", () => {
  it('compacts through compactNow, then switches', async () => {
    const { agent, session } = fakeSession({ reasoner: compacted });

    await applySwitchWarningChoice(session, 'compact-first', 'anthropic', 'claude-haiku-4-5');

    expect(agent.compactNow).toHaveBeenCalledOnce();
    expect(session.switchModel).toHaveBeenCalledWith('claude-haiku-4-5');
  });

  it('still switches when compaction failed', async () => {
    const { session } = fakeSession({ reasoner: { status: 'failed', error: new Error('529 overloaded') } });

    await applySwitchWarningChoice(session, 'compact-first', 'anthropic', 'claude-haiku-4-5');

    expect(session.switchModel).toHaveBeenCalledWith('claude-haiku-4-5');
  });
});
