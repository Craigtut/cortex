import { describe, it, expect } from 'vitest';
import { classifyError, errorMessageOf, extractCauseDetail, toError } from '../../src/error-classifier.js';

describe('classifyError', () => {
  // -----------------------------------------------------------------------
  // Cancelled
  // -----------------------------------------------------------------------
  describe('cancelled', () => {
    it('classifies as cancelled when wasAborted is true', () => {
      const result = classifyError('Some random error', { wasAborted: true });
      expect(result.category).toBe('cancelled');
      expect(result.severity).toBe('recoverable');
      expect(result.suggestedAction).toBeUndefined();
    });

    it('cancelled takes priority over all other patterns', () => {
      // Even if the message matches authentication, wasAborted wins
      const result = classifyError('invalid api key', { wasAborted: true });
      expect(result.category).toBe('cancelled');
    });
  });

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------
  describe('authentication', () => {
    const authMessages = [
      'invalid api key provided',
      'Unauthorized access to resource',
      'User is not logged in',
      'Authentication required for this endpoint',
      'Your expired token cannot be used',
      'The invalid credentials were rejected',
      'Your api key is invalid',
      'Permission denied for this key',
      'Could not resolve API key for provider anthropic',
      // OAuth token expiry / refresh failures (refresh token revoked or expired)
      'Request failed with status code 401',
      'HTTP 401 Unauthorized',
      'Please log in to continue',
      'Your session has expired, please re-authenticate',
      'OAuth token refresh failed for provider anthropic',
      'Failed to refresh token: refresh_token expired',
      'The access token has expired',
      'Token has been revoked',
      'Login required to access this resource',
    ];

    for (const msg of authMessages) {
      it(`classifies "${msg}" as authentication`, () => {
        const result = classifyError(msg);
        expect(result.category).toBe('authentication');
        expect(result.severity).toBe('fatal');
        expect(result.suggestedAction).toBe(
          'Check your API key or re-authenticate in Settings.',
        );
      });
    }

    it('classifies Error objects as authentication', () => {
      const result = classifyError(new Error('Invalid API key'));
      expect(result.category).toBe('authentication');
    });
  });

  // -----------------------------------------------------------------------
  // Rate Limit
  // -----------------------------------------------------------------------
  describe('rate_limit', () => {
    const rateLimitMessages = [
      'Rate limit exceeded for this API',
      'Too many requests, please slow down',
      'HTTP 429: rate limit',
      'rate_limit_exceeded: try again later',
      'Request was throttled by the server',
      'Request limit reached for the day',
      'Quota exceeded for this billing period',
    ];

    for (const msg of rateLimitMessages) {
      it(`classifies "${msg}" as rate_limit`, () => {
        const result = classifyError(msg);
        expect(result.category).toBe('rate_limit');
        expect(result.severity).toBe('retry');
        expect(result.suggestedAction).toBe(
          'Rate limit hit. The next tick will be delayed.',
        );
      });
    }
  });

  // -----------------------------------------------------------------------
  // Context Overflow
  // -----------------------------------------------------------------------
  describe('context_overflow', () => {
    // pi-ai's isContextOverflow decides; these are providers' real wordings.
    const overflowMessages = [
      'prompt is too long: 213462 tokens > 200000 maximum',
      '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
      'Your input exceeds the context window of this model',
      'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)',
      'Input is too long for requested model.',
      'Too many tokens in the request',
    ];

    for (const msg of overflowMessages) {
      it(`classifies "${msg}" as context_overflow`, () => {
        const result = classifyError(msg);
        expect(result.category).toBe('context_overflow');
        expect(result.severity).toBe('recoverable');
        expect(result.suggestedAction).toBe(
          'Context window exceeded. Compaction will run.',
        );
      });
    }
  });

  // -----------------------------------------------------------------------
  // Server Error
  // -----------------------------------------------------------------------
  describe('server_error', () => {
    const serverMessages = [
      'Internal server error occurred',
      'HTTP 500 response',
      '502 bad gateway from upstream',
      '503 service unavailable temporarily',
      '504 gateway timeout waiting for response',
      'The server returned an error',
      'The service is overloaded, try again',
    ];

    for (const msg of serverMessages) {
      it(`classifies "${msg}" as server_error`, () => {
        const result = classifyError(msg);
        expect(result.category).toBe('server_error');
        expect(result.severity).toBe('retry');
        expect(result.suggestedAction).toBe(
          'The provider is experiencing issues. Retrying.',
        );
      });
    }
  });

  // -----------------------------------------------------------------------
  // Network
  // -----------------------------------------------------------------------
  describe('network', () => {
    const networkMessages = [
      'connect ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo ENOTFOUND api.example.com',
      'connect ETIMEDOUT 10.0.0.1:443',
      'read ECONNRESET by peer',
      'A network error occurred during the request',
      'TypeError: fetch failed',
      'socket hang up during TLS handshake',
      'DNS resolution failed for api.anthropic.com',
      // Anthropic SDK canonical messages (post-retry)
      'Connection error.',
      'Request timed out.',
    ];

    for (const msg of networkMessages) {
      it(`classifies "${msg}" as network`, () => {
        const result = classifyError(msg);
        expect(result.category).toBe('network');
        expect(result.severity).toBe('retry');
        expect(result.suggestedAction).toBe(
          'Network error. Check your connection.',
        );
      });
    }
  });

  // -----------------------------------------------------------------------
  // Unknown
  // -----------------------------------------------------------------------
  describe('unknown', () => {
    it('classifies unrecognized errors as unknown', () => {
      const result = classifyError('Something completely unexpected happened');
      expect(result.category).toBe('unknown');
      expect(result.severity).toBe('recoverable');
      expect(result.suggestedAction).toBeUndefined();
    });

    it('preserves the original message in the result', () => {
      const msg = 'A very specific and unique error message 12345';
      const result = classifyError(msg);
      expect(result.originalMessage).toBe(msg);
    });
  });

  // -----------------------------------------------------------------------
  // Billing and usage windows (Cortex's layer over pi-ai)
  // -----------------------------------------------------------------------
  describe('billing', () => {
    // OpenAI's quota error as pi-ai formats it: the JSON body in the message.
    const openAiQuota = (type: string): string =>
      `OpenAI API error (429): {"message":"You exceeded your current quota, please check your plan and billing details.","type":"${type}","param":null,"code":"${type}"}`;

    it('classifies OpenAI insufficient_quota as billing, which is fatal', () => {
      const result = classifyError(openAiQuota('insufficient_quota'));
      expect(result.category).toBe('billing');
      expect(result.severity).toBe('fatal');
      expect(result.retryAfterMs).toBeUndefined();
    });

    it('classifies Anthropic credit exhaustion and OpenRouter 402 as billing', () => {
      expect(classifyError(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
      ).category).toBe('billing');
      expect(classifyError(
        '402 {"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}',
      ).category).toBe('billing');
    });

    it('classifies the OpenCode gateway monthly limits as billing', () => {
      expect(classifyError('429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Usage limit reached"}}').category)
        .toBe('billing');
      expect(classifyError('429 {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage exhausted"}}').category)
        .toBe('billing');
      expect(classifyError('Monthly usage limit reached. Enable available balance usage to continue.').category)
        .toBe('billing');
    });

    it("guard: keeps Gemini's per-minute quota 429 a rate limit", () => {
      const gemini = (status: string): string =>
        `{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"${status}"}}`;
      // Positive precondition: the same fixture with OpenAI's code is billing.
      expect(classifyError(gemini('insufficient_quota')).category).toBe('billing');

      expect(classifyError(gemini('RESOURCE_EXHAUSTED')).category).toBe('rate_limit');
    });

    it("guard: keeps Google's per-metric quota a rate limit", () => {
      const result = classifyError(
        'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15',
      );
      expect(result.category).toBe('rate_limit');
      expect(result.retryAfterMs).toBeUndefined();
    });
  });

  describe('usage windows', () => {
    it('classifies a ChatGPT usage limit as a rate limit with its reset time', () => {
      const result = classifyError('You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.');
      expect(result.category).toBe('rate_limit');
      expect(result.severity).toBe('retry');
      expect(result.retryAfterMs).toBe(2_520_000);
    });

    it('reads a provider retry delay above pi-ai\'s cap as the reset time', () => {
      const result = classifyError('Server requested 3600s retry delay (max: 60s). 429 Rate limit exceeded');
      expect(result.category).toBe('rate_limit');
      expect(result.retryAfterMs).toBe(3_600_000);
    });

    it('classifies a usage limit with no stated reset as a plain rate limit', () => {
      const result = classifyError('You have hit your ChatGPT usage limit (pro plan).');
      expect(result.category).toBe('rate_limit');
      expect(result.retryAfterMs).toBeUndefined();
    });
  });

  describe('transient failures pi-ai recognizes', () => {
    it('classifies server_busy and a model at capacity as server errors', () => {
      expect(classifyError('{"error":{"code":"server_busy","message":"Please retry later"}}').category)
        .toBe('server_error');
      expect(classifyError('The model is at capacity. Please try again later.').category).toBe('server_error');
    });

    it('guard: leaves a failure pi-ai does not call transient unknown', () => {
      expect(classifyError('404 model not found').category).toBe('unknown');
    });
  });

  describe('overflow judged on the failed response', () => {
    const usage = (input: number) => ({
      input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });

    it('reads a Cerebras body-less 413 as an overflow from the response it came on', () => {
      const failure = {
        role: 'assistant' as const, content: [], api: 'openai-completions', provider: 'cerebras', model: 'm',
        usage: usage(0), stopReason: 'error' as const, errorMessage: '413 status code (no body)', timestamp: 0,
      };
      // Precondition: the text alone says nothing about the provider.
      expect(classifyError('413 status code (no body)').category).not.toBe('context_overflow');

      expect(classifyError('413 status code (no body)', { assistantMessage: failure }).category)
        .toBe('context_overflow');
    });
  });

  // -----------------------------------------------------------------------
  // Priority ordering
  // -----------------------------------------------------------------------
  describe('priority ordering', () => {
    it('authentication takes priority over rate_limit for ambiguous messages', () => {
      // A message that could match both auth and rate limit patterns
      // "unauthorized" matches authentication; "429" matches rate_limit
      // But since auth is checked first, it should win
      const result = classifyError('unauthorized request returned 429');
      expect(result.category).toBe('authentication');
    });

    it('authentication takes priority over server_error', () => {
      // "unauthorized" matches auth; "server error" matches server_error
      const result = classifyError('unauthorized server error');
      expect(result.category).toBe('authentication');
    });

    it('rate_limit takes priority over server_error for 429 messages', () => {
      // "429" matches rate_limit; could potentially match other patterns
      const result = classifyError('Error 429 from server');
      expect(result.category).toBe('rate_limit');
    });

    it('server_error takes priority over network', () => {
      // "internal server error" matches server_error
      const result = classifyError('internal server error with ECONNRESET');
      expect(result.category).toBe('server_error');
    });
  });

  // -----------------------------------------------------------------------
  // Error object handling
  // -----------------------------------------------------------------------
  describe('Error object handling', () => {
    it('extracts message from Error objects', () => {
      const error = new Error('Rate limit exceeded');
      const result = classifyError(error);
      expect(result.category).toBe('rate_limit');
      expect(result.originalMessage).toBe('Rate limit exceeded');
    });

    it('handles string errors directly', () => {
      const result = classifyError('ECONNREFUSED');
      expect(result.category).toBe('network');
      expect(result.originalMessage).toBe('ECONNREFUSED');
    });
  });

  // -----------------------------------------------------------------------
  // Options
  // -----------------------------------------------------------------------
  describe('options', () => {
    it('ignores wasAborted when false', () => {
      const result = classifyError('Rate limit exceeded', { wasAborted: false });
      expect(result.category).toBe('rate_limit');
    });

    it('ignores wasAborted when undefined', () => {
      const result = classifyError('Rate limit exceeded', {});
      expect(result.category).toBe('rate_limit');
    });

    it('accepts contextWindow option without affecting basic classification', () => {
      const result = classifyError('Some unknown error', { contextWindow: 128000 });
      expect(result.category).toBe('unknown');
    });
  });

  // -----------------------------------------------------------------------
  // Cause chain extraction
  // -----------------------------------------------------------------------
  describe('cause chain', () => {
    // Reproduce the real undici/SDK nesting:
    //   APIConnectionError("Connection error.")
    //     -> TypeError("fetch failed")
    //       -> Error { code: "ECONNRESET", message: "read ECONNRESET" }
    function buildConnectionError(): Error {
      const root = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      const fetchErr = new TypeError('fetch failed', { cause: root });
      return new Error('Connection error.', { cause: fetchErr });
    }

    it('extracts the buried reason from a Connection error cause chain', () => {
      const detail = extractCauseDetail(buildConnectionError());
      expect(detail).toBe('fetch failed: read ECONNRESET');
    });

    it('attaches causeDetail to the classified result', () => {
      const result = classifyError(buildConnectionError());
      expect(result.category).toBe('network');
      expect(result.causeDetail).toBe('fetch failed: read ECONNRESET');
      // The opaque top-level message is preserved untouched.
      expect(result.originalMessage).toBe('Connection error.');
    });

    it('routes on a buried code even when the top message is opaque', () => {
      const opaque = new Error('Something went wrong', {
        cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      });
      const result = classifyError(opaque);
      expect(result.category).toBe('network');
      expect(result.causeDetail).toContain('ETIMEDOUT');
    });

    it('collects sibling failures from an AggregateError', () => {
      const agg = Object.assign(new AggregateError([], 'Connection error.'), {
        errors: [
          Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED' }),
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
        ],
      });
      const detail = extractCauseDetail(agg);
      expect(detail).toContain('ECONNREFUSED');
    });

    it('returns undefined when there is no cause', () => {
      expect(extractCauseDetail(new Error('Connection error.'))).toBeUndefined();
      expect(extractCauseDetail('Connection error.')).toBeUndefined();
    });

    it('does not attach causeDetail when there is nothing to add', () => {
      const result = classifyError(new Error('Connection error.'));
      expect(result.category).toBe('network');
      expect(result.causeDetail).toBeUndefined();
    });

    it('survives a cyclic cause chain without looping', () => {
      const a = new Error('a-failure');
      const b = new Error('b-failure');
      (a as { cause?: unknown }).cause = b;
      (b as { cause?: unknown }).cause = a;
      const top = new Error('top', { cause: a });
      const detail = extractCauseDetail(top);
      expect(detail).toBe('a-failure: b-failure');
    });

    it('truncates an overlong cause chain', () => {
      const long = new Error('top', { cause: new Error('x'.repeat(500)) });
      const detail = extractCauseDetail(long);
      expect(detail!.length).toBeLessThanOrEqual(200);
      expect(detail!.endsWith('…')).toBe(true);
    });
  });
});

describe('toError / errorMessageOf', () => {
  it('passes Errors through and wraps other thrown values', () => {
    const error = new TypeError('boom');
    expect(toError(error)).toBe(error);
    expect(toError('text')).toBeInstanceOf(Error);
    expect(toError('text').message).toBe('text');
    expect(errorMessageOf(error)).toBe('boom');
    expect(errorMessageOf(42)).toBe('42');
  });
});
