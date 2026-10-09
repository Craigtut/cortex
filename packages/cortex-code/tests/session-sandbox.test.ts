import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SandboxRung, SandboxState } from '@animus-labs/cortex';

// A single lazily-created fake home for the whole file. It must resolve even
// when transitive imports (e.g. logger) call homedir() at module-load time,
// before any beforeEach runs, so it lives on globalThis with no TDZ. Per-test
// isolation comes from a fresh `cwd` each test (workspace settings are keyed
// by a hash of the project path, not by home).
function currentHome(): string {
  const g = globalThis as { __sessionSandboxHome?: string };
  if (!g.__sessionSandboxHome) {
    g.__sessionSandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sandbox-home-'));
  }
  return g.__sessionSandboxHome;
}
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => currentHome() };
});

import { Session } from '../src/session.js';
import { workspaceSettingsPath } from '../src/permissions/rules.js';

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-sandbox-ws-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(cwd, { recursive: true, force: true });
});

function makeSession(config: Record<string, unknown> = {}): {
  session: Session;
  updateStatus: ReturnType<typeof vi.fn>;
} {
  const updateStatus = vi.fn();
  const session = new Session({
    config: config as never,
    mode: { name: 'test', systemPrompt: '', contextSlots: [] } as never,
    model: {} as never,
    provider: 'test',
    modelId: 'test',
    providerManager: {} as never,
    credentialStore: {} as never,
    cwd,
    yoloMode: false,
    initialEffort: 'medium',
    resumeSessionId: undefined,
  });
  (session as unknown as { app: unknown }).app = {
    updateStatus,
    transcript: { addNotification: vi.fn() },
  };
  return { session, updateStatus };
}

function readPersistedRung(): unknown {
  try {
    const settings = JSON.parse(fs.readFileSync(workspaceSettingsPath(cwd), 'utf-8')) as {
      sandbox?: { rung?: unknown };
    };
    return settings.sandbox?.rung;
  } catch {
    // No settings file written yet (e.g. Windows default 'off' is not persisted).
    return undefined;
  }
}

interface SandboxInternals {
  applyState(state: SandboxState | undefined): void;
  settings: { load(): Promise<void> };
  resolveInitialRung(): Promise<SandboxRung>;
}

function sandboxOf(session: Session): SandboxInternals {
  return (session as unknown as { sandbox: SandboxInternals }).sandbox;
}

/** The consumer delegates lifecycle to Cortex and owns preferences and display. */
function attachAgent(session: Session, initial: SandboxRung = 'workspace') {
  let state: SandboxState = { enabled: true, rung: initial, status: {
    backend: 'seatbelt', filesystem: 'enforced', network: 'enforced', degradations: [],
  } };
  const setEphemeral = vi.fn();
  const agent = {
    getSandboxState: () => state,
    setSandboxRung: vi.fn(async (rung: SandboxRung) => { state = { ...state, rung }; }),
    destroy: vi.fn(async () => {}),
    getContextManager: () => ({ setEphemeral }),
    effectiveContextWindow: 200_000,
    currentContextTokenCount: 0,
    estimateCurrentContextTokens: () => 0,
  };
  Object.assign(session, { agent });
  // The same path start() takes once the agent exists: adopt Cortex's state.
  sandboxOf(session).applyState(state);
  return { agent, setEphemeral };
}

describe('Session sandbox integration', () => {
  it('delegates a rung change to Cortex and persists the preference', async () => {
    const { session, updateStatus } = makeSession();
    const { agent, setEphemeral } = attachAgent(session);
    expect((await session.setSandboxRung('trusted')).changed).toBe(true);
    expect(agent.setSandboxRung).toHaveBeenCalledWith('trusted');
    expect(session.getSandboxRung()).toBe('trusted');
    expect(readPersistedRung()).toBe('trusted');
    expect(updateStatus).toHaveBeenLastCalledWith({ sandboxRung: 'trusted', sandboxEnforcement: 'enforced' });
    expect(String(setEphemeral.mock.calls[0]![0])).toContain('Sandbox: trusted rung');
  });

  it('clears the displayed policy when Cortex switches off', async () => {
    const { session, updateStatus } = makeSession();
    const { agent, setEphemeral } = attachAgent(session);
    expect((await session.setSandboxRung('off')).changed).toBe(true);
    expect(agent.setSandboxRung).toHaveBeenCalledWith('off');
    expect(session.getSandboxPolicy()).toBeUndefined();
    expect(session.getSandboxStatus()).toBeUndefined();
    expect(updateStatus).toHaveBeenLastCalledWith({ sandboxRung: 'off', sandboxEnforcement: 'none' });
    expect(String(setEphemeral.mock.calls.at(-1)![0])).not.toContain('Sandbox:');
    expect(readPersistedRung()).toBe('off');
  });

  it('does not persist a change Cortex rejects while work is active', async () => {
    const { session } = makeSession();
    const { agent } = attachAgent(session);
    agent.setSandboxRung.mockRejectedValue(new Error('Wait for work to settle'));
    expect(await session.setSandboxRung('trusted')).toEqual({ changed: false, reason: 'Wait for work to settle' });
    expect(readPersistedRung()).toBeUndefined();
  });

  it('does not reconfigure the same rung', async () => {
    const { session } = makeSession();
    const { agent } = attachAgent(session);
    expect((await session.setSandboxRung('workspace')).changed).toBe(false);
    expect(agent.setSandboxRung).not.toHaveBeenCalled();
  });

  it('honors the consumer kill switch', async () => {
    const { session } = makeSession({ sandbox: { enabled: false } });
    expect((await session.setSandboxRung('workspace')).reason).toContain('disabled by config');
  });

  it('uses the Cortex teardown for abnormal exits', async () => {
    const { session } = makeSession();
    const { agent } = attachAgent(session);
    await session.disposeSandbox();
    expect(agent.destroy).toHaveBeenCalledOnce();
  });
});

describe('Session.resolveInitialRung (folder-trust default)', () => {
  async function resolveRung(session: Session): Promise<SandboxRung> {
    const sandbox = sandboxOf(session);
    await sandbox.settings.load();
    return sandbox.resolveInitialRung();
  }

  it('defaults a fresh workspace to the platform default', async () => {
    const { session } = makeSession();

    if (process.platform === 'win32') {
      // Windows: MXC containment is opt-in until validated on a real host,
      // default 'off', and NOT persisted, so a later config default or an
      // on-by-default rollout can still raise it (only /sandbox workspace
      // persists an opt-in).
      expect(await resolveRung(session)).toBe('off');
      expect(readPersistedRung()).toBeUndefined();
    } else {
      // On-by-default at Workspace and remembered (folder-trust).
      expect(await resolveRung(session)).toBe('workspace');
      expect(readPersistedRung()).toBe('workspace');
    }
  });

  it('starts a fresh workspace at the configured default rung', async () => {
    const { session } = makeSession({ sandbox: { rung: 'trusted' } });

    expect(await resolveRung(session)).toBe('trusted');
    expect(readPersistedRung()).toBe('trusted');
  });

  it('prefers the remembered per-workspace rung over the config default', async () => {
    const first = makeSession();
    attachAgent(first.session);
    await first.session.setSandboxRung('restricted');

    const second = makeSession({ sandbox: { rung: 'trusted' } });
    expect(await resolveRung(second.session)).toBe('restricted');
  });
});
