# Using Cortex

> **STATUS: IMPLEMENTED CONSUMER GUIDE**

This guide is for applications that want to embed `@animus-labs/cortex`. Cortex gives you the agent, providers, tools, context management, compaction, skills, MCP, and lifecycle hooks. Your application still owns identity, product behavior, persistence, credentials storage, UI approvals, and any domain-specific tools.

## Install

```bash
npm install @animus-labs/cortex
```

Cortex requires Node.js 24 or newer and uses ESM.

## Minimal Agent

`CortexAgent` is the entry point. It is the composite agent: you create one, you talk to one.

```typescript
import { CortexAgent, ProviderManager } from '@animus-labs/cortex';

const providers = new ProviderManager();
const model = await providers.resolveModel('anthropic', 'claude-sonnet-4-6');

const agent = await CortexAgent.create({
  model,
  workingDirectory: process.cwd(),
  initialBasePrompt: 'You are a helpful assistant.',
  getApiKey: async (provider) => {
    const key = await loadApiKey(provider);
    if (!key) throw new Error(`No API key configured for ${provider}`);
    return key;
  },
});

agent.onTurnComplete((output, origin) => {
  if (output.userFacing) {
    console.log(`[${origin.loopPath}] ${output.userFacing}`);
  }
});

await agent.prompt('List the top-level files in this workspace.');
await agent.destroy();
```

`prompt()` sends user input and never throws on a busy agent, but what it resolves with depends on the mode. In passthrough, concurrent calls serialize and each resolves against the turn that carries its input. In duplex there is no such queue, deliberately: a call arriving while the talker is busy parks and rides the talker's next run, resolving `undefined` when the conversation next settles rather than with that turn's result. Barge-in is the conversation's core event, so new input has to interrupt rather than wait its turn. When the return value is not `undefined` it is the underlying pi-agent-core result and should be treated as opaque. Either way, do not render from it: most applications render assistant text from `onTurnComplete()` (`output.userFacing`; with working tags off it is the whole text) or from the session log.

