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
 * OAuth credentials are auto-refreshed on subsequent runs. If the refresh
 * token expires, the interactive flow runs again.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
  /** Serialized OAuth credentials blob (opaque, for getOAuthApiKey). */
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

/**
 * pi-ai 0.80 removed the global OAuth helpers this file used to import from
 * `@earendil-works/pi-ai/oauth` (`getOAuthProvider`, `getOAuthApiKey`); the
 * subpath now exports types only. Evals go through ProviderManager, the
 * same OAuth surface Cortex consumers use.
 */
let providerManager: ProviderManager | null = null;

function getProviderManager(): ProviderManager {
  providerManager ??= new ProviderManager();
  return providerManager;
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

  // 3. Cached OAuth credentials
  const credCache = loadCredentialsCache();
  const providerCreds = credCache[config.provider];

  if (providerCreds) {
    if (providerCreds.type === 'api_key' && providerCreds.apiKey) {
      resolvedKeys.set(providerName, providerCreds.apiKey);
      return providerCreds.apiKey;
    }

    if (providerCreds.type === 'oauth' && providerCreds.oauthCredentials) {
      try {
        const apiKey = await refreshOAuthKey(config.provider, providerCreds.oauthCredentials);
        if (apiKey) {
          providerCreds.lastUsed = Date.now();
          saveCredentialsCache(credCache);
          resolvedKeys.set(providerName, apiKey.key);
          // Update cached credentials if they were refreshed
          if (apiKey.updatedCredentials) {
            providerCreds.oauthCredentials = apiKey.updatedCredentials;
            saveCredentialsCache(credCache);
          }
          return apiKey.key;
        }
      } catch (err) {
        console.log(`  Cached OAuth credentials expired or invalid: ${err instanceof Error ? err.message : String(err)}`);
        console.log('  Falling through to interactive login...');
      }
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
  const result = await runInteractiveOAuth(config.provider);

  // Cache the credentials
  credCache[config.provider] = {
    type: 'oauth',
    oauthCredentials: result.credentials,
    lastUsed: Date.now(),
  };
  saveCredentialsCache(credCache);

  resolvedKeys.set(providerName, result.apiKey);
  return result.apiKey;
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

interface RefreshResult {
  key: string;
  updatedCredentials?: string;
}

async function refreshOAuthKey(provider: string, credentials: string): Promise<RefreshResult | null> {
  const result = await getProviderManager().resolveOAuthApiKey(provider, credentials);
  return result.changed
    ? { key: result.apiKey, updatedCredentials: result.credentials }
    : { key: result.apiKey };
}

interface OAuthLoginResult {
  apiKey: string;
  credentials: string;
}

async function runInteractiveOAuth(provider: string): Promise<OAuthLoginResult> {
  const manager = getProviderManager();
  console.log('');

  const login = await manager.initiateOAuth(provider, {
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

  const keyResult = await manager.resolveOAuthApiKey(provider, login.credentials);
  console.log('  OAuth login successful! Credentials cached.\n');

  return {
    apiKey: keyResult.apiKey,
    credentials: keyResult.credentials,
  };
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
