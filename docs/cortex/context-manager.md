# Context Manager

> **STATUS: IMPLEMENTED**

The `ContextManager` is the core abstraction in `@animus-labs/cortex` for managing the content an agent sees. It owns two distinct responsibilities: **slots** (persistent, named content blocks in the message array) and **ephemeral context** (per-call content injected via `transformContext`, never stored). These are separate concepts with different lifecycles and APIs.

## Message Array Layout

In a managed `AgentLoop`, the effective message array has five regions. The ContextManager owns the layout of the fixed prefix (the system head and the slots), slot content, and consumer ephemeral content. AgentLoop composes that with background task state, loaded skills, compaction, and cache breakpoint logic.

```
┌─────────────────────────────────────────────────┐
│  SYSTEM HEAD (position 0)                       │  pi's leading system message: the
│  Prompt sections and initial tools              │  prompt and tools (system-prompt.md)
├─────────────────────────────────────────────────┤
│  SLOT REGION (positions 1..N)                   │  Owned by ContextManager
│  Persistent, named, stability-ordered           │  Updated immediately via setSlot()
├─────────────────────────────────────────────────┤
│  CONVERSATION HISTORY (old, from historyStart)  │  Owned by pi-agent-core
│  Grows organically as agent runs                │  ContextManager does NOT touch this
│  User messages, assistant responses,            │
│  tool_use/tool_result pairs, and later          │
│  system messages (tool and prompt updates)      │
├─────────────────────────────────────────────────┤
│  EPHEMERAL CONTEXT (injected in transformContext)│  Owned by ContextManager + Cortex
│  Consumer ephemeral, loaded skill instructions  │  Rebuilt every LLM call, stable
│                                                 │  across ticks within a turn
├ ─ ─ ─ ─ ─ ─ PREFIX CACHE BOUNDARY ─ ─ ─ ─ ─ ─ ┤
│  BACKGROUND TASK STATE (injected)               │  Churns every tick (durations,
│                                                 │  live output); never cached
├─────────────────────────────────────────────────┤
│  CURRENT TICK CONTENT + USER PROMPT             │  New tool results + prompt
│  Content from the current agentic loop turn     │  Appended by pi-agent-core
└─────────────────────────────────────────────────┘
```

Consecutive user-role messages are valid: the Anthropic API auto-merges them into a single turn. No custom `convertToLlm` is needed.

`ContextManager.historyStart` (`N + 1`) is where history begins; every history slice, compaction rewrite, and observational watermark counts from it. The ContextManager puts an empty head at index 0 at construction when pi has not created one. History may carry `role: 'system'` messages inline: pi declares tool changes there, and Cortex patches prompt sections there once the model has answered (see system-prompt.md). They declare, they are not turns: the observer and summarizer skip them, cache breakpoint indexing skips them, and a history rewrite that drops one folds it into the head (`spliceHistory` in `system-transcript.ts`) so the transcript still declares what it carried.

### Prefix Caching

The layout is ordered so stable content is at the top and volatile content is at the bottom. All three major providers cache the longest unchanged prefix from the start of the request:

| Provider | Mode | Cache Read Discount | Min Tokens |
|----------|------|-------------------|------------|
| Anthropic | Explicit + automatic | 90% | 1,024-4,096 |
| OpenAI | Fully automatic | 50% | 1,024 |
| Google Gemini | Explicit + implicit | 75-90% | 1,024-4,096 |

When a slot in the middle changes, the prefix before it survives in cache; everything from the change point onward is billed at full input price. Conversation history that has not changed also benefits from caching since it sits between the stable slots and the volatile tail.

Consumer ephemeral content and loaded skill instructions sit just above the cache boundary: they are rebuilt every LLM call but hold constant across the ticks of a single turn, so within a turn they cache alongside old history. Background task state (durations, live output) churns every tick, so it is injected after the boundary and never enters the cached prefix, together with current-loop content and the prompt.

### Anthropic Cache Breakpoints

Anthropic prompt caching is explicit: at least one content block must carry `cache_control` before Anthropic will create or read a cache entry. A cache entry covers the full request prefix in Anthropic request order: `tools`, then `system`, then `messages`, up to and including the marked block.

