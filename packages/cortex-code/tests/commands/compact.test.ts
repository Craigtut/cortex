/**
 * /compact and /model's "compact first" go through compactNow, which keeps
 * the recent messages and changes nothing when it fails, and the notice says
 * what each loop did.
 */
import { describe, it, expect, vi } from 'vitest';
import type { CompactNowResult, CortexCompactNowResult } from '@animus-labs/cortex';
import { compactContext, describeCompaction } from '../../src/commands/compact.js';
import { applySwitchWarningChoice } from '../../src/commands/model.js';
import { createFakeApp } from '../helpers/fake-app.js';

const compacted: CompactNowResult = {
  status: 'compacted',
  removedMessages: 12,
  tokensBefore: 48_200,
  tokensAfter: 9_100,
  reflection: { status: 'not-due' },
};

function fakeSession(result: CortexCompactNowResult) {
  const app = createFakeApp();
  const agent = {
    compactNow: vi.fn(async () => result),
  };
  const session = {
    getAgent: () => agent as never,
    getApp: () => app as never,
    getProvider: () => 'anthropic',
    switchModel: vi.fn(async () => {}),
    switchProvider: vi.fn(async () => {}),
  };
  return { app, agent, session };
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
