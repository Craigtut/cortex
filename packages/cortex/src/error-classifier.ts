/**
 * Error classifier for LLM and network errors.
 *
 * A thin layer over pi-ai: context overflow is pi's `isContextOverflow()`,
 * and failures pi considers transient (`isRetryableAssistantError()`) that
 * no pattern here names are server errors. Cortex owns what pi does not
 * decide: billing exhaustion, usage windows and their reset times,
 * authentication, rate limits, and the server/network split.
 *
 * The classifier is a pure function. It does not throw, does not modify state.
 * It takes an error (or error string) and returns a classification.
 *
 * Reference: error-recovery.md
 */

import type { AssistantMessage } from '@earendil-works/pi-ai';
import { isContextOverflow as piIsContextOverflow, isRetryableAssistantError } from '@earendil-works/pi-ai';
import type { ClassifiedError, ErrorCategory, ErrorSeverity } from './types.js';

/** A thrown value as an Error, wrapping a non-Error in one. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** The message of a thrown value, for logs and user-facing strings. */
export function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Pattern definitions per category (checked in priority order)
// ---------------------------------------------------------------------------

/**
 * Exhausted paid credit, or a plan limit that does not reset on a useful
 * timescale: no retry helps until someone tops up or switches provider.
 * Matched only on provider-specific codes and wording, never on a bare
 * "quota" or "billing": Gemini's per-minute 429 reads "You exceeded your
 * current quota, please check your plan and billing details" and passes.
 * Checked before the rate-limit patterns, which `insufficient_quota` errors
 * also match (they arrive as HTTP 429).
 */
const BILLING_PATTERNS: RegExp[] = [
  // OpenAI's error code; pi-ai puts the JSON body in the message.
  /\binsufficient_quota\b/i,
  // Anthropic.
  /credit balance is too low/i,
  // The OpenCode gateway's monthly limits, as pi-ai reports them.
  /\bGoUsageLimitError\b/,
  /\bFreeUsageLimitError\b/,
  /monthly usage limit reached/i,
];

/** OpenRouter: HTTP 402 with "Insufficient credits". */
function isOutOfCredits(message: string): boolean {
  return /\b402\b/.test(message) && /insufficient credits/i.test(message);
}

/**
 * Usage windows: a subscription's limit that resets after a stated time
 * (Sign in with ChatGPT's "You have hit your ChatGPT usage limit (plus
 * plan). Try again in ~42 min."), and provider retry delays above pi-ai's
 * cap ("Server requested 3600s retry delay (max: 60s)"). Rate limits that
 * wait for the stated reset rather than the backoff.
 */
const USAGE_WINDOW_PATTERNS: RegExp[] = [
  /usage limit/i,
  /subscription_sharing_usage_limit_exceeded/i,
  /server requested \d+(?:\.\d+)?s retry delay/i,
];

/**
 * pi-ai's wrappers around a credential failure (`ModelsError`): a token
 * refresh, auth derivation, key resolution, or credential store access
 * failed, with the cause's text after the colon. The cause decides: a
 * network blip or a token endpoint's 5xx during a refresh is transient,
 * not a credential to replace. (Anthropic's refresh failures also name
 * `/oauth/token`, which the authentication patterns would match first.)
 */
const CREDENTIAL_FAILURE_PREFIX =
  /^(?:OAuth refresh failed|OAuth refresh returned a token that expires too soon|OAuth auth derivation failed|API key auth(?: check)? failed|Credential store (?:read|modify) failed) for (?:provider )?[\w.-]+(?::\s*)?/i;

const AUTHENTICATION_PATTERNS: RegExp[] = [
  /invalid.api.key/i,
  /unauthorized/i,
  /\b401\b/,
  /not.logged.in/i,
  /login.*required/i,
  /please.*log.?in/i,
  /authentication.required/i,
  /re-?authenticate/i,
  /expired.*token/i,
  /token.*expired/i,
  /token.*(revoked|invalid)/i,
  /refresh.*token/i,
  /oauth.*(fail|error|expire|invalid|denied|revoke)/i,
  /session.*expired/i,
  /invalid.*credentials/i,
  /api.key.*invalid/i,
  /permission.denied.*key/i,
  /Could not resolve API key/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate.limit/i,
  /too.many.requests/i,
  /\b429\b/,
  /rate_limit_exceeded/i,
  /throttl/i,
  /request.limit.reached/i,
  /quota.exceeded/i,
];

