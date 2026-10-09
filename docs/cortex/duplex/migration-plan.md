# Migration Plan

> **STATUS: IN PROGRESS.** Phases 0, 1, 2a, and 2b-i complete. 2b-ii and Phase 3 outstanding.

Four phases, developed on the `duplex-restructure` branch (an exception to the usual commit-to-main rule, given the size of the overhaul). Each phase lands in small conventional commits, keeps the test suite green, and is independently valuable. File:line references are as of 2026-08 and will drift; they identify the sites, not eternal truths.

Items marked **[Rn]** come from the pre-implementation reviews; see review-findings.md for the reasoning.

## Phase 0: Standalone Fixes (complete)

Bugs and gaps worth shipping regardless of duplex. Each item is small, testable, and committable independently.

Landed across 8 implementation commits plus two rounds of review fixes. Two Opus review passes found one blocker (a re-queued delivery duplicated the completion message in history, because pi pushes the prompt message at run start before any model call, so every realistic failure happens after that push) and several should-fix items; all are fixed and recorded in review-findings.md. Suite went 2753 to 2849.

1. **Background-result durability.** `drainPendingBackgroundResults` splices the pending queue before delivering (`agent-loop.ts:4790`); a throw in the delivery loop drops completed work permanently. Re-queue unsent results on failure, with a capped attempt count and dead-letter path so a deterministic failure cannot redeliver forever. **[R17]**
2. **Spawn-path leaks.** Destroy the just-created child when `track()` fails in both foreground (`agent-loop.ts:4587-4599`) and background (`4689-4696`) paths; add a cap pre-check to public `spawnBackgroundSubAgent` (`4301`).
3. **Real sub-agent cancellation.** `cancel(taskId)` on the sub-agent manager: abort, untrack, discard the pending completion. Today `abort()` never touches children and a surviving child's completion replaces the aborted controller and delivers anyway (`917-922`), so nothing can actually cancel work. **[R-F10]**
4. **Abort-raced permission asks.** pi awaits `beforeToolCall` before checking the abort signal (`pi-agent-core/dist/agent-loop.js:372-383`), so a pending ask hangs abort/destroy into the 8s force-kill path. Race the consumer resolver against the loop's abort signal in Cortex's wrapper; return a block on abort. Pass an abort signal into the resolver context so a consumer UI can dismiss a moot prompt. No pi change. **[R17]**
5. **Abort-stub trim.** Trim-and-continue machinery exists but only fires on retry (`retry-policy.ts:86` returns false on abort), so a user abort leaves the aborted assistant stub in history, later rewritten to `(no output)`. Trim it on abort.
6. **Dead config.** Thread or delete `webFetch.maxPerLoop`, `bash.autoYieldThreshold`, `bash.shellPath` (declared in `types.ts:230-241`, never wired by the agent path).
7. **Background child event forwarding.** Enable `forwardFrom` for background children (currently skipped, `agent-loop.ts:4698-4700`). Fixes dead live-activity surfaces (`4498-4501`), background usage undercounting, and is a prerequisite for headlines. Add the missing unsubscribe in the completion continuation (none exists today, so listeners would leak per task) and audit consumer usage summation for double-count. **[R19]**
8. **Escape headline interpolation.** Task instructions, commands, and stdout tails reach `buildBackgroundTaskState` verbatim (`4474-4538`).

`deliver()` was originally P0.3 and has moved to P1; the reviews showed it is a state machine, not a small fix. **[R16]**

## Phase 1: Rename and Loop Hardening (complete)

The breaking-change phase. Split in practice into 1a (rename plus loop identity, mechanical and high-blast-radius) and 1b (the concurrency primitives), each separately reviewed, because a 635-site rename mixed with concurrency changes would bury the interesting parts of the diff.

Three review passes were needed on 1b, and the pattern is worth carrying into Phase 2. Every round found real defects, none of which the suite could reach: they required hand-traced interleavings and purpose-built probes. Two of them were *introduced by the previous round's fix*, both of the same shape, a bound-the-hang change trading a loud failure for a quiet one. The lesson for the facade: when a fix adds a coordination mechanism, review the mechanism, not just the bug it closed.

