/**
 * Which stored credential answers a getAuth(provider) call.
 *
 * pi-agent-core asks for the *model's* provider field, which is the synthetic
 * id "custom" for anything built by createCustomModel (a local
 * OpenAI-compatible endpoint), whatever the connection is called. The
 * session answers nothing for it: the model carries its connection's key
 * (or Cortex's placeholder for a keyless endpoint), which Cortex sends when
 * the callback supplies none.
 *
 * The session used to borrow a key for "custom" from its own provider's
 * entry, which was only right while the two named the same endpoint. A
 * duplex talker outlives a /model provider switch still pointed at the
 * startup provider's model, so it kept asking for "custom" long after the
 * session moved elsewhere. Sending a cloud token to localhost was the hazard.
 *
 * The callback under test is the one the facade is actually handed
 * (buildAgentConfig().getAuth), not a private method reached directly, so
 * the wiring is covered along with the resolution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { completeModel, ProviderManager } from '@animus-labs/cortex';
import { makeSession } from './helpers/duplex-harness.js';
import type { CredentialEntry } from '../src/config/credentials.js';
import { resolveConfiguredModel } from '../src/providers/model-resolution.js';

const OAUTH_ENTRY: CredentialEntry = {
  provider: 'anthropic',
  method: 'oauth',
  oauthCredentials: '{"access":"a","refresh":"r","expires":0}',
  addedAt: 1,
};

const LOCAL_ENTRY: CredentialEntry = {
  provider: 'ollama',
  method: 'custom',
  apiKey: 'sk-local',
  baseUrl: 'http://localhost:11434/v1',
  addedAt: 1,
};

/**
 * Stands in for ProviderManager.getAuth over the session's store: only the
 * provider the credential is filed under resolves.
 */
function fakeProviderManager() {
  return {
    getAuth: vi.fn(async (id: string) => (id === 'anthropic' ? { apiKey: 'sk-oauth-live' } : undefined)),
  };
}

function fakeCredentialStore(entries: Record<string, CredentialEntry>) {
  return {
    getProvider: vi.fn(async (name: string) => entries[name]),
    setProvider: vi.fn(async () => {}),
  };
}

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-creds-'));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function getAuthFor(
  sessionProvider: string,
  entries: Record<string, CredentialEntry>,
): { call: (provider: string) => Promise<string | undefined>; providerManager: ReturnType<typeof fakeProviderManager> } {
  const providerManager = fakeProviderManager();
  const { internals } = makeSession(cwd, {
    provider: sessionProvider,
    credentialStore: fakeCredentialStore(entries),
    providerManager,
  });
  const getAuth = internals.buildAgentConfig().getAuth;
  if (!getAuth) throw new Error('session did not wire a getAuth callback');
  return { call: async (provider: string) => (await getAuth(provider))?.apiKey, providerManager };
}

describe('getAuth credential attribution', () => {
  it('does not lend a cloud OAuth credential to a custom-endpoint model', async () => {
    const { call, providerManager } = getAuthFor('anthropic', { anthropic: OAUTH_ENTRY });

    // The precondition that makes the negative assertion mean something: this
    // same store does answer an anthropic request, so a placeholder for
    // "custom" is a decision about that id and not an empty store.
    await expect(call('anthropic')).resolves.toBe('sk-oauth-live');

    await expect(call('custom')).resolves.toBeUndefined();
    expect(providerManager.getAuth).not.toHaveBeenCalledWith('custom');
  });

  it('answers nothing for a local endpoint, whose model carries its key', async () => {
    const { call } = getAuthFor('local', { local: LOCAL_ENTRY });

    await expect(call('custom')).resolves.toBeUndefined();
  });

  it('reports a missing credential for a real provider rather than borrowing one', async () => {
    // A talker stranded on the startup provider after /model switched away,
    // where the startup provider is a cloud one rather than Ollama. Handing it
    // the new provider's token would send that token somewhere it was never
    // issued for; "run /login" is both true and actionable.
    const { call, providerManager } = getAuthFor('anthropic', { anthropic: OAUTH_ENTRY });

    await expect(call('openai')).rejects.toThrow(/No credentials for provider "openai"/);
    expect(providerManager.getAuth).not.toHaveBeenCalled();
  });
});

/** An OpenAI-compatible endpoint that records each request's bearer token and refuses it. */
async function localEndpoint(): Promise<{ baseUrl: string; tokens: string[]; close: () => Promise<void> }> {
  const tokens: string[] = [];
  const server = createServer((request, response) => {
    tokens.push(String(request.headers['authorization'] ?? ''));
    request.resume();
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'stand-in' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    tokens,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('a custom endpoint request', () => {
  /**
   * What the session's getAuth and a model resolved from the stored entry
   * send to the endpoint, with the session on `sessionProvider`.
   */
  async function tokenSent(entry: Omit<CredentialEntry, 'baseUrl'>, sessionProvider: string): Promise<string[]> {
    const endpoint = await localEndpoint();
    try {
      const stored = { ...entry, baseUrl: endpoint.baseUrl };
      const model = await resolveConfiguredModel(new ProviderManager(), 'local', 'local-model', stored);
      const { internals } = makeSession(cwd, {
        provider: sessionProvider,
        credentialStore: fakeCredentialStore({ local: stored, anthropic: OAUTH_ENTRY }),
        providerManager: fakeProviderManager(),
      });
      const auth = await internals.buildAgentConfig().getAuth!(model.provider);
      const answer = await completeModel(
        model,
        { messages: [{ role: 'user', content: 'Hi', timestamp: 0 }] },
        auth ? { auth } : {},
      );
      // Precondition: the request reached the endpoint and was refused there.
      expect(answer.stopReason).toBe('error');
      return endpoint.tokens;
    } finally {
      await endpoint.close();
    }
  }

  it("carries the connection's own key", async () => {
    expect(await tokenSent(LOCAL_ENTRY, 'local')).toEqual(['Bearer sk-local']);
  });

  it('still reaches a keyless endpoint', async () => {
    const { apiKey: _none, ...keyless } = LOCAL_ENTRY;
    expect(await tokenSent(keyless, 'local')).toEqual(['Bearer sk-no-key-required']);
  });

  it("keeps its own key after the session moved to a cloud provider", async () => {
    expect(await tokenSent(LOCAL_ENTRY, 'anthropic')).toEqual(['Bearer sk-local']);
  });
});
