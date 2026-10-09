# Error Recovery

> **STATUS: IMPLEMENTED**

How Cortex classifies, surfaces, and recovers from errors. Covers the error classifier module, auth failure detection, rate limit backoff, and integration with the 5-phase pipeline.

## Error Classification

Pi-ai records a failed request as an assistant message with `stopReason: 'error'` and an `errorMessage` string (the agent loop rethrows it as a plain `Error`). No error codes, no structured types. Pi-ai judges two things about such a message: `isContextOverflow(message, contextWindow)` (provider overflow wordings, plus a silent overflow where `usage.input` exceeds the window) and `isRetryableAssistantError(message)` (a broad list of transient failures).

Cortex's classifier (`error-classifier.ts`) is a thin layer over those helpers. It uses pi-ai for overflow and transient detection and owns what pi-ai does not decide: billing exhaustion, usage windows and their reset times, authentication, rate limits, and the server/network split. When the turn runner has pi's failed message it passes it (`assistantMessage`); for a thrown error (a direct completion, a credential failure) a message is built from the error's text.

### Categories

Simplified to categories that are actionable at the framework level:

| Category | Severity | Description |
|----------|----------|-------------|
| `authentication` | fatal | Invalid API key, expired token, missing credentials |
| `billing` | fatal | Paid credit exhausted, or a monthly plan limit. Never retried |
| `rate_limit` | retry | Provider rate limit hit (429 equivalent), including a usage window with a stated reset |
| `context_overflow` | recoverable | Context window exceeded. Handled by compaction. |
| `server_error` | retry | Provider 5xx or internal server error |
| `network` | retry | Connection failure, DNS resolution, timeout |
| `cancelled` | recoverable | Agent aborted by user or system |
| `unknown` | recoverable | Catch-all for unclassified errors |

Removed from the existing system (not actionable at the cortex level): `authorization`, `execution`, `resource_exhausted`, `not_found`, `invalid_input`, `unsupported`. These either don't apply to LLM calls or are too granular to classify from error strings.

`billing` is not `resource_exhausted` back. That category would have swept up Google's per-minute `RESOURCE_EXHAUSTED`, which is transient. `billing` matches only provider-specific codes for exhausted paid credit, says what to do (top up or switch provider), and leaves every per-minute or per-day quota under `rate_limit`.

### Classification Patterns

Checked in priority order (first match wins): cancelled, billing, usage window, authentication, rate limit, context overflow, server error, network, then anything pi-ai calls transient as a server error, else unknown.

**Billing** (before the rate-limit patterns, which an `insufficient_quota` 429 also matches):
```
/\binsufficient_quota\b/i            OpenAI's code (pi-ai puts the JSON body in the message)
/credit balance is too low/i          Anthropic
/\b402\b/ with /insufficient credits/i OpenRouter
/\bGoUsageLimitError\b/, /\bFreeUsageLimitError\b/, /monthly usage limit reached/i
                                      The OpenCode gateway's monthly limits, as pi-ai reports them
```

Never on a bare "quota" or "billing": Gemini's per-minute 429 reads "You exceeded your current quota, please check your plan and billing details" and stays `rate_limit`. Pi-ai's own non-retryable "provider limit" list is too broad to adopt for that reason.

**Usage window** (`rate_limit` with `retryAfterMs`):
```
/usage limit/i                        Sign in with ChatGPT: "...usage limit (plus plan). Try again in ~42 min."
/subscription_sharing_usage_limit_exceeded/i
/server requested \d+s retry delay/i  pi-ai's error when Retry-After exceeds its maxRetryDelayMs
```

`retryAfterMs` is read from "Try again in ~N min" (or seconds, hours) and "Server requested Ns retry delay". Without one, the normal backoff applies.

**Authentication:**
```
/invalid.api.key/i
/unauthorized/i
/\b401\b/
/not.logged.in/i
/login.*required/i
/please.*log.?in/i
/authentication.required/i
/re-?authenticate/i
/expired.*token/i
/token.*expired/i
/token.*(revoked|invalid)/i
/refresh.*token/i
/oauth.*(fail|error|expire|invalid|denied|revoke)/i
/session.*expired/i
/invalid.*credentials/i
/api.key.*invalid/i
/permission.denied.*key/i
/Could not resolve API key/i
```

