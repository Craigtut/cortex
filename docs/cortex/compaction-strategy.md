# Cortex Compaction Strategy

**STATUS**: Implemented (classic strategy)
**Date**: 2026-03-14
**Related docs**: [context-manager.md](./context-manager.md), [cortex-architecture.md](./cortex-architecture.md), [observational-memory-architecture.md](./observational-memory-architecture.md)

> **Note**: This document describes the "classic" compaction strategy (`strategy: 'classic'`). As of 2026-04-10, the default compaction strategy is **observational memory**, which replaces Layer 2 described here. See [observational-memory-architecture.md](./observational-memory-architecture.md) for the default system. Layer 1 (microcompaction) is shared by both strategies and operates in **cache-aware mode**: it only trims tool results when the prompt cache has expired, preventing cache invalidation during active use. See the "Cache-Aware Microcompaction" section below.

---

## Problem Statement

Cortex manages a persistent agent session that accumulates conversation history across heartbeat ticks. Each tick appends a user message (gathered context) and receives an assistant response (thoughts, tool calls, replies, reflections). Without intervention, this history grows until it exceeds the model's context window, causing either degraded performance ("context rot") or hard failures.

The current system has no compaction mechanism. There is no way to manage context growth, which means long-running sessions eventually degrade or fail. The goal is to keep the context window healthy and focused as it grows, preserving the rich context the agent has built up while shedding what is no longer needed.

Additionally, a consumer may have domain-specific compaction (e.g., compressing domain objects into narrative summaries stored in database-backed slots). This is already a form of compaction, but it operates independently of the conversation history. The two systems need to be coordinated.

---

## Design Principles

1. **Cortex is general-purpose; the backend is domain-specific.** Cortex handles conversation history compaction (summarizing old turns). The backend handles observational memory compaction (compressing thoughts/experiences/messages into structured summaries). Cortex provides the hooks; the backend decides what domain-specific work to do.

2. **Layered compression, not a single strategy.** Following established patterns from production coding agents: cheap operations first (clearing old tool results), then summarization only when needed. Each layer buys time before the next kicks in.

3. **Slots are sacred.** Context slots (persona, contacts, core-self, working-memory, observations, goals, tasks) are never touched by compaction. They are managed independently by the backend and rebuilt from database sources on startup.

4. **Ephemeral context is always fresh.** Ephemeral context is injected per-call via `transformContext` and never persists in history. It is never a compaction target.

5. **Compaction is autonomous with event notifications.** Cortex triggers compaction internally whenever thresholds are crossed. It emits `onBeforeCompaction` and `onPostCompaction` events so consumers can coordinate domain-specific work (e.g., observational memory processing, message re-seeding). The consumer never triggers compaction; it only reacts to it.

6. **Prefix cache preservation.** Compaction should minimize cache invalidation. Slots at the top of the message array are stable; compaction operates on conversation history below the slot region.

---

## Architecture Overview

```
Message Array Layout (from context-manager.md):

SYSTEM HEAD (0)                -- pi's leading system message: prompt and tools
  |
SLOT REGION (1..N)             -- Persistent, named, managed by ContextManager
  |
CONVERSATION HISTORY (N+1..M)  -- Grows with each tick, COMPACTION TARGET
  |
PREFIX CACHE BOUNDARY          -- Providers cache the longest unchanged prefix
  |
EPHEMERAL CONTEXT (appended)   -- Per-call via transformContext, never stored
  |
USER PROMPT                    -- Current tick input
```

Compaction operates exclusively on the **CONVERSATION HISTORY** region. Everything above (slots) and below (ephemeral, current prompt) is untouched.

---

## Three-Layer Compaction

### Layer 1: Tool Result Trimming ("Microcompaction")

**What**: Progressively reduce the footprint of old tool results in conversation history. Tool results (file reads, grep outputs, bash outputs, web fetches, MCP tool responses) are typically the largest individual items and dominate context usage.