1. **Rename (done).** `CortexAgent` (class) became `AgentLoop`, and `src/cortex-agent.ts` became `src/agent-loop.ts`. The `CortexAgent` name is now free for the facade (Phase 2). Deprecated aliases (`buildSystemPrompt`, `rebuildSystemPrompt`, `systemPrompt` config) were removed rather than renamed. Actual blast radius: 635 occurrences across 71 files (43 code, 26 docs, 12 in this folder left untouched), and 42 `[CortexAgent]` log prefixes, not the ~90 measured. cortex-code and cortex-sandbox flipped in the same commit. No compat alias was left, so this is an npm major. **[R19]**
2. **`deliver()` primitive (done).** Three outcomes (`prompted`, `parked`, `queued`), decided synchronously inside the loop gate to avoid a time-of-check race against `prompt()`. Wake and silent content both live in loop-owned queues spliced into the next run's batch; pi's steering queue is reserved for the public `steer()` API. Two review passes were needed here: the first mechanism steered into pi's queue and reconciled afterwards, which duplicated already-drained content and destroyed unrelated parked content, because pi's queue cannot be inspected or selectively drained. Also surfaces `followUp()`, queue modes, and queue clears. **[R16, R-F5]**
3. **Loop identity (done).** `AgentLoopConfig.loopPath` (default `'main'`), children derive `${parent.loopPath}/${taskId}`. Threaded through `resolvePermission` (the Phase 0 `ToolPermissionRequestContext` gained `askId` and `loopPath` rather than a fourth parameter), `onError` and `onTurnComplete` (new optional second arg, so 1-arg handlers keep working), `persistResult` metadata, and the watchdog's structured payloads. The logger is wrapped once at construction, so every component logging through it inherits the prefix and the 42 hand-written literals were dropped. `forwardFrom` now prefixes rather than overwrites `childTaskId`, so nested origins survive as paths while direct children keep bare IDs (preserving cortex-code's UI routing).
4. **Long-lived mode (done).** Opt-in `persistentRuntime` (skip `toolRuntime.resetForLoop()` per prompt, `agent-loop.ts:936`); lifetime budget mode (no per-prompt `budgetGuard.reset()`, `940`) plus the plumbing for a facade-level aggregate guard (parent guards currently skip child events, `budget-guard.ts:87-89`).
5. **Steer addressability (done).** Typed child handles (replace `agent: unknown`, `types.ts:1300`); `steerSubAgent(taskId, message)` on the sub-agent manager, built on `deliver()`.
6. **Timeouts, caps, per-spawn overrides (done).** Wall-clock timeout per spawn producing the existing-but-unused `timed_out` status (`types.ts:1281`), treated as a launch blocker; separate concurrency pools for reasoner sub-agents and quick lookups (`sub-agent-manager.ts:41`); per-spawn model/compaction/thinking overrides (`createChildAgent` hardcodes the parent's primary model at `4909`). **[R-F19]**
7. **Ask registry (done).** Facade-queryable pending-ask collection with per-ask nonces, a `voiced` state field, and a mandatory verbatim `renderedRequest` (today: one anonymous nullable slot per tracked child). **[R-F2, R-F14]**
8. **Headline feed API (done).** A small `AgentLoop` surface letting the facade feed the headline block into a loop's `transformContext`; `buildBackgroundTaskState` and its injection point are private and loop-local today. **[R-plan]**
9. **Non-blocking compaction posture (done).** A loop mode that disables the synchronous observer fallback, leaving emergency truncation as the only in-band path (for the talker). **[R-F7]**
10. **Idle-digestion entry point (done).** An `AgentLoop` API to run pending observation buffers and threshold compaction outside a prompt. Correction found during implementation: `checkAndRunCompaction` already provided an outside-prompt L2 path, so the gap was observation specifically, not compaction. Also, in-band L3 is view-only, so digestion's durable work is activation plus L2. **[R2-idle]** *(2026-10-09: classic summarization, L2 and `checkAndRunCompaction` were removed; digestion's durable work is activation and reflection.)*
11. **Usage accounting (done).** Accumulate direct/utility completion usage into per-loop session usage under a category tag and emit a usage event, so the P2 aggregate guard can see observer, reflector, and summarization spend instead of shipping blind. **[R2-B4]**

## Phase 2: The Facade

Split into 2a (skeleton, passthrough-only, the parity checkpoint) and 2b (duplex behaviors), so the plumbing is verified against today's behavior before any duplex behavior exists to confuse the comparison.

### 2a (complete)

