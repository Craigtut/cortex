/**
 * The eval auth helper's cached-OAuth path end to end, through the real
 * ProviderManager and a credentials file on disk: a cached credential is read
 * through the helper's credential store, an expiring one is refreshed by pi's
 * Models inside the store's `modify`, and the rotation lands in the file.
 *
 * The credentials file is redirected to a temp file, and Anthropic's OAuth is
 * a counting fake: no real credentials, no network.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const HOUR = 60 * 60 * 1000;
const temp = vi.hoisted(() => ({ file: '' }));

// Every read and write of the helper's credentials file goes to the temp file.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const redirect = (target: fs.PathOrFileDescriptor): fs.PathOrFileDescriptor =>
    typeof target === 'string' && target.endsWith('.eval-credentials.json') ? temp.file : target;
  return {
    ...real,
    existsSync: (target: fs.PathLike) => real.existsSync(redirect(target as string) as string),
    readFileSync: ((target: fs.PathOrFileDescriptor, options?: unknown) =>
      real.readFileSync(redirect(target), options as never)) as typeof real.readFileSync,
    writeFileSync: ((target: fs.PathOrFileDescriptor, data: string, options?: unknown) =>
      real.writeFileSync(redirect(target), data, options as never)) as typeof real.writeFileSync,
    unlinkSync: (target: fs.PathLike) => real.unlinkSync(redirect(target as string) as string),
  };
});

const refresh = vi.hoisted(() => vi.fn());

vi.mock('@earendil-works/pi-ai/providers/all', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  builtinProviders: () => [{
    id: 'anthropic',
    name: 'Anthropic',
    auth: {
      oauth: {
        name: 'Anthropic',
        login: vi.fn(),
        refresh: (credential: unknown) => refresh(credential),
        toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }),
      },
    },
    getModels: () => [],
  }],
}));

let dir: string;

function writeCache(credential: Record<string, unknown>): void {
  fs.writeFileSync(temp.file, JSON.stringify({
    anthropic: { type: 'oauth', oauthCredentials: JSON.stringify(credential) },
  }));
}

function cachedCredential(): Record<string, unknown> {
  const cache = JSON.parse(fs.readFileSync(temp.file, 'utf8')) as Record<string, { oauthCredentials: string }>;
  return JSON.parse(cache['anthropic']!.oauthCredentials) as Record<string, unknown>;
}

describe('eval auth helper over a credentials file', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-eval-creds-'));
    temp.file = path.join(dir, 'eval-credentials.json');
    refresh.mockReset();
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses a live cached OAuth token without refreshing it', async () => {
    writeCache({ type: 'oauth', access: 'live-access', refresh: 'r1', expires: Date.now() + HOUR });
    const auth = await import('../eval/helpers/auth.js');

    await expect(auth.resolveEvalApiKey('anthropic')).resolves.toBe('live-access');

    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes an expired cached token and writes the rotation to the file', async () => {
    writeCache({ type: 'oauth', access: 'stale-access', refresh: 'r1', expires: Date.now() - 1_000 });
    refresh.mockResolvedValue({ type: 'oauth', access: 'fresh-access', refresh: 'r2', expires: Date.now() + HOUR });
    const auth = await import('../eval/helpers/auth.js');

    await expect(auth.resolveEvalApiKey('anthropic')).resolves.toBe('fresh-access');

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![0]).toMatchObject({ access: 'stale-access', refresh: 'r1' });
    expect(cachedCredential()).toMatchObject({ type: 'oauth', access: 'fresh-access', refresh: 'r2' });
  });
});