**When**: Before every LLM call, inside the `transformContext` hook. Runs as an in-memory pre-pass before token counting. The conversation history on disk / in the session transcript is **never modified** by microcompaction (following OpenClaw's pattern). Only the context sent to the model is affected.

**Critical insight**: The agent's own text responses (assistant messages where it reasons about, synthesizes, and discusses tool results) are **never touched** by microcompaction. Only tool_result content blocks are candidates. This means that research findings, analysis, and conclusions the agent has already articulated in its own words survive regardless of what happens to the raw tool output.

**How** (cache-aware, token-offset-based, progressive degradation):

#### Tier 1: Insertion-time cap (always active)

Large tool results are truncated at insertion time before entering conversation history. Results exceeding `maxResultTokens` (default: 50,000 tokens) are truncated to head + tail with a marker in between. This prevents a single enormous result from destabilizing the context. This tier has zero cache impact since it runs at insertion, not in `transformContext`.

#### Tier 2: Cache-aware token-offset trimming (in `transformContext`)

L1's reactive trimming is gated on two checks before any work happens:

1. **Cache check**: Is the prompt cache still warm? If the time since the last LLM call is less than the active provider's cache TTL, L1 is **dormant** and history is returned untouched. This preserves cache hits during active use, which is where the biggest cost savings live.
2. **Trim floor check**: Is context utilization at least `trimFloorRatio` (default 25%)? Below this, trimming offers little benefit even when the cache is cold.

When both gates pass, L1 walks history from the most recent message backwards, accumulating token offsets. Each tool result lands in one of three zones based on its distance from the end:

```
[Most recent message]
        |
        |  Hot zone — full content, no trimming
        |  size = max(hotZoneMinTokens, contextWindow * hotZoneRatio)
        |
        |---[hot zone boundary]
        |
        |  Degradation span — bookended with shrinking sizes
        |  size = contextWindow * degradationSpanRatio
        |  bookend chars: bookendMaxChars (at boundary) → bookendMinChars (at far end), interpolated linearly
        |
        |---[degradation span boundary]
        |
        |  Beyond — placeholder (most categories) or clear (ephemeral only)
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

**Beyond the degradation span** — placeholder (preserves the "this was tried" breadcrumb):
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

### Layer 2: Conversation Summarization ("Compaction")

**What**: Summarize older conversation history into a structured summary while preserving a small tail of recent turns. The preserved tail keeps recent tool call/result pairs intact (which only exist in conversation history, not in any database). The backend then re-seeds the gap between observation watermarks and the preserved tail with messages from `messages.db`.

**When**: When estimated token usage exceeds `compactionThreshold` (default: 70% of context window) after Layer 1 has run.

**How**:

1. **Threshold check**: After microcompaction, estimate total context size (slots + cleared history + ephemeral estimate). If `estimatedTokens > model.contextWindow * compactionThreshold`, trigger compaction.

2. **Partition history**: Split conversation history into two regions:
   - **Compaction target**: All turns except the most recent `preserveRecentTurns` (default: 6 turns, roughly the last 1-2 ticks worth of exchanges including tool call/result pairs)
   - **Preserved tail**: The most recent turns, kept verbatim. This is the only mechanism that preserves recent tool call/result pairs, which do not exist in `messages.db` or any other database.

3. **Pre-compaction event**: Emit `onBeforeCompaction` with the compaction target. This is the backend's signal to:
   - Trigger observational memory processing for any unprocessed raw items (synchronous, awaited)
   - Flush any other critical state to disk/database

4. **Generate summary**: Make a direct `pi-ai` call (not through the agent loop) with the compaction target and the summarization prompt. Uses the same model as the main agent. The compaction target is sourced from the **original transcript** (not the in-memory microcompacted version), so the summarizer has access to full tool result content for high-quality compression. The summarization response is not added to the agent's conversation history.

5. **Replace history**: Replace the compaction target in the agent's conversation history with a single `user`-role message containing the tagged summary. The new conversation history becomes: `[summary message] + [preserved tail]`.

6. **Post-compaction event**: Emit `onPostCompaction` with metadata (tokens before, tokens after, summary content, oldest preserved turn timestamp). The backend uses this to:
   - Re-seed messages from `messages.db` that fall in the gap between the observation watermark and the preserved tail's oldest timestamp
   - Update any internal state that depends on conversation history

7. **Update token tracking**: Reset `currentContextTokenCount` based on the new history size.

**Why a preserved tail**: Tool call/result pairs only exist in conversation history. `messages.db` stores user-facing messages and agent replies, not tool calls. Without a preserved tail, the agent would lose all recent tool context after compaction, retaining only the summary's prose description. The preserved tail keeps the last 1-2 ticks of full-fidelity context including structured tool data.

**Summary tagging**: The compaction summary is wrapped in a clear marker so the agent knows it's reading a summary, not a real conversation turn. If multiple compactions occur, each is identifiable:

```xml
<compaction-summary generated="2026-03-15T10:30:00Z" turns-summarized="24">
...summary content...
</compaction-summary>
```

**Summarization prompt**: The default prompt is general-purpose (Cortex is a standalone framework used by any consumer). It asks for a structured `<summary>` with explicit sections and nothing else: a reasoning scratchpad in the output (an earlier version asked for an `<analysis>` block first) is what Anthropic's `reasoning_extraction` classifier refuses on Claude 5 models, which run summarization as the primary model. Consumers can override via `customPrompt`.

The prompt requires 11 sections:
1. **Primary Request and Intent** - All user requests, preserved verbatim
2. **Key Technical Concepts** - Technologies and frameworks discussed
3. **Files and Code Sections** - Specific files with paths, snippets, and why each matters
4. **Tool Call Outcomes** - What tools were called, what they returned, errors encountered
5. **Errors and Fixes** - Every error and its resolution, including user corrections
6. **All User Messages** - ALL non-tool-result user messages listed (critical for preserving intent)
7. **Problem Solving** - Problems solved and ongoing troubleshooting
8. **Pending Tasks** - Explicitly requested but not yet completed
9. **Current Work** - Exactly what was being worked on right before compaction (most important section)
10. **Key Decisions (Cumulative)** - Carried forward across compactions to prevent progressive loss
11. **Optional Next Step** - Only if directly aligned with the user's most recent request

**Output parsing**: The content of the `<summary>` tags is kept and wrapped in the `<compaction-summary>` tag. A stray `<analysis>` block a model writes anyway is stripped.

**Consumer override**: The consumer can provide a `customPrompt` via config that narrows the focus (e.g., skip certain sections if domain-specific compaction already covers them).

**Configuration**:
```typescript
interface CompactionConfig {
  threshold: number;                   // default: 0.70 (70% of context window)
  preserveRecentTurns: number;         // default: 6 (last ~1-2 ticks, includes tool calls)
  customPrompt?: string;              // optional: replace default summarization prompt
}
```

**Rationale**: Structured summarization with post-compaction rehydration is the most battle-tested approach across production coding agents. Factory.ai's evaluation across 36,000+ messages confirmed that domain-structured summarization outperforms generic compression. The 70% threshold is earlier than the ~75-83% used by some production agents and Codex's 95%, deliberately trading some context capacity for quality preservation (models degrade before hitting the limit).

### Layer 3: Emergency Truncation ("Failsafe")

**What**: If compaction itself fails or the context is still too large after compaction, drop the oldest conversation turns.

**When**: After a compaction attempt, if `estimatedTokens > model.contextWindow * 0.90` (90% of window). Also triggers reactively if the API returns a context overflow error (detected via pi-ai's `isContextOverflow()` utility).

**How**:
- Remove the oldest conversation turns (post-slot region) one at a time
- Preserve structural integrity: an assistant message with `toolCall` blocks and its consecutive `toolResult` messages form an atomic group (one result message per call for parallel calls). The whole group is dropped together or kept together, so truncation never orphans a tool call or a tool result
- Log a warning for each removed turn
- Continue until estimated tokens drop below the 90% threshold

**Cost**: Zero LLM calls. Lossy but deterministic.

**Rationale**: This is a safety net, not a primary strategy. Codex uses the same pattern (`remove_first_item()` with structural pair preservation). It should rarely fire if Layers 1 and 2 are configured correctly.

---

## Compaction Lifecycle Events

Cortex exposes these events for backend coordination:

```typescript
interface CompactionEvents {
  // Fired before compaction starts. Awaited.
  // Backend should flush observational memory and any critical state.
  onBeforeCompaction: (target: CompactionTarget) => Promise<void>;

  // Fired after compaction completes.
  // Backend should re-seed messages and update internal state.
  onPostCompaction: (result: CompactionResult) => void;

  // Fired if compaction fails (LLM error, timeout, etc.)
  onCompactionError: (error: Error) => void;

  // Fired when Layer 2 failed and Layer 3 (emergency truncation) was used as fallback.
  // Context quality is degraded but the session continues.
  onCompactionDegraded: (info: { layer2Failures: number; turnsDropped: number }) => void;

  // Fired when all compaction layers have failed.
  // Consumer should take recovery action (e.g., pause heartbeat, abort session).
  onCompactionExhausted: (info: { error: Error; layer2Failures: number }) => void;
}

interface CompactionTarget {
  turnsToCompact: number;          // how many turns will be summarized
  estimatedTokens: number;         // estimated tokens in the compaction target
}

interface CompactionResult {
  tokensBefore: number;
  tokensAfter: number;
  turnsCompacted: number;
  turnsPreserved: number;
  summaryTokens: number;
  oldestPreservedTimestamp: string | null; // ISO timestamp of oldest turn in preserved tail (null if no timestamp found)
  oldestPreservedIndex: number;            // index of oldest preserved turn for reliable fallback
  summary: string;                         // the generated summary content
}
```

---

## Integration with Consumer Compaction Systems

Consumers may have their own domain-specific compaction layers (e.g., compressing domain objects like thoughts, experiences, or messages into structured summaries stored in database-backed slots). These operate independently of conversation history compaction, but the two systems need to be coordinated.

### Coordination Pattern

The key pattern: consumers use `onBeforeCompaction` to flush their own compression pipeline before Cortex compacts conversation history.

```
GATHER:   Consumer loads domain data into context slots via ContextManager.setSlot().

RUN:      Cortex runs the agentic loop. Conversation history grows.

BEFORE COMPACTION (Layer 2 triggers):
          Cortex emits onBeforeCompaction.
          Consumer handler:
            1. Flushes domain-specific compression (synchronous, awaited)
            2. Ensures any raw items about to be lost from conversation
               history have been compressed into persistent storage first
            3. Updates context slots via ContextManager.setSlot()

POST-COMPACTION:
          Cortex emits onPostCompaction.
          Consumer handler:
            1. Queries its own data store for recent items
            2. Re-seeds the conversation with any relevant context
               that falls in the gap between the summary and the preserved tail

CONTINUE: Domain-specific processing runs as usual for any new items
          generated during this cycle.
```

### Why Domain Compaction Stays in the Consumer

Domain-specific data (thoughts, experiences, messages, etc.) belongs to the consumer. These have their own database schemas, watermark tracking, token budgets, and compression logic. Cortex has no knowledge of these concepts and should not need to.

The `onBeforeCompaction` / `onPostCompaction` event contract is the clean boundary:
- Cortex says "I'm about to compact" and "I just compacted"
- The consumer does whatever domain-specific work is needed
- Cortex doesn't care what that work is

This means any consumer of Cortex can implement their own pre/post compaction hooks without domain-specific logic leaking into the framework.

---

## Token Tracking

Cortex tracks tokens through two complementary mechanisms:

### Post-Hoc Tracking
After every LLM call, read `AssistantMessage.usage` to get the actual token count. This is authoritative but only available after the call completes. Cortex auto-wires this internally: the EventBridge intercepts `turn_end` events from pi-agent-core, extracts usage data, and updates the compaction manager's token count. No consumer wiring is needed.

```typescript
currentContextTokenCount = response.usage.input_tokens;
```

Note: this is an assignment, not an addition. `usage.input_tokens` reflects the total input size for that call, not a delta.

### Heuristic Estimation
Between LLM calls, estimate context size for proactive compaction decisions:

```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}
```

Used for:
- Deciding whether to trigger Layer 1/2 before the next call
- Estimating the compaction target size
- Estimating post-compaction size to verify compaction was effective

### Token Budget Awareness

Cortex needs to know the model's context window size. This comes from pi-ai's model metadata:

```typescript
const contextWindow = model.contextWindow;  // e.g., 200_000
const compactionThreshold = contextWindow * config.compaction.threshold;
```

---

## Compaction Is Autonomous

Cortex is a standalone package with no knowledge of the backend's pipeline, ticks, or phases. It is always an agentic loop. Compaction runs entirely within Cortex's `transformContext` hook, which fires before every LLM call in the loop.

### All Layers Fire in `transformContext`

Every LLM call in the agentic loop triggers `transformContext`. Inside that hook, compaction checks thresholds and acts:

```
Every LLM call in the agentic loop:
  transformContext fires:
    1. Tier 1 insertion-time cap (mutates agent.state.messages)
    2. Ephemeral context injection
    3. Sanitize messages
    4. Layer 1: Microcompaction (in-memory, threshold-triggered at 40/50/60%)
    5. Layer 2: Summarization (if tokens > 70%, modifies agent.state.messages)
    6. Layer 3: Emergency truncation (if tokens > 90%)
    7. Return final context to model
