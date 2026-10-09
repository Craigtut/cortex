# Cortex Code: Architecture

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript (strict, ESM) | Matches Cortex, shared tooling |
| Runtime | Node.js 24+ | Same requirement as Cortex |
| Agent framework | `@animus-labs/cortex` | The whole point |
| TUI rendering | `@earendil-works/pi-tui` | Lightweight, imperative, same ecosystem as pi-agent-core |
| Credential storage | Plaintext file (0600) + opportunistic macOS Keychain | Zero native deps, industry standard |
| File locking | `proper-lockfile` | Prevents corruption from concurrent instances |
| Testing | Vitest | Matches monorepo conventions |
| Distribution | npm global install | Standard for CLI tools in this category |

## Why pi-tui Over Ink

Ink is a React reconciler for the terminal. It brings React 19+, `yoga-layout` (Flexbox), and 20+ transitive dependencies. That is a lot of machinery for what is fundamentally a scrolling transcript with an input editor.

`@earendil-works/pi-tui` is an imperative TUI library (~1,200 lines core) from the same ecosystem as `pi-agent-core`. It uses differential rendering (full repaint, line-diff, or character-diff) with synchronized output for flicker-free updates. Components implement `render(width): string[]` and optionally `handleInput(data)`. It ships built-in components for text, markdown, editor input, select lists, images, overlays, and dialogs.

The trade-offs:

- **pi-tui wins on**: weight (~5 runtime deps vs 20+), direct terminal control, ecosystem alignment with pi-agent-core, simplicity of the rendering model
- **Ink wins on**: declarative composition, Flexbox layout, React ecosystem familiarity, community size
- **pi-tui lacks**: a layout engine, React hooks/context, third-party component libraries

For a coding agent TUI, pi-tui's built-in components (Editor, Markdown, overlay system) cover the core needs directly. The imperative model gives precise control over streaming LLM output. We do not need Flexbox or a component ecosystem.

pi-tui is pre-1.0 (v0.65), which is a risk. Multiple production coding agents use pi-tui successfully, which reduces this risk.

### pi-tui Capabilities Confirmed

pi-tui handles several concerns that are critical for Cortex Code:

- **Terminal resize**: Automatic. pi-tui registers a `SIGWINCH` listener and triggers a full repaint on width changes (text wrapping recalculates). Height changes trigger a viewport update. No consumer-side resize handling needed.
- **String width utilities**: Built-in `visibleWidth()`, `truncateToWidth()`, `wrapTextWithAnsi()`, and `sliceByColumn()` handle Unicode, East Asian wide characters, emoji, and ANSI escape codes. The footer's manual column padding can use these directly.
- **Differential rendering**: Three-strategy system (full render, viewport update, incremental update). Incremental mode diffs output lines and redraws only changed lines using synchronized output (`\x1b[?2026h...l`) for flicker-free updates.

**Gaps Cortex Code must fill:**
- **Sticky footer/header**: pi-tui has no fixed-position primitives. The footer stays visible because it's the last child in the vertical stack, but Cortex Code needs a custom container that reserves footer rows and manages the scrollable area's height.
- **Scroll container**: pi-tui does not provide a scroll container. The chat transcript needs a custom component that tracks scroll position, renders a visible window of content, and handles scroll keybindings.

## Distribution Strategy

**Primary: npm global install**

```bash
npm install -g @animus-labs/cortex-code
```

This is the standard approach for CLI tools in this category. The target audience (developers) has Node.js installed.

**Secondary (future): compiled binary**

Bun's `bun build --compile` can produce self-contained executables with no runtime dependency. This is appealing for zero-install distribution but has edge-case compatibility gaps with some Node.js APIs today. Worth revisiting once the tool is stable.

**On-demand execution** via `npx @animus-labs/cortex-code` can serve as a "try it now" entry point but is not suitable as the primary method due to cold-start overhead on every invocation.

## CLI Interface

```bash
cortex                               # Start interactive session in CWD
cortex-code                          # Alias for cortex
cortex --resume [session-id]         # Resume last (or specific) session
cortex --model <model>               # Override default model
cortex --yolo                        # Start in YOLO mode (bypass permissions)
```

## High-Level Architecture

Three-layer separation. Each layer has a single concern:

