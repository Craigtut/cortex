/**
 * The callback-page shim recognizes the pages the installed pi-ai actually
 * renders. The shim matches pi's page by its markup, so a pi release that
 * changes the page would silently leave the default, unbranded one in the
 * browser; the other tests run on a copy of the page, which cannot notice.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createProvider } from '@earendil-works/pi-ai';
import type { OAuthCredential } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { oauthErrorHtml, oauthSuccessHtml } from '@earendil-works/pi-ai/utils/oauth-page';
import { ProviderManager } from '../../src/provider-manager.js';
import type { ModelRuntime } from '../../src/model-runtime.js';

/**
 * A login whose browser callback gets `html` from a loopback server, as pi's
 * callback server serves it. Resolves with the flow's outcome and the body
 * the browser received, read to the end even when the flow settles first.
 */
async function loginServing(html: string): Promise<{ outcome: string; body: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const manager = new ProviderManager();
  const runtime = (manager as unknown as { runtime(): ModelRuntime }).runtime();
  let browser!: Promise<string>;
  runtime.models.setProvider(createProvider({
    id: 'fake-oauth',
    name: 'Fake',
    auth: {
      oauth: {
        name: 'Fake',
        refresh: async (credential: OAuthCredential) => credential,
        toAuth: async () => ({ apiKey: 'k' }),
        login: async (interaction) => {
          interaction.notify({
            type: 'auth_url',
            url: `https://example.test/authorize?redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`,
          });
          browser = fetch(`http://localhost:${port}/callback?code=c`).then((response) => response.text());
          await browser;
          return { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 };
        },
      },
    },
    models: [],
    api: anthropicMessagesApi(),
  }));
  try {
    const outcome = await manager.initiateOAuth('fake-oauth', {
      onAuth: () => {},
      onPrompt: async () => '',
      renderCallbackPage: (context) => `<html>BRANDED ${context.status}: ${context.message}</html>`,
    }).then(() => 'signed in', (error: { code?: string }) => error.code ?? 'failed');
    return { outcome, body: await browser };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("the callback page shim on pi-ai's own pages", () => {
  it("brands pi's success page", async () => {
    const { outcome, body } = await loginServing(oauthSuccessHtml('Signed in to Fake. You may now close this page.'));

    expect(outcome).toBe('signed in');
    expect(body).toBe('<html>BRANDED success: Signed in to Fake. You may now close this page.</html>');
  });

  it("brands pi's error page, and the flow fails with callback_failed", async () => {
    const { outcome, body } = await loginServing(oauthErrorHtml('Fake authorization failed.', 'access_denied'));

    expect(outcome).toBe('callback_failed');
    // The browser gets the branded page, not an empty body, even though
    // the flow settled before the browser finished reading it.
    expect(body).toBe('<html>BRANDED error: Fake authorization failed.</html>');
  });
});
