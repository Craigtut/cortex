/**
 * The one owner of model request dispatch: which pi provider streams a
 * model, and with what auth. Built on pi-ai's `Models` collection and
 * provider objects, in place of the process-global `/compat` dispatch that
 * pi-ai is retiring.
 *
 * Auth has two paths. When the caller resolved credentials (a consumer's
 * `getApiKey` or `getAuth`), the request goes straight to the model's
 * provider with them. Otherwise pi's `Models` resolves auth for the
 * provider, and Cortex hands it an auth context that sees no environment
 * variables and no credential files: provider env vars (`ANTHROPIC_API_KEY`),
 * Anthropic workload identity federation, AWS profiles and gcloud ADC are
 * ignored unless the consumer opts in with `ambientCredentials`. Providers
 * that need no credentials (Ollama) resolve either way.
 *
 * Caller credentials must authorize the request on their own: pi's API
 * implementations fall back to ambient sources when a request carries no
 * key (Anthropic's federation, Vertex ADC, the AWS credential chain), and
 * read them from `process.env` directly. Without `ambientCredentials`, caller
 * auth that is headers only, none of them an auth header the model's API
 * accepts in place of a key, takes pi's (env-blind) resolution instead.
 */

import type {
  Api,
  ApiStreamOptions,
  AssistantMessage,
  AssistantMessageEventStream,
  AuthContext,
  Context,
  CredentialStore,
  Model,
  ModelAuth,
  MutableModels,
  Provider,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
} from '@earendil-works/pi-ai';
import {
  createModels,
  createProvider,
  defaultProviderAuthContext,
  normalizeContext,
} from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { azureOpenAIResponsesApi } from '@earendil-works/pi-ai/api/azure-openai-responses.lazy';
import { bedrockConverseStreamApi } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { googleVertexApi } from '@earendil-works/pi-ai/api/google-vertex.lazy';
import { mistralConversationsApi } from '@earendil-works/pi-ai/api/mistral-conversations.lazy';
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { piMessagesApi } from '@earendil-works/pi-ai/api/pi-messages.lazy';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { unwrapModel } from './model-wrapper.js';
import type { CortexModel } from './model-wrapper.js';
import { ollamaProvider } from './providers/ollama/provider.js';

/** The credential policy of one request. */
export interface CredentialOptions {
  /**
   * Request auth the caller resolved (AgentLoopConfig.getAuth): a key, auth
   * headers, and a base URL that replaces the model's. With a key or auth
   * headers here, or an `apiKey` option, the request carries the caller's
   * credentials and pi resolves none.
   */
  auth?: ModelAuth | undefined;
  /**
   * Let pi resolve credentials from the environment (provider env vars such
   * as `ANTHROPIC_API_KEY`, Anthropic workload identity federation, AWS
   * profiles, gcloud ADC) when the request carries no `apiKey`. Default
   * false: Cortex never picks up ambient credentials silently.
   */
  ambientCredentials?: boolean;
}

/**
 * Options for a request at pi's API level (`stream`/`complete`): the
 * options of the model's API, such as Anthropic's `thinkingEnabled`.
 * Thinking stays off unless asked for.
 */
export interface ModelRequestOptions extends StreamOptions, CredentialOptions {
  [option: string]: unknown;
}

/**
 * Options for a request at pi's reasoning level (`streamSimple`): one
 * `reasoning` level that pi maps to each API's own options. What pi's agent
 * loop sends.
 */
export interface SimpleModelRequestOptions extends SimpleStreamOptions, CredentialOptions {}

/** The provider id `createCustomModel()` stamps on its models. */
export const CUSTOM_PROVIDER_ID = 'custom';

/**
 * The field of a custom-endpoint model that holds the key `createCustomModel()`
 * was configured with (a placeholder for a keyless endpoint). A request uses it
 * when the consumer's `getAuth` or `getApiKey` supplies no key.
 */
export const CUSTOM_MODEL_KEY_FIELD = 'apiKey';

/** The key a custom-endpoint model was configured with, if it is one. */
function configuredKeyOf(model: Model<Api>): string | undefined {
  if (model.provider !== CUSTOM_PROVIDER_ID) return undefined;
  const key = (model as unknown as Record<string, unknown>)[CUSTOM_MODEL_KEY_FIELD];
  return typeof key === 'string' ? nonEmpty(key) : undefined;
}

/**
 * The built-in API implementations, by API id: what a model whose provider
 * pi does not know (a consumer's own `wrapModel()`) is streamed with.
 */
