import { describe, it, expect } from 'vitest';
import { isContextOverflow } from '../../../src/compaction/failsafe.js';

// ---------------------------------------------------------------------------
// Tests: isContextOverflow
// ---------------------------------------------------------------------------

describe('isContextOverflow', () => {
  it('detects context_length_exceeded', () => {
    expect(isContextOverflow(new Error('context_length_exceeded'))).toBe(true);
  });

  it('detects OpenAI\'s "exceeds the context window"', () => {
    expect(isContextOverflow(new Error('Your input exceeds the context window of this model'))).toBe(true);
  });

  it('detects "maximum context length"', () => {
    expect(isContextOverflow(new Error('maximum context length exceeded'))).toBe(true);
  });

  it('detects "token limit"', () => {
    expect(isContextOverflow(new Error('token limit exceeded'))).toBe(true);
  });

  it('detects "too many tokens"', () => {
    expect(isContextOverflow(new Error('Request has too many tokens'))).toBe(true);
  });

  it('detects Anthropic\'s request_too_large', () => {
    expect(isContextOverflow(new Error(
      '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
    ))).toBe(true);
  });

  it('detects "prompt is too long"', () => {
    expect(isContextOverflow(new Error('prompt is too long'))).toBe(true);
  });

  it('detects Bedrock\'s "input is too long"', () => {
    expect(isContextOverflow(new Error('Input is too long for requested model.'))).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isContextOverflow(new Error('connection refused'))).toBe(false);
    expect(isContextOverflow(new Error('invalid API key'))).toBe(false);
    expect(isContextOverflow(new Error('rate limited'))).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isContextOverflow(new Error('CONTEXT_LENGTH_EXCEEDED'))).toBe(true);
    expect(isContextOverflow(new Error('Token Limit Exceeded'))).toBe(true);
  });

  // Bedrock reports a tokens-per-minute throttle as "Too many tokens, please
  // wait before trying again." pi-ai's formatBedrockError prefixes it
  // "Throttling error:"; the raw SDK name is "ThrottlingException". Waiting
  // fixes it; dropping history does not.
  it('does not treat throttling or rate limits that mention too many tokens as overflow', () => {
    // Precondition: the phrase alone is an overflow signal.
    expect(isContextOverflow(new Error('Request has too many tokens'))).toBe(true);

    expect(isContextOverflow(new Error(
      'Throttling error: Too many tokens, please wait before trying again.',
    ))).toBe(false);
    expect(isContextOverflow(new Error(
      'ThrottlingException: Too many tokens, please wait before trying again.',
    ))).toBe(false);
    expect(isContextOverflow(new Error('Rate limit reached: too many tokens per minute'))).toBe(false);
    expect(isContextOverflow(new Error('429 Too Many Requests: too many tokens in flight'))).toBe(false);
  });
});
