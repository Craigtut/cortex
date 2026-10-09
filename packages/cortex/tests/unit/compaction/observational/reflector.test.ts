import { describe, it, expect, vi } from 'vitest';
import {
  applyReflection,
  buildReflectorPrompt,
  buildReflectorMessages,
  parseReflectorOutput,
  validateCompression,
  computeEffectiveReflectionThreshold,
  runReflector,
} from '../../../../src/compaction/observational/reflector.js';
import {
  REFLECTOR_SYSTEM_PROMPT,
  COMPRESSION_LEVEL_GUIDANCE,
} from '../../../../src/compaction/observational/constants.js';
import type { CompleteFn } from '../../../../src/compaction/observational/types.js';
import { MemoryReplyError } from '../../../../src/compaction/observational/reply.js';

// ---------------------------------------------------------------------------
// Tests: buildReflectorPrompt
// ---------------------------------------------------------------------------

describe('buildReflectorPrompt', () => {
  it('includes the base reflector system prompt at level 0', () => {
    const prompt = buildReflectorPrompt(0);
    expect(prompt).toBe(REFLECTOR_SYSTEM_PROMPT);
  });

  it('does not append compression guidance at level 0', () => {
    const prompt = buildReflectorPrompt(0);
    expect(prompt).not.toContain('## Compression Target');
  });

  it('appends compression guidance for level 1', () => {
    const prompt = buildReflectorPrompt(1);
    expect(prompt).toContain('## Compression Target');
    expect(prompt).toContain(COMPRESSION_LEVEL_GUIDANCE[1]);
  });

  it('appends compression guidance for level 2', () => {
    const prompt = buildReflectorPrompt(2);
    expect(prompt).toContain(COMPRESSION_LEVEL_GUIDANCE[2]);
  });

  it('appends compression guidance for level 3', () => {
    const prompt = buildReflectorPrompt(3);
    expect(prompt).toContain(COMPRESSION_LEVEL_GUIDANCE[3]);
  });

  it('appends compression guidance for level 4', () => {
    const prompt = buildReflectorPrompt(4);
    expect(prompt).toContain(COMPRESSION_LEVEL_GUIDANCE[4]);
  });

  it('appends custom instructions when provided', () => {
    const prompt = buildReflectorPrompt(0, 'Preserve all user preferences');
    expect(prompt).toContain('## Additional Instructions');
    expect(prompt).toContain('Preserve all user preferences');
  });

  it('includes both compression guidance and custom instructions', () => {
    const prompt = buildReflectorPrompt(2, 'Custom note');
    expect(prompt).toContain('## Compression Target');
    expect(prompt).toContain('## Additional Instructions');
    expect(prompt).toContain('Custom note');
  });
});

// ---------------------------------------------------------------------------
// Tests: buildReflectorMessages
// ---------------------------------------------------------------------------

describe('buildReflectorMessages', () => {
  it('includes observations in the first message', () => {
    const messages = buildReflectorMessages('Date: Apr 10\n* observation');
    const first = messages[0] as { role: string; content: string };

    expect(first.role).toBe('user');
    expect(first.content).toContain('Date: Apr 10');
    expect(first.content).toContain('observation');
  });

  it('includes output instruction as the second message', () => {
    const messages = buildReflectorMessages('some observations');
    expect(messages.length).toBe(2);

    const second = messages[1] as { role: string; content: string };
    expect(second.role).toBe('user');
    expect(second.content).toContain('consolidated reflections');
  });
});

// ---------------------------------------------------------------------------
// Tests: parseReflectorOutput
// ---------------------------------------------------------------------------

