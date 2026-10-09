import { describe, it, expect } from 'vitest';
import {
  resolveCacheRetention,
  resolvePromptCacheTtlMs,
  PROVIDER_CACHE_CONFIG,
} from '../../src/provider-registry.js';
import { CompactionManager, buildCompactionConfig } from '../../src/compaction/index.js';
import { ProviderManager } from '../../src/provider-manager.js';

describe('provider-cache', () => {
  // -----------------------------------------------------------------------
  // PROVIDER_CACHE_CONFIG structure
  // -----------------------------------------------------------------------

  describe('PROVIDER_CACHE_CONFIG', () => {
    it('anthropic has preferLong = false', () => {
      expect(PROVIDER_CACHE_CONFIG['anthropic'].preferLong).toBe(false);
    });

    it('openai has preferLong = true', () => {
      expect(PROVIDER_CACHE_CONFIG['openai'].preferLong).toBe(true);
    });

    it('anthropic is supported', () => {
      expect(PROVIDER_CACHE_CONFIG['anthropic'].supported).toBe(true);
    });

    it('openai is supported', () => {
      expect(PROVIDER_CACHE_CONFIG['openai'].supported).toBe(true);
    });

    it('bedrock is supported', () => {
      expect(PROVIDER_CACHE_CONFIG['amazon-bedrock'].supported).toBe(true);
    });

    it('google is not supported', () => {
      expect(PROVIDER_CACHE_CONFIG['google'].supported).toBe(false);
    });

    it('mistral is not supported', () => {
      expect(PROVIDER_CACHE_CONFIG['mistral'].supported).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // resolveCacheRetention — Anthropic
  // -----------------------------------------------------------------------

  describe('resolveCacheRetention — Anthropic', () => {
    it('returns "long" for a 5 min interval (300,000ms) because it exceeds the 90% safety margin', () => {
      // shortTtlMs = 300,000, safety margin = 0.9, so threshold = 270,000ms
      // 300,000 > 270,000, so the interval does NOT fit within the short TTL window
      expect(resolveCacheRetention('anthropic', 300_000)).toBe('long');
    });

    it('returns "long" for a 30 min interval (1,800,000ms)', () => {
      expect(resolveCacheRetention('anthropic', 1_800_000)).toBe('long');
    });

    it('returns "short" at exactly the boundary (270,000ms)', () => {
      // shortThreshold = 300,000 * 0.9 = 270,000
      // 270,000 <= 270,000 => true => "short"
      expect(resolveCacheRetention('anthropic', 270_000)).toBe('short');
    });

    it('returns "long" just over the boundary (271,000ms)', () => {
      // 271,000 <= 270,000 => false => "long"
      expect(resolveCacheRetention('anthropic', 271_000)).toBe('long');
    });

    it('returns "long" for a very long interval (2 hours)', () => {
      const twoHours = 2 * 60 * 60 * 1000; // 7,200,000ms
      expect(resolveCacheRetention('anthropic', twoHours)).toBe('long');
    });

    it('returns "short" for a very short interval (1 min)', () => {
      expect(resolveCacheRetention('anthropic', 60_000)).toBe('short');
    });
  });

  // -----------------------------------------------------------------------
  // resolveCacheRetention — OpenAI
  // -----------------------------------------------------------------------

  describe('resolveCacheRetention — OpenAI', () => {
    it('always returns "long" regardless of interval (free writes)', () => {
      expect(resolveCacheRetention('openai', 1_800_000)).toBe('long');
    });

    it('returns "long" even with a short interval', () => {
      expect(resolveCacheRetention('openai', 60_000)).toBe('long');
    });

    it('returns "long" with a very long interval', () => {
      const twoHours = 2 * 60 * 60 * 1000;
      expect(resolveCacheRetention('openai', twoHours)).toBe('long');
    });
  });

  // -----------------------------------------------------------------------
  // resolveCacheRetention — Bedrock
  // -----------------------------------------------------------------------

  describe('resolveCacheRetention — Bedrock', () => {
    it('returns "short" at 5 min when within safety margin', () => {
      // Bedrock has same config as Anthropic: shortTtlMs = 300,000
      // shortThreshold = 300,000 * 0.9 = 270,000
      // 270,000 <= 270,000 => "short"
      expect(resolveCacheRetention('amazon-bedrock', 270_000)).toBe('short');
    });

    it('returns "long" at 30 min', () => {
      expect(resolveCacheRetention('amazon-bedrock', 1_800_000)).toBe('long');
    });

    it('returns "long" just over the boundary', () => {
      expect(resolveCacheRetention('amazon-bedrock', 271_000)).toBe('long');
    });
  });

  // -----------------------------------------------------------------------
  // resolveCacheRetention — Unsupported providers
  // -----------------------------------------------------------------------

  describe('resolveCacheRetention — unsupported providers', () => {
    it('returns "none" for Google', () => {
      expect(resolveCacheRetention('google', 300_000)).toBe('none');
    });

    it('returns "none" for Mistral', () => {
      expect(resolveCacheRetention('mistral', 300_000)).toBe('none');
    });

    it('returns "none" for an unknown provider', () => {
      expect(resolveCacheRetention('some-unknown-provider', 300_000)).toBe('none');
    });

    it('returns "none" for Azure (unsupported)', () => {
      expect(resolveCacheRetention('azure', 300_000)).toBe('none');
    });
  });

  // -----------------------------------------------------------------------
  // Model-stated lifetimes (pi-ai's Model.promptCache)
  // -----------------------------------------------------------------------

  describe('model-stated cache lifetimes', () => {
    it('prefer the model over the provider table, tier by tier', () => {
      const lifetimes = { short: 120 };
      expect(resolvePromptCacheTtlMs('anthropic', 'short', lifetimes)).toBe(120_000);
      // The model does not state the long tier: the table answers.
      expect(resolvePromptCacheTtlMs('anthropic', 'long', lifetimes)).toBe(3_600_000);
      expect(resolvePromptCacheTtlMs('anthropic', 'none', lifetimes)).toBe(0);
    });

    it('cover a provider the table does not list', () => {
      expect(resolvePromptCacheTtlMs('fireworks', 'short')).toBe(0);
      expect(resolvePromptCacheTtlMs('fireworks', 'short', { short: 600 })).toBe(600_000);
      expect(resolveCacheRetention('fireworks', 60_000)).toBe('none');
      expect(resolveCacheRetention('fireworks', 60_000, { short: 600 })).toBe('short');
      expect(resolveCacheRetention('fireworks', 3_600_000, { short: 600, long: 86_400 })).toBe('long');
      expect(resolveCacheRetention('fireworks', 3_600_000, { short: 600 })).toBe('none');
    });

    it('move the short/long threshold with the model\'s short lifetime', () => {
      // Anthropic's table short TTL is 5 min; a model stating 10 min keeps 8 min on short.
      expect(resolveCacheRetention('anthropic', 480_000)).toBe('long');
      expect(resolveCacheRetention('anthropic', 480_000, { short: 600, long: 3600 })).toBe('short');
    });

    it('drive when L1 treats the cache as cold', () => {
      const manager = new CompactionManager(buildCompactionConfig(), 1);
      manager.setCacheInfo('anthropic', 'short', undefined, { short: 30 });
      manager.updateCurrentContextTokenCount(1_000);
      const lastCall = manager.lastLlmCallTimestamp!;
      expect(manager.providerCacheTtlMs).toBe(30_000);
      expect(manager.isCacheCold(lastCall + 29_000)).toBe(false);
      expect(manager.isCacheCold(lastCall + 30_000)).toBe(true);
    });

    it('reach a catalog model\'s capabilities', async () => {
      const manager = new ProviderManager();
      const [first] = await manager.listModels('anthropic');
      const model = await manager.resolveModel('anthropic', first!.id);
      expect(model.capabilities?.promptCacheLifetimes).toEqual({ short: 300, long: 3600 });
    });
  });
});