function builtinApis(): Partial<Record<Api, ProviderStreams>> {
  return {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-completions': openAICompletionsApi(),
    'openai-responses': openAIResponsesApi(),
    'openai-codex-responses': openAICodexResponsesApi(),
    'azure-openai-responses': azureOpenAIResponsesApi(),
    'google-generative-ai': googleGenerativeAIApi(),
    'google-vertex': googleVertexApi(),
    'mistral-conversations': mistralConversationsApi(),
    'bedrock-converse-stream': bedrockConverseStreamApi(),
    'pi-messages': piMessagesApi(),
  };
}

/**
 * Models on an OpenAI-compatible endpoint pi has no definition for. Its
 * credential is whatever the request carries, else the key the model was
 * configured with ({@link configuredKeyOf}); nothing ambient.
 */
function customProvider(): Provider {
  return createProvider({
    id: CUSTOM_PROVIDER_ID,
    name: 'Custom endpoint',
    auth: {
      apiKey: {
        name: 'Custom endpoint API key',
        resolve: async ({ credential }) =>
          credential?.key ? { auth: { apiKey: credential.key }, source: 'stored credential' } : undefined,
      },
    },
    models: [],
    api: openAICompletionsApi(),
  });
}

/**
 * The headers each pi API accepts in place of a key (pi's own checks in
 * `anthropic-messages` and `openai-completions`/`openai-responses`). With any
 * other API, or none of these, a request without a key falls back to ambient
 * credentials or fails.
 */
const KEYLESS_AUTH_HEADERS: Partial<Record<Api, readonly string[]>> = {
  'anthropic-messages': ['authorization', 'x-api-key', 'cf-aig-authorization'],
  'openai-completions': ['authorization', 'cf-aig-authorization'],
  'openai-responses': ['authorization', 'cf-aig-authorization'],
};

/** Whether `headers` authorize a request to `api` without a key. */
function headersAuthorize(api: Api, headers: Record<string, string | null>): boolean {
  const accepted = KEYLESS_AUTH_HEADERS[api] ?? [];
  return Object.entries(headers).some(
    ([name, value]) => typeof value === 'string' && value.length > 0 && accepted.includes(name.toLowerCase()),
  );
}

/** An auth context that sees no environment variables and no files. */
const ENV_BLIND_AUTH_CONTEXT: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

/**
 * The auth context for a credential policy: pi's own (env vars, credential
 * files) when the consumer opted into ambient credentials, else one that
 * sees neither.
 */
export function authContextFor(ambientCredentials: boolean): AuthContext {
  return ambientCredentials ? defaultProviderAuthContext() : ENV_BLIND_AUTH_CONTEXT;
}

/** One pi `Models` collection plus the providers Cortex registers on it. */
export class ModelRuntime {
  readonly models: MutableModels;
  /** Dispatches by `model.api`, for models whose provider pi does not know. */
  private readonly byApi: Provider;
  /** Provider ids Cortex registered itself, which serve any model given to them. */
  private readonly cortexProviderIds: ReadonlySet<string>;

  /**
   * @param ambientCredentials - Whether pi may read ambient credentials ({@link authContextFor}).
   * @param credentials - Where pi reads and refreshes stored credentials; in memory by default.
   */
  constructor(
    private readonly ambientCredentials: boolean,
    credentials?: CredentialStore,
  ) {
    this.models = createModels({
      authContext: authContextFor(ambientCredentials),
      ...(credentials ? { credentials } : {}),
    });
    for (const provider of builtinProviders()) this.models.setProvider(provider);
    const own = [ollamaProvider(), customProvider()];
    for (const provider of own) this.models.setProvider(provider);
    this.cortexProviderIds = new Set(own.map((provider) => provider.id));
    this.byApi = createProvider({
      id: 'cortex-api-dispatch',
      auth: { apiKey: { name: 'Request API key', resolve: async () => undefined } },
      models: [],
      api: builtinApis(),
    });
  }

  /**
   * The provider that streams `model` with caller-resolved credentials: its
   * own provider when that provider serves the model's API (a single-API
   * provider would send anything it is given over its one API), else the
   * implementation for the model's API.
   */
  providerFor(model: Model<Api>): Provider {
    const provider = this.models.getProvider(model.provider);
    if (
      provider &&
      (this.cortexProviderIds.has(provider.id) || provider.getModels().some((candidate) => candidate.api === model.api))
    ) {
      return provider;
    }
    return this.byApi;
  }

  /** A request at pi's API level, like pi's `stream()`. */
  stream(
    model: Model<Api>,
    context: Context,
    options: StreamOptions & { auth?: ModelAuth | undefined } = {},
  ): AssistantMessageEventStream {
    const caller = this.callerRequest(model, options);
    if (caller) {
      return this.providerFor(caller.model).stream(
        caller.model,
        normalizeContext(context),
        caller.options as ApiStreamOptions<Api>,
      );
    }
    return this.models.stream(model, context, withoutCallerAuth(options) as ApiStreamOptions<Api>);
  }

