# Cortex: Product Vision

## The Problem

Modern LLM agent frameworks treat the context window as a flat, append-only buffer. You push messages in, the conversation grows, and eventually you hit the limit. At that point, most frameworks either truncate from the front (losing critical context) or summarize everything into a lossy blob. Neither approach gives you real control.

This becomes a serious problem for agents that need to operate continuously: long-running sessions, autonomous agents, agents that manage complex state across many turns. These agents need context that is both highly dynamic (changing every call) and highly stable (preserving prompt cache across calls). Those two goals are in direct tension, and no existing framework resolves that tension well.

Cortex exists to solve this problem. It provides fine-grained, structured control over what the model sees, organized to maximize prompt cache stability even as context changes dynamically throughout operation.

## Origin

Cortex was originally built for [Animus](https://github.com/Craigtut/animus), an autonomous AI assistant with a persistent inner life. Animus operates on a heartbeat loop: every tick, it gathers context from multiple sources (observations, memories, emotional state, active contacts, goals, tasks), runs an agentic loop with tool access, and produces responses. This creates a uniquely demanding context management problem:

- Context changes every tick, but most of it changes incrementally, not wholesale.
- Some context is permanent (identity, core memories), some is semi-stable (goals, recent observations), and some is fully ephemeral (current emotional state, tick trigger details).
- The agent runs indefinitely, so context will inevitably exceed the window. Compaction must be graceful, not catastrophic.
- Cost matters. Prompt caching discounts (up to 90% on Anthropic) make the difference between viable and prohibitively expensive for a continuously running agent.

No existing agentic loop framework provided the level of context control needed. The underlying loop library, `@earendil-works/pi-agent-core`, is deliberately minimal: it provides the agentic loop and nothing else. Cortex wraps it with everything needed to manage context in production: structured slots, ephemeral injection, observational memory, skills, tools, and provider management.

## Core Insight: Context as a Managed Surface

The central idea behind Cortex is that the context window is not a chat log. It is a **managed surface** that the application dynamically composes before every LLM call. Different regions of that surface have different lifecycles, different stability characteristics, and different relationships to prompt caching.

Cortex structures the context window into four distinct regions:

```
┌─────────────────────────────────────────────────┐
│  SYSTEM HEAD                                    │  The system prompt and initial tools
│  Position 0                                     │  (pi keeps them in the transcript)
├─────────────────────────────────────────────────┤
│  SLOT REGION                                    │  Named, persistent, stability-ordered
│  Positions 1..N                                 │  Most stable content at the top
├─────────────────────────────────────────────────┤
│  CONVERSATION HISTORY                           │  Grows organically with the agentic loop
│  Positions N+1..M                               │  Managed by compaction when it grows too large
├ ─ ─ ─ ─ ─ PREFIX CACHE BOUNDARY ─ ─ ─ ─ ─ ─ ─ ┤
│  EPHEMERAL CONTEXT                              │  Rebuilt every LLM call
│  Never persisted                                │  Changes here never invalidate the cache above
├─────────────────────────────────────────────────┤
│  CURRENT PROMPT                                 │  The input for this call
└─────────────────────────────────────────────────┘
```

This layout is not incidental. It is the product of a key optimization: **stable content at the top, volatile content at the bottom**. All major LLM providers (Anthropic, OpenAI, Google) cache the longest unchanged prefix from the start of the request. By placing the most stable content first and the most volatile content last, Cortex maximizes the portion of each request that hits cache.

## Slots: Named, Ordered Context Blocks

Slots are persistent, named content blocks at the start of the message array. They are defined at agent creation with a fixed order. The consumer populates them with whatever content makes sense for their domain.

The ordering is the key design decision. The first slot (position 1, right after the system head) is the most stable and gets the best cache life. Content that rarely changes (identity, credentials, core configuration) goes first. Content that changes more frequently (recent observations, active tasks) goes later. When a slot in the middle updates, the prefix before it survives in cache; only that slot and everything after it incurs a cache miss.

This enables a pattern that would be impossible with a flat context buffer: **the consumer can update a single aspect of context without invalidating everything else.** If only the "goals" slot changes, the identity slot, the user profile slot, and the project context slot all remain cached.

For Animus, this manifests as splitting observation streams into separate slots (thoughts, experiences, messages), each with its own update cadence. When only thought observations compress, the experience and message observation slots remain cached. This granularity is what makes continuous operation cost-effective.

Cortex imposes no formatting on slot content. The consumer provides the full string, including any XML wrapping or structure they choose. Cortex just places it at the right position. This keeps the framework general-purpose while giving consumers complete control over what the model sees.

## Ephemeral Context: Volatile Without Cost

Ephemeral context is content the model should see for a single call but that should not persist in conversation history. In a managed `AgentLoop`, it is injected via `transformContext` at the pre-prompt boundary, below stable slots and old history but before current-loop content.

This placement is intentional: because ephemeral content sits below the stable cached prefix, it can change every single call without invalidating the slots or old conversation history above it. The current prompt remains the final user message, preserving model attention on the active request.

## Compaction: Graceful Context Management

Context grows. For a continuously running agent, it will always eventually exceed the window. Cortex handles this with observational memory: background observer and reflector calls compress older conversation history into structured observations stored in an internal slot, and swap them in for the messages they cover while the most recent messages stay verbatim. This keeps long-running sessions useful without relying on a single large summary blob. Tool result trimming and a failsafe that never drops a message silently run around it.

The key insight is that slots are never touched by compaction. They are managed independently by the consumer and rebuilt from authoritative sources. This means the agent's core context (identity, configuration, observation summaries, goals) survives indefinitely, regardless of how many compaction cycles occur.


## Design Principles

1. **Context is a managed surface, not a chat log.** Structure it, order it for caching, update it granularly.

2. **Stable at the top, volatile at the bottom.** Maximize the prefix cache hit rate across calls.

3. **Graceful compaction, not cliff edges.** Compress old history before context overflow, preserve slots, and keep emergency fallbacks as a safety net.

4. **Mechanism, not policy.** Cortex provides hooks and callbacks. Consumers implement domain-specific logic. No application concerns leak into the framework.

5. **Slots are sacred.** Core context survives indefinitely, independent of conversation history compaction.

6. **No persistence opinions.** The consumer owns storage. Cortex owns the in-memory context surface.

## The Full Picture

Cortex wraps `@earendil-works/pi-agent-core` with production capabilities: MCP tool support, tool permissions, budget guards, a skill system with progressive disclosure, event logging, built-in tools (Bash, TaskOutput, Read, Write, Edit, UndoEdit, Glob, Grep, WebFetch, SubAgent), and multi-provider management with OAuth support.

But the core value, the reason Cortex exists as a separate framework, is the context management layer. The slot system, the ephemeral region, and the compaction system together give consumers fine-grained control over a highly dynamic context surface while maximizing prompt cache stability. For continuously running agents, this is the difference between a viable architecture and one that degrades, costs too much, or simply breaks.