`getAuth` is the fuller form of `getApiKey`: it returns a key, auth headers, and a base URL (pi's `ModelAuth`), which some providers need (Kimi Coding's OAuth authorizes with a header, GitHub Copilot's with a per-account base URL). It takes precedence over `getApiKey`; `ProviderManager.getAuth()` has its shape.

Cortex never reads credentials from the environment on its own. Without a key from `getApiKey`, a request to a provider that needs one fails with "Provider is not configured"; providers that need none (Ollama) still work. Set `ambientCredentials: true` to let pi-ai resolve provider environment variables such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, Anthropic workload identity federation, AWS profiles, and gcloud ADC when `getApiKey` supplies nothing.

## Duplex Is the Default

On a backend that serves concurrent requests (every hosted provider), a `CortexAgent` runs **two loops** unless you tell it otherwise:

- a **talker**: a fast, small model holding the conversation. It has no file tools, no bash, no MCP, and no sub-agent spawning of its own. It speaks, and it dispatches work through a fixed control toolset.
- a **reasoner**: your configured `model`, doing all the actual work. It is session-lifetime and keeps running across conversational exchanges, reporting back through the router.

You do not address these two separately. Your config, tools, slots, skills, and MCP servers are routed to the right loop for you, and every event and callback arrives labeled with the loop it came from.

What changes for you, in practice:

- **First feedback arrives in well under a second**, from the talker, while the reasoner is still working.
- **The user can ask "how is it going" mid-work** and get an answer from live status, without interrupting the reasoner. Small factual questions the talker cannot answer from status go to an ephemeral read-only lookup instead of waiting for the reasoner's turn boundary.
- **Results surface at sensible moments** rather than mid-sentence. That is the router's wake policy.
- **Permission asks arrive as conversation** rather than as a frozen loop, when a `resolvePermission` callback is configured.
- **There is a second, cheap model call per exchange**, and time-to-final-answer is slightly longer than a single loop's, in exchange for a much better time-to-first-feedback.

Set `talker: { model }` to pick the talker's model. The default is the fast tier auto-resolved from your primary provider (the same resolution the utility model uses). For a provider Cortex cannot enumerate (Ollama, custom OpenAI-compatible endpoints) that resolution falls back to your primary model: duplex still works, but the talker is as slow as the reasoner, so you should name a fast model yourself. `getResolutionReport()` tells you whether that happened (see [What you actually got](#what-you-actually-got)).

### Local and custom backends

The talker only helps if it can answer while the reasoner's request is in flight. Ollama serves one request per model by default, and Cortex cannot see what a custom endpoint does. So when you omit `mode`, the agent resolves it from the backends: passthrough when the talker and the reasoner would share one backend that is not `'parallel'` (with a `mode-resolved-passthrough` note in the report saying why), duplex otherwise. Hosted providers are `'parallel'`, native Ollama models are `'serial'`, and custom endpoints are `'unknown'`. A talker on a different backend from the reasoner always runs duplex, so an Ollama reasoner with `talker.model` pinned to a hosted model gets the full benefit.

If your Ollama server does run requests in parallel (`OLLAMA_NUM_PARALLEL` above 1, and your talker and reasoner models fit in memory together), declare it:

```typescript
const model = await providers.createOllamaModel({ modelId: 'qwen3:32b', parallelRequests: true });
```

Or pass `mode: 'duplex'` yourself: an explicit mode always wins, and when the talker and reasoner share a backend that is not `'parallel'` the report carries a `duplex-not-concurrent` warning. The mode is fixed when the agent is created; `setModel()` does not switch it (see [cortex-agent.md](./cortex-agent.md#mode-resolution)).

The design lives in [`duplex/`](./duplex/README.md): [architecture](./duplex/architecture.md), [the facade API contract](./duplex/facade-api.md), [communication and the permission broker](./duplex/communication.md), and [the decision record](./duplex/decisions.md).

### Opting out

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  mode: 'passthrough',
});
```

`passthrough` is a single reasoner loop and exactly the old single-loop behavior, verified by a side-by-side parity suite against a bare `AgentLoop`. Use it when you do not want a second model in the path: a batch or non-interactive job, a CLI where there is nobody waiting on first feedback, or a provider with no usable fast tier. It is also what an omitted `mode` resolves to on a backend that is not known to serve concurrent requests.

Two facade behaviors still apply in passthrough, and both are deliberate: `prompt()` never throws on a busy loop (a direct `AgentLoop.prompt()` does), and `abort()` clears queued content that a direct `AgentLoop.abort()` retains.

### What you actually got

Assembly resolves a configuration that can differ from the one you passed, and every case is quiet by construction: the agent runs, the suite is green, and the difference shows up later as unexplained latency or an unexplained bill. `getResolutionReport()` is the answer to "did I get what I configured?", in both modes:

```typescript
const agent = await CortexAgent.create({ model, workingDirectory, initialBasePrompt });

for (const note of agent.getResolutionReport()) {
  // note.severity: 'degraded' | 'info'
  // note.code:     'talker-model-fallback' | 'talker-utility-model-skipped' | ...
  // note.summary / note.detail / note.remedy: three lengths of the same statement
  // note.data:     the same facts structurally, if you want your own wording
  console.warn(`[${note.severity}] ${note.summary} ${note.remedy}`);
}
```

`degraded` means you asked for something and are not getting it, or duplex is not delivering its premise (a talker on the primary model, a `utilityModel` the talker could not take, shell egress asks that cannot be voiced because nothing took `getNetworkAccessResolver()`, duplex on a backend not known to be concurrent). `info` means a default is in force you may want to change (no `duplex.maxTotalCost`, so no session cost ceiling; an omitted `mode` resolved to passthrough).

Read it once after `create()` and render it wherever your configuration lives. Cortex also logs each note through your `logger` and writes it into the session log as a `lifecycle` entry, so it survives into your persistence artifact; both are generated from the report, so they cannot disagree with it. If you never wire a `logger`, the report is the only place these appear. One code, `network-resolver-unwired`, cannot be known at assembly and lands after the first `prompt()`. It is duplex-only, and it means your shell egress asks are settled somewhere other than the broker and so are never spoken; if you wired your sandbox's `onNetworkRequest` to your own permission UI on purpose, that is what it is telling you and you can ignore it.

### When to use AgentLoop directly

`AgentLoop` is still exported and still supported. It is the loop primitive: one agentic loop, its tools, its context, its compaction, and nothing composite. Reach for it when you want a single loop with no session log, no composite persistence artifact, and no facade lifecycle, for example when embedding one loop inside machinery you already own.

Everything else in this guide is written against `CortexAgent`. Most of it applies unchanged to `AgentLoop`, because the facade forwards the loop's surface. The exceptions are the composite-only members (the session log, `getState()` / `restore()`, `onStateChanged`, the settlement predicates) and the handful of loop members the facade subsumes or withholds. **[cortex-agent.md](./cortex-agent.md) has the delegation table**: what is forwarded, what is subsumed, and what is deliberately not exposed. The facade is not a drop-in rename of `AgentLoop`; read that table before migrating an existing integration.

## Provider Setup

Use `ProviderManager` during onboarding and settings screens:

```typescript
const providers = new ProviderManager();

const providerChoices = providers.listProviders();
const models = await providers.listModels('anthropic');

const validation = await providers.validateApiKey('anthropic', apiKey);
if (!validation.valid) {
  throw new Error(validation.message ?? 'Invalid API key');
}

const model = await providers.resolveModel('anthropic', models[0]!.id);
```

OAuth providers use callbacks supplied by your UI:

```typescript
const result = await providers.initiateOAuth('github-copilot', {
  onAuth: ({ url, instructions }) => {
    openBrowser(url);
    if (instructions) showInstructions(instructions);
  },
  onPrompt: async ({ message, placeholder }) => promptUser(message, placeholder),
  onProgress: (message) => showStatus(message),
  onSelect: async ({ message, options }) => chooseOption(message, options),
});

await credentialStore.saveEncrypted(result.credentials);
```

Store OAuth credentials as opaque encrypted strings. Later, resolve them inside your `getAuth` callback. An OAuth credential can authorize with more than a key (Kimi Coding sends a header, GitHub Copilot a per-account base URL), so return the whole `auth`:

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  getAuth: async (provider) => {
    const saved = await credentialStore.load(provider);
    if (saved.type === 'oauth') {
      const refreshed = await providers.resolveOAuthApiKey(provider, saved.credentials);
      if (refreshed.changed) await credentialStore.update(provider, refreshed.credentials);
      return refreshed.auth;
    }
    return { apiKey: saved.apiKey };
  },
});
```

`getAuth` and `getApiKey` are shared: both loops and every sub-agent resolve credentials through them. A callback like this one refreshes once per call, so a duplex talker and reasoner starting together can both refresh a rotating token. To refresh once, give `ProviderManager` a `credentials` store and pass `getAuth: (provider) => providers.getAuth(provider)` (see `provider-manager.md`).

## Core Configuration

`CortexAgent.create()` accepts everything `AgentLoop.create()` accepts, plus the facade's own keys. Facade keys first:

| Field | Purpose |
|-------|---------|
| `mode` | `'duplex'` or `'passthrough'`. Omitted: duplex when both loops' models are `'parallel'`, otherwise passthrough |
| `talker.model` | Talker model. Default: the fast tier auto-resolved from the primary provider |
| `idleSignal` | `() => boolean`: is the user or channel idle right now? Advisory input to the wake policy |
| `duplex` | Router and scheduling tuning (delivery spacing, backpressure caps, ask timeouts, lookup pool and timeout, `maxTotalCost`). Every field has a production default except `maxTotalCost`, which is unlimited until you set it |
| `sessionLog.maxEntries` | Session log retention cap (default 10000). Overflow comes off machine-generated churn first, conversational history last |
| `sessionLog.maxSubscriberBuffer` | Per-subscriber replay buffer bound (default 1000) |
| `stateChangeDebounceMs` | Debounce for the `onStateChanged` persistence trigger (default 500) |

Loop configuration, routed for you:

| Field | Purpose | Routed to |
|-------|---------|-----------|
| `model` | Required `CortexModel` from `ProviderManager.resolveModel()` or `createCustomModel()` | reasoner |
| `workingDirectory` | Required base directory for file tools | shared |
| `initialBasePrompt` | Your application prompt. Cortex appends operational rules, and each loop's role prompt, after it | both loops |
| `getApiKey` | Optional async provider credential resolver | shared |
| `tools` | Consumer tools | reasoner only |
| `slots` | Optional ordered persistent context slots | both loops, identical content |
| `workingTags.enabled` | Defaults to `false`; controls `<working>` response parsing guidance. Claude 5 models refuse it (working-tags.md) | both loops |
| `budgetGuard.maxTurns` / `maxCost` | Per-prompt safety limits. Your values reach the reasoner only; the talker runs a facade-built guard with a hard turn cap and no cost cap of yours | reasoner, plus `duplex.maxTotalCost` as the session aggregate |
| `contextWindowLimit` | Optional compaction budget below the model's real window | per loop: the same number on both, clamped separately against each loop's own model window |
| `disableTools` | Built-in tool names to exclude | reasoner and sub-agents |
| `resolvePermission` | Optional permission gate for tool calls | facade broker in duplex, direct in passthrough |
| `resolveNetworkAccess` | Optional network gate (sandbox) | facade broker, same pipeline |
| `retryPolicy` | Retry behavior | reasoner and sub-agents; the talker gets fail-fast defaults |
| `compaction` | Observational memory and compaction thresholds | both loops, independent managers, staggered thresholds |
| `persistResult` | Optional callback for storing oversized tool results | shared, with origin context |
| `deferredTools` | Optional schema deferral for large MCP tool sets | reasoner and sub-agents |
| `sandbox`, `envOverrides`, `logger` | Environment-level | shared |
| `sessionId` | The facade derives a distinct stable id per loop from it | per loop |
| `bash.autoYieldThreshold` | Milliseconds before a running Bash command auto-yields to a background task (default 10000) | reasoner and sub-agents |
| `bash.shellPath` | Custom shell binary for the Bash tool | reasoner and sub-agents |
| `webFetch.maxPerLoop` | WebFetch rate limit per agentic loop (default 300) | reasoner and sub-agents |

The full routing table is `CONFIG_ROUTING` in `src/facade/config.ts`, and it is compile-time exhaustive: a config key with no routing destination is a type error rather than a silently ignored setting.

Built-in tools are registered automatically on the reasoner and its sub-agents: `Bash`, `TaskOutput`, `Read`, `Write`, `Edit`, `UndoEdit`, `Glob`, `Grep`, `WebFetch`, and `SubAgent`. `ToolSearch` is registered automatically when `deferredTools.enabled` is true. The `load_skill` tool is registered automatically for parent agents. The talker gets none of these; it carries the control toolset only.

## Events

`getEventBridge()` returns one merged stream across every loop, sub-agent, and quick lookup. Each event carries its own `loopPath` field (`talker`, `reasoner`, `reasoner/task-7`, `lookup/lk-2`). `childTaskId` keeps its existing meaning of "this came from a sub-agent", so an existing `if (event.childTaskId) return;` filter is not broken by the split.

**It is no longer enough, though.** That filter used to admit one loop's stream and now admits two. Every pi-derived event, `response_start`, `response_chunk`, `response_end`, `turn_start`, `turn_end`, and the `tool_call_*` family, arrives once from the talker and once from the reasoner, both with no `childTaskId`, distinguished only by `loopPath`. Anything that renders assistant text has to say which loop it means:

```typescript
agent.getEventBridge().on('response_chunk', (event) => {
  if (event.childTaskId) return;            // still excludes sub-agents
  if (event.loopPath !== 'talker') return;  // now also required
  render(event);
});
```

Without the second line a duplex UI renders the reasoner's internal working prose alongside the talker's speech. For text destined for a user, prefer `talker_delta` below, which is already scoped to the talker and already sanitized.

**Voice consumers must subscribe to `talker_delta`, not to raw `response_chunk`.** Working tags are stripped at turn completion, so raw deltas still contain `<working>` content that TTS would read aloud. `talker_delta` is the sanitized stream, with holdback buffering across chunk boundaries so a tag split across two chunks is still caught.

```typescript
import type { TalkerDeltaPayload } from '@animus-labs/cortex';

agent.getEventBridge().on('talker_delta', (event) => {
  speak((event.payload as TalkerDeltaPayload).text);
});
```

Callbacks that can fire from more than one loop take an origin context as a second argument carrying the producer's `loopPath`. Handlers written against the old one-argument signature still compile and still run, but arity is not the thing to check: under duplex these now fire **twice per exchange**, once per resident loop, where a single-loop integration saw them once.

Registered on both loops: `onLoopComplete`, `onError`, `onRetryScheduled`, `onRetrySucceeded`, `onRetryExhausted`, `onObservation`, `onReflection`, `onMemoryError`, `onMemoryRecovered`, `onMemoryGap`. That is the right default for diagnostics, where you want to see a reasoner failure, and the origin context tells the loops apart. It is the wrong default for anything that counts, dedupes, or renders once per exchange, so branch on `origin.loopPath`.

`onTurnComplete` is the exception: it registers on the conversation loop only, because it is the "the assistant finished saying something" signal and the reasoner's assistant text is internal working prose. `persistResult` is shared rather than per-loop, and carries origin in its metadata.

## The Session Log

The facade keeps an append-only log of the session: utterances, replies, deliveries, errors, retries, sub-agent lifecycle, permission asks and answers, and lookup results. It is the ordering record and the audit trail, and it is part of the persistence artifact. It is not a context surface; no prompt is ever built from it.

A subscriber receives three kinds of event, and must handle all three:

```typescript
let cursor = lastSeenSeq;

const unsubscribe = agent.subscribeLog((event) => {
  switch (event.kind) {
    case 'entry':
      renderTimeline(event.entry);
      cursor = event.entry.seq + 1;
      break;

    case 'gap':
      // Entries this subscriber will never see: evicted by retention
      // before its replay position, or dropped because it fell behind.
      noteMissing(event.fromSeq, event.toSeq, event.dropped);
      cursor = event.toSeq + 1;
      break;

    case 'reset':
      // restore() replaced the log. Everything rendered so far belongs to
      // a session that no longer exists: discard it and render the
      // restored log, which arrives with the event. `gaps` is usually
      // empty; it is non-empty when the restored log itself has holes.
      replaceTimeline(event.entries, event.gaps);
      cursor = event.nextSeq;
      break;
  }
}, lastSeenSeq);

const events = agent.getLogEvents(lastSeenSeq); // the same sequence, as a snapshot
```

Entries carry a monotonic `seq` (the ordering authority; timestamps collide under burst), the producing `loopPath`, and a `causedBy` stamp linking an entry to the input that caused it. Ordering is append-then-emit: an entry reaches subscribers before the events of the run it triggers. A subscriber that falls behind is buffered to `sessionLog.maxSubscriberBuffer` and then dropped oldest-first with a gap marker, rather than applying backpressure to the loops.

**The log is not contiguous, so use `getLogEvents()` for snapshots.** Retention evicts machine-generated churn (sub-agent lifecycle, deliveries, directives, lookup results, retry notices) before it touches conversational history (utterances, replies, permission asks and answers, errors), which means entries go missing from the middle and the end of the range, not just the beginning. `getLogEvents(fromSeq?)` returns exactly what `subscribeLog` would replay, gap markers included, and is built by the same code so the two cannot disagree. `getLog(fromSeq?)` still returns bare entries and is still the right call when you want the entries and nothing else, but it reports no holes: render a timeline from it and the holes are silent.

**A `reset` is not a gap.** A gap says some entries are missing from a timeline that is otherwise still yours. A reset says the timeline itself was replaced, which is what `restore()` does, so the correct response is to throw away what you have rendered rather than to append to it. The event carries the restored log in `entries` (already a detached copy, so render it directly), any holes in it as `gaps`, and it is delivered ahead of any later append, even to a subscriber that was mid-callback when the restore landed.

**Reconnecting.** Track a cursor as above and pass it back to `subscribeLog` to resume: you get everything from there on, with a leading gap if any of it has since been evicted. Take the cursor from `reset.nextSeq` after a reset rather than from the last restored entry's seq. Sequence numbers never rewind across a restore, so after restoring an older artifact (or an artifact with no log at all, which is what a v1 session upgrades to) the next append can sit well above the highest restored entry. `nextSeq` is the seq that append will carry.

## Persistence

Cortex is in-memory only. `getState()` returns a versioned composite artifact you store wherever you like:

```typescript
agent.onStateChanged(async (state) => {
  await saveSession(state); // { version: 2, log, talkerHistory, reasonerHistory, ... }
});
```

`onStateChanged` is the persistence trigger: debounced (`stateChangeDebounceMs`, default 500 ms) and fired with a snapshot taken at a consistent point, never mid-run, so the log and both histories always agree. Persist on this rather than on `onLoopComplete`, which is ambiguous once there are two loops.

Restore before the agent does anything:

```typescript
const agent = await CortexAgent.create(config);

await agent.restore(saved); // v2 artifact, v1 artifact, or a bare message array

const context = agent.getContextManager();
context.setSlot('app-config', buildCurrentAppConfig());
```

`restore()` is all-or-nothing and **rejects** if any loop is running or any sub-agent is active. It is async, so await it (or attach a `.catch`); its guards never throw synchronously, and an unawaited call that hits one becomes an unhandled rejection. It replaces the three loop-level methods (`restoreConversationHistory`, `restoreObservationalMemoryState`, `restoreSessionUsage`), which are not exposed on the facade: those are independently callable at any time, so a consumer migrating from them rewrites the call site rather than renaming it.

A v1 artifact (`{ version: 1, history, memory?, usage? }`) or a bare message array restores into the reasoner with an empty log, so existing single-loop sessions upgrade transparently. Both optional v1 fields accept an explicit `null`, so a consumer whose saved memory and usage are each `T | null` can assign both directly instead of spreading one conditionally. Usage restore is a baseline, not a replay: the facade reports `restoredBaseline + live deltas`, so repeated restores are idempotent.

A restore reaches every live log subscriber as a `reset` event, so a UI attached before the call ends up on the restored session instead of quietly rendering the replaced one. See [the session log](#the-session-log) for how to handle it, and note that a v1 restore produces a reset with **no** entries, since a v1 artifact has no log.

`getConversationHistory()` and `getObservationalMemoryState()` are both still forwarded, but they no longer read the same loop, and the difference is deliberate:

- **`getConversationHistory()`** returns the **conversation** loop's transcript: the talker in duplex, the reasoner in passthrough. The name is the contract. In duplex the reasoner's transcript is the *work* transcript, in which the user's own words survive only as quoted fragments inside dispatch messages, so reading "the conversation" off it hands you dispatch scaffolding instead of the dialogue.
- **`getObservationalMemoryState()`** returns the **reasoner's** in both modes, because observational memory is what the agent learned while working, and the reasoner is the loop that works.

Both are fine for inspection and debugging. Persist `getState()`, not those: it is the only surface that carries both loops and the log.

Slots should usually be rebuilt from current application state instead of restored from prior serialized messages.

### Migrating off the v1 path

`getConversationHistory()` + `getObservationalMemoryState()` + `getSessionUsage()` written out as a v1 artifact still works, and it is the right choice for the first pass of a migration: keeping it means the on-disk format does not change, so the migration stays behavior-preserving and reviewable.

It is also a trap with a deadline, and the trap is sharper than "you lose the talker". In passthrough the trio is coherent: all three read the one loop. Under duplex they read three different scopes. History comes from the talker, observational memory from the reasoner, and usage is the aggregate of both. An artifact assembled from them is not merely incomplete, it is internally inconsistent: the observation watermark indexes into the history the memory was built against, so pairing the reasoner's memory with the talker's history misaligns it, and restoring that artifact is worse than restoring nothing.

So the pin is load-bearing, not a convenience. Migrate onto the facade with `mode: 'passthrough'` and keep v1 for that pass, then move to `getState()` / `restore()`, and only then drop the pin. Dropping it first means every session written in between is already corrupt, and no later migration recovers what was never persisted coherently.

## Context Slots

Slots are persistent messages at the front of context. Use them for application state that should survive across loops and benefit from prefix caching.

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  slots: ['app-config', 'user-profile', 'workspace'],
});

