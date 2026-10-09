/**
 * OAuth flows: login (the race between pi's login, cancellation, the
 * timeout, and a failed browser callback, plus the adapter from pi's
 * interaction object to Cortex's callbacks) and cancellation. One flow is
 * active at a time per instance. Request auth and token refresh are pi's
 * Models.getAuth, over the manager's credential store.
 */

import type { AuthEvent, AuthInteraction, AuthPrompt, OAuthAuth } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '../model-runtime.js';
import { OAUTH_PROVIDER_IDS } from '../provider-registry.js';
import { OAuthError } from './oauth-types.js';
import type {
  OAuthAuthInfo,
  OAuthCallbackPageContext,
  OAuthCallbackPageStatus,
  OAuthCallbacks,
  OAuthFlowType,
  OAuthMeta,
  OAuthPromptInfo,
  OAuthResult,
} from './oauth-types.js';
import { loopbackCallbackOf, maybeInstallOAuthCallbackShim } from './oauth-callback-page.js';
import type { LoopbackCallback, OAuthCallbackRoute } from './oauth-callback-page.js';

const DEVICE_CODE_INSTRUCTIONS_RE = /\benter\s+code:\s*([A-Z0-9-]+)/i;

/** Default overall OAuth flow timeout (pi-ai hangs without this). */
const DEFAULT_OAUTH_FLOW_TIMEOUT_MS = 5 * 60_000;

function normalizeOAuthPromptInfo(prompt: unknown): OAuthPromptInfo {
  if (typeof prompt === 'string') {
    return { message: prompt };
  }

  const raw = prompt as Record<string, unknown> | null | undefined;
  const message = typeof raw?.['message'] === 'string' ? raw['message'] : String(prompt ?? '');
  const normalized: OAuthPromptInfo = { message };

  if (typeof raw?.['placeholder'] === 'string') {
    normalized.placeholder = raw['placeholder'];
  }

  if (typeof raw?.['allowEmpty'] === 'boolean') {
    normalized.allowEmpty = raw['allowEmpty'];
  }

  return normalized;
}

function isOAuthFlowType(value: unknown): value is OAuthFlowType {
  return value === 'browser' || value === 'localhost_callback' || value === 'device_code';
}

function normalizeOAuthAuthInfo(
  provider: string,
  info: unknown,
  legacyInstructions: string | undefined,
  routes: Record<string, OAuthCallbackRoute>,
  callback: LoopbackCallback | null,
): OAuthAuthInfo {
  const raw = typeof info === 'string'
    ? { url: info, instructions: legacyInstructions }
    : (info as Record<string, unknown> | null | undefined);

  const url = typeof raw?.['url'] === 'string' ? raw['url'] : String(info ?? '');
  const instructions = typeof raw?.['instructions'] === 'string'
    ? raw['instructions']
    : legacyInstructions;
  // Where pi's callback server really listens, from the authorization
  // URL; the provider's preferred route when the URL does not say.
  const callbackRoute = callback ?? routes[provider];
  const deviceCode = typeof raw?.['deviceCode'] === 'string'
    ? raw['deviceCode']
    : instructions?.match(DEVICE_CODE_INSTRUCTIONS_RE)?.[1];
  const isDeviceCodeFlow = Boolean(deviceCode) || provider === 'github-copilot';
  const flowType = isOAuthFlowType(raw?.['flowType'])
    ? raw['flowType']
    : isDeviceCodeFlow ? 'device_code'
      : callbackRoute ? 'localhost_callback'
      : 'browser';
  const manualCodeRecommended = typeof raw?.['manualCodeRecommended'] === 'boolean'
    ? raw['manualCodeRecommended']
    : flowType === 'localhost_callback' && callbackRoute ? true : undefined;
  const callbackPort = typeof raw?.['callbackPort'] === 'number'
    ? raw['callbackPort']
    : flowType === 'localhost_callback' ? callbackRoute?.port : undefined;
  const callbackPath = typeof raw?.['callbackPath'] === 'string'
    ? raw['callbackPath']
    : flowType === 'localhost_callback' ? callbackRoute?.path : undefined;

  return {
    url,
    ...(instructions ? { instructions } : {}),
    flowType,
    ...(deviceCode ? { deviceCode } : {}),
    ...(manualCodeRecommended !== undefined ? { manualCodeRecommended } : {}),
    ...(callbackPort !== undefined ? { callbackPort } : {}),
    ...(callbackPath !== undefined ? { callbackPath } : {}),
  };
}

// ---------------------------------------------------------------------------
// Display name extraction
// ---------------------------------------------------------------------------

/**
 * Extract the best available display name from OAuth credentials.
 * Different providers include different identity information.
 */
