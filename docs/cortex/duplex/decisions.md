# Decision Record

> **STATUS: IMPLEMENTED AND DEFAULT.** Built across phases 0 through 2b-ii on the `duplex-restructure` branch and validated in Phase 3. Duplex is the default mode on concurrent backends (D14, D21); `mode: 'passthrough'` is the opt-out. See migration-plan.md for the honest boundary of what the test suite can see, and consumer-guide.md for what changes on upgrade.

Decisions made during the 2026-08 design phase, with rationale and rejected alternatives. Newer decisions supersede older ones where they conflict.

## D1: Build at the Cortex Layer; Do Not Re-implement pi-agent-core

The only capability a pi-agent-core rewrite could theoretically add is token-level interruption of a running generation (the AsyncLM `[INTR]` mechanism). That requires controlling decode, which is impossible when composing provider HTTP APIs. In HTTP-land the turn is the atomic unit; responsiveness comes from keeping the fast loop's turns short, which is orchestration, which is Cortex's mandate. Every identified gap (steering surfacing, delivery primitives, permission brokering, the log) is implementable over existing pi hooks.

## D2: Naming

- `AgentLoop`: the loop primitive. This is today's `CortexAgent` class, renamed. It powers all three roles (talker, reasoner, sub-agent), so the name is role-neutral. "TaskAgent" and "ReasonerAgent" were rejected because the same class runs the talker.
- `CortexAgent`: the composite facade. Consumers keep interacting with "a Cortex agent"; the duplex machinery is internal.

## D3: Topology Is Talker + One Persistent Reasoner + Sub-Agents

Rejected: a pool of parallel task loops at tier 2.

Rationale: parallel reasoners fragment context. The reasoner must understand pretty much everything going on in the session; ephemeral or parallel task loops cold-start without the accumulated codebase understanding, design decisions, and observational memory that make long sessions work. One persistent reasoner preserves that. Parallelism comes from the reasoner spawning sub-agents (tier 3), which is today's proven machinery. This mirrors the Claude Code model: one main loop plus background tasks.

Consequences accepted: the reasoner is the scheduler of all work, and its turn-boundary frequency is the system's pickup latency. Mitigations: the talker acknowledges instantly regardless, long shell commands run backgrounded, and the reasoner's prompt nudges it to background anything long.

## D4: The Talker Is a Full AgentLoop

The talker is not a stripped-down chat wrapper. It has its own compaction (consumers rely on effectively infinite conversation), slots, working tags, and cache management. Default compaction strategy is observational, same as everything else; downgrading the talker to the classic strategy is a tuning option if duplicate observation cost proves material, not an architectural decision.

> **Note (2026-10-09):** the classic strategy was removed ([om-hardening-plan.md](../om-hardening-plan.md)), so the downgrade option no longer exists. The talker runs observational memory under the non-blocking posture: it swaps in only what it has already observed and never waits on a memory call, and `CortexAgent.compactNow()` treats it the same way.

## D5: The Talker Has No Blocking Tools

The invariant is that the talker's turns are structurally incapable of blocking on tool execution, so the voice channel always has someone home. It carries exactly one fixed toolset: the control tools of D8, all of which are local, sub-millisecond dispatches into the facade. Consumer-supplied tools, I/O tools, and MCP tools are wired to the reasoner and never reach the talker. Status arrives by injection, never by a tool.