const context = agent.getContextManager();
context.setSlot('app-config', '<app-config>...</app-config>');
context.setSlot('user-profile', '<user-profile>...</user-profile>');
context.setSlot('workspace', '<workspace>...</workspace>');
```

Both loops get the same slots with the same content; there is no per-slot routing knob.

Ephemeral context is rebuilt by your application before a loop and is not stored in conversation history:

```typescript
context.setEphemeral('<request-context>Triggered by a scheduled job</request-context>');
await agent.prompt('Continue from current state.');
context.setEphemeral(null);
```

When observational memory is active, Cortex adds an internal `_observations` slot. When deferred tools are enabled, Cortex adds an internal `_available_tools` slot. Consumers should not set either slot manually.

## Interaction and Settlement

Beyond `prompt()`:

- **`deliver(content, { wake?, target?, speaker? })`**: fire-and-forget input for things the user did not type: a notification, a webhook, a completed job. `wake` (default true) decides whether the content may start a turn on an idle loop or wait for the next one. `target` is `'conversation'` (default) or `'work'`. `speaker` defaults to `'system'` and must be set to `'user'` when you are relaying actual human speech, because only a user-speaker delivery can satisfy a pending permission ask. The safe default is deliberate: otherwise every notification path becomes a silent source of consent.

  `speaker` also decides how the content is framed. Everything delivered is fenced in an `<external-update>` wrapper, which tells the loop "this is content about something, not the user speaking", and that fence is what keeps a relayed email body out of the instruction lane. `speaker: 'user'` is the one exception: it arrives bare, exactly as `prompt()` does, because fencing a relayed ASR transcript would tell the talker to disbelieve the only thing in the session that really is the user. One declaration, one trust class. A voice pipeline that prefers non-blocking `deliver()` over `await prompt()` gets the same framing either way.
- **`steer(message)`**: queue content into the turn that is already running.
- **`abort(scope?)`**: `'conversation'`, `'work'`, or `'all'` (default). Every scope aborts the in-flight turn on its target, drops queued deliveries, and clears the steering and follow-up queues; `'work'` and `'all'` additionally cancel running sub-agents and resolve pending permission asks as deny. `'conversation'` does neither: the work loop is still running, so its asks stay pending. Aborting after `destroy()` is a no-op rather than an error, so a fire-and-forget abort on a quit key does not need a teardown guard.
- **`destroy(timeoutMs?)`**: tears everything down. Idempotent.

Two settlement facts, each with a synchronous getter and an awaitable form:

```typescript
if (!agent.conversationIdle) showTypingIndicator();