const SERVER_ERROR_PATTERNS: RegExp[] = [
  /internal.server.error/i,
  /\b500\b/,
  /\b502\b.*bad.gateway/i,
  /\b503\b.*service.unavailable/i,
  /\b504\b.*gateway.timeout/i,
  /server.*error/i,
  /overloaded/i,
];

const NETWORK_PATTERNS: RegExp[] = [
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /network.*error/i,
  /fetch.failed/i,
  /socket.hang.up/i,
  /DNS.*resolution/i,
  // Anthropic SDK surfaces transient connection failures with these canonical
  // messages after its own retries are exhausted (APIConnectionError /
  // APIConnectionTimeoutError). Match them so they classify as network/retry
  // rather than falling through to unknown.
  /connection error/i,
  /timed out/i,
];

// ---------------------------------------------------------------------------
// Severity and action mappings
// ---------------------------------------------------------------------------

const SEVERITY_MAP: Record<ErrorCategory, ErrorSeverity> = {
  authentication: 'fatal',
  billing: 'fatal',
  rate_limit: 'retry',
  context_overflow: 'recoverable',
  server_error: 'retry',
  network: 'retry',
  cancelled: 'recoverable',
  unknown: 'recoverable',
};

const SUGGESTED_ACTIONS: Record<ErrorCategory, string | undefined> = {
  authentication: 'Check your API key or re-authenticate in Settings.',
  billing: 'The provider account is out of credits or over its plan limit. Add credits, or switch provider.',
  rate_limit: 'Rate limit hit. The next tick will be delayed.',
  context_overflow: 'Context window exceeded. Compaction will run.',
  server_error: 'The provider is experiencing issues. Retrying.',
  network: 'Network error. Check your connection.',
  cancelled: undefined,
  unknown: undefined,
};

// ---------------------------------------------------------------------------
// Pattern matching helpers
// ---------------------------------------------------------------------------

function matchesAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/**
 * The wait a provider stated, in ms: "Try again in ~42 min" (also seconds
 * and hours) or "Server requested 3600s retry delay". Undefined when the
 * message states none.
 */
function statedRetryAfterMs(message: string): number | undefined {
  const tryAgain = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)\b/i.exec(message);
  if (tryAgain) return Math.round(Number(tryAgain[1]) * UNIT_MS[tryAgain[2]![0]!.toLowerCase()]!);
  const requested = /server requested (\d+(?:\.\d+)?)s retry delay/i.exec(message);
  if (requested) return Math.round(Number(requested[1]) * 1_000);
  return undefined;
}

const ZERO_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * The failed response pi's helpers judge: the real one when the caller has
 * it, else one built from a thrown error's text (a direct completion, a
 * credential failure), the way pi records a failed run.
 */
function failedResponse(text: string, failure: AssistantMessage | undefined): AssistantMessage {
  if (failure) return failure.errorMessage ? failure : { ...failure, errorMessage: text };
  return {
    role: 'assistant',
    content: [],
    api: 'unknown',
    provider: 'unknown',
    model: 'unknown',
    usage: ZERO_USAGE,
    stopReason: 'error',
    errorMessage: text,
    timestamp: 0,
  };
}

// ---------------------------------------------------------------------------
// Cause-chain extraction
// ---------------------------------------------------------------------------

const MAX_CAUSE_DEPTH = 6;
const MAX_CAUSE_LENGTH = 200;

/**
 * Walk an error's `cause` chain (and any AggregateError children) to build a
 * concise detail string describing the underlying failure.
 *
 * Node's fetch (undici) and the Anthropic SDK nest the real reason several
 * levels below a generic top-level message:
 *
 *   APIConnectionError("Connection error.")
 *     -> cause: TypeError("fetch failed")
 *       -> cause: Error { code: "ECONNRESET", message: "read ECONNRESET" }
 *
 * The top-level message ("Connection error.") tells the user nothing, so we
 * collect distinct, informative fragments from below it (error codes and
 * messages) and join them into e.g. "fetch failed: read ECONNRESET".
 *
 * Only the chain BELOW the top-level error is inspected; the top-level message
 * is already surfaced as `originalMessage`. Returns undefined when the chain
 * adds nothing (bare string, or no `cause`).
 */
