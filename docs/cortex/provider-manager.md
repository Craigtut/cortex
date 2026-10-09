# Provider Manager

> **STATUS: IMPLEMENTED**

The `ProviderManager` is a standalone class in `@animus-labs/cortex` that wraps `pi-ai`'s provider registry, model resolution, and OAuth flows into a clean, typed API. It is the sole boundary through which consumers interact with pi-ai's provider ecosystem. Consumers never import `@earendil-works/pi-ai` directly.

## Why It Exists

Pi-ai provides powerful multi-provider support: 20+ providers, automatic model discovery, OAuth login flows, token refresh, custom model creation, and environment variable detection. But pi-ai is a low-level library with multiple entry points (`@earendil-works/pi-ai`, `@earendil-works/pi-ai/oauth`), provider-specific login functions, and raw credential objects.

ProviderManager wraps all of this into a single, typed interface that:

- Gives consumers one import for all provider concerns
- Normalizes pi-ai's provider-specific types into Cortex's own stable types
- Keeps pi-ai as an internal implementation detail of Cortex
- Provides an interface (`IProviderManager`) for testing and alternative implementations

## Relationship to AgentLoop

ProviderManager and AgentLoop are **fully independent**. Neither knows about the other. They exist as separate exports from `@animus-labs/cortex`.

```
@animus-labs/cortex
├── ProviderManager    (discovery, auth, model resolution)
├── AgentLoop        (agentic loop, tools, context, skills)
└── pi-ai / pi-agent-core (internal, not exposed)
```

**Why independent:**

1. **Lifecycle mismatch.** ProviderManager is needed during onboarding (before any agent exists) for provider discovery and OAuth flows. AgentLoop is created later, after credentials are confirmed and persona is set up. They have different creation times.

2. **The consumer wires them.** The consumer creates both, uses ProviderManager for auth/discovery, and provides a `getApiKey` callback to AgentLoop. The callback is the only connection, and the consumer owns it.

3. **Testability.** Each can be tested and mocked independently.

## Interface

```typescript
// packages/cortex/src/provider-manager.ts

interface IProviderManager {
  // ── Discovery ──
  listProviders(): ProviderInfo[];
  listOAuthProviders(): string[];
  listModels(provider: string): Promise<ModelInfo[]>;

  // ── OAuth ──
  initiateOAuth(provider: string, callbacks: OAuthCallbacks): Promise<OAuthResult>; // one flow at a time
  cancelOAuth(): void;

  // ── Stored credentials ──
  getAuth(provider: string): Promise<ModelAuth | undefined>;
  logout(provider: string): Promise<void>;

  // ── API Key ──
  validateApiKey(provider: string, apiKey: string): Promise<ApiKeyValidationResult>;
  checkEnvApiKey(provider: string): string | null;

  // ── Model Resolution ──
  resolveModel(provider: string, modelId: string): Promise<CortexModel>;
  createCustomModel(config: CustomModelConfig): Promise<CortexModel>;
}
```

## Types

### Provider Discovery

```typescript
type AuthMethod = 'oauth' | 'api_key';

interface ProviderInfo {
  /** Provider identifier (e.g., 'anthropic', 'openai', 'google') */
  id: string;
  /** Human-readable name (e.g., 'Anthropic', 'OpenAI') */
  name: string;
  /** Supported authentication methods */
  authMethods: AuthMethod[];
  /** Environment variable name for API key (e.g., 'ANTHROPIC_API_KEY') */
  envVar?: string;
  /** API key prefix for client-side type inference (e.g., 'sk-ant-') */
  keyPrefix?: string;
  /** URL where users obtain API keys */
  keyUrl?: string;
}
```

Provider metadata is assembled from pi-ai's registry and augmented with UX-relevant fields (keyPrefix, keyUrl) that pi-ai doesn't provide. These are maintained in a static map within ProviderManager.

### Model Discovery