await agent.waitForConversationIdle(); // nothing queued or running on the conversation
await agent.waitForWorkSettled();      // plus: no sub-agents, no parked deliveries, no pending asks
```

Both read loop gate depth rather than a "prompting" flag, so they do not report idle while work is still queued. `workSettled` deliberately ignores queued silent deliveries, which wait for the next prompt by design.

Its ask term reads the facade's merged ask registry, not any one loop's, so a network ask raised through `resolveNetworkAccess` (sandbox egress, WebFetch) holds it open too. Those never enter a loop registry at all, and reporting settled while one of your resolvers is still blocked is the case the predicate exists to rule out.

## Permissions

`resolvePermission` is the single public hook for tool permissions. Return `true` or `{ decision: 'allow' }` to proceed. Return `false`, `{ decision: 'block' }`, or `{ decision: 'ask' }` to block the tool call with a reason.

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  resolvePermission: async (toolName, args, context) => {
    if (toolName === 'Bash') {
      // Collect approval; dismiss the prompt if the run is aborted meanwhile.
      return await askForApproval(toolName, args, { dismissOn: context?.signal });
    }
    if (toolName === 'Write' || toolName === 'Edit') {
      return isAllowedPath(args) ? true : { decision: 'block', reason: 'Path is outside workspace.' };
    }
    return true;
  },
});
```

