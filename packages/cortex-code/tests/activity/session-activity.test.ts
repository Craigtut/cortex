import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildActivityDisplaySummary,
  buildActivityPermissionArgs,
  FileSessionActivityReporter,
  normalizeActivityErrorCategory,
  watchDecisionFile,
  type ActivityEvent,
  type SessionActivityState,
} from '../../src/activity/session-activity.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const tempRoots: string[] = [];

async function tempSessionsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cortex-activity-'));
  tempRoots.push(dir);
  return dir;
}

async function readState(sessionsDir: string, sessionId: string): Promise<SessionActivityState> {
  const raw = await readFile(join(sessionsDir, sessionId, 'activity', 'state.json'), 'utf-8');
  return JSON.parse(raw) as SessionActivityState;
}

async function readEvents(sessionsDir: string, sessionId: string): Promise<ActivityEvent[]> {
  const raw = await readFile(join(sessionsDir, sessionId, 'activity', 'events.jsonl'), 'utf-8');
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ActivityEvent);
}

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('buildActivityDisplaySummary', () => {
  it('builds human-readable summaries without exposing full tool args', () => {
    expect(buildActivityDisplaySummary('Bash', { command: 'npm test -- --runInBand' }))
      .toBe('Run shell: npm test -- --runInBand');
    expect(buildActivityDisplaySummary('Edit', { file_path: 'src/main.ts', old_string: 'a', new_string: 'b' }))
      .toBe('Edit src/main.ts');
    expect(buildActivityDisplaySummary('mcp__server__tool', { value: 1 }))
      .toBe('Run mcp__server__tool');
  });
});

describe('buildActivityPermissionArgs', () => {
  it('summarizes large Write and Edit content instead of preserving full strings', () => {
    const longOld = 'old\n'.repeat(2_000);
    const longNew = 'new\n'.repeat(2_000);
    const editArgs = buildActivityPermissionArgs('Edit', {
      file_path: 'src/main.ts',
      old_string: longOld,
      new_string: longNew,
      replace_all: true,
    });

    expect(editArgs).toMatchObject({
      file_path: 'src/main.ts',
      replace_all: true,
      old_string: {
        bytes: Buffer.byteLength(longOld, 'utf8'),
        lines: 2_001,
        truncated: true,
      },
      new_string: {
        bytes: Buffer.byteLength(longNew, 'utf8'),
        lines: 2_001,
        truncated: true,
      },
    });
    expect(JSON.stringify(editArgs)).not.toContain(longOld.slice(0, 500));

    const writeArgs = buildActivityPermissionArgs('Write', {
      file_path: 'README.md',
      content: longNew,
    });
    expect(writeArgs).toMatchObject({
      file_path: 'README.md',
      content: {
        bytes: Buffer.byteLength(longNew, 'utf8'),
        lines: 2_001,
        truncated: true,
      },
    });
    expect(JSON.stringify(writeArgs)).not.toContain(longNew.slice(0, 500));
  });

  it('preserves useful small args for shell permission prompts', () => {
    expect(buildActivityPermissionArgs('Bash', { command: 'rm -rf foo/' }))
      .toEqual({ command: 'rm -rf foo/' });
  });
});

describe('normalizeActivityErrorCategory', () => {
  it('maps Cortex-only categories to the activity contract', () => {
    expect(normalizeActivityErrorCategory('server_error')).toBe('other');
    expect(normalizeActivityErrorCategory('unknown')).toBe('other');
    expect(normalizeActivityErrorCategory('rate_limit')).toBe('rate_limit');
  });

  it('reports a billing error as billing, not other', () => {
    expect(normalizeActivityErrorCategory('billing')).toBe('billing');
  });
});

