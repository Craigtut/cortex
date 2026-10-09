# Cortex Architecture

> **STATUS: IMPLEMENTED**

`@animus-labs/cortex` is a standalone package that wraps `@earendil-works/pi-agent-core` into a production-grade agent. It adds the capabilities pi-agent-core deliberately omits: MCP tool support, tool permissions, budget guards, context compaction, skill system, and event logging. Session persistence is the consumer's responsibility; cortex provides lifecycle hooks and serialization helpers.

It does NOT contain application-specific logic (thoughts, emotions, decisions, persona). Those are concerns of the consumer (e.g., a heartbeat system or application-specific pipeline). Think of it as: pi-agent-core provides the bare agentic loop; cortex provides everything needed to wire that loop into real applications.

Two agent surfaces are exported. `AgentLoop` is the loop primitive this document describes. `CortexAgent` is the composite facade over it (session log, composite persistence, settlement predicates) and the entry point most consumers want: it defaults to a duplex talker/reasoner pair, with `mode: 'passthrough'` as the single-loop opt-out. See [cortex-agent.md](cortex-agent.md) and [consumer-guide.md](consumer-guide.md).

## Package Structure

```
packages/cortex/
  src/
    index.ts                    # Public API
    agent-loop.ts               # AgentLoop: public surface, forwards to the parts below
    agent-loop/                 # AgentLoop internals (see "AgentLoop module layout")
      assembly.ts               # Composition root: builds and wires one loop's parts
      api/                      # Slice interfaces AgentLoop implements; carry the public JSDoc
      run-control.ts            # Loop gate, abort state, abortable waits
      turn-runner.ts            # One logical turn plus background retries
      delivery-queues.ts        # deliver(): silent and parked wake queues, steering
      background-delivery.ts    # Delivering background completions back to the loop
      delivery-failure.ts       # Redelivery budgets and the dead-letter store
      transcript-repair.ts      # Unwinding a failed run from the transcript
      lifecycle.ts              # abort() and destroy() protocols
      context-pipeline.ts       # transformContext hook and idle digestion
      ...                       # tools, permissions, sub-agents, models, system prompt, etc.
    cortex-agent.ts             # Composite facade over AgentLoop (see cortex-agent.md)
    facade/                     # Facade parts: config routing, LoopSurface forwards, session log recorder,
                                #   persistence, settlement, and the SessionMode contract with passthrough
    duplex/                     # Duplex session: loop assembly, router and its parts, permission broker,
                                #   ask voicing and consent, headlines, run tracking and outcomes, watchdog
    session-log.ts              # Append-only session log owned by the facade
    context-manager.ts          # Slot-based context management
    provider-manager.ts         # Provider discovery, OAuth login/refresh, API key validation
    provider-manager/           # ProviderManager parts: pi-ai loading, OAuth flows and callback page,
                                #   model catalog, API key validation, model creation
    provider-registry.ts        # Static provider metadata and utility model defaults
    model-wrapper.ts            # Model resolution and CortexModel opaque type
    error-classifier.ts         # Regex-based error classification
    budget-guard.ts             # Turn count, cost, and wall-clock limits
    event-bridge.ts             # Pi events -> normalized events for logging
    schema-converter.ts         # Zod -> JSON Schema -> TypeBox conversion
    token-estimator.ts          # Heuristic token estimation for compaction triggers
    working-tags.ts             # Working tag parsing and response delivery
    types.ts                    # Package-specific types
    tools/
      index.ts                  # Tool barrel exports and tool name constants
      runtime.ts                # Per-agent mutable tool runtime state
      bash/                     # Bash execution, streaming, and safety checks
      shared/                   # CWD, read tracking, edit history, gitignore helpers
      read.ts                   # Read file contents
      write.ts                  # Write/create files
      edit.ts                   # String replacement edits
      undo-edit.ts              # Revert current-loop Write/Edit mutations
      glob.ts                   # File pattern matching
      grep.ts                   # Regex content search
      web-fetch/                # URL content fetching and cache
      task-output.ts            # Background task interaction
      sub-agent.ts              # Cortex-based sub-agent tool
      tool-search/              # Deferred tool schema loading
  package.json
```

### AgentLoop module layout

`AgentLoop` is a thin class. `assembleLoop()` in `src/agent-loop/assembly.ts` builds the loop's parts once, in a fixed order whose invariants are listed at the top of that file (for example, the budget guard's `turn_end` listener registers before the turn-boundary steer listener, so a turn that breaches the budget is never handed steered content). `AgentLoop` keeps the result and implements each method as a one-line forwarder.

Each part is a small module that takes a narrow `...Ports` interface of the callbacks and state it needs, rather than the loop itself, so modules can be tested with plain fakes. Ports that reach the loop's own public or overridable methods resolve through the loop at call time, so a spy or replacement installed on the loop's method still takes effect.

The public documentation lives on the slice interfaces in `src/agent-loop/api/` (`LoopRunApi`, `LoopDeliveryApi`, and so on). `AgentLoop` implements them, so the JSDoc shows up on the class's methods in editors and in the emitted `.d.ts`.

## Why a Separate Package

- Previous agent abstractions (e.g., adapter/session interfaces) normalized SDK differences. Pi Agent Core does not fit that abstraction: its value is direct control over the loop, not conforming to a normalized interface.
- A standalone package can be reused across future Animus Labs projects.
- Subprocess-based SDK orchestration (e.g., Claude CLI, Codex CLI) remains available as a consumer-level concern, not built into Cortex.

## Context Management

### Temporal Model

Cortex uses four distinct time scales:

- **Session**: the long-lived logical conversation/runtime continuity that can be persisted and resumed across many prompts.
- **Loop**: one `prompt(input, options?)` execution, including all internal turns, tool calls, and follow-up work. Accepts optional `{ cacheRetention }` to set per-call prompt cache behavior.
- **Turn**: one LLM call/response inside a loop.
- **Context**: the working prompt footprint sent to the model on a given turn.

These terms are intentionally not interchangeable. Session persistence is a consumer concern. Loop orchestration, turn handling, and current-context pressure are Cortex concerns.

