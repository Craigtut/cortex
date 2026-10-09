# Per-Tool Renderers: Research and Implementation Plan

> **STATUS: DESIGN/PLANNING** - This document is a design and planning reference, not a description of implemented behavior. It captures research findings and a proposed implementation plan for Cortex Code's per-tool renderer system.

This document covers how production coding agents render tool call results in their terminal UIs, distills best practices, and provides a detailed implementation plan for Cortex Code's per-tool renderer system.

## Table of Contents

1. [Research Findings](#research-findings)
2. [Best Practices](#best-practices)
3. [Recommended Design](#recommended-design)
4. [Implementation Plan](#implementation-plan)
5. [Streaming Considerations](#streaming-considerations)

---

## Research Findings

### Overview of Agents Studied

| Agent | TUI Framework | Language | Rendering Model |
|-------|---------------|----------|-----------------|
| Mastra Code | pi-tui | TypeScript | Imperative, component-based |
| pi-coding-agent | pi-tui | TypeScript | Imperative, pluggable renderers per tool |
| Anthropic CLI | Custom Ink fork (React) | TypeScript | Declarative, React component tree |
| Codex | ratatui | Rust | Immediate-mode, widget-based |

### 1. Mastra Code (github.com/mastra-ai/mastra, `mastracode/`)

Mastra Code uses pi-tui with a single monolithic `ToolExecutionComponentEnhanced` class that switches on tool name to dispatch to per-tool render methods. Source: `mastracode/src/tui/components/tool-execution-enhanced.ts`.

#### Architecture

- **One class, switch-based dispatch**: A single `ToolExecutionComponentEnhanced` container switches on tool name (`renderViewToolEnhanced`, `renderBashToolEnhanced`, `renderEditToolEnhanced`, etc.) to render each tool type differently.
- **Bordered box pattern**: Every tool renders inside a bordered box using Unicode box-drawing characters (`╭──` top, `│` side, `╰──` bottom). The footer line of the box contains the tool name, arguments summary, duration, and status icon.
- **Collapsible by default**: All tool results are collapsed by default. Ctrl+E toggles expand/collapse. Collapsed state shows a configurable number of lines (typically 15-20) with a "... N more lines (ctrl+e to expand)" indicator.
- **Streaming args**: Tool input arguments are streamed via `handleToolInputDelta`, which uses `partial-json` to parse incomplete JSON and update the component as args arrive. This means path and command display start appearing before execution begins.
- **OSC 8 hyperlinks**: File paths are wrapped in OSC 8 terminal hyperlinks (`\x1b]8;;file://...\x07`) so they are clickable in supported terminals (iTerm2, WezTerm, Kitty).

#### Per-Tool Rendering

**File Read (`view`)**:
- Pending: bordered box with just path display and spinner status
- Complete: bordered box with syntax-highlighted content (via `cli-highlight`), line numbers from the view range, file path as OSC 8 clickable link
- Collapsed: first 20 lines shown, "... N more lines" indicator
- Path is truncated from the beginning with ellipsis if too long for terminal width

**File Edit (`string_replace_lsp`)**:
- Pending with partial args: live diff preview as old_str and new_str stream in (shows tail of diff, scrolling new content in at bottom)
- Complete: colored diff (red for removed, green for added), windowed around first change with 3 lines of context before
- LSP diagnostics rendered below the box when available (error/warning/info with severity icons)
- Intra-line changes shown via color only (no inverse/bold highlighting)

**File Write (`write_file`)**:
- Streaming: syntax-highlighted content preview as file content streams in (shows tail, scrolling new lines in)
- Complete: full syntax-highlighted content in bordered box
- Same collapse/expand behavior as view tool

**Bash (`execute_command`)**:
- Streaming: live stdout appended to bordered box as it arrives via `appendStreamingOutput()`, with MAX_LINES=200 rolling window
- Trailing partial line buffered separately from complete lines
- Duration shown in footer after completion
- Exit code shown below box in error color for non-zero exits
- Error detection: checks both `isError` flag and regex pattern matching for common error strings
- Tail-aware: if command includes `| tail -N`, streaming output is limited to N lines to match final result

**Grep/Search**: No dedicated renderer. Falls through to generic tool rendering.

**File Listing (`find_files`)**:
- Bordered box with tree-like output from the file system
- Extracts summary line ("5 directories, 9 files") from output for the footer
- Collapsed to 15 lines by default

**Web Search**:
- Has a dedicated `renderWebSearchEnhanced()` method
- Shows search query and results in bordered box

**Sub-Agent**:
- Dedicated `SubagentExecutionComponent` class with its own bordered box
- Shows task description (word-wrapped, capped at 5 lines when collapsed)
- Rolling window of tool calls within the sub-agent (MAX_ACTIVITY_LINES=15)
- Each nested tool call shows: status icon + tool name + args summary
- Separator line between task description and activity list
- Footer shows: agent type, model ID, duration, status icon
- `collapseOnComplete` option collapses to single footer line after completion

#### Styling

- Background colors set via theme (`toolPendingBg`, `toolErrorBg`, `toolSuccessBg`) on the Box component
- Status indicators: `⋯` (muted) while running, `✓` (green) on success, `✗` (red) on error
- Duration formatted as ms/s/min
- Tool title in bold, args in muted/accent colors

---

### 2. pi-coding-agent (github.com/badlogic/pi-mono, `packages/coding-agent/`)

The pi-coding-agent uses pi-tui with a fundamentally different architecture: a **pluggable renderer system** where each tool definition provides its own `renderCall` and `renderResult` functions.

#### Architecture

- **Tool Definition with Renderers**: Each tool exports a `ToolDefinition` that includes `renderCall(args, theme, context)` and `renderResult(result, options, theme, context)` functions alongside the execution logic.
- **Extension-overridable**: Any extension can replace the built-in tool renderers by re-registering the tool with custom render functions while delegating execution to the original.
- **ToolExecutionComponent**: A generic container that delegates to `callRenderer` and `resultRenderer` from the tool definition. Falls back to generic display (tool name + JSON args) when no renderer exists.
- **Separate BashExecutionComponent**: Bash gets its own dedicated component class with streaming output, live loader, and dynamic borders.
- **Background color state**: The component box background color changes based on state: pending (dim), success (green tint), error (red tint).

#### Per-Tool Rendering

**File Read**:
- Call: `read path/to/file:offset-end` with path in accent color, range in warning color
- Result: syntax-highlighted content (via `highlightCode` function that understands file extensions)
- Collapsed: 10 lines, with "(N more lines, [key] to expand)" hint
- Truncation info shown when file was too large
- Supports image files: renders images inline using Kitty/iTerm2 protocol

**File Edit**:
- Call: `edit path/to/file` with optional edit count
- Result: word-level intra-line diff using the `diff` npm package
  - Removed text: red with inverse styling on changed tokens
  - Added text: green with inverse styling on changed tokens
  - Context lines: dim/gray
- Diff is generated from the tool's `details.diff` field (unified diff format)
- Line numbers included in the diff output
- Tabs replaced with spaces for consistent rendering

**File Write**:
- Call: `write path/to/file (N lines)` showing line count from content
- Streaming: syntax-highlighted content preview with incremental highlighting (first 50 lines get full multi-line highlight, rest get per-line highlight for performance)
- Result: "Written" on success, error message on failure
- Highlight cache maintained across updates to avoid re-highlighting unchanged prefix

**Bash**:
- Dedicated `BashExecutionComponent` with `DynamicBorder` wrapper
- Streaming: live output appended via `appendOutput()`, stripped of ANSI codes
- Loader component with spinner while running, showing cancel keybinding hint
- Collapsed: 20-line preview (PREVIEW_LINES constant), width-aware visual truncation
- Expanded: shows all available lines
- Status line shows: hidden line count, cancelled/error status, truncation warning with path to full output file
- Different border color for excluded-from-context commands (!! prefix)

**Grep**:
- Call: `grep /pattern/ in path (glob, limit N)` with pattern in accent, path in output color
- Result: match output as text, collapsed to 10 lines
- Shows match limit indicator and truncation info
- No special syntax highlighting on results

**Find/Glob**:
- Call: `find pattern in path (limit N)`
- Result: file list as text, collapsed to 10 lines
- Shows result limit and truncation info

**Web Search**: No built-in renderer (falls through to generic).

**Sub-Agent**: Not a built-in concept in pi-coding-agent at the tool level.

#### Key Design Pattern: Expandable Results

Every tool result follows the same expand/collapse pattern controlled by the `ToolRenderResultOptions.expanded` boolean. The `keyHint()` function renders the expand keybinding inline as a styled hint. This is consistent across all tools.

---

### 3. Anthropic CLI

Anthropic's CLI agent was built on a custom fork of Ink (React-based terminal rendering). While not open-source, details are available from the March 2026 source disclosure and public documentation.

#### Architecture

- **React component tree**: Every UI element is a React component rendered via a custom Ink reconciler
- **Virtual DOM**: Terminal "nodes" (Box, Text) are reconciled and diffed against the previous frame
- **Custom Yoga layout**: Full Flexbox layout engine ported to TypeScript
- **Collapsible tool output blocks**: Standard component for all tool results with streaming status
- **Word-level diffs**: `StructuredDiffFallback` component for edit operations
- **Syntax highlighting**: `HighlightedCodeFallback` with LRU cache for performance
- **Optimized rendering**: Cursor position tracking, ANSI code deduplication, EL sequences for SSH performance

#### Per-Tool Rendering (from public documentation and leaked source analysis)

**File Read**:
- Shows file path and line count in collapsed view
- Syntax highlighted content when expanded
- Line numbers displayed
- Truncation indicator for large files

**File Edit**:
- Collapsed: shows file path, line range, and change summary (e.g., "+5 -3")
- Expanded: unified diff with word-level highlighting on changed tokens
- Green checkmark on success, red X on failure

**File Write**:
- Shows file path and status
- Content preview when expanded

**Bash/Shell**:
- Real-time streaming of stdout/stderr
- Spinner animation while running
- Exit code and duration on completion
- Output collapsed by default with expand capability
- Truncated output for very long commands

**Grep/Search**:
- Match count in collapsed summary
- Grouped by file with context lines when expanded

**Glob/File Listing**:
- File count in summary
- Flat list when expanded

**Sub-Agent**:
- Shows nested tool calls as indented items
- Progress indicator while running
- Summary (tool count, token usage) on completion

#### Key Design Choices

- Background colors per status state (pending/success/error)
- Consistent collapse/expand across all tools
- Duration tracking on all tool calls
- File paths as clickable hyperlinks in supported terminals

---

### 4. Codex (OpenAI, github.com/openai/codex, `codex-rs/`)

Codex uses ratatui (Rust) for its TUI, with a fundamentally different approach based on "history cells" and "exec cells".

#### Architecture

- **History cells**: Each conversation event (user message, assistant message, tool call, etc.) is a `HistoryCell` trait object that produces `Vec<Line<'static>>` for display
- **ExecCell grouping**: Multiple related read/list/search commands are grouped into an "exploring" cell, displayed as a single collapsed block
- **Parsed command types**: Commands are parsed into `ParsedCommand` variants (Read, ListFiles, Search, Unknown) to drive rendering
- **Streaming controller**: A `StreamController` manages newline-gated streaming with animation (lines are queued and committed one-at-a-time for a typewriter effect)
- **Theme-aware diffs**: Diff backgrounds adapt to terminal background lightness (dark vs light theme auto-detection)
- **Multiple color level support**: Truecolor, 256-color, and 16-color palettes for diffs

#### Per-Tool Rendering

**Exploring Group (Read/List/Search)**:
- Multiple read-only commands grouped under a single "Exploring" / "Explored" header
- Active: shimmer-animated bullet + "Exploring" in bold
- Complete: dim bullet + "Explored" in bold
- Consecutive Read commands are merged into a single line: `Read file1, file2, file3`
- ListFiles: `List path`
- Search: `Search query in path`
- All items indented under `└` tree prefix
- No output content shown (purely structural summary)

**Single Command (Bash)**:
- Header: bullet + "Running"/"Ran"/"You ran" + syntax-highlighted bash command
- Bash commands are syntax-highlighted using a dedicated `highlight_bash_to_lines` function
- Output: dimmed text, head+tail truncation with "... +N lines" ellipsis in the middle
- Default limit: 5 lines for agent commands, 50 for user shell commands
- Output lines are ANSI-escaped (preserving terminal colors from command output)
- Status: green bullet on success, red bullet on failure
- Duration shown on completion
- "(no output)" in dim text when command produces no output

**Diff Rendering** (separate from exec cells):
- Dedicated `diff_render.rs` module for file change visualization
- Three `FileChange` variants: Add, Delete, Update
- Line numbers right-aligned with gutter sign (+/-/space)
- Syntax highlighting preserved within hunks (cross-line parser state maintained per hunk)
- Dark theme: muted green (`#213A2B`) and red (`#4A221D`) backgrounds
- Light theme: GitHub-style pastels (`#dafbe1` green, `#ffebe9` red)
- Word-level wrapping with style preservation across splits
- Separate gutter background colors for line numbers on light themes

**Spinner/Animation**:
- Truecolor: shimmer animation on bullet character
- Fallback: alternating bullet/circle dim blink (600ms interval)
- Animation can be disabled

#### Key Design Choices

- **Grouping over individual display**: read/list/search commands are grouped as "exploring" rather than shown individually
- **Head+tail truncation**: shows first N and last N lines with ellipsis, not just head or tail
- **No expand/collapse interaction**: output is statically truncated (no user-driven expand)
- **Viewport-aware line counting**: uses `Paragraph::line_count` with wrap to measure actual rows, not logical lines
- **Adaptive wrapping**: long lines are wrapped at column boundaries with style preservation

---

## Best Practices

### Patterns That Work Well Across All Agents

1. **Bordered boxes for tool output**: Mastra Code's bordered box pattern (`╭──`/`│`/`╰──` with footer summary) is the most visually clean and information-dense approach. The pi-coding-agent and Anthropic's CLI use background color blocks instead, which can be harder to distinguish at a glance.

2. **Streaming args display**: Both Mastra Code and pi-coding-agent stream partial tool arguments as they arrive, so the user sees the file path or command before execution begins. This significantly improves perceived responsiveness.

3. **Collapsible results with consistent keybinding**: All agents except Codex support expand/collapse. The pi-coding-agent's approach of embedding the keybinding hint inline ("(N more lines, [key] to expand)") is the most discoverable.

4. **Per-tool call rendering during streaming**: Showing the tool call header (tool name + key args) immediately when the tool starts, before results arrive, tells the user what is happening without waiting for completion.

5. **Syntax highlighting on file content**: All agents apply syntax highlighting to file read/write content. The pi-coding-agent's approach of caching highlights and doing incremental updates for streaming is the most performance-conscious.

6. **Word-level intra-line diff highlighting**: Both pi-coding-agent and Codex highlight the specific changed words/tokens within modified lines (using inverse styling or background color). This is significantly more useful than line-level coloring alone.

7. **File paths as OSC 8 hyperlinks**: Mastra Code wraps file paths in OSC 8 hyperlinks for click-to-open in supported terminals. This is a small addition with high UX value.

8. **Head+tail truncation for shell output**: Codex's approach of showing the first N and last N lines of output (with an ellipsis in the middle) is better than showing only the tail, because error context often appears at the top of output.

9. **Grouping read-only commands**: Codex's "Exploring" pattern that merges consecutive read/list/search commands into a single visual block is excellent for reducing noise during exploration phases.

10. **Duration tracking**: All agents track and display execution duration. This is essential for identifying slow operations.

### Patterns to Avoid

1. **No expand/collapse**: Codex's static truncation with no user-driven expansion is limiting. Users frequently need to see full output.

2. **Generic JSON dump for unknown tools**: When no renderer exists, showing raw JSON args and result text (as the pi-coding-agent fallback does) is acceptable but could be improved.

3. **Monolithic switch statement**: Mastra Code's single 1000+ line class with a switch on tool name is hard to maintain. The pi-coding-agent's pluggable renderer approach is better architecture.

---

## Recommended Design

### Design Principles

1. **Bordered box is the universal container**: Every tool result renders inside a bordered box with a footer summary line. This creates consistent visual rhythm.
2. **Pluggable per-tool renderers**: Each tool defines its own renderer functions (call + result), following the pi-coding-agent pattern. Unknown tools fall back to a generic renderer.
3. **Streaming from the start**: Tool components appear as soon as tool input streaming begins, updating progressively as args and results arrive.
4. **Collapse by default, expand on demand**: All tool results are collapsed by default. Ctrl+E toggles. Collapsed state shows enough context to understand what happened.
5. **Consistent status indicators**: `⋯` (running), `✓` (success), `✗` (error) in the footer of every tool box.

### Per-Tool Renderer Specifications

#### File Read

**Collapsed (default)**:
```
╭──
│  1  import { useState } from 'react';
│  2  import { useEffect } from 'react';
│  3  
│  ...
│  20 export default App;
│  ... 122 more lines (ctrl+e to expand)
╰── read ~/src/App.tsx:1-142 ✓ 0.3s
```

- Syntax highlighted via `cli-highlight` or equivalent, language inferred from file extension
- Line numbers from the offset/range, right-aligned
- Path shortened with ~ for home directory, wrapped in OSC 8 hyperlink
- Range shown after path (`:1-142` or `:50-75`)
- Footer: `read` + path + range + status + duration
- Collapsed: 20 lines, then "... N more lines" indicator
- Pending state: just the footer line with `⋯` status

**ASCII Mockup (pending)**:
```
╭──
╰── read ~/src/App.tsx ⋯
```

#### File Edit

**Collapsed (default)**:
```
╭──
│    const [count, setCount] = useState(0);
│  - const value = count * 2;
│  + const value = useMemo(() => count * 2, [count]);
│    return <div>{value}</div>;
│  ... 3 more lines (ctrl+e to expand)
╰── edit ~/src/App.tsx:15 ✓ 0.2s
```

- Unified diff with red for removals, green for additions, dim for context
- Word-level intra-line highlighting using inverse/bold on changed tokens
- Windowed around first change: 3 context lines before, rest after (collapsed to ~15 lines)
- Footer: `edit` + path + first changed line number + status + duration
- LSP diagnostics shown below the box when available:
  ```
  ✓ No LSP issues
  ```
  or:
  ```
  ✗ L15:3 'useMemo' is not defined
  ⚠ L20:1 Unused import 'useEffect'
  ```

**During streaming (partial args)**:
```
╭──
│  - const value = count * 2;
│  + const value = useMemo(() => cou
╰── edit ~/src/App.tsx:15 ⋯
```
Shows the diff preview as old_str and new_str stream in, with new content scrolling in at the bottom.

#### File Write

**Collapsed (default)**:
```
╭──
│  1  {
│  2    "name": "cortex",
│  3    "version": "0.1.0",
│  ...
│  20   "dependencies": {
│  ... 45 more lines (ctrl+e to expand)
╰── write ~/package.json ✓ 0.1s
```

- Syntax-highlighted content
- Same collapse/expand as read
- Footer: `write` + path + status + duration

**During streaming (content arriving)**:
```
╭──
│  ... 12 lines above (ctrl+e to expand)
│  18   "devDependencies": {
│  19     "vitest": "^2.0.0",
│  20     "typescript": "^5.
╰── write ~/package.json ⋯
```
Shows tail of content as it streams in.

#### Bash/Shell

**Collapsed (default, success)**:
```
╭──
│  PASS  tests/auth.test.ts (3 tests)
│  PASS  tests/user.test.ts (7 tests)
│  ... +42 lines ...
│  Test Suites: 12 passed, 12 total
│  Tests:       48 passed, 48 total
╰── $ npm test ✓ 4.2s
```

- Head+tail truncation: show first 3 and last 2 lines with "... +N lines ..." in the middle (collapsed)
- ANSI color codes from command output preserved
- Duration in footer
- Lines truncated at terminal width to prevent soft wrap

**Collapsed (error)**:
```
╭──
│  src/auth.ts:42:5 - error TS2345: Argument of type
│    'string' is not assignable to parameter of type 'number'.
│  
│  Found 1 error in src/auth.ts:42
╰── $ npm run typecheck ✗ 1.8s
    Exit code: 1
```
- Error status in red, exit code shown below the box
- More lines shown on error (first 5 + last 5 instead of 3+2)

**During streaming**:
```
╭──
│  PASS  tests/auth.test.ts
│  PASS  tests/user.test.ts
│  RUN   tests/compaction.test.ts
╰── $ npm test ⋯
```
- Live output appended as it arrives
- Rolling window of ~20 visible lines during streaming (older lines scroll off top)
- Partial lines buffered until newline

#### Grep/Search

**Collapsed (default)**:
```
╭──
│  src/auth/index.ts
│    15: export function authenticate(token: string) {
│    42: export function validateToken(token: string) {
│  src/auth/middleware.ts
│    8:  import { authenticate } from './index';
│  ... 7 more matches (ctrl+e to expand)
╰── grep /authenticate/ in src/ ✓ 0.1s  12 matches
```

- Results grouped by file, with file path as a header line
- Match lines show line number and content
- Match count in footer
- Pattern shown in the footer with grep-style `/pattern/` notation
- Collapsed to ~10 result lines

#### Glob/File Listing

**Collapsed (default)**:
```
╭──
│  src/
│    auth/
│      index.ts
│      middleware.ts
│    tools/
│      bash.ts
│      read.ts
│  ... 28 more files (ctrl+e to expand)
╰── glob **/*.ts in src/ ✓ 0.0s  42 files
```

- Tree-style indented display when possible, flat list as fallback
- File count in footer
- Collapsed to ~12 lines

#### Web Fetch

**Collapsed (default)**:
```
╭──
│  HTTP 200 OK (text/html, 45.2 KB)
│  Title: Express - Node.js web application framework
│  
│  Express is a minimal and flexible Node.js web
│  application framework that provides a robust set of
│  ... 120 more lines (ctrl+e to expand)
╰── fetch https://expressjs.com ✓ 1.2s
```

- HTTP status, content type, and size in first line
- Page title extracted if HTML
- Content truncated to first ~8 lines collapsed
- Domain shown in footer (not full URL unless short)

#### Sub-Agent

**During execution**:
```
╭──
│  Investigate the auth module structure and identify
│  all exported functions.
│  ───
│  ✓ glob **/*.ts in src/auth/  8 files
│  ✓ read src/auth/index.ts
│  ⋯ grep /export/ in src/auth/
╰── subagent research (claude-haiku-4-5) ⋯
```

- Task description at top (word-wrapped, capped at 5 lines)
- Separator line between task and activity
- Rolling window of nested tool calls (most recent 15)
- Each nested call: status icon + tool name + key args summary
- Footer: `subagent` + agent type + model + duration + status

**After completion (collapsed)**:
```
╰── subagent research (claude-haiku-4-5) ✓ 8.2s  [6 tools]
```
Single footer line with tool count summary. Expandable to show full activity log.

#### Generic (unknown/MCP tools)

**Collapsed (default)**:
```
╭──
│  { "result": "success", "data": { ... } }
╰── mcp:postgres/query ✓ 0.5s
```

- Tool name (with MCP namespace prefix if applicable)
- Args shown as compact JSON on the call line
- Result shown as formatted text or JSON
- Collapsed to ~5 lines

---

## Implementation Plan

### Architecture: Pluggable Renderer Registry

```typescript
interface ToolRenderer {
  /** Render the tool call header (shown immediately when tool starts) */
  renderCall(args: unknown, context: ToolRenderContext): ToolCallDisplay;
  /** Render the tool result (shown after completion or during streaming) */
  renderResult(result: ToolResult, context: ToolRenderContext): ToolResultDisplay;
}

interface ToolCallDisplay {
  /** Lines to show inside the bordered box (above the footer) */
  contentLines: string[];
  /** The footer summary: tool name + args summary */
  footerText: string;
}

interface ToolResultDisplay {
  /** Lines to show inside the bordered box */
  contentLines: string[];
  /** Updated footer text (may include duration, match count, etc.) */
  footerText: string;
  /** Lines to show below the box (e.g., LSP diagnostics) */
  belowBoxLines?: string[];
}

interface ToolRenderContext {
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
  termWidth: number;
  maxContentWidth: number; // termWidth minus border and indent
  theme: Theme;
  streamingOutput?: string; // For bash streaming
  duration?: number;
}
```

### pi-tui Components Used

| Component | Usage |
|-----------|-------|
| `Container` | Base class for ToolExecutionComponent |
| `Box` | Content area with indent |
| `Text` | All text rendering (tool output, headers, footers) |
| `Spacer` | Vertical spacing between tool blocks |
| `Loader` | Braille spinner for pending state (only in streaming contexts like bash) |

### Custom Components to Build

| Component | Purpose | Complexity |
|-----------|---------|------------|
| `BorderedBox` | Reusable bordered box with top/bottom/side borders and footer | Medium |
| `SyntaxHighlighter` | Wrapper around `cli-highlight` with language detection and caching | Low |
| `DiffRenderer` | Word-level intra-line diff with configurable context lines | Medium |
| `CollapsibleContent` | Content with line-limit truncation and expand/collapse state | Low |
| `ToolExecutionComponent` | Container that wires bordered box + renderer + state management | Medium |
| `SubAgentComponent` | Specialized component for sub-agent nested tool display | Medium |
| `StreamingOutputBuffer` | Manages rolling window of streaming shell output | Low |

### Build Order

**Phase 1: Foundation (2-3 days)**

1. `BorderedBox` component
   - Renders `╭──` top border, `│` left border per content line, `╰── footerText` bottom border
   - Accepts content lines and footer text
   - Handles terminal width, truncation at width boundary
   - Status icon rendering (⋯/✓/✗) in footer

2. `CollapsibleContent` utility
   - Takes array of content lines, collapsed line limit, expanded boolean
   - Returns truncated lines + "... N more lines (ctrl+e to expand)" indicator
   - Supports head-only, tail-only, and head+tail truncation modes

3. `ToolExecutionComponent` container
   - Manages lifecycle: pending -> streaming -> complete
   - Dispatches to registered renderer
   - Handles expand/collapse state
   - Wires up with chatContainer for inline display

4. Renderer registry
   - Map of tool name to `ToolRenderer`
   - Fallback generic renderer for unknown tools
   - MCP tools use namespace-prefixed names

**Phase 2: Core Tool Renderers (3-4 days)**

5. `ReadToolRenderer`
   - `SyntaxHighlighter` integration (language from file extension)
   - Line number formatting
   - OSC 8 hyperlink wrapping
   - Path shortening (home directory -> ~)

6. `EditToolRenderer`
   - `DiffRenderer` for unified diff output
   - Word-level intra-line diff (using `diff` npm package or equivalent)
   - Context windowing around first change
   - LSP diagnostic display below box

7. `WriteToolRenderer`
   - Syntax-highlighted content preview
   - Streaming content display (tail-following)

8. `BashToolRenderer` + `StreamingOutputBuffer`
   - Live streaming output display
   - Rolling window (configurable, default 200 lines)
   - Head+tail truncation for final display
   - Partial line buffering
   - ANSI code passthrough from command output
   - Exit code display

**Phase 3: Secondary Tool Renderers (2-3 days)**

9. `GrepToolRenderer`
   - File-grouped results
   - Match count in footer
   - Pattern display

10. `GlobToolRenderer`
    - Tree-style or flat list display
    - File count in footer

11. `WebFetchToolRenderer`
    - HTTP status/content type/size
    - Title extraction
    - Content preview

12. `SubAgentRenderer`
    - Nested tool call tracking
    - Rolling activity window
    - Collapse-on-complete behavior

13. `GenericToolRenderer`
    - JSON formatting for args and results
    - MCP namespace display

**Phase 4: Polish (1-2 days)**

14. Streaming args integration
    - Wire up `partial-json` parsing for streaming tool input
    - Update call display as args arrive

15. Duration tracking
    - Start timer on tool_start, stop on tool_end
    - Format and display in footer

16. Global expand/collapse toggle
    - Ctrl+E toggles the focused/most-recent tool
    - Track expanded state per tool call ID

### Estimated Total Complexity

| Phase | Days | Risk |
|-------|------|------|
| Phase 1: Foundation | 2-3 | Low (well-understood patterns) |
| Phase 2: Core renderers | 3-4 | Medium (diff rendering, streaming) |
| Phase 3: Secondary renderers | 2-3 | Low (variations on established patterns) |
| Phase 4: Polish | 1-2 | Low |
| **Total** | **8-12** | |

The main risk is in the streaming bash output integration, which requires careful coordination between the tool execution event pipeline and the TUI component lifecycle.

### File Structure

```
packages/cortex-code/src/tui/
  renderers/
    types.ts                 # ToolRenderer interface, ToolRenderContext, etc.
    registry.ts              # Renderer registry, lookup, fallback
    bordered-box.ts          # BorderedBox component
    collapsible-content.ts   # Collapse/expand utility
    syntax-highlighter.ts    # cli-highlight wrapper with caching
    diff-renderer.ts         # Word-level diff rendering
    streaming-buffer.ts      # Rolling window output buffer
    read-renderer.ts         # ReadToolRenderer
    edit-renderer.ts         # EditToolRenderer  
    write-renderer.ts        # WriteToolRenderer
    bash-renderer.ts         # BashToolRenderer
    grep-renderer.ts         # GrepToolRenderer
    glob-renderer.ts         # GlobToolRenderer
    web-fetch-renderer.ts    # WebFetchToolRenderer
    sub-agent-renderer.ts    # SubAgentRenderer
    generic-renderer.ts      # GenericToolRenderer (fallback)
    task-output-renderer.ts  # TaskOutputRenderer
  components/
    tool-execution.ts        # ToolExecutionComponent (container)
```

---

## Streaming Considerations

### Which Tools Benefit from Streaming Renders

| Tool | Streaming Value | Approach |
|------|----------------|----------|
| Bash/Shell | **Critical** | Real-time stdout/stderr appending. Users need to see command progress live. |
| File Write | **High** | Content preview as it streams in. Shows what is being written before completion. |
| File Edit | **High** | Diff preview as old_str/new_str stream in. Shows what will change before execution. |
| Sub-Agent | **High** | Nested tool call activity list updates as sub-agent works. |
| File Read | **Low** | Result arrives all at once after file read completes. Streaming adds little value. |
| Grep/Search | **Low** | Results arrive all at once. No benefit from partial display. |
| Glob/File Listing | **None** | Instant completion. No streaming needed. |
| Web Fetch | **Low** | Could show HTTP status before body, but body arrives quickly. |

### Streaming Implementation Strategy

**Tier 1: Real-time streaming (bash)**
- Tool emits `shell_output` events with stdout/stderr chunks
- Component appends to rolling buffer, rebuilds display on each chunk
- Uses `requestRender()` to trigger TUI repaint

**Tier 2: Args-based progressive rendering (edit, write)**
- Tool input arguments stream via `tool_input_delta` events
- Component parses partial JSON with `partial-json`
- Rebuilds call display as path, content, old_str, new_str become available
- For write: shows syntax-highlighted content as it arrives
- For edit: shows diff preview as both strings become available

**Tier 3: Activity tracking (sub-agent)**
- Sub-agent emits tool_start/tool_end events for nested calls
- Component maintains activity list, updates on each event
- Rolling window of recent activity (oldest entries scroll off)

**Tier 4: Completion-only rendering (read, grep, glob, web fetch)**
- Show pending state (footer with ⋯) until result arrives
- Render full result on completion
- No intermediate updates needed

### Performance Considerations

1. **Rebuild throttling**: For bash streaming, cap rebuilds to ~10/second to avoid excessive rendering. Buffer chunks and rebuild on a 100ms debounce.

2. **Highlight caching**: Cache syntax-highlighted output keyed on (content hash, language). For streaming write, use incremental highlighting (highlight new lines only, not full content).

3. **Line truncation at width**: Always truncate content lines to terminal width minus border characters. This prevents soft-wrapping which doubles the effective line count and breaks the bordered box alignment.

4. **ANSI passthrough**: For bash output, preserve ANSI color codes from the command. Use `strip-ansi` only for width calculations, not for display.

5. **Partial JSON parsing**: The `partial-json` package can throw on malformed input. Wrap all parse calls in try/catch and silently ignore failures (the next delta will usually fix the parse).
