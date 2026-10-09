# Changelog

All notable changes to `@animus-labs/cortex-code` are documented here.

## Unreleased

- Fix a torn or corrupt `~/.cortex/credentials.json` wiping every other provider: it read as empty, and the next write (a token refresh, a login) replaced the file with only its own change. The file is now replaced whole (a temp file renamed over it), so a crash or a concurrent reader never sees half of it, and a file that does not parse is an error that names it rather than an empty store.
- An out-of-credits error (OpenAI `insufficient_quota`, Anthropic "credit balance is too low", OpenRouter's 402) shows an "Out of credits" notice with the provider's own sentence and a pointer to `/model`, instead of the generic error box with the raw JSON body. The session activity file reports its category as `billing`.
- `/compact` compacts now through Cortex's `compactNow()`, whatever the context usage, keeping the most recent messages verbatim, and says what each loop did; a failure changes nothing. `/model`'s "compact first" does the same.
- Show memory health in the transcript: one notice when the memory model starts failing, one when it recovers, and one when messages were dropped before memory recorded them.
- Crash checkpoints always include observational memory; they dropped it whenever an observer was running.
- Breaking: `--compaction` is removed (classic compaction no longer exists in Cortex). Sessions saved by older builds, classic ones included, still list and resume. The footer always shows memory, and `/debug` always opens.

- Credentials resolve through Cortex's `ProviderManager.getAuth()` over `~/.cortex/credentials.json`, which is now pi-ai's `CredentialStore`. An OAuth refresh runs under the file's cross-process lock after checking again that it is still due, so concurrent requests and other `cortex` processes refresh a rotating token once; this replaces the in-process single-flight and the retry-on-rotation loop. A waiting writer now waits up to 30 seconds for the lock instead of three quick retries. Kimi Coding and GitHub Copilot OAuth carry their auth header and per-account base URL.
- `cortex -p` completes through Cortex's `completeModel()`, and Cortex Code no longer depends on pi-ai directly.
- Upgrade pi-ai and pi-tui to `1.1.0`, pinned exactly. pi-tui now asks the terminal at startup whether it supports program status reports (OSC 7501); `PI_PROGRAM_STATUS=0` turns that off.
- Windows sandboxing runs on MXC BaseContainer through Cortex instead of the unsigned restricted-token helper. It stays opt-in (`/sandbox workspace`) until validated on a real Windows 11 host, and needs `@microsoft/mxc-sdk` installed alongside Cortex Code.
- Upgrade pi-ai and pi-tui to `0.87.1`.
- Start a provider with no chosen model on that provider's own default from Cortex. A provider missing from the old defaults table used to fall back to the Anthropic model id, which it does not serve; a provider with no catalog (Ollama without a stored model) now asks for a model instead.
- Fix permission prompt ordering: tool and network asks now take the prompt lock in arrival order, so a stream of network asks can no longer starve a waiting tool ask, and a late or repeated lock release can no longer free another prompt's lock.

## 0.6.0

- Use Cortex's native Ollama integration for interactive sessions and `complete`, with context allocation settings and runtime diagnostics. Existing Ollama credentials remain supported; the server must run Ollama `0.15.0` or newer.
- Require Cortex `^0.6.0`, including its built-in sandbox implementation. Delegate sandbox policy, initialization, network wiring, and cleanup to Cortex.
- Add optional duplex mode through `--duplex` and `agentMode`; the CLI keeps single-loop mode as its default.
- Add OS sandbox integration, `/sandbox`, enforcement status, network-access prompts, and per-command escalation. macOS/Linux default to the workspace policy; Windows containment remains opt-in and requires a separately supplied helper binary.
- Harden in-process file permissions, protected configuration paths, credential handling, and per-session temporary directories. Add `sandbox.requireEnforcement` to refuse shell execution when containment is unavailable.
- Fix OAuth refresh races, custom-endpoint credential isolation, setup input and repainting, and internal-tag display.
- Upgrade pi-ai and pi-tui from the published `0.80.3` baseline to `0.85.1`. Default rendering behavior is unchanged; pi-tui no longer reads `PI_HARDWARE_CURSOR` or `PI_CLEAR_ON_SHRINK`, and its redraw debug variable is now `PI_TUI_DEBUG_REDRAW`.
- Breaking: session files moved to a composite artifact, and the move is one-way.
  A session now saves as `state.json`, which carries the session log, both
  agent loops' histories, observational memory and per-loop usage. The old
  pair (`history.json` plus `observations.json`) is still read, so existing
  sessions resume untouched, but sessions written by this version are not
  readable by an earlier build: downgrading and running `/resume` on one
  reports "Session not found". The durable `transcript.jsonl` is unaffected
  and stays readable by anything.
- Sessions are written to disk at startup and at every turn boundary, so a
  crash during a long task no longer loses the session.

## 0.5.0

- Show compact in-place retry status and surface error cause details.
- Answer permission prompts out of band through a control file.
- Show edited file paths under collapsed change groups.
- Add durable session transcript logging.
- Collapse tool display into a borderless activity stream.
- Add a lightweight complete command.
- Rebrand the TUI and OAuth callback page.
- Bundle brand assets through `tsup` and declare the `pi-ai` dependency.