Landed the facade class with a compile-checked config routing table, `SessionLog` (monotonic seq, causation stamps, bounded replayable subscriptions, ring-buffer retention with spill), v2 composite persistence (baseline-plus-delta usage with a per-loop breakdown, restore-while-running rejection, v1 and bare-array upgrade paths, debounced `onStateChanged` snapshotting only at gate quiescence), settlement predicates over gate depth, and a side-by-side parity suite driving `AgentLoop` and the facade over identical mock loops. `mode: 'duplex'` throws rather than silently degrading. Suite 2954 to 3035.

Two mechanism deviations are recorded as footnotes in facade-api.md; both resolve in 2b. Causation stamps bound exactly for facade-initiated runs and were deliberately absent (rather than guessed) for runs the facade did not start. 2b-i replaced that scheme: the cause now travels with the delivered content, which closed a blocker where a barge-in utterance produced a turn with no chain at all, and extended binding to runs the facade does not start. See log-and-context.md.

### 2b-i (complete)

Duplex assembly: the talker loop (no permission resolver, no network resolver, all built-ins disabled, spawn-incapable, hard `maxTurns` consumer config cannot raise, fail-fast retries, forced non-blocking compaction staggered under the reasoner, its own session id and `loopPath`), the aggregate budget guard on the merged bridge from first duplex assembly, the router (wake policy, backpressure, delegation registry with friendly aliases, delta buffer, liveness watchdog), the control toolset with structurally-enforced D17 terminate guards, the `Deliver` and `SteerSubAgent` reasoner tools, conversation deltas, and both role prompts. Suite 3057 to 3139.

Settled during implementation: the duplex reasoner defaults to `persistentRuntime: true` (an explicit consumer `false` still wins), since the reasoner is session-lifetime by design; the aggregate guard aggregates `maxCost` only, because turn counts across two loops plus children have no comparable composite meaning and a lifetime turn aggregate would silently cap session length; and with no consumer idle signal the lull defaults to talker-gate-idle rather than waiting out the degrade delay, which would otherwise add that delay to every final result in the default config.

### 2b-ii (outstanding)

The remaining duplex behavior.

**Three items 2b-ii owns.** The first is a D6 gap found in 2b-i; the other two were deferred from earlier review rounds because 2b's design supersedes the obvious standalone fix.

- **Slot writes must fan out.** 2b-i wires initial slots to both loops but `getContextManager()` returns the reasoner's manager, so a mid-session slot write silently diverges them. The facade returns a fan-out view: writes to both, reads from the reasoner. No per-slot routing knob (D6).

- **Where destroyed wake content is recorded.** Three sites destroy parked wake deliveries with only a log line: epoch-gated abort-window drops, sweep attempt-cap and elapsed-budget drops, and repark-cap drops. The standalone fix is a loop-level dead-letter surface mirroring `getDeadLetteredBackgroundResults`, which is new public `AgentLoop` API plus delegation routing plus facade forwarding. In duplex the router owns delivery and the session log is the durable record of undelivered content, which is exactly the abort-table row "retained in the log, not delivered", so 2b must make the log cover all three sites. If it does not, the fallback shape is a bounded record of `{content, timestamp, attempts, reason}` at each site, surfaced as `getDeadLetteredWakeDeliveries` plus an `onWakeDeliveryDeadLettered` handler and a `delivery_dead_lettered` lifecycle entry. Pre-existing rather than a regression, per the mechanism review.
- **Discarded compaction passes still fire consumer events.** A pass abandoned by the digestion timeout still emits compaction and observation events from inside `CompactionManager`, before the loop knows the pass went stale, so a consumer sees a compaction reported for a rewrite that never landed. Suppressing it means threading staleness into the manager's and the observational engine's dispatch, and 2b's facade-level callback fan-in with origin context touches those same dispatch points. Bounded harm meanwhile: the reported state genuinely did not change, so a persistence trigger firing on it still saves a correct snapshot.

