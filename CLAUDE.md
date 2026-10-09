# Cortex

**Organization**: Animus Labs (`@animus-labs` on npm)

Production-grade agent infrastructure built on `pi-agent-core`. Cortex wraps `@earendil-works/pi-agent-core` into a full-featured agent framework with capabilities the core deliberately omits: MCP tool support, tool permissions, budget guards, context compaction, a skill system, event logging, built-in tools, and provider management.

## Key Principle

**Cortex is a general-purpose framework, not an application.** It must never contain application-specific logic. If a consumer needs Cortex to do something domain-specific, Cortex provides a hook or callback that the consumer implements. If no suitable hook exists, add a general-purpose hook that any consumer could use.

## Monorepo Structure

```
/packages
  /cortex       - Core agent framework (published as @animus-labs/cortex)
  /cortex-code  - Coding agent built on Cortex (in development)
/docs           - Architecture docs, tool references, development plans
```

## Tech Stack

- Node.js 24+, TypeScript strict, ESM
- `@earendil-works/pi-agent-core` + `@earendil-works/pi-ai` for the agentic loop and model access
- `@modelcontextprotocol/sdk` for MCP protocol support
- `typebox` for JSON schema
- `@vscode/ripgrep` for fast file searching
- Vitest for testing

## The Cortex Package (`@animus-labs/cortex`)

Three main exports:

- **`CortexAgent`**: The composite agent consumers interact with, and the entry point most consumers want. Owns the session log, persistence, and settlement, and routes to one or more `AgentLoop` instances. Defaults to duplex: a fast talker loop fronting a persistent reasoner. `mode: 'passthrough'` is the single-loop opt-out and the parity baseline. See `docs/cortex/cortex-agent.md` for the consumer surface and `docs/cortex/duplex/` for the design.
- **`AgentLoop`**: The loop primitive. The agentic loop, tools, context management, compaction, skills. Always-warm session, no cold/warm state machine. Role-neutral by design: the same class runs as talker, reasoner, and sub-agent.
- **`ProviderManager`**: Provider discovery, OAuth flows, API key validation, model resolution. Wraps pi-ai's multi-provider ecosystem. Independent of the other two.

### Key Design Patterns

- **No persistence**: Cortex is in-memory only. It provides `getConversationHistory()`, `restoreConversationHistory()`, and `onLoopComplete` hooks. The consumer decides where and when to persist.
- **No application logic**: No thoughts, emotions, personas, goal tracking, or decision handling. Those are consumer concerns.
- **Callback-driven integration**: `getApiKey` callback for credentials, `beforeToolCall` hook for permissions, `transformContext` for ephemeral context injection, `onObservation`/`onReflection`/`onMemoryGap` for domain-specific coordination with memory.
- **Consumer-provided system prompt**: Cortex appends operational rules after the consumer's content. The consumer owns identity and domain instructions.

### Architecture Highlights

- **Context Management**: Named slots for organizing context, slot-based composition, prefix caching optimization
- **Built-in Tools**: Bash, Read, Write, Edit, Glob, Grep, WebFetch, SubAgent, TaskOutput (auto-registered, disable via `disableTools` config)
- **Tool Permissions**: Per-tool permission modes (off/ask/always_allow), pre-execution callbacks
- **Compaction**: Observational memory (background observer/reflector with async buffering) swaps observations in for older messages and keeps a verbatim tail. Cache-aware microcompaction (tool result trimming) and a failsafe (view truncation, overflow drop with a recorded gap) back it up. Classic summarization was removed.
- **Skills**: Progressive disclosure system (advertise/load/use), SKILL.md format, dynamic context injection
- **MCP**: Unified MCP client for integrating external tool servers
- **Budget Guards**: Token and cost limits to prevent runaway execution
- **Event Bridge**: Normalized event stream for logging and observability

### Sanitized Boundary

**Cortex must never import from any consumer package.** Consumers import from Cortex, never the reverse. Platform sandbox backends belong in `packages/cortex/src/sandbox/`, with CortexAgent owning opt-in setup and cleanup. Framework dependencies, including the pinned sandbox runtime, are declared in `packages/cortex/package.json`.

## Development Guidelines

### Running Locally

```bash
# Prerequisites: Node.js 24+
npm install

# Build
npm run build

# Type check
npm run typecheck

# Tests
npm run test:run
```

### Testing Requirements

Every feature must have unit test coverage. Use Vitest for testing.

```bash
npm run test        # Watch mode
npm run test:run    # Single run
npm run test:coverage
```

### Code Style

- Use TypeScript strict mode
- Validate all external input with Zod schemas
- Keep functions small and focused
- Prefer composition over inheritance
- Use meaningful variable names
- Add comments only for non-obvious logic

### Writing Style

- **Never use em dashes** when writing copy. Use alternative punctuation (commas, colons, semicolons, parentheses, or separate sentences) instead.

### Commit Conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/).

**Format (single line only, no body, no footer, no co-authors):**
```
<type>(<scope>): <description>
```

**Examples:**
```
feat(cortex): add adaptive threshold to compaction manager
fix(cortex-code): show rejected edits as errors in TUI
docs(cortex): sync documentation with implemented codebase
refactor(cortex): extract provider registry into separate module
```

**Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `style`

**Scopes:** `cortex`, `cortex-code`, `docs`, `ci`, `release`

**Rules:**
- Single line only. No message body, no footer, no `Co-Authored-By`.
- Commit early and often. Small, focused commits are preferred.
- Each commit should be one logical change.
- Write in imperative mood: "add feature" not "added feature".
- Keep the first line under 100 characters.
- Always use `git commit -m "..."` with a single-line message.
- Do not use branches. Commit directly to the working branch; never create feature branches.