```
┌─────────────────────────────────────────────────────────┐
│  TUI Layer (pi-tui)                                     │
│  Rendering, input, streaming display, overlays          │
│                                                         │
│  ┌───────────┐  ┌───────────┐  ┌─────────────────────┐ │
│  │ Transcript │  │ Input     │  │ Overlays            │ │
│  │ (markdown) │  │ (editor)  │  │ (permissions,       │ │
│  │            │  │           │  │  slash commands)     │ │
│  └─────┬─────┘  └─────┬─────┘  └──────────┬──────────┘ │
└────────┼───────────────┼───────────────────┼────────────┘
         │               │                   │
┌────────┼───────────────┼───────────────────┼────────────┐
│  Session Controller                                     │
│  Agent lifecycle, persistence, event routing,           │
│  credential retrieval, permission rule management       │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐   │
│  │ Session   │  │ Config   │  │ Permission         │   │
│  │ Lifecycle │  │ & Creds  │  │ Rules              │   │
│  └─────┬────┘  └─────┬────┘  └─────────┬──────────┘   │
└────────┼──────────────┼─────────────────┼──────────────┘
         │              │                 │
┌────────┼──────────────┼─────────────────┼──────────────┐
│  Cortex Framework                                      │
│                                                        │
│  ┌─────────────────────────────────────────────────┐  │
│  │  AgentLoop                                      │  │
│  │  (agentic loop, tools, compaction, skills)      │  │
│  └─────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────┐  │
│  │  ProviderManager                                │  │
│  │  (provider discovery, model resolution)         │  │
│  └─────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

**Why three layers, not two:** Collapsing the session controller and TUI into a single component creates a monolith. The session controller handles business logic (agent lifecycle, persistence, permissions); the TUI handles rendering. Mixing them creates maintenance problems as features grow.

## Key Components

### Session Controller

The composition root for one interactive session (`src/session.ts`). It creates the `CortexAgent` and the TUI, owns the lifecycle (start, input dispatch, resume, abort, shutdown), and delegates each concern to a collaborator that owns it:

| Concern | Owner |
|---------|-------|
| Agent config handed to `CortexAgent.create()` | `session/agent-config.ts` |
| Model, provider, utility model, thinking effort | `session/model-selection.ts` |
| `getAuth` credentials over the pi-ai credential store | `providers/api-key-resolver.ts` |
| Tool and network permission prompts, one prompt at a time | `permissions/prompt-broker.ts` |
| Sandbox rung and status | `session/sandbox-state.ts` |
| Trust gates for project MCP servers, hooks and skills | `session/trust-gates.ts` |
| MCP config hot reload between turns | `mcp/reload-scheduler.ts` |
| Busy state, keyed on the facade's work settlement | `session/work-tracker.ts` |
| Submitting a turn (steer vs fresh prompt, pre_turn hooks) | `session/turn-runner.ts` |
| Routing agent events to the TUI, activity stream and transcript | `session/agent-events.ts`, `session/tool-events.ts` |
| Which resident loop an event came from (duplex) | `session/loop-routing.ts` |
| Composite persistence, startup and turn-boundary checkpoints, resume loading | `persistence/session-checkpoints.ts` |
| Footer state and the model's `<environment>` block | `session/status-view.ts` |

Collaborators are built in the constructor and read the agent and the TUI through getters, because both are created later by `start()`.

The session controller lives inside Cortex Code, not in a separate package. Cortex itself is the shared abstraction; it provides the consumer-agnostic hooks (`getApiKey`, `transformContext`, `getConversationHistory`, etc.) and each consumer wires them to its own world. A hypothetical web consumer would need entirely different orchestration (HTTP transport, multi-user sessions, server-side auth).

**Session resume** uses a create-fresh-and-hydrate pattern: start a new agent, then hand the saved composite state to the facade's all-or-nothing `restore()`. `restore()` refuses while a loop is running, so a `/resume` typed mid-turn fails loudly instead of splicing history out from under it.

### Session Activity Surface

Cortex Code writes a local runtime activity surface for external supervisors, dashboards, launchers, and wrappers. This is a product-neutral integration contract owned by Cortex Code, not Cortex core. Cortex core remains in-memory and only emits lifecycle events.

Activity files live beside the existing session persistence files:

```text
~/.cortex/sessions/{sessionId}/
  meta.json
  history.json
  activity/
    state.json
    events.jsonl
    events.1.jsonl
    events.2.jsonl
    events.3.jsonl
