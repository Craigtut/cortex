# Cortex Code: TUI Design

This document defines the visual design, layout, and interaction patterns for the Cortex Code terminal interface. All designs are built within pi-tui's capabilities: vertical line-based rendering, ANSI truecolor styling, overlay-based dialogs, and keyboard-only interaction (no mouse).

## Brand

**Primary color**: Neon teal (`#00E5CC`)
**Secondary color**: Muted teal (`#008577`) for borders and less prominent elements
**Accent color**: Warm amber (`#FFB347`) for warnings, costs, and attention items
**Error color**: Coral red (`#FF6B6B`)
**Success color**: Green (`#4ADE80`)
**Muted text**: Dim gray (`#6B7280`)

The overall aesthetic is dark terminal with neon teal accents. Clean, minimal, slightly playful.

## Screen Layout

pi-tui uses a vertical stacking model. Components render top-to-bottom as line arrays. The layout is structured as a vertical stack of containers:

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗             │
│  ██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝            │
│  ██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝             │
│  ██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗             │
│  ╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗            │
│   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝            │
│                                                    code          │
│  v0.1.0                                                          │
│  Project: cortex                                                 │
│  Branch: main                                                    │
│  /help for commands                                              │
│                                                                  │
│  ─────────────────────────────────────────────────────────────── │
│                                                                  │
│  Ready for new conversation                                      │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│  ─────────────────────────────────────────────────────────────── │
│  > _                                                             │
│                                                                  │
│  ─────────────────────────────────────────────────────────────── │
│  build │ anthropic/claude-sonnet-4-6    12.4k/200k tokens   main │
└──────────────────────────────────────────────────────────────────┘
```

### Container Stack (top to bottom)

| Container | Content | Scrolls? |
|-----------|---------|----------|
| `headerContainer` | ASCII banner, version, project info, branch | No (rendered once on startup) |
| `borderTop` | Horizontal rule separator | No |
| `chatContainer` | Conversation transcript (messages, tool calls, results) | Yes (main scrollable area) |
| `borderMid` | Horizontal rule separator | No |
| `editorContainer` | Multi-line text input (pi-tui Editor) | No (fixed position) |
| `borderBottom` | Horizontal rule separator | No |
| `footerContainer` | Status bar (mode, model, tokens, branch) | No (always visible) |

The footer "sticks" to the bottom because it is the last child in the vertical stack. Content in `chatContainer` grows upward and scrolls naturally.

## Header (Startup Banner)

Rendered once on session start. Uses Unicode block characters with neon teal (`#00E5CC`) coloring for the "CORTEX" wordmark, with "code" in muted teal to the right or below. Below the banner:

```
v0.1.0
Project: cortex
Branch: main
/help for commands
```

The header scrolls away as conversation progresses. Screen real estate is precious during active work.

## Footer (Status Bar)

Always visible at the bottom. Composed as a single line using manual string padding to simulate columns:

```
 build │ anthropic/claude-sonnet-4-6    12.4k/200k tokens   main
 ╰ mode  ╰ provider/model               ╰ context usage     ╰ git branch
```

Layout (left to right):
- **Mode**: current mode name (e.g., `build`), styled with teal background as a badge
- **Model**: `provider/model-name`, plain text. Amber indicator if in YOLO mode
- **Token usage**: `used/limit tokens` showing current context consumption. Color shifts from green to amber to red as usage increases (thresholds at 50%, 75%, 90%)
- **Git branch**: current branch name, right-aligned

When YOLO mode is active, append a `YOLO` badge in amber after the mode badge:

```
 build  YOLO │ anthropic/claude-sonnet-4-6    12.4k/200k tokens   main
```

## Input Editor

The pi-tui Editor component handles multi-line input with emacs-style keybindings (Ctrl+A/E/K/Y, word movement, undo/redo, bracketed paste). The editor sits between two horizontal rule borders.

**Key bindings:**
- **Enter**: Submit message (single-line input)
- **Shift+Enter** or **Ctrl+J**: New line (multi-line input)
- **Up arrow** (on empty input): Recall previous message
- **Escape**: Cancel current input / close overlay
- **`/`** (as first character): Open slash command picker

## Conversation Transcript

The main scrollable area. Messages are rendered as a vertical sequence of styled blocks.

### User Messages