function extractDisplayName(credentials: Record<string, unknown>): string | undefined {
  // Try common fields across providers
  const email = credentials['email'];
  if (typeof email === 'string') return email;

  const accountId = credentials['accountId'];
  if (typeof accountId === 'string') return accountId;

  const idToken = credentials['idToken'];
  if (typeof idToken === 'string') {
    // JWT id_token may contain email in payload
    try {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(atob(parts[1]!)) as Record<string, unknown>;
        const payloadEmail = payload['email'];
        if (typeof payloadEmail === 'string') return payloadEmail;
      }
    } catch {
      // Ignore malformed tokens
    }
  }
  return undefined;
}

/**
 * Build OAuthMeta from raw credential data.
 */
function buildOAuthMeta(
  provider: string,
  rawCredentials: Record<string, unknown>,
): OAuthMeta {
  const displayName = extractDisplayName(rawCredentials);
  const expiresAtRaw = rawCredentials['expiresAt'] ?? rawCredentials['expires'];
  const expiresAt = typeof expiresAtRaw === 'number' ? expiresAtRaw : undefined;

  const meta: OAuthMeta = {
    provider,
    refreshable: !!(rawCredentials['refreshToken'] ?? rawCredentials['refresh']),
  };

  if (displayName !== undefined) {
    meta.displayName = displayName;
  }
  if (expiresAt !== undefined) {
    meta.expiresAt = expiresAt;
  }

  return meta;
}

/** pi's "Port N is in use" login failure as Cortex's typed error, else null. */
function portInUseError(provider: string, err: unknown): OAuthError | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = /\bport (\d+) is in use\b/i.exec(message);
  if (!match) return null;
  return new OAuthError('callback_port_in_use', provider, message, { port: Number(match[1]) });
}

function cancelledError(provider: string): OAuthError {
  return new OAuthError('cancelled', provider, `OAuth flow for "${provider}" was cancelled.`);
}

export interface OAuthFlowsOptions {
  /** Preferred loopback callback routes (provider to path/port). */
  routes: Record<string, OAuthCallbackRoute>;
  /** The pi model runtime whose providers log in and whose store keeps the credential. */
  runtime: () => ModelRuntime;
}

export class OAuthFlows {
  /** Active OAuth AbortController, if any. */
  private activeOAuthAbort: AbortController | null = null;

  private readonly oauthCallbackRoutes: Record<string, OAuthCallbackRoute>;

  private readonly runtime: () => ModelRuntime;

  constructor(options: OAuthFlowsOptions) {
    this.oauthCallbackRoutes = options.routes;
    this.runtime = options.runtime;
  }

  /** A provider's pi OAuth implementation, or null if it has none. */
  private oauthOf(provider: string): OAuthAuth | null {
    return this.runtime().models.getProvider(provider)?.auth.oauth ?? null;
  }

  /**
   * Run one login flow to completion, cancellation, timeout, or callback
   * failure. One flow at a time: a second call while one is in progress is
   * rejected with `flow_in_progress` and leaves the first untouched, so
   * cancel() still reaches it. The slot is taken synchronously, before any
   * await, so two calls in one tick cannot both pass the check, and it is
   * released only by the flow that holds it, however that flow ends.
   */
  async initiate(provider: string, callbacks: OAuthCallbacks): Promise<OAuthResult> {
    if (this.activeOAuthAbort) {
      throw new OAuthError(
        'flow_in_progress',
        provider,
        'Another OAuth flow is already in progress. Cancel it or let it finish before starting another.',
      );
    }
    const abort = new AbortController();
    this.activeOAuthAbort = abort;
    try {
      return await this.run(provider, callbacks, abort);
    } finally {
      if (this.activeOAuthAbort === abort) this.activeOAuthAbort = null;
    }
  }

