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

    manager.setObservationalCompleteFn(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    expect((await agent.observeNow()).status).toBe('observed');

    expect(memoryNotices(app.transcript['addNotification']!)).toEqual([
      'Memory model failing',
      'Memory model recovered',
    ]);
  });
});