```typescript
interface ModelInfo {
  /** Model identifier (e.g., 'claude-sonnet-4-20250514') */
  id: string;
  /** Human-readable name (e.g., 'Claude Sonnet 4') */
  name: string;
  /** Context window size in tokens */
  contextWindow: number;
  /** Whether the model supports extended thinking */
  supportsThinking: boolean;
  /** Thinking levels supported by this model, using Cortex public names */
  supportedThinkingLevels: Array<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'max'>;
  /** Whether the model supports image input */
  supportsImages: boolean;
  /** Pricing per million tokens (if available) */
  pricing?: { input: number; output: number };
}
```

Model metadata is derived from pi-ai's model registry. Pi-ai auto-discovers models from provider APIs and maintains a generated model list with specs.

### CortexModel (Opaque)

```typescript
/**
 * Opaque model handle. The consumer receives this from ProviderManager
 * and passes it to AgentLoop. The consumer never inspects its internals.
 *
 * Internally, this wraps pi-ai's Model<T> type.
 */
type CortexModel = {
  /** @internal */
  readonly __brand: 'CortexModel';
  /** Provider identifier */
  readonly provider: string;
  /** Model identifier */
  readonly modelId: string;
  /** Context window size */
  readonly contextWindow: number;
  /** What Cortex knows about the backend (prompt caching, structured output, concurrency) */
  readonly capabilities?: ModelCapabilities;
};

type ModelConcurrency = 'parallel' | 'serial' | 'unknown';
```

The consumer can read `provider`, `modelId`, and `contextWindow` for display and configuration purposes.

