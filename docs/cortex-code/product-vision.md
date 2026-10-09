# Cortex Code: Product Vision

## What It Is

Cortex Code is a TUI application that provides a conversational interface for working with an AI agent, built on top of the Cortex framework. It is the consumer layer: the first real client that exercises Cortex's full capabilities in production.

The initial focus is a coding agent (code generation, editing, debugging, codebase exploration), but the architecture supports pluggable modes so the same shell can serve different task domains by swapping context, tools, and skills.

## Why It Exists

Cortex provides the engine: the agentic loop, context management, compaction, tools, skills, MCP integration, provider management. But an engine without a vehicle is untestable. We need a thin, functional client to:

1. **Validate Cortex end-to-end.** Put the framework through real usage: long sessions, tool failures, compaction cycles, skill loading, budget limits. Surface bugs and design gaps that unit tests cannot reach.
2. **Provide a usable tool.** A TUI coding agent backed by Cortex's context management and multi-provider support.
3. **Establish the consumer pattern.** Demonstrate how a real application integrates with Cortex: what callbacks to implement, how to manage credentials, how to structure skills and MCP tools, how to persist conversation state.

## Core Principle: Thin Consumer

Cortex Code should remain a thin layer on top of Cortex. The framework owns the hard problems (context, compaction, tools, skills, the agentic loop). Cortex Code owns what a consumer must own:

- **User interface**: Terminal rendering, input handling, streaming display
- **Credential storage**: Persisting API keys and OAuth tokens so Cortex's ProviderManager can retrieve them
- **Skill and MCP configuration**: Opinionated conventions for discovering and loading skills and MCP servers
- **Session persistence**: Saving and restoring conversation history using Cortex's `getConversationHistory()` / `restoreConversationHistory()` hooks
- **Mode system**: Injecting different system prompts, tool sets, and context depending on the active mode (coding, general chat, research, etc.)

If logic could be useful to other Cortex consumers, it belongs in Cortex, not here.

## Modes

The default mode is coding, but the system should support pluggable modes that configure:

- **System prompt**: Identity, domain instructions, behavioral rules
- **Tool set**: Which built-in and MCP tools are available
- **Skill set**: Which skills are advertised and loadable
- **Context slots**: What persistent context the mode injects (project info, codebase summaries, etc.)

A mode is a configuration bundle, not a runtime abstraction. Switching modes reconfigures the agent; it does not require a separate agent instance.

## Credential Storage

Cortex's ProviderManager needs API keys and OAuth tokens but does not store them. Cortex Code must provide a local storage solution that:

- Persists credentials across sessions
- Supports multiple providers (Anthropic, OpenAI, Google, etc.)
- Integrates with Cortex via the `getAuth` callback
- Uses a plaintext file with strict permissions (0600) as the primary store, with opportunistic macOS Keychain integration
- Zero native dependencies (no compilation toolchain required)

## Skill and MCP Conventions

Cortex Code adopts familiar conventions for discoverability:

- **Skills**: Discovered from a `.cortex/skills/` directory (project-local) and `~/.cortex/skills/` (global), using the `SKILL.md` format that Cortex's skill system already supports
- **MCP servers**: Configured via a `.cortex/mcp.json` file (project-local) and `~/.cortex/mcp.json` (global)
- **Project context**: Loaded from an `agents.md` file in the project root, with fallback to `claude.md` if `agents.md` does not exist. File matching is case-insensitive on all platforms (e.g., `AGENTS.md`, `Agents.md`, `agents.md` all match). Injected as a context slot

## Session Persistence

Cortex Code should persist conversation state to enable resuming sessions:

- Use Cortex's `getConversationHistory()` on session end
- Use `restoreConversationHistory()` on session resume
- Store sessions locally (e.g., `~/.cortex/sessions/`)
- Hook into `onLoopComplete` for auto-save

## Slash Commands

Users interact with Cortex Code through natural conversation and slash commands. Typing `/` opens a command picker with fuzzy search. V1 ships with: `/help`, `/clear`, `/compact`, `/model`, `/cost`, `/context-window`, `/resume`, `/login`, `/logout`, `/yolo`, `/exit`. Skills discovered from `.cortex/skills/` directories also appear as slash commands.

## What Success Looks Like

The first milestone is simple: a working TUI where you can have a multi-turn conversation with a Cortex-backed agent, use built-in tools (bash, file read/write/edit, grep, glob), and see the full compaction and context management system operating under real conditions. No polish, no features beyond what is needed to validate the framework.

From there, the product evolves based on what we learn from actually using it.

## What This Is Not

- **Not an IDE.** No file trees, no tabs, no split panes. It is a conversational interface.
- **Not a framework.** It is an application. Application-specific decisions are appropriate here.
- **Not a Cortex fork.** If a capability is general-purpose, it goes in Cortex. Cortex Code only contains consumer-specific logic.
