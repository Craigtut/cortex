# Observational memory hardening plan

**Status**: Design for review (stage 1). Nothing here is implemented.
**Date**: 2026-10-08
**Scope**: Cortex (`packages/cortex`) and Cortex Code (`packages/cortex-code`).
**Related**: [observational-memory-architecture.md](./observational-memory-architecture.md), [compaction-strategy.md](./compaction-strategy.md), [context-manager.md](./context-manager.md), [cortex-agent.md](./cortex-agent.md), [duplex/](./duplex/), [pi-upgrade-1.x.md](./pi-upgrade-1.x.md)

Every claim about current behavior cites the code it was read from. Line numbers are as of commit `b290e32`. Claims marked **reproduced** were confirmed with a scratch Vitest file run against the current source (kept outside the repo, not committed); the result is quoted.

---

## Summary

Observational memory (OM) loses memory today in five reproducible ways, throws out of `transformContext` in three places, and removes the user's latest message when it swaps synchronously. The design fixes those first, then adds the verbatim tail, a bounded failure policy, an explicit `compactNow()`, and finally deletes the classic strategy.

The structural change underneath all four items: observation chunks carry the message range they cover, so every swap can be planned as "remove exactly these observed messages, keep exactly these" instead of "remove everything up to the watermark". That one change is what makes the tail, partial swaps on failure, in-flight observers surviving a swap, and the emergency path all expressible without losing or re-observing a message.

---

## Leads checked against the code

| Lead | Verdict |
| --- | --- |
| `CompleteFn` lives in `compaction/compaction.ts` and every OM module imports it | True: `observational/index.ts:19`, `observer.ts:14`, `reflector.ts:14`, `buffering.ts:18`. Two more OM-to-classic dependencies the lead missed: L1's prefix-cache gate reads the L2 constant `COMPACTION_DEFAULTS.threshold` (`compaction/index.ts:389-392`), and the duplex talker config imports `COMPACTION_DEFAULTS` to stagger the classic threshold (`duplex/assembly.ts:13,153,161-165`). |
| Only classic resets `_currentContextTokenCount`; an OM swap leaves it stale | **Reproduced, and worse than stated.** After an idle-digestion swap the count stays at the pre-swap 19,500 of a 20,000 budget (`estimateCurrentContextTokens()` also returns 19,500 because it takes the max, `compaction/index.ts:485-490`). The next `transformContext` re-activates: a second observer call runs and the two freshest messages, including the latest user message, are removed. The same staleness follows an in-band swap whose LLM call then fails, since a failed turn reports zero input tokens and the count is only updated when positive (`event-wiring.ts:116-122`). |
| `checkAndRunCompaction` runs the classic summary under OM and desyncs the watermark | **Reproduced.** With a chunk covering 8 messages, it rewrote history to a summary plus 6 preserved messages (7 total) and left the watermark at 8; the next activation removed all 7, including a message no observer ever saw. It has no strategy check (`compaction/index.ts:1155-1235`) and the primary-model summarizer is wired regardless of strategy (`agent-loop/assembly.ts:452-453`). It is reachable today: Cortex Code's `/model` "Run /compact first" option calls it under the default OM strategy (`cortex-code/src/commands/model.ts:323`). |
| OM silently falls back to classic when source accessors are missing (`compaction/index.ts` ~902) | True structurally (`compaction/index.ts:905`), but the classic branch it lands in cannot summarize without the same accessors (`:959-960`), so the effective fallback is L1 plus view-only L3 and no memory at all. The only production caller always passes both accessors (`agent-loop/context-pipeline.ts:219-257`); only tests reach the fallback. |
| About 45 test references use `'classic'` as a shortcut | Overstated. `'classic'` appears 32 times in 19 test files (49 lines across 23 files mention "classic" at all, including `describe` names). Some are shortcuts to avoid the `_observations` slot (for example `tests/unit/tools/tool-search.test.ts:327`); others test classic itself (`agent-loop-idle-digestion.test.ts`, `compaction/non-blocking.test.ts`, `ollama-agent.test.ts:85-90`), and several classic test files never use the string (`compaction/compaction.test.ts`, `adaptive-threshold.test.ts`, `circuit-breaker.test.ts`). |
| Cortex Code call sites | True, plus ones the lead missed: `/model`'s compact-first (`commands/model.ts:323`), the TUI footer flag (`tui/status.ts:25,126,331-332`), the CLI entry (`index.ts:168`), and the crash checkpoint, which drops OM state entirely whenever an observer is in flight (`persistence/session-checkpoints.ts:174-188`) on the premise that a chunk can land between two reads that are in fact one synchronous frame. |
| An empty reflector reply passes `validateCompression` and replaces the whole log | **Reproduced** for the sync path (`reflector.ts:131`, `estimateTokens('')` is 0 at `token-estimator.ts:23-26`, then `observational/index.ts:858`). Also reproduced for the async path: an empty buffered reflection is stored (`buffering.ts:314`) and swapped in (`observational/index.ts:816`). Also reproduced for the observer: an empty reply becomes a chunk and advances the watermark (`buffering.ts:187-201`), so activation removes messages that produced no observation. |
| The sync observer (~276) and sync reflector (~852) are uncaught | True, and the observer case loses memory: **reproduced**. Step 1 consumes the chunks and removes their messages (`observational/index.ts:247-248`) while their text sits only in a local variable; when Step 2's observer then throws, that text is gone. A third uncaught call is the pre-truncation `triggerObservation` (`compaction/index.ts:1083`). |

---

## How it works today

### Where OM runs

pi calls `transformContext` before every provider request (`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:263-264`); its contract says the hook "must not throw or reject" (`pi-agent-core/dist/types.d.ts:190-191`). If it does, pi turns the throw into a failed run with a synthetic error message (`pi-agent-core/dist/agent.js:354-377`), which Cortex classifies and may retry (`agent-loop/turn-runner.ts:332-338`). Cortex wires pi's hook to `ContextPipeline.hook()` and drops pi's abort signal on the floor (`agent-loop/pi-hooks.ts:164`).

The pipeline (`agent-loop/context-pipeline.ts:188-284`):

1. Caps oversized tool results in the source array (`:200-206`).
2. Builds the view: injections (ephemeral, skills, background tasks, headline) at the history boundary, then placeholder sanitization (`:211-212`, `:304-332`).
3. Calls `CompactionManager.applyInTransformContext` with a view getter and setter and a source getter and setter (`:219-257`).
4. Writes the observation slot and patches it into the view (`:260-272`), then computes cache breakpoints (`:276-280`).

`CompactionManager.applyInTransformContext` (`compaction/index.ts:856-1137`) estimates utilization as the max of the last post-hoc input count and a chars/4 heuristic (`:883-897`), runs OM (`:905-913`), runs L1 on the post-OM view (`:916-927`), then L3 (`:1065-1134`).

