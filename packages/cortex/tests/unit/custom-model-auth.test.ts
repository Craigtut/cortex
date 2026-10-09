/**
 * A custom endpoint's configured key reaches its requests. `createCustomModel()`
 * accepts an `apiKey`, but it was stamped on the pi model, which pi never
 * reads: with no key from the consumer's callback, a request failed with
 * "Provider is not configured: custom" and the configured key was never sent.
 *
 * The model points at a local server standing in for an OpenAI-compatible
 * endpoint, so the test sees exactly which key a request carried.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../src/types.js';
import { ProviderManager } from '../../src/provider-manager.js';
import { TOOL_NAMES } from '../../src/tools/index.js';

/** A server that records each request's bearer token and refuses the request. */
async function endpointStandIn(): Promise<{ baseUrl: string; tokens: string[]; close: () => Promise<void> }> {
  const tokens: string[] = [];
  const server = createServer((request, response) => {
    tokens.push(String(request.headers['authorization'] ?? ''));
    request.resume();
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'stand-in', type: 'invalid_request_error' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    tokens,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function loopAt(
  baseUrl: string,
  apiKey: string | undefined,
  credentials: Pick<AgentLoopConfig, 'getApiKey' | 'getAuth'> = {},
): Promise<AgentLoop> {
  const model = await new ProviderManager().createCustomModel({
    baseUrl,
    modelId: 'local-model',
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
  return AgentLoop.create({
    model,
    workingDirectory: process.cwd(),
    initialBasePrompt: 'Test custom endpoint credentials.',
    ...credentials,
    disableTools: Object.values(TOOL_NAMES),
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
  });
}

const ask = { systemPrompt: 'System', messages: [{ role: 'user' as const, content: 'Hi' }] };

describe('custom endpoint credentials', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function serve(): Promise<Awaited<ReturnType<typeof endpointStandIn>>> {
    const server = await endpointStandIn();
    cleanups.push(server.close);
    return server;
  }

  it('sends the configured key when no callback supplies one', async () => {
    const server = await serve();
    const loop = await loopAt(server.baseUrl, 'sk-configured');
    cleanups.push(() => loop.destroy());

    await expect(loop.directComplete(ask)).rejects.toThrow();
    await loop.prompt('Hi').catch(() => undefined);

    expect(server.tokens).toEqual(['Bearer sk-configured', 'Bearer sk-configured']);
  });

  it('sends the configured key when getAuth returns nothing', async () => {
    const server = await serve();
    const loop = await loopAt(server.baseUrl, 'sk-configured', { getAuth: async () => undefined });
    cleanups.push(() => loop.destroy());

    await expect(loop.directComplete(ask)).rejects.toThrow();

    expect(server.tokens).toEqual(['Bearer sk-configured']);
  });

  it("prefers the callback's key over the configured one", async () => {
    const server = await serve();
    const loop = await loopAt(server.baseUrl, 'sk-configured', { getApiKey: async () => 'sk-from-callback' });
    cleanups.push(() => loop.destroy());

    await expect(loop.directComplete(ask)).rejects.toThrow();

    expect(server.tokens).toEqual(['Bearer sk-from-callback']);
  });

  it('reaches a keyless endpoint with a placeholder key', async () => {
    const server = await serve();
    const loop = await loopAt(server.baseUrl, undefined);
    cleanups.push(() => loop.destroy());

    await expect(loop.directComplete(ask)).rejects.toThrow();

    expect(server.tokens).toEqual(['Bearer sk-no-key-required']);
  });
});
