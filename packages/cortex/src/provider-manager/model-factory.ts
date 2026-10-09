/**
 * Building CortexModels: from the pi-ai catalog, for a custom
 * OpenAI-compatible endpoint, and for a native Ollama model.
 */

import { CUSTOM_MODEL_KEY_FIELD, CUSTOM_PROVIDER_ID } from '../model-runtime.js';
import { wrapModel } from '../model-wrapper.js';
import type { CortexModel } from '../model-wrapper.js';
import type { OllamaModelConfig } from '../providers/ollama/runtime.js';
import { loadPiAi } from './pi-ai.js';

/** Configuration for creating a custom model endpoint. */
export interface CustomModelConfig {
  /** Base URL of the OpenAI-compatible API (e.g., 'http://localhost:11434/v1'). */
  baseUrl: string;
  /** Model identifier to send in API requests. */
  modelId: string;
  /** Context window size (default: 128,000). */
  contextWindow?: number | undefined;
  /**
   * The endpoint's API key, sent when the agent's `getAuth` or `getApiKey`
   * returns no key for the `custom` provider. Omit it for a keyless local
   * server; a placeholder is sent, since OpenAI-compatible clients require a
   * non-empty key.
   */
  apiKey?: string | undefined;
  /** Compatibility settings for non-standard servers. */
  compat?: {
    /** Whether the server supports the 'developer' role (default: true). */
    supportsDeveloperRole?: boolean | undefined;
    /** Whether the server supports reasoning_effort (default: true). */
    supportsReasoningEffort?: boolean | undefined;
  } | undefined;
}

/** A model pi-ai ships a definition for; throws for one it does not. */
export async function resolveCatalogModel(provider: string, modelId: string): Promise<CortexModel> {
  const piAi = await loadPiAi();
  const piModel = piAi.getModel(provider, modelId);
  // pi-ai's getModel returns undefined for ids it has no definition for.
  // Fail loudly instead of wrapping undefined into a fake-valid model that
  // would later crash deep inside the agentic loop with an opaque error.
  if (piModel == null) {
    throw new Error(
      `Unknown model "${modelId}" for provider "${provider}". ` +
        `Use ProviderManager.createCustomModel() for endpoints pi-ai has no built-in definition for.`,
    );
  }
  let contextWindow: number | undefined;
  if (typeof piModel === 'object') {
    const raw = piModel as Record<string, unknown>;
    const cw = raw['contextWindow'];
    if (typeof cw === 'number') {
      contextWindow = cw;
    }
  }
  return wrapModel(piModel, provider, modelId, contextWindow);
}

/** A model on an OpenAI-compatible endpoint pi-ai has no definition for. */
export async function createCustomModel(config: CustomModelConfig): Promise<CortexModel> {
  const piAi = await loadPiAi();
  // Clone an OpenAI model as a base for streaming/format compatibility,
  // then override to use the Chat Completions API. The base model
  // (openai/gpt-4.1) uses the newer Responses API which most
  // OpenAI-compatible endpoints (Ollama, vLLM, etc.) do not support.
  const baseModel = piAi.getModel('openai', 'gpt-4.1');
  const piModel = {
    ...(baseModel as Record<string, unknown>),
    id: config.modelId,
    name: config.modelId,
    api: 'openai-completions',
    baseUrl: config.baseUrl,
    provider: CUSTOM_PROVIDER_ID,
    contextWindow: config.contextWindow ?? 128_000,
    // Conservative compat for OpenAI-compatible endpoints: disable
    // features that are OpenAI-specific or may not be supported.
    // Consumer-provided compat overrides are merged on top.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens' as const,
      ...config.compat,
    },
  };
  // The request's key when the consumer's callback supplies none, with a
  // placeholder for keyless endpoints: the OpenAI SDK requires a non-empty key.
  (piModel as Record<string, unknown>)[CUSTOM_MODEL_KEY_FIELD] = config.apiKey ?? 'sk-no-key-required';
  return wrapModel(
    piModel,
    CUSTOM_PROVIDER_ID,
    config.modelId,
    config.contextWindow ?? 128_000,
  );
}

/** A native Ollama model, resolved against the server's actual allocation. */
export async function createOllamaModel(config: OllamaModelConfig): Promise<CortexModel> {
  const ollama = await import('../providers/ollama/model.js');
  return ollama.createOllamaModel(config);
}
