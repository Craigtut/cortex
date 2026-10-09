# Pi 1.x migration plan

Researched on 2026-10-08 against pi 1.1.0 (released 2026-10-07). This is a plan:
nothing has been migrated. Cortex (`packages/cortex`) currently depends on
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` `^0.87.1`. Cortex Code
(`packages/cortex-code`) depends on `@earendil-works/pi-ai` and
`@earendil-works/pi-tui` `^0.87.1`. The 0.87 upgrade landed in f415b6f, 59e57e9,
6a05758 and 66ade15. The previous review in this format is
[pi-upgrade-0.85.1.md](pi-upgrade-0.85.1.md).

## Summary

Bumping the version is a small job. Migrating onto pi 1.x's model and auth layer
is the bigger one, and most of that work fixes bugs Cortex already has on 0.87.

- **The bump compiles unchanged.** A throwaway worktree on 1.1.0 type-checked
  Cortex, Cortex Code and brand with zero source changes. The full Vitest run had
  4,073 passes and 4 failures (4,076 passes and 0 failures before the bump). All
  four failures come from catalog drift: pi 1.0.3 renamed the Azure provider
  `azure-openai-responses` to `azure`, and pi 0.99.0 added `typesafe`, a provider
  with only classifier models. Cortex Code passed 587 of 587 against the built
  Cortex dist, the docs examples compiled, and the test-suite typecheck report
  stayed at 444 (Cortex) and 22 (Cortex Code), with the same diagnostics.
- **The bump compiles because Cortex barely touches pi's types.** Cortex types
  pi values as `unknown` or as hand-written stand-ins, and it reaches pi-ai
  through the `/compat` entrypoint, which 1.1.0 still ships. A type probe against
  the real 1.1.0 types shows the stand-ins have drifted. For example, `PiAgent`
  declares `prompt(input, { update, signal })`, but pi's second parameter is
  `images` (see [Typing against pi](#typing-against-pi)).
- **`/compat` is on borrowed time.** Its own header says it "is deleted with the
  coding-agent ModelManager migration" (`packages/ai/src/compat.ts:1-11` at
  v1.1.0). Cortex imports it on every request path. If it disappears, Cortex's
  try/catch blocks turn the failure into a misleading "pi-ai is not installed"
  (`agent-loop/pi-hooks.ts:78-83`, `agent-loop/direct-completion.ts:141-146`,
  `provider-manager/pi-ai.ts:92-125`).
- **Moving ProviderManager onto pi's `Models` and `CredentialStore` fixes three
  auth bugs Cortex has today.** I found them by reading the code; none has been
  reproduced live.
  1. Kimi Coding OAuth always fails: pi's `toAuth` returns headers only, and
     Cortex throws when `apiKey` is missing (`provider-manager/oauth-flows.ts:407-411`).
  2. GitHub Copilot's per-credential `baseUrl` (business and enterprise
     endpoints) is dropped.
  3. Concurrent refreshes race. `resolveOAuthApiKey` has no single-flight, so a
     duplex talker, reasoner and utility call can rotate an Anthropic refresh
     token twice. Cortex Code works around this in process
     (`providers/api-key-resolver.ts:22`) and across processes
     (`utils/oauth-credentials.ts:10`); other consumers get no protection.
- **pi 1.x does not follow semver in practice.** It shipped a breaking provider
  rename in a patch release (ai 1.0.3) and a breaking type change in a minor
  release (ai 1.1.0), across seven releases in nine days. I recommend exact pins.

Recommended order: Phase 1 (the bump) can land by itself. Phases 2 to 6 then move
Cortex onto pi's types, off `/compat`, onto `Models` and `CredentialStore`, and
onto pi-ai's error helpers. Each phase leaves the tree green.

## Method and what was not verified

- I installed pi 1.1.0 and 0.87.1 into separate scratch directories outside the
  repo, cloned `earendil-works/pi` at tag `v1.1.0`, and diffed the runtime
  exports and `.d.ts` files of every entrypoint Cortex imports.
- I took the import inventory from a TypeScript AST walk over `src` and `tests`
  in both packages plus `tools/`. It covers static, type-only and dynamic imports
  and `vi.mock` targets. I also checked the string-path dynamic imports by hand.
- I read the agent, ai, tui and coding-agent CHANGELOGs from 0.87.1 through 1.1.0,
  plus the source for anything undocumented.
- The trial ran in a detached worktree at 000a42c, which has since been removed.
  It ran `npm install`, the workspace typecheck, `typecheck:tests`,
  `typecheck:docs`, the full Vitest suite, the Cortex Code suite with
  `CORTEX_TEST_TARGET=dist`, and the CLI `--help`. The landing-page workspace's
  typecheck fails in a fresh worktree both before and after the bump, because its
  generated `routeTree.gen` is missing. That is unrelated to pi.
- **Not verified:** live provider requests, real OAuth logins (Anthropic's
  fallback port, Sign in with ChatGPT), Anthropic payloads with
  `inline-tools-2026-09-15` against the live API, pi-tui's OSC 7501 probe in real
  terminals, and the Windows and SteamOS runners. I checked catalog and pricing
  claims against pi's generated catalog, not against provider documentation.

## Symbol-by-symbol impact

"Same" means the symbol exists in 1.1.0 with a compatible signature and
unchanged semantics for Cortex's usage.

| Symbol | Entrypoint | Where used | 1.1.0 status | Action |
| --- | --- | --- | --- | --- |
| `Agent` | `pi-agent-core` (dynamic) | `agent-loop/pi-hooks.ts:79`. Mocked in tests `agent-loop-model-contract.test.ts:69` and `sandbox/cortex-agent.test.ts:11-12` | Present, with the same options plus `onProviderStreamEvent`. The root export count fell from 149 to 8 (the harness is gone). Behavior changes are listed under [pi-agent-core](#pi-agent-core) | Phase 2: type against it |
| `getSupportedThinkingLevels` | `pi-ai` root (dynamic) | `agent-loop/pi-agent.ts:169`, `provider-manager/pi-ai.ts:106`, test `ollama-model.test.ts:6` | Same. Also exported from `/models` | None |
| `createAssistantMessageEventStream` | root | tests `pi-system-transcript.test.ts:13`, `pi-upstream-contract.test.ts:3` | Same, but streams now stamp `durationMs` (ai 1.1.0) | None |
| `Message`, `Model`, `AssistantMessage`, `JsonObject`, `SimpleStreamOptions`, `ToolCall`, `TranscriptContext`, `ThinkingLevel`, `Context` (types) | root | `providers/ollama/messages.ts:1`, `runtime.ts:2`, `thinking.ts:1`, `stream.ts:3`, test `ollama-stream.test.ts:3` | Present. `Model` now extends `BaseModel` with an optional `type?: "chat"` and `samplingParamsByThinkingLevel`. `AssistantMessage` gains `thinkingLevel?` and `durationMs?`. `SimpleStreamOptions` gains `onProviderStreamEvent` | None |
| Stream function contract | n/a | `providers/ollama/stream.ts` (`streamOllama`) | ai 1.1.0: must return an `AssistantMessageEventStream` | Already compliant (built with `createAssistantMessageEventStream`) |
| `streamSimple` | `/compat` | `agent-loop/pi-hooks.ts:113`, test `ollama-stream.test.ts:2` | Same. Deprecated module. Injects env API keys when no key is passed (`compat.ts:224`) | Phase 3 |
| `complete` | `/compat` | `agent-loop/direct-completion.ts:63,142`, Cortex Code `src/complete.ts:258`, `tools/benchmark-ollama.mjs:6`, test `ollama-stream.test.ts:2`, `tests/eval/helpers/provider.ts:52` | Same | Phase 3 |
| `completeSimple` | `/compat` | `provider-manager/pi-ai.ts:111` (`loadPiAi`, used by `api-key-validation.ts:78`) | Same | Phase 4 |
| `registerApiProvider`, `getApiProvider` | `/compat` | `providers/ollama/model.ts:1` | Same (process-global registry) | Phase 3: re-home on `createProvider` |
| `* as piCompat` and `vi.mock('/compat')` | `/compat` | tests `pi-system-transcript.test.ts:14,25`, `pi-upstream-contract.test.ts:4,11`, `agent-loop-model-contract.test.ts:64`, `agent-loop-utility-usage.test.ts:12`, `provider-manager.test.ts:37` | Same | Phase 3: move to pi's faux provider |
| `builtinProviders` | `/providers/all` | `model-defaults.ts:16`, `model-backend.ts:14`, `provider-manager/pi-ai.ts:149`, tests `provider-registry.test.ts:2`, `model-backend.test.ts:7` | Present. The list changed: `azure-openai-responses` became `azure`, and `typesafe` was added with zero chat models | Phase 1 |
| `getBuiltinModels`, `getBuiltinModel` | `/providers/all` | `model-defaults.ts:16`, `agent-loop/model-settings.ts:10`, `provider-manager/pi-ai.ts:103-104`, tests | Same. Still chat-only ("existing unqualified reads remain chat-only", ai 0.99.0) | None |
| `getBuiltinProviders` | `/providers/all` | test `model-backend.test.ts:41` | Now includes `typesafe` | Phase 1 test fix |
| `getCurrentSystemMessage`, `collapseSystemMessages`, `getInitialSystemMessage`, `getCurrentSystemPrompt`, `getCurrentTools`, `hasNonAdditiveToolChanges` | `/utils/transcript` | `system-transcript.ts:18`, `providers/ollama/stream.ts:8`, tests | Same. Only `hasToolRedefinitions` was deprecated, and Cortex doesn't use it | None |
| `getSystemMessageText` | `/utils/text` | `providers/ollama/messages.ts:2` | Same | None |
| `createAssistantMessageEventStream` | `/utils/event-stream` | `providers/ollama/stream.ts:6` | Same, now timed | None |
| `estimateContextTokens` | `/utils/estimate` | `providers/ollama/stream.ts:7` | Behavior change: 3.5 characters per token instead of 4 (ai 1.1.0) | Note: Ollama's preflight check (`stream.ts:99-101`) now rejects about 14% earlier |
| `getOAuthProvider`, `getOAuthApiKey` | `/oauth` | `tests/eval/helpers/auth.ts:115` | Removed since 0.80 ("the `oauth` subpath now retains only extension compatibility types"). Zero runtime exports in both 0.87.1 and 1.1.0 | Phase 0: the eval auth helper is already broken |
| 31 pi-tui symbols in 38 files | `pi-tui` | Cortex Code `src/tui/*`, `src/commands/*`, `src/providers/*`, tests | Every runtime value Cortex Code uses is still exported. Only `parseOsc11BackgroundColor` was removed, and it's unused. `TUI` is type-only in both versions, which explains the existing test type error at `setup-tui-render.test.ts:144` | None |

## Breaking and behavior changes

### pi-agent-core

| Version | Change | Affects |
| --- | --- | --- |
| agent 1.0.0 | Removed the experimental harness, sessions, durable runtime, pico3, harness tools, compaction, skills, telemetry schemas and re-exports, and the `./node`, `./harness/*` and `./experimental/pico3` subpaths. Dependencies on chord, pi-telemetry, diff, ignore and yaml are gone | Neither: Cortex only loads `Agent`. The lockfile drops `@earendil-works/chord`, its 26 esbuild platform packages, and `yaml` |
| agent 0.99.0 | `onProviderStreamEvent` option | Neither (an optional debugging hook) |
| agent 0.99.0 | The loop stamps the requested `thinkingLevel` on every assistant message (`packages/agent/src/agent-loop.ts:409`) | Cortex and Cortex Code: persisted history gains a field. Nothing reads it |
| 0.99.0, undocumented (commit 8562bcf66) | `AgentToolResult.isError` is honored (`agent-loop.ts:844`). New `structuredContent` and `outputSchema`. An `afterToolCall` that replaces `content` drops `structuredContent` unless it returns it too. New `runToolCall()` export | Cortex: a consumer tool that returns `isError: true` now produces an error result. Before, the flag was ignored, because `agent-loop/tool-registry.ts:186-213` passes results through. Cortex's own tools and the MCP wrapper (`mcp-client.ts:736-745`, which throws) are unaffected |
| agent 1.1.0 | `durationMs` on tool results, outcomes and `tool_execution_end` | Cortex: optional. Its own timing in `tool-registry.ts:197-201` could use it |
| agent 1.1.0 | `streamProxy()` returns an `AssistantMessageEventStream` | Neither |

`prepareRequest`, `finishTurn`, `transformContext`, the steering and follow-up
queues, `reset()` and `continue()` are unchanged since 0.87.1. `agent.ts` gained
four lines, all for `onProviderStreamEvent`.

### pi-ai

| Version | Change | Affects |
| --- | --- | --- |
| ai 0.99.0 | Image models folded into `Models`. `ImagesModels` and the `createImages*` and `builtinImages*` APIs were removed. Catalog schema v6 | Neither: Cortex doesn't generate images |
| ai 0.99.0 | Sign in with ChatGPT on the `openai` provider. Login needs `LoginOptions.getDeviceId()` (`auth/oauth/openai-chatgpt.ts:226-237`) | Cortex: `listOAuthCapableProviders()` will now list `openai`, because pi has OAuth for it and `PROVIDER_REGISTRY` lists the provider. `initiateOAuth('openai')` then throws "requires a device ID", because Cortex calls `login(interaction)` with no options (`oauth-flows.ts:338`). Cortex Code: not offered, since it uses the static `OAUTH_PROVIDER_IDS` (`providers/setup-tui.ts:582`) |
| ai 0.99.0 | OpenAI Codex renamed "OpenAI Codex (legacy)" | Cortex Code: label only |
| ai 0.99.0 | Browser sign-in callback servers unified (`auth/oauth/callback-server.ts`), which now honor the abort signal and reject on a provider error redirect. Page helpers moved to `utils/oauth-page` | Cortex: the branded-page shim still matches, because the page titles are unchanged (`utils/oauth-page.ts:94-104`). The `callbackFailure` race and the "pi ignores abort" workaround (`oauth-flows.ts:243-278`) are now redundant |
| ai 0.99.0 | Claude Sonnet 5.5 added. `AssistantMessage.thinkingLevel` added | Cortex: catalog-driven, no change |
| ai 0.99.2 | `@earendil-works/pi-ai/models`: a light entrypoint with `createModels` and `createProvider` that doesn't load TypeBox or the catalogs | An option for Phase 3 |
| ai 0.99.2 | Anthropic workload identity federation from `ANTHROPIC_FEDERATION_*` env vars when no key or auth header is resolved | Cortex: one more ambient auth path (see [open questions](#decisions-craig-2026-10-08)) |
| ai 0.99.2 | Z.AI CN overflow pattern, strict-schema fallback, Retry-After parsing fix | Cortex benefits only once overflow detection goes through pi (Phase 6) |
| ai 1.0.0 | Anthropic login starts with a `select` prompt (browser or copy code) | Cortex: a consumer without `onSelect` gets a free-text prompt asking for an option id (`oauth-flows.ts:322-334`). Cortex Code passes `onSelect` (`setup-tui.ts:243`) |
| ai 1.0.1 | Anthropic native tool changes moved to `inline-tools-2026-09-15`. Later tools are defined by value in `tool_addition` blocks, and a same-name redefinition keeps the prompt cache | Cortex: a cache win. `system-prompt.md:256` still describes `defer_loading`. The comment at `agent-loop/system-prompt.ts:388-391` ("declaring a tool twice is outside what native tool-change transports accept") is no longer true for Anthropic |
| ai 1.0.1 | "Model is at capacity" is retried. Bedrock Claude drops stale thinking blocks | Benefit |
| ai 1.0.2 | `samplingParamsByThinkingLevel` | Neither |
| ai 1.0.3 | **Azure renamed `azure-openai-responses` to `azure`.** The API id `azure-openai-responses` is unchanged | Cortex: `provider-registry.ts:91`, `model-defaults.ts:68` and four tests. `tool-choice.ts:21` keys on the API id, so it's unaffected. `PROVIDER_CACHE_CONFIG` already has an `azure` key (`provider-registry.ts:409`). Cortex Code: credentials and defaults stored under the old id |
| ai 1.0.3 | An OAuth refresh that has started completes and persists even if its caller is cancelled | Benefit, but only on the `Models` path (Phase 4) |
| ai 1.1.0 | A stream function must return an `AssistantMessageEventStream` | Cortex already complies |
| ai 1.1.0 | `durationMs` on `AssistantMessage` | Persisted history gains a field |
| ai 1.1.0 | Claude Haiku 5.5 (`claude-haiku-5-5`): 1M context, mid-conversation system messages, tool changes and effort | Cortex: utility-model inference does not pick it (see [Risks](#risks)) |
| ai 1.1.0 | `LoginOptions.agentName` | Cortex: lets the ChatGPT and Codex login screens name the consuming app |
| ai 1.1.0 | `server_busy` is retried. Estimates use 3.5 characters per token | Ollama preflight, see above |
| ai 1.1.0 | Anthropic browser login falls back to a free loopback port when 53692 is taken (`auth/oauth/anthropic.ts:153-156`) | Cortex: blocked by Cortex's own port pre-check (`oauth-callback-page.ts:87`). The shim matches by fixed port (`oauth-callback-page.ts:184`), so a fallback login gets pi's page instead of the branded one |
| deps | `@anthropic-ai/sdk` 0.124 to 0.129, `openai` 6.40 to 7.19 | Neither imports them directly |

Also undocumented: `ToolResultMessage.nestedCalls` (0.99.0) and `@earendil-works/pi-telemetry` moving to 1.1.0 as a transitive dependency.

### pi-tui (Cortex Code only)

| Version | Change | Affects |
| --- | --- | --- |
| tui 0.99.0 | `queryTerminalColors()` replaces `queryTerminalColorScheme()` and `queryTerminalBackgroundColor()`. `parseOsc11BackgroundColor` removed | Neither: unused |
| tui 1.0.0 | Weakly held Markdown tokens, flattened line caches | Benefit |
| tui 1.0.3 | `Home` and `End` always move the editor cursor. Fullscreen top and bottom moved to `Ctrl+Home` and `Ctrl+End` | Neither: Cortex Code uses `TuiMainScreen`, and `tui/scrollable-viewer.ts:52-54` handles its own keys |
| tui 1.1.0 | `Terminal` implementations must provide `setProgramStatus()`. `ProcessTerminal` probes for OSC 7501 support at startup (`PI_PROGRAM_STATUS=1\|0` overrides) | Cortex Code: `ProcessTerminal` is used at `tui/app.ts:54` and `providers/setup-tui.ts:624`, so the probe now runs at every start. Not checked in real terminals. Tests stub the terminal |

## ProviderManager onto Models and CredentialStore

### What pi 1.x provides

- `createModels({ credentials, authContext, modelsStore })` returns a `Models`
  collection of `Provider` objects. Each provider owns its catalog, its
  `auth.apiKey` and `auth.oauth`, and its streams (`packages/ai/src/models.ts:250-371`).
- `CredentialStore` is the app's storage. It has `read`, `list`, `modify` (the
  only write path, a serialized read-modify-write) and `delete`, and it should
  hold a cross-process lock where the backend allows one
  (`packages/ai/src/auth/types.ts:65`).
- `Models.getAuth(model)` resolves `{ apiKey?, headers?, baseUrl? }`. It runs the
  OAuth refresh inside `modify` with a double check under the lock, so
  concurrent callers in one process or across processes refresh once
  (`auth/resolve.ts:119-160`).
- `Models.login(provider, 'oauth' | 'api_key', interaction, loginOptions)` runs
  the provider's flow and persists the result through `modify`.
- Every `stream`, `streamSimple`, `complete` and `completeSimple` call applies
  the resolved auth, including headers and `baseUrl` (`models.ts:843-875`).

The comment at `provider-manager/pi-ai.ts:42-47` is half right. pi does have
"no global OAuth registry": that was removed in 0.80, and OAuth is reached
through `Provider.auth.oauth`. But the next sentence, "nor does it turn a
credential into an API key", is stale. `Models.getAuth()` does exactly that, with
locked refresh.

### What Cortex keeps as its consumer API

`ProviderManager` and `IProviderManager` stay the consumer surface, with the same
methods and the same `OAuthCallbacks`, `OAuthResult`, `OAuthError`,
`ProviderInfo`, `ModelInfo` and `CortexModel` types. Consumers still never import
pi. What changes underneath:

- **One `Models` per `ProviderManager`.** It holds every built-in provider, plus
  Cortex's `ollama` provider and a `custom` provider for `createCustomModel()`.
- **New `ProviderManagerOptions`:**
  - `credentials?: CredentialStore` (pi's interface, re-exported as a type;
    defaults to `InMemoryCredentialStore`)
  - `authContext?: AuthContext` (controls env and file access for ambient
    credentials)
  - `login?: { agentName?: string; getDeviceId?: () => string }`
- **Provider listing:** `listProviders()` and `listOAuthProviders()` are built
  from `builtinProviders()`, keeping only providers with chat models, so
  `typesafe` drops out. Names and auth methods come from `provider.name`,
  `auth.apiKey` and `auth.oauth`. `PROVIDER_REGISTRY` shrinks to a UX overlay
  keyed by id (`envVar`, `keyPrefix`, `keyUrl`), because pi doesn't expose env var
  names; they live inside closures in `envApiKeyAuth`. The static
  `OAUTH_PROVIDER_IDS` fallback (`provider-registry.ts:346`) is deleted. pi is a
  hard dependency, and `loadPiBuiltinProviders` (`provider-manager/pi-ai.ts:138-157`)
  already fails loudly if the export moves.
- **`initiateOAuth`** calls `models.login(...)`. It keeps the timeout and
  cancellation race, because pi's Anthropic flow passes no `timeoutMs`. It drops
  the `callbackFailure` race. It still returns `{ credentials, meta }` for
  consumers that persist the blob themselves. It forwards `AuthPrompt.signal` to a
  new `signal` argument on `onManualCodeInput` and `onPrompt`, so a pending
  manual-code input closes when the browser callback wins (pi aborts that prompt,
  `auth/oauth/callback-server.ts:157-183`). With no `onSelect`, it answers
  `select` prompts with the first option instead of sending them to `onPrompt`.
- **`resolveOAuthApiKey(provider, blob)`** is kept as a deprecated wrapper. It
  seeds a transient in-memory store, calls `getAuth`, and returns the new blob
  plus an `auth: { apiKey?, headers?, baseUrl? }` field. Kimi and Copilot work
  through the new field.
- **New `getAuth(providerOrModel)` and `logout(provider)`.**
- **`validateApiKey`** uses `models.completeSimple(model, ctx, { apiKey, maxTokens: 1 })`
  and drops the fail-open "assume valid" branch (`api-key-validation.ts:78-82`).
- **`createCustomModel`** builds its `Model` literal directly instead of cloning
  `openai/gpt-4.1` (`provider-manager/model-factory.ts:59-63`). That id still
  exists in 1.1.0, but the code shouldn't depend on it.

### How `getApiKey` maps

Today, `AgentLoopConfig.getApiKey` (`types.ts:331`) is shared across the facade,
the talker, lookups and child loops (`facade/config.ts:270`,
`duplex/assembly.ts:250,309`, `agent-loop/child-loop-config.ts:159`,
`agent-loop/assembly.ts:259`). It becomes pi's `Agent.getApiKey`
(`pi-hooks.ts:107`), and the string is passed to compat's `streamSimple`, which
falls back to env vars when the string is empty. Direct completions call it
themselves (`direct-completion.ts:159-165`).

Proposal:

1. **Add a general hook on the loop and facade config:**
   `getAuth?: (provider: string) => Promise<{ apiKey?: string; headers?: Record<string, string>; baseUrl?: string } | undefined>`.
   It's shared everywhere `getApiKey` is shared today. `getApiKey` becomes sugar
   (`p => ({ apiKey: await getApiKey(p) })`). AgentLoop and ProviderManager stay
   independent: a consumer wires `getAuth: p => manager.getAuth(p)`, and the
   locked refresh lives in the manager's `Models`.
2. **One owner for request dispatch** (`src/model-runtime.ts`). Its
   `streamSimple(model, context, options, auth)` merges the resolved auth the way
   `Models.applyAuth` does (explicit key, then merged headers, then a `baseUrl`
   override). It then calls `provider.streamSimple` on the model's registered
   provider. It does not go through `Models.streamSimple` with an explicit key,
   because `Models` ignores an `apiKey` override for providers without
   `auth.apiKey` (`auth/resolve.ts:56`). For OAuth-only `openai-codex`, it then
   throws "Provider is not configured" (`models.ts:860`).
3. **Fit with duplex.** The talker, the reasoner, sub-agents and the direct
   completions all call the one `getAuth`. With the manager's store, a
   simultaneous start of all of them produces one refresh, not one per loop.
   Nothing in the duplex routing changes.

### The branded callback page

pi 1.1.0 has no render hook. `startOAuthCallbackServer` hard-codes
`oauthSuccessHtml` and `oauthErrorHtml`, and Sign in with ChatGPT runs its own
`createServer`. The `ServerResponse.prototype.end` patch
(`oauth-callback-page.ts:141-174`) keeps working, because the titles it keys on
are unchanged. It does need these changes:

- Match on the callback path, a loopback `Host` header and an active flow,
  instead of the fixed port. Anthropic can now land on any port, and OpenRouter
  always uses an ephemeral port, which is why its page was never branded.
- Read the real callback port from the `redirect_uri` in the `auth_url` event,
  instead of from `OAUTH_CALLBACK_ROUTES` (`oauth-callback-page.ts:49`).
- Delete `assertOAuthCallbackPortAvailable`. In 1.x, Anthropic falls back to a
  free port, Codex falls back to pasting the redirect URL, and ChatGPT fails with
  a clear "port in use" error. The pre-check now blocks the first two fallbacks.
  Map ChatGPT's `EADDRINUSE` text to `callback_port_in_use` instead.

The patch stays. We do not ask pi upstream for a renderer hook (see
[decisions](#decisions-craig-2026-10-08)).

### Re-homing Ollama on `createProvider`

Replace the global `registerApiProvider` call (`providers/ollama/model.ts:10-21`)
with a provider registered on the runtime:

```ts
createProvider({
  id: 'ollama',
  name: 'Ollama',
  auth: { apiKey: { name: 'Ollama (no key)', resolve: async () => ({ auth: {}, source: 'local server' }) } },
  models: [],
  api: { stream: streamOllama, streamSimple: ollamaStreamSimple },
});
```

The codec (`stream.ts`), discovery and runtime allocation stay as they are. The
off-by-default reasoning clamp moves from the registry lambda into
`ollamaStreamSimple`. The model still carries `ollamaRuntime`. Provider streams
dispatch on `model.api` and don't require the model to be in the provider's list
(`models.ts:1066-1078`), so per-call models keep working. The `custom` provider
works the same way, with `api: openAICompletionsApi()` and a key-or-keyless
`resolve`.

### Cortex Code

`config/credentials.ts` becomes a pi `CredentialStore` over
`~/.cortex/credentials.json` and the Keychain:

- `read` maps `oauth` entries to `{ type: 'oauth', ...JSON.parse(oauthCredentials) }`
  and `api_key` or `custom` entries to `{ type: 'api_key', key }`.
- `modify` takes a proper-lockfile lock and preserves Cortex Code's extra fields
  (`oauthMeta`, `addedAt`, `lastUsed`, and the defaults).

pi runs the network refresh inside `modify` for up to 15 seconds
(`auth/resolve.ts:113-114`). The current `lockfile.lock(path, { retries: 3 })`
(`config/credentials.ts:169,199`) would fail waiters during a refresh, so copy
pi's own `AuthStorage` approach: `stale: 30_000`, `retries: 0`, and an outer
backoff loop up to a deadline (`packages/coding-agent/src/core/auth-storage.ts:120-145`).

Once that's in place, `ApiKeyResolver`'s single-flight and
`resolveStoredOAuthApiKey`'s rotation retries are deleted. Pass an env-blind
`AuthContext` to keep the no-env-var policy.

## Error classification onto pi-ai

### Current state

- **`error-classifier.ts`.** The comments claim it "delegates to pi-ai's
  `isContextOverflow()`" (lines 61-62, 239, 276-277), and `error-recovery.md:69`
  says "Not duplicated in cortex". Neither is true: it uses four regexes of its
  own.
- **`compaction/failsafe.ts:153-176`** has a second overflow detector, which the
  turn runner calls (`agent-loop/turn-runner.ts:355`).
- **`token-estimator.ts`** divides by 4. Its header points at
  `@animus-labs/shared`, which isn't in this repo.
- **Retry policy.** `DEFAULT_RETRY_POLICY` retries `rate_limit`, `server_error`
  and `network` up to 20 times with 2m, 4m and 8m backoff, then a 10m cap
  (`retry-policy.ts:18-20`, `types.ts:773-796`). That totals about 3 hours.

### What pi-ai 1.1.0 provides

| Helper | Signature | Use for Cortex |
| --- | --- | --- |
| `isContextOverflow(message, contextWindow?)` | Takes an `AssistantMessage` (`utils/overflow.ts:137`) | Pattern matches plus silent overflow (`usage.input > contextWindow` with `stopReason: "stop"`) and length-stop overflow. Excludes Bedrock throttling and rate limits. Cortex's Error-only check misses the silent case |
| `getOverflowPatterns()` | Returns `RegExp[]` | For thrown `Error`s that have no assistant message |
| `isRetryableAssistantError(message)` | Takes an `AssistantMessage` (`utils/retry.ts:252`) | A broad transient list: `server_busy`, "model is at capacity", "stream ended before message_stop", "pending stream has been canceled", `ResourceExhausted`, "provider returned error", "terminated", "websocket closed", "retry delay" and more. Cortex calls several of these `unknown` today |
| `estimateTextTokens()`, `estimateMessageTokens()` | 3.5 characters per token | See [open questions](#decisions-craig-2026-10-08) |

pi also has a non-retryable "provider limit" list (`utils/retry.ts:7-28`). It is
**too broad to adopt whole**. It matches the bare strings `billing` and
`quota exceeded`, which would make Gemini's per-minute 429 ("You exceeded your
current quota, please check your plan and billing details") and Google's
"Quota exceeded for metric" errors non-retryable. Cortex deliberately retries
those (`error-recovery.md:65`). pi also extracts no reset time generically. The
Codex path renders "You have hit your ChatGPT usage limit (plan). Try again in
~N min." (`api/openai-codex-responses.ts:1603-1614`), and several APIs throw
"Server requested Ns retry delay (max: Ms)" when Retry-After exceeds
`maxRetryDelayMs` (`utils/provider-retry.ts:39-50`). So Cortex owns billing and
usage-window detection, and uses pi for overflow and transient detection.

### Design: a thin layer over pi

`classifyError` keeps its signature and gains an optional `assistantMessage`.
When a failing assistant message exists (the turn runner reads it off
`agent.state`, `turn-runner.ts:332-337`), the pi helpers take it directly. For a
thrown `Error` (direct completions, credential failures), one adapter in
`error-classifier.ts` builds a synthetic
`{ stopReason: 'error', errorMessage, usage: zero }`. The order of checks:

1. `cancelled` (unchanged).
2. **`billing` (new, fatal, never retried).** Matched only on specific provider
   codes and messages:
   - `insufficient_quota`: OpenAI's code. pi's `formatProviderError` puts the
     JSON body into the message as "OpenAI API error (429): {...}"
     (`utils/error-body.ts:128-135`).
   - "credit balance is too low" (Anthropic).
   - `402` together with "insufficient credits" (OpenRouter).

   This check runs before the rate-limit patterns, because `insufficient_quota`
   also matches `/\b429\b/` (`error-classifier.ts:54`).
3. **Usage-window limits (`rate_limit` with a new `retryAfterMs`).** Matched on
   "usage limit" with "Try again in ~N min", on
   `subscription_sharing_usage_limit_exceeded`, and on "Server requested Ns retry
   delay". `retryAfterMs` is parsed when a reset time is present. Otherwise the
   normal backoff applies; a subscription window resets in hours, and 20 attempts
   cover about 3 hours.
4. `authentication` (unchanged).
5. `rate_limit` (unchanged, including `/quota.exceeded/i`, `error-classifier.ts:58`).
6. `context_overflow` through pi's `isContextOverflow`. `failsafe.ts`'s
   `isContextOverflow` becomes a call to it.
7. `server_error` and `network` from Cortex's patterns. Anything else pi
   considers retryable becomes `server_error`.
8. `unknown`.

**How this differs from the dropped `resource_exhausted`.** That category was
removed as "too granular to classify from error strings" (`error-recovery.md:27`).
It would have swept up Google's per-minute `RESOURCE_EXHAUSTED`, which is
transient. `billing` is matched only on provider-specific codes for exhausted
paid credit, is actionable ("top up or switch provider"), and leaves every
per-minute or per-day quota under `rate_limit`.

**Retry engine.** `ClassifiedError` gains `retryAfterMs?: number`. Before each
wait, the turn runner, background delivery and delivery queues
(`turn-runner.ts:393`; classification at `background-delivery.ts:220` and `delivery-queues.ts:267`)
use `max(backoffForAttempt(...), retryAfterMs)`. That wait is capped by
`maxElapsedMs` and by a new `RetryPolicy.maxRetryAfterMs` (proposed default: 6
hours). A wait for a stated reset time counts as one attempt.
`RetryScheduledInfo.delayMs` reports the real wait.

### Consumer-visible changes

- **`ErrorCategory` gains `'billing'` (`types.ts:719-726`).** This breaks
  exhaustive switches in consumers at compile time, which is intended: Animus
  will be forced to handle it.
- **Cortex Code changes:**
  - `session/agent-events.ts:137-175` needs a `billing` case: an "Out of credits"
    notification with a provider billing link, and `retry.clear()`. Without it,
    billing errors fall into the generic `default` box.
  - `activity/session-activity.ts:32-38,252-266` maps unknown categories to
    `'other'`, so it needs `'billing'` added.
  - `persistence/transcript-writer.ts:195` stores the category string. Old
    transcripts are fine.
- **Severity:** `billing` is `fatal`.
- **Retries:** `retryableCategories` defaults are unchanged, and `billing` is not
  in them.
- **More errors become retryable.** Errors that were `unknown` now classify as
  `server_error` (retried) or `rate_limit`, which a consumer will see as more
  retries.
- **OpenAI `insufficient_quota`** moves from `rate_limit` (retried for about 3
  hours) to `billing` (surfaced immediately).

Land this after the in-flight error-classifier and failsafe fixes from the other
agent. The throttling fix is already in, as 2e04562.

## Typing against pi

| Site | Today | Probe result against 1.1.0 types |
| --- | --- | --- |
| `agent-loop/pi-agent.ts:22-73` `PiAgent` | Hand-written structural interface | The real `Agent` is **not assignable**: `prompt` is `(message \| message[])` or `(input: string, images?)`, not `(input, { update, signal })` |
| `context-manager.ts:26-53` `AgentMessage` | Hand-written | pi's `AgentMessage` and `Message` are not assignable to it: Cortex's content blocks need an index signature that pi's don't have. The reverse also fails: Cortex's `role` union is wider than any single pi variant |
| `agent-loop/pi-agent.ts:79-84` `PiModel` | Index-signature record | Not assignable either way: it lacks `api`, `id`, `reasoning`, `maxTokens` and others |
| `event-bridge.ts:118-139` `PiEvent` | Hand-written | Compatible: pi's `AgentEvent` assigns cleanly |
| `pi-message.ts` readers | `unknown` input, defensive reads | Keep the defensive reads for restored history. Type the inputs |

The header comment at `pi-agent.ts:17-20` justifies the stand-ins: "avoid a hard
runtime dependency". That reason is stale. Both pi packages are hard
`dependencies` in `packages/cortex/package.json`, and `import type` is erased at
build time. Since 0.80, pi-ai's root is side-effect free, and pi-agent-core's
root is now eight exports.

Recommendation: import pi's types in the pi boundary modules and keep the lazy
runtime imports only for the heavy entrypoints (`/providers/all`). The
consequence is intended: the next pi type change fails `npm run typecheck`
instead of passing silently, as it did for this one. `AgentMessage`, `PiEvent`,
`PiAgent` and `PiModel` are public exports (`index.ts:126-166`), so changing them
is a consumer-visible decision.

## New pi packages

| Package | Recommendation | Reasons |
| --- | --- | --- |
| `pi-mcp` (1.1.0, first released in 0.99.0 on 2026-09-29) | **Watch.** Prototype after Phase 4 | It covers what `mcp-client.ts` uses: stdio, Streamable HTTP, `tools/list`, `tools/call`, progress with timeout renewal, cancellation, and process-group shutdown. Its only dependency is `cross-spawn`. `@modelcontextprotocol/sdk` 1.29.0 pulls in express, hono, cors, ajv and jose for a client-only use. It also brings MCP OAuth, which Cortex lacks. Against it: ten days old, with an OAuth API break already (mcp 1.0.1). Cortex's manager (sandboxed spawn, safe env, reconnects, namespacing, redaction, progress listeners) stays either way; only the transport and client core would swap. Its custom `McpTransport` interface can host the sandboxed spawn. Duplex: no change, the reasoner still owns MCP tools |
| `pi-codemode` | **Watch** | A QuickJS sandbox with no pi dependencies, where model-written scripts call injected tools. It would fit as an opt-in reasoner tool that runs registered tools through pi-agent-core's new `runToolCall()`, so Cortex's `beforeToolCall` permission gate still applies. It isn't needed for the migration, and the duplex talker should not get it |
| `pi-durable` | **Skip** | Marked "Experimental. The API changes without notice". It is a full durable harness that owns storage, transcripts, tasks and settlement. That conflicts with Cortex's no-persistence design and duplicates CortexAgent's session log, settlement and background work. It would also bring back chord and esbuild. Ideas worth borrowing without the package: idempotent submission ids and per-conversation provider `sessionId` |
| `pi-env` | **Skip** | It's a remote `ExecutionEnv` for Durable only |
| `pi-server`, `pi-client`, `pi-protocol` | **Skip** | pi's own app RPC layer, on chord |

## Phases

Each phase leaves typecheck, the suite, `typecheck:docs` and the Cortex Code
dist run green. Per this repo's practice, every new test must be shown to fail
against the pre-change source: revert only the source with
`git show HEAD:<path> > <path>`, gated on `git diff --quiet`.

### Phase 0: pre-existing breakage (Cortex)

- `tests/eval/helpers/auth.ts:115` imports `getOAuthApiKey` from
  `@earendil-works/pi-ai/oauth`, which has had no runtime exports since 0.80.
  Rewrite it on `ProviderManager`, or delete the OAuth branch.
- Proof: run `npm run test:eval` with credentials. Not run here.

### Phase 1: bump (Cortex and Cortex Code)

- Changes:
  - Pin `@earendil-works/pi-agent-core`, `pi-ai` and `pi-tui` to `1.1.0`.
  - `provider-registry.ts:91`: change `azure-openai-responses` to `azure`.
  - `model-defaults.ts:68`: the same key change.
  - `provider-registry.test.ts` and `model-backend.test.ts`: compare only
    against providers that have chat models.
  - Fix `system-prompt.md:256`.
  - Add changelog entries.
- Tests:
  - The four failures from the trial go green.
  - New Cortex tests:
    - A consumer tool that returns `isError: true` reaches `onToolResult` as an
      error. This fails on 0.87.1.
    - `thinkingLevel` and `durationMs` survive a history round trip through
      `getConversationHistory()` and `restoreConversationHistory()`.
  - `pi-upstream-contract.test.ts` and `pi-system-transcript.test.ts` pass
    unchanged.
- Manual: start Cortex Code in Ghostty, iTerm and Terminal.app (the OSC 7501
  probe), then run an Anthropic login (the select prompt).

### Phase 2: type against pi (Cortex, no behavior change)

- Replace `PiAgent`, `PiModel`, `AgentMessage`, `PiEvent` and the `unknown`
  inputs with pi's types, and correct `PiAgent.prompt`.
- Proof: commit the type probe from this review as a test file that fails to
  compile against the old stand-ins. The runtime suite is unchanged.

### Phase 3: leave `/compat` (Cortex and Cortex Code)

- Changes:
  - Add `src/model-runtime.ts`: one `Models` with the built-in providers plus
    `ollama` and `custom`.
  - Move these onto it: `pi-hooks.ts:113`, `direct-completion.ts:142`,
    `provider-manager/pi-ai.ts:100`, `providers/ollama/model.ts:1`, Cortex Code
    `src/complete.ts:258`, `tools/benchmark-ollama.mjs:6` and
    `tests/eval/helpers/provider.ts:52`.
  - Keep today's semantics: an explicit key goes through `provider.streamSimple`,
    and no key goes through `Models` auth, which includes ambient env vars as
    compat did.
- Tests:
  - A grep gate: no `pi-ai/compat` import in `src`, `tests` or `tools`.
  - Contract tests stop mocking `/compat` and run on pi's faux provider. They
    must still fail when, for example, Cortex drops `cacheRetention` or
    `sessionId`.
  - The Ollama stream tests pass through `createProvider`.

### Phase 4: Models and CredentialStore in ProviderManager (Cortex)

- Changes: as designed above. `getAuth` becomes a shared config key in
  `facade/config.ts`, so the compile-time delegation table forces its wiring.
- New tests (each fails on today's code):
  - Kimi OAuth resolves to an `Authorization` header.
  - Copilot's `baseUrl` reaches the request model.
  - A talker, reasoner and utility call against one expired Anthropic credential
    produce exactly one `refresh`. Use a counting fake `OAuthAuth`.
  - `initiateOAuth('openai')` passes `getDeviceId`.
  - An Anthropic login on a fallback port still renders the branded page.
  - A `select` prompt with no `onSelect` picks the first option.

### Phase 5: Cortex Code on the CredentialStore

- Changes: the file-backed store, deleting `ApiKeyResolver`'s single-flight and
  the rotation retries, and the env-blind `AuthContext`.
- Tests:
  - Two store instances over one file, refreshing concurrently, produce one
    refresh.
  - A waiter survives a 15-second refresh.
  - Existing `credentials.json` fixtures read back unchanged.
  - Keychain-held keys resolve.

### Phase 6: errors onto pi-ai (Cortex, then Cortex Code UI)

- Changes: as designed above.
- Tests (each fails first unless noted as a guard):
  - `insufficient_quota` in pi's format classifies as `billing` and fatal, with
    no `onRetryScheduled`. Today it's `rate_limit` and retried.
  - Anthropic's "credit balance is too low" and OpenRouter's 402 "Insufficient
    credits" classify as `billing`. Today both are `unknown`.
  - Gemini's "You exceeded your current quota, please check your plan and
    billing details" stays `rate_limit`. This is a guard that passes today. Its
    positive precondition is that the same fixture rewritten as
    `insufficient_quota` classifies as `billing`.
  - Google's "Quota exceeded for metric" stays `rate_limit`.
  - "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min."
    classifies as `rate_limit` with `retryAfterMs` 2,520,000, and the turn runner
    waits that long. Today it's `unknown`.
  - "Server requested 3600s retry delay (max: 60s)" waits 3,600,000 ms. Today it
    waits 2 minutes.
  - `server_busy` and "model is at capacity" classify as `server_error`.
  - A silent overflow (`usage.input > contextWindow`) triggers `handleOverflow`.
  - Bedrock's "Too many tokens" is not an overflow. That test exists from
    2e04562.
  - Cortex Code renders the billing notification.

## Risks

1. **`/compat` removal under a caret range.** pi's coding-agent still imports
   `/compat` in 13 files at 1.1.0, so removal isn't imminent, but it has no date.
   pi already ships breaking changes in patch and minor releases. Pin exact
   versions until Phase 3 lands.
2. **Concurrent OAuth refresh under duplex** for consumers other than Cortex
   Code. This is live on 0.87 today. Phase 4 fixes it.
3. **Hollow contract tests.** Tests that `vi.mock('/compat')` pass whether or not
   Cortex's real dispatch works, and they stay green after compat is gone.
   Phase 3 replaces them with tests on the faux provider.
4. **The talker misses Haiku 5.5.** `inferUtilityModel` ranks
   `claude-haiku-4-5-20251001` above `claude-haiku-5-5` on the 1.1.0 catalog,
   because a dated snapshot id outscores a version number
   (`utility-model-inference.ts:79-84,108-165`). In pi's catalog, Haiku 5.5 costs
   a tenth as much ($0.10 against $1.00 input per million tokens) and supports
   mid-conversation system messages, so the duplex talker's prompt cache would
   survive status updates. Fixing it changes the default talker for every
   Anthropic duplex session.
5. **The callback-page patch** is a process-global prototype patch, and the
   ChatGPT login has its own server. Every OAuth refactor in pi can break it
   quietly. The existing `looksLikePiOAuthPage` title check limits the damage to
   an unbranded page.
6. **The CredentialStore lock.** proper-lockfile's settings in Cortex Code
   (`retries: 3`) would fail waiters during pi's 15-second refresh window.
7. **Estimate drift.** pi's 3.5 characters per token already makes Ollama's
   preflight about 14% stricter. Adopting it in compaction would trigger
   compaction earlier.
8. **Release churn.** pi published 1.0.0 to 1.1.0 in six days, and pi-mcp broke
   its OAuth API within days. The adoption recommendations above assume that
   pace continues.

## Decisions (Craig, 2026-10-08)

Guiding rule: rely on pi for anything it provides, and do not ask pi upstream
for changes. Where pi lacks something, keep our own code.

1. **Version pins:** exact `1.1.0` pins.
2. **`getAuth` and `getApiKey`:** add `getAuth`, keep `getApiKey` as the simple
   path.
3. **Ambient env credentials in Cortex:** pending. Today Cortex silently falls
   back to provider env vars (for example `ANTHROPIC_API_KEY`) when the
   consumer's `getApiKey` returns nothing, because pi-ai's `/compat` layer reads
   them (`pi-ai/dist/compat.js:146-153`). Recommendation: Cortex stops doing that
   by default and a consumer opts in explicitly.
4. **Branded OAuth page:** keep our patch, matched by path. No upstream request.
5. **Talker model:** fix utility-model inference so Anthropic duplex talkers
   resolve to `claude-haiku-5-5`.
6. **Token estimates:** use pi's estimator.
7. **Billing errors:** the three keys (`insufficient_quota`, "credit balance is
   too low", 402 "insufficient credits") are `billing`. The OpenCode gateway
   monthly limits pi reports (`GoUsageLimitError`, `FreeUsageLimitError`,
   "Monthly usage limit reached") are also `billing`, since a monthly limit does
   not reset on a useful timescale. Cap waiting for a stated reset at 6 hours.
8. **Sign in with ChatGPT:** out of scope for this migration.
9. **Azure:** no Cortex Code users, so no credential migration. Rename the
   provider id in code only.
10. **Public types:** export pi's own message and agent types.

## Sources

- [Agent changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/CHANGELOG.md)
- [AI changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/CHANGELOG.md)
- [TUI changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/tui/CHANGELOG.md)
- [Coding agent changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/CHANGELOG.md)
- [pi-ai README: Models, Auth, Credential Store](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/README.md)
- [pi-mcp README](https://github.com/earendil-works/pi/blob/v1.1.0/packages/mcp/README.md), [pi-codemode README](https://github.com/earendil-works/pi/blob/v1.1.0/packages/codemode/README.md), [pi-durable README](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md)
- [Release 1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0)
