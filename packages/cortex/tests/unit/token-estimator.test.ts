import { describe, it, expect } from 'vitest';
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { charsForTokens, estimateTokens } from '../../src/token-estimator.js';

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('counts whitespace as characters', () => {
    expect(estimateTokens('   ')).toBe(1); // 3 chars / 3.5 = ceil(0.86) = 1
    expect(estimateTokens('\n\t  \n')).toBe(2); // 5 chars / 3.5 = ceil(1.43) = 2
  });

  it('estimates a single word by character count', () => {
    // 'hello' = 5 chars / 3.5 = ceil(1.43) = 2
    expect(estimateTokens('hello')).toBe(2);
  });

  it('estimates a 10-word sentence', () => {
    const text = 'one two three four five six seven eight nine ten';
    // 48 chars / 3.5 = ceil(13.71) = 14
    expect(estimateTokens(text)).toBe(14);
  });

  it('estimates a 5-word sentence', () => {
    const text = 'the quick brown fox jumped';
    // 26 chars / 3.5 = ceil(7.43) = 8
    expect(estimateTokens(text)).toBe(8);
  });

  it('handles multiple spaces between words', () => {
    // 'hello    world' = 14 chars / 3.5 = 4
    expect(estimateTokens('hello    world')).toBe(4);
  });

  it('handles tabs and newlines as characters', () => {
    // 'hello\tworld\nfoo' = 15 chars / 3.5 = ceil(4.29) = 5
    expect(estimateTokens('hello\tworld\nfoo')).toBe(5);
  });

  it('handles leading and trailing whitespace', () => {
    // '  hello world  ' = 15 chars / 3.5 = ceil(4.29) = 5
    expect(estimateTokens('  hello world  ')).toBe(5);
  });

  it('handles a longer text passage', () => {
    const text = 'The quick brown fox jumps over the lazy dog near the river bank';
    // 63 chars / 3.5 = 18
    expect(estimateTokens(text)).toBe(18);
  });

  it('handles text with punctuation', () => {
    const text = 'Hello, world! How are you?';
    // 26 chars / 3.5 = ceil(7.43) = 8
    expect(estimateTokens(text)).toBe(8);
  });

  it('handles code-like content', () => {
    const text = 'const x = 42;';
    // 13 chars / 3.5 = ceil(3.71) = 4
    expect(estimateTokens(text)).toBe(4);
  });

  it('handles JSON content', () => {
    const text = '{"key":"value","count":42}';
    // 26 chars / 3.5 = ceil(7.43) = 8
    expect(estimateTokens(text)).toBe(8);
  });

  it("is pi-ai's estimate", () => {
    for (const text of ['a', 'hello world', 'x'.repeat(10_001), '{"nested":{"json":[1,2,3]}}']) {
      expect(estimateTokens(text)).toBe(estimateTextTokens(text));
    }
  });
});

describe('charsForTokens', () => {
  it('is the most characters whose estimate stays within the budget', () => {
    for (const tokens of [1, 2, 3, 7, 100, 1_234, 50_000]) {
      const chars = charsForTokens(tokens);
      expect(estimateTokens('x'.repeat(chars))).toBeLessThanOrEqual(tokens);
      expect(estimateTokens('x'.repeat(chars + 1))).toBeGreaterThan(tokens);
    }
  });

  it('is 0 for no budget', () => {
    expect(charsForTokens(0)).toBe(0);
    expect(charsForTokens(-5)).toBe(0);
  });
});