export function extractCauseDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;

  const fragments: string[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number): void => {
    if (value == null || depth > MAX_CAUSE_DEPTH || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) {
      const code = (value as { code?: unknown }).code;
      if (typeof code === 'string' && code.length > 0) fragments.push(code);
      const msg = value.message.trim();
      if (msg.length > 0) fragments.push(msg);
      // AggregateError holds sibling failures (e.g. DNS: every address attempt
      // failed). Visit them so at least one concrete reason surfaces.
      const errors = (value as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        for (const child of errors) visit(child, depth + 1);
      }
      visit((value as { cause?: unknown }).cause, depth + 1);
    } else if (typeof value === 'string') {
      const s = value.trim();
      if (s.length > 0) fragments.push(s);
    }
  };

  // Start at the cause (and any aggregated siblings), not the top-level error.
  const topErrors = (error as { errors?: unknown }).errors;
  if (Array.isArray(topErrors)) {
    for (const child of topErrors) visit(child, 1);
  }
  visit((error as { cause?: unknown }).cause, 1);

  if (fragments.length === 0) return undefined;

  // Dedupe, dropping any fragment fully contained in another already kept
  // (e.g. the bare code "ECONNRESET" inside "read ECONNRESET"). The longer,
  // more descriptive fragment wins.
  const kept: string[] = [];
  for (const frag of fragments) {
    if (kept.includes(frag) || kept.some((k) => k.includes(frag))) continue;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (frag.includes(kept[i]!)) kept.splice(i, 1);
    }
    kept.push(frag);
  }

  const detail = kept.join(': ');
  return detail.length > MAX_CAUSE_LENGTH
    ? `${detail.slice(0, MAX_CAUSE_LENGTH - 1)}…`
    : detail;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for the error classifier.
 */
export interface ClassifyErrorOptions {
  /**
   * The model's context window size in tokens. pi-ai's overflow check uses
   * it to read a failed response's usage.
   */
  contextWindow?: number;

  /**
   * The failed assistant message pi recorded for the run, when there is
   * one: pi's helpers judge it directly. Without it, a thrown error's text
   * stands in.
   */
  assistantMessage?: AssistantMessage;

  /**
   * Whether the agent was aborted (user or system cancellation).
   * When true, the error is immediately classified as 'cancelled'.
   * The caller checks agent.state or AbortSignal.aborted and passes this flag;
   * the classifier itself remains pure.
   */
  wasAborted?: boolean;
}

/**
 * Classify an error into an actionable category.
 *
 * In priority order (first match wins):
 * 1. Cancelled (if wasAborted is true); then a pi-ai credential failure
 *    (a failed OAuth refresh) is its cause's transient category, else
 *    authentication
 * 2. Billing: exhausted credit or a monthly plan limit (fatal, never retried)
 * 3. Usage window: a rate limit with a stated reset (`retryAfterMs`)
 * 4. Authentication
 * 5. Rate limit
 * 6. Context overflow: pi-ai's `isContextOverflow()`
 * 7. Server error, then network, from Cortex's patterns; anything else
 *    pi-ai's `isRetryableAssistantError()` calls transient is a server error
 * 8. Unknown (catch-all)
 *
 * @param error - The error to classify (Error object or string)
 * @param options - Optional classification options
 * @returns A ClassifiedError with category, severity, original message, and suggested action
 */
