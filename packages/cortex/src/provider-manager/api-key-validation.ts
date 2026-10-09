/**
 * API key validation: one minimal completion (maxTokens: 1) against the
 * provider's cheapest likely model, with the outcome classified so a
 * consumer can tell a bad key from a transient failure.
 */

import { UTILITY_MODEL_OVERRIDES } from '../provider-registry.js';
import { inferUtilityModelId } from '../utility-model-inference.js';
import type { Api, Model } from '@earendil-works/pi-ai';
import { streamModelSimple } from '../model-runtime.js';
import { loadPiAi } from './pi-ai.js';
import type { PiAiModule } from './pi-ai.js';

export type ApiKeyValidationStatus =
  | 'valid'
  | 'invalid_credentials'
  | 'transient_error'
  | 'resolution_error';

export interface ApiKeyValidationResult {
  provider: string;
  modelId: string | null;
  valid: boolean;
  retryable: boolean;
  status: ApiKeyValidationStatus;
  message?: string | undefined;
}

/** Validate an API key by making a minimal LLM call. */
export async function validateProviderApiKey(provider: string, apiKey: string): Promise<ApiKeyValidationResult> {
  const piAi = await loadPiAi();

  const models = piAi.getModels(provider) ?? [];
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

  const modelId = getSmallestModelId(provider, models);
  if (!modelId) {
    return {
      provider,
      modelId: null,
      valid: false,
      retryable: false,
      status: 'resolution_error',
      message: `No usable models found for provider "${provider}"`,
    };
  }

  return tryValidation(piAi, provider, modelId, apiKey);
}

/**
 * Get the cheapest likely utility model ID for a provider.
 */
function getSmallestModelId(provider: string, models: Array<Record<string, unknown>>): string | null {
  return UTILITY_MODEL_OVERRIDES[provider] ?? inferUtilityModelId(models);
}

/**
 * Attempt to validate an API key by making a minimal LLM call.
 */
async function tryValidation(
  piAi: PiAiModule,
  provider: string,
  modelId: string,
  apiKey: string,
): Promise<ApiKeyValidationResult> {
  try {
    const model = piAi.getModel(provider, modelId) as Model<Api>;
    const result = await streamModelSimple(
      model,
      { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
      { apiKey, maxTokens: 1 },
    ).result();
    const silentError = extractSilentValidationError(result);
    if (silentError) {
      throw new Error(silentError);
    }
    return {
      provider,
      modelId,
      valid: true,
      retryable: false,
      status: 'valid',
    };
  } catch (err) {
    return classifyValidationError(provider, modelId, err);
  }
}

function classifyValidationError(
  provider: string,
  modelId: string,
  err: unknown,
): ApiKeyValidationResult {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();

  if (
    /\b401\b/.test(normalized) ||
    /\b403\b/.test(normalized) ||
    normalized.includes('invalid api key') ||
    normalized.includes('incorrect api key') ||
    normalized.includes('authentication failed') ||
    normalized.includes('invalid_auth') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('invalid credential')
  ) {
    return {
      provider,
      modelId,
      valid: false,
      retryable: false,
      status: 'invalid_credentials',
      message,
    };
  }

  if (
    /\b429\b/.test(normalized) ||
    /\b500\b/.test(normalized) ||
    /\b502\b/.test(normalized) ||
    /\b503\b/.test(normalized) ||
    /\b504\b/.test(normalized) ||
    normalized.includes('rate limit') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('temporar') ||
    normalized.includes('overloaded') ||
    normalized.includes('unavailable') ||
    normalized.includes('server error') ||
    normalized.includes('network') ||
    normalized.includes('econn') ||
    normalized.includes('enotfound') ||
    normalized.includes('eai_again')
  ) {
    return {
      provider,
      modelId,
      valid: false,
      retryable: true,
      status: 'transient_error',
      message,
    };
  }

  return {
    provider,
    modelId,
    valid: false,
    retryable: false,
    status: 'resolution_error',
    message,
  };
}

function extractSilentValidationError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const msg = result as Record<string, unknown>;
  if (msg['stopReason'] !== 'error') return null;
  const errorMessage = msg['errorMessage'];
  return typeof errorMessage === 'string'
    ? errorMessage
    : 'Provider validation failed';
}