```

`activity/state.json` is the authoritative current state for late attach. It is written with atomic replace and contains:

- `sessionId`, matching the session directory name
- `status`: `working`, `awaiting_input`, `awaiting_permission`, `done`, or `error`
- `updatedAt` and monotonic `sequence`
- current turn metadata
- active tool summaries
- pending permission details, including `displaySummary` and sanitized `args`
- latest visible error
- final exit information for closed sessions

`activity/events.jsonl` is an append-only lifecycle stream. It records:

- `status_changed`
- `turn_started` and `turn_ended`
- `tool_call_started` and `tool_call_ended`
- `permission_requested` and `permission_resolved`
- `error`

Completion events include `durationMs` when Cortex Code can compute it. Permission requests include a human-readable `displaySummary` so external readers can render a safe one-line prompt without understanding every tool's argument schema. Permission `args` are sanitized before persistence: shell commands and small primitive fields are preserved, while large file contents and edit replacements are represented with previews, byte counts, line counts, and truncation flags.

The event log rotates at 5 MB into `events.1.jsonl`, `events.2.jsonl`, and `events.3.jsonl`. Readers should use `state.json` for current state and treat JSONL as a best-effort activity history. If a reader sees an incomplete trailing line, it should ignore that line until the next write.

### TUI Layer

Built on pi-tui. The rendering surface has a simple structure:

- **Header**: Status bar (active mode, model, token usage, session info)
- **Transcript**: Scrollable conversation history rendered as markdown
- **Input editor**: Multi-line input at the bottom

The TUI subscribes to Cortex's event bridge for real-time updates (streaming tokens, tool execution, compaction events).

#### Streaming Markdown

Uses a stable-prefix algorithm for efficient rendering. Maintains a mutable offset tracking the last complete top-level markdown block boundary. On each streaming token delta, only re-lexes and re-renders text after that boundary. Everything before it is frozen. Rendering cost is `O(unstable_suffix)`, not `O(full_text)`.

#### Tool Call Display

- **In-progress**: Single line `[spinner] ToolName(args summary)` (e.g., `[...] Bash(git status)`)
- **Completed**: Results collapsed to a summary line (e.g., "Read 3 files"). Expandable on demand.

This keeps the transcript clean during tool-heavy sessions. Tool arguments are rendered as a short inline summary, not the full input.

#### Sub-Agent Display

Sub-agents render inline using box-drawing tree characters with a one-line activity summary:

```
SubAgent(description)
└─ Last action: Grep(pattern)  [3 tools] [1.2k tokens]
```

Full sub-agent transcripts are available via a detail view, not inline.

#### Permission Prompts

Permission requests render **inline in the transcript**, not as a modal overlay. This preserves scrollback access so the user can review context while deciding. The prompt appears as a top-bordered box appended after the last message, with arrow-key navigation to select an option.

### Slash Commands

Typing `/` in the input editor triggers a command picker overlay. The picker shows all available commands in a scrollable list, filtered by fuzzy search as the user types. Each entry shows the command name and a short description.

**V1 commands:**

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear transcript |
| `/compact` | Trigger context compaction |
| `/model` | Switch primary or utility model |
| `/cost` | Show token usage and cost summary |
| `/context-window` | Adjust artificial context window limit (10% increments) |
| `/resume` | Pick and resume a previous session |
| `/login` | Add a provider (re-runs provider setup flow) |
| `/logout` | Remove credentials for a provider |
| `/yolo` | Toggle YOLO mode (bypass permissions) |
| `/exit` | Exit the application |

Commands are registered as simple objects with a name, description, and handler. Skills discovered from `.cortex/skills/` directories also appear in the command picker as `/skill-name`.

### Mode System

A mode is a static configuration object:

```typescript
interface Mode {
  name: string;
  systemPrompt: string;
  tools: ToolConfig[];
  skills: SkillDiscoveryConfig;
  contextSlots: SlotDefinition[];
  mcpServers: McpServerConfig[];
}
```

V1 ships with a single **build** mode, which is the default. It configures:
- A coding-focused system prompt (see `context-design.md`)
- All built-in tools are automatically registered by Cortex (no mode-level tool configuration needed)
- Skill discovery from `.cortex/skills/` and `~/.cortex/skills/`
- MCP servers from `.cortex/mcp.json` and `~/.cortex/mcp.json`
- A `project-context` slot populated from `agents.md` / `claude.md`

Additional modes can be added later as we learn what different context configurations are useful.

### Permission System

**How it works**: Cortex Code provides a `resolvePermission` callback to AgentLoop, which wires it into pi-agent-core's `beforeToolCall` hook. The hook is fully async: pi-agent-core `await`s the result before proceeding with tool execution. This means Cortex Code can return a Promise from `resolvePermission` that blocks until the user makes a decision in the TUI, with no Cortex-level changes required.

```typescript
// Simplified permission flow
const resolvePermission = async (toolName: string, toolArgs: unknown) => {
  // 1. Check persisted allow/deny rules
  const rule = rules.match(toolName, toolArgs);
  if (rule) return { decision: rule.decision };

  // 2. No matching rule: show inline prompt, suspend until user decides
  return new Promise<CortexToolPermissionResult>((resolve) => {
    tui.showPermissionPrompt(toolName, toolArgs, (decision) => {
      resolve(decision);
    });
  });
};
```

**Default behavior**: every tool call prompts for approval ("ask" mode).

**YOLO mode**: enabled via `--yolo` flag or `/yolo` slash command. Sets the `resolvePermission` callback to always return `{ decision: 'allow' }`, bypassing permission prompts. YOLO mode does NOT bypass safety checks built into tools themselves. Specifically, the Bash tool's 7-layer safety system (`runSafetyChecks()`) runs inside the tool's `execute()` function, completely independent of `beforeToolCall`. This includes critical path protection, command classification, obfuscation detection, and the auto-mode classifier. Write and Edit tools enforce read-before-write checks inside `execute()` as well. First YOLO activation shows a confirmation dialog.

**Permission prompt options** (displayed inline with arrow-key selection):

1. **Allow**: approve this one call
2. **Deny**: reject this one call
3. **Always allow `<pattern>`**: add a persistent allow rule

**Pattern generation for "always allow"**: for Bash, a narrow command prefix is used (`git status` suggests `git status *`, `npm run build` suggests `npm run *`). For file tools, the pattern is the path or a directory glob.

**Rule format**: `ToolName(pattern)`. Examples:
- `Bash(git *)`: allow all git commands
- `Bash(npm run *)`: allow all npm run scripts
- `Edit(src/*)`: allow edits to files under src/
- `WebFetch(api.github.com)`: allow all requests to a domain
- `Bash`: allow all bash commands (no pattern = tool-wide)

**Rule storage**: `allow` and `deny` lists stored per source:
- **Session**: in-memory, cleared on exit
- **Project**: persisted to user-owned workspace settings under `~/.cortex/workspaces/<workspace-hash>/settings.json`
- **User**: persisted to `~/.cortex/settings.json`

Scope precedence is session, then project, then user. Deny rules win within the same scope.

### Config and Credentials

**Configuration** lives in `~/.cortex/config.json` (global) and `.cortex/config.json` (project-local). Project config overrides global config for overlapping keys.

#### Credential Store

Credentials are stored at `~/.cortex/credentials.json` with file mode `0600`. On macOS, the credential store opportunistically attempts to use the system Keychain via the `security` CLI as the preferred backend, falling back to the file if Keychain operations fail. On Linux, the file is used directly.

This approach uses zero native dependencies and matches the industry standard (gh CLI, aws-cli, gcloud all use chmod 600 files).

**File schema:**

```typescript
interface CredentialFile {
  version: 1;
  defaultProvider: string | null;
  defaultModel: string | null;
  providers: Record<string, CredentialEntry>;
}

interface CredentialEntry {
  provider: string;                    // e.g., 'anthropic', 'openai', 'custom'
  method: 'oauth' | 'api_key' | 'custom';
  // API key auth:
  apiKey?: string;
  // OAuth auth (opaque blob from ProviderManager, stored as-is):
  oauthCredentials?: string;
  oauthMeta?: {                        // Display-safe, stored unencrypted
    displayName?: string;
    expiresAt?: number;
    refreshable: boolean;
  };
  // Custom connection:
  baseUrl?: string;
  modelId?: string;
  connectionName?: string;
  // Metadata:
  addedAt: number;                     // Unix timestamp ms
  lastUsed?: number;                   // Updated on each successful API call
}
```

OAuth credential blobs from ProviderManager are stored as-is in the JSON file. ProviderManager's docs describe them as "opaque blobs the consumer should encrypt," but for a local CLI tool, file-level protection (0600 permissions + optional Keychain) matches industry practice. The blobs contain access tokens and refresh tokens; Keychain storage is preferred when available.

**CredentialStore interface:**

```typescript
interface CredentialStore {
  /** Load all credentials from disk. */
  load(): Promise<CredentialFile>;

  /** Get a specific provider's credentials. */
  getProvider(providerId: string): Promise<CredentialEntry | null>;

  /** Save or update a provider's credentials. Acquires file lock. */
  setProvider(providerId: string, entry: CredentialEntry): Promise<void>;

  /** Remove a provider's credentials. */
  removeProvider(providerId: string): Promise<void>;

  /** Get/set default provider and model. */
  getDefaults(): Promise<{ provider: string | null; model: string | null }>;
  setDefaults(provider: string, model: string): Promise<void>;
}
```

**`getAuth` callback flow:**

The credential store is also pi-ai's `CredentialStore` (`read`, `list`, `modify`, `delete`), and Cortex's `ProviderManager` is built over it (`new ProviderManager({ credentials: credentialStore })`). The session hands the agent a `getAuth` callback (`providers/api-key-resolver.ts`):

- A local endpoint (provider id `custom` from `createCustomModel()`, or `ollama`) gets no answer: its model carries its connection's key, set from the stored entry when the model is resolved, and Cortex sends that key (or a placeholder for a keyless server) when the callback supplies none. Nothing is borrowed from the session's provider entry, so a model that outlives a provider switch keeps its own key.
- Every other provider resolves through `providerManager.getAuth(provider)`: an API key straight from the file or the Keychain, or an OAuth token pi refreshes inside the store's `modify`. `modify` holds the credentials file's lock (stale after 30 seconds, waited for up to 30 seconds), and pi checks again under it whether the token still needs refreshing, so concurrent requests in one session and other `cortex` processes refresh a rotating token once. This replaced an in-process single-flight and a re-read-and-retry loop for refresh races between processes.
- No stored credential is an error ("Run /login to connect"). Provider environment variables are never read: Cortex ignores them unless a consumer opts in.

`cortex -p` uses the same resolver.

**File locking**: credential and session files are protected with `proper-lockfile` to prevent corruption from concurrent Cortex Code instances. The library uses atomic `mkdir`-based locks with stale-lock detection and automatic cleanup on crash. Locks are acquired for writes only; reads do not lock. `credentials.json` is replaced whole (a temp file renamed over it), so a lock-free reader or a crash never sees half a file, and a file that does not parse is an error rather than an empty store. The dependency cost is minimal (~30KB, 3 transitive deps).

### Project Context Discovery

Project context files are discovered by walking from CWD upward to the filesystem root. At each directory, the system lists files and checks for case-insensitive matches against:

1. `agents.md` (any casing: `AGENTS.md`, `Agents.md`, etc.)
2. `claude.md` (fallback if no `agents.md` match; any casing: `CLAUDE.md`, `Claude.md`, etc.)

Implementation: at each directory level, read the directory listing once and match filenames via `toLowerCase()`. This ensures consistent behavior across case-sensitive (Linux) and case-insensitive (macOS) filesystems.

All found files are collected and concatenated root-first, closest-last. This handles monorepos naturally: a root-level `agents.md` provides base instructions, and a package-level `agents.md` adds more specific context. There is no structured merge or override mechanism; all files are included in full.

A global context file at `~/.cortex/agents.md` is also loaded (lowest priority).

The merged content is injected as a named context slot. See `context-design.md` for how this fits into the overall context architecture.

### Provider Setup

Cortex Code has no default provider. On first run, a setup flow guides the user through connecting to at least one provider. Three tiers, ordered by ease of use:

1. **OAuth** (quickest): Anthropic, OpenAI Codex, Google Gemini, GitHub Copilot. pi-ai handles the OAuth callback server and browser redirect.
2. **API key**: All pi-ai providers (Anthropic, OpenAI, Google, xAI, Groq, Cerebras, OpenRouter, Mistral, Hugging Face, etc.). Key is validated before saving.
3. **Ollama** (local): Auto-detected through `/api/tags` at `http://localhost:11434` (or `OLLAMA_HOST`) with a 2-second timeout. Uses Cortex's dedicated Ollama provider and `/api/chat` for inference. Requires Ollama 0.15.0 or newer. There is no transport selector. See [Ollama integration](../cortex/ollama.md).
4. **Custom connection**: Any OpenAI-compatible endpoint with a custom base URL.

