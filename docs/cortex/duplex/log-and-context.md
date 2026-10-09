# The Session Log and Context Mechanics

> **STATUS: IMPLEMENTED AND DEFAULT.** Built across phases 0 through 2b-ii on the `duplex-restructure` branch and validated in Phase 3. Duplex is the default mode (D14); `mode: 'passthrough'` is the opt-out. See migration-plan.md for the honest boundary of what the test suite can see, and consumer-guide.md for what changes on upgrade.

## What the Log Is

The log is the facade-owned, append-only record of the session: every user utterance, talker reply, directive, delivery, permission ask and answer, and task lifecycle event, in one totally ordered sequence. It is:

- the ordering record of everything routed between loops (each directive and delivery is logged before it moves)
- the wake policy's input
- the consumer's persistence artifact
- the audit trail of the session

## What the Log Is Not

The log is not a context surface. No loop's prompt is built by projecting log entries into synthetic view messages. This was the original design and it was rejected (decisions.md D7) after the context-pipeline audit identified three violations, all in current code:

1. **View injections vanish under context pressure.** After an observational swap the post-slot view was rebuilt from the source array, and from the activation threshold on the engine stopped building views at all, so anything that existed only in the returned view was missing from every request at or past the threshold, not just the swap turns. That is fixed: the transform passes its injections into compaction, and a swap re-derives the whole view, injections and the new observations included (`ContextPipeline.transform`'s `rebuildView`). Each request-only surface still has to be carried through every rewrite, which is why the log adds none.
2. **The observational watermark requires reported rewrites.** The ledger tracks indices into the post-slot source history (`compaction/observational/ledger.ts`); every rewrite reports to it (a swap's prefix removal, a failed run's trimmed stubs, an unwound delivery's removals) and it moves its indices with the messages. A foreign insertion nothing reports desyncs the watermark into silent observation loss or an orphaned-toolResult provider 400.
3. **Tool-call-group adjacency.** Any insertion between an assistant tool call and its consecutive tool results corrupts group detection (`findToolCallGroups` in `compaction/tool-call-groups.ts`), the unit atomicity of swaps and truncation, toolResult merge runs, and the cache-breakpoint index simulation (`computeCacheBreakpointIndices` in `cache-breakpoints.ts`) simultaneously.

## The Two Sanctioned Channels

Content reaches a model through exactly two mechanisms, chosen by durability:

### Durable Content: Real Messages

Deliverables, directives, conversation deltas, permission asks: anything a loop must remember becomes a real message in that loop's transcript, delivered at a turn boundary via the loop's `deliver()` primitive. This is the same path background sub-agent results use today (`drainPendingBackgroundResults`, hardened in P0 for capped re-queue-on-failure).

`deliver()` is a state machine over (loop-gate depth, wake class, abort state) with three outcomes (`prompted`, `parked`, `queued`), specified in P1 rather than P0 because the semantics are subtle:

Wake class is the primary axis, loop state the secondary one. Silent never steers, in any state:

| Wake | Loop state | Action |
|---|---|---|
| wake | idle | prompt (starts a turn; the caller's promise is that turn) |
| wake | gate held (any holder) | append to the loop-owned wake queue and enqueue a sweep task that starts a run if the content is still parked when it fires |
| `silent` | any | loop-owned silent queue, flushed as leading messages of the next real prompt |

**Cortex owns wake parking; pi's steering queue is only ever used by the public `steer()` API.** The obvious implementation hands wake content to pi's steering queue and reconciles afterwards, on the premise that some run will drain it. Two things defeat that. First, not every gate holder starts a run: `digestIdle` holds the gate and calls the transform hook directly, so content parked there waits for an unrelated later run, possibly a background drain. Second, and worse, pi's queue is opaque: you cannot inspect it, remove a single entry, or learn that one particular item was drained. Any after-the-fact reconciliation has to approximate, and every approximation leaks. A "was anything left queued" check duplicates already-drained content whenever a second delivery parks behind it, and clearing the queue to avoid that destroys content the public `steer()` API parked.

So both wake and silent content live in loop-owned queues and are spliced into the front of the next run's message batch, which is exact by construction. They differ in one respect only: wake content enqueues a sweep so a run happens even if nothing else would start one; silent content waits for a real prompt.

The accepted cost is that a wake delivery arriving during a live run lands at the start of the next run rather than at the current run's next turn boundary. That is a bounded one-turn delay, and the talker's turns are short by design (capped output, no blocking tools). Exactness is worth more than the latency here, because the failure it removes is duplicated or destroyed conversation content.

**The one early path: `atTurnBoundary`.** That delay is fine for the talker and wrong for a redirect aimed at the reasoner, whose runs last minutes: a `steer_task` that waits for the run to end arrives after the work it was meant to change. So a wake delivery can opt in with `atTurnBoundary: true` (the router sets it on `steer_task` and `cancel_task` dispatches only). It still parks on the loop-owned queue like any wake delivery. The difference is that the loop hands it to pi's steering queue in the `turn_end` frame of a live run, immediately before pi's own steering poll, and only when that poll is guaranteed to drain exactly this message: the turn did not fail or abort, no abort is in progress, the budget guard has not breached, pi's queues are empty, and the item is at the head of the parked queue (an ordinary delivery parked ahead of it, such as a new task, opens the next run, and a redirect must not overtake the work it refers to). Under any other condition it stays parked and behaves as before. The run that takes it adds its cause tags to `activeRunCauseTags`, so the result it produces carries the redirect's causation. Exactness is preserved because pi's queue is only ever given content at the one moment the next read of it is known.

**Silent must never reach pi's steering queue, including while a run is live.** After a terminated tool batch, `runLoop` still polls `getSteeringMessages()` and continues the inner loop if anything is queued. A silent delivery parked there during a talker turn would drain immediately after the control-tool batch and produce an unprompted spoken response to content that was supposed to surface only when relevant. Steering silent content into a running turn is the same mistake wearing a different hat: it lands at that run's next turn boundary and gets acted on, which is a wake by another name.

The silent queue flushes into real prompts only, never into drain-started background-completion runs, because those runs depend on the pre-delivery message count for the unwind accounting added in Phase 0.

A message delivered into a running turn extends that turn, so it inherits its budget window, retry window, and consumer promise. The implementation lives inside the loop gate; a check-then-call version has a time-of-check race against `prompt()`, which throws whenever the gate is held.

Real messages are append-only source content, which makes them:

- cache-friendly (the prefix only extends)
- compaction-safe (they participate in observation like any message)
- persistence-free (they ride the loop's existing history)

Message shape constraints from the audit: user-role, non-whitespace string content, timestamp set. Whitespace-only content is silently dropped at conversion; toolResult-role synthetics merge into adjacent runs and can 400; assistant-role synthetics with error stop reasons get stripped.

### Churn: View Injection Outside BP3

Task headlines and live activity (current tool, duration, token count, last output lines) change every tick and must never enter a transcript or the cached prefix. They use the existing `<background-tasks>` mechanism: view-injected in `transformContext` after the BP3 boundary (`ContextPipeline.injectedSnapshot` in `agent-loop/context-pipeline.ts`), rebuilt every call, carried through compaction turns, never observed, never persisted.

Rules for the headline block, from the audit:

- It stays outside `stableInjectionCount` so BP3 accounting is untouched.
- It is built inside `buildInjectedAndSanitizedContextSnapshot` so token estimation and compaction utilization see it.
- It budgets its own tokens (hard cap); injected user-role content is never trimmed by microcompaction, so an unbounded block would inflate utilization and trigger early source compaction without itself shrinking.

## Log Entry Types

| Entry | Producer | Routed to | Channel |
|---|---|---|---|
| `utterance` | consumer via facade | talker (its prompt), reasoner (silent delta, D18) | real message |
| `reply` | talker | log; reasoner (silent delta, batched with the utterance it answers) | real message |
| `error` / `retrying` | error and retry handlers | talker (retrying: headline; fatal: interrupt delivery) | mixed |
| `directive` | talker control tools | facade router, then reasoner or target sub-agent | real message (steer) |
| `delivery` | reasoner | talker, per wake policy | real message |
| `lifecycle` | facade | log (durable: spawns, completions, cancels, dispatch failures, resolution notes) | none |
| `ask` / `ask_answer` | permission broker | talker / originating resolver | real message / promise settle |
| `lookup_result` | quick-lookup sub-agent | talker (wake) and reasoner (delta at next turn) | real message |

`lookup_result` routing is the shared-context guarantee of decisions.md D13: the reasoner sees everything the talker learned, so context never forks.

**Headlines are not log entries.** The live status block is facade state rebuilt from event-bridge activity and injected per turn; it never appends to the log. Making every headline tick an entry would grow the log at tool-call frequency and bloat the persistence artifact with exactly the churn the two-channel split exists to keep out of durable state. Durable milestones (a task started, finished, was cancelled, or a dispatch failed) are `lifecycle` entries; the moment-to-moment "currently running Grep" is not.

Every entry carries a monotonic sequence number (timestamps collide under burst), and entries produced by a router-initiated run carry the sequence number of the entry that caused it. Causation is not only for observability: D16 uses it to bind consent.

**The cause travels with the content, not in a facade field.** A delivery carries its cause tag from the moment it is parked; the loop surfaces the tags of whatever content the current run actually consumed, set in the same synchronous frame the run takes its batch and cleared in that run's own `finally`. This matters because the obvious implementation, a facade field set when a run is started, silently fails for the most common voice interaction there is: a user answering while the talker is still speaking parks behind the live run, so the field is never set and the resulting turn has an empty chain. It also races, since the field's clear is not synchronized with the loop gate, so a swept run can begin while the previous utterance's stamp still stands. Binding the cause to the content makes both impossible by construction, and as a side effect gives a dispatch parked behind a busy reasoner the directive causation an earlier draft of this document called unbindable.

## Cache Discipline Per Loop

Each loop keeps its own transcript, its own stable session ID (`sessionId` per instance for prefix-cache routing; children use their taskId, `agent-loop/child-loop-config.ts`), and its own cache breakpoints. The composite adds no cross-loop cache coupling:

- Talker prefix: system prompt + slots + compacted history. Deliveries append; headlines stay outside BP3. Target: near-total cache reads per utterance.
- Reasoner prefix: unchanged from today.
- The step-0 mirror rule holds everywhere: mid-loop writes to `agent.state.messages` (including `setSlot`) are clobbered by the next `transformContext` mirror (step 0 of `ContextPipeline.transform`) and never reach pi's loop array. The facade therefore writes slots only between prompts, or uses the per-call re-patch pattern (`ContextPipeline.writeObservationSlot`) if a mid-loop surface ever becomes necessary.

## Compaction Interactions

- Every loop runs its own compaction manager. The talker compacts (infinite conversation is a consumer expectation); both resident loops run observational memory (classic summarization, once a talker tuning option in decisions.md D4, was removed on 2026-10-09).
- **The talker runs a non-blocking compaction posture.** It never waits on a memory call: a swap merges only what is already observed, and the in-band failsafe cuts only the request's view, because a blocking observer call inside `transformContext` is multi-second dead air on the presence loop and would recur at every activation for the whole session. Staggering thresholds between loops does not help the user who is mid-conversation when the talker crosses its own.
- The facade schedules deferred digestion (pending observation buffers, threshold compaction) during idle-signal windows for both loops, and staggers their thresholds so blocking work on the reasoner never coincides with a talker activation.
- The log itself never compacts. Since it is also the persistence artifact, it carries a retention policy, and that policy is now scoped by entry type rather than a flat FIFO. `maxEntries` still bounds the whole log; what it no longer does is decide *which* entries pay for the overflow. `applyRetention` evicts churn first, oldest-first (`lifecycle`, `delivery`, `directive`, `lookup_result`, `retrying`, all produced at machine frequency), and reaches conversational history (`utterance`, `reply`, `ask`, `ask_answer`, plus `error`) only once no churn is left, at which point it degrades to the old oldest-first behavior. `error` sits with the durable set because it is rare enough to crowd out nothing and is what a consumer most needs when reconstructing a failure. An over-cap restore applies the same selection, so the two paths cannot drift. One consequence to know: the retained set is no longer a contiguous seq suffix, so `firstRetainedSeq` bounds it from below but guarantees nothing above, and `subscribeLog` replay announces every hole in the requested range rather than only the leading one.
- Persisted-result breadcrumbs (`[Result persisted: <path>]`) inside delivered content assume a shared filesystem; both resident loops share `workingDirectory` and the persist layout, so a delivered breadcrumb remains resolvable by the reasoner. The talker has no Read tool and simply speaks around them.