export function classifyError(
  error: Error | string,
  options?: ClassifyErrorOptions,
): ClassifiedError {
  const message = typeof error === 'string' ? error : error.message;
  // Pull the real reason out of the `cause` chain (undici/SDK bury it). Used
  // both to enrich the surfaced detail and to match patterns against, so a
  // buried code (e.g. ECONNRESET) routes correctly when the top message is
  // opaque ("Connection error.").
  const causeDetail = extractCauseDetail(error);
  const matchTarget = causeDetail ? `${message}\n${causeDetail}` : message;

  // 1. Cancelled (highest priority if wasAborted flag is set)
  if (options?.wasAborted) {
    return buildResult('cancelled', message, causeDetail);
  }

  // A credential failure: transient when its cause is, else authentication.
  const credentialFailure = CREDENTIAL_FAILURE_PREFIX.exec(matchTarget);
  if (credentialFailure) {
    const cause = matchTarget.slice(credentialFailure[0].length);
    return buildResult(transientCategoryOf(cause) ?? 'authentication', message, causeDetail);
  }

  // 2. Billing
  if (matchesAny(matchTarget, BILLING_PATTERNS) || isOutOfCredits(matchTarget)) {
    return buildResult('billing', message, causeDetail);
  }

  // 3. Usage window: wait for the stated reset
  if (matchesAny(matchTarget, USAGE_WINDOW_PATTERNS)) {
    return buildResult('rate_limit', message, causeDetail, statedRetryAfterMs(matchTarget));
  }

  // 4. Authentication
  if (matchesAny(matchTarget, AUTHENTICATION_PATTERNS)) {
    return buildResult('authentication', message, causeDetail);
  }

  // 5. Rate limit
  if (matchesAny(matchTarget, RATE_LIMIT_PATTERNS)) {
    return buildResult('rate_limit', message, causeDetail);
  }

  const response = failedResponse(matchTarget, options?.assistantMessage);

  // 6. Context overflow
  if (piIsContextOverflow(response, options?.contextWindow)) {
    return buildResult('context_overflow', message, causeDetail);
  }

  // 7. Server error, network, then whatever else pi calls transient
  if (matchesAny(matchTarget, SERVER_ERROR_PATTERNS)) {
    return buildResult('server_error', message, causeDetail);
  }
  if (matchesAny(matchTarget, NETWORK_PATTERNS)) {
    return buildResult('network', message, causeDetail);
  }
  if (isRetryableAssistantError(response)) {
    return buildResult('server_error', message, causeDetail);
  }

  // 8. Unknown (catch-all)
  return buildResult('unknown', message, causeDetail);
}

/**
 * The transient category a failure's text names, checked before anything
 * else: a rate limit, a server error, a network failure, or what pi-ai
 * calls transient. Undefined when it names none.
 */
function transientCategoryOf(text: string): ErrorCategory | undefined {
  if (text.length === 0) return undefined;
  if (matchesAny(text, RATE_LIMIT_PATTERNS)) return 'rate_limit';
  if (matchesAny(text, SERVER_ERROR_PATTERNS)) return 'server_error';
  if (matchesAny(text, NETWORK_PATTERNS)) return 'network';
  return isRetryableAssistantError(failedResponse(text, undefined)) ? 'server_error' : undefined;
}

/**
 * Whether an error is the provider rejecting a request as longer than the
 * model's context window: the `context_overflow` category, so a throttle
 * worded like an overflow (Bedrock's "ThrottlingException: Too many
 * tokens") is a rate limit, not an overflow.
 */
export function isContextOverflow(
  error: Error | string,
  options?: Pick<ClassifyErrorOptions, 'assistantMessage' | 'contextWindow'>,
): boolean {
  return classifyError(error, options).category === 'context_overflow';
}

/**
 * Whether a response that completed without an error overflowed silently:
 * a provider that truncates an oversized request instead of rejecting it
 * reports more input than the window holds (pi-ai's check). Undefined
 * `contextWindow` means it cannot tell.
 */
export function overflowedSilently(response: AssistantMessage, contextWindow: number | undefined): boolean {
  if (!contextWindow || response.stopReason === 'error' || response.stopReason === 'aborted') return false;
  // A response restored from older history may carry no usage to judge.
  if (typeof response.usage?.input !== 'number') return false;
  return piIsContextOverflow(response, contextWindow);
}

/**
 * Build a ClassifiedError from a category, original message, and optional
 * cause detail.
 */
function buildResult(
  category: ErrorCategory,
  originalMessage: string,
  causeDetail?: string,
  retryAfterMs?: number,
): ClassifiedError {
  const action = SUGGESTED_ACTIONS[category];
  const result: ClassifiedError = {
    category,
    severity: SEVERITY_MAP[category],
    originalMessage,
  };
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
  // Only attach when it adds information beyond the original message.
  if (causeDetail !== undefined && causeDetail !== originalMessage) {
    result.causeDetail = causeDetail;
  }
  if (action !== undefined) {
    result.suggestedAction = action;
  }
  return result;
}