Users can add more providers later via `/login` and remove them via `/logout`. See `tui-design.md` for the full setup flow UX.

pi-ai supports 22 providers total. Cortex Code surfaces them through the setup flow; it does not need to know about provider internals beyond passing the right credentials to Cortex's ProviderManager.

### Skill and MCP Discovery

**Skills** follow Cortex's `SKILL.md` format. Cortex Code discovers them from:
- `.cortex/skills/` in the current project
- `~/.cortex/skills/` for global skills
- Skills bundled with the active mode

**MCP servers** are configured in JSON:
- `.cortex/mcp.json` in the current project
- `~/.cortex/mcp.json` for global servers

The schema uses named server entries with command, args, and env fields.

**MCP lifecycle**: all configured MCP servers are started on session initialization. Cortex handles the full lifecycle internally: subprocess spawning (stdio transport), tool discovery, automatic reconnection (3 retries), and cleanup on shutdown. Cortex Code reads the MCP config files, iterates entries, and calls `cortexAgent.connectMcpServer(serverName, config)` for each.

### Session Persistence

Sessions are stored at `~/.cortex/sessions/<session-id>/`:
- `history.json`: Conversation history from `getConversationHistory()`
- `meta.json`: Mode, model, timestamps, token counts

**Auto-save strategy:**

