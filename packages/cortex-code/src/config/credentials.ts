import { readFile, writeFile, mkdir, chmod, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore as PiCredentialStore,
} from '@animus-labs/cortex';

const execFileAsync = promisify(execFile);

export interface CredentialEntry {
  provider: string;
  method: 'oauth' | 'api_key' | 'custom';
  apiKey?: string;
  oauthCredentials?: string;
  oauthMeta?: {
    displayName?: string | undefined;
    expiresAt?: number | undefined;
    refreshable: boolean;
  };
  baseUrl?: string;
  modelId?: string;
  connectionName?: string;
  addedAt: number;
  lastUsed?: number;
}

export interface CredentialFile {
  version: 1;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultEffort: string | null;
  defaultUtilityModels: Record<string, string>;
  providers: Record<string, CredentialEntry>;
}

const CREDENTIALS_PATH = join(homedir(), '.cortex', 'credentials.json');
const KEYCHAIN_SERVICE = 'cortex-code';

/**
 * How long a lock holder may go without touching the lock before another
 * process may take it. pi refreshes an OAuth token inside `modify` for up to
 * 15 seconds; proper-lockfile keeps a held lock fresh while its process lives.
 */
const LOCK_STALE_MS = 30_000;
/** How long a writer waits for the lock before giving up. */
const LOCK_WAIT_MS = 30_000;

function emptyCredentialFile(): CredentialFile {
  return {
    version: 1,
    defaultProvider: null,
    defaultModel: null,
    defaultEffort: null,
    defaultUtilityModels: {},
    providers: {},
  };
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

/**
 * The credentials file cannot be read or does not parse. Nothing is written
 * over it: a store that read it as empty would replace every other
 * provider's credential with its own one change.
 */
export class CredentialFileError extends Error {
  constructor(path: string, reason: string) {
    super(`Cannot read ${path}: ${reason}. Fix or remove the file, then run cortex again to sign in.`);
    this.name = 'CredentialFileError';
  }
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'ENOENT';
}

/** The file's contents: empty only when there is no file; anything unreadable throws. */
async function readCredentialFile(path: string): Promise<CredentialFile> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (error) {
    if (isMissing(error)) return emptyCredentialFile();
    throw new CredentialFileError(path, (error as Error).message);
  }
  let file: Partial<CredentialFile>;
  try {
    file = JSON.parse(content) as Partial<CredentialFile>;
  } catch {
    throw new CredentialFileError(path, 'it is not valid JSON');
  }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) {
    throw new CredentialFileError(path, 'it is not a credentials object');
  }
  return {
    version: 1,
    defaultProvider: file.defaultProvider ?? null,
    defaultModel: file.defaultModel ?? null,
    defaultEffort: file.defaultEffort ?? null,
    defaultUtilityModels: file.defaultUtilityModels ?? {},
    providers: file.providers ?? {},
  };
}

/**
 * Replace the file whole: write a private temp file beside it, then rename
 * it over the original. A crash leaves the old file or the new one, never a
 * torn one, and a reader without the lock never sees a half-written file.
 */