`capabilities.concurrency` says whether the backend serves a request while another is in flight, which decides the default `CortexAgent` mode (cortex-agent.md, "Mode resolution"). It is stamped at creation: `resolveModel()` and a direct `wrapModel()` judge by the backend (`parallel` for every provider in pi-ai's catalog, `unknown` for any other id and for any base URL on loopback, a private network or a private-use name, whatever the provider id), `createCustomModel()` is `unknown` (provider `custom`), and `createOllamaModel()` is `serial` unless its config sets `parallelRequests: true`. The underlying pi-ai `Model` object is accessed internally by AgentLoop when constructing the pi-agent-core Agent.

### OAuth

```typescript
type OAuthFlowType = 'browser' | 'localhost_callback' | 'device_code';

interface OAuthAuthInfo {
  url: string;
  instructions?: string;
  flowType: OAuthFlowType;
  deviceCode?: string;
  manualCodeRecommended?: boolean;
  callbackPort?: number;
  callbackPath?: string;
}

interface OAuthPromptInfo {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
}

interface OAuthCallbacks {
  /**
   * Called when the user needs to visit a URL to authorize.
   * The consumer should open the URL in a browser or display it to the user.
   * Cortex normalizes provider-specific details into flow metadata.
   */
  onAuth: (info: OAuthAuthInfo) => void;

  /**
   * Called when the OAuth flow needs user input (e.g., a prompt).
   * The consumer should display the prompt and return the user's response.
   */
  onPrompt: (prompt: OAuthPromptInfo) => Promise<string>;

  /**
   * Called with progress messages during the flow.
   */
  onProgress?: (message: string) => void;

  /**
   * Called when a callback-server OAuth flow needs a manual authorization code.
   */
  onManualCodeInput?: () => Promise<string>;

  /**
   * Called when the OAuth flow needs the user to choose from provider-specific options.
   */
  onSelect?: (prompt: {
    message: string;
    options: Array<{ id: string; label: string }>;
  }) => Promise<string | undefined>;

  /**
   * Optional browser callback page renderer for callback-server OAuth flows.
   * This is a best-effort compatibility shim around pi-ai's internal page.
   */
  renderCallbackPage?: (context: OAuthCallbackPageContext) => string;
}

interface OAuthCallbackPageContext {
  /** Provider identifier, e.g. "anthropic" or "openai-codex". */
  provider: string;
  /** Human-readable provider name when available. */
  providerName: string;
  /** Whether the callback response represents success or failure. */
  status: 'success' | 'error';
  /** Page title extracted from pi-ai's default page. */
  title: string;
  /** Page heading extracted from pi-ai's default page. */
  heading: string;
  /** User-facing message extracted from pi-ai's default page. */
  message: string;
  /** Error details extracted from pi-ai's default page, if present. */
  details?: string;
  /** Callback path matched by the shim, without query parameters. */
  callbackPath: string;
  /** Local callback port matched by the shim. */
  callbackPort: number;
  /** Pi-ai's original generated page. */
  defaultHtml: string;
}

interface OAuthResult {
  /**
   * Serialized credential payload. The login has already written it to the
   * manager's credential store, where getAuth() reads and refreshes it; this
   * copy is for a consumer that files it with metadata of its own.
   *
   * This is a JSON string. Treat it as an opaque blob. Never parse or inspect.
   */
  credentials: string;

  /**
   * Display-safe metadata extracted at login time.
   * The consumer can store this unencrypted for UI display
   * (e.g., "Connected as craig@example.com", "Expires in 4 hours").
   */
  meta: OAuthMeta;
}

interface OAuthMeta {
  /** Provider identifier */
  provider: string;
  /** Display name, email, or account identifier (if available from the provider) */
  displayName?: string;
  /** When the access token expires (Unix timestamp ms). Undefined if non-expiring. */
  expiresAt?: number;
  /** Whether the credential supports automatic refresh */
  refreshable: boolean;
}
```

### Custom Models

```typescript
interface CustomModelConfig {
  /** Base URL of the OpenAI-compatible API (e.g., 'http://localhost:11434/v1') */
  baseUrl: string;
  /** Model identifier to send in API requests */
  modelId: string;
  /** Context window size (default: 128,000) */
  contextWindow?: number;
  /**
   * The endpoint's API key, sent when the agent's getAuth or getApiKey returns
   * no key for the 'custom' provider. Omit it for a keyless local server; a
   * placeholder is sent, since OpenAI-compatible clients require a key.
   */
  apiKey?: string;
  /** Compatibility settings for non-standard servers */
  compat?: {
    /** Whether the server supports the 'developer' role (default: true) */
    supportsDeveloperRole?: boolean;
    /** Whether the server supports reasoning_effort (default: true) */
    supportsReasoningEffort?: boolean;
  };
}
```

### API Key Validation

```typescript
type ApiKeyValidationStatus =
  | 'valid'
  | 'invalid_credentials'
  | 'transient_error'
  | 'resolution_error';

interface ApiKeyValidationResult {
  provider: string;
  modelId: string | null;
  valid: boolean;
  retryable: boolean;
  status: ApiKeyValidationStatus;
  message?: string;
}
```

`validateApiKey()` does not collapse all failures into a single boolean. Consumers can distinguish bad credentials from retryable provider failures and from provider/model resolution errors.

## Implementation

### Default Implementation

A sketch of the behavior. In the source, `ProviderManager` is a thin class that forwards to the modules under `src/provider-manager/` (see Package Structure).

```typescript
// packages/cortex/src/provider-manager.ts

import {
  PROVIDER_REGISTRY,
  OAUTH_PROVIDER_IDS,
  UTILITY_MODEL_DEFAULTS,
} from './provider-registry.js';

// Pi-ai is loaded dynamically via loadPiAi() and loadPiAiOAuth(). Consumers
// never import it directly through Cortex APIs. If pi-ai is unavailable,
// methods that require it throw clear errors.

async function loadPiAi(): Promise<PiAiModule> {
  try {
    const modulePath = '@earendil-works/pi-ai';
    return await import(modulePath) as PiAiModule;
  } catch {
    throw new Error(
      'pi-ai is not installed. Install @earendil-works/pi-ai to use ProviderManager.'
    );
  }
}

async function loadPiAiOAuth(): Promise<PiAiOAuthModule> {
  try {
    const modulePath = '@earendil-works/pi-ai/oauth';
    return await import(modulePath) as PiAiOAuthModule;
  } catch {
    throw new Error(
      'pi-ai is not installed. Install @earendil-works/pi-ai to use OAuth features.'
    );
  }
}

class ProviderManager implements IProviderManager {
  private activeOAuthAbort: AbortController | null = null;

  listProviders(): ProviderInfo[] {
    return PROVIDER_REGISTRY;
  }

  listOAuthProviders(): string[] {
    return OAUTH_PROVIDER_IDS;
  }

  async listModels(provider: string): Promise<ModelInfo[]> {
    const piAi = await loadPiAi();
    const rawModels = piAi.getModels(provider);
    const models = rawModels.map(raw => mapRawToModelInfo(raw, piAi.getSupportedThinkingLevels));

    // Filter pipeline:
    // 1. Remove legacy/deprecated generation models (see LEGACY_MODEL_PREFIXES)
    // 2. Remove "-latest" alias duplicates (keep pinned version if it exists)
    // 3. Remove duplicate display names (first occurrence wins)
    const legacyPrefixes = LEGACY_MODEL_PREFIXES[provider];
    const filtered = legacyPrefixes
      ? models.filter(m => !legacyPrefixes.some(prefix => m.id.startsWith(prefix)))
      : models;

    const seen = new Set<string>();
    return filtered.filter(m => {
      const baseName = m.id.replace(/-latest$/, '');
      if (m.id.endsWith('-latest')) {
        return !filtered.some(other => other.id === baseName);
      }
      if (seen.has(m.name)) return false;
      seen.add(m.name);
      return true;
    });
  }

  async initiateOAuth(provider: string, callbacks: OAuthCallbacks): Promise<OAuthResult> {
    const oauthModule = await loadPiAiOAuth();
    const oauthProvider = oauthModule.getOAuthProvider?.(provider);
    if (!oauthProvider) throw new Error(`Provider "${provider}" does not support OAuth`);

    this.activeOAuthAbort = new AbortController();

    const rawCredentials = await withOAuthCallbackPageShim(
      provider,
      oauthProvider.name,
      callbacks.renderCallbackPage,
      () => oauthProvider.login({
        onAuth: callbacks.onAuth,
        onPrompt: callbacks.onPrompt,
        onProgress: callbacks.onProgress,
        onManualCodeInput: callbacks.onManualCodeInput,
        onSelect: callbacks.onSelect,
        signal: this.activeOAuthAbort.signal,
      }),
    );

    this.activeOAuthAbort = null;

    const credentials = JSON.stringify(rawCredentials);
    const meta = buildOAuthMeta(provider, rawCredentials);

    return { credentials, meta };
  }

  cancelOAuth(): void {
    if (this.activeOAuthAbort) {
      this.activeOAuthAbort.abort();
      this.activeOAuthAbort = null;
    }
  }

  async validateApiKey(
    provider: string,
    apiKey: string,
  ): Promise<ApiKeyValidationResult> {
    const piAi = await loadPiAi();

    // Use the cheapest known model from UTILITY_MODEL_DEFAULTS
    const cheapestModelId = this.getSmallestModelId(provider);
    if (!cheapestModelId) {
      // Fallback: try the first available model from the provider
      const models = piAi.getModels(provider);
      if (models.length === 0) {
        return {
          provider,
          modelId: null,
          valid: false,
          retryable: false,
          status: 'resolution_error',
          message: `No models found for provider "${provider}"`,
        };
      }
      const firstModelId = models[0].id ?? models[0].name;
      return this.tryValidation(piAi, provider, firstModelId, apiKey);
    }

    return this.tryValidation(piAi, provider, cheapestModelId, apiKey);
  }

  checkEnvApiKey(provider: string): string | null {
    // Looks up the provider's envVar from PROVIDER_REGISTRY and checks process.env
    const entry = PROVIDER_REGISTRY.find(p => p.id === provider);
    if (entry?.envVar) {
      const value = process.env[entry.envVar];
      if (value && value.length > 0) return value;
    }
    return null;
  }

  async resolveModel(provider: string, modelId: string): Promise<CortexModel> {
    const piAi = await loadPiAi();
    const piModel = piAi.getModel(provider, modelId);
    return wrapModel(piModel, provider, modelId);
  }

  async createCustomModel(config: CustomModelConfig): Promise<CortexModel> {
    const piAi = await loadPiAi();
    const piModel = createModel({
      baseUrl: config.baseUrl,
      modelId: config.modelId,
      contextWindow: config.contextWindow ?? 128_000,
      compat: config.compat,
    });
    return wrapModel(piModel, 'custom', config.modelId);
  }

  // ── Private helpers ──

  private getSmallestModelId(provider: string): string | null {
    return UTILITY_MODEL_DEFAULTS[provider] ?? null;
  }

  private async tryValidation(
    piAi: PiAiModule,
    provider: string,
    modelId: string,
    apiKey: string,
  ): Promise<ApiKeyValidationResult> {
    try {
      const model = piAi.getModel(provider, modelId);
      const completeFn = piAi.completeSimple ?? piAi.complete;
      await completeFn(model, {
        messages: [{ role: 'user', content: 'hi' }],
      }, { apiKey, maxTokens: 1 });
      return { provider, modelId, valid: true, retryable: false, status: 'valid' };
    } catch (err) {
      return this.classifyValidationError(provider, modelId, err);
    }
  }
}
```

### Provider Registry (Static Metadata)

Pi-ai provides provider and model information programmatically, but some UX-relevant metadata (key prefixes, documentation URLs) is not available from the library. ProviderManager maintains a static registry for this:

```typescript
const PROVIDER_REGISTRY: ProviderInfo[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    authMethods: ['oauth', 'api_key'],
    envVar: 'ANTHROPIC_API_KEY',
    keyPrefix: 'sk-ant-',
    keyUrl: 'console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    authMethods: ['api_key'],
    envVar: 'OPENAI_API_KEY',
    keyPrefix: 'sk-proj-',
    keyUrl: 'platform.openai.com/api-keys',
  },
  {
    id: 'openai-codex',
    name: 'OpenAI Codex',
    authMethods: ['oauth'],
    // No API key; requires ChatGPT Plus/Pro subscription OAuth
  },
  {
    id: 'google',
    name: 'Google',
    authMethods: ['api_key'],
    envVar: 'GEMINI_API_KEY',
    keyUrl: 'aistudio.google.com/apikey',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    authMethods: ['oauth'],
    // Copilot subscription OAuth
  },
  {
    id: 'mistral',
    name: 'Mistral',
    authMethods: ['api_key'],
    envVar: 'MISTRAL_API_KEY',
    keyUrl: 'console.mistral.ai/api-keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    authMethods: ['api_key'],
    envVar: 'GROQ_API_KEY',
    keyUrl: 'console.groq.com/keys',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    authMethods: ['api_key'],
    envVar: 'CEREBRAS_API_KEY',
    keyUrl: 'cloud.cerebras.ai',
  },
  {
    id: 'xai',
    name: 'xAI',
    authMethods: ['api_key'],
    envVar: 'XAI_API_KEY',
    keyUrl: 'console.x.ai',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    authMethods: ['api_key'],
    envVar: 'OPENROUTER_API_KEY',
    keyUrl: 'openrouter.ai/keys',
  },
  // Additional providers can be added as needed
];
```

This registry is maintained manually. When pi-ai adds a new provider, a corresponding entry is added here. Providers not in the registry can still be used via `resolveModel()` and `createCustomModel()` with direct API keys; they just won't appear in the discovery UI.

### OAuth Provider Registry

`ProviderManager.initiateOAuth()` dynamically imports `@earendil-works/pi-ai/oauth` and resolves the provider through pi-ai's OAuth registry. Cortex no longer hardcodes login function names.

```typescript
const oauthModule = await loadPiAiOAuth();
const oauthProvider = oauthModule.getOAuthProvider?.(provider);
if (!oauthProvider) throw new Error(`Provider "${provider}" does not support OAuth`);

const rawCredentials = await oauthProvider.login(callbacks);
```

### OAuth Callback Page Customization

Pi-ai owns the localhost callback server for browser-based OAuth providers. It currently renders its own success and failure HTML without exposing a page hook. `ProviderManager` offers an opt-in `renderCallbackPage` compatibility shim so consumers can brand that final browser page without importing pi-ai or copying provider login flows.

`ProviderManager` also normalizes OAuth callback data before it reaches the consumer. Callback-server providers are marked with `flowType: 'localhost_callback'`, callback port/path metadata, and `manualCodeRecommended: true`; device-code providers are marked with `flowType: 'device_code'` and a parsed `deviceCode` when the provider supplies one in its instructions. Prompt callbacks preserve `placeholder` and `allowEmpty` so remote UIs can render blank-submittable prompts such as GitHub Enterprise domain selection.

The shim is intentionally narrow:

- It only runs when `renderCallbackPage` is provided.
- It matches the loopback callback the authorization URL names (its `redirect_uri` or `callback_url`), on whatever port pi bound: Anthropic's preferred `53692` or the free port it falls back to, OpenRouter's ephemeral port and random path. Before the URL is known it matches the provider's preferred path (Anthropic `/callback`, OpenAI Codex `/auth/callback`).
- It requires a local host header (`localhost`, `127.0.0.1`, or `::1`) and a pi-ai authentication page title.
- It passes only safe page metadata to the renderer. Query parameters such as OAuth `code` and `state` are never exposed.
- It is installed only for the duration of the OAuth login and restored in `finally`.
- It rejects concurrent customized callback-page flows in the same process.

One flow runs per `ProviderManager` at a time. A second `initiateOAuth()` while one is in progress rejects with `OAuthError` code `flow_in_progress` and leaves the first untouched, so `cancelOAuth()` still cancels it. A taken callback port is pi-ai's to handle (Anthropic binds a free port, Codex asks for the pasted redirect URL); a login pi-ai fails with "Port N is in use" rejects with `callback_port_in_use`. Without `onSelect`, a `select` prompt (Anthropic's login method) takes the first option. `onManualCodeInput` receives the prompt's abort signal, which pi aborts when the browser callback wins the race.

