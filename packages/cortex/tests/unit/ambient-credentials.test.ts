/**
 * Cortex ignores ambient credentials unless the consumer opts in. pi-ai's
 * retired `/compat` dispatch read provider env vars (`ANTHROPIC_API_KEY`)
 * whenever a request carried no key, so an agent whose consumer supplied no
 * `getApiKey` silently spent whatever key the environment held.
 *
 * The model points at a local server standing in for Anthropic, so the test
 * sees exactly which credentials a request would have carried.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import { ProviderManager } from '../../src/provider-manager.js';
import { unwrapModel, wrapModel } from '../../src/model-wrapper.js';
import type { CortexModel } from '../../src/model-wrapper.js';
import { TOOL_NAMES } from '../../src/tools/index.js';

const ENV_KEY = 'sk-ant-from-the-environment';

/** A server that records each request's API key header and refuses it. */
async function anthropicStandIn(): Promise<{ baseUrl: string; keys: string[]; close: () => Promise<void> }> {
  const keys: string[] = [];
  const server = createServer((request, response) => {
    keys.push(String(request.headers['x-api-key'] ?? request.headers['authorization'] ?? ''));
    request.resume();
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'stand-in' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    keys,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function modelAt(baseUrl: string): Promise<CortexModel> {
  const manager = new ProviderManager();
  const catalog = await manager.listModels('anthropic');
  const model = await manager.resolveModel('anthropic', catalog[0]!.id);
  return wrapModel({ ...(unwrapModel(model) as Record<string, unknown>), baseUrl }, 'anthropic', model.modelId);
}

async function loopAt(baseUrl: string, ambientCredentials?: boolean): Promise<AgentLoop> {
  return AgentLoop.create({
    model: await modelAt(baseUrl),
    workingDirectory: process.cwd(),
    initialBasePrompt: 'Test credential resolution.',
    ...(ambientCredentials !== undefined ? { ambientCredentials } : {}),
    disableTools: Object.values(TOOL_NAMES),
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
  });
}

describe('ambient credentials', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.unstubAllEnvs();
  });

  it('never sends a provider env var key when no getApiKey supplies one', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ENV_KEY);
    const server = await anthropicStandIn();
    cleanups.push(server.close);
    const loop = await loopAt(server.baseUrl);
    cleanups.push(() => loop.destroy());

    await expect(loop.directComplete({ systemPrompt: 'System', messages: [{ role: 'user', content: 'Hi' }] }))
      .rejects.toThrow(/not configured/i);
    await expect(loop.prompt('Hi')).rejects.toThrow(/not configured/i);

    expect(server.keys).not.toContain(ENV_KEY);
    expect(server.keys).toEqual([]);
  });

  it('uses the environment key when the consumer opts in', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', ENV_KEY);
    const server = await anthropicStandIn();
    cleanups.push(server.close);
    const loop = await loopAt(server.baseUrl, true);
    cleanups.push(() => loop.destroy());

    await expect(loop.directComplete({ systemPrompt: 'System', messages: [{ role: 'user', content: 'Hi' }] }))
      .rejects.toThrow();

    // The positive precondition for the test above: this route does reach
    // the server, and with the environment's key.
    expect(server.keys).toContain(ENV_KEY);
  });
});
