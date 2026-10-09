/**
 * Which stored credential answers a getAuth(provider) call.
 *
 * pi-agent-core asks for the *model's* provider field, which is the synthetic
 * id "custom" for anything built by createCustomModel (Ollama, a local
 * OpenAI-compatible endpoint). The session answers those from the store, with
 * a fallback to the session's own provider name because a custom endpoint's
 * credential is filed under the connection name rather than "custom".
 *
 * That fallback is only safe while the two names describe the same endpoint.
 * A duplex talker outlives a /model provider switch still pointed at the
 * startup provider's model, so it keeps asking for "custom" long after the
 * session moved to a cloud provider, and the fallback then offers it that
 * provider's OAuth credential. Sending a cloud token to localhost is the real
 * hazard; the visible symptom was narrower, because an OAuth credential can
 * only be resolved under its own provider id and no OAuth provider is
 * registered as "custom".
 *
 * The callback under test is the one the facade is actually handed
 * (buildAgentConfig().getAuth), not a private method reached directly, so
 * the wiring is covered along with the resolution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeSession } from './helpers/duplex-harness.js';
import type { CredentialEntry } from '../src/config/credentials.js';

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

    await expect(call('custom')).resolves.toBe('sk-no-key-required');
    expect(providerManager.getAuth).not.toHaveBeenCalledWith('custom');
  });

  it('still lends a local endpoint credential filed under the connection name', async () => {
    // Regression guard, not a new behaviour: this is the case the fallback was
    // written for, and the guard above must not close it.
    const { call } = getAuthFor('ollama', { ollama: LOCAL_ENTRY });

    await expect(call('custom')).resolves.toBe('sk-local');
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
