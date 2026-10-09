/**
 * Memory health in the transcript: one notice when the memory model starts
 * failing, none for the failures that follow, and one when it recovers.
 * A notice per failed call would bury the conversation during an outage.
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

import type { CompleteFn } from '@animus-labs/cortex';
import type { TranscriptWriter } from '../src/persistence/transcript-writer.js';
import { createPassthroughSession, destroyHarnessAgents } from './helpers/duplex-harness.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duplex-ws-'));
});

afterEach(async () => {
  await destroyHarnessAgents();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

const OBSERVED = '<observations>\n* (10:00) observed\n</observations>';

function memoryNotices(addNotification: ReturnType<typeof vi.fn>): string[] {
  return addNotification.mock.calls
    .map(([title]) => String(title))
    .filter((title) => title.startsWith('Memory'));
}

describe('memory notices', () => {
  it('render once per degraded episode, and once on recovery', async () => {
    const { app, agent, reasonerPi } = await createPassthroughSession(cwd);
    const manager = agent.getCompactionManager();
    // Not retried, so each call fails at once.
    const failing = vi.fn<CompleteFn>().mockRejectedValue(new Error('401 Unauthorized'));
    manager.setObservationalCompleteFn(failing);
    const history = reasonerPi.state.messages as Array<{ role: string; content: string; timestamp: number }>;
    history.push({ role: 'user', content: 'rename the payments module', timestamp: 1 });
    history.push({ role: 'assistant', content: 'Renamed.', timestamp: 2 });

    expect((await agent.observeNow()).status).toBe('failed');
    expect((await agent.observeNow()).status).toBe('failed');
    // Precondition: two failed memory calls, one episode.
    expect(failing).toHaveBeenCalledTimes(2);
    expect(memoryNotices(app.transcript['addNotification']!)).toEqual(['Memory model failing']);
    // It promises only what holds: an overflow can still drop unrecorded messages.
    const failingNotice = app.transcript['addNotification']!.mock.calls.find(([title]) => title === 'Memory model failing')!;
    expect(String(failingNotice[1])).toContain('Memory gap');

    manager.setObservationalCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    expect((await agent.observeNow()).status).toBe('observed');

    expect(memoryNotices(app.transcript['addNotification']!)).toEqual([
      'Memory model failing',
      'Memory model recovered',
    ]);
  });
});

describe('the durable marker for an overflow drop', () => {
  it('records the context size before and after the drop', async () => {
    const { session, agent } = await createPassthroughSession(cwd);
    const writer = (session as unknown as { transcriptWriter: TranscriptWriter }).transcriptWriter;
    const addCompaction = vi.spyOn(writer, 'addCompaction');
    const manager = agent.getCompactionManager();
    const capacity = manager.modelContextWindow || manager.contextWindow;
    // Twice the window, in twenty messages; the first four are observed.
    const size = Math.ceil((capacity * 2 * 4) / 20);
    const history = Array.from({ length: 20 }, (_, i) =>
      ({ role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(size), timestamp: i + 1 }));
    manager.restoreObservationalMemoryState({
      observations: '', continuationHint: null, observationTokenCount: 0, generationCount: 0,
      bufferedChunks: [{ observations: '* (10:00) the first exchanges', messageTokensObserved: 1_000, createdAt: new Date(), endIndex: 4 }],
      bufferWatermark: 4,
    });

    manager.handleOverflowError(() => history as never, () => {});

    // Precondition: the observed messages left as a swap, so a marker is written.
    expect(addCompaction).toHaveBeenCalledOnce();
    const marker = addCompaction.mock.calls[0]![0]!;
    expect(marker.reason).toBe('emergency');
    expect(marker.beforeTokens).toBeGreaterThan(capacity);
    expect(marker.afterTokens).toBeGreaterThan(0);
    expect(marker.afterTokens).toBeLessThan(capacity);
  });
});
