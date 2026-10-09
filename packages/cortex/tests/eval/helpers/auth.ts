/**
 * Eval Authentication System
 *
 * Handles API key resolution for eval tests with auto-caching OAuth.
 * Provider-agnostic: supports any pi-ai provider, defaulting to Anthropic.
 *
 * Resolution order:
 *   1. Environment variable (e.g., ANTHROPIC_API_KEY)
 *   2. Cached credentials file (.eval-credentials.json)
 *   3. Interactive OAuth flow (opens browser, caches result)
 *
 * The credentials file is gitignored and stored in the cortex package root.
 * It backs ProviderManager's credential store: a login writes to it, and
 * an expiring OAuth token is refreshed and written back on later runs. If
 * the refresh token has expired, the interactive flow runs again.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { ProviderManager } from '../../../src/provider-manager.js';

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export interface EvalProviderConfig {
  /** Pi-ai provider identifier. */
  provider: string;
  /** Default model ID for evals (cheapest capable model). */
  modelId: string;
  /** Environment variable name for direct API key. */
  envVar: string;
  /** Whether this provider supports OAuth. */
  supportsOAuth: boolean;
}

/**
 * Registry of providers available for evals.
 * Add new providers here to expand eval coverage.
 */
export const EVAL_PROVIDER_CONFIGS: Record<string, EvalProviderConfig> = {
  anthropic: {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    envVar: 'ANTHROPIC_API_KEY',
    supportsOAuth: true,
  },
  // Future providers can be added here:
  // openai: { provider: 'openai', modelId: 'gpt-4.1-nano', envVar: 'OPENAI_API_KEY', supportsOAuth: false },
  // google: { provider: 'google', modelId: 'gemini-2.5-flash-lite', envVar: 'GEMINI_API_KEY', supportsOAuth: false },
};

/** The default provider used for evals. */
export const DEFAULT_EVAL_PROVIDER = 'anthropic';

// ---------------------------------------------------------------------------
// Credentials cache
// ---------------------------------------------------------------------------

/** Path to the credentials cache file (cortex package root). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.resolve(__dirname, '..', '..', '..', '.eval-credentials.json');

interface CachedProviderCredentials {
  type: 'oauth' | 'api_key';
  /** Serialized OAuth credential (pi's OAuthCredential as JSON). */
  oauthCredentials?: string;
  /** Direct API key (only for type: 'api_key'). */
  apiKey?: string;
  /** Timestamp of last successful use. */
  lastUsed?: number;
}

interface CredentialsCache {
  [provider: string]: CachedProviderCredentials;
}

function loadCredentialsCache(): CredentialsCache {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
      return JSON.parse(raw) as CredentialsCache;
    }
  } catch {
    // Corrupt file, start fresh
  }
  return {};
}

