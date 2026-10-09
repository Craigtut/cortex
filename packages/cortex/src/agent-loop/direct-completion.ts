/**
 * Direct (non-agentic) completions: one model call, no tools run, no
 * transcript. directComplete and structuredComplete use the primary
 * model, utilityComplete the utility model; all three share credential
 * resolution, cache options, abort and silent-error handling, usage
 * accounting, and error surfacing through the loop's onError.
 */

import {
  applyCacheBreakpoints,
  resolveDirectCompletionContext,
} from '../cache-breakpoints.js';
import type { CacheBreakpointIndices, DirectCompletionContext } from '../cache-breakpoints.js';
import type { Context, ModelAuth } from '@earendil-works/pi-ai';
import { toError } from '../error-classifier.js';
import { streamModel } from '../model-runtime.js';
import type { ModelRequestOptions } from '../model-runtime.js';
import type { CortexModel } from '../model-wrapper.js';
import { assistantText, assistantUsage, toolCallArguments } from '../pi-message.js';
import { parseSchemaCompletion, structuredCompletionRequest } from '../structured-completion.js';
import type { CortexLogger, CortexUsage } from '../types.js';
import type { CacheRetention, PiModel } from './pi-agent.js';
import type { LoopUsage } from './loop-usage.js';

export interface DirectCompletionOptions {
  cacheRetention?: CacheRetention;
  /**
   * Per-call cache affinity key, sent as the `x-session-affinity` header on
   * Anthropic requests so repeated calls route to the same cache. Defaults to
   * the agent's sessionId. Set a distinct value per pipeline when running
   * several independent direct-completion pipelines with different stable
   * prefixes.
   */
  sessionId?: string;
  /**
   * Optional abort signal to cancel an in-flight completion. When the signal
   * fires, the call rejects with an `AbortError` (an Error whose `name` is
   * `'AbortError'`) so callers can distinguish caller-initiated cancellation
   * from a genuine failure. Applies to `directComplete`, `structuredComplete`,
   * and `utilityComplete`.
   */
  signal?: AbortSignal;
  /**
   * Category tag this completion's spend is recorded under in the loop's
   * session usage (see SessionUsage.utility) and on the emitted
   * utility_usage event. Cortex tags its internal calls ('observer',
   * 'reflector', 'webfetch', 'bash_utility'); consumer
   * calls default to 'direct', 'structured', or 'utility' by entry point.
   */
  usageCategory?: string;
}

export interface DirectCompletionPorts {
  models(): { primary: CortexModel; primaryPi: PiModel; utility: CortexModel; utilityPi: PiModel };
  getApiKey: ((provider: string) => Promise<string>) | undefined;
  /** Resolves request auth; takes precedence over getApiKey (AgentLoopConfig.getAuth). */
  getAuth: ((provider: string) => Promise<ModelAuth | undefined>) | undefined;
  /** Let pi resolve ambient credentials when no key was resolved (AgentLoopConfig.ambientCredentials). */
  ambientCredentials: boolean;
  cacheRetention(): CacheRetention | null;
  sessionId(): string | null;
  isAborted(): boolean;
  emitError(error: Error, wasAborted?: boolean): void;
  /** Report a call's spend (the loop's utility_usage event feeds the ledger). */
  emitUtilityUsage(category: string, usage: CortexUsage): void;
  ledger: LoopUsage;
  logger: CortexLogger;
}

/** What distinguishes one direct entry point from another. */
interface CompletionSpec<T> {
  entry: 'directComplete' | 'structuredComplete' | 'utilityComplete';
  target: 'primary' | 'utility';
  defaultUsageCategory: string;
  /** Extra request context and options, built once credentials resolved. */
  request?: () => { context: Record<string, unknown>; options: Record<string, unknown> };
  logFields?: Record<string, unknown>;
  read(result: unknown): T;
}

export class DirectCompletions {
  constructor(private readonly ports: DirectCompletionPorts) {}