The `401`, `oauth`, `refresh.*token`, `token.*expired`, and `session.*expired` patterns cover OAuth access-token expiry where the refresh token is itself revoked or expired. In that case pi-ai's `getOAuthApiKey()` (invoked from the `getApiKey` callback) throws during credential resolution; the resolution error is surfaced as the cause rather than the downstream provider error (see "Auth Failure Detection").

**Rate Limit:**
```
/rate.limit/i
/too.many.requests/i
/429/
/rate_limit_exceeded/i
/throttl/i
/request.limit.reached/i
/quota.exceeded/i
```

**Context Overflow:**
Pi-ai's `isContextOverflow(message, contextWindow)`, checked after the rate-limit patterns, so a throttle worded like an overflow (Bedrock's "ThrottlingException: Too many tokens, please wait") is a rate limit. Wordings pi-ai does not know are not overflows. The exported `isContextOverflow(error)` is `classifyError(error).category === 'context_overflow'`.

**Server Error:**
```
/internal.server.error/i
/500/
/502.*bad.gateway/i
/503.*service.unavailable/i
/504.*gateway.timeout/i
/server.*error/i
/overloaded/i
```

Anything else pi-ai's `isRetryableAssistantError()` accepts (`server_busy`, "model is at capacity", "stream ended before message_stop", "terminated" and more) is `server_error`, after Cortex's server and network patterns.

**Network:**
```
/ECONNREFUSED/
/ENOTFOUND/
/ETIMEDOUT/
/ECONNRESET/
/network.*error/i
/fetch.failed/i
/socket.hang.up/i
/DNS.*resolution/i
/connection error/i
/timed out/i
```

The last two match the Anthropic SDK's canonical `APIConnectionError` ("Connection error.") and `APIConnectionTimeoutError` ("Request timed out.") messages, which the SDK throws after exhausting its own internal retries.

**Cancelled:**
Detected by checking `agent.state.error` after abort, or `stopReason === "aborted"` on the response.

### Classifier API

```typescript
interface ClassifiedError {
  category: ErrorCategory;
  severity: 'fatal' | 'retry' | 'recoverable';
  originalMessage: string;
  causeDetail?: string;
  suggestedAction?: string;
  /** The wait the provider stated, in ms (a usage window's reset, a retry delay over pi-ai's cap). */
  retryAfterMs?: number;
}

function classifyError(error: Error | string, options?: ClassifyErrorOptions): ClassifiedError;

interface ClassifyErrorOptions {
  /** Context window size in tokens. pi-ai's overflow check reads a failed response's usage against it. */
  contextWindow?: number;
  /** pi's failed assistant message for the run, judged directly by pi-ai's helpers. */
  assistantMessage?: AssistantMessage;
  /** Whether the agent was aborted (user or system cancellation). When true, the error is immediately classified as 'cancelled'. */
  wasAborted?: boolean;
}
```

The classifier is a pure function. It does not throw, does not modify state. It takes an error (or error string) and returns a classification.

**Suggested actions** per category:
- `authentication`: "Check your API key or re-authenticate in Settings."
- `billing`: "The provider account is out of credits or over its plan limit. Add credits, or switch provider."
- `rate_limit`: "Rate limit hit. The next tick will be delayed."
- `context_overflow`: "Context window exceeded. Compaction will run."
- `server_error`: "The provider is experiencing issues. Retrying."
- `network`: "Network error. Check your connection."
- `cancelled`: null (user-initiated, no action needed)
- `unknown`: null

## Error Event Flow

When a pi-ai call fails:

```
Pi-ai error (plain Error)
  → classifyError() produces ClassifiedError
  → AgentLoop emits onError(ClassifiedError) event
  → Consumer (backend) receives and routes:
      → Log the error (always)
      → EventBus 'system:error' (for auth, rate_limit, server_error)
      → Frontend receives via onSystemError tRPC subscription
      → SystemErrorCard rendered in conversation view
```

### AgentLoop Error Event

```typescript
cortexAgent.onError((error: ClassifiedError) => {
  // Consumer handles routing
});
```

This fires for any LLM call failure, whether it happens in the agentic loop (`prompt()`) or in a direct completion (`directComplete` / `structuredComplete` / `utilityComplete`, used for phases like THOUGHT and REFLECT). All four paths route failures through the same `emitError()` helper. Tool execution errors are not surfaced here; those are handled by pi-agent-core internally and don't crash the loop. A transient failure that a background retry recovers from never reaches `onError` (see [Transient error handling](#transient-error-handling)).