**Git safety:**
- Never run a bare `git stash pop` or `git stash drop`. The stash may hold unrelated work-in-progress that is not yours, and a bare pop takes whichever entry happens to be on top. To set your own changes aside temporarily, copy the file instead, or use `git stash push -- <paths>` and pop that specific entry by name.
- To check whether a test genuinely fails against pre-change code, revert only the source file (keep the test) with `git show HEAD:<path> > <path>` and restore it afterwards. Do not stash. **Only when the file is clean, and gate on it rather than eyeballing it.** Put `git diff --quiet -- <path> || { echo "dirty, use a worktree"; exit 1; }` in front of any mutate-then-restore sequence: if anything else is already modified there, the restore discards it. A printed warning is not enough, because the evidence arrives as one routine line in a wall of output and nobody reads those adversarially; two incidents on this branch happened with the tell already on screen. On a dirty file use a detached worktree (`git worktree add --detach <dir> HEAD`) and mutate there, so the shared tree is never touched. Note a stray file inside a worktree produces `TS2307` walls in worktree typechecks that look like branch failures.
- **When more than one agent is working the repo, commit through a private index.** The shared index is global mutable state and the pre-commit hook holds it for the length of a full typecheck, so even `git add … && git commit` in one shell invocation leaves your content exposed for twenty-odd seconds, and any concurrent commit takes it. Both ordinary forms fail, differently: `git commit -- <path>` bypasses the index but commits the *worktree* content of that path, sweeping up another agent's in-flight edit to the same file; `git add` + `git commit` snapshots your file safely but exposes you to the shared index. Neither is safe alone. Instead:

  ```bash
  export GIT_INDEX_FILE=$(mktemp)
  git read-tree HEAD && git add -- <paths>
  tree=$(git write-tree)
  commit=$(git commit-tree "$tree" -p HEAD -m "message")
  git update-ref refs/heads/<branch> "$commit" HEAD   # compare-and-swap: fails if the branch moved
  ```

  The expected-old-value on `update-ref` is the load-bearing part: it fails loudly instead of racing. Two caveats: this bypasses the pre-commit hook, so run `npm run typecheck` and the affected tests yourself first; and it leaves the *shared* index still holding the pre-commit entry for those paths, so finish with `git reset -q HEAD -- <paths>` or they keep showing as modified and another agent's commit can revert them.
- After every commit, check `git show --stat HEAD` against the size of the change you actually made. A commit that swept up a foreign hunk almost always has exactly the filenames you expected; the line counts are what give it away.
- **Do not rewrite a commit once anything is on top of it.** A mislabeled commit is a documentation problem; the repair's blast radius is other people's commits. Record the correction instead. If a rewrite is genuinely necessary, it belongs to whoever can pause the branch.
- **Never compute a parent as `HEAD^` on a shared branch.** Capture the full SHA you inspected and pass it explicitly. An agent doing surgery here read `HEAD^` moments after another commit landed, so the parent was one commit too new and the rewrite dropped an unrelated commit off the branch. The `update-ref` compare-and-swap passed, because the *old value* was current; it was the parent that was stale.

## Documentation

Detailed documentation lives in `/docs/cortex/`. Use `/doc-explorer <topic>` to explore.

### Key Docs

- **Product Vision**: `docs/cortex/product-vision.md` (why Cortex exists, core insight, design principles)
- **Architecture**: `docs/cortex/cortex-architecture.md` (core design, exports, patterns)
- **Context**: `docs/cortex/context-manager.md` (slots, prefix caching, ephemeral context)
- **Compaction**: `docs/cortex/observational-memory-architecture.md` (observational memory), `docs/cortex/compaction-strategy.md` (the layers: memory, microcompaction, failsafe)
- **Duplex (planned)**: `docs/cortex/duplex/` (talker/reasoner restructure: design decisions, architecture, migration plan)
- **Tool Result Persistence**: `docs/cortex/tool-result-persistence.md` (proactive bookend + persist for oversized tool results)
- **Skills**: `docs/cortex/skill-system.md` (progressive disclosure, SKILL.md format, registry)
- **Providers**: `docs/cortex/provider-manager.md` (discovery, OAuth, model resolution)
- **Sandboxing**: `docs/cortex/sandbox-consumer-guide.md` (managed opt-in setup), `docs/cortex/sandboxing.md` (ownership and platform limits)
- **MCP**: `docs/cortex/mcp-integration.md` (MCP client, tool wrapping, namespacing)
- **Tools**: `docs/cortex/tools/` (per-tool documentation)
- **System Prompt**: `docs/cortex/system-prompt.md` (prompt assembly, operational rules)
- **Working Tags**: `docs/cortex/working-tags.md` (response delivery, tag system)
- **Error Recovery**: `docs/cortex/error-recovery.md` (error classification, strategies)
- **Cross-Platform**: `docs/cortex/cross-platform-considerations.md` (platform differences)
- **Model Tiers**: `docs/cortex/model-tiers.md` (tier selection, defaults)
## File Locations

- Cortex source: `/packages/cortex/src/`
- Cortex tools: `/packages/cortex/src/tools/`
- Cortex compaction: `/packages/cortex/src/compaction/`
- Cortex tests: `/packages/cortex/tests/`
- Cortex Code source: `/packages/cortex-code/src/`
- Cortex documentation: `/docs/cortex/`
- Tool docs: `/docs/cortex/tools/`

## Consumers

Cortex is a general-purpose framework consumed by downstream applications. Consumers integrate via the documented hooks and callbacks (`getApiKey`, `beforeToolCall`, `transformContext`, compaction hooks) and provide their own system prompt, persistence, and domain logic. Consumer-specific integration documentation lives in each consumer's own repository, not here.