```

- **Layer 2 runs mid-loop.** The hook is async, so the summarization LLM call happens inline. When Layer 2 fires, it modifies `agent.state.messages` (the persistent transcript), emits `onBeforeCompaction` (awaited) and `onPostCompaction` events, then rebuilds the context from the updated messages. The agentic loop continues seamlessly from the compacted state.
- **Layer 3 runs unconditionally at 90%.** No phase check. If context exceeds 90% of the context window, emergency truncation fires regardless of what else has happened.
- **There is no `setPipelinePhase` or external trigger.** Cortex has no concept of pipeline phases. Compaction is self-contained.

### Events Are Notifications, Not Triggers

When Layer 2 fires (whether mid-loop or at any other point), Cortex emits:
- `onBeforeCompaction` (awaited): The consumer can flush state (e.g., flush domain-specific compression pipelines)
- `onPostCompaction`: The consumer can re-seed messages or update internal state

These events flow UP from Cortex to the consumer. The consumer never triggers compaction; it only reacts to it.

### Relationship to Consumer Pipelines

A consumer may run a multi-phase pipeline where only some phases go through Cortex (via `agent.prompt()`). Other phases (e.g., direct LLM calls, post-processing, persistence) may bypass the agent entirely and do not add to conversation history. Cortex is unaware of any consumer pipeline structure.

Compaction fires during the agentic loop because that is when `transformContext` runs. If the loop generates enough context to cross thresholds, compaction fires automatically. After the loop completes and the consumer runs its remaining phases, there is nothing for Cortex to do: it already compacted during the loop if needed.

---

## Progressive Loss Mitigation

Every compaction system suffers from "summarizing summaries" degradation. After 3+ compactions, early context is effectively gone. Mitigation strategies:

### 1. Slots as Durable Memory
The slot system is the primary defense against progressive loss. Information that matters long-term should be in slots (core-self, working-memory, observation summaries), not in conversation history. Slots are never compacted.

### 2. Consumer Compression as Pre-Compaction Safety Net
The `onBeforeCompaction` hook ensures that domain-specific context is compressed into persistent summaries before it is lost from conversation history. These summaries live in slots and survive indefinitely.

### 3. Cumulative Summary Section
Following the Codex community proposal (Issue #14347), the summarization prompt includes a "Key Decisions" section that is explicitly instructed to be preserved across compactions. Each compaction carries forward the previous summary's key decisions, appending new ones. This creates a rolling log of important decisions that compounds rather than decays.

### 4. External State as Ground Truth
File system state, database records, and git history are the authoritative record of what happened. Compaction summaries are a convenience for the agent's reasoning, not the source of truth. The backend can always reconstruct context from databases (which is exactly what the slot system does).

### 5. Infinite Sessions
There is no compaction limit. Sessions can run indefinitely, compacting as many times as needed. Each compaction re-compresses the previous summary alongside new turns into a single fresh summary. The Key Decisions section accumulates across compactions to preserve important decisions. Natural quality degradation of older content is acceptable: the slot system (observations, working memory, core self) captures durable long-term context independently of the conversation summary.

---

## Configuration Summary

```typescript
interface CortexCompactionConfig {
  microcompaction: {
    maxResultTokens: number;             // default: 50_000 (insertion-time cap)
    softTrimThreshold: number;           // default: 0.40 (40% of context window)
    hardClearThreshold: number;          // default: 0.60 (60% of context window)
    bookendSize: number;                 // default: 2_000 (chars per end)
    preserveRecentTurns: number;         // default: 5
    extendedRetentionMultiplier: number; // default: 2 (for non-reproducible tools)
    toolCategories?: Record<string, 'rereadable' | 'non-reproducible' | 'ephemeral' | 'computational'>;
    persistResult?: PersistResultFn;     // optional: persist cleared results to disk
    maxAggregateTurnTokens?: number;     // default: 150_000 (per-message aggregate cap)
  };
  compaction: {
    threshold: number;                   // default: 0.70 (70% of context window)
    preserveRecentTurns: number;         // default: 6 (last ~1-2 ticks, includes tool calls)
    customPrompt?: string;              // optional: custom summarization prompt
    maxRetries?: number;                // default: 3 (Layer 2 retry attempts)
    retryDelayMs?: number;              // default: 2000 (delay between retries)
  };
  failsafe: {
    threshold: number;                   // default: 0.90
  };
  adaptive: {
    enabled: boolean;                    // default: false
    minThreshold: number;               // default: 0.50 (lowest Layer 2 can drop to)
    idleMinutes: number;                // default: 30 (minutes of inactivity before lowering)
  };
}
```

**Adaptive threshold** (optional): When enabled, lowers the Layer 2 compaction threshold during idle periods. After `idleMinutes` of no user interaction, the threshold gradually drops from the configured 70% toward `minThreshold` (default: 50%). This proactively compacts during autonomous interval ticks when the user isn't actively engaged, keeping context lean for when they return. Disabled by default.

Compaction is always active. There are no `enabled` toggles. The summarization model is always the same model used by the main agent session. Microcompaction operates in-memory only; the session transcript on disk is never modified.

---

## Observability

All compaction activity is logged and surfaced:

- **Agent logs**: Each compaction event is logged to `agent_logs.db` with before/after token counts, summary content, and timing
- **Frontend**: The tick timeline shows compaction events as distinct entries with expandable summary content
- **Metrics**: Token usage breakdown (slots, history, ephemeral, cleared tool results) available via the context manifest pattern already used by the context builder

---

## Implementation Sequence

This should be implemented as part of **Phase 5: Compaction** in the pi-agent-core migration plan:

1. **Token tracking**: Add `estimateTokens()` utility and post-hoc token tracking to `ContextManager`
2. **Layer 1 (Microcompaction)**: Implement tool result clearing in `transformContext`
3. **Layer 2 (Compaction)**: Implement summarization pipeline with event hooks
4. **Layer 3 (Failsafe)**: Implement emergency truncation
5. **Backend integration**: Wire `onBeforeCompaction` / `onPostCompaction` handlers in the heartbeat pipeline for observational memory coordination and message re-seeding
6. **Observability**: Add compaction events to agent logs and frontend tick timeline

---

## Resolved Decisions

### Uniform Microcompaction (All Providers)

Microcompaction runs at threshold crossings (40%, 50%, 60%) for all providers, regardless of caching discount. This keeps the system simple and uniform rather than branching behavior based on provider capabilities.

**Cost analysis** (modeled on a 200K context window, 34-tick session):

```
                    90% cache    50% cache    No cache
                    (Anthropic)  (OpenAI)     (other)
                    ─────────    ─────────    ────────