  private async run(
    provider: string,
    callbacks: OAuthCallbacks,
    abort: AbortController,
  ): Promise<OAuthResult> {
    const oauthProvider = this.oauthOf(provider);
    if (!oauthProvider) {
      throw new OAuthError(
        'unsupported_provider',
        provider,
        `Provider "${provider}" does not support OAuth`,
      );
    }

    // A taken callback port is pi's to handle: Anthropic falls back to a
    // free port and Codex to a pasted redirect URL.

    // The render shim sees a failed callback (a state mismatch, a provider
    // error redirect) as the browser does: fail the flow with Cortex's typed
    // error right away. pi rejects its own login too, with its own message.
    let failFromCallback!: (err: OAuthError) => void;
    const callbackFailure = new Promise<never>((_, reject) => {
      failFromCallback = reject;
    });
    const handleCallbackResult = (
      status: OAuthCallbackPageStatus,
      ctx: OAuthCallbackPageContext,
    ): void => {
      if (status !== 'error') return;
      const detail = ctx.details ? ` (${ctx.details})` : '';
      failFromCallback(new OAuthError(
        'callback_failed',
        provider,
        `OAuth callback for "${provider}" reported a failure: ${ctx.message}${detail}`,
      ));
    };

    const shim = maybeInstallOAuthCallbackShim(
      provider,
      oauthProvider.name,
      callbacks.renderCallbackPage,
      handleCallbackResult,
      this.oauthCallbackRoutes,
    );

    // pi stops a login on the interaction's abort signal; the timeout is
    // Cortex's (pi's Anthropic login sets none), and both reject with
    // Cortex's typed errors.
    const timeoutMs = callbacks.timeoutMs ?? DEFAULT_OAUTH_FLOW_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => reject(new OAuthError(
          'timed_out',
          provider,
          `OAuth flow for "${provider}" timed out after ${timeoutMs}ms.`,
        )), timeoutMs);
        timer.unref?.();
      }
    });
    const cancelled = new Promise<never>((_, reject) => {
      abort.signal.addEventListener('abort', () => reject(cancelledError(provider)), { once: true });
    });

    // pi's login takes one interaction object: every out-bound message is
    // notify(AuthEvent) and every in-bound answer is prompt(AuthPrompt).
    // Adapt it to Cortex's consumer-facing OAuthCallbacks.
    const interaction: AuthInteraction = {
      signal: abort.signal,
      notify: (event: AuthEvent) => {
        switch (event.type) {
          case 'auth_url': {
            const callback = loopbackCallbackOf(event.url);
            if (callback) shim.expect(callback);
            callbacks.onAuth(
              normalizeOAuthAuthInfo(provider, event, event.instructions, this.oauthCallbackRoutes, callback),
            );
            return;
          }
          case 'device_code':
            // pi hands us the code as structured data, so pass it straight
            // through rather than re-deriving it from a prose instruction.
            callbacks.onAuth({
              url: event.verificationUri,
              flowType: 'device_code',
              deviceCode: event.userCode,
              instructions: `Enter code ${event.userCode}`,
            });
            return;
          case 'info':
          case 'progress':
            callbacks.onProgress?.(event.message);
            return;
        }
      },
      prompt: async (prompt: AuthPrompt): Promise<string> => {
        if (prompt.type === 'manual_code' && callbacks.onManualCodeInput) {
          // pi aborts this signal when the browser callback wins the race.
          return await callbacks.onManualCodeInput(prompt.signal);
        }
        if (prompt.type === 'select' && callbacks.onSelect) {
          const chosen = await callbacks.onSelect({
            message: prompt.message,
            options: prompt.options.map(o => ({ id: o.id, label: o.label })),
          });
          // pi's prompt() contract is "resolve with the answer, reject on
          // cancel". Cortex signals cancel as undefined, so translate rather
          // than handing pi the string "undefined".
          if (chosen === undefined) {
            throw cancelledError(provider);
          }
          return chosen;
        }
        if (prompt.type === 'select') {
          // No chooser: take the provider's first, default option (browser
          // login for Anthropic) rather than asking for an option id as text.
          const first = prompt.options[0];
          if (first) return first.id;
        }
        return await callbacks.onPrompt(normalizeOAuthPromptInfo(prompt));
      },
    };

    // pi runs the provider's login and stores the credential in the
    // runtime's credential store.
    const login = this.runtime().models.login(provider, 'oauth', interaction).catch((err: unknown) => {
      throw portInUseError(provider, err) ?? err;
    }) as Promise<Record<string, unknown>>;
    // Whichever promise loses the race may still settle later (pi-ai's
    // login can hang or settle late; the aux promises can reject after the
    // race is decided). Attach inert handlers so a late rejection never
    // surfaces as an unhandled rejection. Promise.race still observes the
    // first settlement independently.
    login.catch(() => {});
    cancelled.catch(() => {});
    timeout.catch(() => {});
    callbackFailure.catch(() => {});

    try {
      const rawCredentials = await Promise.race([
        login,
        cancelled,
        timeout,
        callbackFailure,
      ]);

      const credentials = JSON.stringify(rawCredentials);
      const meta = buildOAuthMeta(provider, rawCredentials);

      return { credentials, meta };
    } finally {
      if (timer) clearTimeout(timer);
      shim.release();
      // However the flow ended, end pi's login with it: a timed-out or
      // failed flow would otherwise keep its callback server bound and store
      // a credential the user completes later in the browser. A login that
      // succeeded has already stored its credential.
      abort.abort();
    }
  }

  /** Cancel the in-progress flow, if any. */
  cancel(): void {
    if (this.activeOAuthAbort) {
      this.activeOAuthAbort.abort();
      this.activeOAuthAbort = null;
    }
  }

  /** OAuth-capable provider ids from the installed pi, limited to the logins Cortex supports. */
  async listCapableProviders(): Promise<string[]> {
    const fromPi = this.runtime().models.getProviders()
      .filter((provider) => provider.auth.oauth)
      .map((provider) => provider.id)
      .sort();
    // Intersect with Cortex's OAuth set: pi also ships logins Cortex does
    // not follow through on (Sign in with ChatGPT on 'openai' requires a
    // device id Cortex does not supply, so it always fails).
    const supported = new Set(OAUTH_PROVIDER_IDS);
    return fromPi.filter(id => supported.has(id));
  }
}
