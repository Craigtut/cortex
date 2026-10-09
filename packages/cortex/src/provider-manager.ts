/**
 * ProviderManager: standalone class wrapping pi-ai for provider discovery,
 * OAuth login/refresh, API key validation, model resolution, and custom
 * endpoint creation.
 *
 * ProviderManager and AgentLoop are fully independent. Neither knows
 * about the other. The consumer creates both, uses ProviderManager for
 * auth/discovery, and provides a getApiKey callback to AgentLoop.
 *
 * The class is the public surface only. Each capability lives in its own
 * module under provider-manager/ (pi-ai loading, OAuth contract, callback
 * page shim, OAuth flows, model catalog, API key validation, model
 * creation), and this file re-exports their public types.
 *
 * Reference: provider-manager.md
 */

import {
  PROVIDER_REGISTRY,
  OAUTH_PROVIDER_IDS,
} from './provider-registry.js';
import type { ProviderInfo, ModelInfo } from './provider-registry.js';
import type { CortexModel } from './model-wrapper.js';
import type { OllamaModelConfig } from './providers/ollama/runtime.js';
import type {
  OAuthCallbacks,
  OAuthResult,
} from './provider-manager/oauth-types.js';
import { OAUTH_CALLBACK_ROUTES } from './provider-manager/oauth-callback-page.js';
import type { OAuthCallbackRoute } from './provider-manager/oauth-callback-page.js';
import { OAuthFlows } from './provider-manager/oauth-flows.js';
import type { CredentialStore, ModelAuth } from '@earendil-works/pi-ai';
import { authContextFor, ModelRuntime } from './model-runtime.js';
import { listProviderModels } from './provider-manager/model-catalog.js';
import { validateProviderApiKey } from './provider-manager/api-key-validation.js';
import type { ApiKeyValidationResult } from './provider-manager/api-key-validation.js';
import {
  createCustomModel,
  createOllamaModel,
  resolveCatalogModel,
} from './provider-manager/model-factory.js';
import type { CustomModelConfig } from './provider-manager/model-factory.js';

export { OAuthError } from './provider-manager/oauth-types.js';
export type {
  OAuthFlowType,
  OAuthAuthInfo,
  OAuthPromptInfo,
  OAuthCallbacks,
  OAuthCallbackPageStatus,
  OAuthCallbackPageContext,
  OAuthCallbackPageRenderer,
  OAuthMeta,
  OAuthResult,
  OAuthErrorCode,
} from './provider-manager/oauth-types.js';
export type { OAuthCallbackRoute } from './provider-manager/oauth-callback-page.js';
export type {
  ApiKeyValidationResult,
  ApiKeyValidationStatus,
} from './provider-manager/api-key-validation.js';
export type { CustomModelConfig } from './provider-manager/model-factory.js';

// ---------------------------------------------------------------------------
// IProviderManager interface
// ---------------------------------------------------------------------------

/**
 * Interface for provider management operations.
 * Consumers can mock this for testing.
 */
export interface IProviderManager {
  // Discovery
  listProviders(): ProviderInfo[];
  listOAuthProviders(): string[];
  listModels(provider: string): Promise<ModelInfo[]>;

  // OAuth
  initiateOAuth(provider: string, callbacks: OAuthCallbacks): Promise<OAuthResult>;
  cancelOAuth(): void;

  // Stored credentials
  getAuth(provider: string): Promise<ModelAuth | undefined>;
  logout(provider: string): Promise<void>;

  // API Key
  validateApiKey(provider: string, apiKey: string): Promise<ApiKeyValidationResult>;
  checkEnvApiKey(provider: string): string | null;

  // Model Resolution
  resolveModel(provider: string, modelId: string): Promise<CortexModel>;
  createCustomModel(config: CustomModelConfig): Promise<CortexModel>;
  createOllamaModel(config: OllamaModelConfig): Promise<CortexModel>;
}

// ---------------------------------------------------------------------------
// ProviderManager implementation
// ---------------------------------------------------------------------------

/**
 * Construction options for {@link ProviderManager}. Production consumers
 * pass `credentials` (and `ambientCredentials` to opt into env vars);
 * `oauthCallbackRoutes` is a testing seam.
 */
export interface ProviderManagerOptions {
  /**
   * Override the preferred loopback OAuth callback routes (provider ->
   * path/port), which seed the callback-page shim's path match before the
   * authorization URL names the real callback.
   */
  oauthCallbackRoutes?: Record<string, OAuthCallbackRoute> | undefined;
  /**
   * Where provider credentials live: pi's `CredentialStore`, keyed by
   * provider id (`read`, `list`, `modify`, `delete`). `initiateOAuth()`
   * stores the credential it obtains, and `getAuth()` reads and refreshes
   * it under the store's lock, so concurrent requests (a duplex talker,
   * reasoner, and utility calls) refresh a rotating token once. In memory
   * by default; implement it over your own storage, with a cross-process
   * lock in `modify` where several processes share it.
   */
  credentials?: CredentialStore | undefined;
  /**
   * Let `getAuth()` fall back to ambient credentials (provider env vars,
   * Anthropic workload identity federation, AWS profiles, gcloud ADC) for a
   * provider with nothing stored. Default false.
   */
  ambientCredentials?: boolean | undefined;
}

export class ProviderManager implements IProviderManager {
  private readonly oauth: OAuthFlows;
  private readonly credentials: CredentialStore | undefined;
  private readonly ambientCredentials: boolean;
  private modelRuntime: ModelRuntime | null = null;

