/**
 * The OAuth callback page shim: the one process-global patch of
 * `http.ServerResponse.prototype.end` that lets a consumer render pi-ai's
 * localhost callback page and lets a flow observe the callback's outcome,
 * plus the providers' preferred callback routes. pi-ai has no page renderer
 * hook, so Cortex keeps this patch.
 */

import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  OAuthCallbackPageContext,
  OAuthCallbackPageRenderer,
  OAuthCallbackPageStatus,
} from './oauth-types.js';

const nodeRequire = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// OAuth callback page rendering shim
// ---------------------------------------------------------------------------

/**
 * A provider's preferred loopback OAuth callback route. pi-ai binds it when
 * it can: Anthropic falls back to a free port and Codex to a pasted redirect
 * URL when it is taken, and OpenRouter always picks an ephemeral port and a
 * random path. The flow learns the real one from the authorization URL's
 * redirect parameter.
 */
export interface OAuthCallbackRoute {
  readonly path: string;
  readonly port: number;
}

export const OAUTH_CALLBACK_ROUTES: Record<string, OAuthCallbackRoute> = {
  anthropic: { path: '/callback', port: 53692 },
  'openai-codex': { path: '/auth/callback', port: 1455 },
};

interface ActiveOAuthCallbackPageShim {
  readonly provider: string;
  readonly providerName: string;
  /** The callback path the flow is waiting on; null until known. */
  callbackPath: string | null;
  readonly render: OAuthCallbackPageRenderer | undefined;
  /**
   * Notified exactly once when the browser callback fires and its status
   * (success/error) is known, so the flow can fail with Cortex's typed
   * error as soon as the browser shows the failure.
   */
  readonly onResult?: ((status: OAuthCallbackPageStatus, context: OAuthCallbackPageContext) => void) | undefined;
}

/** A flow's handle on the installed shim. */
export interface OAuthCallbackShim {
  /** Match callbacks on the loopback URL the authorization request redirects to. */
  expect(callback: LoopbackCallback): void;
  /** Uninstall the shim. Safe to call more than once. */
  release(): void;
}

/** Where pi's callback server is listening for this flow. */
export interface LoopbackCallback {
  port: number;
  path: string;
}

type ServerResponseEnd = ServerResponse['end'];

let activeOAuthCallbackPageShim: ActiveOAuthCallbackPageShim | null = null;
/** Ensures `onResult` fires at most once per installed shim. */
let oauthCallbackResultNotified = false;

const NO_SHIM: OAuthCallbackShim = { expect: () => {}, release: () => {} };

/**
 * The loopback callback an authorization URL redirects to (its
 * `redirect_uri` or `callback_url` parameter), or null when it redirects
 * elsewhere (a copy-code login, a device code page).
 */
