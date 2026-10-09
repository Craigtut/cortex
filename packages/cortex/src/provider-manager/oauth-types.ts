/**
 * The consumer-facing OAuth contract: flow callbacks, callback page
 * rendering, results, and the structured error.
 */

import type { ModelAuth } from '@earendil-works/pi-ai';

// ---------------------------------------------------------------------------
// OAuth types
// ---------------------------------------------------------------------------

/** OAuth flow shape, used by consumers to render provider-specific UX. */
export type OAuthFlowType = 'browser' | 'localhost_callback' | 'device_code';

/** URL and flow metadata emitted when a user needs to authorize a provider. */
export interface OAuthAuthInfo {
  /** URL the user should open to authorize the provider. */
  url: string;
  /** Provider-supplied instructions, when available. */
  instructions?: string | undefined;
  /** Normalized flow type. */
  flowType: OAuthFlowType;
  /** Device code extracted from provider instructions, when available. */
  deviceCode?: string | undefined;
  /** Whether a remote/headless environment should show a manual paste input. */
  manualCodeRecommended?: boolean | undefined;
  /** Fixed localhost callback port, for callback-server flows. */
  callbackPort?: number | undefined;
  /** Fixed callback path, for callback-server flows. */
  callbackPath?: string | undefined;
}

/** Prompt emitted when a provider needs user input during OAuth. */
export interface OAuthPromptInfo {
  /** User-facing prompt text. */
  message: string;
  /** Optional input placeholder. */
  placeholder?: string | undefined;
  /** Whether an empty response is valid. */
  allowEmpty?: boolean | undefined;
}

/** Callbacks provided by the consumer during an OAuth flow. */
export interface OAuthCallbacks {
  /**
   * Called when the user needs to visit a URL to authorize.
   * The consumer should open the URL in a browser or display it.
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
   * Called when a callback-server OAuth flow offers the user to paste a
   * manual authorization code or redirect URL. pi races this against the
   * browser callback: the returned promise is the paste, and resolving it
   * ends the race (an empty string abandons the callback). `signal` aborts
   * when the callback wins, so the prompt can close; leave it pending
   * otherwise.
   */
  onManualCodeInput?: (signal?: AbortSignal) => Promise<string>;

  /**
   * Called when the OAuth flow needs the user to choose from provider-specific
   * options, such as Anthropic's login method or a Copilot endpoint. Without
   * it, the flow takes the first option, the provider's default.
   */
  onSelect?: (prompt: {
    message: string;
    options: Array<{ id: string; label: string }>;
  }) => Promise<string | undefined>;

  /**
   * Optional renderer for provider OAuth callback pages shown in the browser.
   *
   * Pi-ai does not expose a native callback page hook, so Cortex implements
   * this as a narrow Node.js compatibility shim. It only runs for known pi-ai
   * localhost callback routes and is restored immediately after the login flow.
   */
  renderCallbackPage?: OAuthCallbackPageRenderer | undefined;

  /**
   * Overall timeout for the OAuth flow, in milliseconds. pi-ai's
   * callback-server flows (e.g. Anthropic) do not honor an abort signal and
   * hang forever if the callback never arrives or arrives with an error, so
   * Cortex enforces this timeout itself and rejects with an
   * `OAuthError('timed_out')`. Defaults to 5 minutes. Pass `0` or a negative
   * value to disable (not recommended).
   */
  timeoutMs?: number | undefined;
}

/** Status of the browser callback page produced by an OAuth flow. */
export type OAuthCallbackPageStatus = 'success' | 'error';

/** Context passed to a custom OAuth callback page renderer. */
export interface OAuthCallbackPageContext {
  /** Provider identifier, e.g. "anthropic" or "openai-codex". */
  provider: string;
  /** Human-readable provider name when available. */
  providerName: string;
  /** Whether the callback response represents success or failure. */
  status: OAuthCallbackPageStatus;
  /** Page title extracted from pi-ai's default page. */
  title: string;
  /** Page heading extracted from pi-ai's default page. */
  heading: string;
  /** User-facing message extracted from pi-ai's default page. */
  message: string;
  /** Error details extracted from pi-ai's default page, if present. */
  details?: string | undefined;
  /** Callback path matched by the shim, without query parameters. */
  callbackPath: string;
  /** Local callback port matched by the shim. */
  callbackPort: number;
  /** Pi-ai's original generated page. */
  defaultHtml: string;
}

/**
 * Render custom HTML for the browser page shown after an OAuth callback.
 *
 * The renderer must be synchronous because Node's response end hook is
 * synchronous. If it throws or returns an empty string, Cortex falls back to
 * pi-ai's default page.
 */
export type OAuthCallbackPageRenderer = (context: OAuthCallbackPageContext) => string;

/** Display-safe metadata extracted at login time. */
export interface OAuthMeta {
  /** Provider identifier. */
  provider: string;
  /** Display name, email, or account identifier (if available). */
  displayName?: string | undefined;
  /** When the access token expires (Unix timestamp ms). Undefined if non-expiring. */
  expiresAt?: number | undefined;
  /** Whether the credential supports automatic refresh. */
  refreshable: boolean;
}

/** Result of a successful OAuth login. */
export interface OAuthResult {
  /**
   * Serialized credential payload. The consumer stores this (encrypted)
   * and passes it back to resolveOAuthApiKey() for refresh.
   * Treat as an opaque blob: encrypt, store, decrypt, pass back. Never parse.
   */
  credentials: string;
  /** Display-safe metadata extracted at login time. */
  meta: OAuthMeta;
}

/** Result of resolving/refreshing an OAuth API key. */
export interface OAuthRefreshResult {
  /**
   * The API key to use for LLM calls, when the provider authorizes with one.
   * Kimi Coding authorizes with a header instead: read `auth`.
   */
  apiKey?: string;
  /**
   * Everything the provider authorizes a request with: the key, auth
   * headers, and a per-account base URL (GitHub Copilot). Hand it to
   * AgentLoopConfig.getAuth.
   */
  auth: ModelAuth;
  /**
   * Credential payload (may be updated if refresh occurred).
   * Same format as OAuthResult.credentials.
   */
  credentials: string;
  /** Updated metadata. */
  meta: OAuthMeta;
  /** Whether the credentials were actually refreshed (true) or reused as-is (false). */
  changed: boolean;
}

/**
 * Discriminant for OAuth flow failures, so consumers can render specific
 * UX instead of parsing error strings.
 *
 * - `unsupported_provider`: provider has no OAuth support.
 * - `callback_port_in_use`: pi-ai could not bind a login's fixed loopback
 *   callback port and had no fallback for it. Anthropic falls back to a free
 *   port and Codex to a pasted redirect URL, so neither reports it.
 * - `cancelled`: the flow was cancelled via `cancelOAuth()`.
 * - `timed_out`: the flow exceeded its timeout (`OAuthCallbacks.timeoutMs`).
 * - `callback_failed`: the browser callback fired but the provider reported
 *   an error (e.g. state mismatch), surfaced as soon as the browser shows it.
 */
export type OAuthErrorCode =
  | 'unsupported_provider'
  | 'flow_in_progress'
  | 'callback_port_in_use'
  | 'cancelled'
  | 'timed_out'
  | 'callback_failed';

/** Structured error thrown by initiateOAuth. */
export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly provider: string;
  /** The fixed callback port, when relevant (`callback_port_in_use`). */
  readonly port?: number | undefined;

  constructor(
    code: OAuthErrorCode,
    provider: string,
    message: string,
    options?: { port?: number | undefined; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'OAuthError';
    this.code = code;
    this.provider = provider;
    this.port = options?.port;
  }
}