| Trigger | What is saved | Why |
|---------|---------------|-----|
| `onLoopComplete` event | Full session (history + meta) | Primary checkpoint after each complete agent loop |
| Graceful shutdown (first Ctrl+C, `/exit`, SIGTERM) | Full session | Preserve work before exit |
| `turn_end` event | Full session | Crash resilience: if the process dies mid-loop, the last completed turn is preserved |

Auto-save writes are debounced (500ms) to avoid excessive I/O during rapid tool execution loops. The `turn_end` save is important because a single agent loop can run for minutes (many tool calls); without it, a crash mid-loop loses all progress since the last `onLoopComplete`.

The `/resume` command lists available sessions and lets the user pick one to resume. Resuming creates a fresh agent instance and hydrates it with the saved history.

### Model Tiers

Cortex has two model tiers:

- **Primary model**: used for the main agentic loop and compaction summarization
- **Utility model**: used for lightweight internal operations (WebFetch page summarization, safety classification)

The utility model auto-resolves to a sensible default per provider (e.g., Haiku for Anthropic, GPT-4.1-nano for OpenAI, Gemini Flash Lite for Google). Most users never need to think about it.

During setup, the user selects only a primary model. The utility model is set automatically. The `/model` command exposes both tiers for power users (see TUI design doc for the overlay layout).