Anthropic also performs automatic prefix checking around explicit breakpoints. When a breakpoint is present, Anthropic checks previous content-block boundaries near that breakpoint, currently documented as roughly 20 blocks back, and uses the longest matching cached prefix it finds. This is why Cortex's slot ordering matters: one explicit breakpoint at the end of the slot region can still reuse an earlier stable prefix when a later slot changes, as long as the earlier boundary is within Anthropic's lookback window.

For a managed `AgentLoop` using Anthropic, pi-ai first places cache controls on the system prompt, the last tool definition, and the last user message. Cortex's `onPayload` hook then adjusts that payload into the intended four-breakpoint layout:

1. System prompt (the head, which pi-ai lifts into the request's `system` field).
2. End of the slot region.
3. End of the stable prefix: old conversation history plus the injected ephemeral and skill messages, before background task state and current-tick content.
4. Last user message, usually the current prompt.

Cortex strips the tool-definition breakpoint because the system breakpoint already covers tools in Anthropic's prefix order, and Anthropic allows only four breakpoints. Keeping the slot and history breakpoints is more valuable for long-running agents.

Slot order should be chosen by expected stability. Put content that almost never changes first, semi-stable context after that, and high-churn context near the end of the slot list. If a late slot changes, Anthropic can still walk back from the end-of-slots breakpoint to an earlier unchanged slot boundary. If the slot region grows beyond roughly 20 content blocks, add another explicit breakpoint or reduce slot fragmentation, because Anthropic may not check far enough back from the end-of-slots breakpoint.

Direct completion helpers (`directComplete()`, `structuredComplete()`, and `utilityComplete()`) do not run the managed agentic-loop `transformContext` pipeline, and raw calls (`{ systemPrompt, messages }`) rely on pi-ai's provider-level cache controls. Passing a structured context (`{ systemPrompt, slots, history, ephemeral, prompt }`) instead opts into the same breakpoint strategy: BP2 after the last slot, BP3 at the end of history, with per-call ephemeral content kept outside the cached prefix. Direct completions inherit the agent's configured `cacheRetention` and `sessionId` by default; both can be overridden per call. See the consumer guide's "Direct Model Calls" section for the caching contract.

Reference: [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching).

## Slots

Slots are persistent, named content blocks stored as user-role messages right after the system head in `agent.state.messages`. They are defined at `ContextManager` creation time as an ordered list. The order defines their position in the message array: first slot = position 1 (most stable, best cache life), last slot = position N (least stable among slots). Slot count and names are static for the lifetime of the agent.

### API

```typescript
interface ContextManagerConfig {
  slots: string[];    // Ordered list of slot names. Order = position in message array.
}

class ContextManager {
  constructor(agent: Agent, config: ContextManagerConfig);

  // Update a slot's content. Immediately updates the corresponding
  // message in agent.state.messages at the slot's position.
  // Content is the raw string (including any formatting the consumer chooses).
  setSlot(name: string, content: string): void;

  // Read current slot content. If the underlying message uses a content
  // array (rather than a plain string), text parts are concatenated.
  // Returns null if the slot has not been set.
  getSlot(name: string): string | null;

  // Set ephemeral content for the next LLM call(s).
  // The standalone ContextManager hook appends it at the end of the
  // message array. AgentLoop uses its composed hook to insert it at the
  // pre-prompt boundary for cache optimization.
  // Never written to agent.state.messages.
  // Pass null to clear.
  setEphemeral(content: string | null): void;

  // Read the current ephemeral content.
  getEphemeral(): string | null;

  // Returns a standalone transformContext hook function that appends the
  // ephemeral content. Consumers using AgentLoop normally do not register
  // this manually; AgentLoop installs its composed hook internally.
  getTransformContextHook(): (context: AgentContext) => AgentContext;
}
```

### Constructor Initialization

When the ContextManager is constructed, it puts an empty system head at position 0 if pi has not created one, then reserves space for all declared slots by pushing empty user-role messages (`{ role: 'user', content: '' }`) into `agent.state.messages` at positions 1 through N (where N is the number of slots). This ensures the message array always has the correct length from the start, so `setSlot()` can safely overwrite any position without gaps.

### Usage: How a Consumer Configures Slots

The consumer defines slots at startup and populates them with content built from its own data sources:

**Startup (once per process)**:

```typescript
const agent = await AgentLoop.create({
  model,
  workingDirectory,
  initialBasePrompt,
  // Order = position. Most stable first for best prefix caching.
  slots: ['credentials', 'user-profile', 'project-context', 'history'],
});

const cm = agent.getContextManager();

// Initial population from application state
cm.setSlot('credentials', buildCredentialContext(credentialStore));
cm.setSlot('user-profile', buildUserProfileContext(userStore));
cm.setSlot('project-context', buildProjectContext(projectStore));
cm.setSlot('history', buildHistoryContext(historyStore));
```

**Each tick (GATHER phase)**:

```typescript
// Only update slots whose source data actually changed.
// The mind tracks this via event bus signals (plugin:changed, persona:updated, etc.)
if (credentialsChanged) {
  cm.setSlot('credentials', buildCredentialContext(credentialStore));
}
if (contactsChanged) {
  cm.setSlot('contacts', buildContactsContext(contactStore));
}
if (coreSelfChanged) {
  cm.setSlot('core-self', buildCoreSelfContext(memoryStore));
}
if (workingMemoryChanged) {
  cm.setSlot('working-memory', buildWorkingMemoryContext(memoryStore, contactId));
}

// Each observation stream is tracked independently.
// Thoughts and experiences compress at different rates. Message observations
// are per-contact scoped and update when the observer processes that contact's
// messages. Splitting allows finer-grained cache preservation: if only thought
// observations update, the experience and message observation slots remain cached.
if (thoughtObservationsChanged) {
  cm.setSlot('thought-observations', buildThoughtObservationContext(memoryStore));
}
if (experienceObservationsChanged) {
  cm.setSlot('experience-observations', buildExperienceObservationContext(memoryStore));
}
if (messageObservationsChanged) {
  cm.setSlot('message-observations', buildMessageObservationContext(memoryStore, contactId));
}

if (goalsChanged) {
  cm.setSlot('goals', buildGoalContext(goalStore));
}
if (tasksChanged) {
  cm.setSlot('tasks', buildTaskContext(taskStore));
}

// Ephemeral context is always rebuilt every tick
cm.setEphemeral(buildTickContext(emotions, energy, trigger, retrievedMemories));
```

**Run the agentic loop**:

```typescript
await agent.prompt(tickPrompt);
```

The `build*Context()` functions are the mind's responsibility (they live in the backend's context builder). The ContextManager does not know or care what content goes into each slot. It just places the string at the correct position in the message array.