  /** Primary model, text result. Contract: LoopCompletionApi.directComplete. */
  direct(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string> {
    return this.run({
      entry: 'directComplete',
      target: 'primary',
      defaultUsageCategory: 'direct',
      read: assistantText,
    }, context, options);
  }

  /** Primary model, schema-shaped result. Contract: LoopCompletionApi.structuredComplete. */
  structured(
    context: DirectCompletionContext,
    schema: unknown,
    toolName: string,
    toolDescription: string,
    options?: DirectCompletionOptions,
  ): Promise<Record<string, unknown> | null> {
    const tool = {
      name: toolName,
      description: toolDescription,
      parameters: schema,
    };
    const primary = (): CortexModel => this.ports.models().primary;
    return this.run({
      entry: 'structuredComplete',
      target: 'primary',
      defaultUsageCategory: 'structured',
      // The provider capability selects native schema output or a forced tool.
      request: () => structuredCompletionRequest(primary(), schema, tool),
      logFields: { toolName },
      read: (result) => primary().capabilities?.structuredOutput === 'json-schema'
        ? parseSchemaCompletion(result, schema)
        : toolCallArguments(result, toolName),
    }, context, options);
  }

  /** Utility model, text result. Contract: LoopCompletionApi.utilityComplete. */
  utility(context: DirectCompletionContext, options?: DirectCompletionOptions): Promise<string> {
    return this.run({
      entry: 'utilityComplete',
      target: 'utility',
      defaultUsageCategory: 'utility',
      read: assistantText,
    }, context, options);
  }

  private async run<T>(
    spec: CompletionSpec<T>,
    context: DirectCompletionContext,
    options?: DirectCompletionOptions,
  ): Promise<T> {
    // Structured contexts get the [slots][history][ephemeral][prompt] layout plus BP2/BP3 indices.
    const resolved = resolveDirectCompletionContext(context);

    const models = this.ports.models();
    const model = spec.target === 'primary' ? models.primary : models.utility;
    const piModel = spec.target === 'primary' ? models.primaryPi : models.utilityPi;

    // A key-resolution failure is remembered, not thrown: pi-ai may still
    // succeed, and if it fails this is the more actionable cause.
    let apiKey: string | undefined;
    let auth: ModelAuth | undefined;
    let keyError: Error | undefined;
    if (this.ports.getAuth) {
      try {
        auth = await this.ports.getAuth(model.provider);
      } catch (err) {
        keyError = toError(err);
      }
    } else if (this.ports.getApiKey) {
      try {
        apiKey = await this.ports.getApiKey(model.provider);
      } catch (err) {
        keyError = toError(err);
      }
    }

    this.ports.ledger.lastDirect = null;
    const completeOptions = this.completeOptions(apiKey, options, resolved.indices);
    const request = spec.request?.();

    const startMs = Date.now();
    try {
      // Messages pass through as-is; pi-ai normalizes formats per provider.
      const result = await streamModel(
        piModel,
        {
          systemPrompt: resolved.systemPrompt,
          messages: resolved.messages,
          ...request?.context,
        } as Context,
        {
          ...completeOptions,
          ...request?.options,
          ...(auth ? { auth } : {}),
          ambientCredentials: this.ports.ambientCredentials,
        } as ModelRequestOptions,
      ).result();

      // Caller-initiated cancellation takes precedence over error/usage handling.
      throwIfAborted(result, options?.signal);
      checkForSilentError(result);

      const usage = assistantUsage(result);
      this.ports.ledger.lastDirect = usage;
      if (usage) {
        this.ports.emitUtilityUsage(options?.usageCategory ?? spec.defaultUsageCategory, usage);
      }

      this.ports.logger.debug(spec.entry, {
        ...spec.logFields,
        durationMs: Date.now() - startMs,
        usage,
      });

      return spec.read(result);
    } catch (err) {
      throw this.surfaceError(err, keyError, options?.signal);
    }
  }

  /**
   * Emits the error through onError, so direct-call auth failures surface
   * like loop failures, and returns the error to throw. Prefers the
   * credential-resolution error ("OAuth refresh failed") over the downstream
   * provider error it caused, unless the call was aborted.
   */
  private surfaceError(
    err: unknown,
    keyError: Error | undefined,
    signal?: AbortSignal,
  ): Error {
    const downstream = toError(err);
    const aborted =
      this.ports.isAborted() || (signal?.aborted ?? false) || downstream.name === 'AbortError';
    const cause = aborted ? downstream : (keyError ?? downstream);
    this.ports.emitError(cause, aborted);
    return cause;
  }

  private completeOptions(
    apiKey: string | undefined,
    options?: DirectCompletionOptions,
    breakpointIndices?: CacheBreakpointIndices | null,
  ): Record<string, unknown> {
    const completeOptions: Record<string, unknown> = {};
    const cacheRetention = options?.cacheRetention ?? this.ports.cacheRetention();
    const sessionId = options?.sessionId ?? this.ports.sessionId();

    if (apiKey) completeOptions['apiKey'] = apiKey;
    if (cacheRetention) completeOptions['cacheRetention'] = cacheRetention;
    if (sessionId) completeOptions['sessionId'] = sessionId;
    if (options?.signal) completeOptions['signal'] = options.signal;

    // Stamp structured contexts' BP2/BP3 indices onto the payload, as the agentic loop does.
    if (breakpointIndices) {
      completeOptions['onPayload'] = (
        payload: Record<string, unknown>,
        model: Record<string, unknown>,
      ) => {
        if (!model || model['provider'] !== 'anthropic') return undefined;
        return applyCacheBreakpoints(payload, breakpointIndices);
      };
    }

    return completeOptions;
  }
}

/** pi-ai resolves failures with stopReason 'error' instead of throwing; rethrow them. */
function checkForSilentError(result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const msg = result as Record<string, unknown>;
  if (msg['stopReason'] === 'error') {
    const errorMessage = typeof msg['errorMessage'] === 'string'
      ? msg['errorMessage']
      : 'Unknown pi-ai error (stopReason=error)';
    throw new Error(`LLM call failed: ${errorMessage}`);
  }
}

/**
 * Throw an `AbortError` for a caller-aborted completion. pi-ai resolves with
 * stopReason 'aborted' rather than throwing, and the signal check also covers
 * an abort landing just after the result resolved. Runs before
 * checkForSilentError so an abort is never reported as an LLM error.
 */
function throwIfAborted(result: unknown, signal?: AbortSignal): void {
  const resultAborted =
    !!result &&
    typeof result === 'object' &&
    (result as Record<string, unknown>)['stopReason'] === 'aborted';
  if (signal?.aborted || resultAborted) {
    const err = new Error('Completion aborted');
    err.name = 'AbortError';
    throw err;
  }
}