```
─── You ──────────────────────────────────────────────────────────
Can you refactor the auth module to use async/await?
```

A thin horizontal rule with "You" label in teal, followed by the message text in the default terminal color.

### Assistant Messages

```
─── Cortex ───────────────────────────────────────────────────────
I'll refactor the auth module. Let me start by reading the current
implementation.

  Read src/auth/index.ts ✓
  ╰ 142 lines

Looking at the code, the main changes needed are...

[markdown rendered content with syntax highlighting]
```

A thin horizontal rule with "Cortex" label in teal, followed by streaming markdown content. Tool calls and results appear inline within the assistant's response.

### Tool Calls

Tool calls render inline within the assistant message flow:

**In-progress:**
```
  ⠋ Bash(git status)
```

The braille spinner (pi-tui's Loader component) animates at 80ms intervals. Tool name in bold, args in parentheses as a short summary.

**Completed (success):**
```
  Read src/auth/index.ts ✓
  ╰ 142 lines
```

Green checkmark. Second line (muted, indented) shows a one-line summary of the result. For file reads: line count. For bash: exit code and truncated output. For grep: match count.

**Completed (error):**
```
  Bash(npm test) ✗
  ╰ Exit code 1: 3 tests failed
```

Red X mark. Error summary on the indented line.

**Collapsed output**: tool results are always collapsed to a summary by default. The user can expand full output by selecting the tool result line and pressing Enter (or a designated expand key).

**Expanded output** shows the full result in a dimmed, indented block:

```
  Read src/auth/index.ts ✓
  ╰ 142 lines
  │ 1  import { hash } from 'crypto';
  │ 2  import { db } from '../db';
  │ 3  ...
  │ 40 export function authenticate(token) {
  │ 41   return new Promise((resolve, reject) => {
  │ ...
  │ 142 }
```

### Sub-Agent Display

```
  ⠋ Agent(explore codebase structure)
  ├─ Glob(**/*.ts) ✓  42 files
  ├─ Read src/index.ts ✓
  └─ Grep(export class) ✓  12 matches
```

Tree-drawing characters show nested tool calls within the sub-agent. The top line shows the sub-agent description with a spinner while running. Child tool calls appear as tree nodes with their own status indicators. When completed:

```
  Agent(explore codebase structure) ✓  [6 tools, 3.2k tokens]
  ╰ Found 12 exported classes across 42 TypeScript files
```

Collapses to a summary. Expandable for the full tree.

## Permission Prompts

Rendered inline in the transcript, appended after the last message. Uses a top-border box with clear visual hierarchy: the tool name is a header, the specific action is visually distinct below it.

### Bash Tool

```
  ─── Permission Required ────────────────────────────────────────
  Bash
  npm install express

  ▸ Allow
    Always allow  npm *
  ──
    Deny
```

### File Edit Tool

```
  ─── Permission Required ────────────────────────────────────────
  Edit
  src/auth/index.ts (lines 42-58)

  ▸ Allow
    Always allow  src/auth/*
  ──
    Deny
```

### Web Fetch Tool

```
  ─── Permission Required ────────────────────────────────────────
  WebFetch
  https://api.github.com/repos/owner/repo/pulls

  ▸ Allow
    Always allow  api.github.com
  ──
    Deny
```

For WebFetch, the "always allow" pattern keys off the **domain** (not the full URL). This means allowing `api.github.com` permits all requests to that domain. Subdomains are distinct: allowing `api.github.com` does not allow `github.com`.

### Layout Principles

- **Tool name as header**: the tool name (`Bash`, `Edit`, `WebFetch`) is displayed prominently on its own line, styled bold in the default text color
- **Action on its own line**: the specific command, file path, or URL is displayed below the header in a monospace/code style, giving it clear visual weight
- **Option grouping**: Allow and Always Allow are grouped together (the permissive actions). Deny is separated below with a thin divider line. This reduces accidental denials.
- **Arrow-key navigation**: up/down to select, Enter to confirm
- **Pattern editing**: when the cursor is on "Always allow," the pattern is editable inline. The user can accept the suggested pattern or type a custom one.

### Pattern Generation by Tool

| Tool | Pattern Source | Example |
|------|---------------|---------|
| Bash | First token as prefix (two tokens for package managers) | `git *`, `npm run *` |
| Edit | Directory glob from the file path | `src/auth/*` |
| Write | Directory glob from the file path | `src/components/*` |
| Read | Directory glob from the file path | `docs/*` |
| Glob | The glob pattern itself | `src/**/*.ts` |
| Grep | Tool-wide (no meaningful sub-pattern) | `Grep` (all grep) |
| WebFetch | Domain extracted from the URL | `api.github.com` |
| SubAgent | Tool-wide | `SubAgent` (all sub-agents) |

The user can always edit the pattern. The suggestions are just sensible defaults.

### Prompt Behavior

- The prompt sits inside the scrollable transcript, so the user can scroll up to see context while deciding
- Escape dismisses the prompt and denies the action (same as selecting Deny)
- Only one permission prompt is active at a time (queued)

## Slash Command Picker

Triggered when the user types `/` as the first character in the input editor. Renders as an overlay anchored to `bottom-left`, positioned just above the editor:

```
  ┌─────────────────────────────────────────┐
  │  /co                                    │
  │                                         │
  │  /compact    Trigger context compaction │
  │  /cost       Show token usage and cost  │
  │                                         │
  └─────────────────────────────────────────┘
```

- Shows up to 8 commands at a time, scrollable
- Fuzzy-filtered as the user types after `/`
- Each row: command name (teal) + description (muted)
- Enter to select, Escape to dismiss
- Skills from `.cortex/skills/` appear in the list with a `skill` tag

## Model Selector (`/model`)

Opens an overlay showing both model tiers:

```
  ┌─────────────────────────────────────────────────┐
  │  Model Selection                                │
  │                                                 │
  │  ▸ Primary model    claude-sonnet-4-6           │
  │    Utility model    claude-haiku-4-5 (auto)     │
  │                                                 │
  └─────────────────────────────────────────────────┘
```

**Primary model**: selecting this shows a model picker listing all available models across connected providers. Changing the primary model also re-resolves the utility model automatically.

**Utility model**: selecting this shows models filtered to the same provider as the primary (utility must match the primary's provider). An "(auto)" option at the top restores the default resolution:

```
  ┌─────────────────────────────────────────────────┐
  │  Utility Model (Anthropic)                      │
  │                                                 │
  │  ▸ Auto (claude-haiku-4-5)                      │
  │    claude-haiku-4-5                             │
  │    claude-sonnet-4-6                            │
  │    claude-opus-4-6                              │
  │                                                 │
  └─────────────────────────────────────────────────┘
```

The "(auto)" label in the top-level view indicates the utility model was auto-selected, not manually set. If the user has overridden it, just the model name shows without "(auto)". Changing the primary model resets a manual utility override back to auto.

The footer updates immediately to reflect the new primary model.

## Context Window Selector

`/context-window`. Opens an overlay with selectable context window thresholds based on the current model's maximum:

```
  ┌─────────────────────────────────────────┐
  │  Context Window Limit                   │
  │                                         │
  │    20k   (10%)                          │
  │    40k   (20%)                          │
  │    60k   (30%)                          │
  │    80k   (40%)                          │
  │  ▸ 100k  (50%)                          │
  │    120k  (60%)                          │
  │    140k  (70%)                          │
  │    160k  (80%)                          │
  │    180k  (90%)                          │
  │    200k  (100%) ← current              │
  │                                         │
  └─────────────────────────────────────────┘
```

Cortex supports artificial context window limiting. This overlay provides 10 threshold options at 10% increments of the active model's context window. The footer's token usage display updates to reflect the new limit.

## Error Recovery

All errors follow three principles: show inline in the transcript, auto-recover where possible, and only prompt the user when manual action is required.

### Tool Execution Failure

No special UI. The model sees the error and decides what to do next.

```
  Bash(npm test) ✗
  ╰ Exit code 1: 3 tests failed
```

Red X and error summary. The agent continues its turn and can retry, try a different approach, or ask the user for guidance. No user intervention needed.

### API Rate Limit (429) / Overloaded (529)

Auto-retry with exponential backoff. No user prompt unless max retries are exhausted.

**During auto-retry** (replaces the spinner):
```
  ⠋ Rate limited, retrying in 8s...
```

Countdown updates in-place. Backoff schedule: 2s, 4s, 8s, 16s, 32s (5 retries max).

**After max retries exhausted:**
```
  ─── Error ──────────────────────────────────────────────────────
  API rate limited after 5 retries. Send another message to retry.
```

No interactive prompt. The user can simply send another message (or the same message again) to restart the request. This keeps the flow simple: the user is always in control of when to try again by sending input.

### API Authentication Error (401 / 403)

Credentials have expired or been revoked. Inline error with guidance:

```
  ─── Authentication Error ───────────────────────────────────────
  Anthropic credentials expired.
  Run /login to reconnect.
```

The user runs `/login`, which opens the provider setup flow as an overlay (see `/login` flow below). After re-authenticating, the user sends their message again.

### Network Failure

Connection dropped, DNS failure, timeout, etc.

```
  ─── Connection Error ───────────────────────────────────────────
  Could not reach api.anthropic.com. Check your network connection.
  Send another message to retry.
```

No auto-retry for network errors (unlike rate limits). The issue is likely persistent until the user's network recovers. The user sends another message when ready.

### Stream Interrupted

The model's response was cut off mid-stream (connection dropped during streaming).

```
─── Cortex ───────────────────────────────────────────────────────
I'll refactor the auth module. The key changes are:

1. Convert all callback-based functions to async/aw

  [response interrupted]
```

Whatever was received is displayed. `[response interrupted]` appended in muted text. The user can send another message to continue (e.g., "continue" or re-ask the question). The partial response stays in conversation history so the model has context.

### Compaction Event

Not an error, but an informational inline notification when Cortex automatically compacts context:

```
  ─── Context Compacted ──────────────────────────────────────────
  Reduced from 148k to 62k tokens (microcompaction + summarization)
```

Brief, muted text. Not interactive. The footer token count updates to reflect the new usage.

### Budget Exhaustion

Cortex's budget guards can set token or cost limits. In practice, compaction should prevent hitting the context window ceiling. But if the budget is artificially constrained (via `/context-window` or a hard cost cap) and compaction cannot free enough space, the session reaches its limit.

```
  ─── Context Limit Reached ──────────────────────────────────────
  Context window is full (200k/200k tokens).
  Compaction has already run. Options:

  ▸ Increase context window (/context-window)
    Start a new session (/clear)
```

This should be rare. The primary path is to increase the context window limit if it was artificially constrained, or start fresh. If the model's actual context window is full and compaction has exhausted all three layers, the only option is a new session.

### MCP Server Disconnected

Cortex auto-reconnects MCP servers (3 retries). If reconnection fails:

```
  ─── MCP Server Disconnected ────────────────────────────────────
  Server "postgres-tools" is unavailable. Its tools are disabled.
  Reconnect with /login or restart the session.
```

Muted warning. The session continues without those tools. The agent is informed via its context (the tools simply disappear from its available tool list).

## Keyboard Shortcuts

| Key | Context | Action |
|-----|---------|--------|
| Enter | Editor | Submit message |
| Shift+Enter | Editor | New line |
| Escape | Editor | Cancel input / close overlay |
| Escape | Overlay | Close overlay |
| Up/Down | Overlay | Navigate options |
| Enter | Overlay | Select option |
| Up | Empty editor | Recall previous message |
| Ctrl+C | Anywhere | Interrupt current operation |
| Ctrl+L | Anywhere | Clear screen (re-render) |

## Theming

Cortex Code uses a JSON theme system (implemented at the application level, not in pi-tui). The theme defines ~20 named color slots:

```json
{
  "name": "default",
  "colors": {
    "primary": "#00E5CC",
    "primaryMuted": "#008577",
    "accent": "#FFB347",
    "error": "#FF6B6B",
    "success": "#4ADE80",
    "muted": "#6B7280",
    "border": "#008577",
    "badgeBg": "#00E5CC",
    "badgeText": "#000000",
    "userLabel": "#00E5CC",
    "assistantLabel": "#00E5CC",
    "toolName": "#FFFFFF",
    "toolArgs": "#6B7280",
    "toolSuccess": "#4ADE80",
    "toolError": "#FF6B6B",
    "tokenNormal": "#4ADE80",
    "tokenWarning": "#FFB347",
    "tokenCritical": "#FF6B6B",
    "spinnerColor": "#00E5CC",
    "codeBackground": "#1a1a2e"
  }
}
```

Themes are loadable from `~/.cortex/themes/` and selectable via a future `/theme` command. V1 ships with the default teal theme only.

## First-Run Setup Flow

When the user launches Cortex Code with no credentials configured, the setup flow begins automatically. The goal is to get the user connected to at least one provider as quickly as possible.

### Step 1: Welcome

```
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│   ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗             │
│  ██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝            │
│  ██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝             │
│  ██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗             │
│  ╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗            │
│   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝            │
│                                                    code          │
│                                                                  │
│  Welcome! Let's connect to a provider to get started.            │
│                                                                  │
│  How would you like to connect?                                  │
│                                                                  │
│  ▸ Sign in with OAuth          (quickest)                        │
│    Enter an API key                                              │
│    Connect to Ollama           (local, detected ✓)               │
│    Custom connection                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Three tiers of connection, ordered by ease of use. If Ollama is detected running locally (checked via `GET http://localhost:11434/` with a 2-second timeout on startup), it gets a green checkmark badge and appears prominently.

**Navigation**: Escape goes back one level at any point in the setup flow. From the provider selection screen, Escape returns to the tier selection. From the tier selection, Escape is a no-op (credentials are required to proceed).

### Step 2a: OAuth Provider Selection

If the user picks "Sign in with OAuth":

```
  Select a provider:

  ▸ Anthropic             (Claude models)
    OpenAI Codex          (GPT models)
    Google Gemini         (Gemini models)
    GitHub Copilot        (device flow)
```

Selecting a provider triggers the OAuth flow. pi-ai handles the OAuth callback server and browser redirect. On success:

```
  ✓ Signed in to Anthropic

  Select a primary model:

  ▸ claude-sonnet-4-6     (balanced)
    claude-opus-4-6       (most capable)
    claude-haiku-4-5      (fastest)

  Utility model: claude-haiku-4-5 (auto)
```

### Step 2b: API Key Entry

If the user picks "Enter an API key":

```
  Select a provider:

  ▸ Anthropic              ANTHROPIC_API_KEY
    OpenAI                 OPENAI_API_KEY
    Google                 GEMINI_API_KEY
    xAI (Grok)             XAI_API_KEY
    Groq                   GROQ_API_KEY
    Cerebras               CEREBRAS_API_KEY
    OpenRouter             OPENROUTER_API_KEY
    Mistral                MISTRAL_API_KEY
    Hugging Face           HF_TOKEN
    Other...
```

Provider list shows all API key providers from pi-ai. After selection, the user enters their key directly. The key is stored in `~/.cortex/credentials.json`. Cortex Code does not read API keys from environment variables; all credentials are managed through the credential store to avoid accidentally using keys intended for other tools.

```
  Anthropic API Key:
  > sk-ant-••••••••••••_

  Validating... ✓ Connected

  Select a primary model:
  ▸ claude-sonnet-4-6
    claude-opus-4-6
    claude-haiku-4-5

  Utility model: claude-haiku-4-5 (auto)
```

The API key input masks characters after entry (shows dots). A validation request confirms the key works before proceeding.

### Step 2c: Ollama Connection

If the user picks "Connect to Ollama" (only shown when detected):

```
  ✓ Connected to Ollama at localhost:11434

  Available models:

  ▸ qwen2.5-coder:32b     32B params, Q4_0
    deepseek-coder-v2:16b  16B params, Q4_K_M
    llama3:8b              8B params, Q4_0
    codellama:13b          13B params, Q4_0
```

Ollama detection:
1. On setup start, check `OLLAMA_HOST` env var, fall back to `http://localhost:11434`
2. `GET /` with 2-second timeout to confirm Ollama is running
3. `GET /api/tags` to list available models
4. Connect via pi-ai's OpenAI-compatible API using base URL `http://localhost:11434/v1`

If Ollama is not detected but the user still picks it, show instructions:

```
  Ollama not detected at localhost:11434

  To install Ollama: https://ollama.ai/download
  To start Ollama: ollama serve

  Press any key to retry, or Escape to go back.
```

### Step 2d: Custom Connection

For advanced users connecting to custom OpenAI-compatible endpoints:

```
  Base URL:
  > http://my-server:8080/v1_

  API Key (optional):
  > _

  Connection name:
  > my-server_

  Testing connection... ✓ Connected

  Available models:
  ▸ my-custom-model
```

### Step 3: Setup Complete

```
  ─────────────────────────────────────────────────────────────────
  ✓ Setup complete!

  Provider: Anthropic (OAuth)
  Primary model: claude-sonnet-4-6
  Utility model: claude-haiku-4-5 (auto)

  You can add more providers later with /login
  You can switch models with /model

  Ready for new conversation
  ─────────────────────────────────────────────────────────────────
  > _
```

Credentials are saved to `~/.cortex/credentials.json`. The session transitions directly into the normal chat interface.

### `/login` Flow (Re-authentication and Adding Providers)

`/login` opens an overlay with two paths: re-authenticate an existing provider, or add a new one.

```
  ┌─────────────────────────────────────────────────┐
  │  Login                                          │
  │                                                 │
  │  Connected providers:                           │
  │    Anthropic (OAuth) ── signed in               │
  │    Ollama ── connected                          │
  │                                                 │
  │  ▸ Re-authenticate a provider                   │
  │    Add a new provider                           │
  │                                                 │
  └─────────────────────────────────────────────────┘
```

**Re-authenticate** shows connected providers. Selecting one runs the appropriate flow:

- **OAuth providers**: triggers the OAuth flow again (browser opens, callback server starts). On success, replaces the stored credentials. The user sees: `✓ Re-authenticated with Anthropic`
- **API key providers**: prompts for a new API key. Validates, then replaces the stored key. The user sees the masked input and validation spinner.
- **Ollama**: re-checks the Ollama endpoint. If Ollama has moved to a different host, prompts for the new URL.
- **Custom connections**: prompts for updated base URL and/or API key.

**Add a new provider** runs the same tier selection as the first-run setup (OAuth / API key / Ollama / Custom), rendered as an overlay rather than a full-screen flow.

### `/logout` Flow

`/logout` shows connected providers and lets the user remove one:

```
  ┌─────────────────────────────────────────────────┐
  │  Logout                                         │
  │                                                 │
  │  Remove credentials for:                        │
  │                                                 │
  │  ▸ Anthropic (OAuth)                            │
  │    Ollama                                       │
  │                                                 │
  └─────────────────────────────────────────────────┘
```

Selecting a provider removes its credentials from `~/.cortex/credentials.json` (and from macOS Keychain if stored there). If the removed provider was the active one, prompts the user to switch models via `/model`.

## Model Switch Warning

When `/model` selects a model whose context window is smaller than current token usage, an inline confirmation appears before switching:

```
  ─── Warning ────────────────────────────────────────────────────
  Switching to claude-haiku-4-5 (context: 200k → 200k).
  Current usage: 142k tokens exceeds the new model's window.

  ▸ Run /compact first, then switch
    Switch anyway (compaction will trigger automatically)
    Cancel
```

Arrow-key navigation, Enter to confirm. If the user picks "Run /compact first," compaction runs and the model switch happens automatically after. The warning only appears when current usage exceeds the new model's context window; switching between same-size models proceeds immediately.

## Design Constraints (pi-tui)

These constraints shape the design:

- **Vertical-only layout**: no CSS grid or flexbox. Horizontal composition requires manual string padding within a single component's render output. pi-tui provides `visibleWidth()`, `truncateToWidth()`, and `sliceByColumn()` for Unicode/ANSI-aware string width calculations.
- **No fixed/sticky positioning**: the footer stays visible because it is the last child, not because it is pinned. Cortex Code implements a custom layout container that reserves footer rows and manages the scrollable area's available height.
- **No mouse interaction**: everything is keyboard-driven.
- **Overlays are the only layering mechanism**: dialogs, pickers, and permission prompts that need to float above content use overlays.
- **No built-in scroll container**: Cortex Code implements a custom scroll container for the chat transcript that tracks scroll position and renders a visible window of content.
- **No built-in progress bars or tables**: custom components needed if we want these.
- **Spinner is braille-only**: the Loader component provides the standard braille spinner at 80ms. No other animation primitives. Rate limit countdown text (`Retrying in 8s...`) updates in-place via re-render, not via animation.
- **Resize handling**: pi-tui handles terminal resize automatically. Width changes trigger a full repaint; height changes trigger a viewport update. No consumer-side `SIGWINCH` handling needed.