  /** A request at pi's reasoning level, like pi's `streamSimple()`. */
  streamSimple(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions & { auth?: ModelAuth | undefined } = {},
  ): AssistantMessageEventStream {
    const caller = this.callerRequest(model, options);
    if (caller) {
      return this.providerFor(caller.model).streamSimple(caller.model, normalizeContext(context), caller.options);
    }
    return this.models.streamSimple(model, context, withoutCallerAuth(options));
  }

  /**
   * The request as the caller's credentials shape it, or null when they do
   * not authorize it on their own and pi resolves auth instead. Cortex's own
   * providers take any caller auth.
   */
  private callerRequest<T extends StreamOptions & { auth?: ModelAuth | undefined }>(
    model: Model<Api>,
    options: T,
  ): { model: Model<Api>; options: Omit<T, 'auth'> } | null {
    const caller = withCallerAuth(model, options);
    if (!caller || this.ambientCredentials || this.cortexProviderIds.has(model.provider)) return caller;
    const key = (caller.options as StreamOptions).apiKey;
    if (key !== undefined && !PLACEHOLDER_KEY.test(key)) return caller;
    return headersAuthorize(model.api, (caller.options as StreamOptions).headers ?? {}) ? caller : null;
  }
}

/**
 * A key that stands for ambient credentials rather than being one (pi's
 * `<authenticated>` marker for Vertex ADC and the AWS chain).
 */
const PLACEHOLDER_KEY = /^<[^>]+>$/;

/**
 * The request as the caller's credentials shape it, or null when the caller
 * resolved none: auth headers go under the request's own headers, and an
 * auth base URL replaces the model's (GitHub Copilot's per-account endpoint).
 * A custom-endpoint model with no key from the caller uses its configured one.
 */
function withCallerAuth<T extends StreamOptions & { auth?: ModelAuth | undefined }>(
  model: Model<Api>,
  options: T,
): { model: Model<Api>; options: Omit<T, 'auth'> } | null {
  const { auth, ...rest } = options;
  const apiKey = nonEmpty(auth?.apiKey) ?? nonEmpty(rest.apiKey) ?? configuredKeyOf(model);
  const authHeaders = auth?.headers && Object.keys(auth.headers).length > 0 ? auth.headers : undefined;
  if (!apiKey && !authHeaders) return null;
  const headers = authHeaders ? mergeHeaders(authHeaders, rest.headers) : rest.headers;
  return {
    model: auth?.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
    options: {
      ...rest,
      ...(apiKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
    },
  };
}

/**
 * Without caller credentials, pi resolves them through the runtime's auth
 * context. Drop an empty key so it is not taken as an explicit one.
 */
function withoutCallerAuth<T extends StreamOptions & { auth?: ModelAuth | undefined }>(
  options: T,
): Omit<T, 'auth' | 'apiKey'> {
  const { auth: _auth, apiKey: _empty, ...rest } = options;
  return rest;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `override` over `base`, header names compared case-insensitively, as pi merges them. */
function mergeHeaders(
  base: Record<string, string | null>,
  override: Record<string, string | null> | undefined,
): Record<string, string | null> {
  const merged = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}

let envBlindRuntime: ModelRuntime | null = null;
let ambientRuntime: ModelRuntime | null = null;

/**
 * The process-wide runtime for a credential policy. Built on first use: it
 * loads every built-in provider's catalog.
 */
export function getModelRuntime(ambientCredentials = false): ModelRuntime {
  if (ambientCredentials) {
    ambientRuntime ??= new ModelRuntime(true);
    return ambientRuntime;
  }
  envBlindRuntime ??= new ModelRuntime(false);
  return envBlindRuntime;
}

/** Stream one request to a pi model at pi's API level. */
export function streamModel(
  model: Model<Api>,
  context: Context,
  options: ModelRequestOptions = {},
): AssistantMessageEventStream {
  const { ambientCredentials, ...streamOptions } = options;
  return getModelRuntime(ambientCredentials === true).stream(model, context, streamOptions);
}

/** Stream one request to a pi model at pi's reasoning level. */
export function streamModelSimple(
  model: Model<Api>,
  context: Context,
  options: SimpleModelRequestOptions = {},
): AssistantMessageEventStream {
  const { ambientCredentials, ...streamOptions } = options;
  return getModelRuntime(ambientCredentials === true).streamSimple(model, context, streamOptions);
}

/**
 * One completion from a model outside any agent loop, at pi's API level.
 * pi-ai reports a failed request as a message with `stopReason: 'error'`
 * rather than a rejection; check it.
 */
export function completeModel(
  model: CortexModel,
  context: Context,
  options: ModelRequestOptions = {},
): Promise<AssistantMessage> {
  return streamModel(unwrapModel(model) as Model<Api>, context, options).result();
}
