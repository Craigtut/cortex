/**
 * A failed OAuth refresh is classified by its cause. pi-ai wraps every
 * refresh failure as "OAuth refresh failed for <provider>: <cause>", which
 * Cortex's authentication patterns matched, so a network blip or a token
 * endpoint's 5xx during a refresh (GitHub Copilot refreshes about every 25
 * minutes) became a fatal, never-retried authentication error with
 * "re-authenticate" advice. Only a cause that is not transient is.
 */

import { describe, expect, it } from 'vitest';
import { createProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Provider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { AgentLoop } from '../../src/agent-loop.js';
import { classifyError } from '../../src/error-classifier.js';
import { ProviderManager } from '../../src/provider-manager.js';
import type { ModelRuntime } from '../../src/model-runtime.js';
import { TOOL_NAMES } from '../../src/tools/index.js';

const ANTHROPIC_REFRESH_FAILURE = (status: number, body: string): string =>
  `OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=${status}; url=https://platform.claude.com/v1/oauth/token; body=${body}`;

describe('credential failure classification', () => {
  it('classifies a refresh that failed on the network as a network error', () => {
    expect(classifyError('OAuth refresh failed for github-copilot: fetch failed').category).toBe('network');
  });

  it("classifies a token endpoint's 5xx during a refresh as a server error", () => {
    expect(classifyError(ANTHROPIC_REFRESH_FAILURE(503, '{"error":"service unavailable"}')).category)
      .toBe('server_error');
  });

  it('guard: keeps a refresh the provider refused an authentication error', () => {
    const result = classifyError(ANTHROPIC_REFRESH_FAILURE(400, '{"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}'));
    expect(result.category).toBe('authentication');
    expect(result.severity).toBe('fatal');
    expect(classifyError('OAuth refresh failed for anthropic').category).toBe('authentication');
  });

  it('retries a turn whose OAuth refresh failed on the network', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('anthropic', async () => ({ type: 'oauth', access: 'old', refresh: 'r1', expires: Date.now() - 1_000 }));
    const manager = new ProviderManager({ credentials });
    // The real Anthropic provider, with a refresh that fails like a dropped connection.
    const runtime = (manager as unknown as { runtime(): ModelRuntime }).runtime();
    const real = runtime.models.getProvider('anthropic') as Provider;
    runtime.models.setProvider(createProvider({
      id: 'anthropic',
      name: real.name,
      auth: {
        ...(real.auth.apiKey ? { apiKey: real.auth.apiKey } : {}),
        oauth: {
          name: 'Anthropic',
          login: async () => { throw new Error('not in this test'); },
          refresh: async () => { throw new TypeError('fetch failed'); },
          toAuth: async (credential) => ({ apiKey: credential.access }),
        },
      },
      models: real.getModels(),
      api: anthropicMessagesApi(),
    }));
    const loop = await AgentLoop.create({
      model: await manager.resolveModel('anthropic', 'claude-haiku-5-5'),
      workingDirectory: process.cwd(),
      initialBasePrompt: 'Test refresh failures.',
      getAuth: (provider) => manager.getAuth(provider),
      retryPolicy: { backoffMs: [5], maxBackoffMs: 5, maxAttempts: 1 },
      disableTools: Object.values(TOOL_NAMES),
      enableSubAgentTool: false,
      enableLoadSkillTool: false,
    });
    const scheduled: string[] = [];
    const errors: string[] = [];
    loop.onRetryScheduled((info) => scheduled.push(info.category));
    loop.onError((error) => errors.push(error.category));

    await expect(loop.prompt('hi')).rejects.toThrow(/OAuth refresh failed for anthropic: fetch failed/);
    await loop.destroy();

    expect(scheduled).toEqual(['network']);
    expect(errors).toEqual(['network']);
  });
});