describe('FileSessionActivityReporter', () => {
  it('writes initial current state and event stream', async () => {
    const sessionsDir = await tempSessionsDir();
    const reporter = new FileSessionActivityReporter('session-a', '/repo', { sessionsDir });

    await reporter.initialize();
    await reporter.recordAwaitingInput();
    await reporter.flush();

    const state = await readState(sessionsDir, 'session-a');
    expect(state).toMatchObject({
      version: 1,
      sessionId: 'session-a',
      status: 'awaiting_input',
      cwd: '/repo',
      awaitingPermission: null,
      finalExit: null,
    });
    expect(state.sequence).toBe(2);

    const events = await readEvents(sessionsDir, 'session-a');
    expect(events.map((event) => event.type)).toEqual(['status_changed', 'status_changed']);
    expect(events[0]?.payload).toMatchObject({ from: null, to: 'working' });
    expect(events[1]?.payload).toMatchObject({ from: 'working', to: 'awaiting_input' });
  });

  it('records permission request and resolution with display summary and small args', async () => {
    const sessionsDir = await tempSessionsDir();
    const reporter = new FileSessionActivityReporter('session-perm', '/repo', { sessionsDir });
    await reporter.initialize();

    const permission = reporter.recordPermissionRequested('Bash', { command: 'rm -rf foo/' });
    await permission.written;

    const pendingState = await readState(sessionsDir, 'session-perm');
    expect(pendingState.status).toBe('awaiting_permission');
    expect(pendingState.awaitingPermission).toMatchObject({
      id: permission.id,
      toolName: 'Bash',
      displaySummary: 'Run shell: rm -rf foo/',
      args: { command: 'rm -rf foo/' },
    });

    await reporter.recordPermissionResolved(permission.id, 'Bash', 'denied');
    await reporter.flush();

    const resolvedState = await readState(sessionsDir, 'session-perm');
    expect(resolvedState.status).toBe('working');
    expect(resolvedState.awaitingPermission).toBeNull();

    const events = await readEvents(sessionsDir, 'session-perm');
    expect(events.map((event) => event.type)).toEqual([
      'status_changed',
      'status_changed',
      'permission_requested',
      'status_changed',
      'permission_resolved',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      id: permission.id,
      toolName: 'Bash',
      resolution: 'denied',
    });
  });

  it('writes sanitized file-edit permission args to state and events', async () => {
    const sessionsDir = await tempSessionsDir();
    const reporter = new FileSessionActivityReporter('session-edit-perm', '/repo', { sessionsDir });
    const longOld = 'old\n'.repeat(2_000);
    const longNew = 'new\n'.repeat(2_000);
    await reporter.initialize();

    const permission = reporter.recordPermissionRequested('Edit', {
      file_path: 'src/main.ts',
      old_string: longOld,
      new_string: longNew,
    });
    await permission.written;

    const state = await readState(sessionsDir, 'session-edit-perm');
    expect(state.awaitingPermission?.args).toMatchObject({
      file_path: 'src/main.ts',
      old_string: {
        bytes: Buffer.byteLength(longOld, 'utf8'),
        truncated: true,
      },
      new_string: {
        bytes: Buffer.byteLength(longNew, 'utf8'),
        truncated: true,
      },
    });
    expect(JSON.stringify(state)).not.toContain(longOld.slice(0, 500));

    const events = await readEvents(sessionsDir, 'session-edit-perm');
    const permissionEvent = events.find((event) => event.type === 'permission_requested');
    expect(permissionEvent?.payload).toMatchObject({
      id: permission.id,
      toolName: 'Edit',
      args: {
        file_path: 'src/main.ts',
        old_string: {
          bytes: Buffer.byteLength(longOld, 'utf8'),
          truncated: true,
        },
      },
    });
    expect(JSON.stringify(permissionEvent)).not.toContain(longNew.slice(0, 500));
  });

  it('tracks tool and turn duration fields', async () => {
    const sessionsDir = await tempSessionsDir();
    let currentTime = new Date('2026-05-28T12:00:00.000Z').getTime();
    const reporter = new FileSessionActivityReporter('session-tool', '/repo', {
      sessionsDir,
      now: () => new Date(currentTime),
    });

    await reporter.initialize();
    reporter.recordTurnStarted();
    currentTime += 250;
    reporter.recordToolStarted({
      toolCallId: 'tc-1',
      toolName: 'Edit',
      args: { file_path: 'src/main.ts', old_string: 'old', new_string: 'new' },
    });
    currentTime += 1250;
    reporter.recordToolEnded({ toolCallId: 'tc-1', toolName: 'Edit' });
    currentTime += 500;
    reporter.recordTurnEnded();
    await reporter.flush();

    const state = await readState(sessionsDir, 'session-tool');
    expect(state.activeTools).toEqual([]);
    expect(state.turn).toMatchObject({
      id: 'turn-1',
      status: 'completed',
      endedAt: '2026-05-28T12:00:02.000Z',
    });

    const events = await readEvents(sessionsDir, 'session-tool');
    const toolStart = events.find((event) => event.type === 'tool_call_started');
    const toolEnd = events.find((event) => event.type === 'tool_call_ended');
    const turnEnd = events.find((event) => event.type === 'turn_ended');
    expect(toolStart?.payload).toMatchObject({
      toolCallId: 'tc-1',
      toolName: 'Edit',
      displaySummary: 'Edit src/main.ts',
    });
    expect(toolEnd?.payload).toMatchObject({ durationMs: 1250, isError: false });
    expect(turnEnd?.payload).toMatchObject({ turnId: 'turn-1', durationMs: 2000 });
  });

  it('records terminal done and error details', async () => {
    const sessionsDir = await tempSessionsDir();
    const reporter = new FileSessionActivityReporter('session-exit', '/repo', { sessionsDir });

    await reporter.initialize();
    await reporter.recordError({
      category: 'authentication',
      severity: 'fatal',
      originalMessage: 'Invalid API key',
    }, true);
    let state = await readState(sessionsDir, 'session-exit');
    expect(state.status).toBe('error');
    expect(state.lastError).toMatchObject({
      category: 'authentication',
      message: 'Invalid API key',
    });

    await reporter.recordDone({ code: 0, signal: null, reason: 'normal_shutdown' });
    state = await readState(sessionsDir, 'session-exit');
    expect(state.status).toBe('done');
    expect(state.finalExit).toEqual({ code: 0, signal: null, reason: 'normal_shutdown' });
  });

  it('does not let idle cleanup overwrite a terminal error state', async () => {
    const sessionsDir = await tempSessionsDir();
    const reporter = new FileSessionActivityReporter('session-fatal', '/repo', { sessionsDir });

    await reporter.initialize();
    await reporter.recordError(new Error('startup failed'), true);
    await reporter.recordAwaitingInput();
    await reporter.flush();

    const state = await readState(sessionsDir, 'session-fatal');
    expect(state.status).toBe('error');
    expect(state.lastError).toMatchObject({
      category: 'other',
      message: 'startup failed',
    });
  });

  it('rotates events.jsonl at the configured size cap', async () => {
    const sessionsDir = await tempSessionsDir();
    const reporter = new FileSessionActivityReporter('session-rotate', '/repo', {
      sessionsDir,
      maxEventLogBytes: 450,
      maxRotatedEventLogs: 2,
    });

    await reporter.initialize();
    for (let index = 0; index < 12; index++) {
      reporter.recordToolStarted({
        toolCallId: `tc-${index}`,
        toolName: 'Bash',
        args: { command: `echo ${index}` },
      });
      reporter.recordToolEnded({ toolCallId: `tc-${index}`, toolName: 'Bash' });
    }
    await reporter.flush();

    const activityDir = join(sessionsDir, 'session-rotate', 'activity');
    const files = await readdir(activityDir);
    expect(files).toContain('events.jsonl');
    expect(files).toContain('events.1.jsonl');
    expect(files).toContain('events.2.jsonl');

    const current = await stat(join(activityDir, 'events.jsonl'));
    expect(current.size).toBeGreaterThan(0);
  });
});

