# CortexAgent: The Composite Facade

> **STATUS: IMPLEMENTED. DUPLEX IS THE DEFAULT ON CONCURRENT BACKENDS.**

`CortexAgent` is the composite facade over the `AgentLoop` primitive. Consumers interact with one agent; internally the facade owns the resident loops, the session log, settlement predicates, and composite persistence. The design lives in `docs/cortex/duplex/`; this document describes what is implemented and, in particular, where the facade's surface does *not* mean what the same-named `AgentLoop` member means.

Two modes:

- **`duplex`** (the default on concurrent backends, decisions.md D14 and D21): a fast talker loop fronting a persistent reasoner. The talker always has the floor and delegates through fire-and-forget control tools; the reasoner does all real work.
- **`passthrough`**: a single reasoner loop. Behavior is identical to using `AgentLoop` directly, verified by a side-by-side parity suite. This is the consumer opt-out and the parity baseline.

### Mode resolution

Duplex only helps when the talker's request runs while the reasoner's is in flight. Hosted providers serve concurrent requests, even two for the same model. Ollama serves one request per model by default (`OLLAMA_NUM_PARALLEL=1`) and runs two different models at once only if both fit in memory, and custom OpenAI-compatible endpoints are unknown. So the mode follows the backend:

| `mode` | Result |
|---|---|
| omitted | `passthrough` when the talker and the reasoner would share one backend that is not `parallel` for both models, with a `mode-resolved-passthrough` note naming the backend and the models; otherwise `duplex`. |
| `'duplex'` | Always duplex. If the talker and the reasoner share a backend that is not `parallel`, a `duplex-not-concurrent` note warns that the talker can queue behind the reasoner. |
| `'passthrough'` | Always passthrough. |

The talker model judged is the one assembly would build: `talker.model` when set, otherwise the reasoner's auto-resolved fast tier or the `utilityModel` you set (which falls back to the primary model itself on a provider Cortex cannot enumerate).

