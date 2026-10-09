/**
 * What survives a crash.
 *
 * Persistence is driven by the facade's `onStateChanged`, which only fires
 * from a `getState()` taken at gate quiescence. A session doing a long task
 * holds the loop gate for the whole task and never reaches one, so a
 * settlement-only design writes nothing at all until the work is over: a
 * brand-new session killed during its first task left no `meta.json`, which
 * means `listSessions()` cannot see it and `/resume` cannot find it. Not
 * stale, invisible.
 *
 * These tests hold a run open past both debounce windows and assert on the
 * bytes on disk, which is the thing a crash actually leaves behind.
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

import type { CortexAgentStateV2 } from '@animus-labs/cortex';
import {
  createDuplexSession,
  createPassthroughSession,
  destroyHarnessAgents,
  waitUntil,
  settle,
} from './helpers/duplex-harness.js';
import { listSessions } from '../src/persistence/sessions.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-duplex-ws-'));
});

afterEach(async () => {
  await destroyHarnessAgents();
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

function sessionDir(sessionId: string): string {
  return path.join(currentHome(), '.cortex', 'sessions', sessionId);
}

function readState(sessionId: string): CortexAgentStateV2 {
  return JSON.parse(
    fs.readFileSync(path.join(sessionDir(sessionId), 'state.json'), 'utf-8'),
  ) as CortexAgentStateV2;
}

describe('a session is on disk before it does any work', () => {
  it('writes meta.json and state.json at startup, so a crashed first task is still listable', async () => {
    const { internals } = await createPassthroughSession(cwd);
    const dir = sessionDir(internals.sessionId);

    expect(fs.existsSync(path.join(dir, 'meta.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(true);

    // The user-facing consequence of a missing meta.json: the session never
    // appears in /resume.
    const listed = await listSessions();
    expect(listed.map((s) => s.id)).toContain(internals.sessionId);
  });
});

describe('checkpointing during a long task', () => {
  it('reaches disk at a turn boundary, before the task settles', async () => {
    const { internals, reasonerPi } = await createPassthroughSession(cwd);
    const sessionId = internals.sessionId;
    const save = vi.spyOn(internals.checkpoints.saver, 'save');

    // A task that keeps going: it pauses after its first turn boundary and
    // stays there, which is where a ten-minute run spends its time.
    reasonerPi.holdAfterTurn = true;
    reasonerPi.script = [
      { text: 'Renaming the payments module.' },
      { text: 'Done.' },
    ];
    const turn = internals.handleInput('rename the payments module');
    await waitUntil(() => save.mock.calls.length > 0, 3000, 'a checkpoint was taken mid-run');
    await internals.checkpoints.saver.flush();

    // Still working: settlement has not happened and cannot have.
    expect(reasonerPi.running).toBe(true);
    expect(internals.work.isRunning).toBe(true);

    const state = readState(sessionId);
    expect(JSON.stringify(state.reasonerHistory)).toContain('rename the payments module');
    expect(JSON.stringify(state.reasonerHistory)).toContain('Renaming the payments module.');

    reasonerPi.holdAfterTurn = false;
    reasonerPi.releaseRun();
    await turn;
  });

  it('keeps observational memory while a generation is in flight', async () => {
    const { internals, agent, reasonerPi } = await createPassthroughSession(cwd);
    const sessionId = internals.sessionId;
    const cm = agent.getCompactionManager();
    // History and memory are read in one synchronous frame, so a generation
    // in flight cannot land between them: dropping memory bought nothing
    // and lost every observation on crash recovery.
    vi.spyOn(cm, 'isObserverInFlight').mockReturnValue(true);

    const save = vi.spyOn(internals.checkpoints.saver, 'save');
    reasonerPi.holdAfterTurn = true;
    const turn = internals.handleInput('rename the payments module');
    await waitUntil(() => save.mock.calls.length > 0, 3000, 'a checkpoint was taken mid-run');
    await internals.checkpoints.saver.flush();

    const state = readState(sessionId);
    expect(state.reasonerMemory).not.toBeNull();
    expect(state.reasonerMemory!.bufferWatermark).toBeLessThanOrEqual(state.reasonerHistory.length);

    reasonerPi.holdAfterTurn = false;
    reasonerPi.releaseRun();
    await turn;
  });

  it('takes no mid-run checkpoint under duplex, where it could not be consistent', async () => {
    const { internals, harness } = await createDuplexSession(cwd);
    const save = vi.spyOn(internals.checkpoints.saver, 'save');

    harness.reasonerPi.holdAfterTurn = true;
    harness.agent.deliver('Refactor the payments module', { target: 'work' });
    await waitUntil(() => harness.reasonerPi.running, 2000, 'reasoner run started');
    await settle(12);

    // The other loop can be mid-turn at a reasoner turn boundary and its
    // history is unreachable while getState() is blocked, so a checkpoint
    // here would be exactly the partial the composite artifact exists to
    // avoid. Better to write nothing than to write half a session.
    expect(save).not.toHaveBeenCalled();

    harness.reasonerPi.holdAfterTurn = false;
    harness.reasonerPi.releaseRun();
  });
});

describe('a resumed session keeps its artifact', () => {
  it('does not overwrite the saved session before resume() reads it', async () => {
    const first = await createPassthroughSession(cwd);
    const sessionId = first.internals.sessionId;
    first.reasonerPi.defaultText = 'Renamed it.';
    const save = vi.spyOn(first.internals.checkpoints.saver, 'save');
    await first.internals.handleInput('rename the payments module');
    await waitUntil(() => save.mock.calls.length > 0, 3000, 'the session persisted');
    await first.internals.checkpoints.saver.flush();

    // start() checkpoints before index.ts calls resume(), so an
    // unconditional write there would blank the session being resumed.
    const second = await createPassthroughSession(cwd, { resumeSessionId: sessionId });
    expect(second.internals.sessionId).toBe(sessionId);
    await second.session.resume(sessionId);

    expect(JSON.stringify(second.agent.getConversationHistory()))
      .toContain('rename the payments module');
    expect(JSON.stringify(readState(sessionId).reasonerHistory))
      .toContain('rename the payments module');
  });
});