describe('decisionPath', () => {
  it('points at a control/ sibling of activity/, keyed by permission id', async () => {
    const sessionsDir = await tempSessionsDir();
    const reporter = new FileSessionActivityReporter('session-ctrl', '/repo', { sessionsDir });

    expect(reporter.decisionPath('perm-abc')).toBe(
      join(sessionsDir, 'session-ctrl', 'control', 'perm-abc.json'),
    );
  });
});

describe('watchDecisionFile', () => {
  it('resolves with the decision and consumes the file', async () => {
    const dir = await tempSessionsDir();
    const file = join(dir, 'perm-1.json');
    await writeFile(file, JSON.stringify({ decision: 'allow' }));

    const controller = new AbortController();
    expect(await watchDecisionFile(file, controller.signal, 10)).toBe('allow');
    expect(await fileExists(file)).toBe(false);
    controller.abort();
  });

  it('resolves with deny', async () => {
    const dir = await tempSessionsDir();
    const file = join(dir, 'perm-2.json');
    await writeFile(file, JSON.stringify({ decision: 'deny' }));

    const controller = new AbortController();
    expect(await watchDecisionFile(file, controller.signal, 10)).toBe('deny');
    controller.abort();
  });

  it('leaves a partially written (unparseable) file in place and retries', async () => {
    const dir = await tempSessionsDir();
    const file = join(dir, 'perm-3.json');
    // Simulate a non-atomic writer mid-write: valid-prefix, invalid JSON.
    await writeFile(file, '{"decision":');

    const controller = new AbortController();
    const decision = watchDecisionFile(file, controller.signal, 10);

    await delay(60);
    // Must not have been consumed/dropped while the write was incomplete.
    expect(await fileExists(file)).toBe(true);

    // Writer finishes.
    await writeFile(file, JSON.stringify({ decision: 'deny' }));
    expect(await decision).toBe('deny');
    expect(await fileExists(file)).toBe(false);
    controller.abort();
  });

  it('discards a complete-but-malformed decision and keeps waiting', async () => {
    const dir = await tempSessionsDir();
    const file = join(dir, 'perm-4.json');
    await writeFile(file, JSON.stringify({ decision: 'maybe' }));

    const controller = new AbortController();
    const decision = watchDecisionFile(file, controller.signal, 10);

    await delay(60);
    // A complete write is consumed even when the shape is wrong, so it can't
    // wedge the poller on the same bad file forever.
    expect(await fileExists(file)).toBe(false);
    const settled = await Promise.race([
      decision.then(() => 'resolved' as const),
      delay(20).then(() => 'pending' as const),
    ]);
    expect(settled).toBe('pending');

    await writeFile(file, JSON.stringify({ decision: 'allow' }));
    expect(await decision).toBe('allow');
    controller.abort();
  });

  it('stops and cleans up a late answer when aborted before resolving', async () => {
    const dir = await tempSessionsDir();
    const file = join(dir, 'perm-5.json');
    await writeFile(file, JSON.stringify({ decision: 'allow' }));

    const controller = new AbortController();
    controller.abort();
    const decision = watchDecisionFile(file, controller.signal, 10);

    const settled = await Promise.race([
      decision.then(() => 'resolved' as const),
      delay(40).then(() => 'pending' as const),
    ]);
    expect(settled).toBe('pending');
    // The late file is swept so it can't outlive the prompt.
    expect(await fileExists(file)).toBe(false);
  });
});