function saveCredentialsCache(cache: CredentialsCache): void {
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// OAuth through Cortex's ProviderManager
// ---------------------------------------------------------------------------

/** A cached entry as pi's credential, or undefined when it holds none. */
function toCredential(entry: CachedProviderCredentials | undefined): Credential | undefined {
  if (entry?.type === 'api_key' && entry.apiKey) return { type: 'api_key', key: entry.apiKey };
  if (entry?.type === 'oauth' && entry.oauthCredentials) {
    // Spread first so a cached blob cannot change the credential's type.
    return { ...(JSON.parse(entry.oauthCredentials) as object), type: 'oauth' } as Credential;
  }
  return undefined;
}

function toCacheEntry(credential: Credential): CachedProviderCredentials {
  return credential.type === 'oauth'
    ? { type: 'oauth', oauthCredentials: JSON.stringify(credential), lastUsed: Date.now() }
    : { type: 'api_key', ...(credential.key ? { apiKey: credential.key } : {}), lastUsed: Date.now() };
}

/**
 * The credentials file as pi's CredentialStore. ProviderManager refreshes an
 * expiring OAuth token inside `modify`, so a rotation lands in the file.
 * There is no cross-process lock: an eval run is one process.
 */
class EvalCredentialStore implements CredentialStore {
  async read(providerId: string): Promise<Credential | undefined> {
    return toCredential(loadCredentialsCache()[providerId]);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(loadCredentialsCache()).flatMap(([providerId, entry]): CredentialInfo[] => {
      const credential = toCredential(entry);
      return credential ? [{ providerId, type: credential.type }] : [];
    });
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const cache = loadCredentialsCache();
    const current = toCredential(cache[providerId]);
    const next = await fn(current);
    if (next === undefined) return current;
    cache[providerId] = toCacheEntry(next);
    saveCredentialsCache(cache);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    const cache = loadCredentialsCache();
    delete cache[providerId];
    saveCredentialsCache(cache);
  }
}

let providerManager: ProviderManager | null = null;

/** Evals use the OAuth surface Cortex consumers use, over the credentials file. */
function getProviderManager(): ProviderManager {
  providerManager ??= new ProviderManager({ credentials: new EvalCredentialStore() });
  return providerManager;
}

/** The API key a stored credential yields, refreshing an expiring OAuth token first. */
async function storedApiKey(provider: string): Promise<string | undefined> {
  return (await getProviderManager().getAuth(provider))?.apiKey;
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/** In-memory cache of resolved API keys (avoids re-resolving per test). */
const resolvedKeys = new Map<string, string>();

/**
 * Resolve an API key for the given provider.
 *
 * Resolution order:
 *   1. In-memory cache (from earlier in this test run)
 *   2. Environment variable
 *   3. Cached OAuth credentials (auto-refreshed)
 *   4. Interactive OAuth flow (opens browser)
 *
 * @param providerName - Provider key from EVAL_PROVIDER_CONFIGS (default: 'anthropic')
 * @returns The API key string
 * @throws Error if no key could be resolved
 */
export async function resolveEvalApiKey(providerName: string = DEFAULT_EVAL_PROVIDER): Promise<string> {
  // 1. In-memory cache
  const cached = resolvedKeys.get(providerName);
  if (cached) return cached;

  const config = EVAL_PROVIDER_CONFIGS[providerName];
  if (!config) {
    throw new Error(`Unknown eval provider: "${providerName}". Known: ${Object.keys(EVAL_PROVIDER_CONFIGS).join(', ')}`);
  }

  // 2. Environment variable
  const envKey = process.env[config.envVar];
  if (envKey && envKey.length > 0) {
    resolvedKeys.set(providerName, envKey);
    return envKey;
  }

  // 3. Cached credentials (an OAuth token is refreshed if it is expiring)
  if (loadCredentialsCache()[config.provider]) {
    try {
      const apiKey = await storedApiKey(config.provider);
      if (apiKey) {
        resolvedKeys.set(providerName, apiKey);
        return apiKey;
      }
    } catch (err) {
      console.log(`  Cached OAuth credentials expired or invalid: ${err instanceof Error ? err.message : String(err)}`);
      console.log('  Falling through to interactive login...');
    }
  }

  // 4. Interactive OAuth login
  if (!config.supportsOAuth) {
    throw new Error(
      `No API key found for "${providerName}". ` +
      `Set ${config.envVar} environment variable, or add an api_key entry to ${CREDENTIALS_PATH}.`
    );
  }

  console.log(`\n  No credentials found for ${providerName}. Starting OAuth login...`);
  const apiKey = await runInteractiveOAuth(config.provider);
  resolvedKeys.set(providerName, apiKey);
  return apiKey;
}

/**
 * Check if credentials are already available for a provider.
 * Used for test skipping decisions in non-interactive contexts.
 *
 * Returns true ONLY if credentials exist right now (env var or cached file).
 * Does NOT return true just because OAuth is available, since OAuth requires
 * user interaction. Use canRunEvals() if you want to include OAuth capability.
 */
export function hasEvalCredentials(providerName: string = DEFAULT_EVAL_PROVIDER): boolean {
  const config = EVAL_PROVIDER_CONFIGS[providerName];
  if (!config) return false;

  // Check env var
  const envKey = process.env[config.envVar];
  if (envKey && envKey.length > 0) return true;

  // Check cached credentials file
  const credCache = loadCredentialsCache();
  const providerCreds = credCache[config.provider];
  if (providerCreds) return true;

  return false;
}

/**
 * Check if evals can potentially run (credentials available OR OAuth is possible).
 * Use this when you want to include interactive OAuth as an option.
 */
export function canRunEvals(providerName: string = DEFAULT_EVAL_PROVIDER): boolean {
  if (hasEvalCredentials(providerName)) return true;

  const config = EVAL_PROVIDER_CONFIGS[providerName];
  return !!config?.supportsOAuth;
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

/** Log in through the browser; the login writes its credential to the credentials file. */
async function runInteractiveOAuth(provider: string): Promise<string> {
  const manager = getProviderManager();
  console.log('');

  await manager.initiateOAuth(provider, {
    onAuth: ({ url, instructions }) => {
      console.log('  ╔══════════════════════════════════════════════════╗');
      console.log('  ║  OAuth Authorization Required                   ║');
      console.log('  ╠══════════════════════════════════════════════════╣');
      if (instructions) {
        console.log(`  ║  ${instructions}`);
      }
      console.log(`  ║  URL: ${url}`);
      console.log('  ╚══════════════════════════════════════════════════╝');
      console.log('');

      // Try to open the URL in the default browser
      try {
        if (process.platform === 'darwin') {
          execSync(`open "${url}"`, { stdio: 'ignore' });
          console.log('  Browser opened automatically.');
        } else if (process.platform === 'linux') {
          execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
        }
      } catch {
        console.log('  Please open the URL above in your browser.');
      }
      console.log('  Waiting for authorization...\n');
    },
    // Anthropic asks for a login method first; evals always use the browser.
    onSelect: async (prompt) => prompt.options.find(option => option.id === 'browser')?.id ?? prompt.options[0]?.id,
    onPrompt: async (prompt: { message: string }) => {
      console.log(`  Prompt: ${prompt.message}`);
      return '';
    },
    // pi races this prompt against the browser callback, and an answer ends
    // the race: resolving with '' would abandon the callback and fail the
    // login. Never answer; the callback wins.
    onManualCodeInput: () => new Promise<string>(() => {}),
    onProgress: (message: string) => {
      console.log(`  ${message}`);
    },
  });

  const apiKey = await storedApiKey(provider);
  if (!apiKey) throw new Error(`OAuth login for "${provider}" stored no credential that yields an API key`);
  console.log('  OAuth login successful! Credentials cached.\n');
  return apiKey;
}

// ---------------------------------------------------------------------------
// Manual credential management
// ---------------------------------------------------------------------------

/**
 * Store a plain API key in the credentials cache.
 * Useful for providers that don't support OAuth.
 *
 * @param provider - Provider key from EVAL_PROVIDER_CONFIGS
 * @param apiKey - The API key to store
 */
export function storeApiKey(provider: string, apiKey: string): void {
  const cache = loadCredentialsCache();
  cache[provider] = { type: 'api_key', apiKey, lastUsed: Date.now() };
  saveCredentialsCache(cache);
}

/**
 * Clear cached credentials for a provider (or all providers).
 */
export function clearCredentials(provider?: string): void {
  if (provider) {
    const cache = loadCredentialsCache();
    delete cache[provider];
    saveCredentialsCache(cache);
  } else {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      fs.unlinkSync(CREDENTIALS_PATH);
    }
  }
}

/**
 * Get the path to the credentials cache file.
 */
export function getCredentialsPath(): string {
  return CREDENTIALS_PATH;
}