In duplex, an `ask` is routed through the conversation by the facade's permission broker: the talker reads the request out verbatim, and the user's answer resolves it. `allow` and `block` decisions pass through untouched. The broker enforces the rules that make a spoken "yes" mean something: one ask voiced at a time, and an allow accepted only for the most recently voiced ask, only once, and only from a turn caused by user speech that arrived after the ask was voiced. In passthrough the resolver is called directly and Cortex runs no in-band approval UI: your application collects approval and retries or steers as appropriate.

The resolver receives a third argument, a `ToolPermissionRequestContext` with an optional `signal`. The signal fires when the run that asked is aborted. Cortex races your resolver against that abort and proceeds with a block when the abort wins, so an unanswered approval prompt can never hang `abort()` or `destroy()`. A UI showing an approval prompt should listen on the signal and dismiss the now-moot prompt.

The context also carries `askId`, a nonce unique to each ask (two asks never share one, even for identical tool calls), and `loopPath`, the identity of the loop that raised it (`reasoner`, `reasoner/<taskId>` for a sub-agent). Key pending-prompt UI state on `askId` and use `loopPath` to attribute asks when several loops share one resolver. The same `loopPath` appears on `onError` and `onTurnComplete` origin contexts, in `persistResult` metadata, and as the `[AgentLoop:<loopPath>]` prefix on log lines.