GitHub Copilot uses device-code OAuth and does not show a localhost callback page, so this renderer is not used for that provider.

### Display Name Extraction

Different OAuth providers include different identity information in their credentials. ProviderManager extracts the best available display name:

```typescript
function extractDisplayName(credentials: Record<string, unknown>): string | undefined {
  // Try common fields across providers
  if (typeof credentials.email === 'string') return credentials.email;
  if (typeof credentials.accountId === 'string') return credentials.accountId;
  if (typeof credentials.idToken === 'string') {
    // JWT id_token may contain email in payload
    try {
      const payload = JSON.parse(atob(credentials.idToken.split('.')[1]));
      if (payload.email) return payload.email;
    } catch { /* ignore malformed tokens */ }
  }
  return undefined;
}
```

### Legacy Model Filtering

Pi-ai does not flag models as deprecated, so `ProviderManager` maintains a `LEGACY_MODEL_PREFIXES` map to keep the model picker clean. These prefixes identify older model generations that produce poor results with modern tool-use patterns. Models matching any prefix are excluded from `listModels()` results.

```typescript
// packages/cortex/src/provider-manager/model-catalog.ts

const LEGACY_MODEL_PREFIXES: Record<string, string[]> = {
  anthropic: [
    'claude-3-',      // Claude 3.x family (Haiku/Sonnet/Opus from 2024)
    'claude-3.',      // Alternate naming
  ],
  openai: [
    'gpt-3.5-',      // GPT-3.5 family
    'gpt-4-',        // GPT-4 original (not 4o/4.1)
  ],
  google: [
    'gemini-1.',      // Gemini 1.x family
    'gemini-pro',     // Original Gemini Pro
  ],
};
```

