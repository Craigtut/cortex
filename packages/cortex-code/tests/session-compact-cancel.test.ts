/**
 * Esc during /compact: the session's abort reaches the compaction through
 * its signal, the memory call it was waiting on is abandoned, and nothing
 * changes.
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
import { registerBuiltinCommands } from '../src/commands/index.js';
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

describe('Esc during /compact', () => {
  it('cancels the compaction and changes nothing', async () => {
    registerBuiltinCommands();
    const { session, internals, app, agent, reasonerPi } = await createPassthroughSession(cwd);
    // The memory model never answers: only a cancel ends the compaction.
    const complete = vi.fn<CompleteFn>(() => new Promise<string>(() => {}));
    agent.getCompactionManager().memory.setCompleteFn(complete);
    agent.getCompactionManager().setContextWindow(20_000);
    const history = reasonerPi.state.messages as Array<{ role: string; content: string; timestamp: number }>;
    history.push({ role: 'user', content: 'a'.repeat(20_000), timestamp: 1 });
    history.push({ role: 'assistant', content: 'b'.repeat(20_000), timestamp: 2 });
    history.push({ role: 'user', content: 'the latest question', timestamp: 3 });
    const before = agent.getConversationHistory();

    const running = internals.handleInput('/compact');
    await vi.waitFor(() => expect(complete).toHaveBeenCalled());
    await session.abort();
    await running;

    expect(app.transcript['addNotification']).toHaveBeenCalledWith('Compaction Cancelled', 'Nothing changed: cancelled', undefined);
    expect(agent.getConversationHistory()).toEqual(before);
    expect(agent.getObservationalMemoryState().observations).toBe('');
  });
});