### Consumer Error Routing

Consumers receive classified errors and decide how to handle them (retry, notify users, escalate, delay). A typical consumer error handler routes errors to its own event/notification system:

```typescript
cortexAgent.onError((error) => {
  log.error(`Agent error [${error.category}]:`, error.originalMessage);

  if (error.category === 'authentication') {
    // Surface to UI, halt processing
    notifyUser({
      category: 'authentication',
      message: error.originalMessage,
      recoverable: false,
      suggestedAction: error.suggestedAction,
    });
  }

  if (error.category === 'rate_limit') {
    // Notify user, delay next operation
    notifyUser({
      category: 'rate_limit',
      message: error.originalMessage,
      recoverable: true,
      suggestedAction: error.suggestedAction,
    });
    scheduler.delayNext(backoffMs);  // see Rate Limit Backoff below
  }

  if (error.category === 'server_error') {
    // Notify user, may retry
    notifyUser({
      category: 'server_error',
      message: error.originalMessage,
      recoverable: true,
      suggestedAction: error.suggestedAction,
    });
  }
});
```

The consumer decides which categories warrant user notification, which trigger retries, and which are silently logged.

## Auth Failure Detection

Two detection points:

### Pre-Call (Credential Resolution)

The `getApiKey` callback (e.g. a consumer's `CortexCredentialService.resolveApiKey()`) throws if:
- No API key is configured for the provider
- The encrypted key cannot be decrypted (vault locked)
- An OAuth access token is expired and its refresh token is revoked/expired (refresh fails)

A resolution failure is remembered, not swallowed. The completion still runs without a key, which succeeds for providers that need none and, with `ambientCredentials: true`, for credentials pi-ai finds in the environment; otherwise pi-ai reports the provider as not configured. If the call then fails, the remembered resolution error is surfaced as the cause (it is more actionable than the downstream provider error) and classified as `authentication` / `fatal`. In the agentic loop, pi-agent-core invokes `getApiKey` and stores the failure on `agent.state.errorMessage`, which `AgentLoop` re-throws and classifies the same way.

### Post-Call (Provider Rejection)

The LLM call fails with an auth error string (e.g., "Invalid API key"). The error classifier detects this via regex patterns.

### Auth Event

Both detection points result in the same consumer event. The backend emits `system:error` with `category: 'authentication'`, which the frontend renders as a SystemErrorCard with the suggested action to check API keys.

## Transient error handling

Cortex retries transient failures of a turn itself, in the background, before anything reaches `onError`. A turn that recovers never surfaces an error; the caller's `prompt()` promise just stays pending across the backoff window and resolves with the recovered result. Only a failure Cortex gives up on is classified, emitted through `onError`, and thrown.

### Why Cortex owns this

Provider-level retries exist but are inconsistent:
- **Anthropic SDK**: 2 retries (built-in)
- **OpenAI Codex**: 3 retries (custom in pi-ai)
- **OpenAI, Mistral, Google SDK**: SDK built-in (varies)
- **Groq, xAI, Cerebras, OpenRouter, etc.**: No retry at all

Pi-agent-core has no retry at the agent loop level. When an LLM call fails after provider-level retries are exhausted, the agent appends a synthetic assistant failure message (`stopReason: "error"`) and stops. Cortex sits above that inconsistent behavior, so it can apply one policy to every provider and resume the failed turn without re-running completed tool calls.

### Retry policy

`AgentLoopConfig.retryPolicy` takes a partial `RetryPolicy`, merged over the defaults by `resolveRetryPolicy()` (`src/retry-policy.ts`). `retryableCategories` and `backoffMs` replace the defaults wholesale when given; invalid values fall back to the default.

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Master switch. `{ enabled: false }` turns background retry off. |
| `retryableCategories` | `['network', 'server_error', 'rate_limit']` | Categories eligible for retry. |
| `backoffMs` | `[120_000, 240_000, 480_000]` | Wait before each retry (2m, 4m, 8m). Entries past the end use `maxBackoffMs`. |
| `maxBackoffMs` | `600_000` | Cap on any single wait (10m). |
| `maxAttempts` | `20` | Retries before giving up (about a 3h window with the defaults). |
| `maxElapsedMs` | unset | Optional ceiling on time since the turn's first failure. |
| `maxRetryAfterMs` | `21_600_000` | Longest wait for a reset the provider stated (6h). A reset further away, or past `maxElapsedMs`, is not waited for: the failure surfaces at once, since a retry before the reset would be refused the same way. |

### Mechanism

`TurnRunner` (`src/agent-loop/turn-runner.ts`) runs one logical turn under the loop gate:

1. The first attempt calls `agent.prompt()`. For a consumer turn the input is preceded by any parked wake deliveries and queued silent deliveries taken for this run. Pi catches provider errors and stores them in `state.errorMessage` without throwing, so the runner turns a set error state into a thrown error.
2. A failure is classified with `classifyError()`, given pi's failed message and the model's context window. A context overflow triggers the overflow drop first; it is not in the default retryable set, so it then surfaces. A run that completes is checked for a silent overflow (pi-ai's `isContextOverflow()` on the answer: more input than the window holds, from a provider that truncates instead of rejecting), which triggers the same drop.
3. The turn is retried only when `shouldRetry()` agrees (policy enabled, not aborted, severity not `fatal`, category retryable, attempts and elapsed time within the policy) and the transcript can be resumed: after trimming trailing failure stubs, the last message must be a user message or tool result past the slot region. A failure that lands after an assistant tool-call turn but before its results cannot be resumed and surfaces instead.
4. Before each wait the runner emits `onRetryScheduled`, then sleeps for `retryDelayForAttempt()`: the backoff, or the provider's stated reset (`retryAfterMs`) when that is later. A wait for a stated reset counts as one attempt, and `delayMs` reports the real wait. The sleep wakes at once if the run is aborted.
5. After the wait it trims pi's failure stub and calls `agent.continue()`. The user message is already in the transcript, so nothing is re-sent and completed tool calls do not re-run.
6. A retry that succeeds emits `onRetrySucceeded`. A failure that will not be retried emits `onError` and rethrows. When the policy stopped a retryable category after at least one retry, `onRetryExhausted` fires first.

### Aborts

`isAborted()` is true when the run's abort controller fired or pi's run state holds an abort-shaped error. The match is on a word start ("abort", "cancelled"), so a network error such as `ECONNABORTED` stays a network error and keeps its retry.

- An abort during a backoff wait trims the failure stub, emits `onError` classified as `cancelled`, and throws an `AbortError` ("Prompt aborted during retry backoff") rather than the stale transient error.
- An aborted run that ends cleanly or with an error has its trailing aborted stub trimmed. A stub that carries partial text the user already saw is kept unless it also carries tool calls, which would be unpaired.
- A consumer turn whose controller was aborted before the turn left the gate queue never reaches pi: it emits a `cancelled` error and throws "Prompt aborted before it started".

### Failed delivery runs

Runs that deliver content without a consumer caller (background completions, parked wake deliveries swept into a run of their own) use the same retry loop with two differences:

- Their retry ladder is capped by a delivery budget: `maxElapsedMs` is lowered to what remains of the oldest item's budget, so re-attempts cannot re-enter the full ladder back to back.
- Per-attempt `onError` and `onRetryExhausted` are suppressed. A failed run is unwound from the transcript and re-attempted. `onError` fires once, at the root of the delivery chain, when content is dead-lettered after a failure or the failed run had progressed past it. A later attempt that delivers the content surfaces no error.

Content the loop gives up on is dead-lettered, never dropped silently. See [Background delivery budgets and dead letters](cortex-architecture.md#background-delivery-budgets-and-dead-letters) for the budgets, the unwind rules, and the dead-letter store.

Two related consumer-visible guarantees:

- A background delivery that fails after a consumer turn succeeded surfaces through `onError`. It never rejects that turn or replaces its error.
- Wake deliveries spliced into a consumer prompt that fails terminally are unwound and re-parked for a run of their own, unless the run progressed past them or was aborted.

### Events

| Hook | Payload | Fires |
|------|---------|-------|
| `onRetryScheduled(handler)` | `RetryScheduledInfo`: `category`, `attempt` (1-based), `maxAttempts`, `delayMs`, `nextAttemptAt`, `originalMessage`, optional `causeDetail` | Before each backoff wait |
| `onRetrySucceeded(handler)` | `RetrySucceededInfo`: `attempts` | When a retry resolves the turn |
| `onRetryExhausted(handler)` | `RetryExhaustedInfo`: `attempts`, `category` | When the policy stops retrying a retryable failure (consumer turns only) |
| `onError(handler)` | `ClassifiedError` | For any failure Cortex gives up on |

Every handler also receives the loop's `LoopOriginContext` as its second argument.

### Error categories and retry behavior

| Category | Severity | Retried by Cortex? | Notes |
|----------|----------|--------------------|-------|
| `rate_limit` | retry | Yes, by default | 429 or rate limit patterns. A usage window waits for its stated reset, up to `maxRetryAfterMs` |
| `server_error` | retry | Yes, by default | 500, 502, 503, 504 |
| `network` | retry | Yes, by default | Connection failure, DNS, timeout |
| `authentication` | fatal | No | Invalid key, expired token. Fatal errors are never retried, even if listed. |
| `billing` | fatal | No | Out of credit or over a monthly plan limit. Surfaces at once |
| `context_overflow` | recoverable | No | Emergency truncation runs, then the error surfaces |
| `cancelled` | recoverable | No | User abort |
| `unknown` | recoverable | No | Unclassified errors, including a 404 |

### Interaction with provider-level retries

Provider SDKs retry inside each attempt, before the error reaches Cortex. Cortex's backoff starts only after those are spent.

The `maxRetryDelayMs` option in pi-ai caps provider-requested retry delays. If a server asks for a longer delay, pi-ai throws immediately ("Server requested 3600s retry delay (max: 60s)") rather than waiting, and Cortex waits the requested delay instead of its backoff, within `maxRetryAfterMs`.

### Memory model calls

Observer and reflector calls retry quickly within their own policy (`compaction/observational/calls.ts`). They do not retry `authentication`, `billing`, `context_overflow` or `cancelled` failures, nor a limit with a stated reset, which quick retries cannot reach: the call fails at once and memory goes degraded until a background call succeeds.

## Consumer-Specific Rate Limit Handling

Consumers can apply higher-level backoff between prompts:

### Heartbeat Consumers (e.g., Animus)

For consumers with autonomous tick loops, rate limits should also delay the next tick:

```typescript
cortexAgent.onError((error) => {
  if (error.category === 'rate_limit') {
    consecutiveRateLimits++;
    const backoffMs = Math.min(
      30000 * Math.pow(2, consecutiveRateLimits - 1),
      300000  // max 5 minutes
    );
    tickQueue.delayNext(backoffMs);
  }
});

// On successful prompt completion
consecutiveRateLimits = 0;
```

### Interactive Consumers (e.g., Cortex Code)

For TUI consumers, `onError` can drive UI feedback:

```typescript
cortexAgent.onError((error) => {
  if (error.severity === 'retry') {
    tui.showError(`${error.suggestedAction} Send another message to retry.`);
  }
});
```

Interactive consumers usually avoid automatic retry loops so the user stays in control after the failure is shown.

## Integration with the 5-Phase Pipeline

Each phase of the pipeline (THOUGHT, AGENTIC LOOP, REFLECT) can fail independently. The error classifier runs on any failure. The per-phase failure handling sits above the classifier:

| Phase | On Error | Classification Used For |
|-------|----------|------------------------|
| THOUGHT | Skip thought, continue to agentic loop with no thought in context | Log + surface to UI. Auth errors halt the tick. |
| AGENTIC LOOP | Cortex retries transient failures per its retry policy, then classifies the error and throws. Consumers decide whether to retry further, use partial results, or fall back. | Log + surface to UI. Auth errors halt the tick. |
| REFLECT | Retry up to 3 times. If all fail, skip reflection (emotions/decisions for this tick are lost). | Log + surface to UI. Auth errors halt the tick. |
| Any phase | If `authentication`: halt the tick entirely, surface to UI, do not retry. | Auth is always fatal. |

### Context Overflow During Agentic Loop

Detected via pi-ai's `isContextOverflow()`, on a provider's rejection (after Cortex's rate-limit patterns, so a throttle never triggers it) or on a completed answer that overflowed silently. Handled by the compaction system (see `compaction-strategy.md`):
1. The source shrinks to 80% of the model's capacity: observed messages leave as in any swap, and unobserved ones that do not fit are dropped, with a `GAP` line in the observation log and `onMemoryGap`
2. The latest user message stays, and the next attempt runs with the smaller context
