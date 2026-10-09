import { describe, expect, it } from 'vitest';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { inferUtilityModelId } from '../../src/utility-model-inference.js';

function model(id: string, input = 1, output = 1): Record<string, unknown> {
  return {
    id,
    name: id,
    input: ['text'],
    cost: { input, output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
  };
}

describe('utility-model-inference', () => {
  it('prefers the newest utility-sized version over older cheaper versions', () => {
    expect(inferUtilityModelId([
      model('gpt-5.1-codex-mini', 0.25, 2),
      model('gpt-5.4-mini', 0.75, 4.5),
      model('gpt-5.5', 5, 30),
    ])).toBe('gpt-5.4-mini');
  });

  it('infers recency from release dates', () => {
    expect(inferUtilityModelId([
      model('claude-3-5-haiku-20241022', 0.8, 4),
      model('claude-haiku-4-5-20251001', 1, 5),
      model('claude-sonnet-4-6', 3, 15),
    ])).toBe('claude-haiku-4-5-20251001');
  });

  it('never picks a batch-priced variant, however cheap', () => {
    expect(inferUtilityModelId([
      model('mistralai/mistral-small-2603', 0.15, 0.6),
      model('mistralai/mistral-small-2603:batch', 0.075, 0.3),
    ])).toBe('mistralai/mistral-small-2603');
  });

  it("picks a real-time model from OpenRouter's catalog", () => {
    const openRouter = getBuiltinModels('openrouter') as unknown as Array<Record<string, unknown>>;
    // Precondition: the catalog carries batch variants of utility models.
    expect(openRouter.some((candidate) => candidate['id'] === 'mistralai/mistral-small-2603:batch')).toBe(true);

    expect(inferUtilityModelId(openRouter)).not.toMatch(/:batch$/);
  });

  it('prefers a newer version over a dated snapshot of an older one', () => {
    // pi-ai 1.1.0's Anthropic catalog: Haiku 5.5 carries no date, and the
    // older Haiku 4.5 snapshot's date must not outrank its version.
    expect(inferUtilityModelId([
      model('claude-haiku-4-5', 1, 5),
      model('claude-haiku-4-5-20251001', 1, 5),
      model('claude-haiku-5-5', 0.1, 0.5),
    ])).toBe('claude-haiku-5-5');
  });

  it('reads a version from a whole run of numbers, not from its tail', () => {
    // 3.5.1, whose tail "5-1" is not version 5.1.
    expect(inferUtilityModelId([
      model('acme-3-5-1-mini'),
      model('acme-4-0-mini'),
    ])).toBe('acme-4-0-mini');
  });

  it('orders by date when only one model names a version', () => {
    // Mistral Small 4 has no dotted version; Small 3.2 has one.
    expect(inferUtilityModelId([
      { ...model('mistral-small-2506', 0.1, 0.3), name: 'Mistral Small 3.2' },
      { ...model('mistral-small-2603', 0.15, 0.6), name: 'Mistral Small 4' },
    ])).toBe('mistral-small-2603');
  });

  it('infers recency from short yymm suffixes', () => {
    expect(inferUtilityModelId([
      model('mistral-small-2501', 0.1, 0.3),
      model('mistral-small-2506', 0.06, 0.18),
      model('mistral-large-2512', 2, 6),
    ])).toBe('mistral-small-2506');
  });

  it('infers recency from month-year preview suffixes', () => {
    expect(inferUtilityModelId([
      model('gemini-2.5-flash-lite-preview-06-2025', 0.1, 0.4),
      model('gemini-2.5-flash-lite-preview-09-2025', 0.1, 0.4),
    ])).toBe('gemini-2.5-flash-lite-preview-09-2025');
  });

  it('filters special-purpose models', () => {
    expect(inferUtilityModelId([
      model('grok-vision-beta', 0.1, 0.1),
      model('grok-code-fast-1', 0.2, 1.5),
    ])).toBe('grok-code-fast-1');
  });

  it('falls back to cheapest capable model when no utility-sized hint exists', () => {
    expect(inferUtilityModelId([
      model('provider-model-1', 2, 8),
      model('provider-model-2', 1, 2),
    ])).toBe('provider-model-2');
  });
});
