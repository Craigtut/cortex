/**
 * What reaches the assistant bubble under duplex.
 *
 * The merged event bridge forwards `response_start` and `response_chunk` from
 * BOTH resident loops and neither sets `childTaskId`, so the session's
 * existing child filter passes them all. Streaming every chunk into one
 * bubble shows the user the reasoner's private working prose, which is then
 * replaced when the talker's turn finalizes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function currentHome(): string {
  const g = globalThis as { __sessionDuplexHome?: string };
  if (!g.__sessionDuplexHome) {
    g.__sessionDuplexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duplex-home-'));
  }
  return g.__sessionDuplexHome;
}
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => currentHome() };
});

import type { TranscriptWriter } from '../src/persistence/transcript-writer.js';
import {
  createDuplexSession,
  destroyHarnessAgents,
  fireRetryScheduled,
  fireRetrySucceeded,
  retryScheduledInfo,
  seedObservedExchange,
  startHeldReasonerWork,
  waitUntil,
  settle,
} from './helpers/duplex-harness.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duplex-ws-'));
});

afterEach(async () => {
  await destroyHarnessAgents();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('duplex: only the talker speaks into the assistant bubble', () => {
  it('does not stream the reasoner\'s working prose', async () => {
    const { app, harness } = await createDuplexSession(cwd);

    harness.reasonerPi.streamChunks = ['Checking the migration ', 'and the schema...'];
    harness.reasonerPi.hold = true;
    harness.agent.deliver('Refactor the payments module', { target: 'work' });
    await waitUntil(() => harness.reasonerPi.running, 2000, 'reasoner run started');
    harness.reasonerPi.releaseRun();
    await waitUntil(() => !harness.reasonerPi.running, 2000, 'reasoner run finished');
    await settle();

    expect(app.assistantChunks.join('')).toBe('');
    expect(app.calls).not.toContain('transcript.startAssistantMessage');
  });

  it('streams the talker\'s speech', async () => {
    const { internals, app, harness } = await createDuplexSession(cwd);
    harness.talkerPi.streamChunks = ['On it', ', one moment.'];

    await internals.handleInput('how is it going?');
    await settle();

    expect(app.assistantChunks.join('')).toBe('On it, one moment.');
  });

  it('finalizes the bubble from the talker only', async () => {
    const { internals, app, harness } = await createDuplexSession(cwd);
    harness.talkerPi.defaultText = 'Still working on the payments module.';
    harness.reasonerPi.defaultText = 'Internal: the schema needs two more edits.';

    await startHeldReasonerWork(harness);
    await internals.handleInput('how is it going?');
    harness.reasonerPi.releaseRun();
    await waitUntil(() => !harness.reasonerPi.running, 2000, 'reasoner run finished');
    await settle();

    // The talker may speak more than once in an exchange (the reasoner's
    // result comes back as a delivery it voices). What must never happen is
    // the reasoner's internal text being finalized as an assistant reply.
    // This one already held before the streaming filter: the facade routes
    // onTurnComplete to the conversation loop alone. It is here so a
    // regression in that routing surfaces on the consumer side too.
    expect(app.finalized.length).toBeGreaterThan(0);
    expect(new Set(app.finalized)).toEqual(new Set(['Still working on the payments module.']));
  });
});

describe('duplex: the talker\'s control tools stay out of the transcript', () => {
  it('renders no tool row for a control-tool dispatch', async () => {
    const { internals, app, harness } = await createDuplexSession(cwd);
    harness.reasonerPi.hold = true;
    harness.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'Refactor the payments module.' } }],
    }];

    await internals.handleInput('refactor the payments module');
    await waitUntil(() => harness.reasonerPi.running, 2000, 'reasoner run started');
    await settle();

    expect(app.calls).not.toContain('transcript.startToolCall');
    expect(app.calls).not.toContain('transcript.completeToolCall');

    harness.reasonerPi.releaseRun();
  });

  it('still renders the reasoner\'s tool calls', async () => {
    const { app, harness } = await createDuplexSession(cwd);
    harness.reasonerPi.script = [{
      text: 'Reading it.',
      calls: [{ name: 'Glob', args: { pattern: '*.md' } }],
    }];

    harness.agent.deliver('Refactor the payments module', { target: 'work' });
    await waitUntil(
      () => app.calls.includes('transcript.startToolCall'),
      2000,
      'the reasoner tool row rendered',
    );
  });
});

describe('duplex: fan-out callbacks are keyed on the loop they came from', () => {
  it('keeps the reasoner\'s countdown alive when a talker retry resolves', async () => {
    const { app, harness } = await createDuplexSession(cwd);

    // The reasoner backs off, so its countdown owns the single status line.
    fireRetryScheduled(harness.reasonerLoop, retryScheduledInfo());
    await settle();
    expect(app.calls).toContain('transcript.setRetryStatus');

    // The talker's own retry then succeeds. That says nothing about the
    // reasoner's backoff, which is the one the user is waiting on.
    fireRetrySucceeded(harness.talkerLoop, { attempts: 1, totalDelayMs: 10 });
    await settle();

    expect(app.calls).not.toContain('transcript.clearRetryStatus');

    // Positive control: the owning loop's resolution does clear it, so the
    // assertion above is about the origin and not about clearing never firing.
    fireRetrySucceeded(harness.reasonerLoop, { attempts: 1, totalDelayMs: 10 });
    await settle();
    expect(app.calls).toContain('transcript.clearRetryStatus');
  });

  it("marks only the work loop's swaps in the transcript", async () => {
    const { session, harness } = await createDuplexSession(cwd);
    const writer = (session as unknown as { transcriptWriter: TranscriptWriter }).transcriptWriter;
    const addCompaction = vi.spyOn(writer, 'addCompaction');
    seedObservedExchange(harness.talkerLoop);
    seedObservedExchange(harness.reasonerLoop);

    expect((await harness.talkerLoop.compactNow({ observe: false })).status).toBe('compacted');
    await settle();
    expect(addCompaction).not.toHaveBeenCalled();

    // Positive control: the reasoner's swap is marked, so the absence above
    // is the origin filter rather than a marker path that never runs.
    expect((await harness.reasonerLoop.compactNow({ observe: false })).status).toBe('compacted');
    await settle();
    expect(addCompaction).toHaveBeenCalledOnce();
    expect(addCompaction.mock.calls[0]![0]).toMatchObject({ reason: 'compact-now' });
  });
});