### Model Switching

The `/model` command calls `cortexAgent.setModel()` for primary changes and `cortexAgent.setUtilityModel()` for utility changes. Both work mid-session without restart. Changing the primary model also re-resolves the utility model automatically (unless the user has manually overridden it). pi-ai's `transformMessages()` handles cross-provider message format compatibility automatically (strips provider-specific signatures, normalizes tool call IDs, downgrades encrypted thinking blocks to plain text on provider switch).

**Note**: `setUtilityModel()` does not exist in Cortex yet. This is a small enhancement to add to Cortex to support independent utility model changes at runtime.

**Context window warning**: if the user selects a model whose context window is smaller than the current token usage, an inline confirmation prompt appears before switching:

```
  ─── Warning ────────────────────────────────────────────────────
  Switching to claude-haiku-4-5 (context: 200k → 200k).
  Current usage: 142k tokens exceeds the new model's window.

  ▸ Run /compact first, then switch
    Switch anyway (compaction will trigger automatically)
    Cancel
```

If the user proceeds without compacting first, compaction triggers automatically on the next prompt. The model switch itself is immediate; it does not require compaction to complete first.

### Signal Handling

| Signal | Behavior |
|--------|----------|
| First Ctrl+C (SIGINT) | Abort the current agent loop (`agent.abort()`). Auto-save the session. Return to the input editor. |
| Second Ctrl+C within 2 seconds | Force exit (`process.exit(1)`). The first Ctrl+C already saved the session. |
| SIGTERM | Graceful shutdown: auto-save session, call `agent.destroy()` (cleans up MCP subprocesses), exit cleanly. |