### Always-Warm Agent

There is no cold/warm/active state machine. A single `Agent` instance persists for the lifetime of the process. The system prompt is set once and rarely changes. Context is managed through two complementary mechanisms:

1. **`ContextManager.setSlot()`**: Updates persistent context slots in `agent.state.messages`. Used for content that changes infrequently. Consumers define how many slots exist and what they contain.
2. **`transformContext` hook**: Injects ephemeral per-call context that should NOT persist in `agent.state.messages`. In a managed `AgentLoop`, Cortex inserts consumer ephemeral content, background task state, loaded skill instructions, and an optional consumer-fed headline block at the pre-prompt boundary. This keeps old history cacheable while keeping the current prompt as the final message.

By default, per-loop tool runtime state (working directory, read-before-edit registry, undo history) resets at every prompt. A long-lived loop that is woken repeatedly by deliveries can opt into `persistentRuntime: true` to keep that workspace state across prompts; transient per-loop state (the file mutation lock and the WebFetch rate-limit counter) still resets every prompt.

### Delivery and Steering

`prompt()` throws while a turn is running or queued, and `steer()` silently no-ops while the loop is idle. `deliver(content, { wake? })` closes that gap: it is a small state machine over the loop's run state that accepts a message in every state.

- **Wake wanted (default), loop busy** (running, queued, in retry backoff, or in the end-of-cycle drain window): the content is **parked** on a loop-owned wake queue (`outcome: 'parked'`, no promise) and a sweep task is enqueued behind every gate task present at park time. The content opens the NEXT run, never the one in flight: a prompt that dequeues ahead of the sweep splices the parked list to the front of its message batch, and the sweep delivers whatever is still parked when it fires with a run of its own (so a parked delivery always ends in a run, even when every task ahead of it is a non-run task such as an idle digestion pass or an empty drain). Cortex owns wake parking end to end; the content never enters pi's steering queue, which belongs to the public `steer()` API alone and cannot be inspected or selectively drained. The cost is a bounded one-run delay for content arriving during a live run; the gain is exact delivery: nothing is duplicated and nothing is destroyed, on any interleaving. A carrying run that fails is unwound: whether the parked content rode a sweep run or the leading batch of a consumer prompt, a terminal failure that never progressed past the content splices it back out of the transcript and re-parks it for a sweep run of its own, so a delivery reported as `'parked'` always ends in a run that answers it (never silently demoted to inert context by a failed prompt). Re-parked content is bounded twice like the background drain's deliveries: an attempt cap, and an elapsed delivery budget that also caps each attempt's in-run retry ladder, so a sustained outage cannot hold the loop gate for retry ladders back-to-back. Content a failed run DID progress past stays as durable history the next successful run sees; re-parking it would duplicate it. Parked content is dropped by `abort()` (cancelled like the aborted turn) and by `destroy()`; inspect it via `pendingWakeDeliveryCount`, and wait for it to clear with `waitForWakeDeliveriesDrained()`. The abort drop is epoch-gated rather than tied to the live abort controller, so it also covers a delivery that parks while the abort itself is completing: even when pending background deliveries make `abort()` skip its gate wait, or a mid-abort drain replaces the aborted controller, content parked before the abort finished is dropped at its next take instead of riding a post-abort run.
- **Wake wanted, loop busy, `atTurnBoundary: true`**: for content that redirects the work in flight (a redirect, a stop, the user speaking mid-turn), where the next run would be too late. It parks like any wake delivery, and the loop hands it to pi in the `turn_end` frame of the live run, immediately before pi's own steering poll, only when that poll is guaranteed to take exactly this content: the turn neither failed nor aborted, no abort is in progress, the budget guard has not breached, pi's queues are provably empty (`hasQueuedMessages()` returns `false`; an unknown state counts as non-empty), and the item heads the parked queue (consecutive flagged items go together; an ordinary delivery parked ahead is never overtaken). The run that takes it adds the delivery's `causeTag` to `activeRunCauseTags` from that moment. Under any other condition it stays parked and opens the next run exactly as an unflagged delivery would, so exactness is never traded for the early hand-over.
- **Wake wanted, loop idle**: a turn starts with the content as its prompt; `DeliverResult.turn` carries that turn's promise.
- **`wake: false` (silent), any state**: the content is queued on the `AgentLoop` itself and flushed as leading user messages into the next real prompt's message batch. It never touches pi's steering queue (which drains into whatever run starts next, surfacing "silent" content as an unprompted response) and never flushes into a background-completion delivery run. Inspect and clear the queue via `queuedDeliveryCount`, `getQueuedDeliveries()` and `clearQueuedDeliveries()`; content still queued at `destroy()` is dead-lettered.

Every delivery has a handle: `DeliverResult.deliveryId`, minted by the loop or supplied through `DeliverOptions.deliveryId`. The same id identifies the content wherever it resurfaces: a dead-letter entry for it carries `deliveryId` (and its `causeTag`), and `dropPendingWakeDeliveries(predicate)` shows the predicate each parked delivery's `{ id, content, causeTag }`. A producer that needs to recognize its own content later (the duplex broker finding its permission voicings among the talker's parked deliveries, or learning that one was destroyed) matches by id, never by text, so look-alike content from another producer is never mistaken for it.

Alongside `deliver()`, the loop surfaces pi's queue controls directly: `followUp(message)` (queued until a would-stop point: after the model produces what would otherwise be the run's final answer), `setSteeringQueueMode` / `setFollowUpQueueMode` (`'all' | 'one-at-a-time'`), and `clearSteeringQueue` / `clearFollowUpQueue` / `clearAllQueues` (the last also drops the silent delivery queue and parked wake deliveries, returning their content).

### Loop gate, turn unwind, abort epoch

These three mechanisms keep runs from overlapping and make `abort()` exact. They live in `src/agent-loop/run-control.ts` (`LoopGate`, `AbortState`, the abortable waits), `src/agent-loop/turn-runner.ts` (the turn unwind), `src/agent-loop/transcript-repair.ts` (transcript unwind after a failed run), and `src/agent-loop/lifecycle.ts` (the abort and destroy protocols).

