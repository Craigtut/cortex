import { describe, it, expect } from 'vitest';
import { builtinProviders, getBuiltinModel, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import {
  PROVIDER_REGISTRY,
  OAUTH_PROVIDER_IDS,
  UTILITY_MODEL_DEFAULTS,
  UTILITY_MODEL_OVERRIDES,
} from '../../src/provider-registry.js';
import { PRIMARY_MODEL_DEFAULTS } from '../../src/model-defaults.js';

describe('provider-registry', () => {
  // -----------------------------------------------------------------------
  // PROVIDER_REGISTRY
  // -----------------------------------------------------------------------

  describe('PROVIDER_REGISTRY', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(PROVIDER_REGISTRY)).toBe(true);
      expect(PROVIDER_REGISTRY.length).toBeGreaterThan(0);
    });

    it('contains Anthropic', () => {
      const anthropic = PROVIDER_REGISTRY.find(p => p.id === 'anthropic');
      expect(anthropic).toBeDefined();
      expect(anthropic!.name).toBe('Anthropic');
      expect(anthropic!.authMethods).toContain('oauth');
      expect(anthropic!.authMethods).toContain('api_key');
      expect(anthropic!.envVar).toBe('ANTHROPIC_API_KEY');
      expect(anthropic!.keyPrefix).toBe('sk-ant-');
    });

    it('contains OpenAI', () => {
      const openai = PROVIDER_REGISTRY.find(p => p.id === 'openai');
      expect(openai).toBeDefined();
      expect(openai!.name).toBe('OpenAI');
      expect(openai!.authMethods).toContain('api_key');
      expect(openai!.envVar).toBe('OPENAI_API_KEY');
    });

    it('contains Google', () => {
      const google = PROVIDER_REGISTRY.find(p => p.id === 'google');
      expect(google).toBeDefined();
      expect(google!.envVar).toBe('GEMINI_API_KEY');
    });

    it('contains OpenAI Codex (OAuth only)', () => {
      const codex = PROVIDER_REGISTRY.find(p => p.id === 'openai-codex');
      expect(codex).toBeDefined();
      expect(codex!.authMethods).toEqual(['oauth']);
      expect(codex!.envVar).toBeUndefined();
    });

    it('contains GitHub Copilot (OAuth only)', () => {
      const copilot = PROVIDER_REGISTRY.find(p => p.id === 'github-copilot');
      expect(copilot).toBeDefined();
      expect(copilot!.authMethods).toEqual(['oauth']);
    });

    it('contains Mistral, Groq, Cerebras, xAI, OpenRouter', () => {
      const expectedApiKeyProviders = ['mistral', 'groq', 'cerebras', 'xai', 'openrouter'];
      for (const id of expectedApiKeyProviders) {
        const provider = PROVIDER_REGISTRY.find(p => p.id === id);
        expect(provider, `Expected provider "${id}" to exist`).toBeDefined();
        expect(provider!.authMethods).toContain('api_key');
        expect(provider!.envVar).toBeDefined();
      }
    });

    it('has unique IDs', () => {
      const ids = PROVIDER_REGISTRY.map(p => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('every entry has required fields', () => {
      for (const entry of PROVIDER_REGISTRY) {
        expect(typeof entry.id).toBe('string');
        expect(entry.id.length).toBeGreaterThan(0);
        expect(typeof entry.name).toBe('string');
        expect(entry.name.length).toBeGreaterThan(0);
        expect(Array.isArray(entry.authMethods)).toBe(true);
        expect(entry.authMethods.length).toBeGreaterThan(0);

        // Validate auth methods are valid values
        for (const method of entry.authMethods) {
          expect(['oauth', 'api_key']).toContain(method);
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // OAUTH_PROVIDER_IDS
  // -----------------------------------------------------------------------

  describe('OAUTH_PROVIDER_IDS', () => {
    it('contains expected OAuth providers', () => {
      expect(OAUTH_PROVIDER_IDS).toContain('anthropic');
      expect(OAUTH_PROVIDER_IDS).toContain('openai-codex');
      expect(OAUTH_PROVIDER_IDS).toContain('github-copilot');
      expect(OAUTH_PROVIDER_IDS).not.toContain('google-gemini-cli');
      expect(OAUTH_PROVIDER_IDS).not.toContain('google-antigravity');
    });

    it('does not contain API-key-only providers', () => {
      expect(OAUTH_PROVIDER_IDS).not.toContain('openai');
      expect(OAUTH_PROVIDER_IDS).not.toContain('mistral');
      expect(OAUTH_PROVIDER_IDS).not.toContain('groq');
    });

    it('every OAuth provider ID exists in PROVIDER_REGISTRY', () => {
      for (const id of OAUTH_PROVIDER_IDS) {
        expect(PROVIDER_REGISTRY.some(provider => provider.id === id), `Missing provider "${id}"`).toBe(true);
      }
    });
  });

  // -----------------------------------------------------------------------
  // UTILITY_MODEL_OVERRIDES
  // -----------------------------------------------------------------------

  describe('UTILITY_MODEL_OVERRIDES', () => {
    it('is empty by default so utility models are inferred dynamically', () => {
      expect(UTILITY_MODEL_OVERRIDES).toEqual({});
    });

    it('keeps UTILITY_MODEL_DEFAULTS as a backwards-compatible alias', () => {
      expect(UTILITY_MODEL_DEFAULTS).toBe(UTILITY_MODEL_OVERRIDES);
    });
  });

  // -----------------------------------------------------------------------
  // Agreement with the installed pi-ai catalog
  // -----------------------------------------------------------------------

  describe('against the installed pi-ai catalog', () => {
    // Providers that serve no chat models (pi-ai's classifier-only
    // `typesafe`) have nothing for an agent to run, so Cortex does not list them.
    const piProviders = builtinProviders().filter((provider) => getBuiltinModels(provider.id as never).length > 0);

    it('names only providers pi-ai ships', () => {
      const piIds = new Set(piProviders.map((provider) => provider.id));
      expect(PROVIDER_REGISTRY.map((provider) => provider.id).filter((id) => !piIds.has(id))).toEqual([]);
    });

    it('lists as OAuth only providers whose pi-ai definition has an OAuth flow', () => {
      const oauthCapable = piProviders.filter((provider) => provider.auth?.oauth).map((provider) => provider.id);
      expect(OAUTH_PROVIDER_IDS.filter((id) => !oauthCapable.includes(id))).toEqual([]);
      expect(OAUTH_PROVIDER_IDS).toEqual(expect.arrayContaining(['meta', 'radius']));
    });

    it('lists every provider pi-ai ships', () => {
      const registered = new Set(PROVIDER_REGISTRY.map((provider) => provider.id));
      expect(piProviders.map((provider) => provider.id).filter((id) => !registered.has(id))).toEqual([]);
    });

    it('defaults every registered provider to a model its catalog has', () => {
      const missing = PROVIDER_REGISTRY
        .map((provider) => [provider.id, PRIMARY_MODEL_DEFAULTS[provider.id]] as const)
        .filter(([provider, modelId]) =>
          modelId === undefined || getBuiltinModel(provider as never, modelId as never) === undefined)
        .map(([provider, modelId]) => `${provider}/${String(modelId)}`);
      expect(missing).toEqual([]);
    });
  });
});