The double-Ctrl+C pattern is standard for CLI tools (npm, vitest, etc.). The 2-second window resets after each Ctrl+C.

### Concurrent Instances

Multiple Cortex Code instances can run concurrently in the same project directory. Each instance operates independently:

- **Sessions**: Each instance creates its own session ID. No session sharing. Two instances in the same CWD produce two separate sessions in `~/.cortex/sessions/`.
- **Credentials**: Read at startup and on `getAuth` calls. Writes (from `/login`, `/logout`, OAuth refresh) acquire a file lock via `proper-lockfile`. Concurrent reads are lock-free. An OAuth refresh runs inside the lock, after checking again that the token still needs it, so two instances never refresh the same token.
- **Config files**: Read at startup. Not watched for changes during the session. Changes made by one instance are not visible to another until restart.
- **MCP servers**: Each instance spawns its own MCP server subprocesses. There is no sharing. This means a plugin MCP server may run multiple times concurrently, which is fine for stateless servers but could cause issues for servers that hold exclusive resources (e.g., a database lock). This is a known limitation documented for users.
- **Permission rules**: Project-level rules are loaded from user-owned workspace settings at startup. Session-scoped rules are in-memory and per-instance. If two instances both write persistent rules, last-write-wins applies.

## File Structure (Planned)

```
packages/cortex-code/
  src/
    index.ts              # Entry point, CLI arg parsing
    session.ts            # Session composition root and lifecycle
    session/              # Session collaborators (see Session Controller)
    tui/
      app.ts              # Top-level TUI layout
      transcript.ts       # Conversation display (streaming markdown)
      input.ts            # User input editor
      status.ts           # Header/status bar
      permissions.ts      # Inline permission prompt component
      tool-display.ts     # Tool call/result rendering
      command-picker.ts   # Slash command overlay
    modes/
      build.ts            # Default build mode
      types.ts            # Mode interface
    commands/
      index.ts            # Command registry
      help.ts             # /help
      clear.ts            # /clear
      compact.ts          # /compact
      model.ts            # /model
      cost.ts             # /cost
      context-window.ts   # /context-window
      resume.ts           # /resume
      login.ts            # /login
      logout.ts           # /logout
      yolo.ts             # /yolo
      exit.ts             # /exit
    config/
      config.ts           # Config loading and merging
      credentials.ts      # Credential storage (file + keychain)
    providers/
      setup.ts            # First-run setup flow
      ollama.ts           # Ollama auto-detection
    permissions/
      rules.ts            # Allow/deny/ask rule management
      patterns.ts         # Pattern matching and prefix extraction
    persistence/
      sessions.ts         # Session save/restore
    discovery/
      context.ts          # agents.md / claude.md walk-up discovery
      skills.ts           # Skill discovery
      mcp.ts              # MCP server discovery
```

## Error Recovery

All errors are inline notifications in the transcript. Auto-recover where possible, prompt the user only when manual action is required.

| Scenario | Recovery | User action |
|----------|----------|-------------|
| Tool execution fails | Model sees error, decides next step | None |
| API rate limit (429) / overloaded (529) | Cortex auto-retries with exponential backoff (5 retries max) | Send another message after max retries |
| API auth error (401/403) | None (credentials expired) | Run `/login` to re-authenticate |
| Network failure | None (likely persistent) | Fix network, send another message |
| Stream interrupted | Display partial response | Send another message to continue |
| Compaction fires | Automatic (Cortex handles) | None (informational notification) |
| Context limit reached | Compaction already exhausted | Increase limit via `/context-window` or `/clear` |
| MCP server crash | Cortex auto-reconnects (3 retries) | Session continues without those tools |

