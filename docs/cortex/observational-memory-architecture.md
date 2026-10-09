# Observational memory architecture

**Status**: Implemented. Hardened 2026-10-09 ([om-hardening-plan.md](./om-hardening-plan.md)): verbatim tail, bounded failures, `compactNow` and `observeNow`, gap recording; classic summarization removed.
**Date**: 2026-04-10
**Related docs**: [compaction-strategy.md](./compaction-strategy.md), [cortex-architecture.md](./cortex-architecture.md), [context-manager.md](./context-manager.md)
**Research basis**: [Mastra Observational Memory](https://mastra.ai/research/observational-memory) (source analysis of `mastra-ai/mastra` repository, April 2026)

---

## Overview

Observational memory is Cortex's compaction. Two background LLM agents on the utility model, the observer and the reflector, maintain a compressed event log of the conversation. As the context fills, observations replace the older messages they cover while the most recent messages stay verbatim. Sessions run indefinitely with high memory fidelity and good prompt cache behavior.

Layer 1 (tool result trimming) and Layer 3 (the failsafe) run around it; see [compaction-strategy.md](./compaction-strategy.md).

### Why this exists

Conversation summarization, the approach this replaced, has three limits for long-running sessions:

1. **Blocking**: the loop pauses for a summarization call when the context fills.
2. **Lossy**: narrative summaries lose event-level granularity, and summarizing summaries compounds the loss.
3. **Cache-hostile**: each summary replaces the last, invalidating the prompt prefix cache.

Observational memory addresses all three: observation runs in the background before it is needed, produces event logs rather than prose (preserving granularity through reflection), and appends rather than rewrites.

### Core insight

The system is modeled on human cognition: a "subconscious" observer watches the conversation and extracts structured notes, while a reflector periodically reorganizes and condenses those notes. The main agent (actor) sees only the compressed observations plus a tail of recent raw messages. This achieves 5-40x compression while scoring 84-95% on LongMemEval benchmarks (beating oracle baselines where the LLM was given only the relevant raw conversations).

---

## Design decisions

### 1. L1 runs after the swap

Observational memory compresses the conversation; there is no summarization layer. Layer 1 (microcompaction) runs **after** the swap, on the history that remains, trimming large tool results in the view when the prompt cache has gone cold. The observer always reads full-fidelity source messages, while the request benefits from trimming. The insertion-time cap always runs first. See [compaction-strategy.md](./compaction-strategy.md#layer-1-tool-result-trimming-microcompaction).

### 2. Percentage-based thresholds on total context utilization

Thresholds are expressed as percentages of the total context window, not fixed token amounts. This supports any context window size from 32k to 1M+.

The observation threshold is based on **total context window utilization**, not just message tokens. This includes system prompt, consumer slots, the observation slot, and raw messages. If a consumer bloats their slots, the effective message budget shrinks and observation activates sooner.

### 3. Observations live in a context slot

Observations are stored in a Cortex-managed context slot (`_observations`) at the last slot position (after all consumer slots, before conversation history). This provides:

- Stable prefix for cache optimization (observation content changes infrequently)
- Clean separation from conversation history
- Consistent slot management via the existing `ContextManager`

The slot is managed internally by the `ObservationalMemoryEngine`. Consumers never interact with it directly.

### 4. Dynamic buffer intervals

Buffer intervals are computed dynamically at each turn boundary based on current context utilization. The interval targets roughly 4 buffer cycles between the current utilization and the activation threshold, capped at a maximum token count to prevent oversized observer calls on large windows. This adapts naturally to any context window size and any consumer slot configuration without assuming a fixed "message budget."

### 5. Consumer hooks

Method-level hooks notify consumers: `onObservation` (observations recorded, messages swapped out), `onReflection` (the log condensed), and the memory health hooks `onMemoryError`, `onMemoryRecovered` and `onMemoryGap`. Multiple handlers, register at any time. On `CortexAgent` they fan out to both resident loops with the loop's origin. They let consumers with their own memory (e.g., Animus's thought and experience compression) coordinate with Cortex's.

### 6. Optional recall via consumer-provided search

Cortex provides an opinionated but minimal recall tool interface. Observations include timestamps. A consumer can provide a `search` function that accepts a query and optional time range. Cortex registers a recall tool that wraps it. Consumers own message persistence and search implementation.

### 7. Observer and reflector prompts

Default prompts are adapted from Mastra's proven prompts (94.87% on LongMemEval). Consumers can append custom instructions but cannot replace the core prompt. This ensures a quality baseline while allowing domain-specific customization.

### 8. No observation editing

Agents cannot directly edit their observations. Corrections flow through the observer: the user says "no, I meant X," the next observation captures the correction, and the reflector reconciles it with the original. `observeNow()` records everything not yet in the log at once, for a correction the log should carry immediately.

### 9. No pinned observations

Observations are not pinnable. Long-term memory that must survive indefinitely is a consumer concern (vector databases, persistent storage). The observation system is for context compression, not permanent storage. Archive pointers and observation group ranges are not used; consumers who need recall implement their own persistence and search.

### 10. L3 never truncates observations, and never loses silently

The in-band failsafe cuts only the request's **view**: the source keeps every message and the observer still reads it. Messages leave the source unobserved only after the provider rejects a request as too long, and then the log records a `GAP` line (marked critical, and restored if a reflection drops it) and `onMemoryGap` fires.

### 11. A verbatim tail survives every swap

A swap keeps the most recent messages as they are: units (a tool call with its results, or a single message) walked back from the end while they fit `min(tailRatio × effective window, tailMaxTokens)`, and the last unit whatever its size. The latest user message stays wherever it is: when it is older than the cut, it moves to the front of what remains. The agent never loses the request it is working on, nor the last thing it did.

### 12. Failures are bounded and change nothing

Every observer and reflector call runs under a policy: a timeout per attempt, quick retries for errors worth retrying, and the caller's abort ending the call at once. A call that fails after its attempts changes nothing it would have recorded: unobserved messages stay in context and a failed reflection keeps the current log. One failure puts memory into a degraded mode in which a request never waits on a memory call; background calls keep trying, and their first success recovers it. Memory failures never reach the loop's general `onError`.

### 13. Explicit compaction and observation

`compactNow()` swaps observations in whatever the utilization; `observeNow()` records without removing anything. Both run under the loop gate, so neither races a turn.

### 14. Observations are tracked by message range

Every buffered chunk records the end of the range it covers, and every source rewrite reports to the ledger that owns the indices, so an observer in flight survives a swap and lands at its shifted range. Nothing is observed twice, and nothing leaves the source unobserved except through decision 10.

---

## Configuration

```typescript
interface CortexCompactionConfig {
  // Never run a memory call while a request waits (the duplex talker).
  nonBlocking?: boolean;  // default: false

  microcompaction: MicrocompactionConfig;  // Layer 1
  failsafe: FailsafeConfig;                // Layer 3

  observational?: Partial<ObservationalMemoryConfig>;
}
```

### Non-blocking posture and idle digestion

For loops whose turns must never stall on a multi-second in-band LLM call (a presence loop mid-conversation), two controls exist:

- **`nonBlocking: true`** disables every synchronous memory call inside `transformContext`. A swap still merges what is already observed (cheap), but the catch-up observer and inline reflection never run while a request waits; reflection at threshold swaps in a buffered result or launches in the background. Past the threshold, buffering keeps launching at its floor interval, so the next activation has chunks to merge.
- **`AgentLoop.digestIdle()`** runs the deferred work outside a prompt: it waits for any in-flight observer chunk to land, observes the still-unobserved tail (buffering the result), then runs the threshold pass (activation, reflection) with blocking work allowed even under the non-blocking posture. It is serialized through the loop gate, so it can never race a running turn's history mutations; an owner schedules it during idle windows so the expensive calls happen while nobody is waiting. Returns `{ observerRan, historyCompacted }`. Each phase is bounded (`observerTimeoutMs`, default 60s): on timeout the digestion releases the gate and an abandoned pass discards its late rewrite. A `signal` option preempts the pass the same way (`preempted: true`), which is how the duplex facade keeps idle digestion from delaying a user's next input.

### ObservationalMemoryConfig

```typescript
interface ObservationalMemoryConfig {
  /**
   * Percentage of total context window utilization that triggers observation
   * activation. When total context (system prompt + slots + observations +
   * messages) exceeds this fraction of the context window, buffered
   * observations activate and raw messages are trimmed.
   * @default 0.9
   */
  activationThreshold?: number;

  /**
   * Maximum token count per async buffer observation. Caps how many tokens
   * of unobserved messages a single observer call will process. Prevents
   * oversized observer calls on large context windows.
   * The actual interval is computed dynamically (see Observer System section).
   * Internally clamped to utilityModelContextWindow * 0.6 to ensure the
   * observer input fits within the utility model's context window.
   * @default 30_000
   */
  bufferTokenCap?: number;

  /**
   * Minimum tokens of unobserved messages before a buffer observation runs.
   * Prevents thrashing when the context window is nearly full or on very
   * small windows.
   * @default 5_000
   */
  bufferMinTokens?: number;

  /**
   * Target number of buffer cycles between current utilization and the
   * activation threshold. Higher = more frequent, smaller observer calls.
   * Lower = fewer, larger observer calls.
   * @default 4
   */
  bufferTargetCycles?: number;

  /**
   * Fraction of the context window at which reflection triggers.
   * When the observation slot exceeds this percentage of the context window,
   * the Reflector condenses it. Scales naturally across all window sizes.
   * Internally clamped to utilityModelContextWindow * 0.5 to ensure the
   * reflector input fits within the utility model's context window.
   * @default 0.20
   */
  reflectionThreshold?: number;

  /**
   * Fraction of reflectionThreshold at which async reflection buffering
   * begins. e.g., 0.5 = start background reflection at 50% of threshold.
   * @default 0.5
   */
  reflectionBufferActivation?: number;

  /**
   * Token budget for previous observations sent to the Observer as context.
   * Provides continuity between observation cycles.
   * @default 2_000
   */
  previousObserverTokens?: number;

  /**
   * Custom instructions appended to the Observer's system prompt.
   * Use for domain-specific observation behavior.
   */
  observerInstruction?: string;

  /**
   * Custom instructions appended to the Reflector's system prompt.
   * Use for domain-specific reflection behavior.
   */
  reflectorInstruction?: string;

  /**
   * Share of the effective context window the verbatim tail may hold: the
   * most recent messages a swap keeps as they are.
   * @default 0.2
   */
  tailRatio?: number;

  /**
   * Cap on the verbatim tail, in tokens.
   * @default 64_000
   */
  tailMaxTokens?: number;

  /**
   * Wall-clock bound on each observer or reflector attempt.
   * @default 60_000
   */
  callTimeoutMs?: number;

  /**
   * Attempts per observer or reflector call, the first included. Quick
   * retries (1s, then 2s) for errors worth retrying; authentication and
   * context-overflow errors are not retried.
   * @default 3
   */
  maxAttempts?: number;

  /**
   * Budget for all memory calls one in-band pass (a request waiting) may
   * make before it sends the request as it stands.
   * @default 60_000
   */
  blockingBudgetMs?: number;

  /**
   * Optional recall tool. When provided, Cortex registers a recall tool
   * that enables the agent to search through persisted conversation history.
   * The consumer owns message persistence and search implementation.
   */
  recall?: {
    search: (
      query: string,
      options?: { timeRange?: { start?: Date; end?: Date } }
    ) => Promise<RecallResult[]>;
  };
}
```

### Event types

```typescript
interface ObservationEvent {
  /** What recorded them: a threshold activation, compactNow, observeNow, or the swap before an overflow drop. */
  trigger: 'activation' | 'compact-now' | 'observe-now' | 'emergency';
  /** Messages whose observations this event added to the log. */
  observedMessages: AgentMessage[];
  /** Messages that left context; empty when nothing was swapped out. */
  removedMessages: AgentMessage[];
  /** The whole observation log after this event. */
  observations: string;
  contextUtilization: number;
  /** Estimated context size before and after, in tokens. */
  tokensBefore: number;
  tokensAfter: number;
  /** Whether observations were made while a caller waited. */
  sync: boolean;
  timestamp: Date;
}

interface ReflectionEvent {
  previousObservations: string;
  newObservations: string;
  generationCount: number;
  /** Compression level used (0-4). */
  compressionLevel: number;
  timestamp: Date;
}

interface MemoryErrorInfo {
  operation: 'observe' | 'reflect';
  trigger: 'buffer' | 'activation' | 'idle' | 'compact-now' | 'observe-now';
  error: Error;          // the last attempt's
  attempts: number;
  /** 1 on the call that started a degraded episode. */
  consecutiveFailures: number;
  /** 'retry-later' (background), 'partial-swap' (in-band), 'unchanged'. */
  outcome: 'retry-later' | 'partial-swap' | 'unchanged';
}

interface MemoryRecoveredInfo {
  failures: number;
  degradedForMs: number;
}

interface MemoryGapInfo {
  droppedMessages: number;
  from: Date | null;
  to: Date | null;
  reason: string;
  /** The GAP line appended to the log. */
  note: string;
}
```

The memory events also reach the event bridge as `memory` (`{ kind: 'error' | 'recovered' | 'gap', info }`), so they forward from sub-agents.

---

## Context layout

The message array layout:

```
Message Array:
┌─────────────────────────────────────────┐
│ SYSTEM HEAD (0)                         │  Prompt sections and initial tools
│                                         │
│ SLOT REGION (1..N)                      │  Consumer-managed, named slots
│   [slot 1: system context]              │
│   [slot 2: thoughts]                    │
│   [slot 3: experiences]                 │
│                                         │
│ OBSERVATION SLOT (N+1)                  │  Cortex-managed, last slot position
│   [observations + current-task +        │  Stable prefix, cache-friendly
│    suggested-response]                  │  Changes only on activation/reflection
│                                         │
├─────────────────────────────────────────┤
│ RAW MESSAGE REGION (N+2..M)             │  The verbatim tail and anything not
│   [user message]                        │  yet swapped out; grows between swaps
│   [assistant response]                  │
│   [toolCall + toolResult messages]      │
│   [user message]                        │
│   ...                                   │
│                                         │
│ EPHEMERAL CONTEXT (injected)            │  Per-call, never stored
│   [skill buffer, background tasks]      │
│                                         │
│ CURRENT INPUT                           │  This turn's prompt
└─────────────────────────────────────────┘

Cache behavior:
  Slots + observation slot = stable prefix: cache hit (between swaps)
  Raw messages = appending suffix: new tokens each turn
  On a swap: observation slot updates, older raw messages leave: partial cache miss
  On reflection: observation slot rewritten: full cache miss (rare)
```

### Slot registration

Cortex appends `'_observations'` to the consumer's slot list during agent construction. This is transparent to the consumer:

- Consumer configures: `slots: ['system-context', 'thoughts', 'experiences']`
- Cortex internally registers: `['system-context', 'thoughts', 'experiences', '_observations']`
- `slotCount` becomes 4 (consumer's 3 + 1 internal), so `historyStart` is 5 (the system head plus 4 slots)
- All compaction operations use `historyStart` to skip the head and slot region

The slot stays empty until there are observations. Then it holds a user-role message containing:
1. Context preamble (instructions for the agent on how to use observations)
2. `<observations>` block with the formatted observation log
3. `<current-task>` with the agent's current task
4. `<suggested-response>` with a continuation hint

---

## Observer system

### When it runs

The observer runs asynchronously in the background. The interval between observer calls is computed dynamically at each turn boundary based on current context utilization. There is no fixed "message budget"; the system adapts to whatever space is actually available.

**Interval calculation (at each `turn_end`):**

```typescript
// Current state
const totalTokens = systemPromptTokens + slotTokens + observationTokens + messageTokens;
const currentUtilization = totalTokens / contextWindow;

// How many tokens remain before activation triggers?
const tokensUntilActivation = (activationThreshold - currentUtilization) * contextWindow;

// Target N buffer cycles between now and activation
const dynamicInterval = tokensUntilActivation / bufferTargetCycles;

// Cap at maximum (prevent huge observer calls, respect utility model window)
// Floor at minimum (prevent thrashing when nearly full)
const effectiveBufferCap = Math.min(bufferTokenCap, utilityModelContextWindow * 0.6);
const bufferInterval = Math.max(
  Math.min(dynamicInterval, effectiveBufferCap),
  bufferMinTokens
);
```

**How this adapts:**

- `bufferTargetCycles` (default 4) controls granularity: the system aims for ~4 observer calls between current state and activation
- `effectiveBufferCap` (bufferTokenCap clamped to utility model window) prevents oversized observer calls
- `bufferMinTokens` (default 5k) prevents thrashing near the activation threshold
- As the window fills up, intervals naturally shorten (more frequent, smaller buffers)
- If consumer slots grow mid-session, `tokensUntilActivation` shrinks, intervals shorten automatically
- No assumption about how much space is "for messages" vs other context

**Example scenarios** (assuming 15k of system prompt + consumer slots, negligible observations early in session):

| Context Window | At 50% Util | Tokens Until 90% | Dynamic Interval | Capped At |
|---|---|---|---|---|
| 32k | 16k used | ~13k | ~3.2k | 5k (floor) |
| 100k | 50k used | ~40k | ~10k | 10k |
| 200k | 100k used | ~80k | ~20k | 20k |
| 500k | 250k used | ~200k | ~50k | 30k (cap) |
| 1M | 500k used | ~400k | ~100k | 30k (cap) |

As utilization increases toward 90%, intervals shrink:

| Context Window | At 80% Util | Tokens Until 90% | Dynamic Interval | Capped At |
|---|---|---|---|---|
| 100k | 80k used | ~10k | ~2.5k | 5k (floor) |
| 200k | 160k used | ~20k | ~5k | 5k |
| 1M | 800k used | ~100k | ~25k | 25k |

Past the activation threshold, buffering keeps launching at the floor interval (`bufferMinTokens`, bounded by the input cap) instead of stopping: a swap can only bring in what is observed.

### Trigger mechanism

At each agentic turn boundary (`turn_end` event):

1. Compute unobserved message tokens (messages after the watermark).
2. If unobserved tokens >= `bufferInterval` and no observer is in flight, launch the observer over the next **piece**: whole units from the watermark, as many as fit the observer's input cap. The ledger records the pending range.
3. When the observer completes, its chunk lands at that range (shifted by any swap since) and the watermark advances. A failed call leaves the range unobserved for the next attempt.

### Activation: the swap

In `applyInTransformContext()`, before each LLM call, once utilization reaches `activationThreshold`:

1. **Select the tail.** The verbatim tail starts at `T`; the latest user message is at `U`.
2. **Catch up**, only when blocking work is allowed, memory is healthy, and swapping in what is already observed would still leave utilization at or above the threshold: wait for the observer in flight, then observe `[watermark, T)` in pieces within the input cap. All of it shares one budget (`blockingBudgetMs`) and the run's abort signal.
3. **Cut** at the unit boundary at or below `min(T, watermark)`. If nothing new would leave history, stop.
4. **Merge** every chunk covering a removed message into the log, in order, with the latest of their hints. A chunk that reaches past the cut is merged whole; its remaining messages stay in history as observed-and-kept.
5. **Remove** the messages before the cut, except the latest user message, which moves to the front of what remains.
6. **Rebase** the ledger: the observed-and-kept prefix, the remaining chunks and the in-flight range shift with the messages.
7. Fire `onObservation`, then check the log against the reflection threshold.

Every await happens before anything changes; steps 3 to 6 run in one synchronous block. An abandoned pass (a timed-out digestion) applies nothing, and what it observed stays buffered. Chunks wholly inside the tail stay buffered rather than merged, so a swap never grows the log without removing anything.

When the latest user message is far back (a long autonomous run), the kept history is that message, then a gap the log covers, then the tail. The log can therefore describe work after the oldest kept message; the preamble says so.

### Observer prompt

Adapted from Mastra's observer prompt. Key structure:

```
System: "You are the memory consciousness of an AI assistant. Your
observations will be the ONLY information the assistant has about
past interactions."

Input:
  - Previous observations (tail-truncated to previousObserverTokens)
  - Formatted message history (with timestamps, tool results)

Output (XML):
  <observations>
  Date: Apr 10, 2026
  * 🔴 (14:30) [high-priority observation]
  * 🟡 (14:32) [medium-priority observation]
    * -> [detail]
    * ✅ [completed item]
  </observations>

  <current-task>
  - Primary: What the agent is currently working on
  - Secondary: Other pending tasks
  </current-task>

  <suggested-response>
  Hint for the agent's next message after observation activates
  </suggested-response>
```

Priority levels (inter-agent signaling, guides the reflector):
- 🔴 Critical: user facts, preferences, assertions, key decisions
- 🟡 Medium: project details, tool results, contextual information
- 🟢 Low: background context, minor details
- ✅ Completed: resolved tasks, answered questions

The consumer can append domain-specific instructions via `observerInstruction`.

### Message formatting for the observer

Messages are formatted with temporal context for the observer:

```typescript
function formatMessagesForObserver(messages: AgentMessage[]): string {
  // Each message formatted as:
  // **role (HH:mm)**: content
  // Tool calls: formatted with tool name, key arguments, result summary
  // Tool results: formatted with tool name and content
  // Timestamps derived from message metadata or inferred from position
}
```

Tool results receive special formatting: the tool name is prominent, results are presented with enough context for the observer to extract takeaways without needing the full output.

---

The prompt tells the observer that after a swap older raw messages are removed and only the most recent stay verbatim, so its continuation hints connect what the agent was doing before that tail to the work in it. The preamble tells the agent the same: the most recent messages follow verbatim and are the more precise record where they overlap an observation, an observation can describe work after the oldest message still visible, and a line marked `GAP` means a span was lost before it could be recorded, so it should say so rather than guess.

Tool results in the observer's input are bookended to fit the observer's input cap, so a single huge result never overflows the utility model.

---

## Reflector system

### When it runs

The reflector condenses observations when the observation slot exceeds the effective reflection threshold. The threshold is percentage-based, scaling with the context window and clamped to the utility model's capacity:

```typescript
const effectiveReflectionThreshold = Math.min(
  contextWindow * reflectionThreshold,    // default: 20% of context window
  utilityModelContextWindow * 0.5         // ensure input fits in utility model
);
```

Like the observer, the reflector runs asynchronously.

### Trigger mechanism

After each swap:

1. Estimate tokens in the log.
2. From `effectiveReflectionThreshold * reflectionBufferActivation` (50%), launch the reflector in the background.
3. At `effectiveReflectionThreshold`, swap in a buffered reflection if one is ready; otherwise run the reflector while the caller waits (or, under the non-blocking posture, in the background).

A reflection condenses the log as it was when the reflector started, so it lands onto that prefix and keeps everything appended since. An empty, unparseable, or not-smaller reply is rejected, and a failed reflection keeps the current log: larger than ideal, which costs tokens, not memory. A `GAP` line the reflector drops is put back.

### Compression levels

The reflector retries with escalating compression when output exceeds the target:

| Level | Detail | Guidance |
|---|---|---|
| 0 | Full | No compression guidance (first attempt) |
| 1 | 8/10 | Gentle: condense beginning more |
| 2 | 6/10 | Aggressive: merge repeated tool calls |
| 3 | 4/10 | Heavy: summarize oldest 50-70% into paragraphs |
| 4 | 2/10 | Maximum: collapse ALL tool sequences to outcomes only |

Maximum 3 retries from starting level. Each reflection increments `generationCount`.

### Reflector prompt

Adapted from Mastra's reflector prompt:

```
System: "You are the observation reflector. Your reason for existing
is to reflect on all the observations, re-organize and streamline
them, and draw connections and conclusions between observations.

IMPORTANT: your reflections are THE ENTIRETY of the assistant's
memory. Any information you do not add to your reflections will be
immediately forgotten."

Guidance:
  - Preserve dates/times when present
  - Combine related items
  - Preserve ✅ completion markers
  - Condense older observations more aggressively, retain detail for recent
  - User assertions ("User stated X") take precedence over questions
  - Keep every GAP line
```

The consumer can append domain-specific instructions via `reflectorInstruction`.

---

## Failure handling

| Call | Policy | On failure |
| --- | --- | --- |
| Background observer (buffering, idle) | timeout, 3 attempts | its range stays unobserved; the next turn tries again |
| In-band catch-up | timeout, 3 attempts, one shared pass budget, run abort | the swap brings in only what is already observed; the request goes out as it stands |
| Reflector | timeout, 3 attempts | the current log stays |
| `compactNow` / `observeNow` | full policy (the user asked) | history and the log are unchanged; the result says why |

Quick retries wait 1s, then 2s. Authentication and context-overflow errors are not retried: the same request fails the same way. A reply that cannot be used (empty, unparseable, truncated, degenerate repetition, a reflection that is not smaller) counts as a failed attempt.

While memory is degraded (a call failed after all its attempts, and none has succeeded since), an in-band pass makes no memory calls: it merges what is buffered and sends the request. Background buffering keeps calling, and its first success fires `onMemoryRecovered`.

---

## Threshold system

### Total context utilization

All threshold decisions use total context utilization:

```typescript
const totalTokens = systemPromptTokens + slotTokens + observationTokens + messageTokens;
const utilization = totalTokens / contextWindow;
```

This means:
- If consumer slots grow, message budget shrinks, observation activates sooner
- If the consumer calls `setContextWindowLimit()` to a smaller value, all thresholds adjust
- The system gracefully handles any context window size

### Utility model context window constraints

Both the observer and reflector run on the utility model. Their inputs must fit within the utility model's context window. Two internal clamps enforce this:

```typescript
// Observer: each buffer call must fit in the utility model
const effectiveBufferCap = Math.min(
  bufferTokenCap,                         // consumer config (default 30k)
  utilityModelContextWindow * 0.6         // 60% of utility model window
);
// The remaining 40% accommodates the observer prompt (~4k tokens),
// previous observations context (~2k tokens), and output.

// Reflector: the full observation input must fit in the utility model
const effectiveReflectionThreshold = Math.min(
  contextWindow * reflectionThreshold,    // 20% of primary model window
  utilityModelContextWindow * 0.5         // 50% of utility model window
);
// The remaining 50% accommodates the reflector prompt (which embeds the
// full observer instructions for format understanding) and output.
```

These clamps are internal implementation details, not consumer-facing configuration. They ensure correct behavior regardless of the utility model's capabilities. With common utility models (128k-200k context), the effective caps are 77k-120k for the observer and 64k-100k for the reflector, which are in the right range for quality output.

If the consumer uses a utility model with a very small context window, both observer and reflector calls are naturally bounded to fit, at the cost of more frequent observation and reflection cycles.

### Token estimation

Uses the existing dual-tracking approach:
- Heuristic: `estimateTokens(text)` = `Math.ceil(text.length / 4)`
- Post-hoc: the measured input of the last parent call
- Working value: `Math.max(heuristic, postHoc)` to avoid underestimating

A swap, an overflow drop and `observeNow` invalidate the measured count: it described a context that no longer exists.

### Activation, failsafe and overflow

- **Activation threshold** (default 0.9): of the **effective** window (the consumer's limit, or the model's window). A swap happens here.
- **Failsafe threshold** (default 0.95): of the effective window, after the swap and Layer 1. Past it, the request's view is cut; the source keeps every message.
- **Overflow**: after the provider rejects a request as too long, the source shrinks to 80% of the model's capacity, observed messages leaving as in a swap and unobserved ones that do not fit dropped with a `GAP` line.

---

## Session state

### Saving state

```typescript
const history = agent.getConversationHistory();
const omState = agent.getObservationalMemoryState();
```

On `CortexAgent`, `getState()` returns both loops' histories and memory in one coherent artifact, and is the supported persistence surface.

### ObservationalMemoryState

```typescript
interface ObservationalMemoryState {
  /** Current observation text (the slot's log). */
  observations: string;
  continuationHint: { currentTask: string; suggestedResponse: string } | null;
  observationTokenCount: number;
  generationCount: number;
  /** Buffered chunks not yet merged into the log, each with the end of its range. */
  bufferedChunks: ObservationChunk[];
  /** Where the observed messages end. */
  bufferWatermark?: number;
  /** Messages at the front that are in the log and still in history. */
  observedPrefix?: number;
}

interface ObservationChunk {
  observations: string;
  messageTokensObserved: number;
  createdAt: Date;
  currentTask?: string;
  suggestedResponse?: string;
  /** End of the source range this chunk covers. Absent in state saved before ranges existed. */
  endIndex?: number;
}
```

### Restoring state

```typescript
agent.restoreConversationHistory(history);       // resets memory: it described the old history
agent.restoreObservationalMemoryState(omState);  // then restores it, aligned to that history
```

`restoreConversationHistory()` alone leaves memory empty, and drops any memory work in flight from the replaced session. The observation slot fills only when the restored log is non-empty.

### Session resumption

On resumption, the agent starts with:
- Observation slot populated with previous observations
- `<current-task>` and `<suggested-response>` providing continuity
- Conversation history restored (may include unobserved messages from the previous session)
- Buffered observation chunks that completed before the session was saved are restored alongside other state, each with the end of the range it covers, together with the `bufferWatermark` and the `observedPrefix`. In-flight (incomplete) observer calls are lost; their messages are observed again.

**Buffer restore on resumption:** Completed chunks and their ranges are restored verbatim, so the observer work done in the previous session is not recomputed. Because the indices point into the post-slot conversation history (restored first, at the same positions), the chunks stay aligned: the next swap removes exactly the messages it merges. Indices are clamped to the restored history length to guard against state that drifted ahead of a stale history (possible only on a hard crash). Older state restores leniently: chunks saved without ranges merge into one chunk ending at the watermark (lossless, since together they covered exactly that range), and state saved without a watermark drops its chunks and observes the history again.

**Resumption launches no observer.** The restored buffer is valid as-is, and the unobserved tail after the watermark is restored as raw messages, which the model reads directly. There is no benefit to pre-compressing that tail at resume time: at any utilization below the activation threshold there is ample room for the raw messages, and compression only matters as the window fills. So restore does no LLM work at all. The unobserved remainder is observed lazily through normal operation:

1. On the first `turn_end`, the dynamic interval calculation detects any unobserved messages after the watermark and runs async buffering once the tail crosses the interval, exactly as during a live session.
2. Each subsequent turn continues from the advanced watermark.

This makes resume a pure, deterministic state restore. It is also the correct behavior for consumers that resume sessions frequently: reopening a session never costs a utility-model call.

Sessions saved before buffer persistence was added have no `bufferWatermark`; their chunks are discarded on restore (the pre-persistence behavior) and re-observed lazily through normal `turn_end` buffering.

**Hot resumption edge case:** If the session is restored at high utilization (e.g., 89%) and the first agent turn pushes past the activation threshold, the per-prompt activation check in `transformContext` is the safety net: one blocking catch-up observation up to the verbatim tail, then the swap. After that, async buffering operates normally. This is at most one blocking pause on the first turn after a hot resumption, and only when resuming an already near-full session. We deliberately do not optimize this case with an eager resume-time observer, since that would tax every resume to smooth a rare one.

The `<suggested-response>` is particularly valuable on resumption: it tells the agent what it should say next after the gap, enabling smooth continuation even though the raw conversational flow may be sparse.

---

## Recall tool (optional)

### When to use

Recall is for consumers who persist raw messages and want the agent to search back through them. It is entirely optional. Without it, observations are the sole memory and the system works fine for most use cases.

### Architecture

The consumer provides a `search` function. Cortex wraps it in a tool.

```typescript
// Consumer configuration
const agent = await AgentLoop.create({
  compaction: {
    observational: {
      recall: {
        search: async (query, options) => {
          // Consumer's search implementation
          // Could use: vector DB, full-text search, SQL, etc.
          return results;
        },
      },
    },
  },
});
```

### Tool schema

The recall tool registered for the agent:

```typescript
{
  name: 'recall',
  description: 'Search through past conversation history for specific details. ' +
    'Use when your observations mention something but lack the detail needed, ' +
    'or when you need exact content (code, errors, quotes, URLs).',
  parameters: {
    query: { type: 'string', description: 'What to search for' },
    timeRange: {
      type: 'object',
      description: 'Optional time range to narrow results. ' +
        'Use timestamps from your observations for precision.',
      properties: {
        start: { type: 'string', description: 'ISO date string' },
        end: { type: 'string', description: 'ISO date string' },
      },
    },
  },
}
```

### Prompt instructions

When recall is configured, the observation context preamble includes:

```
Your observations include dates and timestamps. When you need more
detail behind an observation, use the recall tool with the relevant
time range from the observation's timestamp for precision.

Use recall when:
- You need exact content: code, error messages, file paths, specific numbers
- Your observations mention something but lack detail to fully answer
- You want to verify an observation before acting on it

Do not use recall when:
- Your observations already have enough detail
- The question is about general facts or preferences
```

### Temporal anchoring

The key value Cortex adds to recall is temporal context from observations. The agent sees:

```
Date: 2026-04-10
- 🔴 (14:30) Agent researched auth middleware...
```

And can call:

```
recall(query: "auth middleware research", timeRange: { start: "2026-04-10T14:00", end: "2026-04-10T15:00" })
```

The time range narrows the consumer's search space regardless of their backend (vector, full-text, SQL).

---

## Module structure

```
packages/cortex/src/compaction/
  index.ts            CompactionManager: observational memory, then L1, then L3
  microcompaction.ts  Layer 1, and the insertion-time cap
  tool-messages.ts    reading tool calls and results out of messages
  failsafe.ts         Layer 3 settings, overflow detection
  observational/
    index.ts          ObservationalMemoryEngine: activation, onTurnEnd, digestion, compactNow, observeNow
    ledger.ts         which messages are observed, by range; moves with every source rewrite
    buffering.ts      background observer and reflector calls
    in-band.ts        observation while a caller waits (catch-up)
    tail.ts           verbatim tail selection
    units.ts          units: a tool-call group or a single message
    swap.ts           where a swap cuts, what it keeps, how it lands
    log.ts            the observation log and its slot content
    reflection.ts     when and how the log is condensed
    emergency.ts      view truncation and the overflow drop with its gap reports
    calls.ts          call policy: timeouts, retries, abort
    health.ts         degraded and recovered
    reply.ts          rejecting unusable replies
    observer.ts       observer prompt, formatting, parsing
    reflector.ts      reflector prompt, compression levels, parsing
    recall-tool.ts    optional recall tool
    types.ts          public types
    constants.ts      defaults and prompts
```

---

## Open questions (minor)

### Observation slot size on resumption

On session resumption with a large observation history, the observation slot may hold significant token counts. This is expected (it is the compressed memory), and the dynamic thresholds account for it: the effective message budget on resumption is smaller than at session start.

### Small context budgets

Explicit Cortex budgets below 16K are honored. The observer's preferred
`bufferMinTokens` never overrides the effective buffer cap from the utility
model's capacity. For example, a 4096-token utility model has a 2457.6-token
buffer cap even when the preferred batch minimum is 5000 tokens. Reflection
continues to use the smaller of the primary budget fraction and the utility
capacity fraction. See [context capacity and budgets](context-manager.md#context-capacity-and-budgets).