### Source history and view history

The source is pi's in-loop message array, which the pipeline mutates in place and mirrors to `agent.state.messages` (`context-pipeline.ts:192`, `:234-250`). The view is the array returned to pi for this one request. Every OM rewrite goes through `setSourceHistory`, which splices the source, mirrors it, and recomputes the turn boundary assuming the current tick stays a contiguous suffix (`:240-249`). A rewrite from an abandoned digestion pass is discarded (`:235-239`). L1 and L3 change only the view.

### Buffering and the watermark

`BufferingCoordinator` holds completed chunks, one watermark, at most one in-flight observer, at most one in-flight reflector, one buffered reflection, and an activation epoch (`observational/buffering.ts:45-61`). A chunk records its text, hints, token count and creation time, but not which messages it covers (`observational/types.ts:183-198`). The watermark is the end index of the last landed chunk, so chunks implicitly cover `[0, watermark)` of post-slot history.

At each parent `turn_end` (`event-wiring.ts:97-131`), `onTurnEnd` computes a dynamic interval (`observational/index.ts:395-400`) and, if the unobserved tokens after the watermark exceed it and no observer is in flight, snapshots **all** unobserved messages with no size cap (`:417`) and launches an observer (`:420-427`). It returns early once utilization is past the activation threshold (`:393`). When the observer lands, its chunk is pushed and the watermark moves to its end index (`buffering.ts:187-201`), unless the epoch changed since launch, in which case the result is discarded (`:181-185`). A failed observer is logged and forgotten (`:205-212`).

### Activation, chunk path

At utilization ≥ `activationThreshold` (default 0.9, `observational/constants.ts:31`), Step 1 merges every completed chunk, removes `source[0, watermark)` and resets the buffer: chunks cleared, watermark 0, epoch advanced (`observational/index.ts:233-249`, `buffering.ts:240-244`). Advancing the epoch discards whatever observer is in flight, so its messages are observed again later.

### Activation, synchronous observer path

If the heuristic says utilization is still ≥ threshold after Step 1 and blocking is allowed, Step 2 runs the observer on everything left in source, appends the result, calls `setSourceHistory([])`, sets the watermark to 0 and advances the epoch (`observational/index.ts:269-304`). It keeps nothing. In pi's loop the new prompt is already in the source when the first `transformContext` runs, so this removes the user's latest message. **Reproduced**: a sync activation over `[big user, big assistant, 'tail q']` left an empty history.

Step 3 appends the new text to the log (`:307-315`), Step 4 fires `onObservation` unless the pass is stale (`:322-330`), Step 5 handles reflection (`:333`), and Steps 6 and 7 rebuild the slot and a view built from source, so view injections vanish on activation turns (`:338-363`, documented in `duplex/log-and-context.md:18`).

### Reflection

`handleReflection` (`observational/index.ts:789-889`) compares the log's tokens to `min(contextWindow × 0.20, utilityWindow × 0.5)` (`reflector.ts:153-162`). At the threshold it swaps in a buffered reflection if one exists (`:813-833`), otherwise launches one async under the non-blocking posture (`:839-849`) or runs it inline (`:852-871`). Between 50% and 100% of the threshold it launches an async reflector (`:874-888`). `runReflector` escalates compression levels 0 to 4 and returns the last result even when it never validated (`reflector.ts:189-221`).

The buffered reflection is a reflection of the log as it was when the reflector launched (`buffering.ts:299-325`), but it is swapped in as the whole log (`observational/index.ts:816`). **Reproduced**: a reflection launched after activation 1 landed, activation 2 appended new observations, the threshold forced the buffered swap, and the activation-2 observations were gone.

### Idle digestion

Only the duplex facade schedules it, 10 s after a run completes (`duplex/session-parts.ts:103-111`), for the talker and then for the reasoner when it has no active sub-agents (`duplex/idle-digestion.ts:67-100`). Passthrough, which is Cortex Code's default (`cortex-code/src/config/config.ts:159-165`), never digests. `digest()` holds the loop gate (`context-pipeline.ts:346-381`): phase 1 waits for the in-flight observer and observes the whole unobserved tail as one chunk (`observational/index.ts:457-506`); phase 2 runs the transform hook with blocking forced on, under a timeout and a preemption signal, and invalidates the pass by bumping a generation counter if it does not settle (`context-pipeline.ts:388-426`).

### Persistence and restore

`getState()` returns the log, hint, counts, chunks and watermark (`observational/index.ts:619-629`). `restoreState` sets them, discards chunks from sessions saved without a watermark, and clamps the watermark to the restored history (`:653-675`). It does not touch an in-flight observer or reflector or a buffered reflection (`buffering.ts:374-377`), so work from the replaced session can land in the restored one. The facade restores history before memory and skips memory when the artifact carries none (`facade/composite-state.ts:90-94`, `duplex/session.ts:382-387`), which leaves the previous session's log, chunks and watermark paired with the restored history.

### Talker, reasoner, sub-agents

| Loop | Compaction posture | Source |
| --- | --- | --- |
| Reasoner (duplex) or the single loop (passthrough) | Consumer config; blocking by default | `facade/config.ts`, `duplex/assembly.ts:105-123` |
| Talker | `nonBlocking: true`, activation staggered 0.05 below the reasoner's, classic threshold staggered too | `duplex/assembly.ts:144-167` |
| Sub-agents | Default compaction (OM, blocking) unless the spawn passes `compaction`; inherits `contextWindowLimit` | `agent-loop/child-loop-config.ts:132,140-142` |
| Quick lookups | Default compaction; short-lived | `duplex/assembly.ts:284-322` |

Under `nonBlocking`, Step 2 and inline reflection are skipped and so is the pre-L3 catch-up observation (`compaction/index.ts:872`, `:1076-1081`). Because `onTurnEnd` stops buffering past the threshold (`observational/index.ts:393`), a talker that stays above its threshold produces no new chunks until idle digestion runs. Sub-agent loops are not persisted and their callback events do not reach the parent; only their event-bridge events are forwarded (`agent-loop/sub-agent-spawner.ts:123-126`, `event-bridge.ts:283-292`).

### L1 and L3 around OM

L1 runs on the post-swap view only when the cache is cold, or, for automatic-prefix providers, above `COMPACTION_DEFAULTS.threshold` (0.70) (`compaction/index.ts:389-392`, `:920-927`). Its hot zone protects the last 16K tokens or 5% (`types.ts:1065-1077`).