**Rate limit retry ownership**: Retry logic is handled by Cortex, not Cortex Code. Cortex wraps `prompt()` with automatic retry for transient errors (`rate_limit`, `server_error`, `network`) using `agent.continue()` from pi-agent-core with exponential backoff (default: 5 retries, 2s/4s/8s/16s/32s). This is necessary because provider-level retry coverage is inconsistent (some SDKs retry, others don't). Cortex emits `onRetry` and `onRetriesExhausted` events. Cortex Code subscribes to these for TUI feedback (countdown display, final error message). See the Cortex `error-recovery.md` doc for the full retry design.

Users extend tool capabilities through MCP servers configured in `.cortex/mcp.json`.

See `tui-design.md` for full error state visual designs.

## Testing Strategy

Cortex Code uses Vitest, matching the monorepo convention. The testing approach is split by layer.

### Unit Tests

These exercise pure logic with no TUI or Cortex agent involved. Mock filesystem operations and AgentLoop where needed.

| Module | What to test | Approach |
|--------|-------------|----------|
| `permissions/rules.ts` | Rule matching, pattern globbing, precedence (session > project > user), deny override behavior | Pure functions, no mocks |
| `permissions/patterns.ts` | Pattern extraction from tool args (bash prefix, directory globs, domain extraction) | Pure functions |
| `config/credentials.ts` | Read/write round-trip, file locking, OAuth entry handling, Keychain fallback path | Mock `fs` and `child_process` (for `security` CLI) |
| `config/config.ts` | Config merging (project overrides global), missing file handling | Mock `fs` |
| `discovery/context.ts` | Walk-up discovery, case-insensitive matching, root-first concatenation order, global file inclusion | Mock `fs` with virtual directory tree |
| `discovery/skills.ts` | Skill directory scanning, SKILL.md detection | Mock `fs` |
| `discovery/mcp.ts` | MCP config parsing, server entry validation | Pure functions |
| `commands/index.ts` | Command registry, fuzzy search filtering | Pure functions |
| `persistence/sessions.ts` | Save/restore round-trip, debouncing, stale session cleanup | Mock `fs` |
| `session.ts` and `session/` | Agent lifecycle, settlement-keyed busy state, checkpointing, duplex event routing, model switch flow | Real `CortexAgent` over a scripted pi agent (`tests/helpers/duplex-harness.ts`) |

### Component Render Tests

pi-tui components implement `render(width): string[]`, returning plain string arrays. This makes visual output directly testable via snapshot tests without running a real terminal.

| Component | What to test |
|-----------|-------------|
| `tui/status.ts` | Footer renders correct columns, YOLO badge, token color thresholds |
| `tui/tool-display.ts` | In-progress spinner line, completed checkmark/X, collapsed summary format |
| `tui/permissions.ts` | Permission prompt renders correct options, pattern suggestion per tool type |
| `tui/command-picker.ts` | Fuzzy filtering, skill entries appear with tag |

Snapshot tests: capture `render(80)` and `render(120)` output for each component state. Review snapshots on changes to catch unintended layout regressions.

### Integration Tests

Test the session controller's integration with a real (but minimal) AgentLoop. These are slower and may require network access for provider validation.

| Scenario | What to test |
|----------|-------------|
| Session round-trip | Create session, send a message, save, create new instance, restore, verify history intact |
| Provider setup | Mock ProviderManager, verify credential store is populated correctly for each auth method |
| Permission flow | Verify resolvePermission callback suspends, resumes on mock user input, rule is persisted |

### What Is NOT Tested in V1

- **TUI interaction flows** (keyboard navigation, scroll behavior, overlay stacking): These require a terminal emulator harness. Deferred until the TUI stabilizes.
- **End-to-end agent conversations**: Tested implicitly by using the tool. Cortex itself has unit test coverage for the agentic loop.
- **Streaming markdown rendering**: Tested visually during development. Snapshot tests for the markdown component can be added once the stable-prefix algorithm is implemented.
