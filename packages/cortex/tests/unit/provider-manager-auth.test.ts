/**
 * ProviderManager resolves request auth through pi's own providers and
 * credential store. Run against the installed pi-ai, with no network: every
 * credential here is unexpired, so nothing refreshes.
 *
 * Before pi's Models backed it, resolveOAuthApiKey() kept only a key. Kimi
 * Coding's OAuth authorizes with a header (so it threw "pi returned no
 * apiKey"), and GitHub Copilot's per-account base URL was dropped.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ProviderManager } from '../../src/provider-manager.js';

const HOUR = 60 * 60 * 1000;

function oauthBlob(access: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'oauth', access, refresh: 'refresh-token', expires: Date.now() + HOUR, ...extra });
}

describe('ProviderManager request auth', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('passes on Kimi Coding OAuth auth, which is a header rather than a key', async () => {
    const result = await new ProviderManager().resolveOAuthApiKey('kimi-coding', oauthBlob('kimi-access'));

    expect(result.auth.headers).toEqual({ Authorization: 'Bearer kimi-access' });
    expect(result.apiKey).toBeUndefined();
  });

  it("passes on GitHub Copilot's per-account base URL", async () => {
    const token = 'tid=abc;exp=9999999999;proxy-ep=proxy.business.githubcopilot.com;st=dotcom';

    const result = await new ProviderManager().resolveOAuthApiKey('github-copilot', oauthBlob(token));

    expect(result.apiKey).toBe(token);
    expect(result.auth.baseUrl).toBe('https://api.business.githubcopilot.com');
  });

  it('reads request auth from the credential store it was given', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('kimi-coding', async () => JSON.parse(oauthBlob('stored-kimi')));
    await credentials.modify('openai', async () => ({ type: 'api_key', key: 'sk-stored' }));
    const manager = new ProviderManager({ credentials });

    expect(await manager.getAuth('kimi-coding')).toEqual({ headers: { Authorization: 'Bearer stored-kimi' } });
    expect(await manager.getAuth('openai')).toMatchObject({ apiKey: 'sk-stored' });

    await manager.logout('openai');
    expect(await credentials.read('openai')).toBeUndefined();
  });

  it('ignores provider env vars unless ambient credentials are enabled', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-from-env');

    expect(await new ProviderManager().getAuth('anthropic')).toBeUndefined();
    expect(await new ProviderManager({ ambientCredentials: true }).getAuth('anthropic'))
      .toMatchObject({ apiKey: 'sk-ant-from-env' });
  });
});
