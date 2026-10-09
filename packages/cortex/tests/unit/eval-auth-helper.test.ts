/**
 * The eval auth helper resolves cached OAuth credentials through
 * ProviderManager.getAuth, over a credential store backed by its cache file.
 * It used to call pi-ai's removed global OAuth helpers
 * (`@earendil-works/pi-ai/oauth` has exported types only since 0.80), so a
 * cached credential failed with "getOAuthApiKey is not a function" and fell
 * through to a browser login.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '@earendil-works/pi-ai';

const files = new Map<string, string>();

vi.mock('node:fs', () => ({
  existsSync: (path: string) => files.has(path),
  readFileSync: (path: string) => {
    const content = files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  },
  writeFileSync: (path: string, content: string) => {
    files.set(path, content);
  },
  unlinkSync: (path: string) => {
    files.delete(path);
  },
}));

const getAuth = vi.fn();
const initiateOAuth = vi.fn();
let storeGiven: CredentialStore | undefined;

vi.mock('../../src/provider-manager.js', () => ({
  ProviderManager: class {
    constructor(options: { credentials?: CredentialStore } = {}) {
      storeGiven = options.credentials;
    }
    getAuth = getAuth;
    initiateOAuth = initiateOAuth;
  },
}));

describe('eval auth helper', () => {
  beforeEach(() => {
    files.clear();
    getAuth.mockReset();
    initiateOAuth.mockReset();
    storeGiven = undefined;
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves a cached OAuth credential through ProviderManager and persists a rotation', async () => {
    const auth = await import('../eval/helpers/auth.js');
    files.set(auth.getCredentialsPath(), JSON.stringify({
      anthropic: {
        type: 'oauth',
        oauthCredentials: JSON.stringify({ access: 'old-access', refresh: 'old-refresh', expires: 1 }),
      },
    }));
    // What pi's getAuth does with an expired token: refresh it inside the
    // store's modify, which writes the rotation.
    const rotated = { type: 'oauth' as const, access: 'new-access', refresh: 'new-refresh', expires: 2 };
    let seen: unknown;
    getAuth.mockImplementation(async (provider: string) => {
      const stored = await storeGiven!.modify(provider, async (current) => {
        seen = current;
        return rotated;
      });
      return { apiKey: stored?.type === 'oauth' ? stored.access : undefined };
    });

    await expect(auth.resolveEvalApiKey('anthropic')).resolves.toBe('new-access');

    expect(getAuth).toHaveBeenCalledWith('anthropic');
    expect(seen).toEqual({ type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: 1 });
    expect(initiateOAuth).not.toHaveBeenCalled();
    const cache = JSON.parse(files.get(auth.getCredentialsPath())!) as Record<string, { oauthCredentials: string }>;
    expect(JSON.parse(cache['anthropic']!.oauthCredentials)).toEqual(rotated);
  });
});