The `SubAgent` tool invocation itself is treated as internal orchestration. Tool calls made by child agents still go through the parent permission resolver; the `context.signal` for those asks is the child run's signal, so cancelling a child dismisses its pending ask.

## Background Sub-Agents

The `SubAgent` tool lets the model delegate work; the same machinery is exposed as a consumer API:

```typescript
const { taskId } = await agent.spawnBackgroundSubAgent({ instructions: 'Research topic X' });

console.log(agent.getActiveSubAgents()); // live status, tool activity, cost

agent.steerSubAgent(taskId, 'Focus on the last two years only.');

await agent.cancelSubAgent(taskId);
```

Sub-agents belong to the reasoner. A talker control tool that starts a task dispatches it to the reasoner rather than spawning directly, so consumer spawns, model spawns, and talker-dispatched work all share one pool and one set of lifecycle log entries. Quick lookups are the exception: they get their own small pool so a busy task fleet cannot starve them.

`cancelSubAgent(taskId)` destroys the child, resolves its completion promise as `cancelled`, and discards any pending or late result so cancelled work is never delivered to the loop. It returns `false` for an unknown task ID. A cancelled foreground child reports `status: 'cancelled'` to the SubAgent tool.

When a background child or backgrounded Bash command completes while the loop is busy, its result is queued and delivered once the loop goes idle. Delivery is durable: a failed delivery attempt is unwound from history and re-queued with a capped attempt count and a total elapsed budget. A delivery Cortex gives up on (attempts exhausted, budget spent, a fatal error such as failed authentication, or the agent shutting down first) is dead-lettered instead of silently dropped:

```typescript
agent.onBackgroundResultDelivery((taskIds) => showSpinner(taskIds));

agent.onBackgroundResultDeadLettered((result) => {
  notifyUser(`Background result for ${result.taskId} could not be delivered: ${result.lastError}`);
});

// Bounded list, newest last; still available after destroy().
const undelivered = agent.getDeadLetteredBackgroundResults();
```

Both of those are **reasoner-only**. The talker dead-letters too, and its losses are wake deliveries, which can carry user utterances, so they matter more than a background result does. Those reach the session log as `lifecycle` entries with `data.event === 'delivery_dead_lettered'` (carrying the full message, not a preview) and reach neither the callback nor the getter. If undelivered content matters to you, read it off the log rather than off these two surfaces.

A delivery failure that a later re-queued attempt recovers from surfaces no `onError`; a terminal failure surfaces exactly one, and never rejects a consumer `prompt()` that already succeeded.

## MCP Tools

Connect MCP servers at runtime. Tool names are namespaced as `serverName__toolName`.

```typescript
await agent.connectMcpServer('memory', {
  transport: 'stdio',
  command: 'node',
  args: ['/absolute/path/to/mcp-server.js'],
  cwd: '/absolute/path/to/server',
  env: { NODE_ENV: 'production' },
});

console.log(agent.getMcpClientManager().getServerToolNames('memory'));

await agent.disconnectMcpServer('memory');
```

The facade multiplexes MCP: one connection per server for the whole agent, projected to the reasoner and its sub-agents, never to the talker. Pass your own `mcpClientManager` if you want to own the lifecycle; otherwise the facade mints one and closes it at `destroy()`.

For large MCP tool sets, enable deferred tools so schemas are loaded on demand:

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  deferredTools: {
    enabled: true,
    deferMcp: true,
    alwaysLoad: ['memory__search'],
  },
});
```

## Consumer Tools

You can pass in-process tools at creation or add them later. Tools use Cortex's `execute(params, context?)` contract. Consumer tools go to the reasoner; the talker's toolset is fixed.

```typescript
import { z } from 'zod';
import { CortexAgent, zodToTypebox, type CortexTool } from '@animus-labs/cortex';

const getProjectTool: CortexTool = {
  name: 'get_project',
  description: 'Return metadata for the active project.',
  parameters: zodToTypebox(z.object({ id: z.string() })),
  async execute(params) {
    const { id } = params as { id: string };
    const project = await loadProject(id);
    return {
      content: [{ type: 'text', text: JSON.stringify(project) }],
      details: { id },
    };
  },
};

const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  tools: [getProjectTool],
});

agent.addConsumerTool(getProjectTool);
agent.removeConsumerTool('get_project');
```

If you already have a pi-agent-core style tool with `execute(toolCallId, params, signal, onUpdate)`, adapt it with `fromPiAgentTool()` before passing it to Cortex.

## Skills

Register SKILL.md files explicitly. Cortex does not scan directories.

```typescript
agent.addSkill({
  path: '/absolute/path/to/my-skill/SKILL.md',
  source: 'user',
  variables: { PROJECT_ROOT: workingDirectory },
});

agent.setPreprocessorVariables({ WORKSPACE: workingDirectory });
agent.setScriptContext({ userId: currentUser.id });
```

Skills register on the reasoner, like MCP servers and consumer tools. The model sees a compact skill list in the `load_skill` tool description. Full skill content is loaded into ephemeral context only when `load_skill` is called or when your app preloads it:

```typescript
await agent.loadSkill('my-skill', 'optional args');
await agent.prompt('Use the loaded skill for this task.');
```

Skill content is cleared automatically when the loop ends. You can also call `clearSkillBuffer()`.

## Compaction

Compaction is observational memory. An observer records older conversation as observations in an internal slot, in the background, and once the context fills they replace the messages they cover. The most recent messages always stay verbatim. A reflector condenses the observations when they grow, and emergency truncation remains as a failsafe.

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  compaction: {
    observational: { activationThreshold: 0.85 },
  },
});
```

To compact now, whatever the context usage (before switching to a model with a smaller window, for example), call `compactNow()`. A failed observer call changes nothing and says why:

```typescript
const result = await agent.compactNow();
if (result.reasoner.status === 'failed') {
  console.warn(`Nothing changed: ${result.reasoner.error.message}`);
}
```

Each loop runs its own compaction manager with staggered thresholds, so both loops never compact at once. The talker is additionally forced into a non-blocking posture, because a talker that stops to compact is a conversation that stops mid-sentence; for the same reason `compactNow()` on the talker swaps in only what it has already observed, and its result is `result.talker`.

For oversized tool results, provide `persistResult` so Cortex can replace context-heavy output with a bookend preview and a file reference:

```typescript
const agent = await CortexAgent.create({
  model,
  workingDirectory,
  initialBasePrompt,
  persistResult: async (content, metadata) => {
    return writeToolResultFile(content, metadata);
  },
});
```

`persistResult` is not only called for tool results. When the session log passes its retention cap, the evicted entries are spilled through the same callback as JSON lines under the synthetic tool name `_session_log`. A persistor that names files after `metadata.toolName` will find `_session_log-*.md` sitting in its tool-results directory. Branch on the name if those belong somewhere else.

## Usage and Cost

`getSessionUsage()` returns one aggregate across both loops, every sub-agent, every quick lookup, and utility spend (observer, reflector, WebFetch, Bash utility calls). Children are counted exactly once, so do not add `SubAgentResult.usage` on top of it. The v2 persistence artifact keeps per-loop attribution alongside the total, so a restore does not flatten it.

`budgetGuard.maxCost` keeps its per-prompt meaning on the reasoner. For a whole-session ceiling across everything, set `duplex.maxTotalCost`. Leave it unset and the aggregate is uncapped; Cortex records a `duplex-cost-cap-unset` note in [the resolution report](#what-you-actually-got) rather than inventing a number for you.

There are two guards, and reading the wrong one is easy:

- **`getBudgetGuard()`** returns the guard built from your `budgetGuard` config, in both modes. This is the one to check a `maxCost` you set against, because it is the object that holds your number.
- **`getAggregateBudgetGuard()`** returns the facade's lifetime guard across both loops, sub-agents, lookups, and utility spend, capped by `duplex.maxTotalCost`. This is the guard that stops a duplex session, so a UI reporting "the agent halted on budget" reads `isBreached()` here. It is `null` in passthrough, where the reasoner's own guard is the whole story.

## Direct Model Calls

Use `prompt()` for tool-using agent loops. Use direct completion helpers for single LLM calls that should not use tools or mutate conversation history. `directComplete()` and `structuredComplete()` use the primary model; `utilityComplete()` uses the cheaper utility model.

Each helper accepts two context shapes. A raw context passes caller-assembled messages to the provider verbatim:

```typescript
const text = await agent.directComplete({
  systemPrompt: 'Summarize the input.',
  messages: [{ role: 'user', content: '...' }],
});

const data = await agent.structuredComplete(
  {
    systemPrompt: 'Extract fields.',
    messages: [{ role: 'user', content: '...' }],
  },
  zodToTypebox(z.object({ title: z.string(), tags: z.array(z.string()) })),
);

const usage = agent.getLastDirectUsage();
```

### Structured Contexts and Caching

A structured context supplies the same opinionated regions the agentic loop uses, and Cortex assembles the message array as `[slots][history][ephemeral][prompt]` with its cache breakpoint strategy applied on top (BP2 after the last slot, BP3 at the end of history):

```typescript
const review = await agent.directComplete({
  systemPrompt: 'You review pull requests.',   // consumer-owned, sent as-is
  slots: [styleGuide, repoConventions],        // stable blocks, most stable first
  history: reviewTurns,                        // consumer-managed, append-only
  ephemeral: `Queue depth: ${queue.length}`,   // volatile, outside the cached prefix
  prompt: 'Review the attached diff.',
}, { sessionId: 'pr-review-pipeline' });
```

Prefix caching rewards byte-identical prefixes across calls, so the caching contract is:

- Keep `slots` byte-stable and ordered most stable first. Empty entries are dropped.
- Treat `history` as append-only. Cortex stores nothing between calls; pass the same array plus any new turns. Because pi-ai also marks the last user message, appending the previous `prompt` and response to `history` turns the previous call's cache entry into a read on the next call.
- Put anything that changes per call in `ephemeral` (or the `prompt`). It sits after BP3 and never invalidates the cached prefix.
- When running several independent pipelines, give each a distinct `sessionId` (option, defaults to the agent's session id) so requests route to the right cache.
- For `structuredComplete()`, keep the output schema byte-stable across calls: tool definitions precede the system prompt in Anthropic's cacheable prefix, so a changing schema misses the whole prefix.

Breakpoints are stamped on Anthropic only; other providers still benefit from the stable prefix through their implicit caching. Raw and structured shapes are mutually exclusive: pass `messages`, or `prompt` with the optional regions, never both.

## Shutdown

Always destroy long-lived agents during application shutdown. This aborts active loops, cancels sub-agents, closes MCP connections, kills tracked subprocesses, clears buffers, and removes event listeners.

```typescript
process.once('SIGINT', async () => {
  await agent.destroy();
  process.exit(0);
});
```