**Loop gate.** Every task that owns the loop runs through one promise chain: consumer prompts, background delivery drains, wake sweeps, and [idle digestion](#context-compaction). At most one runs at a time, so a second run can never corrupt the tool runtime or the history boundary of the first. The gate's depth counts the running task plus queued ones, which is what the public state reads: `prompt()` throws while the gate is non-empty, `deliver()` parks while it is non-empty, `steer()` reaches pi when the gate is non-empty even before the turn has started, and `waitForLoopIdle()` waits until it is empty, including tasks enqueued by tasks. A consumer prompt's gate task runs the turn and then, under the same acquisition, delivers any background completions that arrived meanwhile. Lifecycle is re-checked at dequeue, so a `destroy()` that lands between enqueue and dequeue never starts a loop.

**Run lifecycle.** The turn runner owns the identity of the logical run in flight and exposes it as `currentRun`: a loop-lifetime `id`, when the run started, and which pi `attempt` of its retry ladder is live (`attemptStartedAt` is null during a backoff, when the run is in flight but no attempt is). It is non-null exactly while `isPrompting` is true, and `lastRunEndedAt` records when the last one ended. Consumers that report on a loop's runs read these rather than reconstructing runs from `loop_start` / `loop_end` events, which fire once per attempt.

**Turn unwind.** Each turn creates an unwind promise before it starts and resolves it in its `finally`, after the turn's status is classified and its flags are cleared. `abort()` captures that promise before aborting and waits for it after pi goes idle. Pi's `waitForIdle()` covers only pi's own run; renewing the abort controller before Cortex classified the failure would let the cancelled turn read as a retryable failure.

A failed run can also leave content in the transcript that no run answered. Pi pushes a run's leading messages at run start and appends a synthetic failure stub when the run fails, so after a failed delivery run Cortex trims the stubs appended during that run and then:

- removes the delivery message when nothing else followed it, and re-queues the content (also when the message never landed);
- removes the whole delivery when the transcript still ends on an assistant message (such as a tool-call turn whose results never arrived, which would be an unpaired tool call on the next request), and re-parks any user messages pi drained into the run (a `steer()` or follow-up) as wake deliveries;
- otherwise treats the run as having progressed past the content. It stays as history and is not re-queued, which would duplicate it.

A consumer prompt that fails terminally, other than by an abort, applies the same test to the wake deliveries spliced into its leading batch, matching them by role and content at the live history boundary. Only the wake messages are removed and re-parked; the prompt's own input and any flushed silent deliveries stay, as for any failed prompt. A batch that was only partly found (history rewritten under the run) is left alone rather than risk duplication.

**Abort epoch.** `AbortState` holds the current run's `AbortController` plus an epoch counter. `abort()` runs in this order:

1. Capture the current turn's unwind promise.
2. Drop every parked wake delivery (dead-lettered as cancelled).
3. `begin()`: abort the current controller and mark an abort in progress.
4. Abort pi, wait for pi to go idle, then wait for the turn unwind.
5. If no background completions are pending, wait for the gate to settle, so a follow-up `prompt()` does not fail on a stale gate. Pending completions start a fresh run, so `abort()` returns without waiting on it.
6. `renew()`: install a fresh controller, unless teardown began or a newer run already replaced the aborted one.
7. `end()`: clear the in-progress mark and advance the epoch.

The epoch exists because the controller cannot say which content an abort cancelled. Content can park during the awaits in steps 4 and 5, a background drain that starts mid-abort replaces the aborted controller, and step 5 is skipped when deliveries are pending. So each parked delivery is stamped with the epoch at park time, and every take of the parked queue drops everything while an abort is in flight (in progress, or the current controller still aborted) plus any item stamped with an older epoch. Content re-parked after a failed run is stamped with the epoch the run started under, captured before the run, so a failure handler that runs after the abort finished cannot stamp the new epoch and bring the content back. Dropped content is dead-lettered.

Two more rules close the same-frame cases. `prompt()` installs a fresh controller synchronously when the current one is already aborted, so an `abort()` in the same frame lands on the new turn, which then cancels at dequeue without reaching pi. Delivery runs (background drains and wake sweeps) replace an aborted controller instead of cancelling: background completions are not cancelled by a user abort.

**Abortable waits.** `raceAbort(promise, signal)` resolves to the value, or to the `ABORTED` marker when the signal fires first; a late rejection is swallowed. `raceTimeout(promise, ms, signal?)` resolves to `'settled'`, `'timeout'`, or `'aborted'`, and propagates a rejection that lands before the deadline. `sleepUnlessAborted(ms, signal)` resolves `true` after the delay or `false` as soon as the signal aborts. They bound permission asks (an abort answers a pending ask with a block), idle digestion's observer catch-up and threshold pass, the retry backoff wait, and `destroy()`'s force-kill deadline. `raceAbort` and `raceTimeout` abandon the wait, not the work; an abandoned idle-digestion pass is invalidated so a late settlement cannot write over live state.

### Background delivery budgets and dead letters

Two kinds of content reach the loop without a consumer caller waiting on them: background completions (finished background sub-agents and backgrounded Bash commands, `src/agent-loop/background-delivery.ts`) and parked wake deliveries (see [Delivery and Steering](#delivery-and-steering), `src/agent-loop/delivery-queues.ts`). Both are delivered by runs of their own, both re-attempt a failed run a bounded number of times, and both dead-letter what they give up on. The budgets and the store live in `src/agent-loop/delivery-failure.ts`.

**Background completions.** A completion is queued and a gated drain is scheduled. If a turn is running, the end of that turn's gate task delivers it first and the scheduled drain finds nothing; scheduling unconditionally covers a completion that lands after the running turn's last drain check. The drain batches every pending completion into one message and starts a run with it. `onBackgroundResultDelivery(taskIds)` fires with each completion's task id on its first attempt only. Each completion's message is formatted once and reused on re-attempts, because formatting marks a Bash task notified. After the run, the drain repeats for anything that arrived meanwhile, including re-queued items. Each completion carries the cause tags of the run that started the work (the run whose SubAgent call spawned the child, or whose Bash call backgrounded the command), and the drain run exposes the union of them through `activeRunCauseTags`. A consumer attributing results by cause therefore sees a background result as part of the work that asked for it; the duplex router relies on this to withhold a result whose task was cancelled after the spawning run ended. A sub-agent spawned through the consumer API outside any run carries none.

**Budgets.** Each item records its failed attempts and when its first delivery run started. The limits are the same for both paths: 3 failed runs or 4 hours in total, whichever comes first (`BACKGROUND_DELIVERY_LIMITS`, `WAKE_DELIVERY_LIMITS`). Each run's own [retry ladder](error-recovery.md#transient-error-handling) is capped too: `boundedPolicyFor()` lowers the retry policy's `maxElapsedMs` to what remains of the oldest item's budget. Without that cap, three attempts could each run a full default ladder (about 3 hours) while holding the loop gate through an outage.

**Requeue or dead letter.** After a failed run the transcript is unwound first (see [Loop gate, turn unwind, abort epoch](#loop-gate-turn-unwind-abort-epoch)). Content the run progressed past is history and is never re-queued; its failure surfaces through `onError`. Otherwise `partitionExhausted()` charges each item an attempt and splits the batch:

- Items with budget left go back to the front of their queue, ahead of anything that arrived meanwhile, and get another run (a re-queued background batch rides the drain's repeat; re-parked wake content gets a new sweep).
- Items out of attempts or out of time are dead-lettered. A `fatal` failure, such as an authentication error, exhausts the whole batch at once on every path (background drains, wake sweeps, and a failed prompt carrying spliced wake content), since an identical re-attempt cannot succeed.
- Background completions are not charged an attempt when the run was aborted: the user stopped the agent, the delivery did not fail. Parked wake content whose carrying run was aborted is cancelled with it and dead-lettered, whether a sweep run or a consumer prompt that spliced it into its batch carried it; content the aborted run had already answered stays, and content it never answered is also removed from the transcript, so the next run does not read it as delivered.

A failure that a later attempt recovers from never reaches `onError`. A background batch counts as recovered when every item has left the queue without being dead-lettered. A wake sweep stays silent while every item still has budget.

**Dead-letter store.** `DeadLetterStore` keeps the last 50 entries; evictions are logged, since an evicted entry is completed work gone for good. Each entry records `kind` (`'subagent'`, `'bash'`, `'wake_delivery'`, or `'silent_delivery'`), `taskId` (`'wake-delivery'` or `'silent-delivery'` for loop-owned content), `attempts`, `lastError`, `deadLetteredAt`, and the undelivered `message`. Read them with `getDeadLetteredBackgroundResults()` and subscribe with `onBackgroundResultDeadLettered(handler)`; the `CortexAgent` facade turns entries into session-log lifecycle entries. The store is not cleared by `destroy()`, so it still answers after teardown.

**Teardown.** Once `destroy()` starts, queued drains and sweeps no-op. After the gate settles, every background completion still pending is dead-lettered with `'agent shut down before delivery'`, and so is any completion that arrives during teardown. Parked wake deliveries and queued silent deliveries still held then are dead-lettered with the same reason (kinds `'wake_delivery'` and `'silent_delivery'`), matching abort(), which dead-letters the parked content it cancels. A consumer that wants them delivered elsewhere drains them first with `clearAllQueues()` or `clearQueuedDeliveries()`.

**Cancel purge.** `cancelSubAgent(taskId)` destroys the child and removes its queued result. The drain also skips any sub-agent whose task was cancelled, including a re-queued item whose cancel landed between attempts, and a result that settles after its cancel is dropped at enqueue. Discarded results are logged, not dead-lettered: the work was thrown away on purpose.

### The ContextManager

The `ContextManager` manages the content an agent sees through two mechanisms: persistent **slots** (named content blocks at the start of the message array) and **ephemeral context** (per-call content injected via `transformContext`, never stored).

See **`context-manager.md`** for the full design: message array layout, slot API, ephemeral context API, composability with other `transformContext` hooks, and prefix caching implications.

### Session Persistence

Pi-agent-core is in-memory only. `agent.state` is JSON-serializable. Cortex does NOT own persistence to disk. Instead, it provides lifecycle hooks and serialization helpers that the consumer uses to implement their own storage:

- **`getConversationHistory()`**: Returns the conversation history (everything between slots and ephemeral) as a JSON-serializable array, including the `role: 'system'` messages pi and Cortex write inline for tool and prompt updates (they carry no conversation; skip them when rendering). After compaction, this returns the compacted version. The consumer snapshots this to their storage.
- **`restoreConversationHistory(messages)`**: Injects saved conversation history after the slot region on startup. Restored system messages replay as declared, and the loop brings the prompt and tools up to date on its next request.
- **`onLoopComplete` event**: Fires when the full agentic loop finishes (maps to pi-agent-core's `agent_end` event, not `turn_end`). A single loop may contain many internal turns (tool calls, follow-ups, steering). The consumer listens to this to trigger checkpoints. One snapshot per loop, not per turn.

This design means cortex has zero storage dependencies. The consumer decides where to persist (SQLite, filesystem, Redis, nowhere) and when to checkpoint beyond the basic lifecycle events.

## Capabilities (Gap Fills)

These are capabilities pi-agent-core deliberately omits that cortex implements.

### MCP Tool Support

Pi-agent-core has no MCP support. Tools are direct `AgentTool` objects with `execute()` functions.
Cortex owns its own in-process tool contract and adapts it to pi-agent-core only at the final registration boundary.

Cortex acts as a **unified MCP client**, connecting to all tool sources through standard MCP protocol. It uses the MCP SDK `Client` class with the appropriate transport for each server:

- **Consumer domain tools**: The consumer provides its own MCP tool server (e.g., a subprocess exposing domain-specific tools like memory, tasks, messaging). Cortex connects via stdio transport, calls `tools/list` to discover available tools, then wraps each as an `AgentTool` object. On `execute()`, the client calls `tools/call` on the MCP server and returns the result. These tools are registered by the consumer, not built into Cortex.
- **Plugin tools**: Cortex connects to each plugin's MCP server via its configured transport (stdio for stdio-based plugins, HTTP for HTTP-based plugins). Discovery works the same way: `tools/list` on connection, wrap as `AgentTool` objects.
- **Dynamic lifecycle**: Tools are added and removed as plugins install or uninstall, without tearing down the agent session. On plugin install, Cortex opens a new MCP client connection and registers the discovered tools. On uninstall, it closes the connection and removes those tools.
- **Dynamic discovery**: On each MCP client connection, Cortex calls `tools/list` to discover the server's available tools. This means tool inventories are always derived from the server, not hardcoded.

Built-in tools are NOT delivered via MCP. They are native in-process Cortex tools that Cortex adapts to pi-agent-core when synchronizing the tool inventory. See the Built-in Tools section below.

### Built-in Tools

Built-in tools are native Cortex tools defined directly in Cortex. These run in-process with no MCP overhead and are adapted to pi-agent-core at the registration boundary.

- **Bash**: Execute shell commands and return output.
- **TaskOutput**: Poll, send input to, or kill backgrounded Bash processes.
- **Read**: Read file contents from the filesystem.
- **Write**: Write content to a file.
- **Edit**: Make targeted edits to existing files (string replacement).
- **UndoEdit**: Revert the most recent current-loop Write or Edit mutation for a file.
- **Glob**: Search for files by name patterns.
- **Grep**: Search file contents with regex patterns.
- **WebFetch**: Fetch content from URLs.
- **SubAgent**: Spawn a sub-agent for delegated work.
- **ToolSearch**: Load deferred tool schemas on demand when `deferredTools.enabled` is true.

Mutable built-in tool state is scoped per agent runtime. That includes cwd tracking, read tracking, WebFetch loop counters/cache ownership, and background task ownership. Parent and child agents get fresh built-in tool instances so they do not share mutable closures.

Built-in tools are registered automatically when `AgentLoop.create()` is called, using the `workingDirectory` from the agent config. The consumer does not need to create or pass tool instances. To exclude specific built-in tools, use the `disableTools` config option:

```typescript
const agent = await AgentLoop.create({
  model,
  workingDirectory: cwd,
  disableTools: ['WebFetch', 'Bash'], // Exclude specific tools
});
```

Permissions are enforced through the `beforeToolCall` hook used for both built-in and MCP tools. Built-in tool schemas use TypeBox directly since they are defined within Cortex. SubAgent is a special case: spawning is treated as internal orchestration, while tools used by the child agent still go through the parent's permission resolver.

#### Dynamic Consumer Tool Management

Consumer-provided tools (passed via `tools` in `AgentLoop.create()`) can be added and removed at runtime without restarting the agent:

```typescript
// Add a tool dynamically (e.g., after a permission change enables it)
cortexAgent.addConsumerTool(myTool);

// Remove a tool by name (e.g., after a permission change disables it)
cortexAgent.removeConsumerTool('my_tool');
```

Both methods call `refreshTools()` internally, which re-syncs the full tool list (built-in + consumer + MCP) to pi-agent-core. If the tool already exists (by name), `addConsumerTool` replaces it. Tools are normalized and validated via `assertValidCortexTool` on registration.

This complements the existing MCP dynamic lifecycle (connect/disconnect servers), providing the same hot-swap capability for in-process consumer tools.

#### Tool Result Persistence

Every tool's output flows through a result-size interceptor at the registration boundary in `refreshTools()`. Oversized results (>25K tokens) are bookended (head + tail preview) and, when a `persistResult` callback is configured on `AgentLoopConfig`, persisted to disk with a file reference the agent can Read for the full content. This applies uniformly to built-in tools, MCP tools, and consumer-provided tools, with a small skip set (Read, Edit, Write, Glob) for tools that produce inherently bounded output. See [tool-result-persistence.md](tool-result-persistence.md) for the full design.

### Schema Conversion (Zod -> TypeBox)

Pi-agent-core uses TypeBox for tool parameter schemas. Cortex provides a conversion utility:

```typescript
// Zod -> JSON Schema (via zod-to-json-schema) -> TypeBox Type.Unsafe()
function zodToTypebox(zodSchema: z.ZodType): TSchema {
  const jsonSchema = zodToJsonSchema(zodSchema);
  return Type.Unsafe(jsonSchema);
}
```

One-way conversion at the tool registration boundary. Consumer code continues using Zod. Built-in tools (Bash, Read, Write) use TypeBox directly since they are defined within Cortex, not converted from Zod.

### Tool Permission Gate

Pi-agent-core has no permission system. Cortex implements permissions via the `beforeToolCall` hook:

- Accepts a permission resolver function from the consumer
- Supports a structured result: `allow`, `block`, or `ask`
- Accepts booleans for backward compatibility: `true` -> `allow`, `false` -> `block`
- `ask` currently blocks the tool call with an approval-needed reason. Cortex does not run an in-band approval flow for the consumer.

The consumer provides the resolver; cortex provides the hook integration.

Every resolver invocation receives a `ToolPermissionRequestContext` carrying the run's abort `signal` (dismiss the prompt when it fires; the answer is no longer consulted), a per-ask `askId` nonce (crypto-random, never reused), the asking loop's `loopPath`, and a verbatim `renderedRequest`: the permission name plus the actual command, path, pattern, or URL. Requests over a fixed cap keep their head and tail verbatim with an explicit `…[N chars elided]…` marker between them, never a summary, so a destructive suffix cannot hide behind a long benign prefix. The elided middle is still concealed, though: an over-cap rendering is not a full transcript of what will run, and a destructive segment can sit inside the elision. Surfaces presenting the ask to a human should show this text, and a surface that needs certainty about an over-cap request must read the tool call's own args rather than rely on the rendering.

While a resolver call is pending, the ask is queryable: `getPendingAsks()` snapshots every ask currently blocked on a decision, for the loop and (mirrored) its spawned children, and `markAskVoiced(askId)` records that an ask was actually presented to the human. Entries disappear the moment an ask settles, however it settles (answered, blocked, or aborted). A consent broker should treat ask ids as security-relevant: bind an approval to the exact `askId` it was voiced for.

### Budget Guards

Pi-agent-core has no limits on turns or cost.

Cortex provides optional, configurable guards. All default to unlimited (no enforcement):

- **Max turns**: Count LLM turns via `turn_end` events. Default: `Infinity`. On breach, force-stop the loop.
- **Max cost**: Track via `AssistantMessage.usage.cost.total`. Default: `Infinity`. On breach, force-stop the loop.
- **Scope** (`budgetGuard.scope`): `'prompt'` (default) resets the counters at each prompt, so limits bound one logical turn. `'lifetime'` never resets them, so limits bound the loop's whole life; once breached, a lifetime guard aborts every further turn, including turns of later prompts. The mode for a resident loop prompted many times per session, where a per-prompt `maxCost` would never trip.
- **Child usage** (`budgetGuard.includeChildUsage`): by default a loop's guard counts only its own turns; forwarded sub-agent events are skipped (each child has its own guard). Setting it true counts forwarded child turn usage too, which is the plumbing an aggregate guard needs to bound a loop plus everything it spawns.

These are safety rails for runaway loops, not user-facing budget enforcement. Application-level budgeting (weekly/monthly spend limits, user-configurable caps) is the consumer's responsibility.

### Context Compaction

Pi-agent-core has no compaction. Only the `transformContext` hook.

Cortex implements compaction in `transformContext`:

- **Observational memory**: Two background LLM agents (Observer and Reflector) continuously compress conversation history into structured event logs stored in a dedicated context slot, swapped in for the messages they cover while the most recent messages stay verbatim. Non-blocking, cache-friendly, and suitable for long-running sessions. See [observational-memory-architecture.md](./observational-memory-architecture.md).
- **Layer 1** (microcompaction) trims large tool results in what remains, cache-aware, and **Layer 3** (the failsafe) cuts a request's view when it still would not fit. See [compaction-strategy.md](./compaction-strategy.md).

Context slots are never touched. `compactNow()` and `observeNow()` let an owner choose the moment; classic summarization was removed on 2026-10-09.

Two controls exist for latency-sensitive loops:

- **Non-blocking posture** (`compaction.nonBlocking: true`): no synchronous LLM call may run inside `transformContext`. Observational activation still consumes already-buffered chunks (instant), but the catch-up observer and inline reflection are skipped (reflection swaps in a buffered result or launches asynchronously).
- **Idle digestion** (`digestIdle()`): runs pending observation buffering plus the threshold pass (activation and reflection) OUTSIDE a prompt, with blocking work explicitly allowed even under the non-blocking posture. Serialized through the loop gate, so it can never race a running turn; an owner schedules it during idle windows so the multi-second calls happen while nobody is waiting. Both phases are bounded by `observerTimeoutMs` (default 60s): the observer catch-up waits time out (`observerRan: false`, the observer left in flight), and the blocking threshold pass (catch-up observation, reflection) is raced against the same deadline, so a hung utility request in either phase times the digestion out instead of wedging the gate, which would otherwise make `prompt()` throw indefinitely and strand parked deliveries. A timed-out threshold pass is invalidated, not merely abandoned: nothing can cancel the hung call, so if it settles later (after the gate released and a real prompt appended messages), its history rewrite and its blocking-posture cleanup are discarded rather than applied over live state. An owner can also preempt the pass with `signal` (an `AbortSignal`): aborting it abandons whichever phase is running exactly as a timeout would and releases the gate at once (`preempted: true`). The duplex facade aborts its digestion pass the moment wake content is bound for either loop (a prompt, a steer, a delivery, a dispatch), so a user never waits behind background compaction.

### Skill System

Pi-agent-core has no concept of skills. Skills are handled at the application layer in `pi-coding-agent`, not in the library.

Cortex implements a full skill system with three core capabilities:

- **Progressive disclosure**: Only skill names and descriptions are in context at startup (~100 tokens per skill). Full skill content loads on demand via a `load_skill` AgentTool.
- **Ephemeral injection**: Loaded skill content lives in the ephemeral context region (via a skillBuffer read by `transformContext`), not in conversation history. It persists for the duration of the current agentic loop, then disappears on the next tick.
- **Dynamic context injection**: Skills can contain preprocessor markers (shell commands, in-process JavaScript scripts, variable substitution) that execute at load time, replacing markers with live runtime data before the agent sees the content.

The skill registry is config-driven: the consumer provides paths to SKILL.md files from any source (plugins, user directories, built-ins). Cortex does not scan directories. Skills are added/removed dynamically as plugins install/uninstall.

See **`skill-system.md`** for the full design: SKILL.md format, SkillRegistry, load_skill tool, ephemeral injection, preprocessor system, consumer API, and future sub-agent skill execution.

### Working Tags (Response Delivery)

When an agent runs multi-turn agentic loops, it generates intermediate text (reasoning, analysis, planning) mixed with user-facing text (acknowledgments, progress updates, final answers). Working tags let the agent wrap internal content in `<working>` XML tags. Text outside these tags is direct communication for the user. Both stay in conversation history; the difference is only in delivery.

This feature is off by default and enabled via `AgentLoopConfig.workingTags.enabled`. Claude 5 models refuse its instructions under Anthropic's `reasoning_extraction` classifier (see working-tags.md), so enable it only for other models. When enabled, Cortex appends a "Response Delivery" section to its operational rules in the system prompt. When disabled, the prompt stops mentioning the tags entirely: the Response Delivery section is dropped, the tool result reminder is not appended, and the Tool Usage section swaps to a variant that tells the model to withhold its reasoning rather than tag it.

At the streaming level, Cortex passes raw text through with zero buffering. At turn completion, Cortex parses the complete text into a structured `AgentTextOutput` object with `userFacing`, `working`, and `raw` properties. Parsing only runs when the feature is enabled, so with it disabled `turn_end.textOutput` is left undefined and consumers must read the turn text themselves. The consumer decides per-channel what to deliver (e.g., SMS sends `userFacing` only; the frontend renders everything with working content dimmed).

See **`working-tags.md`** for the full design: tag rules, system prompt guidance, event model, parsing utilities, consumer integration, and multi-layer response delivery framework.

### Model Tiers

Cortex uses two model tiers: a **primary model** for all consumer-facing work (agentic loop and direct completion helpers) and a **utility model** for internal operations the user never sees, such as WebFetch summarization, Bash safety classification, and observational memory observer/reflector calls.

See **`model-tiers.md`** for the full design: tier definitions, provider default mapping, same-provider constraint, configuration API, and frontend implications.

### System Prompt Management

Cortex assembles a system prompt from two layers: a **consumer layer** (identity, domain instructions, communication style) followed by a **cortex operational layer** (response delivery, system rules, tool guidance, safety, environment info). The consumer content comes first, and Cortex appends its operational rules after it.

See **`system-prompt.md`** for the full design: the operational sections, how the consumer prompt is composed, platform-aware tool guidance, and caching implications.

Cortex provides a `setBasePrompt(newPrompt: string)` method for when the application prompt needs to change:

- **Triggers for rebuild**: Consumer-detected (e.g., persona changes, plugin install/remove, settings changes).
- **Non-destructive**: Rebuilding does NOT tear down the session or lose conversation history.
- **Cortex default is stable**: The default sections almost never change (platform/shell/tools don't change at runtime). Rebuilds are driven by consumer content changes.

### Event Bridge

Pi-agent-core emits 10 events across 4 scopes. Cortex normalizes these into a consumer-facing event stream for logging and monitoring.

**Pi-agent-core events:**

| Scope | Event | Description |
|-------|-------|-------------|
| Agent | `agent_start` | Agent begins processing a prompt |
| Agent | `agent_end` | Agent finishes all work (including follow-ups) |
| Turn | `turn_start` | New LLM turn begins |
| Turn | `turn_end` | LLM turn completes (response + tool execution) |
| Message | `message_start` | LLM response streaming begins |
| Message | `message_update` | Incremental streaming content (text deltas, tool call deltas) |
| Message | `message_end` | LLM response streaming complete |
| Tool | `tool_execution_start` | Tool begins executing |
| Tool | `tool_execution_update` | Tool progress update (mid-execution) |
| Tool | `tool_execution_end` | Tool execution complete (with result or error) |

**Mapping to consumer event types** (consumers define their own event enum):

| Pi Event | Consumer Event | Notes |
|----------|-------------|-------|
| `agent_start` | `loop_start` | Direct mapping |
| `agent_end` | `loop_end` | Direct mapping |
| `turn_start` | *(none)* | New; can be added or omitted |
| `turn_end` | `turn_end` | Direct mapping |
| `message_start` | `response_start` | Direct mapping |
| `message_update` | `response_chunk` | Direct mapping |
| `message_end` | `response_end` | Direct mapping |
| `tool_execution_start` | `tool_call_start` | Direct mapping |
| `tool_execution_update` | *(none)* | New; tool progress, can be added or omitted |
| `tool_execution_end` | `tool_call_end` | Direct mapping |

**Typed payloads.** The bridge extracts a typed `payload` once from pi's raw event (`src/event-payloads.ts`), so no subscriber casts `event.data`: `tool_call_start` / `tool_call_update` / `tool_call_end` carry the tool call, `turn_end` carries the assistant message the turn ended with (`{ message?: { role, content, stopReason, errorMessage } }`), `loop_end` carries the run's messages in the same shape, and `utility_usage` its category. Read them with `payloadOf(event, type)`, which narrows by event type and returns undefined for any other. The raw pi event stays on `data` for logging.

**Additional notes:**

- Cortex additionally emits one synthetic event of its own: `utility_usage`, fired once per direct/utility completion with the typed usage and a category tag (see Token Tracking below). It propagates through `forwardFrom` with `childTaskId` set, exactly like pi events.
- Each pipeline phase (THOUGHT, AGENTIC LOOP, REFLECT) creates its own event session/scope for traceability. This allows log consumers to correlate events to a specific phase of the tick.
- `thinking_start`/`thinking_end` are dropped. These were Claude SDK-specific events not present in pi-agent-core.
- `turn_start` is available as a new event type (mapped from pi-agent-core's `turn_start` event).
- The event bridge provides normalized events that consumers can persist using their own logging infrastructure.
- The consumer may emit its own pipeline events (e.g., `tick_input`, `tick_output`, `execute_*`) independently of the event bridge. These are application-level events that the consumer logs during its own pipeline phases, not pi-agent-core events.

### Error Recovery

Pi-ai surfaces errors as plain `Error` objects with string messages. Cortex's error classifier maps them to actionable categories (`authentication`, `billing`, `rate_limit`, `context_overflow`, `server_error`, `network`, `cancelled`, `unknown`), using pi-ai's own overflow and transient-error detection and adding what pi-ai does not decide: billing exhaustion, usage windows with a stated reset, authentication, and rate limits. Classified errors are emitted via the `onError` event for the consumer to route (logging, UI notifications, backoff, or retry).

Provider SDKs have inconsistent retry coverage, so Cortex retries transient failures (`network`, `server_error`, `rate_limit` by default) itself, per a configurable `retryPolicy`: it waits out a backoff (or a reset the provider stated, up to 6 hours), trims pi's failure stub, and resumes the turn with `agent.continue()`. Only failures it gives up on reach `onError`, and `onRetryScheduled` / `onRetrySucceeded` / `onRetryExhausted` report the retries along the way.

See **`error-recovery.md`** for the full design: classification patterns per category, error event flow, auth failure detection, transient error handling, consumer-specific rate limit handling, and pipeline integration.

### Token Tracking

Pi-agent-core has no pre-request token counting. Pi-ai reports `Usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and per-category costs) on every response. `model.contextWindow` provides the limit.

Cortex tracks tokens through two complementary mechanisms:

- **Post-hoc tracking**: Running `currentContextTokenCount` from per-turn `AssistantMessage.usage`. Updated after every LLM call.
- **Heuristic estimation**: A built-in `estimateCurrentContextTokens()` API uses `estimateTokens(text)` internally to estimate context size before the first LLM call and between calls. This is critical for compaction and consumer UIs: if the heuristic estimate of the current message array is approaching `model.contextWindow`, Cortex can trigger compaction proactively and consumers can show current context pressure without waiting for the next post-hoc usage report.

The heuristic is a duplicate of the same utility in `@animus-labs/shared` (4 lines), kept inline to avoid a dependency.

**Utility usage accounting.** Direct and utility completions (observer, reflector, WebFetch summarization, Bash safety classification, and consumer `directComplete` / `structuredComplete` / `utilityComplete` calls) are accounted per loop, not just stashed for `getLastDirectUsage()`. Each completion is recorded under a category tag: Cortex tags its internal calls (`observer`, `reflector`, `webfetch`, `bash_utility`); consumer calls default to their entry point (`direct`, `structured`, `utility`) or pass `usageCategory` explicitly. The spend rolls into `getSessionUsage()` (top-level totals plus a per-category `utility` breakdown, persisted and restored with the rest of session usage) and each completion emits a `utility_usage` event on the event bridge, carrying the typed usage and its category. Forwarded child events roll into the parent's totals exactly like child turn usage, so an aggregate consumer sees a subtree's whole spend.

## Lifecycle

Pi-agent-core's `Agent` class has no `destroy()` or `dispose()` method. It provides `abort()` (cancels the running loop via AbortController), `waitForIdle()` (resolves when the loop finishes), and `reset()` (clears message history and queues). But there is no instance-level cleanup: event listeners are never auto-removed, and the Agent holds references to callbacks and message arrays indefinitely.

Cortex wraps this with explicit lifecycle management.

### `AgentLoop.destroy()`

Ordered cleanup of all resources, implemented in `src/agent-loop/lifecycle.ts`. Called by the consumer when the agent is no longer needed (e.g., during application shutdown or pipeline teardown). `destroy(timeoutMs = 8000)` is idempotent, and concurrent calls share one teardown.

Before any await, the loop moves to `destroying`: `prompt()` and `deliver()` throw, queued gate tasks no-op, and the current abort controller is aborted, which cancels a pending retry backoff. The ordered cleanup then runs, raced against `timeoutMs`; if the deadline wins, every subprocess the loop tracked is killed.

1. Abort pi and wait for it to go idle, then wait for the loop gate to settle.
2. Dead-letter background completions, parked wake deliveries and queued silent deliveries still awaiting delivery (see [Background delivery budgets and dead letters](#background-delivery-budgets-and-dead-letters)).
3. Cancel all sub-agents with a full child `destroy()`.
4. Emit `onLoopComplete` for a final checkpoint. A throwing handler is logged and teardown continues.
5. Detach from the MCP client manager. Connections close only when this loop owns the manager; a shared manager's connections belong to its owner.
6. Release skills, the sub-agent manager, the budget guard, the event bridge, and the loop's event subscriptions.
7. Reset pi's agent state, then destroy the compaction manager and the tool runtime.
8. Clear every handler list and pending permission asks. The dead-letter store is kept so it still answers after teardown.

The state becomes `destroyed` when cleanup finishes or times out. Any later `prompt()` throws "Agent has been destroyed".

### `AgentLoop.abort()`

Cancel the current agentic loop without destroying the agent. The agent remains usable for subsequent prompts. Parked wake deliveries are cancelled with the run; background completions are not, and a pending one starts a fresh run. The ordered protocol, and why an abort epoch backs it, is in [Loop gate, turn unwind, abort epoch](#loop-gate-turn-unwind-abort-epoch).

**Tool abort is cooperative.** Pi-agent-core passes the `AbortSignal` to each `tool.execute()` call, but if a tool doesn't check the signal, it runs to completion. For Bash commands, the process tree is killed independently via the process cleanup mechanism (see `bash.md`). For MCP tool calls, the MCP client can close the pending request.

### Consumer Shutdown Integration

The consumer calls `destroy()` during its shutdown sequence (e.g., stopping a pipeline, exiting the application):

```typescript
async function shutdown(): Promise<void> {
  pipeline.stop();
  pipeline.clear();                 // prevent new work during shutdown
  await cortexAgent?.destroy();     // ordered cleanup
  cortexAgent = null;
}
```

The consumer should prevent new work from starting before calling `destroy()` to avoid a race where new prompts arrive while shutdown is in progress.

### Process Signal Handling

On `SIGTERM`/`SIGINT`, the consumer's signal handler calls `destroy()`. The key concern is **orphaned MCP subprocesses**, especially on Windows where there are no process groups by default.

Mitigations:
- **Unix**: MCP stdio subprocesses are spawned with `detached: true` in their own process group. On destroy, `kill(-pid, SIGKILL)` kills the entire group.
- **Windows**: MCP stdio subprocesses are tracked by PID. On destroy, `taskkill /F /T /PID` kills each one. As a safety net, cortex registers a `process.on('exit')` handler that runs synchronous cleanup for any processes still alive.
- **All platforms**: Cortex stores spawned subprocess PIDs in a set. The `process.on('exit')` handler iterates and kills any remaining. This is a last-resort fallback for unclean exits (SIGKILL, crash).

### Lifecycle States

```
CREATED → ACTIVE → DESTROYING → DESTROYED
             ↑
             └── abort() stays in ACTIVE (agent still usable)
```

- **CREATED**: After `await AgentLoop.create(config)`. Slots can be set, but no loops have run.
- **ACTIVE**: After the first `prompt()` call. The agent is running or idle between prompts.
- **DESTROYING**: From the start of `destroy()` until cleanup finishes or times out. Nothing new can start.
- **DESTROYED**: After `destroy()`. All resources released. Any `prompt()` call throws.

There is no IDLE vs RUNNING sub-state. `isRunning` is true while the loop is `active` and a turn is in flight; `isLoopActive` is true while any gate task (a turn, a delivery drain, a wake sweep, idle digestion) is running or queued.

## References

- [pi-agent-core source](https://github.com/badlogic/pi-mono/tree/main/packages/agent)
- [pi-ai source](https://github.com/badlogic/pi-mono/tree/main/packages/ai)
- [pi.dev](https://pi.dev)
- Pi Agent Core context architecture diagram: `App.pen` (frame: "pi-agent-core Context Architecture")