### Cortex-Managed Observation Slot

Cortex automatically appends a `_observations` slot as the last slot position. It stays empty until there are observations. This slot is managed internally by Cortex's `ObservationalMemoryEngine` and consumers never interact with it directly. See [observational-memory-architecture.md](./observational-memory-architecture.md) for details.

### Consumer Observation Slots (Example: Animus)

Consumers may define their own observation-related slots for domain-specific needs. For example, Animus splits its observations into three consumer-owned slots (thought-observations, experience-observations, message-observations) for finer-grained cache preservation: each stream updates on a different cadence, so splitting them means only the changed slot forces a cache miss while the others remain cached.

These consumer slots are independent of Cortex's `_observations` slot and are managed entirely by the consumer via `setSlot()`.

### How setSlot() Works

`setSlot()` replaces the entire message object at the corresponding position in `agent.state.messages` with a new `{ role: 'user', content }` object. This is a full replacement, not a merge. Because the constructor pre-initializes all slot positions with empty messages, there is always a valid entry at every slot index before the first `setSlot()` call.

### Content Formatting

The ContextManager does not impose any formatting. The consumer provides the full message content string, including any XML wrapping (e.g., `<app-context type="plugins">...</app-context>`). This keeps the ContextManager general-purpose.

## Ephemeral Context

Ephemeral context is per-call content that the LLM should see but that should NOT persist in `agent.state.messages`. The standalone `ContextManager.getTransformContextHook()` appends it at the end of the message array. The managed `AgentLoop.getTransformContextHook()` reads the same ephemeral content and inserts it at the pre-prompt boundary, along with framework-managed background task state and loaded skill instructions.

### What Goes in Ephemeral Context

There are three sources of ephemeral content, injected as separate user-role messages at the boundary position. Injection order follows stability: consumer ephemeral first, then loaded skill instructions, then background task state, then the consumer-fed headline block last, so the churning blocks stay outside the BP3 cache breakpoint.