No microcompaction:  707K eff.    1,250K       2,983K
With microcompaction: 841K eff.   1,020K       2,450K

Difference:          +19%         -18%         -18%
```

With strong caching (90% discount), microcompaction is ~19% more expensive due to cache invalidation at threshold crossings. With weaker or no caching, microcompaction is ~18% cheaper. The decision to use microcompaction uniformly trades a modest cost increase on Anthropic for simplicity, consistency, and the benefit of delaying full compaction (Layer 2) by ~12 additional ticks across all providers.

### Preserved Tail + Gap Re-Seeding

Layer 2 compaction preserves the most recent `preserveRecentTurns` (default: 6) turns verbatim. This is necessary because tool call/result pairs only exist in conversation history; `messages.db` stores user-facing messages and agent replies but not tool calls. Without a preserved tail, the agent would lose all structured tool context after compaction.

The backend's `onPostCompaction` handler re-seeds the **gap** between the observation watermark and the preserved tail. The `CompactionResult` includes `oldestPreservedTimestamp`, which the backend uses to query only messages from `messages.db` where `createdAt > observation.lastRawTimestamp AND createdAt < oldestPreservedTimestamp`. This prevents duplication: re-seeded messages cover the gap, the preserved tail covers recent context, and there is no overlap.

**Responsibility split:**
- **Cortex**: Preserves recent turns (the only source of tool call/result pairs)
- **Backend**: Fills the gap between observation watermark and preserved tail with messages from `messages.db`

### Summarization Model

Compaction should use the same model as the main session. The conversation history summary is the only record of what happened during agentic loops (tool calls, decisions, reasoning chains). Quality matters significantly here, unlike observational memory compression where the Observer/Reflector use Haiku because they are compressing simple timestamped items into date-grouped summaries. Conversation history is structurally complex (interleaved tool calls, multi-turn reasoning) and a lower-tier model would lose critical details. This aligns with the approach taken by most production coding agents, which use the same model for summarization.

### Sub-Agent Compaction

Sub-agents are full Cortex instances and inherit the parent's compaction config. Compaction is not optional for any Cortex instance; it is a core feature baked into the system. There is no `enabled: false` toggle. Sub-agents may run longer than expected (complex research tasks, multi-step workflows), and without compaction they would hit the same context overflow problems as the mind.

### Message Re-Seeding Granularity

Message re-seeding after compaction follows the same watermark pattern used by the observational memory system. The observational memory stores a `lastRawTimestamp` watermark in `memory.db` that tracks the newest message that has been compressed into an observation summary. Messages newer than this watermark are "post-watermark" items that exist as full messages in context, not yet compressed.

This is entirely a backend operation, not a Cortex concern. Cortex has no knowledge of `messages.db`, contacts, watermarks, or observational memory. It emits the `onPostCompaction` event; the backend's handler does the re-seeding.

After compaction, the backend's `onPostCompaction` handler re-seeds the gap:
1. Queries `messages.db` for the active contact's messages where `createdAt > observation.lastRawTimestamp AND createdAt < oldestPreservedTimestamp` (the gap between the observation watermark and the preserved tail)
2. These are the messages that have NOT been compressed into observation summaries and are NOT already in the preserved tail
3. Formats them as conversation turns and injects between the compaction summary and the preserved tail via Cortex's API
4. Applies the same `rawTokens` budget (default: 4,000 tokens for messages) to cap the re-seeded amount

This is the natural boundary: if a message has already been compressed into an observation summary (which lives in a slot and survives compaction), it does not need to be re-seeded. Only messages newer than the watermark need full representation in conversation history.

```
After compaction + re-seeding, conversation history looks like:

<compaction-summary generated="..." turns-summarized="18">
  ...structured summary of tool history, reasoning, user instructions...
</compaction-summary>

[Re-seeded message from messages.db]   -- in the gap: after watermark, before tail
[Re-seeded message from messages.db]   -- (only if gap exists)
...                                     -- up to rawTokens budget (4K default)
[Preserved tail turn 1]                -- recent user message (tick prompt)
[Preserved tail turn 2]                -- recent assistant response + tool calls
[Preserved tail turn 3]                -- recent tool results
...                                     -- last ~6 turns, full fidelity
[Current tick prompt]                   -- ephemeral, not stored
```

Three layers of coverage, no duplication:
- **Observation slots** provide compressed coverage of everything older than the watermark
- **Re-seeded messages** fill the gap between the watermark and the preserved tail
- **Preserved tail** provides full-fidelity recent context including tool call/result pairs
- **Summary** carries tool history, reasoning, and user instructions from the compacted region

---

## Circuit Breaker

If Layer 2 (LLM summarization) fails, Cortex retries up to `maxRetries` times (default 3) with a configurable delay (`retryDelayMs`, default 2000ms) between attempts. This all happens mid-loop inside `applyInTransformContext`.

**Failure cascade:**

1. Layer 2 fails once: retry after delay.
2. Layer 2 fails `maxRetries` times: fall through to Layer 3 (emergency truncation).
3. Layer 3 succeeds: emit `onCompactionDegraded` with `{ layer2Failures, turnsDropped }`. The session continues but context quality is degraded.
4. Layer 3 also fails (or tokens remain over budget): emit `onCompactionExhausted` with `{ error, layer2Failures }`. The consumer should take recovery action (e.g., pause heartbeat, abort session).

A successful Layer 2 compaction resets the consecutive failure counter.

**Configuration** (in `CompactionConfig`):
- `maxRetries`: number (default 3)
- `retryDelayMs`: number (default 2000)

**Events** (registered via `AgentLoop.onCompactionDegraded()` / `onCompactionExhausted()`):
- `onCompactionDegraded`: Layer 2 failed, Layer 3 was used as fallback
- `onCompactionExhausted`: all compaction layers failed

---

## Disk Persistence for Tool Results

The same `PersistResultFn` callback drives disk persistence in three places: the proactive [tool result persistence interceptor](tool-result-persistence.md) (per-tool, at execution time), microcompaction trim/clear of historic results, and aggregate per-turn budget enforcement. Configure once; all three layers use it.

**Motivation:** Non-reproducible results (WebFetch, Bash, SubAgent) cannot be re-fetched. Truncating loses information; persistence to disk lets the agent Read the content back if it needs to reference it later in the same long-lived session. The persisted files also survive Layer 2 compaction, which replaces the source transcript entirely.

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

## Aggregate Per-Turn Token Budget

In addition to the per-result insertion cap (`maxResultTokens`, default 50K), an aggregate cap limits the total tokens across all tool results in a single message.

**Motivation:** A single agentic loop turn with many parallel tool calls (e.g., 10 file reads at 50K each = 500K) can overwhelm context before microcompaction evaluates.

**Configuration** (in `MicrocompactionConfig`):
- `maxAggregateTurnTokens`: number (default 150,000)

**Behavior:**
- After individual per-result caps are applied, the aggregate token count for all tool results in the message is computed.
- If the aggregate exceeds `maxAggregateTurnTokens`, the largest results are bookended (head + tail) until the total is under budget.
- If `persistResult` is configured, full content is persisted to disk before bookending, and the bookended text includes a reference to the persisted file.