describe('parseReflectorOutput', () => {
  it('extracts content from observations tags', () => {
    const raw = '<observations>\nDate: Apr 10\n* consolidated obs\n</observations>';
    const result = parseReflectorOutput(raw);
    expect(result).toBe('Date: Apr 10\n* consolidated obs');
  });

  it('strips analysis tags before extracting', () => {
    const raw =
      '<analysis>\nThinking about consolidation...\n</analysis>\n' +
      '<observations>\nClean observations\n</observations>';
    const result = parseReflectorOutput(raw);
    expect(result).toBe('Clean observations');
    expect(result).not.toContain('analysis');
    expect(result).not.toContain('Thinking');
  });

  it('strips thinking tags before extracting', () => {
    const raw =
      '<thinking>\nLet me consider...\n</thinking>\n' +
      '<observations>\nFinal output\n</observations>';
    const result = parseReflectorOutput(raw);
    expect(result).toBe('Final output');
    expect(result).not.toContain('thinking');
  });

  it('rejects output with no observations tags', () => {
    expect(() => parseReflectorOutput('Just some consolidated observations without tags')).toThrow(MemoryReplyError);
  });

  it('rejects whitespace-only output', () => {
    expect(() => parseReflectorOutput('  \n  ')).toThrow(MemoryReplyError);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateCompression
// ---------------------------------------------------------------------------

describe('validateCompression', () => {
  it('returns true when output tokens are under threshold', () => {
    // "short" is 5 chars, 2 tokens at 3.5 chars/token
    expect(validateCompression('short', 100)).toBe(true);
  });

  it('returns true when output tokens equal threshold', () => {
    // 350 chars = 100 tokens at 3.5 chars/token
    const text = 'x'.repeat(350);
    expect(validateCompression(text, 100)).toBe(true);
  });

  it('returns false when output tokens exceed threshold', () => {
    // 1000 chars = 286 tokens at 3.5 chars/token
    const text = 'x'.repeat(1000);
    expect(validateCompression(text, 100)).toBe(false);
  });

  it('returns true for empty string', () => {
    expect(validateCompression('', 100)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: computeEffectiveReflectionThreshold
// ---------------------------------------------------------------------------

describe('computeEffectiveReflectionThreshold', () => {
  it('takes the minimum of percentage-based and utility model clamp', () => {
    // 200k * 0.20 = 40k vs 100k * 0.5 = 50k => should be 40k
    expect(
      computeEffectiveReflectionThreshold(200_000, 0.20, 100_000),
    ).toBe(40_000);
  });

  it('clamps to utility model window when it is smaller', () => {
    // 1M * 0.20 = 200k vs 50k * 0.5 = 25k => should be 25k
    expect(
      computeEffectiveReflectionThreshold(1_000_000, 0.20, 50_000),
    ).toBe(25_000);
  });

  it('handles small context window', () => {
    // 32k * 0.20 = 6400 vs 128k * 0.5 = 64k => should be 6400
    expect(
      computeEffectiveReflectionThreshold(32_000, 0.20, 128_000),
    ).toBe(6_400);
  });

  it('handles small utility model context window', () => {
    // 200k * 0.20 = 40k vs 16k * 0.5 = 8k => should be 8k
    expect(
      computeEffectiveReflectionThreshold(200_000, 0.20, 16_000),
    ).toBe(8_000);
  });

  it('handles equal values', () => {
    // 100k * 0.5 = 50k vs 100k * 0.5 = 50k => should be 50k
    expect(
      computeEffectiveReflectionThreshold(100_000, 0.5, 100_000),
    ).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// Tests: runReflector
// ---------------------------------------------------------------------------

describe('runReflector', () => {
  it('returns result at level 0 when compression validates', async () => {
    // Return a small output that fits within the threshold
    const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(
      '<observations>\nShort result\n</observations>',
    );

    const result = await runReflector(mockComplete, 'Long observations...', {
      reflectionThreshold: 10_000, // very generous
    });

    expect(mockComplete).toHaveBeenCalledOnce();
    expect(result.observations).toBe('Short result');
    expect(result.compressionLevel).toBe(0);
  });

  it('retries with escalating compression levels when output is too large', async () => {
    // First two attempts return oversized output, third succeeds
    const largeOutput = '<observations>\n' + 'x'.repeat(50_000) + '\n</observations>';
    const smallOutput = '<observations>\nSmall\n</observations>';

    const mockComplete = vi.fn<CompleteFn>()
      .mockResolvedValueOnce(largeOutput)   // level 0 - too big
      .mockResolvedValueOnce(largeOutput)   // level 1 - too big
      .mockResolvedValueOnce(smallOutput);  // level 2 - fits

    const result = await runReflector(mockComplete, 'observations', {
      reflectionThreshold: 100, // very tight threshold
    });

    expect(mockComplete).toHaveBeenCalledTimes(3);
    expect(result.observations).toBe('Small');
    expect(result.compressionLevel).toBe(2);

    // Verify compression guidance was included in later calls
    const secondCall = mockComplete.mock.calls[1]![0];
    expect(secondCall.systemPrompt).toContain('Compression Target');
  });

  it('returns best result even if validation fails after max retries', async () => {
    const oversizedOutput = '<observations>\n' + 'x'.repeat(10_000) + '\n</observations>';

    const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(oversizedOutput);

    const result = await runReflector(mockComplete, 'o'.repeat(20_000), {
      reflectionThreshold: 10, // impossibly tight
    });

    // Should stop after 5 calls (initial + 4 retries, reaching level 4)
    expect(mockComplete).toHaveBeenCalledTimes(5);
    // Returns the last result even though it does not validate
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.compressionLevel).toBeGreaterThan(0);
  });

  it('rejects a final reflection that is no smaller than its input', async () => {
    const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(
      '<observations>\n' + 'x'.repeat(10_000) + '\n</observations>',
    );

    await expect(runReflector(mockComplete, 'short observations', { reflectionThreshold: 10 }))
      .rejects.toThrow(MemoryReplyError);
  });

  it('stops at compression level 4 even if more retries remain', async () => {
    const oversizedOutput = '<observations>\n' + 'x'.repeat(10_000) + '\n</observations>';

    const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(oversizedOutput);

    const result = await runReflector(mockComplete, 'o'.repeat(20_000), {
      reflectionThreshold: 10,
    });

    // Compression level should not exceed 4
    expect(result.compressionLevel).toBeLessThanOrEqual(4);
  });

  it('passes custom reflector instruction through', async () => {
    const mockComplete = vi.fn<CompleteFn>().mockResolvedValue(
      '<observations>\nResult\n</observations>',
    );

    await runReflector(mockComplete, 'observations', {
      reflectionThreshold: 10_000,
      reflectorInstruction: 'Keep user names',
    });

    const callArgs = mockComplete.mock.calls[0]![0];
    expect(callArgs.systemPrompt).toContain('Keep user names');
  });
});

// ---------------------------------------------------------------------------
// Tests: applyReflection
// ---------------------------------------------------------------------------

describe('applyReflection', () => {
  it('keeps what was appended after the reflected input', () => {
    expect(applyReflection('OLD LOG\n\nMORE', 'OLD LOG', 'R')).toBe('R\n\nMORE');
  });

  it('discards a reflection of a log that was since replaced', () => {
    expect(applyReflection('NEW LOG', 'OLD LOG', 'R')).toBeNull();
  });
});