**1. Consumer ephemeral content** (via `setEphemeral()`): Anything the consumer wants the LLM to see per-call. Examples: environment info (cwd, git branch, model), runtime state, active contact context, emotional state, retrieved memories.

**2. Background task state** (automatic, framework-level): Cortex automatically builds and injects a `<background-tasks>` block describing running sub-agents and background bash processes. This gives the parent agent visibility into long-running work without requiring a tool call. Only running tasks are included; completed tasks deliver their results through the normal completion flow.

The background task block includes:
- **Running sub-agents**: task ID, instructions, duration, tool count, current tool activity (with "started N seconds ago" for hang detection), token usage, turn count with budget ceiling, and whether the sub-agent is waiting on a permission prompt
- **Running bash processes**: task ID, command, duration, last few lines of stdout

This block is omitted entirely when no background tasks are running.

**3. Consumer-fed headline block** (via `AgentLoop.setHeadlineProvider(provider, { maxTokens? })`): An owner-built live status block, rebuilt from the provider on every LLM call and injected after the background task state. Like background state it churns per tick, so it never extends the cached prefix, never enters the transcript, and is absent on compaction turns like all view injections. The block is hard token-capped (default 2000 tokens): injected user-role content is never trimmed by microcompaction, so an unbounded block would inflate utilization without ever shrinking. Pass `null` to stop injecting; a provider that throws or returns nothing injects nothing for that call.

### Composability

Applications that use `AgentLoop.create()` do not need to wire `transformContext`; Cortex installs the composed hook internally. Consumers that instantiate `ContextManager` directly can compose its standalone hook with their own logic:

```typescript
const cm = new ContextManager(agent, { slots: [...] });

const agent = new Agent({
  transformContext: async (context) => {
    // 1. ContextManager injects ephemeral content
    context = cm.getTransformContextHook()(context);
    // 2. Consumer's own logic (compaction, etc.)
    context = await compactionHook(context);
    return context;
  },
  // ...
});
```

## What the ContextManager Does NOT Do

- **Manage conversation history**: The organic message accumulation from agent turns is entirely pi-agent-core's responsibility.
- **Format content**: No XML wrapping, no tags. The consumer formats content however they want.
- **Handle persistence**: Serializing `agent.state.messages` for crash recovery is the consumer's responsibility. Cortex provides `getConversationHistory()` and `restoreConversationHistory()` on the `AgentLoop`, not on the ContextManager. The history they carry includes the inline system messages; persist it as returned and skip `role: 'system'` when rendering it.
- **Compact conversation history**: Compaction is a separate cortex capability that composes with the ContextManager via `transformContext`.

## Context capacity and budgets

Cortex keeps backend capacity separate from each loop's compaction budget.
`CortexModel.contextWindow` is the capacity that hard overflow protection uses.
`contextWindowLimit` is an optional positive integer for proactive compaction.
Its effective value is `min(limit, capacity)`, or capacity when no limit is set.
Explicit limits below 16K are honored across providers. `MINIMUM_CONTEXT_WINDOW`
remains a legacy fallback for unknown capacity, not a floor on a known budget.
A budget does not guarantee every request fits it: system instructions and an
indivisible recent turn can exceed the budget. Hard overflow handling still
uses backend capacity.

Provider resolution owns runtime allocation. A loop changing its budget cannot
resize memory on a shared backend. Providers which support allocation controls
can apply an allocation cap while resolving a model; that resolved model is
then shared by loops with independent compaction budgets. Cloud providers do
not receive an unsupported context-allocation parameter.

For [Ollama](ollama.md), `ProviderManager.createOllamaModel()` accepts an exact
`contextWindow` and an optional `contextWindowLimit` allocation cap. Cortex Code forwards its configured limit to both provider setup and
loop configuration. The native provider sends the resolved allocation as
`options.num_ctx` on every request, independently of the output-token limit.
Cortex Code `/status` reports requested budget, effective budget, and backend
capacity for every provider, plus allocation details for Ollama.

Compaction's recent-history protection is capped at half the budget, and the
observer batch minimum cannot exceed its utility model's capacity-based cap.
These constraints keep minimum-size preferences from defeating small budgets.
