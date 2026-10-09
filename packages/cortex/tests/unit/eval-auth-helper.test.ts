/**
 * The eval auth helper resolves cached OAuth credentials through
 * ProviderManager. It used to call pi-ai's removed global OAuth helpers
 * (`@earendil-works/pi-ai/oauth` has exported types only since 0.80), so a
 * cached credential failed with "getOAuthApiKey is not a function" and fell
 * through to a browser login.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const resolveOAuthApiKey = vi.fn();
const initiateOAuth = vi.fn();

vi.mock('../../src/provider-manager.js', () => ({
  ProviderManager: class {
    resolveOAuthApiKey = resolveOAuthApiKey;
    initiateOAuth = initiateOAuth;
  },
}));

describe('eval auth helper', () => {
  beforeEach(() => {
    files.clear();
    resolveOAuthApiKey.mockReset();
    initiateOAuth.mockReset();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves a cached OAuth credential through ProviderManager and persists a rotation', async () => {
    const auth = await import('../eval/helpers/auth.js');
    const stored = JSON.stringify({ access: 'old-access', refresh: 'old-refresh', expires: 1 });
    files.set(auth.getCredentialsPath(), JSON.stringify({
      anthropic: { type: 'oauth', oauthCredentials: stored },
    }));
    const rotated = JSON.stringify({ access: 'new-access', refresh: 'new-refresh', expires: 2 });
    resolveOAuthApiKey.mockResolvedValue({
      apiKey: 'new-access',
      credentials: rotated,
      meta: { provider: 'anthropic', refreshable: true },
      changed: true,
    });

    await expect(auth.resolveEvalApiKey('anthropic')).resolves.toBe('new-access');

    expect(resolveOAuthApiKey).toHaveBeenCalledWith('anthropic', stored);
    expect(initiateOAuth).not.toHaveBeenCalled();
    const cache = JSON.parse(files.get(auth.getCredentialsPath())!) as Record<string, { oauthCredentials: string }>;
    expect(cache['anthropic']!.oauthCredentials).toBe(rotated);
  });
});