1. Facade class: talker + persistent reasoner, mode routing, the completed config routing table (facade-api.md), per-loop session IDs, staggered compaction thresholds, talker constructed with no `resolvePermission` and a facade-set hard `maxTurns`, **and the aggregate budget guard active from the first assembly** (moved up from P3: duplex must never run with per-prompt budgets as its only bound). **[R-F1, R-F3]**
2. The session log: entry types (including `error`/`retrying`; headlines are facade state, not entries), monotonic sequence numbers and `causedBy` causation stamps (load-bearing for D16 consent, so not deferrable), snapshot `getLog(fromSeq)` and replayable subscription with a bounded buffer, append-then-emit ordering, retention/ring-buffer policy, versioned composite persistence (v2; per-loop usage breakdown; baseline-plus-delta restore; restore-while-running rejection; v1 upgrade path), and the `onStateChanged` persistence trigger with atomic snapshotting. **[R-F8, R2-B1/B2/B3/B5]**
3. Router: wake policy (`interrupt` / `when_idle` / `silent` with producer-proposes/router-disposes), a **facade-owned silent queue** flushed into the next prompt (never pi's steering queue, which drains after terminated batches and would speak the content unprompted), advisory idle signal with facade-enforced minimum spacing, aggregate budget guard, and backpressure per D19 (interrupt token bucket, content-hash dedup, per-turn and per-exchange delegation caps, dispatch dedup on `(loopPath, turnIndex, toolName, argsHash)`). Also the facade settlement predicates (`conversationIdle`, `workSettled`), built on gate depth and awaitable, since P3's tests cannot be written without them. **[R-F13, R2-A1, R2-B6]**
4. Control toolset on the talker: `spawn_task`, `steer_task`, `cancel_task`, `answer_ask`, `quick_lookup`; local dispatch into the router; **every outcome returns `{content, terminate: true}` as a bare receipt, and control tools never throw or return `isError`** (D17); required result shape asserted by testing that the batch terminates. Plus the two D17 terminate-suppression guards (empty spoken text, `maxTokens` truncation with no dispatched call), the talker constructed with no permission resolver, and control tools exempted from the working-tags reminder wrapper. Failed dispatch produces a voiceable lifecycle entry. **[R-F9, R2-A2/A3/A4/A6]**
5. Headlines: generalize `buildBackgroundTaskState` (`agent-loop.ts:4474-4538`) into the facade-fed, hard-capped status block with aliases and `as_of` timestamps, injected outside BP3 for the talker.
6. Permission broker end-to-end (communication.md): D16 consent binding in the router, verbatim `renderedRequest`, one-voiced-at-a-time, escalation-class timeouts, `resolveNetworkAccess` and the sandbox ask callback routed through the same pipeline, passthrough bypass. **[R-F2, R-F14]**
7. `Deliver` tool for the reasoner (`{content, wake}`), implicit `when_idle` delivery from final assistant text, and the liveness watchdog for long silent runs. `SteerSubAgent` tool; no steer fast-path (D20). **[R-F1, R-F11]**
8. Quick lookups: `quick_lookup` control tool, ephemeral spawns with an in-tool path allowlist rooted at `workingDirectory` and inherited sandbox, results wake the talker and route to the reasoner via the log. **[R-F12]**
9. MCP multiplexer and skill registration fan-out (single-slot callback fields become listener arrays; one stdio subprocess per server total).
10. Sanitized talker delta stream for TTS: holdback buffering across chunk boundaries, emitted as a defined event. **[R-F6]**
11. Talker role prompt: presence, grounding rules (never state facts absent from headlines/deliveries, never invent outcomes of unfinished work, correct yourself when a later delivery contradicts what you said), verbatim reading of destructive and escalation asks, honest staleness phrasing from `as_of`, routing context-dependent questions to the reasoner rather than to a lookup.
12. Reasoner prompt: background long commands, delegate long parallelizable work, deliver with appropriate wake classes; conversation deltas arrive wrapped as context-only and never as instruction (D18).

## Phase 3: Validation and Default Flip

**What the test suite structurally cannot see**, established while building the scenario suites. This list is the honest boundary of "green" and should be read before the default flip:

- **Model compliance, everywhere.** The suites prove the system hands the talker nothing to hallucinate from and that the rules are present in the role prompt. Whether a fast-tier model obeys grounding under user pressure, speaks before calling a control tool (the reason D17's guards exist), or truncates mid-tool-call in practice, are all unmeasurable without a live provider.
- **Compaction and observational quality.** Retention and transcript shape across a compaction boundary are testable; whether the distilled understanding is any good is a model question.
- **Real tool execution inside children.** Sub-agents and lookups run scripted, so F12's path allowlist is covered at the config and tool layers rather than by a child actually attempting an escape.
- **Latency.** Live-provider work by nature.

A green suite therefore means the mechanisms are right and the wiring is right. It does not mean the conversation is good, and the default flip should rest on a real session as well as on the suite.

**What Phase 3 actually found**, since a phase that reports "no defects" invites the question of whether it looked. It closed a seam where config correctness and behavior correctness were two green claims with nothing crossing between them, and running the real `CortexAgent.create()` path found no assembly defect: the talker's hard turn cap, its role prompt, and the brokered resolver are now proven live rather than computed. It fixed a parity check of mine that had been failing roughly one run in three on embedded timestamps, which could only manufacture false failures but was well on its way to being ignored. It found consumer-relayed content arriving unfenced on both surfaces. It found that a discard is a trio of checks rather than a pair, and that one of the three is untestable in isolation. And it found that a configured `contextWindowLimit` below the safe floor is silently raised on any model, with no coverage of effective-window behavior anywhere in the suite, which is why it went unnoticed.

The pattern across every phase is worth naming: the defects were never in the checks, they were in what the checks were attached to. Content drifting from the run that carried it, a stamp living in a field rather than on the thing it described, a cache boundary drifting from the content it bounded, a consent tag minted by a surface that could not vouch for it. Where the next one lives is probably the same kind of place.

**Consumer migration checklist**, from the 2a verification pass. The facade is not a drop-in replacement for `AgentLoop`; `AGENT_LOOP_DELEGATION` in `src/facade/loop-delegation.ts` is the authoritative disposition source, and these are the three places a real migration breaks:

- `packages/cortex-code/src/session.ts:1948-1963` calls all three subsumed `restore*` methods on a bare `AgentLoop`. This is a call-site rewrite into a single `restore()`, not a rename, because `restore()` is all-or-nothing and rejects while running.
- There is no facade route to parked-wake content dropped by `abort()` or `restore()`. `clearAllQueues()` returns that content for re-routing and both facade call sites discard it. Either forward it or surface the dropped content on the abort log entry (this overlaps the wake dead-letter item in 2b's scope).
- Facade `abort()` clears queues that a direct `AgentLoop.abort()` retains. Intended per the abort table, documented in facade-api.md, and pinned by a parity test that asserts the divergence rather than papering over it. A consumer relying on `steer()` content surviving an abort must re-issue after migrating.

1. Scenario integration tests, each run in both modes:
   - coding session with mid-work questions and a quick lookup
   - deep research with a mid-flight redirect (parent-to-child steer)
   - iterative design against the persistent reasoner
   - permission brokering through conversation (including timeout and abort paths)
   - passthrough parity, measured against the **post-P0/P1 baseline**, not against today (P0.5 and the P1 signature additions change behavior legitimately) **[R-plan]**
2. Terminated-batch transcript shape (build this first; nothing in the codebase sets `terminate` today, so the path is entirely unexercised and becomes the talker's steady state): talker dispatches, run ends on a `toolResult`, the next utterance prompts cleanly, cache-breakpoint simulation handles history ending on a toolResult, restore round-trips, and microcompaction trimming a control-tool result does not orphan its tool call. **[R2-A5]**
3. Adversarial scenario tests: **[red-team]**
   - persuasion attempt against a live pending ask via planted content in a delivery
   - two-pending-ask mis-binding under a bare "yes"
   - injected `cancel_task`/`steer_task` using an alias harvested from headlines
   - control-tool error loop, asserting bounded turns
   - retry-induced double dispatch
   - cancel-during-completion, abort-during-drain, user-speaks-during-interrupt-turn
   - grounding held under repeated user pressure ("just tell me what it found so far")
4. Latency measurement harness: talker TTFT (warm and cold-cache), control-tool dispatch latency, delivery-to-voiced latency, and a talker-prefix size guardrail.
5. Docs sync (this folder moves from DESIGN to IMPLEMENTED status; consumer-guide.md updated).
6. Duplex ships as the default with `mode: 'passthrough'` as the opt-out (decisions.md D14).

## Out of Scope for Launch

- Resumable/persistent sub-agent state (tasks re-derive from the log).
- Parent-to-child steering below tier 2 (sub-agents cannot spawn, so there is no tier 4 to steer).
- Cross-loop shared MCP tool state beyond connection multiplexing.
- Upstream pi-agent-core changes of any kind. The abort-check-before-`beforeToolCall` nicety may be proposed upstream later; Cortex does not depend on it.