async function writeCredentialFile(path: string, data: CredentialFile): Promise<void> {
  await ensureDir(path);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Run `fn` holding the credentials file's lock, which other cortex-code
 * processes honor too. A busy lock is retried with backoff until
 * {@link LOCK_WAIT_MS}: another process may be refreshing a token under it.
 */
async function withFileLock<T>(path: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await ensureDir(path);
  try {
    await readFile(path);
  } catch (error) {
    if (!isMissing(error)) throw new CredentialFileError(path, (error as Error).message);
    await writeCredentialFile(path, emptyCredentialFile());
  }
  const deadline = Date.now() + LOCK_WAIT_MS;
  let release: (() => Promise<void>) | undefined;
  for (let attempt = 0; !release; attempt++) {
    signal?.throwIfAborted();
    try {
      release = await lockfile.lock(path, { stale: LOCK_STALE_MS, retries: 0, realpath: false });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 'ELOCKED' || Date.now() >= deadline) throw error;
      const delay = Math.min(Math.round(10 * 2 ** attempt * (1 + Math.random())), 500);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}

// Opportunistic macOS Keychain integration via `security` CLI.
// Falls back silently if Keychain is unavailable.
async function keychainGet(account: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
      '-w',
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function keychainSet(account: string, password: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    // Delete existing entry first (ignore errors if it doesn't exist)
    try {
      await execFileAsync('security', [
        'delete-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', account,
      ]);
    } catch {
      // Entry doesn't exist, that's fine
    }
    await execFileAsync('security', [
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
      '-w', password,
      '-U',
    ]);
    return true;
  } catch {
    return false;
  }
}

async function keychainDelete(account: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await execFileAsync('security', [
      'delete-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
    ]);
  } catch {
    // Ignore if entry doesn't exist
  }
}

/**
 * Provider credentials in `~/.cortex/credentials.json`, with API keys in the
 * macOS Keychain where available. It is also pi-ai's `CredentialStore`
 * (`read`, `list`, `modify`, `delete`), so Cortex's ProviderManager reads
 * and refreshes OAuth tokens through it, under the file's cross-process
 * lock: concurrent requests and other cortex-code processes refresh a
 * rotating token once.
 */
export class CredentialStore implements PiCredentialStore {
  constructor(private readonly path: string = CREDENTIALS_PATH) {}

  /** Load all credentials from disk. */
  async load(): Promise<CredentialFile> {
    return readCredentialFile(this.path);
  }

  /** Get a specific provider's credentials. */
  async getProvider(providerId: string): Promise<CredentialEntry | null> {
    const file = await readCredentialFile(this.path);
    return withKeychainKey(providerId, file.providers[providerId]);
  }

  /** Save or update a provider's credentials. Acquires file lock. */
  async setProvider(providerId: string, entry: CredentialEntry): Promise<void> {
    await withFileLock(this.path, async () => {
      const file = await readCredentialFile(this.path);
      file.providers[providerId] = await storeKeyInKeychain(providerId, entry);
      await writeCredentialFile(this.path, file);
    });
  }

  /** Remove a provider's credentials. */
  async removeProvider(providerId: string): Promise<void> {
    try {
      await readFile(this.path);
    } catch (error) {
      if (isMissing(error)) return; // No file, nothing to remove
      throw new CredentialFileError(this.path, (error as Error).message);
    }
    await withFileLock(this.path, async () => {
      const file = await readCredentialFile(this.path);
      delete file.providers[providerId];
      // Also remove from Keychain
      await keychainDelete(providerId);
      await writeCredentialFile(this.path, file);
    });
  }

  /** Get default provider and model. */
  async getDefaults(): Promise<{ provider: string | null; model: string | null }> {
    const file = await readCredentialFile(this.path);
    return {
      provider: file.defaultProvider,
      model: file.defaultModel,
    };
  }

  /** Set default provider and model. */
  async setDefaults(provider: string, model: string): Promise<void> {
    await this.update((file) => {
      file.defaultProvider = provider;
      file.defaultModel = model;
    });
  }

  /** Get the persisted default utility model for a provider. */
  async getDefaultUtilityModel(provider: string): Promise<string | null> {
    const file = await readCredentialFile(this.path);
    return file.defaultUtilityModels[provider] ?? null;
  }

  /** Persist or clear the default utility model for a provider. */
  async setDefaultUtilityModel(provider: string, model: string | null): Promise<void> {
    await this.update((file) => {
      file.defaultUtilityModels ??= {};
      if (model) {
        file.defaultUtilityModels[provider] = model;
      } else {
        delete file.defaultUtilityModels[provider];
      }
    });
  }

  /** Get the persisted default effort level. */
  async getDefaultEffort(): Promise<string | null> {
    const file = await readCredentialFile(this.path);
    return file.defaultEffort ?? null;
  }

  /** Persist the default effort level. */
  async setDefaultEffort(effort: string): Promise<void> {
    await this.update((file) => {
      file.defaultEffort = effort;
    });
  }

  /** Check if any providers are configured. */
  async hasProviders(): Promise<boolean> {
    const file = await readCredentialFile(this.path);
    return Object.keys(file.providers).length > 0;
  }

  // -------------------------------------------------------------------------
  // pi-ai's CredentialStore
  // -------------------------------------------------------------------------

  /** A provider's stored credential in pi's shape. Custom endpoints have none. */
  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return toCredential(await this.getProvider(providerId));
  }

  /** Providers with a stored pi credential, without exposing any secret. */
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const file = await readCredentialFile(this.path);
    return Object.entries(file.providers).flatMap(([providerId, entry]): CredentialInfo[] => {
      if (entry.method === 'oauth') return [{ providerId, type: 'oauth' }];
      if (entry.method === 'api_key') return [{ providerId, type: 'api_key' }];
      return [];
    });
  }

  /**
   * The only write path pi uses: read, transform, and write one provider's
   * credential under the file lock. pi refreshes an OAuth token inside `fn`
   * after checking again that it still needs one, so a refresh another
   * process just finished is reused instead of repeated.
   */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return withFileLock(this.path, async () => {
      const file = await readCredentialFile(this.path);
      const existing = await withKeychainKey(providerId, file.providers[providerId]);
      const current = toCredential(existing);
      const next = await fn(current);
      if (next === undefined) return current;
      file.providers[providerId] = await storeKeyInKeychain(providerId, fromCredential(providerId, next, existing));
      await writeCredentialFile(this.path, file);
      return next;
    }, options?.signal);
  }

  /** Remove a provider's credential (pi's logout). */
  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.removeProvider(providerId);
  }

  private async update(change: (file: CredentialFile) => void): Promise<void> {
    await withFileLock(this.path, async () => {
      const file = await readCredentialFile(this.path);
      change(file);
      await writeCredentialFile(this.path, file);
    });
  }
}