L3 fires at `failsafe.threshold` (0.9) of the model's capacity (`compaction/index.ts:1066-1070`, `failsafe.ts:34`). With no `contextWindowLimit`, the effective window equals capacity (`context-budget.ts:24`), so L3 and OM activation share the same 90% line: when an activation fails to shrink the context, L3 fires in the same call. Under blocking OM it first calls `triggerObservation` over the whole source (`compaction/index.ts:1076-1084`), which re-observes already-buffered messages and appends duplicates without moving the watermark. The truncation itself only changes the view (`:1086-1092`, `:1136`) and keeps the last 3 messages (`failsafe.ts:41`). Because the source keeps everything, in-band L3 loses no memory: buffering still reads the full source (`event-wiring.ts:127`).

The reactive path is different. When the provider rejects a request for overflow, the turn runner calls `handleOverflowError` (`turn-runner.ts:355-357`), which truncates the **source** through the public `restoreConversationHistory` (`agent-loop/assembly.ts:347-350`, `compaction/index.ts:1248-1274`), shifts the watermark down, keeps chunk text, and silently drops any unobserved messages it removed. `context_overflow` is not a retryable category (`retry-policy.ts:20`), so that turn still fails.

### Token tracking

`_currentContextTokenCount` is the last parent call's input, set on `turn_end` when positive (`event-wiring.ts:116-122`, `compaction/index.ts:428-444`). Classic resets it after a rewrite (`:1007`, `:1197`, `:1231`, `:1273`); OM never does.

### Events and error reporting

| Event | Fires for | Source |
| --- | --- | --- |
| `onObservation` | OM activation, `triggerObservation` (which reports the whole history as "compacted" though nothing left context) | `observational/index.ts:322-330`, `:603-609` |
| `onReflection` | Sync or buffered reflection | `:824-831`, `:862-870` |
| `onBeforeCompaction`, `onPostCompaction`, `onCompactionError` | Classic L2 only, including `checkAndRunCompaction` under OM | `compaction/index.ts:972-990`, `:1181-1191` |
| `onCompactionDegraded`, `onCompactionExhausted` | Only after an L2 failure, so never under OM | `:1095-1133` |
| `onError` | Every failed utility completion, including observer and reflector calls | `agent-loop/direct-completion.ts:203-225` |

The last row matters in Cortex Code: an observer 529 lands in the general `onError` handler, which drives the main retry status line to "failed" for a turn that is fine and marks the turn's error as already shown (`cortex-code/src/session/agent-events.ts:124-175`, `session/turn-runner.ts:63-65,126`).

### Cortex Code integration

- `--compaction observational|classic` (`cli-args.ts:13,44-52,95`, `index.ts:168`) flows through `Session` (`session.ts:88,117,157,218,228,633,655`) into `compaction.strategy` (`session/agent-config.ts:28,64`).
- `/compact` calls `triggerObservation` under OM and `checkAndRunCompaction` under classic (`commands/compact.ts:11-49`). `/model` calls `checkAndRunCompaction` for "Run /compact first" (`commands/model.ts:323`). `/debug` is gated on the strategy (`commands/debug.ts:20`).
- The footer's memory segment is gated on `observationalMode` (`session/status-view.ts:128,161-172`, `tui/status.ts:331-332`).
- Checkpoints record the strategy in `meta.json` and omit OM state while an observer or reflector is in flight (`persistence/session-checkpoints.ts:174-188,239,276-278`); meta parsing keeps the field only when it is one of the two known values (`persistence/sessions.ts:91-93`).
- `onPostCompaction` writes the durable transcript's compaction marker (`session/agent-events.ts:196-211`), which never fires under OM; degraded and exhausted notices (`:220-233`) never fire under OM either.

### Defects found

| # | Defect | Evidence |
| --- | --- | --- |
| D1 | Sync observer failure after chunk activation loses the chunk text | Reproduced; `observational/index.ts:236-248,276` |
| D2 | Empty reflector reply (sync or buffered) wipes the log | Reproduced; `reflector.ts:131`, `buffering.ts:314`, `observational/index.ts:816,858` |
| D3 | Empty observer reply becomes a chunk; its messages are removed with no observation | Reproduced; `buffering.ts:187-201` |
| D4 | A buffered reflection overwrites observations appended after it launched | Reproduced; `buffering.ts:299-325`, `observational/index.ts:816` |
| D5 | Stale token count after a swap re-activates and removes the freshest messages | Reproduced; `event-wiring.ts:120`, `compaction/index.ts:485-490` |
| D6 | `checkAndRunCompaction` under OM desyncs the watermark and loses unobserved messages; reachable from `/model` | Reproduced; `compaction/index.ts:1155-1235`, `commands/model.ts:323` |
| D7 | Sync swap removes the latest user message | Reproduced; `observational/index.ts:299` |
| D8 | Three uncaught calls inside `transformContext` | `observational/index.ts:276,852`, `compaction/index.ts:1083` |
| D9 | Restore lets the replaced session's in-flight observer, reflector or buffered reflection land; restore with no memory keeps the old log and watermark | `buffering.ts:374-377`, `facade/composite-state.ts:91-93`, `duplex/session.ts:384-386` |
| D10 | Activation discards the in-flight observer, so its messages are observed twice (two calls, one recorded) | `buffering.ts:181-185,243` |
| D11 | `triggerObservation` re-observes all history and is not gated against a running turn | `observational/index.ts:576-591`, `agent-loop.ts:439-444` |
| D12 | Observer input is unbounded (`onTurnEnd` and digestion snapshot every unobserved message) | `observational/index.ts:417,490` |
| D13 | Past the threshold, buffering stops; a non-blocking loop stalls until idle digestion | `observational/index.ts:393` |
| D14 | OM failures reach the general `onError`, confusing Cortex Code's retry line | `direct-completion.ts:214-225`, `cortex-code/src/session/agent-events.ts:124-145` |
| D15 | Cortex Code's crash checkpoint drops all OM state while an observer is in flight | `cortex-code/src/persistence/session-checkpoints.ts:174-188` |
| D16 | In-band observer calls ignore pi's abort signal, so Escape waits for the observer | `agent-loop/pi-hooks.ts:164` |

---

## Design

### Invariants

Every rule below exists to keep these true. Tests assert them directly, including a randomized property test over transcripts, chunk landings and swaps.

- **I1, no loss.** A message leaves source history only if its content is already in the log, or the emergency path records a gap note that names it.
- **I2, no re-observation.** Every observer call covers a range that starts at the watermark when it launches; ranges never overlap; each chunk's text is merged into the log at most once.
- **I3, structure.** No rewrite splits a tool-call group (`compaction/tool-call-groups.ts:57-81`), and kept history never starts with a tool result.
- **I4, latest input.** The latest user message is never removed by a swap.
- **I5, never throw.** `transformContext` resolves for every input.
- **I6, fresh accounting.** After any source rewrite, nothing uses a token count measured before it.