The filtering pipeline in `listModels()` applies three steps in sequence:

1. **Remove legacy models**: Any model whose ID starts with a legacy prefix for that provider is excluded.
2. **Remove "-latest" alias duplicates**: If both `model-name` and `model-name-latest` exist, only the pinned version is kept. The `-latest` alias is only included when no pinned version exists.
3. **Remove duplicate display names**: If multiple model IDs share the same display name, only the first occurrence is kept.

Providers not listed in `LEGACY_MODEL_PREFIXES` (e.g., Mistral, Groq) have no filtering applied; all their models pass through unchanged.

## Credential Store

ProviderManager runs on pi-ai's `Models` collection, with every built-in provider plus Cortex's `ollama` and `custom` providers. Pass `credentials`, a pi-ai `CredentialStore` (`read`, `list`, `modify`, `delete`, keyed by provider id), to keep credentials in your own storage; the default is in memory.

- `initiateOAuth()` stores the credential the login obtains, and also returns it as `OAuthResult.credentials` for a consumer that files it with metadata of its own.
- `getAuth(provider)` returns the request auth a stored credential yields (pi's `ModelAuth`: `apiKey`, `headers`, `baseUrl`), which Kimi Coding (a header) and GitHub Copilot (a per-account base URL) need. It refreshes an expiring OAuth token inside the store's `modify`, so concurrent requests refresh a rotating token once. Implement `modify` with a cross-process lock when several processes share the store. It is the only OAuth refresh path: there is no call that refreshes a credential the caller holds outside a store.
- `getAuth` ignores provider env vars and credential files unless `ambientCredentials: true` is passed.

## AgentLoop Integration

AgentLoop receives a `CortexModel` and an optional `getAuth` or `getApiKey` callback. ProviderManager's `getAuth` has the callback's shape, so a consumer that keeps credentials in a store wires `getAuth: (provider) => manager.getAuth(provider)`; the loop and the manager stay independent.

`CortexModel` is the public model boundary for Cortex. Consumers obtain it from `ProviderManager`, store it, and pass it back into `AgentLoop`. Raw pi-ai model objects do not cross the public API boundary.

```typescript
// packages/cortex/src/agent-loop.ts

interface AgentLoopConfig {
  /** Model handle from ProviderManager.resolveModel() */
  model: CortexModel;

  /**
   * Dynamic API key resolver. Called before every LLM call.
   * Enables OAuth token refresh without session teardown.
   * If omitted, requests to providers that need credentials fail, unless
   * `ambientCredentials` lets pi-ai read them from the environment.
   */
  getApiKey?: (provider: string) => Promise<string>;

  /** Let pi-ai resolve env var, federation, AWS profile, and ADC credentials. Default false. */
  ambientCredentials?: boolean;

  // ... tools, contextManager, budgetGuards, etc.
}
```

Internally, AgentLoop unwraps the `CortexModel` once at the Cortex boundary, uses the raw pi-ai model for runtime calls, and passes `getApiKey` through to pi-agent-core:

```typescript
const agent = await AgentLoop.create({
  model,
  getApiKey: (provider) => credService.resolveApiKey(provider),
  initialBasePrompt: 'You are the application agent.',
});

  /**
   * Switch to a different model at runtime.
   * Conversation history is preserved. The getApiKey callback
   * handles the new provider automatically.
   */
agent.setModel(model);
```

## Package Structure

```
packages/cortex/
  src/
    provider-manager.ts       # ProviderManager class (IProviderManager implementation), re-exports public types
    provider-manager/
      pi-ai.ts                # Dynamic pi-ai loading and the pi shapes Cortex reads
      oauth-types.ts          # OAuth contract types and OAuthError
      oauth-callback-page.ts  # Callback page shim and preferred callback routes
      oauth-flows.ts          # OAuthFlows: login race and cancellation
      model-catalog.ts        # listModels mapping and legacy filtering
      api-key-validation.ts   # validateApiKey and its result classification
      model-factory.ts        # resolveModel, createCustomModel, createOllamaModel, CustomModelConfig
    provider-registry.ts      # Static provider metadata (PROVIDER_REGISTRY), ProviderInfo, ModelInfo
    model-wrapper.ts          # CortexModel wrapping/unwrapping utilities
    types.ts                  # AgentLoop config and shared agent/runtime types
```

## Supported Providers

### OAuth Providers

These providers authenticate via browser-based OAuth flows. The user signs in with their existing subscription (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot). No API keys needed.

| Provider | Pi-ai ID | Subscription Required |
|----------|----------|----------------------|
| Anthropic (Claude) | `anthropic` | Claude Pro or Max |
| OpenAI Codex | `openai-codex` | ChatGPT Plus or Pro |
| GitHub Copilot | `github-copilot` | Copilot subscription |
| Meta | `meta` | Muse subscription |
| Radius | `radius` | Radius account |

Google Gemini CLI and Google Antigravity OAuth providers were removed upstream in pi-ai 0.71. Cortex supports Google through the `google` API key provider. Google Vertex can be used by consumers that supply the required Google application credentials to pi-ai.

### API Key Providers

These providers authenticate with a static API key obtained from the provider's console.

| Provider | Pi-ai ID | Environment Variable |
|----------|----------|---------------------|
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Google (Gemini) | `google` | `GEMINI_API_KEY` |
| Mistral | `mistral` | `MISTRAL_API_KEY` |
| Groq | `groq` | `GROQ_API_KEY` |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` |
| xAI | `xai` | `XAI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |
| MiniMax | `minimax` | `MINIMAX_API_KEY` |
| OpenCode | `opencode` | `OPENCODE_API_KEY` |
| OpenCode Go | `opencode-go` | `OPENCODE_API_KEY` |
| Kimi Coding | `kimi-coding` | `KIMI_API_KEY` |
| Meta (Model API) | `meta` | `META_API_KEY` |
| Radius | `radius` | `RADIUS_API_KEY` |
| Amazon Bedrock | `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK` |
| Together | `together` | `TOGETHER_API_KEY` |
| Baseten | `baseten` | `BASETEN_API_KEY` |
| NVIDIA | `nvidia` | `NVIDIA_API_KEY` |
| Ant Ling | `ant-ling` | `ANT_LING_API_KEY` |
| Z.AI Coding CN | `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` |
| Qwen Token Plan | `qwen-token-plan` | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan CN | `qwen-token-plan-cn` | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Qwen Token Plan Individual | `qwen-token-plan-individual` | `QWEN_TOKEN_PLAN_API_KEY` |

Note: Anthropic, Meta, and Radius support both OAuth and API key. They appear in both tables. Amazon Bedrock takes a Bedrock API key (bearer token); pi-ai reads the region from the model's inference profile and otherwise uses `us-east-1`. AWS profiles and the SDK credential chain are not offered, since Cortex never reads credentials from the environment.

The registry lists every provider pi-ai ships; a test fails when a pi-ai upgrade adds one that is missing.

### Default Models

`PRIMARY_MODEL_DEFAULTS` (and `resolveDefaultModelId(provider)`) give the model a provider starts on when none was picked. They are resolved from the installed pi-ai catalog when `model-defaults.ts` loads, not hardcoded: each provider names a model family in `PRIMARY_MODEL_FAMILIES` (Claude Opus for Anthropic, the GPT Sol tier for OpenAI, Grok for xAI, and so on), and the default is the newest version of that family the catalog carries, so a pi-ai release that adds a newer Opus moves the default with no change in Cortex. Providers without a family of their own, the aggregators, take the first family in `FALLBACK_FAMILY_ORDER` they serve (Claude Opus first). A provider serving none of them defaults to its first catalog model. Every resolved default is a model its provider has; a provider with no catalog (Ollama, custom endpoints) has none, and the consumer must supply a model.

### Custom Endpoints

OpenAI-compatible endpoints such as vLLM and LM Studio can be configured via `createCustomModel()`. These require a base URL, model ID, and optional API key. Ollama uses the dedicated `createOllamaModel()` integration.

### Deferred Providers

These providers require complex credential configurations beyond a single API key:

- **Azure OpenAI**: Requires resource name, deployment name, API version, and API key. May be supported under API key entry with additional fields in a future iteration.
- **Google Vertex AI**: Requires project ID, location, and either an API key or Application Default Credentials. May be supported in a future iteration.

## Open Questions

1. **Model list caching**: Should `listModels()` cache results? Pi-ai's model list is generated at build time, not fetched live. If it's static, caching is unnecessary. If pi-ai adds live model discovery, caching would matter.

2. **Provider-specific OAuth notes**: Some providers have quirks (e.g., GitHub Copilot requires enabling models in VS Code first). Should ProviderManager surface these as structured data, or leave them to consumer documentation?

3. **Validation cost**: `validateApiKey()` makes a real LLM call (with `maxTokens: 1`). This costs a tiny amount. Should there be a cheaper validation path, or is this acceptable?

4. **OAuth cancellation**: Pi-ai's login functions may or may not support `AbortSignal`. If they don't, `cancelOAuth()` would need to track and reject the pending promise manually.

## Local Ollama models

Use `ProviderManager.createOllamaModel()` for local Ollama connections. It
resolves capabilities and loaded context allocation and uses Ollama's
`/api/chat` API. Ollama 0.15.0 or newer is required. Its models are `serial`
by default; set `parallelRequests: true` when the server runs requests in
parallel. See [Ollama integration](ollama.md).
