/**
 * Drives the REAL Session against a REAL CortexAgent in passthrough, so the
 * two claims the facade migration rests on actually cross:
 *
 * - the config Session hands CortexAgent.create() really assembles a
 *   passthrough facade (the facade default is duplex, so an omitted `mode`
 *   would silently give a coding CLI a talker), and
 * - resume() really restores through the single subsumed restore(), rather
 *   than through the three loop-level restore* calls the facade withholds.
 *
 * Only the TUI and the OS-touching pieces are stubbed. The agent, the
 * persistence round-trip, and the restore contract all run for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CortexAgent, wrapModel } from '@animus-labs/cortex';
import type {
  CortexAgentConfig,
  CortexModel,
  ObservationalMemoryState,
  SessionUsage,
} from '@animus-labs/cortex';

// A single lazily-created fake home for the whole file (see
// session-sandbox.test.ts for why this lives on globalThis). The persistence
// module resolves ~/.cortex/sessions at module load, so this must be in place
// before the first import of it.
function currentHome(): string {
  const g = globalThis as { __sessionFacadeHome?: string };
  if (!g.__sessionFacadeHome) {
    g.__sessionFacadeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-facade-home-'));
  }
  return g.__sessionFacadeHome;
}
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => currentHome() };
});

import { Session } from '../src/session.js';
import { listSessions, saveSession, saveObservationalState, type SessionMeta } from '../src/persistence/sessions.js';

let cwd: string;
const liveAgents: CortexAgent[] = [];

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-facade-ws-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (liveAgents.length > 0) {
    await liveAgents.pop()!.destroy();
  }
  fs.rmSync(cwd, { recursive: true, force: true });
});

interface SessionInternals {
  agent: CortexAgent | null;
  app: unknown;
  work: { readonly isRunning: boolean; begin(): void };
  buildAgentConfig: () => CortexAgentConfig;
}

function makeSession(overrides: Record<string, unknown> = {}): {
  session: Session;
  internals: SessionInternals;
} {
  const session = new Session({
    config: {} as never,
    mode: { name: 'test', systemPrompt: 'Test base prompt', contextSlots: [] } as never,
    model: {} as never,
    provider: 'test',
    modelId: 'test',
    providerManager: {} as never,
    credentialStore: {} as never,
    cwd,
    yoloMode: false,
    initialEffort: 'medium',
    resumeSessionId: undefined,
    ...overrides,
  } as never);
  return { session, internals: session as unknown as SessionInternals };
}

/** A wrapped model the loop accepts; no provider call is ever made here. */
function testModel(): CortexModel {
  return wrapModel(
    { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as never,
    'anthropic',
    'claude-sonnet-4-20250514',
  );
}

/** A real passthrough facade built from Session's own config. */
async function agentFromSessionConfig(internals: SessionInternals): Promise<CortexAgent> {
  const agent = await CortexAgent.create({ ...internals.buildAgentConfig(), model: testModel() });
  liveAgents.push(agent);
  return agent;
}

function usage(totalCost: number, totalTurns: number): SessionUsage {
  return {
    totalCost,
    totalTurns,
    tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3 },
  };
}

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    mode: 'test',
    provider: 'test',
    model: 'test',
    cwd,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    contextTokenCount: 1234,
    ...extra,
  };
}

function observationalState(): ObservationalMemoryState {
  return {
    observations: 'The user is migrating a consumer onto the facade.',
    continuationHint: null,
    observationTokenCount: 42,
    generationCount: 1,
    bufferedChunks: [],
    bufferWatermark: 0,
  };
}