### Ownership after the change

| Owner | Owns | Change |
| --- | --- | --- |
| `observational/ledger.ts` (new) | Which messages are observed: the observed-and-kept prefix, chunk ranges, the watermark, rebasing them under every rewrite, (de)serialization | Replaces the chunk and watermark fields of `BufferingCoordinator` |
| `observational/tail.ts` (new) | Pure tail selection | New |
| `observational/calls.ts` (new) | One observer or reflector call: timeout, abort, quick retries, reply validation | New; wraps `runObserver`/`runReflector` |
| `observational/buffering.ts` | Lifecycle of the tracked in-flight observer and reflector, each with a token instead of a shared epoch | Slimmed |
| `observational/health.ts` (new) | Healthy or degraded, consecutive failures, memory events | New |
| `observational/index.ts` (engine) | Orchestration: activation, `onTurnEnd`, digestion, `observeNow`, `compactNow`, reflection, emergency planning | Under 800 lines after extraction |
| `CompactionManager` | L1, L3, insertion cap, the context-size count and its invalidation, the never-throw boundary | Classic removed (1,340 lines today, `compaction/index.ts`) |
| `ContextPipeline` | The single source writer (stale-guarded, boundary-adjusting), gated `compactNow`/`observeNow` entry points, pi's abort signal | Small additions |

The pipeline's source writer becomes the only way history is rewritten. `handleOverflowError` stops using the public `restoreConversationHistory` (`agent-loop/assembly.ts:347-350`), which the design changes to reset OM state (D9 fix).

### 1. Verbatim tail on swap

#### Tail selection

`selectTail(history, budget)` walks back from the end of post-slot source history in units, where a unit is a tool-call group or a single message:

- The budget is `min(tailRatio × effectiveWindow, tailMaxTokens)` with defaults `0.2` and `64_000`. The effective window is the manager's `contextWindow`, so `contextWindowLimit` applies (`agent-loop/model-settings.ts:212-217`).
- The last unit is always kept whatever its size. Then units are added while the running total stays within budget. Tokens use the same `estimateTokens(extractTextContent(m))` as L3.
- `T` is the start index of the earliest kept unit.
- `U` is the index of the latest message with role `user` that is neither a system message nor a tool result (`isToolResultMessage`, `compaction/microcompaction.ts:198-208`). Deliveries and steers are user-role turns, so in the talker `U` can be a delivered result and in the reasoner it is the latest dispatch. That is the input the loop's current activity answers, which is what continuity needs.

#### The ledger

Post-slot indices `0..N`:

- `P`, the observed-and-kept prefix: messages `[0, P)` are in the log and still in history. Today this is always 0; the tail makes it real.
- Chunks `c1..ck` cover contiguous ranges `[P, e1), [e1, e2) ... [e(k-1), ek)`. Each chunk stores `endIndex`.
- The watermark `W` is `ek`, or `P` with no chunks. `onTurnEnd` and digestion observe from `W`, as today.
- The tracked in-flight observer covers `[W, F)` and has a token.

Every source rewrite reports to the ledger: a swap (prefix removal plus at most one kept message), a front drop (emergency), a tail trim (failure stubs, `agent-loop/assembly.ts:158-164`). The ledger shifts `P`, chunk ends, `W` and `F` accordingly, so an in-flight observer survives a swap and lands at its shifted range instead of being discarded (D10). It is invalidated, by token, only when its range cannot be mapped: a restore, or an emergency drop that intersects it.

#### The swap plan

Given `T`, `U`, the ledger, and whether blocking work is allowed:

1. **Catch up** (blocking posture, health permitting, and only when cutting at `W` would leave utilization ≥ threshold): wait for the tracked observer, then observe `[W, T)` in pieces. Each piece ends at a unit boundary and stays within the effective buffer cap (`buffering.ts:89-92`); tool results are bookended for the observer so a single unit always fits the utility model (D12). Each successful piece becomes a chunk and moves `W`. All of this is bounded by the in-band budget (below).
2. **Cut** `cut = unitFloor(min(T, W))`. If nothing new would leave history, stop: no swap, no churn.
3. **Merge** into the log, in order, every chunk whose range starts before `cut`, with the latest of their hints. A chunk that straddles `cut` is merged whole; its messages at or after `cut` stay in history as observed-and-kept.
4. **Remove** `R = [0, cut)` minus `U` when `U < cut`. Kept history is `[m(U)]` (when `U < cut`) followed by `m[cut..N)`.
5. **Rebase** with `k = 1` if `U` was kept separately, else 0: `P' = k + max(0, max(E, P) − cut)` where `E` is the end of the last merged chunk; remaining chunks and the in-flight range shift by `−(cut − k)`.

Why this satisfies the invariants: every removed index is below `W` at apply time (I1); `U < cut ≤ W` means a kept `U` is already observed, so the kept observed messages form a contiguous prefix of the new history and `P'` describes them exactly (I2); `cut`, `T` and `U` are all unit boundaries (I3); `U` is never in `R` (I4).

Chunks lying wholly inside the tail stay buffered rather than merged. Merging them would grow the log without removing anything and push utilization up at exactly the moment the swap is trying to bring it down. The straddling chunk is the only duplication, bounded by one buffer cap.

When `U` is far back (a long autonomous run), the kept history is `U`, then a gap the log covers, then the budgeted suffix. The log can therefore describe work done after the oldest kept message; the preamble says so. Removing whole units from the middle of one tool loop is the one shape no rewrite produces today. My understanding is that Anthropic requires thinking blocks only on the last assistant turn of an active tool loop, which the budgeted suffix always keeps whole, but that is provider behavior I have not verified here; step 10 should prove it against a recorded Anthropic request before relying on it.

The turn boundary stays exact: when `cut` is at or before the boundary the current tick is still a contiguous suffix; when `cut` falls inside the tick, the existing formula collapses the boundary to `historyStart` (`context-pipeline.ts:243-249`), which is the correct value because the earliest kept tick message is then at index 0.

#### Both swap paths use the plan