export function loopbackCallbackOf(authorizationUrl: string): LoopbackCallback | null {
  let params: URLSearchParams;
  try {
    params = new URL(authorizationUrl).searchParams;
  } catch {
    return null;
  }
  for (const name of ['redirect_uri', 'callback_url']) {
    const value = params.get(name);
    if (!value) continue;
    try {
      const target = new URL(value);
      if (target.protocol !== 'http:' || !isLoopbackHostname(target.hostname)) continue;
      return { port: target.port ? Number(target.port) : 80, path: target.pathname };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Install the callback-page shim for a flow when there is something to do
 * with the callback (a custom renderer and/or a result observer). Matching
 * starts on the provider's preferred route path and follows
 * {@link OAuthCallbackShim.expect} once the flow knows the real callback.
 *
 * Unlike a `try/finally` wrapper around pi-ai's `login()`, the caller owns
 * the release lifecycle, tied to the flow's own race and timeout.
 */
export function maybeInstallOAuthCallbackShim(
  provider: string,
  providerName: string,
  render: OAuthCallbackPageRenderer | undefined,
  onResult: ActiveOAuthCallbackPageShim['onResult'],
  routes: Record<string, OAuthCallbackRoute>,
): OAuthCallbackShim {
  if (!render && !onResult) return NO_SHIM;

  const shim: ActiveOAuthCallbackPageShim = {
    provider,
    providerName,
    callbackPath: routes[provider]?.path ?? null,
    render,
    onResult,
  };
  const release = installOAuthCallbackPageShim(shim);
  return {
    expect: (callback) => {
      shim.callbackPath = callback.path;
    },
    release,
  };
}

function installOAuthCallbackPageShim(shim: ActiveOAuthCallbackPageShim): () => void {
  if (activeOAuthCallbackPageShim) {
    throw new Error(
      `An OAuth callback page renderer is already active for provider "${activeOAuthCallbackPageShim.provider}".`,
    );
  }

  const http = nodeRequire('node:http') as typeof import('node:http');
  const prototype = http.ServerResponse.prototype;
  const previousEnd = prototype.end;
  activeOAuthCallbackPageShim = shim;
  oauthCallbackResultNotified = false;

  const patchedEnd = function patchedOAuthCallbackEnd(this: ServerResponse, ...args: unknown[]) {
    const replacement = maybeRenderOAuthCallbackPage(this, args[0]);
    if (replacement) {
      args[0] = replacement;
    }

    return Reflect.apply(previousEnd, this, args) as ReturnType<ServerResponseEnd>;
  } as ServerResponseEnd;

  prototype.end = patchedEnd;

  return () => {
    if (activeOAuthCallbackPageShim === shim) {
      activeOAuthCallbackPageShim = null;
    }

    if (prototype.end === patchedEnd) {
      prototype.end = previousEnd;
    }
  };
}

function maybeRenderOAuthCallbackPage(response: ServerResponse, chunk: unknown): string | null {
  const shim = activeOAuthCallbackPageShim;
  if (!shim?.callbackPath) return null;

  const request = (response as ServerResponse & { req?: IncomingMessage | undefined }).req;
  if (!request || request.method !== 'GET' || !request.url) return null;

  // The port pi bound: its preferred one, a fallback, or an ephemeral one.
  const port = response.socket?.localPort;
  if (port === undefined) return null;

  let url: URL;
  try {
    url = new URL(request.url, `http://localhost:${port}`);
  } catch {
    return null;
  }

  if (url.pathname !== shim.callbackPath) return null;
  if (!isExpectedLocalCallbackHost(request.headers.host, port)) return null;

  const contentType = response.getHeader('content-type');
  if (typeof contentType === 'string' && !contentType.toLowerCase().includes('text/html')) {
    return null;
  }

  const defaultHtml = responseChunkToString(chunk);
  if (!defaultHtml || !looksLikePiOAuthPage(defaultHtml)) return null;

  const status = extractOAuthCallbackPageStatus(defaultHtml);
  if (!status) return null;

  const details = extractHtmlClassText(defaultHtml, 'details');
  const context: OAuthCallbackPageContext = {
    provider: shim.provider,
    providerName: shim.providerName,
    status,
    title: extractHtmlTagText(defaultHtml, 'title') ?? defaultOAuthCallbackTitle(status),
    heading: extractHtmlTagText(defaultHtml, 'h1') ?? defaultOAuthCallbackTitle(status),
    message: extractHtmlTagText(defaultHtml, 'p') ?? defaultOAuthCallbackMessage(status),
    callbackPath: shim.callbackPath,
    callbackPort: port,
    defaultHtml,
  };
  if (details !== undefined) {
    context.details = details;
  }

  if (!oauthCallbackResultNotified && shim.onResult) {
    oauthCallbackResultNotified = true;
    try {
      shim.onResult(status, context);
    } catch {
      // An observer must never break the callback response.
    }
  }

  if (!shim.render) return null;
  try {
    const rendered = shim.render(context);
    return typeof rendered === 'string' && rendered.trim().length > 0 ? rendered : null;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

function isExpectedLocalCallbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;

  try {
    const url = new URL(`http://${host}`);
    const hostname = url.hostname.toLowerCase();
    const parsedPort = url.port ? Number(url.port) : 80;
    return (
      parsedPort === port
      && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function responseChunkToString(chunk: unknown): string | null {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8');
  return null;
}

function looksLikePiOAuthPage(html: string): boolean {
  return (
    html.includes('<title>Authentication successful</title>')
    || html.includes('<title>Authentication failed</title>')
  );
}

function extractOAuthCallbackPageStatus(html: string): OAuthCallbackPageStatus | null {
  if (html.includes('<title>Authentication successful</title>')) return 'success';
  if (html.includes('<title>Authentication failed</title>')) return 'error';
  return null;
}

function defaultOAuthCallbackTitle(status: OAuthCallbackPageStatus): string {
  return status === 'success' ? 'Authentication successful' : 'Authentication failed';
}

function defaultOAuthCallbackMessage(status: OAuthCallbackPageStatus): string {
  return status === 'success' ? 'Authentication completed.' : 'Authentication failed.';
}

function extractHtmlTagText(html: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlText(match[1]) : undefined;
}

function extractHtmlClassText(html: string, className: string): string | undefined {
  const pattern = new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  const match = html.match(pattern);
  return match?.[1] ? decodeHtmlText(match[1]) : undefined;
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .trim();
}