/** The entry with its API key filled in from the Keychain when the file has none. */
async function withKeychainKey(providerId: string, entry: CredentialEntry | undefined): Promise<CredentialEntry | null> {
  if (!entry) return null;
  if (entry.method === 'api_key' && !entry.apiKey) {
    const keychainKey = await keychainGet(providerId);
    if (keychainKey) return { ...entry, apiKey: keychainKey };
  }
  return entry;
}

/** The entry as written to the file: an API key moves to the Keychain when it can. */
async function storeKeyInKeychain(providerId: string, entry: CredentialEntry): Promise<CredentialEntry> {
  const stored: CredentialEntry = { ...entry };
  if (entry.method === 'api_key' && entry.apiKey && await keychainSet(providerId, entry.apiKey)) {
    // Key is in Keychain, don't store in plaintext file
    delete stored.apiKey;
  }
  return stored;
}

/** A stored entry as pi's credential. */
function toCredential(entry: CredentialEntry | null): Credential | undefined {
  if (!entry) return undefined;
  if (entry.method === 'oauth' && entry.oauthCredentials) {
    try {
      const parsed = JSON.parse(entry.oauthCredentials) as Record<string, unknown>;
      return { ...parsed, type: 'oauth' } as Credential;
    } catch {
      return undefined;
    }
  }
  if (entry.method === 'api_key' && entry.apiKey) return { type: 'api_key', key: entry.apiKey };
  return undefined;
}

/** pi's credential as a stored entry, keeping the existing entry's own fields. */
function fromCredential(providerId: string, credential: Credential, existing: CredentialEntry | null): CredentialEntry {
  const base: CredentialEntry = existing ?? { provider: providerId, method: credential.type, addedAt: Date.now() };
  if (credential.type === 'oauth') {
    const { apiKey: _apiKey, ...rest } = base;
    return {
      ...rest,
      method: 'oauth',
      oauthCredentials: JSON.stringify(credential),
      oauthMeta: {
        ...base.oauthMeta,
        expiresAt: credential.expires,
        refreshable: Boolean(credential.refresh),
      },
    };
  }
  const { oauthCredentials: _oauth, oauthMeta: _meta, ...rest } = base;
  return { ...rest, method: 'api_key', ...(credential.key ? { apiKey: credential.key } : {}) };
}
