# Cortex compaction

**Status**: Implemented
**Updated**: 2026-10-09 (classic summarization removed; observational memory is the only strategy)
**Related docs**: [observational-memory-architecture.md](./observational-memory-architecture.md), [context-manager.md](./context-manager.md), [cortex-architecture.md](./cortex-architecture.md)

Compaction keeps every request inside the context window. It has three parts:

- **Observational memory** compresses older conversation into observations in the `_observations` slot and swaps them in for the messages they cover, keeping the most recent messages verbatim. It is documented in [observational-memory-architecture.md](./observational-memory-architecture.md).
- **Layer 1 (microcompaction)** trims large tool results in what remains, cache-aware.
- **Layer 3 (failsafe)** handles a request that still will not fit: it cuts the request's view, and after the provider rejects a request as too long it shrinks the source itself.

There is no Layer 2. Classic conversation summarization (an LLM summary replacing old turns, with adaptive thresholds and a circuit breaker) was removed on 2026-10-09. `buildCompactionConfig` rejects `strategy: 'classic'` and the old `compaction` and `adaptive` sections with a message saying so. The decision and the hardening that preceded it are in [om-hardening-plan.md](./om-hardening-plan.md).

---

## Design principles

1. **Cortex compacts conversation history; the consumer owns its domain.** Cortex records and compresses what happened in the conversation. Domain-specific memory (a consumer's own summaries, database-backed slots) stays with the consumer, which hears about every swap through `onObservation`.

2. **Cheap first, lossy last.** Observations are recorded in the background, before they are needed, so a swap is a merge rather than a wait. Tool result trimming costs no LLM call. Dropping unobserved messages happens only after the provider has refused a request, and the log records the gap.

3. **Slots are sacred.** Consumer slots are never touched by compaction. The `_observations` slot is the one Cortex owns.

4. **Ephemeral context is always fresh.** View injections are added per call and never persist in history, so they are never a compaction target.

5. **Prefix cache preservation.** Slots sit at the top of the message array and change rarely; compaction works on history below them, and Layer 1 waits for a cold cache before trimming.

---

## Message array layout

```
SYSTEM HEAD (0)                pi's leading system message: prompt and tools
  |
SLOT REGION (1..N)             persistent, named, managed by ContextManager;
  |                            `_observations` is the last slot
CONVERSATION HISTORY (N+1..M)  grows with each turn: the compaction target
  |
VIEW INJECTIONS                per call, never stored
  |
CURRENT TURN                   the tick's own messages
```

Compaction operates on the **conversation history** region. Slots above it and injections below it are untouched, except that observational memory writes the `_observations` slot.

---

### Layer 1: tool result trimming (microcompaction)

**What**: Progressively reduce the footprint of old tool results in conversation history. Tool results (file reads, grep outputs, bash outputs, web fetches, MCP tool responses) are typically the largest individual items and dominate context usage.

**When**: Before every LLM call, inside the `transformContext` hook, on the history that survives observational memory's swap. The session transcript is **never modified** by microcompaction (following OpenClaw's pattern). Only the context sent to the model is affected.

**Critical insight**: The agent's own text responses (assistant messages where it reasons about, synthesizes, and discusses tool results) are **never touched** by microcompaction. Only tool_result content blocks are candidates. This means that research findings, analysis, and conclusions the agent has already articulated in its own words survive regardless of what happens to the raw tool output.

**How** (cache-aware, token-offset-based, progressive degradation):

#### Tier 1: insertion-time cap (always active)

Large tool results are truncated at insertion time before entering conversation history. Results exceeding `maxResultTokens` (default: 50,000 tokens) are truncated to head + tail with a marker in between. This prevents a single enormous result from destabilizing the context. This tier has zero cache impact since it runs at insertion, not in `transformContext`.

#### Tier 2: cache-aware token-offset trimming (in `transformContext`)

L1's reactive trimming is gated on two checks before any work happens:

1. **Cache check**: Is the prompt cache still warm? If the time since the last LLM call is less than the active provider's cache TTL, L1 is **dormant** and history is returned untouched. This preserves cache hits during active use, which is where the biggest cost savings live. A provider that caches the prompt prefix automatically, with no stated lifetime (Ollama, for example), has no TTL to read: there L1 preserves the prefix until utilization reaches `prefixTrimRatio` (default 70%) and trims from there.
2. **Trim floor check**: Is context utilization at least `trimFloorRatio` (default 25%)? Below this, trimming offers little benefit even when the cache is cold.

When both gates pass, L1 walks history from the most recent message backwards, accumulating token offsets. Each tool result lands in one of three zones based on its distance from the end:

```
[Most recent message]
        |
        |  Hot zone: full content, no trimming
        |  size = max(hotZoneMinTokens, contextWindow * hotZoneRatio)
        |
        |---[hot zone boundary]
        |
        |  Degradation span: bookended with shrinking sizes
        |  size = contextWindow * degradationSpanRatio
        |  bookend chars: bookendMaxChars (at boundary) to bookendMinChars (at far end), interpolated linearly
        |
        |---[degradation span boundary]
        |
        |  Beyond: placeholder (most categories) or clear (ephemeral only)
        |
[Oldest message]
```

**Hot zone defaults**: `hotZoneMinTokens = 16_000`, `hotZoneRatio = 0.05`. The floor wins on small/medium windows; the ratio wins above ~320k. Non-reproducible tools get an extended hot zone via `extendedRetentionMultiplier` (resolves to 1.0 with persister, 1.5 without).

**Hot zone + degradation span coverage**:

| Context Window | Hot Zone | Degradation Span | "Still bookended" Total | % of Window |
|---|---|---|---|---|
| 32k | 16,000 | 12,800 | 28,800 | 90% |
| 200k | 16,000 | 80,000 | 96,000 | 48% |
| 1M | 50,000 | 400,000 | 450,000 | 45% |

Tool results only become placeholder/clear after exiting the bookended region.

**Bookend formats** (defaults: `bookendMaxChars = 2_000`, `bookendMinChars = 256`):

Without persister:
```
[First N chars of original result]

... [~8,500 tokens trimmed] ...

[Last N chars of original result]
```

With persister (full content saved to disk, path embedded in replacement):
```
[Result persisted: /path/to/file.txt (45,230 chars, ~11,308 tokens) -- WebFetch]

[First N chars of original result]

... [~8,500 tokens trimmed; full content at /path/to/file.txt] ...

[Last N chars of original result]
```

**Beyond the degradation span**, a placeholder (preserves the "this was tried" breadcrumb):
```
[Tool result trimmed -- WebFetch: "context compaction techniques 2026" -- see assistant response below for findings]
```

Or with persister (non-reproducible/computational only):
```
[Tool result persisted -- WebFetch: "context compaction" -- use Read on /path/to/file.txt for full content]
```

For ephemeral tools (SubAgent, TaskOutput) beyond the degradation span:
```
[Tool result cleared]
```

#### Action selection by tool category

| Distance from end | rereadable | non-reproducible | computational | ephemeral |
|---|---|---|---|---|
| Within hot zone | full | full (extended hot zone) | full | full |
| Within degradation span | bookend (shrinking) | bookend (shrinking, persisted) | bookend (shrinking, persisted) | bookend (shrinking) |
| Beyond degradation span | placeholder | placeholder (persisted) | placeholder (persisted) | clear |

- **bookend**: Default for tool results within the degradation span. Head+tail gives the LLM enough context to recognize what was read and decide whether to dig deeper.
- **placeholder**: Used beyond the degradation span for `non-reproducible`, `computational`, `rereadable`, and unknown tools. Strips all bookend tokens but preserves a one-line breadcrumb so the agent doesn't redo work.
- **clear**: Used beyond the degradation span for `ephemeral` tools only. No record needed because re-running is the right recovery path.

#### Cache-aware gating (per-provider TTLs)

Cortex resolves the active cache TTL for the current `CacheRetention` setting from the model first: pi-ai's catalog states per-model lifetimes (`Model.promptCache`, surfaced as `capabilities.promptCacheLifetimes`), and a tier the model states wins. Otherwise it falls back to `PROVIDER_CACHE_CONFIG` for the current provider (`resolvePromptCacheTtlMs()` owns the rule; `resolveCacheRetention()` accepts the same lifetimes as an optional third argument). The provider fallbacks:

| Provider | Short TTL | Long TTL |
|---|---|---|
| Anthropic / Bedrock | 5 minutes | 1 hour |
| OpenAI | 10 minutes | 24 hours |
| Google / Mistral / Azure | no caching (L1 runs freely) | no caching |

The consumer's `CacheRetention` setting is set via `setCacheRetention()` on `AgentLoop` for the default retention level. For per-call overrides, `prompt()`, `directComplete()`, and `structuredComplete()` all accept `{ cacheRetention }` in their options parameter. This lets consumers use different retention levels for different call types (e.g., short retention for cheap thought-generation calls, long retention for expensive multi-turn agentic loops). AgentLoop automatically wires the effective retention (and the active provider) into `CompactionManager.setCacheInfo()`. The CompactionManager records `lastLlmCallTimestamp` automatically inside `updateCurrentContextTokenCount()`, so cache-coldness is computed without any consumer-side bookkeeping.

**Result**:
- During rapid tool calls (cache warm): L1 stays dormant. Tool results stay full. Cache hit rates maximized.
- During idle periods: L1 fires once when the cache has naturally expired, reducing the size of the prompt that gets cached on the next call.
- All subsequent calls within the cache TTL hit the trimmed (smaller) cached content.