Duplex fails only when both loops' requests go to one server that cannot serve them at once. So the question is whether the two models share a backend, judged by the base URL's host and port (loopback spellings count as one host, and a custom OpenAI-compatible model on Ollama's `/v1` is the same server as the native Ollama model), and only then whether that backend is `parallel` for both. Two backends always overlap: an Ollama reasoner with a talker pinned to a hosted model runs duplex, and so does the reverse. Two distinct models on one serial Ollama server block, because whether both fit in memory is what Ollama does not expose; `parallelRequests: true` on both models opts in.

`concurrency` is stamped when the model is created:

- **Hosted providers** (every provider in pi-ai's catalog, read at runtime, so a provider a pi-ai release adds is covered without a Cortex change): `parallel`.
- **Native Ollama** (`ProviderManager.createOllamaModel()`): `serial`, unless the config sets `parallelRequests: true` (for a server with `OLLAMA_NUM_PARALLEL` raised whose talker and reasoner models fit in memory together). Ollama's API does not expose either setting, so Cortex cannot detect it.
- **Custom endpoints** (`createCustomModel()`) and any provider id pi-ai does not know: `unknown`.
- **Any model whose base URL is local**: `unknown`, whatever its provider id. Loopback, private-network addresses (RFC 1918, link-local, IPv6 unique-local, the `100.64/10` space tailnets use) and private-use names (`.local`, `.internal`, `.lan`, a single-label host) all count, so a catalog provider id aimed at a local proxy or vLLM is not mistaken for the hosted API.

The mode is fixed at construction, because the loops are assembled from it. A later `setModel()` that leaves the talker and reasoner sharing a backend that is not `parallel` keeps a duplex agent duplex and records a `duplex-not-concurrent` note (and clears it if you switch back); a passthrough agent stays passthrough, and its `mode-resolved-passthrough` note is re-read against the new model: it names the new backend, or, when the new models would have resolved to duplex, says the mode was fixed at creation (`data.wouldResolveTo: 'duplex'`). To change mode, create a new agent.

`AgentLoop` remains exported and remains the loop primitive. Nothing about direct `AgentLoop` use changes.

**If you are upgrading an existing consumer, read "What changes when duplex is the default" below before anything else.** Three surfaces change meaning without changing type.

## Managed sandboxing

Set `sandbox: true` to opt in to workspace containment, or supply `SandboxOptions` for policy settings. Cortex initializes and disposes the backend, shares it across loops, and wires network decisions automatically. `getSandboxState()` reports the effective policy; trusted host code can call `setSandboxRung()` after work settles. See the [sandbox consumer guide](./sandbox-consumer-guide.md).

The `network-resolver-unwired` note below applies only to manually supplied providers. Managed sandboxing wires the broker automatically.

## Construction

```typescript
import { CortexAgent } from '@animus-labs/cortex';

const agent = await CortexAgent.create({
  // everything AgentLoopConfig accepts, plus:
  mode: 'duplex',               // optional; omitted resolves from backend concurrency (see Mode resolution)
  talker: { model },            // optional; defaults to the fast tier of the primary provider
  idleSignal: () => boolean,    // optional wake-policy idle signal (advisory)
  duplex: {
    maxTotalCost,               // aggregate session cap across both loops (see the warning below)
  },
  sessionLog: {                 // optional log tuning
    maxEntries: 10_000,         // retention cap (churn evicted before conversation)
    maxSubscriberBuffer: 1_000, // per-subscriber buffer bound
  },
  stateChangeDebounceMs: 500,   // onStateChanged debounce
});
```

Config is routed per the table in `src/facade/config.ts` (`CONFIG_ROUTING`). The table is compile-time exhaustive: adding a config key without a routing destination is a type error. In passthrough every non-facade key flows to the reasoner unchanged, so behavior matches direct `AgentLoop` construction exactly.

One routing caveat in duplex. There is no unresolvable-talker-model case: model resolution falls back to the primary model rather than failing, so on a provider whose model list cannot be enumerated (Ollama, custom OpenAI-compatible endpoints) an explicit or opted-in duplex assembles with **talker = reasoner**. That configuration is healthy-looking and passes every test while delivering none of the latency benefit, so it is reported as a `talker-model-fallback` note in [the resolution report](#the-resolution-report).

The talker keeps mirroring after assembly. When `talker.model` is unset, a facade `setModel()` re-resolves the talker onto the fast tier of the new primary model, exactly as `create()` picked it, so a model or provider switch moves the presence loop and every later quick lookup (which builds from the talker's model) along with the reasoner. A pinned `talker.model` is never touched. The talker's primary does not follow `setUtilityModel()`: a utility override changes observational spend, not which fast tier the provider has.

## What changes when duplex is the default

These are the surfaces a consumer hits on day one of an upgrade. All three keep their types, so nothing fails to compile.

- **Event and callback surfaces carry two loops.** The event bridge returned by `getEventBridge()` is a merged bridge forwarding `response_start`, `response_chunk` and `turn_end` from both the talker and the reasoner, and the existing `if (event.childTaskId) return;` idiom does not filter them apart because neither resident loop sets `childTaskId`. Filter on `loopPath` instead. A UI that streams every `response_chunk` into one bubble will interleave the reasoner's internal working prose with the talker's speech; a voice pipeline wired off `turn_end` rather than the talker's deltas will speak the reasoner's private reasoning aloud.
- **`getConversationHistory()` returns the dialogue**, which in duplex is the talker's transcript, not the reasoner's work log. This changed during the restructure: it forwarded unconditionally to the reasoner at first, so a consumer rendering "the conversation" got dispatch scaffolding. The reasoner's work transcript is reachable through `getState()`.
- **There is no session-level cost cap by default.** `getBudgetGuard()` hands back the guard you configured, so `isBreached()` and `getMaxCost()` mean what you set them to. But `budgetGuard.maxCost` keeps its **per-prompt** meaning on the reasoner, and the facade's aggregate guard is uncapped unless `duplex.maxTotalCost` is supplied. A default duplex session runs two resident loops, sub-agents, quick lookups and doubled observational spend against no session ceiling, which is reported as a `duplex-cost-cap-unset` note in [the resolution report](#the-resolution-report). Set `duplex.maxTotalCost` if you want one. When it is breached, the facade stops every loop, sub-agent and quick lookup, retires every outstanding task, and delivers one notice to the talker saying the spending limit was reached. After that, `spawn_task`, `steer_task` and `quick_lookup` are refused with a receipt the talker relays, so no new reasoner run is started; `cancel_task` and `answer_ask` stay open. `prompt()` still accepts input, matching a breached lifetime guard in passthrough: each talker turn past the limit is stopped when it ends, so the user hears one reply and no further spend follows.

## The resolution report

```typescript
agent.getResolutionReport(): ResolutionNote[]

interface ResolutionNote {
  code: ResolutionNoteCode;          // stable, machine-readable
  severity: 'degraded' | 'info';
  summary: string;                   // one line, fits a status bar
  detail: string;                    // what was resolved, and what it costs
  remedy: string;                    // what to set to fix it
  data: Record<string, unknown>;     // the same facts structurally
}
```

Assembly resolves a configuration that can quietly differ from what the consumer asked for. The report is the queryable record of every such difference, in both modes.

`degraded` means the consumer asked for something and is not getting it, or the architecture is not delivering its premise. `info` means a default is in force that they may want to change. Nothing is a `degraded` note merely because it is unusual.

| Code | Severity | Condition |
|---|---|---|
| `talker-model-fallback` | degraded | No `talker.model` was set and no fast tier resolved, so duplex assembled with talker = reasoner. |
| `talker-utility-model-skipped` | degraded | A configured `utilityModel` is from a different provider than the talker's model, so the talker runs its observational memory on its own auto-resolved model. |
| `network-resolver-unwired` | degraded | **Duplex only.** A sandbox and `resolveNetworkAccess` are configured but nobody took `getNetworkAccessResolver()`, so shell egress asks cannot reach the broker and are never voiced, while WebFetch's still are. |
| `duplex-cost-cap-unset` | info | Duplex assembled with no `duplex.maxTotalCost`, so there is no session-level cost ceiling. |
| `mode-resolved-passthrough` | info | `mode` was omitted and the talker and the reasoner would share a backend that is not `parallel`, so the agent runs passthrough. `data` carries each model's provider, id, endpoint and concurrency. |
| `duplex-not-concurrent` | degraded | The agent runs duplex but the talker and the reasoner share a backend that is not `parallel`, so the talker can queue behind the reasoner. A talker on another backend never earns it. Earned at assembly only by an explicit `mode: 'duplex'`; re-evaluated on `setModel()`. |
| `restore-mode-mismatch` | degraded | `restore()` applied an artifact written in the other mode, so part of it is carried but inactive (see Composite persistence). Recorded at restore, replaced by the next one. `data` carries both modes and what was handed over. |

**A note claims only what Cortex can observe.** `network-resolver-unwired` first said that egress "fails closed", which was an inference about consumer wiring Cortex has no way to see: a consumer that hands its sandbox its own decision function answers those asks perfectly well, and the first consumer to read the note did exactly that. It is duplex-only for the same reason. In passthrough there is no broker, `getNetworkAccessResolver()` returns the consumer's own function unchanged, and whether anyone called it is evidence of nothing. A marker that lights on a healthy session costs more than the condition it was meant to catch, so the rule for any new note is: state the observation and the consequence that follows from it necessarily, and stop there.

**The notes are the source; the other surfaces derive from them.** Each note also produces one `logger.warn` (the text is `detail` plus `remedy`) and one `lifecycle` session-log entry carrying the whole note under `data.note`, both generated from the note rather than written beside it. This is deliberate: the same fact described in two hand-written places is the bug class that produced several of the divergences in the delegation table above. The log entry puts the report in the persistence artifact, so an audit of "why was this session slow or expensive" can find it after the fact.

The report is computed **eagerly at assembly**, not lazily on first read, so it cannot observe a later mutation and present it as an assembly fact. Two exceptions. A facade `setModel()` redoes that part of the assembly (it swaps the reasoner's model and re-mirrors an unpinned talker), so the notes read off the loops' models (`talker-model-fallback`, `talker-utility-model-skipped`, `duplex-not-concurrent`, `mode-resolved-passthrough`) are re-evaluated then: a note that newly applies is recorded through the usual pathway, and one that stops applying leaves the report with a `resolution_note_cleared` lifecycle entry naming its code. A direct loop `setModel()` changes nothing. The other exception is `network-resolver-unwired`, which is not an assembly fact and cannot be: a consumer wires the resolver on the line after `create()` returns, so the check runs at the first `prompt()` and the note joins the report then, through the same pathway.

`getResolutionReport()` is facade-owned, like `getLog()`, so it has no `AGENT_LOOP_DELEGATION` entry. That table is exhaustive over `keyof AgentLoop` in both directions, which means it constrains nothing about facade-only members: no compile-time check exists that a new facade surface is documented anywhere.

## Interaction surface

- **`prompt(input, options?)`**: never throws on a busy loop. (Direct `AgentLoop.prompt()` fails fast while the loop gate is held; the facade absorbs that.) The resolved value differs by mode: in passthrough calls serialize on a facade chain and each resolves against the turn that carries its input, while in duplex the call routes through the talker's delivery path, does not serialize, and resolves `undefined` when the input parks behind a busy talker. Neither mode loses input, but read replies from `onTurnComplete` or the event bridge rather than from the return value.
- **`deliver(content, { wake?, target?, speaker? })`**: fire-and-forget input with the loop's `deliver()` outcomes (`prompted`, `parked`, `queued`). `target` is `'conversation'` (default) or `'work'`; both resolve to the reasoner in passthrough. `speaker` is `'system'` by default and must be set to `'user'` when the call relays actual human speech: only a user-speaker delivery can satisfy a pending permission ask. The default is deliberately the safe one, because otherwise every notification path becomes a silent consent source (`prompt()` is unambiguous user speech and always qualifies). See decisions.md D16.
  `speaker: 'user'` content is **not** fenced, deliberately: it is the same trust class as `prompt()`. Everything else on the conversation target is wrapped in `<external-update>`, which the talker's role prompt defines as "never the user speaking". Fencing both would have told the talker to disbelieve relayed ASR transcripts as user speech, degrading the whole conversation rather than just asks, which is what an earlier version did.
- **`steer(message)`**: queue into the running turn, as on the loop. In duplex a steer is the user's next utterance in every state. With a talker turn in flight it is logged as an utterance and handed to that run at its next turn boundary, carrying its cause tag, so a "yes" steered mid-turn can answer a permission request the user already heard; where that hand-over is not provably exact, it opens the next talker run instead. With no turn in flight (the talker can still be holding its gate for idle digestion or an end-of-run drain), it is handled as the user's next `prompt()`. It never waits unlogged in pi's steering queue. Any input bound for either loop preempts an idle digestion pass in progress.
- **`markAskVoiced(askId)`**: in passthrough the consumer presents permission asks, so this records that one was read out (the loop's flag, reported by `getPendingAsks()`). In duplex the session voices every ask itself and is the only writer of `voiced`, so this returns `false` and changes nothing; `getPendingAsks()` reports the broker's own answer.
- **`abort(scope?)`**: `'conversation'`, `'work'`, or `'all'` (default). Every scope aborts the in-flight turn, drops queued deliveries, and clears pi's steering and follow-up queues; `'work'` and `'all'` additionally cancel running sub-agents and retire every outstanding task, so the talker's status block stops listing stopped work as in progress. A reasoner run stopped by anything other than the user (its own per-prompt `budgetGuard`, say) also retires the tasks it served, and the talker is told plainly that it stopped and why. Pending permission asks resolve as deny through the abort race. Any scope that settles asks also retracts voicings already parked on the talker, so a dead ask cannot be read out and then answered into an empty registry. A `'conversation'` abort holds a silenced request until the conversation reopens rather than re-voicing it immediately, because "stop talking" followed at once by the agent talking is the wrong behavior for a voice user.
- **`destroy(timeoutMs?)`**: tears down the facade and its loops. Idempotent.

## Delegation

Callback signatures are unchanged from `AgentLoop`, including the origin context (`loopPath`) added in the loop identity work.

The rule is: **forward everything that is pure delegation, and withhold only what has no single composite meaning.** An earlier draft of this document claimed everything a consumer uses was already exposed, which was wrong in both directions and left four members with live call sites in this repo unreachable.

`AGENT_LOOP_DELEGATION` in `src/facade/loop-delegation.ts` is the authoritative source, not this table. It is a compile-time-exhaustive record over `keyof AgentLoop`, so every member must carry a disposition or the package does not build, and a runtime test asserts both directions: forwarded members exist on the facade, withheld and subsumed members do not, so accidental exposure fails too.

**What that test does not assert is behavior.** `'forwarded'` means the name exists on the facade; it does not mean the call does the same thing. A whole-diff review found that a substantial fraction of forwarded members diverge in duplex, every one of them shipped, because presence was the only thing under test. The taxonomy below is the honest reading, and it is the Phase 3 migration checklist.

| Category | Members | Notes |
|---|---|---|
| **Delegated** (byte-identical) | slots, `getModel`, thinking levels (the talker's is fixed `off`), `getCompactionManager`, `isUtilityModelOverridden`, `getAutoResolvedUtilityModel`, `modelContextWindow`, `setContextWindow`, `getMcpClientManager`, `getMcpTools`, `getSkillBuffer`, `clearSkillBuffer`, `composeSystemPrompt`, `getSystemPromptSections`, `capToolResult`, `getEnvOverrides`, `updateCurrentContextTokenCount`, direct completions, sub-agent spawn/cancel/steer | Straight delegation to the reasoner. |
| **Adapted** (facade adds a guard) | `prompt`, `deliver`, `steer`, `abort` | All route through `assertPromptable()` / `assertNotDestroyed()`, which the loop does not have, so a fire-and-forget caller that never awaited these now has an unhandled rejection path after `destroy()`. `deliver()` additionally throws on whitespace content, and in duplex `assertPromptable` validates the *talker's* system prompt even for `target: 'work'`. |
| **Retargeted** (a different loop than the name suggests) | `followUp`, `setSteeringQueueMode`, `setFollowUpQueueMode`, `clearSteeringQueue`, `clearFollowUpQueue`, `clearQueuedDeliveries`, `getQueuedDeliveries`, `queuedDeliveryCount`, `pendingWakeDeliveryCount` → the **talker**; `setHeadlineProvider` → the **reasoner**; `getDeadLetteredBackgroundResults` → the **reasoner** only | Using `followUp()` to queue work queues it into a loop with no tools. `setHeadlineProvider` feeds the reasoner while the facade owns the talker's provider. The talker's dead-lettered wake deliveries (user utterances among them) are logged but unreachable through the getter. |
| **Different object** | `getBudgetGuard` (aggregate guard: different cap, scope and breach state), `getEventBridge` (merged, two loops), `getContextManager` (`FanOutContextManager`: writes both, reads the reasoner) | See the upgrade warnings above. |
| **Per loop** (setter reaches both resident loops) | `setModel` (re-mirrors an unpinned talker onto the new fast tier), `setUtilityModel` (the talker takes it when it shares the talker's provider, same rule as assembly), `resetUtilityModel`, `setCacheRetention`, `setContextWindowLimit`, `setSessionId` (the talker gets a derived id) | Getters report the reasoner. `setContextWindow` stays reasoner-only: it is metadata for the primary model, and the talker runs a different one. |
| **Fan-out** (handler fires per loop) | `onLoopComplete`, `onError`, `onRetryScheduled`, `onRetrySucceeded`, `onRetryExhausted`, `onObservation`, `onReflection`, `onMemoryError`, `onMemoryRecovered`, `onMemoryGap`, `setWorkingTagsEnabled` | Registered on both resident loops, so persistence and error-reporting work doubles. **Every fan-out callback takes a trailing `LoopOriginContext`**, so a consumer can tell which loop produced an arrival and collapse or attribute the pair; `onLoopComplete` takes it as its only argument, having previously taken none. Adding it was source-compatible: a handler declared with fewer parameters keeps working, which is what let the omission survive as long as it did. Without the label the doubling is not merely noisy but wrong: one provider hiccup renders two retry countdowns, one compaction renders two notifications, and `onLoopComplete` said only that *a* loop had finished. `onTurnComplete` is deliberately **not** in this list: it registers on the conversation loop only. It is not a diagnostic but the "the assistant finished saying something" signal a TUI finalizes its bubble on and a voice app speaks, so fanning it out would fire it twice per exchange and hand the consumer the reasoner's internal working text as if it were the reply. The reasoner's results still reach the user, as deliveries the talker performs, which are talker turns. It is `'forwarded'` in `AGENT_LOOP_DELEGATION` because that table records presence, with the routing decision noted at the call site. |
| **Composite value** | `getSessionUsage` (baseline-plus-delta across both loops and settled lookups), `getPendingAsks` (reasoner registry plus broker-minted network asks), `isRunning` / `isPrompting` (OR across both loops), `state` (reasoner only) | `state` reading the reasoner alone is a wart: `isReasonerShuttingDown()` checks both loops, `state` checks one, so a destroyed talker is invisible to it. |
| **Subsumed** | `restoreConversationHistory`, `restoreObservationalMemoryState`, `restoreSessionUsage` → `restore()`; `isLoopActive` → `conversationIdle`; `waitForLoopIdle` → `waitForConversationIdle`; `waitForAskSettlement`, `waitForWakeDeliveriesDrained` → `waitForWorkSettled` | Not a rename. `restore()` is all-or-nothing and rejects while running, where the three loop methods are independently callable at any time, so a consumer calling them separately rewrites the call site rather than renaming it. |
| **Partially subsumed** | `clearAllQueues` → folded into `abort()` | `abort()` also aborts the turn and cancels children, and discards the dropped content that `clearAllQueues()` returns for re-routing. There is currently no facade way to drop queued content without aborting. |
| **Withheld** | `getTransformContextHook`, `prePromptMessageCount`, `getSubAgentManager`, `loopPath` | Composition internals, a cache-breakpoint internal, a raw internals handle (consumers have `getActiveSubAgents` plus spawn/cancel/steer), and a value with no single composite meaning in duplex (origin reaches consumers through `LoopOriginContext`). |

`waitForIdle`, `continue`, and `reset` are members of the wrapped `PiAgent` contract rather than `AgentLoop`, and are not part of this surface.

## The session log

The facade keeps an append-only session log: the ordering record and audit trail of the session, and part of the persistence artifact. It is not a context surface; no prompt is ever built from it.

Entry types: `utterance`, `reply`, `directive`, `delivery`, `error`, `retrying`, `lifecycle`, `ask`, `ask_answer`, `lookup_result`. Passthrough produces a subset: `utterance` (consumer input), `reply` (user-facing turn text), `error` and `retrying` (from the error and retry handlers), and `lifecycle` (sub-agent spawns, completions, failures, dead-lettered deliveries, aborts, and resolution notes). Duplex adds `directive`, `delivery`, `ask`, `ask_answer` and `lookup_result` from the control tools, the permission broker and quick lookups. In duplex, `reply` entries are taken from the talker only, since the reasoner's final text is internal working prose rather than something the user was told.

Entries carry:

- **`seq`**: monotonic sequence number, the ordering authority (timestamps collide under burst).
- **`loopPath`**: producer identity.
- **`causedBy`**: causation stamp. An entry produced by a run (a reply, an error in that run, a spawn made during it) carries the seq of the input that run consumed: the utterance a prompt logged, or the delivery a parked item's sweep run carried. The seq rides with the input into whichever run takes it, in both modes, so nothing is guessed. A background delivery drain carries the causation of the run that started the work it delivers; a completion lifecycle entry carries its spawn entry's seq. A run whose input carried no tag (a consumer's own direct loop call, say) stamps nothing.
- **`wake`** and **`data`**: wake class (duplex) and structured per-type payload.

Reads and subscriptions:

- **`getLog(fromSeq?)`**: snapshot copy, never a live reference.
- **`subscribeLog(cb, fromSeq?)`**: push subscription with replay from a seq. Ordering is append-then-emit: an entry reaches subscribers before the events of the run it triggers. Synchronous callbacks are invoked inline; a callback that returns a promise is awaited, with later events buffered to the configured bound and then dropped oldest-first with a gap marker (`{ kind: 'gap', fromSeq, toSeq, dropped }`) instead of applying backpressure to the loops. Unsubscribe is idempotent.

Retention: the log holds at most `sessionLog.maxEntries` entries (default 10,000), evicting oldest-first. When `persistResult` is configured, evicted entries are spilled through it (as JSON lines under the synthetic tool name `_session_log`) before leaving memory. Replaying from below retention yields a leading gap marker.

## Composite persistence

`getState()` returns the versioned composite artifact:

```typescript
{
  version: 2,
  mode:            'duplex',// the mode that wrote it; optional (older artifacts omit it)
  log:             [...],   // the session log
  talkerHistory:   [...],   // post-slot messages (empty in passthrough)
  reasonerHistory: [...],
  talkerMemory:    {...},   // observational state (null in passthrough)
  reasonerMemory:  {...},
  usage: {
    total:   {...},         // aggregate across every loop
    perLoop: { talker, reasoner },
  },
  router: {                 // duplex only; optional (older artifacts omit it)
    nextAliasNumber,        // task aliases never restart under a transcript that uses them
    delegations,            // tracked tasks
    pendingDeliveries,      // results logged but not yet handed to the talker
    conversationDeltas,     // conversation the reasoner has not seen yet
    conversationDeltasOverflowed,
  },
  queuedDeliveries: {       // optional; absent when both queues are empty
    talker,                 // silent deliveries waiting for the talker's next turn ([] in passthrough)
    reasoner,               // silent deliveries waiting for the reasoner's next prompt
  },
}
```

`getState()` is async: it snapshots only at a consistent point (loop gate empty, never mid-run), so the log and histories always match. `restore(state)` accepts a v2 artifact, a v1 artifact (`{ version: 1, history, memory?, usage? }`), or a bare message array; v1 shapes restore into the reasoner with an empty log, so existing single-history sessions upgrade transparently.

Restore rules:

- Rejected while any loop is running or any sub-agent is active.
- Per-loop ordering holds internally: history first, then observational state (the observation watermark aligns to the post-slot history length).
- Usage restore is a baseline: the facade reports `restoredBaseline + live deltas`, so repeated restores are idempotent and `getSessionUsage()` totals survive restores without double-counting. Note `SessionUsage.totalCost` includes direct/utility completion spend (observer, reflector, summarization, WebFetch, Bash utility calls).
- A v2 artifact with talker content restored into a passthrough facade carries the talker side through opaquely: `getState()` round-trips it unchanged, and restored talker spend stays in the aggregate.
- **Restoring across modes is not a clean continuation, and the report says so.** With `mode` omitted the mode follows the backend, so a consumer that moves backends between runs can restore an artifact written in the other mode. The artifact's `mode` (or, for an older artifact, its shape: router state or talker usage means duplex) is compared with the agent's, and a mismatch records a degraded `restore-mode-mismatch` note plus its lifecycle entry in the restored log. The next restore replaces it.
  - **Duplex artifact, passthrough agent.** The single loop continues from the reasoner's history. That history already holds the conversation up to the last delegation, because every dispatch carried it; the conversation since (the router's pending `conversationDeltas`, bounded by `deltaBufferMaxChars`) is queued on the loop as silent context for its next prompt and removed from the carried router state, so a later restore into duplex does not hand it to the reasoner twice. The talker's history and memory, task state, results the talker had not relayed yet, and the talker's queued deliveries are carried but inactive; `data` counts what was handed over and what was not relayed.
  - **Passthrough artifact, duplex agent.** The reasoner continues with the whole conversation, but the talker starts with no history (or with whatever an earlier duplex run left it), so it learns the earlier conversation only from what the reasoner delivers. Cortex does not rebuild the talker from the single history: that history holds tool calls the talker has no tools for and is order-coupled to the reasoner's observational memory, and a rebuild from the log is unbounded and loses what compaction summarized.
  - To avoid both, pass `mode` explicitly for sessions you persist, so a change of backend cannot change the mode under a saved session.
- Router state comes back with the rest, and a restore never starts a turn. Results the router was still holding reach the talker silently and surface with the user's next turn. A task that was still outstanding lost the run serving it, so it is retired, recorded as a `delegation_interrupted` lifecycle entry, and described to the talker in a silent note (interrupted, offer to restart) rather than listed as live work. The alias counter resumes after the highest alias the restored log uses even when the artifact has no `router` field, so aliases never collide with ones the transcript already mentions.
- Silent deliveries queued at capture time (`deliver(..., { wake: false })` content, silent results already handed to the talker) are queued again on the loop that held them and surface with its next turn, ahead of any results the router was holding. The replaced session's own queued content is dropped as before and recorded in the log.

`onStateChanged(handler)` is the persistence trigger: debounced (`stateChangeDebounceMs`, default 500 ms), fired with a consistent `getState()` snapshot after state-changing activity settles (log appends, run completions, compaction, observation). Consumers persist on this rather than on `onLoopComplete`, which becomes ambiguous once multiple loops exist.

## Settlement predicates

Two distinct facts, each with a synchronous getter and an awaitable form, all built on loop-gate depth (not the prompting flag, which reads idle while gate tasks are queued):

- **`conversationIdle`** / **`waitForConversationIdle()`**: no facade prompt queued or running, and the conversation loop's gate empty. The conversation loop is the talker in duplex and the reasoner in passthrough.
- **`workSettled`** / **`waitForWorkSettled()`**: conversation idle, no active sub-agents, no parked wake deliveries, no pending permission asks. Queued silent deliveries do not count; silent content deliberately waits for the next prompt.

The awaitable forms are event-driven (gate tail, sub-agent completion promises) and are the foundation the Phase 3 scenario tests build on.

## Parity

`tests/unit/cortex-agent-parity.test.ts` drives `AgentLoop` directly and `CortexAgent` in passthrough side by side over identical mock loops and asserts equivalence of pi-level interaction, events, callbacks (with origin context), history, turn results, retry schedules, abort behavior, and usage. Parity is measured against the current (post Phase 0/1) behavior, and it covers passthrough only. Duplex is deliberately not parity-tested: the divergences in the delegation table are the point of the mode, not regressions against it.