(Earlier draft of this decision said "zero tools" with delegation via in-band tags; superseded by D8's reversal. The property being protected, no blocking tools, is unchanged.)

## D6: No Consumer-Facing Slot Routing

Rejected: a per-slot policy (talker-only / reasoner-only / both) on the facade API.

Consumer slots apply to both loops. The consumer should not know the talker/reasoner split exists; that dynamic is Cortex's internal concern. If a large slot ever becomes a talker latency problem, Cortex may optimize placement internally without any API change.

This covers **mid-session writes**, not only construction. 2b-i wired initial slots to both loops but left `getContextManager()` returning the reasoner's manager, so a consumer updating a persona slot mid-session would silently diverge the two loops. The facade's `getContextManager()` therefore returns a fan-out view: writes reach both loops, reads come from the reasoner. A per-slot routing knob remains forbidden.

## D7: The Log Is a Bus, Not a Context Projection

Rejected: injecting log-derived synthetic messages into each loop's prompt view via `transformContext`.

The context-pipeline audit killed the projection approach for durable content: view-only injections silently vanish on exactly the turns compaction fires, the observational-memory watermark requires the post-slot source array to be append-only, and insertions between a tool call and its results corrupt tool-call grouping, breakpoint simulation, and compaction atomicity simultaneously.

Instead, the log is an append-only coordination record: everything routed between loops is logged before it moves. Content reaches models through exactly two sanctioned channels, split by durability:

- Durable entries (deliverables, directives, permission asks, conversation deltas) are delivered as real transcript messages at turn boundaries, via the same path background results use today.
- Churn (task headlines, live activity) is view-injected outside the BP3 cache boundary, which is today's `<background-tasks>` mechanism.

## D8: Delegation Is a Control Toolset (Reversal of the Tags Draft)

The talker delegates via five fire-and-forget control tools: `spawn_task`, `steer_task`, `cancel_task`, `answer_ask`, `quick_lookup`. Each executes locally in under a millisecond (an array push into the facade) and returns `terminate: true`, which pi-agent-core already honors by skipping the automatic follow-up LLM call (`agent-loop.ts` `shouldTerminateToolBatch`). The spoken acknowledgment streams before the tool call in the same turn, so delegation costs zero extra LLM round trips.

Rejected, after initially being chosen: in-band directive tags parsed from the talker's text stream. The reversal rationale:

- **Wrong-layer transposition.** The control-token systems (MoshiRAG `<ret>`, DuplexOmni `[THINK]`, DuplexSLA's action channel) are custom-trained models that control decode; a token is their only possible interface. Every production system at the HTTP API layer (OpenAI Realtime, Gemini Live, LiveKit, Pipecat, ElevenLabs) uses tool calls for the fast loop's control surface. AsyncFC formalizes the pattern: standard call-return contract, future-style immediate return, no retraining.
- **Injection by echo.** Tags are parsed from text, and untrusted text (tool output in deliveries, stdout in headlines, file contents in lookup results, users saying tag syntax) constantly enters the talker's context; an echoed `<answer>` would forge a permission decision. Tool calls cannot be echoed into existence: invocation requires a deliberate structured call. This closes echo, and only echo. **Persuasion is a separate threat and is not mitigated here**: injected text can still argue the talker into making a deliberate call, and tools are marginally worse than tags in this respect because each control-tool result lands in the talker's transcript, so prior `answer_ask(..., allow)` calls accumulate as few-shot precedent. Persuasion is handled by the router rules in D16, not by this decision.
- **Reliability.** Models are trained heavily on schema'd tool calls with validation and structured retryable errors; bespoke tag grammar on a fast-tier model fails silently.
- **The latency case for tags was overstated.** With `terminate: true` there is no follow-up call; the only remaining difference is dispatch-at-tag-close versus dispatch-at-message-end, which equals the duration of any post-delegation speech, typically nothing and promptable to nothing.

Delegation remains a pointer, not a paraphrase: the reasoner receives the conversation deltas regardless, so tool arguments do not need to restate the user's request accurately.

## D9: No Deliverable Schema

Rejected: a structured deliverable format (`{headline, spoken, full}`).

Over-engineering. The reasoner delivers plain content; the talker is a full agent and decides what to say. The rule that survives is grounding: the talker condenses and rephrases what was delivered, and never states facts not present in deliveries or headlines.

## D10: Wake Policy Vocabulary

Adopted from Gemini Live's result scheduling: a log entry destined for the talker carries `interrupt` (start an unprompted talker turn now), `when_idle` (deliver at the next lull, gated on a consumer-supplied idle signal), or `silent` (available in context, surfaced only when relevant).

## D11: Permission Asks Broker Through the Talker

A reasoner or sub-agent permission ask becomes a log entry with an ask ID, wakes the talker (`interrupt`), is voiced to the user, and the spoken answer returns via the talker's `answer_ask` control tool, which settles the pending resolver. Requires ask identity, a queryable pending-ask collection, and abort-raced resolution (the current resolver await is uninterruptible; Cortex's wrapper fixes this by racing the consumer's decision against the abort signal, no pi change needed).

## D12: Parent-to-Child Steering Is a Launch Requirement

Rejected: cancel-and-respawn as the interim redirect mechanism for running sub-agents.

The reasoner must be able to steer a running sub-agent. Children are full AgentLoops and already have steering queues; the missing pieces are addressability (typed child handles, steer-by-taskId on the sub-agent manager) and a reasoner-facing `SteerSubAgent` tool. The chain: user speaks, talker calls `steer_task`, facade delivers to the reasoner, reasoner calls `SteerSubAgent(taskId, message)`, child's queue drains at its next turn boundary.

## D13: Quick Lookups Are Facade-Spawned, Log-Mediated

While the reasoner is mid-turn and deaf, small factual questions ("what does resolveModel do?") cannot wait for its turn boundary. The facade spawns ephemeral read-only sub-agents for talker-initiated lookups: no write tools, no decision authority, small separate concurrency cap, results wake the talker. Lookup results are appended to the log, so the reasoner sees them at its next turn; shared context is preserved and nothing forks.

## D14: Duplex Is the Default; Passthrough Is the Opt-Out

Both modes are built. Passthrough routes the facade straight to the reasoner and reproduces today's single-loop behavior exactly; it exists for consumers who want it and for parity testing. Duplex ships as the default (on a concurrent backend; D21 narrows the default to where it can deliver). Rationale: faster first feedback is close to a pure gain in every modality, and the reasoner is unchanged, so no reasoning power is lost. The accepted tradeoff is a slightly longer time-to-final-answer (acknowledgment plus handoff) in exchange for dramatically better time-to-first-feedback, plus one small-model call per exchange.

## D15: Tier Depth Is Hard-Capped

Tasks at tier 3 (sub-agents) cannot spawn further sub-agents. The reasoner spawns sub-agents; sub-agents are leaves. The existing `enableSubAgentTool: false` hardcode for children becomes configuration that the facade sets by tier.

---

The decisions below were added after the pre-implementation reviews. See review-findings.md for the findings that produced them.

## D16: Consent Is Bound by the Router, Not by the Talker

Validating that an askId exists and is pending establishes well-formedness, not authorization. The router enforces:

- exactly one ask is voiced at a time;
- `allow` is accepted only for the most-recently-voiced ask, only once, and **only from a talker turn whose causation chain includes a user utterance that arrived after the ask was voiced**. A turn triggered purely by a delivery, a headline refresh, or a lookup wake cannot grant permission, which is precisely the shape an injected-content persuasion attempt takes;
- `deny` is unrestricted;
- anything else returns a voiceable refusal and re-voices the pending ask. (The refusal costs one recovery turn and leaves the anomaly in the log.) Re-voices are capped per ask; past the cap the refusal says a fresh answer is needed instead (communication.md, Permission Brokering).

This makes the log's causation stamps load-bearing for security, not just for observability, so they are built in P2 with the log rather than added later.

**The broker must read the full cause set, never the latest-cause helper.** A run can consume several delivered items with different causes, and the loop exposes all of their tags; `latestCauseSeq` collapses that to one for log-stamping convenience. Collapsing before the check fails in both directions, and they are the same defect:

- **Denies real consent.** Ask voiced at seq 10, user says "yes" at seq 12, an unrelated delivery lands at seq 14, the run carries both. The helper returns 14, which is not an utterance, so a genuine "yes" is refused.
- **Grants consent nobody gave.** Same set, ask voiced at seq 22. The helper returns 25 > 22, so without a type filter the broker accepts a delivery the user never spoke, while the only real utterance predates the ask.

Over a homogeneous utterance-only set the collapse is coincidentally correct, which is exactly why this stays invisible until a second kind of tag exists. So: **cause tags are a discriminated shape carrying kind and seq**, not bare numbers, and the check filters by kind before aggregating. Resolving a bare seq against the log instead would work until retention evicted the entry; a self-describing tag cannot degrade that way. The broker reads the full set through its own port; the collapsing helper stays as-is for log stamping, which is a single-value field and forced to collapse.

One consequence to accept: a single-number `causedBy` on a log entry cannot express multi-cause, so a run that consumed two utterances stamps only the later one. Any consent audit or replay must reconstruct from the live tag set, never from the log alone, or it re-inherits the masking this rule exists to prevent.

As built (`src/duplex/cause-tags.ts`): a tag is `{kind: SessionLogEntryType, seq: number}`, with `kind` reusing the log's own entry-type union and stamped at the site that appended the causing entry rather than resolved later, so a tag cannot disagree with the log and cannot degrade when retention evicts. The loop's `causeTag` slot stays `unknown`, which is right for a general-purpose primitive, so `collectCauseTags` is the only validator between arbitrary input and a consent decision and must stay strict. It also flattens nested sets, because the truncation-repair delivery carries a whole prior set in one slot. The broker reads the full set through `DuplexRouterPorts.currentTalkerCauseTags()`; `currentTalkerCauseSeq` remains the log-stamping collapse and must never be used for consent.

**Every user word arrives as a tag, and only once a run has seen it.** `prompt()`, `deliver()` with `speaker: 'user'`, and `steer()` all log an utterance and carry its tag with the content. A steer into a live talker turn is handed to that run at its next turn boundary (the loop's `atTurnBoundary` path), and the run takes the utterance tag in that same frame, so a "yes, go ahead" steered mid-turn can satisfy this check from the next turn on, never before the talker has read it. Where that hand-over is not provably exact the steer parks and opens the next run with its tag. The failure direction stays safe: words that never reached a run carry no tag, so the broker still must not treat the tag set as proof the user said nothing else, and the voiced-first rule is what carries the weight: an unheard "yes" means the ask stays pending.

**Two rules the seq comparison alone does not give you**, both found while building the broker and both restricting rather than recovering:

- **Anchor on voicing, not on the ask.** The comparison is against the seq of an `ask_voiced` entry appended when the voicing is actually delivered, re-anchored on every re-voice, not against the ask entry's own seq. Otherwise a "yes" spoken while this ask sat queued behind another voicing satisfies the comparison, because the ask entry existed long before the user could have heard it.
- **A run carrying this ask's voicing cannot grant it.** A barge-in "yes" can park alongside the voicing delivery and be consumed by the same run, which passes the seq rule while having been spoken *before* the request was read out. So the presence of this ask's own voicing tag in the cause set disqualifies that run from granting it.

Both fail toward one extra re-voice cycle, which is the correct direction: the user hears the request again and answers again.

**An utterance tag means the user spoke, not that something reached the conversation surface.** The first broker build stamped `{kind: 'utterance'}` on every waking `deliver({target: 'conversation'})`, which meant a consumer speaking its own notification ("Your build finished") minted a tag the consent check accepts. The attack needs no injection into the tag path at all: voice an escalation ask, wait for any consumer-side notification, and a persuaded talker can grant consent whose audit trail points at a build message. The check was doing exactly what it was told; the vocabulary was wrong.

So `deliver` carries an explicit speaker, and **the default is not the user**. A caller that genuinely relays human speech says so; everything else mints a non-qualifying kind. The default has to fail toward denial, because the failure modes are asymmetric: defaulting to user turns every existing and future notification path into a consent source silently, while defaulting to system costs at most a re-voice when a consumer forgets to mark real speech. `prompt()` is unambiguous user speech and stamps `utterance` directly.

The general rule this is an instance of: **a consent input must be minted by the surface that can vouch for its origin.** Anything downstream of that, however convenient the tag looks, is only reporting what reached it. Secondary mitigation for the few-shot-precedent problem named in D8: control-tool results are bare uniform receipts, so the transcript carries as little imitable decision text as possible.

These are router rules and never prompt rules, because the talker's judgment is precisely what an attacker targets (review-findings.md F2). Ask entries carry per-ask nonces, a `voiced` state, and a mandatory verbatim `renderedRequest`; the talker reads destructive and escalation requests verbatim rather than summarizing them (F14).

## D17: Control Tools Never Fail Loudly

Every control-tool outcome, including schema-validation failure, unknown task id, and dispatch error, returns `terminate: true` with a bare uniform receipt the talker can voice. Control tools never throw and never return `isError`, because pi's error results omit `terminate` and therefore reopen the loop; combined with an unbounded default `maxTurns` that produces an unbounded retry cycle with no attacker involved (F9). The facade additionally sets a hard low `maxTurns` on the talker rather than inheriting consumer budget config, and failed dispatches produce a lifecycle entry the talker voices so a user instruction never vanishes silently.

**Two exceptions where terminate is deliberately withheld**, both guarding against a silent exchange (the user speaks, hears nothing, and the turn ends):

- **Empty spoken text.** Fast-tier models frequently emit a tool call with no preamble, and `terminate: true` then ends the turn with nothing said. The facade's `afterToolCall` wrapper suppresses terminate when the assistant message's user-facing text (after stripping working tags) is empty, forcing exactly one follow-up turn that speaks. This converts dead air into one extra fast-model call, and uses machinery that already exists: pi passes `assistantMessage` into the hook, and `afterResult.terminate` overrides the tool's value.
- **Truncation.** If the talker hits its output cap mid-tool-call, the call may never materialize, leaving a spoken acknowledgment with nothing dispatched and no error anywhere. The facade audits the talker's stop reason and runs a repair turn when a `maxTokens` stop produced no control-tool call.

## D18: Conversation Is Context, Not Instruction

Conversation deltas (both user utterances and talker replies) reach the reasoner queued rather than prompted, wrapped as explicitly context-only. Only a control-tool dispatch starts a reasoner turn.

**Mechanism, settled during 2b-i.** The deltas ride *inside* the next dispatch message as a `<conversation-context>` block, rather than going through the reasoner's loop-owned silent queue. The silent queue flushes only into real prompts, and sweep runs deliberately never flush it (the unwind accounting from Phase 0), so a dispatch parked behind a busy reasoner would have arrived without the conversation it points at. That breaks pointer-not-paraphrase in exactly the busy case this decision exists for. Carrying the block in the dispatch makes the pairing exact in every loop state. The contract this decision asserts (queued not prompted; only dispatches start turns) is unchanged. Without this, every "thanks, that's great" runs a full primary-model turn over the whole session context, and any utterance can drive an agent that acts (F3). Talker replies are included because the reasoner cannot interpret "yes, do that" without its antecedent (F4).

## D19: The Router Applies Backpressure

Wake classes describe intent; they do not bound rate. The router enforces an interrupt token bucket with demotion to `when_idle`, content-hash dedup across recent deliveries, per-turn and per-exchange delegation caps, dispatch dedup on `(loopPath, turnIndex, toolName, argsHash)` to absorb retry-induced double dispatch, and a facade-level aggregate budget guard that exists from the moment duplex is first assembled (F13, F3).

## D20: The Steer Fast-Path Is Removed

Steers always route through the reasoner. Delivering a steer straight to a named child saved one hop and removed the only loop exercising judgment between injected content and a tool-carrying agent (F11).

## D21: An Omitted Mode Resolves from Backend Concurrency

D14's rationale assumes the talker answers while the reasoner works. That holds only when the backend serves both requests at once. Hosted providers do, even for two requests to one model. Ollama serves one request per model by default (`OLLAMA_NUM_PARALLEL=1`), runs two models concurrently only if both fit in memory, and exposes neither through its API. On a serial backend duplex adds a second loop, a second model call per exchange and the handoff latency, and the talker queues behind the reasoner, so the premise is gone and the cost stays.

So every `CortexModel` carries `capabilities.concurrency: 'parallel' | 'serial' | 'unknown'`, stamped at creation by a structural rule (`src/model-backend.ts`) rather than a hand-kept list. Every provider in pi-ai's catalog is a hosted API, and hosted APIs serve concurrent requests, so a catalog provider is `parallel`. The catalog is read at runtime (`builtinProviders()`), so a pi-ai release that adds a provider is classified by the rule, and a test enumerates the catalog so a provider that breaks the rule fails loudly. Two things override it: a local runtime id (`ollama`, `custom`) is never judged hosted, and a base URL on loopback, a private network, or a private-use name (`.local`, a single-label host) is `unknown` whatever the provider id says, because a catalog id aimed at a local proxy is still a local server. Native Ollama is `serial` unless the consumer sets `parallelRequests: true`; custom endpoints and ids pi-ai does not know are `unknown`. An earlier version used Cortex's own registry plus a few extras and quietly withheld duplex from providers pi-ai had added since (`ant-ling`, `radius`, the `qwen-token-plan` family). Whether pi-ai has *vetted* a provider is not the question the rule asks; whether it is a hosted API is. `wrapModel` is the one place a `CortexModel` is built, so it owns the classification; a creator that knows its backend better (Ollama) declares its own value, which wins. Duplex fails only when the talker and the reasoner share one backend that cannot serve them concurrently, so that is the question an omitted `mode` asks: passthrough when both loops' models reach the same backend and it is not `parallel` for both, duplex otherwise, with a `mode-resolved-passthrough` resolution note naming the backend and both models. A backend is the base URL's host and port, with loopback spellings folded together, not the provider id: a custom OpenAI-compatible model on Ollama's `/v1` is the same server as the native Ollama model on that port, and model-name equality is no test at all (Opus and Opus on Anthropic still overlap). An earlier version required both models to be `parallel`, which withheld duplex from an Ollama reasoner whose talker was pinned to a hosted model, exactly the configuration where a fast hosted talker helps most. Two distinct models on one serial Ollama server block by default: they overlap only if both fit in memory, which Ollama does not expose, and a wrong guess queues every talker turn behind the reasoner. `parallelRequests: true` on both models is the opt-in, and the note says so. The talker judged is the one assembly builds (`talker.model`, or the reasoner's auto-resolved fast tier or configured `utilityModel`), computed by the same function before either loop exists.

An explicit `mode` always wins. `mode: 'duplex'` with the talker and reasoner on a shared backend that is not `parallel` runs duplex and records a `duplex-not-concurrent` note, because a consumer may know what Cortex cannot (a raised `OLLAMA_NUM_PARALLEL` it did not declare, a custom endpoint that is really a hosted gateway). A talker on another backend never earns the note.

The mode is not re-decided on `setModel()`. The loops are assembled from it: a passthrough agent has no talker to start, and a duplex agent's talker holds conversation state that a live teardown would have to migrate. So a `setModel()` that leaves both loops on a shared non-`parallel` backend keeps duplex and re-evaluates `duplex-not-concurrent` alongside the other model notes, and a passthrough agent stays passthrough. Its `mode-resolved-passthrough` note is re-read against the new model too, since a note naming a backend the agent no longer uses would explain the mode with a reason that is gone; when the new models would resolve to duplex, the note says the mode was fixed at creation instead (`data.wouldResolveTo`). A consumer that wants the mode re-decided creates a new agent. The note makes the mismatch visible, and switching to a different mode is not something a model swap should do behind the consumer's back.

A mode that follows the backend has one consequence for persistence: a consumer that moves backends between runs restores an artifact written in the other mode. Neither direction is a clean continuation, so the artifact records the mode that wrote it (`mode`, read off the shape for older artifacts) and a mismatch records a degraded `restore-mode-mismatch` note and lifecycle entry saying what was carried and what is inactive. One direction can be made whole cheaply, and is. A passthrough agent restoring a duplex artifact continues from the reasoner's history, which already holds the conversation up to the last delegation because every dispatch carries it (D18); what it lacks is exactly the router's pending conversation deltas, which are bounded and already in the format that history uses, so they are queued on the single loop as silent context and removed from the carried router state. The reverse is not rebuilt. A passthrough history holds tool calls the talker has no tools for and is order-coupled to the reasoner's observational memory, and a talker rebuilt from the session log would be unbounded and lose what compaction summarized; the reasoner has everything, and the talker learns the earlier conversation from what the reasoner delivers. The durable fix is the consumer's: pin `mode` for sessions it persists.

Not done: an Ollama `/api/ps` probe that warns when the talker and reasoner models were never resident at the same time. It would need polling during runs from the facade, would put provider-specific code in a general-purpose layer, and could not see the common case anyway (talker = reasoner on one model, where the limit is `OLLAMA_NUM_PARALLEL` and `/api/ps` shows one resident model either way).