describe('Session builds a passthrough CortexAgent', () => {
  it('pins mode to passthrough rather than inheriting the facade default', () => {
    const { internals } = makeSession();
    expect(internals.buildAgentConfig().mode).toBe('passthrough');
  });

  it('assembles a facade with no talker from that exact config', async () => {
    const { internals } = makeSession();
    const agent = await agentFromSessionConfig(internals);

    // The public tell for "no talker was built": duplex always has a talker
    // loop, so its per-loop usage attribution is never null and its history
    // is a real surface.
    const state = await agent.getState();
    expect(state.version).toBe(2);
    expect(state.usage.perLoop.talker).toBeNull();
    expect(state.talkerHistory).toEqual([]);
  });

  it('carries the session wiring through the facade to the reasoner', async () => {
    const { internals } = makeSession();
    const agent = await agentFromSessionConfig(internals);

    // Forwarded reads the TUI depends on: the base prompt Session supplied,
    // and the model surface /model and the footer read.
    expect(agent.getBasePrompt()).toContain('Test base prompt');
    expect(agent.getModel().modelId).toBe('claude-sonnet-4-20250514');
    expect(agent.effectiveContextWindow).toBeGreaterThan(0);
    expect(agent.getCompactionManager()).toBeDefined();
  });
});

describe('Session.resume through the subsumed restore()', () => {
  it('restores history, usage, and observational state in one call', async () => {
    const sessionId = 'resume-full';
    await saveSession(
      sessionId,
      [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
      meta(sessionId, { usage: usage(1.25, 7) }),
    );
    await saveObservationalState(sessionId, observationalState());

    const { session, internals } = makeSession();
    internals.agent = await agentFromSessionConfig(internals);
    internals.app = null;

    await session.resume(sessionId);

    expect(internals.agent.getConversationHistory()).toHaveLength(2);
    // Usage restores as the facade's baseline, so the aggregate reads back
    // exactly what was saved before any live delta lands on top.
    expect(internals.agent.getSessionUsage().totalCost).toBeCloseTo(1.25);
    expect(internals.agent.getSessionUsage().totalTurns).toBe(7);
    expect(internals.agent.getObservationalMemoryState()?.observations).toContain(
      'migrating a consumer',
    );
  });

  it('lists and resumes a session a classic build saved', async () => {
    const sessionId = 'resume-classic';
    // Older builds recorded their compaction strategy in meta.json.
    await saveSession(
      sessionId,
      [{ role: 'user', content: 'hello' }],
      { ...meta(sessionId), compactionStrategy: 'classic' } as SessionMeta,
    );

    expect((await listSessions()).map((listed) => listed.id)).toContain(sessionId);

    const { session, internals } = makeSession();
    internals.agent = await agentFromSessionConfig(internals);
    internals.app = null;

    await session.resume(sessionId);

    expect(internals.agent.getConversationHistory()).toHaveLength(1);
    // A classic build saved no memory, so the session resumes with none.
    expect(internals.agent.getObservationalMemoryState()?.observations).toBe('');
  });

  it('restores a session saved without usage', async () => {
    const sessionId = 'resume-no-usage';
    await saveSession(sessionId, [{ role: 'user', content: 'hello' }], meta(sessionId));

    const { session, internals } = makeSession();
    internals.agent = await agentFromSessionConfig(internals);
    internals.app = null;

    await session.resume(sessionId);

    expect(internals.agent.getConversationHistory()).toHaveLength(1);
    expect(internals.agent.getSessionUsage().totalCost).toBe(0);
  });

  it('reports a rejected restore instead of rejecting out of the input handler', async () => {
    const sessionId = 'resume-rejected';
    await saveSession(sessionId, [{ role: 'user', content: 'hello' }], meta(sessionId));

    const { session, internals } = makeSession();
    const agent = await agentFromSessionConfig(internals);
    internals.agent = agent;
    const addNotification = vi.fn();
    internals.app = { transcript: { addNotification } };

    // A real facade rejection: restore() refuses once the agent is gone, the
    // same way it refuses while a loop is running.
    await agent.destroy();

    await expect(session.resume(sessionId)).resolves.toBeUndefined();
    expect(addNotification).toHaveBeenCalledWith('Resume Failed', expect.stringContaining('destroyed'));
  });
});

describe('Session.abort against the facade', () => {
  it('does not reject when a Ctrl+C lands after teardown has begun', async () => {
    const { session, internals } = makeSession();
    const agent = await agentFromSessionConfig(internals);
    internals.agent = agent;
    internals.work.begin();
    internals.app = null;

    await agent.destroy();

    // The editor discards this promise, so a rejection here would be an
    // unhandled rejection rather than a visible error.
    await expect(session.abort()).resolves.toBeUndefined();
    expect(internals.work.isRunning).toBe(false);
  });
});
