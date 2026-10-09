/**
 * Cortex ignores ambient credentials unless the consumer opts in. pi-ai's
 * retired `/compat` dispatch read provider env vars (`ANTHROPIC_API_KEY`)
 * whenever a request carried no key, so an agent whose consumer supplied no
 * `getApiKey` silently spent whatever key the environment held.
 *
 * The model points at a local server standing in for Anthropic, so the test
 * sees exactly which credentials a request would have carried.
 */

import * as fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import { getModelRuntime, streamModel, streamModelSimple } from '../../src/model-runtime.js';
import { ProviderManager } from '../../src/provider-manager.js';
import { PROVIDER_REGISTRY } from '../../src/provider-registry.js';
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

/** A server that records every request in full and refuses it. */
async function recordingServer(): Promise<{ origin: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      requests.push(`${request.method} ${request.url} ${JSON.stringify(request.headers)} ${body}`);
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'stand-in' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Every ambient credential source pi's request code reads on its own, set to
 * values the stand-in can spot: provider key env vars, Anthropic workload
 * identity federation, and the AWS chain (over HTTP/1, which the stand-in
 * speaks). Vertex ADC points at a file that does not exist, so reading it
 * shows in the failure instead of reaching Google's token endpoint.
 */
function setAmbientCredentials(dir: string): string[] {
  const secrets: string[] = [];
  for (const entry of PROVIDER_REGISTRY) {
    if (!entry.envVar) continue;
    const value = `env-secret-${entry.envVar.toLowerCase()}`;
    vi.stubEnv(entry.envVar, value);
    secrets.push(value);
  }
  const identityToken = path.join(dir, 'identity-token');
  fs.writeFileSync(identityToken, 'federated.identity.jwt');
  vi.stubEnv('ANTHROPIC_FEDERATION_RULE_ID', 'fdrl_ambient');
  vi.stubEnv('ANTHROPIC_ORGANIZATION_ID', 'org_ambient');
  vi.stubEnv('ANTHROPIC_IDENTITY_TOKEN_FILE', identityToken);
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'env-bedrock-bearer');
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIAAMBIENTTEST');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-secret-access-key');
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('AWS_BEDROCK_FORCE_HTTP1', '1');
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', path.join(dir, ADC_FILE));
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'ambient-project');
  vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
  secrets.push('federated.identity.jwt', 'env-bedrock-bearer', 'AKIAAMBIENTTEST');
  return secrets;
}

/** One chat model of every built-in provider, pointed at the stand-in. */
function everyProviderModel(origin: string): Array<Model<Api>> {
  return getModelRuntime().models.getProviders()
    .map((provider) => provider.getModels()[0])
    .filter((model): model is Model<Api> => model !== undefined)
    .map((model) => ({ ...model, baseUrl: origin }));
}

const ADC_FILE = 'ambient-adc-credentials.json';

const ASK = { messages: [{ role: 'user' as const, content: 'Hi', timestamp: 0 }] };
const HEADER_ONLY = { headers: { 'x-proxy-route': 'team-a' } };

describe('caller auth that is headers only', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.unstubAllEnvs();
  });

  async function standIn(): Promise<{ origin: string; requests: string[]; secrets: string[] }> {
    const server = await recordingServer();
    cleanups.push(server.close);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ambient-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { ...server, secrets: setAmbientCredentials(dir) };
  }

  /**
   * Requests that carried an ambient secret or exchanged one for a token, and
   * failures that come from reading an ambient credential file.
   */
  function ambientUse(requests: string[], secrets: string[], failures: string[] = []): string[] {
    return [
      ...requests.filter((request) =>
        secrets.some((secret) => request.includes(secret)) || /^POST \/v1\/oauth\/token\b/.test(request)),
      ...failures.filter((failure) => failure.includes(ADC_FILE)),
    ];
  }

  it('uses no ambient credential with any built-in provider', async () => {
    const { origin, requests, secrets } = await standIn();
    const models = everyProviderModel(origin);
    // Precondition: the sweep covers the providers with ambient fallbacks.
    expect(models.map((model) => model.provider)).toEqual(
      expect.arrayContaining(['anthropic', 'amazon-bedrock', 'google-vertex', 'openai']),
    );

    const failures: string[] = [];
    for (const model of models) {
      for (const result of [
        await streamModel(model, ASK, { auth: HEADER_ONLY }).result(),
        await streamModelSimple(model, ASK, { auth: HEADER_ONLY }).result(),
      ]) failures.push(`${model.provider}: ${result.errorMessage ?? ''}`);
    }

    expect(ambientUse(requests, secrets, failures)).toEqual([]);
  });

  it('guard: does use them when the consumer opts in', async () => {
    const { origin, requests, secrets } = await standIn();
    const anthropic = everyProviderModel(origin).find((model) => model.provider === 'anthropic')!;

    await streamModel(anthropic, ASK, { auth: HEADER_ONLY, ambientCredentials: true }).result();

    // The positive precondition for the sweep above: the stand-in sees the
    // federation exchange when ambient credentials are allowed.
    expect(ambientUse(requests, secrets)).not.toEqual([]);
  });

  it('still sends a request whose headers authorize it', async () => {
    const { origin, requests, secrets } = await standIn();
    const anthropic = everyProviderModel(origin).find((model) => model.provider === 'anthropic')!;

    await streamModel(anthropic, ASK, { auth: { headers: { authorization: 'Bearer gateway-token' } } }).result();

    expect(requests).toEqual([expect.stringContaining('gateway-token')]);
    expect(ambientUse(requests, secrets)).toEqual([]);
  });
});