- **Chunk path, non-blocking posture (talker), or a degraded engine:** steps 2 to 5 only.
- **Blocking posture (reasoner, sub-agents, idle digestion's threshold pass):** step 1 first. This replaces Step 2's `setSourceHistory([])` (`observational/index.ts:299`): the sync observer now covers `[W, T)`, never the tail.
- **Buffering past the threshold:** `onTurnEnd` keeps launching observers past the threshold at the `bufferMinTokens` floor instead of returning (D13), so a non-blocking loop keeps producing chunks its next activation can merge, and a degraded engine keeps retrying in the background.

All awaits happen before any state changes. Steps 2 to 5 then run synchronously, in one block: merge, ledger update, source write, count invalidation. An abandoned pass (`isStale`) skips that block; the chunks it produced stay in the ledger at tracked ranges, so nothing is lost and nothing is observed twice (the same pass today merges sync observations into the log while its source rewrite is discarded, then resets the watermark to 0, so those messages are observed again: `observational/index.ts:298-315`, `context-pipeline.ts:235-239`).

#### Prompts

- `observational/constants.ts:203`: replace "after activation, the raw conversation messages are removed from context, and these hints are the ONLY way the agent knows what it was doing" with: after activation, older raw messages are removed and only the most recent messages stay verbatim; these hints connect what the agent was doing before that tail to the work in it.
- Preamble (`:486`, `:500`, `:503`): observations cover earlier conversation; the most recent messages follow verbatim and are the more precise record where they overlap; an observation can describe work after the oldest message still visible; a line marked `GAP` means that span was lost before it could be recorded, so say so rather than guess.
- Reflector prompt: preserve every `GAP` line verbatim. The engine also re-appends any gap line a reflection dropped (mechanical, so the guarantee does not depend on the model).

### 2. Failure handling

#### What counts as a failure

| Reply | Today | New |
| --- | --- | --- |
| Throw, timeout, abort | Async: logged. Sync: thrown out of `transformContext` | Failure |
| Empty or whitespace | Valid: empty chunk or empty log | Failure |
| No `<observations>` tag | Whole reply used as observations (`observer.ts:263`) or as the log (`reflector.ts:108-113`) | Failure (unparseable) |
| Open tag, no close tag | Everything after the tag used (`observer.ts:326-329`) | Failure (truncated output) |
| Well-formed observer reply with an empty block | Valid | Valid: the observer judged the span empty. Rejecting it would pin the watermark forever on trivial chatter |
| Well-formed but empty reflection | Valid, wipes the log | Failure |
| Reflection not smaller than its input | Swapped in | Discarded; the log is kept |
| Degenerate repetition | Retried once (`observer.ts:513-517`) | Counts as a failed attempt |

#### Call policy (`calls.ts`)

Each observer or reflector call is up to `maxAttempts` (default 3) attempts, each bounded by `callTimeoutMs` (default 60,000, the same value idle digestion already uses at `observational/index.ts:73`), with 1 s and 2 s backoff. Authentication, billing and context-overflow errors are not retried. Each attempt gets an `AbortSignal` combining its timeout with the caller's signal; `CompleteFn` gains `signal`, which `utilityComplete` already supports (`direct-completion.ts:39`, `:239`). The reflector's compression escalation is separate: a valid but oversized reply still escalates a level; a failed attempt retries the same level.

OM completions stop reporting through the loop's `onError` (D14). Spend is still recorded. Failures are reported once, through memory events.

pi's abort signal is forwarded through `wirePiTransformContext` into the hook (D16). Aborting stops the in-band wait at once; the tracked call keeps running and lands as a chunk if it succeeds.

#### Health state machine (`health.ts`)

```
healthy ──(a call fails after all attempts)──▶ degraded
degraded ──(any observer or reflector call succeeds)──▶ healthy
```

| | Healthy | Degraded |
| --- | --- | --- |
| In-band pass (blocking posture) | May wait for the tracked observer and observe `[W, T)`, within `blockingBudgetMs` (default 60,000) for the whole pass, reflection included | Behaves like the non-blocking posture: merge completed chunks, never wait, never call |
| Background (`onTurnEnd`, digestion) | Normal | Normal, full retry policy. This is where recovery comes from |
| `compactNow` / `observeNow` | Full policy | Full policy (the user asked) |

This bounds blocking to one budget per degraded episode instead of one per LLM call: a reasoner turn with 30 tool calls against a hung utility provider blocks once for at most 60 s, then proceeds, rather than up to 30 times.

When a pass ends short (a failed piece, or the budget runs out), steps 2 to 5 swap whatever chunks exist, the request goes out as is, and the next pass tries again. That is the headroom: activation fires at 90% and the request still fits.

#### Never throw

`CompactionManager.applyInTransformContext` catches everything around OM, L1 and L3, logs it, emits a memory error, and returns the best context it has. The pipeline's hook adds the same boundary around the whole hook as defense in depth. Because of the apply-after-await rule, a throw can never land between removing messages and recording their observations (D1).

#### Reflection safety

The tracked reflector records the exact log string it reflected. A result is applied only if the current log still starts with that string; the reflected text then replaces that prefix and whatever was appended since is kept as a suffix (D4). If the log no longer starts with it (another reflection or a restore replaced it), the result is discarded. A failed or discarded reflection keeps the old log; the log is larger than ideal, which is a cost, not a loss.

#### Emergency truncation

Today's in-band L3 shares the 90% line with activation when no limit is set, so "use the headroom" is impossible without moving it. The design splits emergency handling by what it can lose:

- **In-band (view only, lossless).** If the estimate after the swap is still ≥ `failsafe.threshold` × the **effective** window (proposed default 0.95, see open questions), truncate the view: keep `U`, the tail and the observation slot, drop the oldest units in between, and insert a one-call note at the cut naming how many messages and which time span are not shown. The source keeps everything and the background observer still reads it, so nothing is lost and no permanent gap note is written. The pre-truncation `triggerObservation` (`compaction/index.ts:1076-1084`) is removed. If even `U` plus the tail does not fit (one giant tool result), fall back to `U` plus the last unit; if that does not fit, send it and let the provider decide.
- **Reactive (source, durable).** Only after the provider rejects a request for overflow. Synchronously: first an ordinary swap of everything already observed outside the tail (lossless); then drop unobserved units outside the tail, oldest first, until the estimate is under a target below capacity (proposed 0.8, see open questions), never `U`, never the last unit. Append a gap note to the log, for example `* <critical marker> (14:02 to 14:40) GAP: 37 messages from 14:02 to 14:40 left context before memory recorded them (observer failing: overloaded). Details from that span are missing.`, and fire `onMemoryGap`. Messages with no timestamp are described by count only. An in-flight observer whose range intersects the drop is invalidated.

Using the effective window for the in-band ceiling is a deliberate change from L3 today (`compaction/index.ts:1066`): with a 1M model and a 200K limit, a degraded observer would otherwise let requests grow toward 950K. View truncation is lossless, so applying it at the consumer's budget costs nothing durable.

#### Events

| Handler (fan-out with origin on the facade) | When | Payload |
| --- | --- | --- |
| `onMemoryError` | A call failed after all attempts | `operation` ('observe' or 'reflect'), `trigger` ('buffer', 'activation', 'idle', 'compact-now', 'observe-now'), `error`, `attempts`, `consecutiveFailures`, `outcome` ('retry-later', 'partial-swap', 'unchanged') |
| `onMemoryRecovered` | First success after failures | `failures`, `degradedForMs` |
| `onMemoryGap` | The reactive path dropped unobserved messages | `droppedMessages`, `from`, `to`, `reason`, `note` |
| `onObservation` (existing) | Messages recorded and, for a swap, removed | `observedMessages`, `removedMessages` (renamed from `compactedMessages`), `trigger`, `tokensBefore`, `tokensAfter` |
| `onReflection` (existing) | Unchanged | Unchanged |

Each memory event is also emitted on the event bridge as type `memory` with a typed payload, following `utility_usage` (`event-bridge.ts:325-331`), so sub-agent events forward with `childTaskId` and the duplex merged bridge labels them with `loopPath`. These replace `onCompactionError`, `onCompactionDegraded` and `onCompactionExhausted` rather than repurposing them: those names and payloads (`layer2Failures`) describe L2.

#### Stale context size

Whenever the source writer lands a rewrite, the manager clears the post-hoc count (I6, D5). Estimates use the heuristic until the next `turn_end` measures again. Within the same call, L1 and L3 re-estimate from the rebuilt context instead of reusing `currentTokens` and `slotTokens` computed before the swap (`compaction/index.ts:884-896`). The source writer reports whether a rewrite landed, so an abandoned pass does not clear anything.

#### Edge cases

| Case | Behavior |
| --- | --- |
| Restore from a checkpoint mid-buffer | Composite capture is one synchronous frame (`facade/composite-state.ts:44-66`), so saved chunk ranges and `P` match the saved history. Restore clamps ranges to the restored length and invalidates every tracked call and the buffered reflection (D9). State without per-chunk ranges but with a watermark restores as one merged chunk ending at the watermark (lossless). State without a watermark keeps today's rule: chunks dropped, history re-observed. `restoreConversationHistory` resets OM state, so restoring history with no memory never pairs it with the old log. |
| Aborted turn | The in-band wait stops on pi's signal; completed chunks stay; no swap applies on an aborted pass. Trimmed failure stubs clamp `P`, chunk ends and `F` (`buffering.ts:525-533` today clamps only the watermark and the in-flight end). |
| Swap while an observer is in flight | Non-blocking or degraded: its range is wholly at or after `cut`, so it is rebased and lands later. Blocking and healthy: the pass waits for it within the budget; if the budget runs out, the pass cuts at `W` and does not start an overlapping call. |
| Stale token | A tracked call whose token was invalidated (restore, overlapping drop) discards its result and touches no state; a new call can launch immediately. Today a stale observer still clears whichever in-flight marker exists (`buffering.ts:182-183`), which is only safe because nothing new can launch while it is marked in flight. |
| Tail larger than budget (one giant tool result) | The last unit and `U` are always kept. Nothing else is. If the result still exceeds the threshold, the next activation finds nothing new to remove and does nothing; L1's view trimming, the in-band emergency path and finally the provider decide, as today. |
| Duplex talker | Non-blocking: merges chunks with the tail rules, never calls in-band, keeps buffering past its threshold, and gets its blocking catch-up from idle digestion. Its memory events reach Cortex Code with origin `talker`. |

### 3. `compactNow()` and the fate of `triggerObservation`

**`compactNow(options?)`** runs under the loop gate (like `digest()`, `context-pipeline.ts:346-381`), so it cannot race a turn:

1. Wait for the tracked observer to settle.
2. Select the tail and observe `[W, T)` with the full policy. If any piece fails, return `{ status: 'failed', error }`. History and the log are unchanged; pieces that did succeed stay buffered so the next swap does not repeat them.
3. Apply steps 2 to 5 of the swap plan regardless of the threshold. If nothing would leave history (everything fits in the tail), return `{ status: 'nothing-to-compact' }`.
4. Run the reflection check with blocking allowed. A failed reflection keeps the old log and is reported in the result; the swap stands.
5. Return `{ status: 'compacted', removedMessages, tokensBefore, tokensAfter, reflection }`.

On the facade it compacts both resident loops (decision 3 below): the reasoner runs the full sequence above; the talker runs only steps 2 to 5 of the swap plan, never waiting on an observer call. The result is per loop, and the call preempts a running idle digestion.

**`triggerObservation`: keep the capability, fix it, rename it `observeNow()`.** Its documented purpose is capturing a correction in the log immediately (`observational-memory-architecture.md` decision 8, `agent-loop/api/context.ts:161-165`). That purpose is still real: consumers read the log (Animus-style persistence, `onObservation` handlers), and the reflector can only reconcile a correction it has seen. What is broken is the mechanism: it re-observes all of history (`observational/index.ts:576-591`), appends duplicates, never moves the watermark, so buffering observes the same messages a third time, and it runs outside the gate (`agent-loop.ts:439-444`).

`observeNow()` runs under the gate, waits for the tracked observer, observes `[W, N)`, merges every completed chunk into the log and removes nothing, so `P` advances to `N` and nothing is ever observed again. It fires `onObservation` with `removedMessages: []`. The rename matters because the semantics change materially and because it pairs visibly with `compactNow()`: one records, the other records and swaps.

### 4. Removing classic

Prerequisites, all part of this plan before the removal commit: `CompleteFn` moves to `observational/types.ts`; L1 gets its own automatic-prefix trim ratio (`microcompaction.prefixTrimRatio`, default 0.70) instead of `COMPACTION_DEFAULTS.threshold`; `/compact` and `/model` use `compactNow()`.

Then, in Cortex:

- Delete `compaction/compaction.ts` (L2), adaptive thresholds (`compaction/index.ts:69-174,407-419`), the classic branch (`:928-1056`), `checkAndRunCompaction` (`:1155-1235`), the L2 failure counters and handlers, `setCompleteFn` and the summarization wiring (`agent-loop/assembly.ts:452-453`), `setLastInteractionTime` (adaptive is its only reader, `compaction/index.ts:339-348`), and the `strategy` field. The OM engine is always constructed; the source accessors become required parameters, so the silent fallback cannot exist.
- `_observations` is always registered (`agent-loop/assembly.ts:299`); the pipeline's strategy checks go (`context-pipeline.ts:260,361`); `onTurnEnd` wiring drops its strategy check (`event-wiring.ts:123`).
- The talker config staggers only `observational.activationThreshold` (`duplex/assembly.ts:144-167`).
- `buildCompactionConfig` rejects `strategy: 'classic'` (and `compaction` or `adaptive` sections) with a message saying classic was removed, rather than silently ignoring them.
- Tests: the shortcut uses switch to accounting for the `_observations` slot; classic's own tests are deleted; tests for shared machinery (L1, L3, insertion cap, idle digestion timeouts) are retargeted at OM. `ollama-agent.test.ts:85-90` moves to the new L1 ratio.

In Cortex Code:

- Remove `--compaction` (an unknown argument is an error, `cli-args.ts:75-78`), the `compactionStrategy` plumbing in `Session`, `agent-config`, `status-view`, the footer's `observationalMode` flag, and the `/debug` gate.
- Checkpoints always include memory (D15) and stop writing `compactionStrategy`. `parseSessionMeta` ignores the field instead of filtering it, so meta written by older builds, `'classic'` included, still lists and resumes. A resumed classic session restores with no memory, which the D9 fix resets cleanly; its `<compaction-summary>` message is ordinary history the observer will read.
- `agent-events.ts`: remove the three classic handlers; render `onMemoryError` (on entering degraded), `onMemoryRecovered` and `onMemoryGap` for any loop, matching the existing "a duplicated warning beats a swallowed one" rule (`:213-217`); move the durable transcript's compaction marker to `onObservation` for the work loop when `removedMessages` is non-empty, using its new token fields.

---

## Public API changes

### Cortex

Added:
- `AgentLoop` and `CortexAgent`: `compactNow(options?: { signal?: AbortSignal }): Promise<CompactNowResult>`, `observeNow(): Promise<ObserveNowResult>`, `onMemoryError`, `onMemoryRecovered`, `onMemoryGap`.
- Event bridge type `memory` with payload `MemoryEventPayload` (`kind: 'error' | 'recovered' | 'gap'`).
- `ObservationalMemoryConfig`: `tailRatio` (0.2), `tailMaxTokens` (64,000), `callTimeoutMs` (60,000), `maxAttempts` (3), `blockingBudgetMs` (60,000).
- `ObservationalMemoryState.observedPrefix?`; `ObservationChunk.endIndex?` (optional for reading old state).
- `MicrocompactionConfig.prefixTrimRatio` (0.70).
- `CompleteFn` options gain `signal?: AbortSignal`; the type is exported from the observational module.

Changed:
- `ObservationEvent.compactedMessages` becomes `removedMessages`; adds `observedMessages`, `trigger`, `tokensBefore`, `tokensAfter`.
- `getObservationalMemoryState()` never returns null once classic is gone.
- `restoreConversationHistory()` resets observational state (call `restoreObservationalMemoryState()` after it, as already documented).
- `failsafe.threshold` default and basis (see open questions).
- Observer and reflector failures no longer reach `onError`.

Removed:
- `triggerObservation()` (replaced by `observeNow()`), `checkAndRunCompaction()`, `setLastInteractionTime()`.
- `onBeforeCompaction`, `onPostCompaction`, `onCompactionError`, `onCompactionDegraded`, `onCompactionExhausted` and their types (`CompactionTarget`, `CompactionResult`, `CompactionDegradedInfo`, `CompactionExhaustedInfo`), and the `CortexEvents` entries.
- `CortexCompactionConfig.strategy`, `.compaction`, `.adaptive`; `CompactionConfig`, `AdaptiveThresholdConfig`; exports `runCompaction`, `shouldCompact`, `partitionHistory`, `buildSummaryMessage`, `ADAPTIVE_DEFAULTS`, `computeAdaptiveThreshold`; `CompactionManager.strategy`, `.setCompleteFn`, `.getEffectiveThreshold`, `.lastInteractionTime`.
- `AGENT_LOOP_DELEGATION` (`facade/loop-delegation.ts`) and `facade/loop-surface.ts` follow: `observeNow` work-routed, `compactNow` composite over both resident loops with a per-loop result, the memory handlers fanned out; `facade/state-emitter.ts:68-70` marks dirty on `onMemoryGap` instead of `onPostCompaction`.

### Cortex Code

- Removed: `--compaction`, `SessionOptions.compactionStrategy`, `Session.getCompactionStrategy()`, the footer's `observationalMode`, `SessionMeta.compactionStrategy` (read and ignored).
- `/compact` reports the `compactNow()` result: what was removed and the new size, "nothing to compact" when history fits in the tail, or the failure with "nothing changed".
- `/model`'s "Run /compact first" calls `compactNow()`.
- New transcript notices for memory degraded, recovered and gap.

---

## Interactions outside this scope

- **Token estimator (pi 1.x Phase 6).** Utilization is `max(last measured input, chars/4 of the whole context)` (`compaction/index.ts:485-490`). A large tool result added since the last call can be underestimated by its full size, so a request can overflow while the estimate reads below the ceiling. The reactive path is the backstop, and the lossless in-band truncation reduces what a misestimate costs. Switching estimators moves every threshold here, including the proposed 0.95 and 0.8.
- **Error classification (pi 1.x Phase 6).** `calls.ts` uses `classifyError` to decide what not to retry; Phase 6's `billing` category plugs in there. Phase 6 also replaces `isContextOverflow` in `failsafe.ts:164-177`; this design changes callers of `emergencyTruncate`, not the detector. Phase 6's silent-overflow detection will route more cases into the reactive path.
- **Overflow turns still fail.** After the reactive path frees space, the turn is not retried because `context_overflow` is not a retryable category (`retry-policy.ts:20`). Unchanged here.
- **L1 inside the tail.** L1 can bookend tool results inside the verbatim tail in the view when the cache is cold, because its hot zone (16K or 5%) is smaller than the tail budget. The source stays verbatim. Consolidating limiters is out of scope; noting it because "verbatim" holds for source, not for every view.
- **View injections vanish on swap turns.** Step 7 rebuilds the view from source (`observational/index.ts:341-363`). Unchanged; a cheap fix is to have the pipeline re-inject after any landed rewrite.
- **Positional delivery unwind.** `unwindFailedDelivery` and the drain paths locate a failed delivery by the transcript length captured before the run (`agent-loop/transcript-repair.ts:88-117`, `delivery-queues.ts:250`, `background-delivery.ts:171`). Any partial swap mid-run shifts those indices; if the run then progresses past the old length and fails, the unwind can remove the run's own messages and re-queue the delivery. Today's chunk-only activations can already do this; the tail makes partial swaps the norm, so the plan fixes it (step 6 below).
- **Utility model equals primary when none can be inferred** (`agent-loop/model-settings.ts:283-290`). That is configuration, not a failure fallback, so "no fallback to the primary model" does not touch it.
- **Recall tool, cache-timed activation, threshold changes, microcompaction consolidation.** Not designed. None of them blocks this design.
- **Concurrent work.** `packages/cortex/src/index.ts` is currently being edited by the sandbox work; the export changes in steps 13 and 15 need to coordinate with it.

---

## Commit sequence

Each step keeps `npm run typecheck` and the suite green and adds tests that fail against the code before it. Where a test guards existing behavior, it is labeled a guard and paired with a positive precondition. Existing tests that codify replaced behavior are updated in the step that replaces it; the main ones are named.

1. **`fix(cortex): keep observation text when an in-band observer or reflector fails`**
   Apply-after-await in the engine; try/catch boundary in the manager and the hook; remove the pre-L3 `triggerObservation`.
   Fails first: chunk text survives a sync observer rejection after chunk activation (D1); the hook resolves when the observer rejects and when the reflector rejects (D8); blocking L3 makes no observer call.
2. **`fix(cortex): reject empty, untagged, and truncated observer and reflector replies`**
   Fails first: empty sync reflection keeps the log; empty buffered reflection is never swapped in (D2); empty observer reply yields no chunk and the watermark stays (D3); missing tag and missing close tag are failures. Guard: a well-formed empty observer block is accepted, with a precondition that a populated block lands.
3. **`fix(cortex): apply a buffered reflection only onto the log it reflected`**
   Fails first: the D4 reproduction keeps the activation-2 observations.
4. **`fix(cortex): invalidate the measured context size when compaction rewrites history`**
   Fails first: the D5 reproduction makes one observer call and keeps the two fresh messages.
5. **`fix(cortex): reset observational state on restore and invalidate in-flight memory work`**
   Internal rewrites move to the pipeline's source writer.
   Fails first: a pre-restore observer does not land; a pre-restore buffered reflection is not applied; restore with null memory leaves an empty log and watermark (D9).
6. **`fix(cortex): locate a failed delivery by identity, not by transcript length`**
   Fails first: a delivery run with a mid-run chunk activation, then a terminal failure, leaves the run's messages intact and does not re-queue the delivery.
7. **`feat(cortex): bound memory calls with timeouts, quick retries, and the run's abort signal`**
   `calls.ts`, `signal` on `CompleteFn`, pi's signal forwarded, OM completions off `onError`, `health.ts`.
   Fails first (fake timers): a hung observer settles within `callTimeoutMs`; a 529 then a success yields one chunk and no `onError` (D14); an auth error is not retried; aborting the run resolves `transformContext` without waiting for the observer (D16); a degraded in-band pass makes no call.
8. **`feat(cortex): report memory failures through onMemoryError and onMemoryRecovered`**
   Fails first: a failing buffer observer fires `onMemoryError` with `consecutiveFailures`; recovery fires once; a sub-agent's `memory` bridge event reaches the parent with `childTaskId`.
9. **`refactor(cortex): track observation chunks by message range`**
   `ledger.ts`, tokens instead of the epoch, rebase on activation, unit-aligned capped observer pieces, bookended tool results in observer input, buffering past the threshold.
   Fails first: legacy two-chunk state restores as one ranged chunk; an in-flight observer survives an activation and lands at shifted indices (D10); the `onTurnEnd` snapshot is within the buffer cap at a unit boundary (D12); a non-blocking loop past its threshold launches a buffer observer (D13). Updates `engine.test.ts:388` ("does not trigger when already past activation threshold").
10. **`feat(cortex): keep a verbatim tail when observations swap in`**
    `tail.ts`, the swap plan in both paths, prompts, `ObservationEvent` fields.
    Fails first: the latest user message survives an in-band swap (D7); messages inside the tail budget stay; a straddling chunk is merged and its in-tail messages stay as observed-and-kept; the randomized property test for I1 to I4.
11. **`fix(cortex): truncate the view only near the full window and record gaps durably only on provider overflow`**
    Fails first: a failed activation at 91% does not truncate; view truncation keeps `U` and the tail (today the last 3 messages); provider overflow appends a gap note with the span and fires `onMemoryGap`; a reflection that drops a gap line gets it back.
12. **`feat(cortex): add compactNow and observeNow, replacing triggerObservation`**
    Fails first: `compactNow` below the threshold swaps keeping the tail; it waits for the tracked observer and never re-observes its range; a failing observer changes neither history nor the log; `observeNow` twice makes one observer call (`triggerObservation` today makes two over overlapping input, D11); both wait for a running turn.
13. **`feat(cortex-code): compact through compactNow and show memory events`**
    `/compact`, `/model`, memory notices, crash checkpoint always includes memory.
    Fails first: a crash checkpoint taken with an observer in flight carries `reasonerMemory` (D15); `/model`'s compact-first calls `compactNow`; a `memory` error renders once per degraded episode.
14. **`refactor(cortex): move CompleteFn into observational types and give L1 its own prefix trim ratio`**
    Guards: L1 behavior under automatic-prefix caching is unchanged (`ollama-agent.test.ts:85-90` retargeted), with a precondition that it trims under pressure.
15. **`refactor(cortex): remove the classic compaction strategy`**
    Fails first: `strategy: 'classic'` is rejected with a message naming the removal; `AgentLoop` always registers `_observations`. Migrates the 19 shortcut files.
16. **`refactor(cortex-code): remove compaction strategy plumbing`**
    Fails first: `--compaction` is rejected. Guard: meta with `compactionStrategy: 'classic'` still lists and resumes.
17. **`docs(cortex): document the hardened observational memory and remove classic compaction docs`**
    `observational-memory-architecture.md`, `compaction-strategy.md` (reduced to L1 and L3), `context-manager.md`, `cortex-architecture.md`, `cortex-agent.md`, `consumer-guide.md`, `product-vision.md`, `tools/sub-agent.md`, `duplex/log-and-context.md`, `duplex/README.md`, `packages/cortex/README.md`. `duplex/decisions.md` and `migration-plan.md` are history: add a dated note rather than rewriting them.

Steps 1 to 8 are independent fixes that are worth landing even if the rest waits. Classic could also be removed right after step 8; the only cost is that `/model`'s compact-first would call the old `triggerObservation` until step 12. The order above follows "after OM no longer depends on it".

---

## Decisions on the open questions (2026-10-08)

Decided by the tech lead, to whom Craig delegated these calls.

1. **Emergency numbers.** Accepted as proposed: in-band view truncation at 0.95 of the effective window; the reactive path drops to 0.8 of capacity. The reactive drop is the only lossy step, so it drops the minimum; the lossless in-band view truncation then enforces the consumer's budget on the next call.
2. **In-band emergency stays view-only.** Accepted: a one-call note in the view in-band; a durable drop plus a `GAP` note in the log only on provider overflow. This matches "never lose memory" better than the original wording.
3. **`compactNow` in duplex compacts both loops,** because consumers never learn the talker and reasoner split. The reasoner gets the full `compactNow`. The talker gets a non-blocking swap of what is already observed, plus its tail (swap plan steps 2 to 5 only); it never waits on an observer call, since it is the latency-critical loop. The facade returns a per-loop result. Cortex Code's `/compact` reports the reasoner's result, plus the talker's when there is one.