#### Trim state caching

L1 caches trim decisions across consecutive calls when `(historyLength, utilizationBand)` is unchanged. When either changes, the engine recomputes. This is mostly redundant with the cache-aware gate (L1 only runs when the cache is cold, and immediately after running the cache will be warm again until the next TTL expiry), but the cache is cheap to keep as a safety net.

#### Persistence model

When a `persistResult` callback is configured (typically via the top-level `AgentLoopConfig.persistResult`, which propagates into `MicrocompactionConfig`), L1 saves the **full original content to disk** before any destructive trim action (bookend, placeholder, clear) for non-reproducible and computational tools. The in-context replacement includes the disk path so the agent can `Read` it back if needed.

- `rereadable` tools: no persistence (agent can re-read source files directly)
- `ephemeral` tools: no persistence (re-running is trivial)
- `non-reproducible` and `computational`: persisted on every destructive trim

**Cost**: Zero LLM calls. Pure string operations plus an optional disk write.

**Configuration**:
```typescript
interface MicrocompactionConfig {
  // Insertion-time cap
  maxResultTokens: number;              // default: 50_000

  // Cache-aware gating
  trimFloorRatio: number;               // default: 0.25 (25% of context window)
  prefixTrimRatio: number;              // default: 0.70 (automatic-prefix caches only)

  // Hot zone (token-offset recency)
  hotZoneMinTokens: number;             // default: 16_000
  hotZoneRatio: number;                 // default: 0.05 (5% of context window)
  extendedRetentionMultiplier?: number; // default: 1.0 with persister, 1.5 without

  // Progressive bookend degradation
  bookendMaxChars: number;              // default: 2_000 (at hot zone boundary)
  bookendMinChars: number;              // default: 256 (at far end)
  degradationSpanRatio: number;         // default: 0.40 (40% of context window)

  // Tool categorization
  toolCategories?: Record<string, 'rereadable' | 'non-reproducible' | 'ephemeral' | 'computational'>;

  // Persistence (typically set at top-level AgentLoopConfig.persistResult)
  persistResult?: PersistResultFn;

  // Aggregate budget enforcement
  maxAggregateTurnTokens?: number;      // default: 150_000
}
```

**Rationale**: This graduated approach avoids the "cliff edge" of aggressive clearing. The key findings from industry research:

- **JetBrains (NeurIPS 2025)**: Simple observation masking matches LLM summarization at zero cost for SE agents, reducing cost ~50% without performance degradation. But the masking should be graduated, not all-or-nothing.
- **OpenClaw**: Uses semantic bookends (first/last 1,500 chars) as soft-trim before hard-clearing. In-memory only; disk transcript stays intact. This preserves the most structurally useful parts of tool output.
- **Production coding agents (e.g., Anthropic's CLI)**: Only clear tool results, never assistant text. The agent's own synthesis is the natural "distillation" that survives clearing.
- **LangChain Deep Agents**: Prioritizes offloading over lossy summarization. Three-tier graduated strategy.

### Layer 3: the failsafe

Layer 3 is mechanical and costs no LLM call. It has two halves.

**In-band, before a request: the view only.** After the swap and Layer 1, if the estimate is still at or above `failsafe.threshold` (default 0.95) of the **effective** window, the request's view drops the oldest units of history until it fits. The source keeps every message and the observer still reads them, so nothing is lost: the model is shown less for this request, with a one-line note naming the span it is not shown. The latest user message and the last unit always stay, and a tool call is never separated from its result.

**After the provider rejects a request as too long: the source.** The estimate was optimistic, so `handleOverflowError` shrinks history to 80% of the model's capacity, leaving room for the slots and tools measured on the last pass. Observed messages leave as in any swap. Unobserved messages that do not fit are dropped, oldest first, and the observation log records a `GAP` line saying how many messages from which span were lost and why; `onMemoryGap` reports the same. The latest user message stays for the next attempt. Overflow is recognized by `isContextOverflow`, which excludes throttling errors that share its wording.

---

## Events

Compaction reports through observational memory's events:

- `onObservation(event, origin)`: observations recorded, and messages swapped out (`event.removedMessages`, with `trigger`, `tokensBefore` and `tokensAfter`). A consumer keeping its own memory, or a durable transcript marker, hangs off this.
- `onReflection(event, origin)`: the log was condensed.
- `onMemoryError(info, origin)`, `onMemoryRecovered(info, origin)`: a memory call failed after all its attempts, and the first success after failures. A failed call loses nothing by itself: unobserved messages stay in context. Only a provider overflow before memory records them drops any, and `onMemoryGap` reports that.
- `onMemoryGap(info, origin)`: messages were dropped before memory recorded them (provider overflow only).

The same reports reach the event bridge as the `memory` event, so they forward from sub-agents.

---

## Explicit entry points

Compaction is autonomous: every part of it runs inside `transformContext`, before every LLM call, so a consumer never has to trigger it. Three entry points exist for an owner that wants to choose the moment. All three hold the loop gate, so a call made during a turn waits for the turn to end.

- `compactNow(options?)`: observe up to the verbatim tail, swap, then reflect if the log is due, whatever the utilization. A failed or stopped observer call changes nothing. With `observe: false` it swaps in only what is already observed and never waits on the memory model. On `CortexAgent` it compacts both resident loops and returns each loop's result (the talker always swaps without observing).
- `observeNow(options?)`: record everything not yet in the log, removing nothing.
- `digestIdle(options?)`: run pending observation and the threshold pass in a quiet moment, bounded by a timeout and preemptible. The duplex session schedules it after each run.

---

## Token tracking

Cortex tracks context size two ways and uses the larger:

- **Measured**: after every parent LLM call, the input tokens from `AssistantMessage.usage` (input plus cache reads and writes). This is authoritative for the context that was sent. The event bridge records it on `turn_end`; no consumer wiring is needed. It is an assignment, not a sum: each call's input is the whole context.
- **Estimated**: the heuristic `estimateTokens` (characters / 3.5, pi-ai's `estimateTextTokens`) over the context this call would send, slots and view injections included. This catches content the last measurement never saw.

Compaction decisions compare that size with the **effective** window: the model's window, or the consumer's `contextWindowLimit` when it is smaller. After a swap, an overflow drop, or `observeNow`, the measured count describes a context that no longer exists, so it is invalidated and estimates stand alone until the next call measures again.

---

## Configuration summary

```typescript
interface CortexCompactionConfig {
  // Never run a memory call while a request waits (the duplex talker).
  nonBlocking?: boolean;                 // default: false

  microcompaction: MicrocompactionConfig; // Layer 1, above
  failsafe: {
    threshold: number;                    // default: 0.95 of the effective window
  };

  // Activation threshold, verbatim tail, buffering, reflection, call policy.
  observational?: Partial<ObservationalMemoryConfig>;
}
```

Compaction is always active. There are no `enabled` toggles.

---

## Disk persistence for tool results

The same `PersistResultFn` callback drives disk persistence in three places: the proactive [tool result persistence interceptor](tool-result-persistence.md) (per-tool, at execution time), microcompaction trim/clear of historic results, and aggregate per-turn budget enforcement. Configure once; all three layers use it.

**Motivation:** Non-reproducible results (WebFetch, Bash, SubAgent) cannot be re-fetched. Truncating loses information; persistence to disk lets the agent Read the content back if it needs to reference it later in the same long-lived session. The persisted files also survive a swap, which removes the tool results from history.

**Recommended configuration** (top-level on `AgentLoopConfig`):
- `persistResult`: `PersistResultFn` callback. The consumer implements the I/O and returns the file path. Cortex propagates this to the proactive interceptor and to `MicrocompactionConfig.persistResult` automatically.

**Legacy configuration** (`MicrocompactionConfig.persistResult`):
- Still accepted for backwards compatibility. If both top-level and `MicrocompactionConfig` settings are present, the top-level wins (logged at debug level).

**Microcompaction trim/clear behavior:**
- When a `placeholder` or `clear` action is applied to a non-reproducible or computational result, the callback is invoked with the full original content.
- The replacement text includes the file path: `[Tool result persisted -- {toolName}: "{preview}" -- use Read on {path} for full content]`
- Rereadable results (Read, Glob, Grep) are NOT persisted in this path since the agent can re-invoke the tool. (Note: at the proactive interceptor layer, only Read, Edit, Write, and Glob skip persistence by name; Grep is persisted there because grep results are not trivially re-derivable from the tool name alone.)
- If the callback throws, standard placeholder/clear text is used as fallback.

---

## Aggregate per-turn token budget

In addition to the per-result insertion cap (`maxResultTokens`, default 50K), an aggregate cap limits the total tokens across all tool results in a single message.

**Motivation:** A single agentic loop turn with many parallel tool calls (e.g., 10 file reads at 50K each = 500K) can overwhelm context before microcompaction evaluates.

**Configuration** (in `MicrocompactionConfig`):
- `maxAggregateTurnTokens`: number (default 150,000)

**Behavior:**
- After individual per-result caps are applied, the aggregate token count for all tool results in the message is computed.
- If the aggregate exceeds `maxAggregateTurnTokens`, the largest results are bookended (head + tail) until the total is under budget.
- If `persistResult` is configured, full content is persisted to disk before bookending, and the bookended text includes a reference to the persisted file.
