/**
 * The credential store is pi-ai's CredentialStore, over a real file and the
 * real cross-process file lock. Cortex's ProviderManager refreshes an OAuth
 * token inside `modify`, checking again under the lock whether it still
 * needs one, so several processes (or several sessions in one process)
 * refresh a rotating token once. These tests drive `modify` the way pi does,
 * with two store instances standing in for two processes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Keep the macOS Keychain out of it: report it unavailable unless a test
// says otherwise.
const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

import { CredentialFileError, CredentialStore } from '../../src/config/credentials.js';
import type { CredentialFile } from '../../src/config/credentials.js';

const HOUR = 60 * 60 * 1000;

let dir: string;
let file: string;

function writeFixture(data: Partial<CredentialFile>): void {
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...data }, null, 2));
}

function readBack(): CredentialFile {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as CredentialFile;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-creds-'));
  file = path.join(dir, 'credentials.json');
  execFile.mockReset();
  execFile.mockImplementation((_cmd: string, _args: string[], callback: (err: Error | null) => void) =>
    callback(new Error('keychain unavailable')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('CredentialStore as pi-ai CredentialStore', () => {
  it('maps stored entries to pi credentials', async () => {
    const blob = { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + HOUR };
    writeFixture({
      providers: {
        anthropic: { provider: 'anthropic', method: 'oauth', oauthCredentials: JSON.stringify(blob), addedAt: 1 },
        openai: { provider: 'openai', method: 'api_key', apiKey: 'sk-openai', addedAt: 1 },
        ollama: { provider: 'ollama', method: 'custom', baseUrl: 'http://localhost:11434/v1', addedAt: 1 },
      },
    });
    const store = new CredentialStore(file);

    expect(await store.read('anthropic')).toEqual(blob);
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'sk-openai' });
    expect(await store.read('ollama')).toBeUndefined();
    expect(await store.list()).toEqual([
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'openai', type: 'api_key' },
    ]);
  });

  it('reads an API key the Keychain holds', async () => {
    execFile.mockImplementation((_cmd: string, args: string[], callback: (err: Error | null, out?: { stdout: string }) => void) =>
      (args[0] === 'find-generic-password' ? callback(null, { stdout: 'sk-from-keychain\n' }) : callback(new Error('no'))));
    writeFixture({ providers: { openai: { provider: 'openai', method: 'api_key', addedAt: 1 } } });

    expect(await new CredentialStore(file).read('openai')).toEqual({ type: 'api_key', key: 'sk-from-keychain' });
  });

  it('refreshes once when two processes find the same expired token', async () => {
    const stale = { type: 'oauth' as const, access: 'stale', refresh: 'r1', expires: Date.now() - 1000 };
    writeFixture({
      providers: { anthropic: { provider: 'anthropic', method: 'oauth', oauthCredentials: JSON.stringify(stale), addedAt: 1 } },
    });
    let refreshes = 0;
    // pi's locked refresh: check again under the lock, refresh only if still due.
    const refreshUnderLock = (store: CredentialStore) => store.modify('anthropic', async (current) => {
      if (current?.type !== 'oauth' || current.expires > Date.now()) return undefined;
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { type: 'oauth', access: 'fresh', refresh: 'r2', expires: Date.now() + HOUR };
    });

    const results = await Promise.all([
      refreshUnderLock(new CredentialStore(file)),
      refreshUnderLock(new CredentialStore(file)),
      refreshUnderLock(new CredentialStore(file)),
    ]);

    expect(refreshes).toBe(1);
    expect(results.map((credential) => credential?.type === 'oauth' && credential.access)).toEqual(['fresh', 'fresh', 'fresh']);
    expect(JSON.parse(readBack().providers['anthropic']!.oauthCredentials!)).toMatchObject({ access: 'fresh', refresh: 'r2' });
  });

  it('keeps its own fields when pi writes a credential', async () => {
    const blob = { type: 'oauth', access: 'a', refresh: 'r', expires: 5 };
    writeFixture({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-opus-5-5',
      providers: {
        anthropic: {
          provider: 'anthropic',
          method: 'oauth',
          oauthCredentials: JSON.stringify(blob),
          oauthMeta: { displayName: 'craig@example.com', expiresAt: 5, refreshable: true },
          addedAt: 42,
        },
      },
    });
    const store = new CredentialStore(file);

    await store.modify('anthropic', async () => ({ type: 'oauth', access: 'b', refresh: 'r', expires: 9 }));

    const written = readBack();
    expect(written.defaultModel).toBe('claude-opus-5-5');
    expect(written.providers['anthropic']).toMatchObject({
      provider: 'anthropic',
      method: 'oauth',
      addedAt: 42,
      oauthMeta: { displayName: 'craig@example.com', expiresAt: 9, refreshable: true },
    });
  });

  it('leaves the file untouched when pi changes nothing', async () => {
    writeFixture({ providers: { openai: { provider: 'openai', method: 'api_key', apiKey: 'sk-openai', addedAt: 1 } } });
    const before = fs.readFileSync(file, 'utf8');

    const result = await new CredentialStore(file).modify('openai', async () => undefined);

    expect(result).toEqual({ type: 'api_key', key: 'sk-openai' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses to read or write over a torn file, which would wipe every other provider', async () => {
    const full = JSON.stringify({
      version: 1,
      defaultModel: 'claude-opus-5-5',
      providers: {
        anthropic: { provider: 'anthropic', method: 'oauth', oauthCredentials: JSON.stringify({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + HOUR }), addedAt: 1 },
        openai: { provider: 'openai', method: 'api_key', apiKey: 'sk-openai', addedAt: 1 },
      },
    }, null, 2);
    // A crash in the middle of an in-place write.
    fs.writeFileSync(file, full.slice(0, Math.floor(full.length / 2)));
    const torn = fs.readFileSync(file, 'utf8');
    const store = new CredentialStore(file);

    await expect(store.read('anthropic')).rejects.toBeInstanceOf(CredentialFileError);
    await expect(store.modify('xai', async () => ({ type: 'api_key', key: 'sk-xai' })))
      .rejects.toThrow(/not valid JSON.*Fix or remove the file/);

    expect(fs.readFileSync(file, 'utf8')).toBe(torn);
  });

  it('replaces the file whole rather than rewriting it in place', async () => {
    writeFixture({ providers: { openai: { provider: 'openai', method: 'api_key', apiKey: 'sk-openai', addedAt: 1 } } });
    const before = fs.statSync(file).ino;

    await new CredentialStore(file).modify('anthropic', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 5 }));

    // A rename leaves a new inode; truncating in place keeps the old one.
    expect(fs.statSync(file).ino).not.toBe(before);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(Object.keys(readBack().providers).sort()).toEqual(['anthropic', 'openai']);
  });

  it('waits out a holder that keeps the lock longer than a 15-second refresh', async () => {
    // pi may hold the lock for a 15-second token refresh. proper-lockfile's
    // own retries (the old `retries: 3`) give up after 1 + 2 + 4 seconds, so
    // the clock runs on past that: fake timers for the waits, real I/O for
    // the lock itself.
    const realSetTimeout = globalThis.setTimeout;
    const io = (): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, 2));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      writeFixture({ providers: {} });
      let releaseHolder!: () => void;
      const holding = new Promise<void>((resolve) => { releaseHolder = resolve; });
      let held = false;
      const slow = new CredentialStore(file).modify('openai', async () => {
        held = true;
        await holding;
        return { type: 'api_key', key: 'sk-first' };
      });
      while (!held) await io();

      let waited = false;
      const second = new CredentialStore(file).modify('openai', async (current) => {
        expect(current).toEqual({ type: 'api_key', key: 'sk-first' });
        return { type: 'api_key', key: 'sk-second' };
      }).finally(() => { waited = true; });
      second.catch(() => {});

      for (let elapsed = 0; elapsed < 16_000; elapsed += 250) {
        await vi.advanceTimersByTimeAsync(250);
        await io();
      }
      // Still waiting, sixteen seconds in: it did not give up.
      expect(waited).toBe(false);

      releaseHolder();
      for (let i = 0; i < 200 && !waited; i++) {
        await vi.advanceTimersByTimeAsync(250);
        await io();
      }
      await Promise.all([slow, second]);
    } finally {
      vi.useRealTimers();
    }
    expect(await new CredentialStore(file).read('openai')).toEqual({ type: 'api_key', key: 'sk-second' });
  });
});