  constructor(options: ProviderManagerOptions = {}) {
    this.credentials = options.credentials;
    this.ambientCredentials = options.ambientCredentials === true;
    this.oauth = new OAuthFlows({
      routes: options.oauthCallbackRoutes ?? OAUTH_CALLBACK_ROUTES,
      runtime: () => this.runtime(),
    });
  }

  /**
   * This manager's pi providers over its credential store. Built on first
   * use: it registers every built-in provider.
   */
  private runtime(): ModelRuntime {
    this.modelRuntime ??= new ModelRuntime(authContextFor(this.ambientCredentials), this.credentials);
    return this.modelRuntime;
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  /**
   * List all known providers with their metadata.
   */
  listProviders(): ProviderInfo[] {
    return PROVIDER_REGISTRY;
  }

  /**
   * List provider IDs that support OAuth authentication.
   */
  listOAuthProviders(): string[] {
    return OAUTH_PROVIDER_IDS;
  }

  /**
   * List models available from a provider.
   * Delegates to pi-ai's getModels().
   *
   * @param provider - Provider identifier
   * @returns Array of ModelInfo
   * @throws Error if pi-ai is not installed
   */
  async listModels(provider: string): Promise<ModelInfo[]> {
    return listProviderModels(provider);
  }

  // -----------------------------------------------------------------------
  // OAuth
  // -----------------------------------------------------------------------

  /**
   * Initiate an OAuth login flow for a provider.
   *
   * @param provider - OAuth provider identifier
   * @param callbacks - UI callbacks for auth URL, prompts, and progress
   * @returns The OAuth credentials and display metadata
   * @throws {OAuthError} `unsupported_provider`, `callback_port_in_use`,
   *   `cancelled`, `timed_out`, or `callback_failed`. Other errors (e.g.
   *   network/token-exchange failures from pi-ai) propagate as-is.
   */
  async initiateOAuth(provider: string, callbacks: OAuthCallbacks): Promise<OAuthResult> {
    return this.oauth.initiate(provider, callbacks);
  }

  /**
   * Cancel any in-progress OAuth flow.
   */
  cancelOAuth(): void {
    this.oauth.cancel();
  }

  /**
   * Provider ids whose installed pi definition ships an OAuth flow.
   *
   * Read from pi rather than from Cortex's static list, so a provider pi
   * gains OAuth for becomes available without a Cortex release. Falls back to
   * the static list if pi cannot be loaded.
   */
  async listOAuthCapableProviders(): Promise<string[]> {
    return this.oauth.listCapableProviders();
  }

  // -----------------------------------------------------------------------
  // Stored credentials
  // -----------------------------------------------------------------------

  /**
   * Request auth for a provider from the credential store: the key, auth
   * headers, and base URL its stored credential yields, refreshing an
   * expiring OAuth token first under the store's lock. Undefined when
   * nothing is stored (and, without `ambientCredentials`, nothing else is
   * consulted). Rejects when a refresh fails; the credential is kept for a
   * new login. Shaped for AgentLoopConfig.getAuth.
   */
  async getAuth(provider: string): Promise<ModelAuth | undefined> {
    return (await this.runtime().models.getAuth(provider))?.auth;
  }

  /** Remove a provider's stored credential. */
  async logout(provider: string): Promise<void> {
    await this.runtime().models.logout(provider);
  }

  // -----------------------------------------------------------------------
  // API Key
  // -----------------------------------------------------------------------

  /**
   * Validate an API key by making a minimal LLM call (maxTokens: 1).
   *
   * @param provider - The provider to validate against
   * @param apiKey - The API key to validate
   * @returns True if the key is valid, false otherwise
   * @throws Error if pi-ai is not installed
   */
  async validateApiKey(provider: string, apiKey: string): Promise<ApiKeyValidationResult> {
    return validateProviderApiKey(provider, apiKey);
  }

  /**
   * Check whether a provider's API key is available in environment variables.
   *
   * @param provider - The provider to check
   * @returns The API key if found, null otherwise
   */
  checkEnvApiKey(provider: string): string | null {
    const entry = PROVIDER_REGISTRY.find(p => p.id === provider);
    if (entry?.envVar) {
      const value = process.env[entry.envVar];
      if (value && value.length > 0) return value;
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Model Resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve a provider + model ID into a CortexModel.
   *
   * Only resolves models that pi-ai ships a definition for. For custom or
   * keyless OpenAI-compatible endpoints pi-ai does not know about, use
   * {@link createCustomModel} instead.
   *
   * @param provider - The provider identifier
   * @param modelId - The model identifier
   * @returns A CortexModel handle
   * @throws Error if pi-ai is not installed
   * @throws Error if the provider/model is unknown to pi-ai
   */
  async resolveModel(provider: string, modelId: string): Promise<CortexModel> {
    return resolveCatalogModel(provider, modelId);
  }

  /**
   * Create a custom model for an OpenAI-compatible endpoint.
   *
   * @param config - Custom model configuration
   * @returns A CortexModel handle
   * @throws Error if pi-ai is not installed
   */
  async createCustomModel(config: CustomModelConfig): Promise<CortexModel> {
    return createCustomModel(config);
  }

  /** Resolve the selected local model's capabilities and actual runtime allocation. */
  async createOllamaModel(config: OllamaModelConfig): Promise<CortexModel> {
    return createOllamaModel(config);
  }
}
