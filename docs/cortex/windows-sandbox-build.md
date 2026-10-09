# Windows sandbox helper: build, sign, ship

How the native Windows Tier-1 sandbox helper is produced, signed, and bundled,
plus exactly what it does and does not enforce. This is the operational
companion to the design in [`sandboxing.md`](./sandboxing.md) ("Layer 3: native
Windows (no WSL2)").

> **Status: built and behaviorally verified on Windows; code-signing still
> pending.** The helper crate (`packages/cortex/windows-helper`) now
> compiles clean on `x86_64-pc-windows-msvc` (Rust 1.94 / `windows` crate 0.58),
> its `cargo test` suite passes, and the full adversarial containment suite
> (`tests/windows-containment.integration.test.ts`, run through the real
> `WindowsRestrictedTokenProvider` with a locally-built binary) passes: writes
> are confined to the workspace roots and the per-session sandbox temp; writes to
> the agent config, `.git/hooks`, `.git/config`, and outside the workspace are
> denied; reads stay broad; credential env vars are scrubbed; and exit codes and
> stdio pass through. Two corrections were needed on the first real build and are
> called out below (the restricting principal is a synthetic `S-1-5-21` SID, not
> a capability SID; the policy loader tolerates a UTF-8 BOM). What remains before
> a production ship is the **Authenticode signing + CI pipeline** (an unsigned
> token-manipulating exe is flagged by Defender/SmartScreen) and the ARM64 build.
> The bundled binary at `vendor/win32-x64/` is git-ignored precisely because the
> repo must never carry an unsigned native binary; CI builds, signs, and packs it.

> **Superseded.** `createSandboxProvider` now selects the MXC BaseContainer
> backend on Windows (design: [`sandboxing.md`](./sandboxing.md), "Windows
> backend: MXC BaseContainer"). The helper material below is kept only until
> the helper is removed.

## MXC BaseContainer: real-host validation checklist

Nothing below has run on Windows yet. The MXC backend is covered on any OS by
unit tests (policy mapping, provider against a faked SDK boundary, launcher
entry point against a fake SDK module, real host-side proxy). Every item here
needs a real Windows 11 host with PSEC, and none of it can run on GitHub's
`windows-latest` (Windows Server 2025; MXC documents Windows 11 only and its
own hosted-runner jobs skip real sandbox tests). Run it on a self-hosted
Windows 11 machine; the `windows-11-arm` hosted image (build 26200.9457) is
worth one attempt, but whether PSEC is enabled there is unknown.

**Setup.**

- Windows 11 24H2/25H2 at build `.9278` or later (KB5120998), or 26H1/26H2.
  KB5120998 rolls MXC out gradually, so a matching build alone proves nothing;
  the probe decides.
- Node 24.21+ (or 26.8+), Cortex built, and `npm install @microsoft/mxc-sdk`
  next to Cortex, outside the test workspace.
- An agent created with `sandbox: true` (strict) and a `workingDirectory` that
  is a git repository, plus a second run with `{ rung: 'restricted' }`.
- Record `getSandboxState()` and, from the launcher's probe, the SDK's
  `getAvailableBackends()` output for the report.

**Checklist.** Run each command through the Bash tool, in both `pwsh.exe` and
`powershell.exe`, unless the item names another path.

1. **Probe and status.** State is `mxc-base-container`, filesystem and network
   `enforced`, no degradations. On a host without PSEC (or with the SDK
   uninstalled) state is `none` with a readable reason, `CortexAgent.create()`
   rejects under strict settings, and no host ACL changed (compare
   `icacls` of the workspace before and after).
2. **Writes outside the workspace denied.** `Set-Content $env:USERPROFILE\escape.txt x`,
   `Set-Content C:\escape.txt x`, and a write to a second drive fail, and no
   file appears. Writes inside the workspace and to `$env:TEMP` succeed, and
   `$env:TEMP` is the session temp, not the user's temp.
3. **Protected paths inside the workspace.** Writing `.git\hooks\pre-commit`,
   `.git\config`, and the consumer's `.cortex` directory fails, while
   `git commit` still works. In a repo with no `.git\hooks` directory,
   creating it fails (MXC's handling of missing carve-out paths is unverified).
4. **Secret reads denied.** `Get-Content $env:USERPROFILE\.ssh\<key>`,
   `Get-ChildItem $env:USERPROFILE\.ssh`, and `Get-Content $env:USERPROFILE\.npmrc`
   fail. A secret file created after the session started is denied on the
   next command. Credential variables (`$env:GITHUB_TOKEN`) are empty.
5. **Reads stay broad.** Repo files, `git status`, `node -v`, `npm -v`,
   `%APPDATA%\npm`, `C:\Program Files\Git`, and a file on a second drive are
   readable. Note that an entry created directly under a volume root after the
   session started is not readable until the next policy change.
6. **Egress only through the proxy.** In workspace mode,
   `curl.exe https://registry.npmjs.org/` succeeds, `curl.exe https://example.com/`
   is refused by the proxy (or reaches `resolveNetworkAccess`), and
   `curl.exe --noproxy "*" https://registry.npmjs.org/` fails because direct
   egress is blocked. `Test-NetConnection 1.1.1.1 -Port 443` fails.
   `npm view left-pad version` and `git ls-remote https://github.com/git/git`
   work. Record what `Invoke-WebRequest` does in `pwsh.exe` (honors
   `HTTP_PROXY`) and in Windows PowerShell 5.1 (may not). In restricted mode
   every egress attempt fails and no proxy variables are set.
7. **Loopback.** A server on host `127.0.0.1` and on `::1` is reachable from a
   contained command. A server started in a background Bash task is reachable
   from the host and from another contained command (MXC notes host-to-container
   listener timeouts in some modes). In restricted mode with local binding
   allowed, loopback still works.
8. **UI isolation.** `Get-Clipboard` returns nothing from the host clipboard and
   `Set-Clipboard` does not change it. Synthetic input
   (`[System.Windows.Forms.SendKeys]::SendWait`) does not reach host windows.
   Record where `Start-Process notepad` shows a window, if anywhere.
9. **Background processes.** A Bash background task (`npm run dev`) stays
   alive until killed through TaskOutput. A detached server started inside a
   foreground command (`Start-Process node server.js` followed by the command
   returning) is killed when the command returns; this is expected MXC
   behavior, but confirm it. A foreground timeout kill and `taskkill /F` of the
   agent process leave no contained process behind (`Get-Process` before and
   after).
10. **Grep through `wrapExec`.** Grep finds workspace content. Grep aimed at
    `~\.ssh` returns no content and reports `usingFallback: false`.
11. **Stdio MCP through `wrapExec`.** A stdio MCP server (for example
    `@modelcontextprotocol/server-filesystem`) connects, lists tools, and
    answers calls through the launcher's stdin and stdout relay. It cannot
    write outside the workspace or read `~\.ssh`, and disconnecting stops its
    process.
12. **The Bash tool's real `execute()` path.** Through `CortexAgent`, not a
    hand-built provider: exit codes, separate stdout and stderr, cwd tracking
    across commands, UTF-8 output, a command with embedded quotes and
    backslashes (`echo "a \"b\" C:\path\"`), a long command near the
    command-line limit, credential scrubbing, and an approved
    `escalateOutsideSandbox` run that executes uncontained. Skill shell markers
    are contained too.
13. **Failure handling.** Renaming the SDK directory mid-session makes the next
    command fail with `cortex-mxc-launcher:` and exit 125, and the command does
    not run. A workspace that contains `node_modules\@microsoft\mxc-sdk`
    reports filesystem `partial` with the module-resolution note.
14. **Cost and architecture.** Time `echo hi` contained and uncontained to
    measure the per-command launcher overhead. Repeat the core items on
    Windows on ARM64.

## What ships, and how the pieces fit

- **Rust helper** (`packages/cortex/windows-helper`): a small exe,
  `cortex-sandbox-helper.exe`, built for Windows and Authenticode-signed.
- **TS provider** (`packages/cortex/src/sandbox/backends/windows.ts`,
  `WindowsRestrictedTokenProvider`): on win32, Cortex's Bash tool spawns the
  helper in place of the shell. It writes the policy JSON to a private
  per-session directory that is never under a writable root (and lists that
  directory in `denyWritePaths`, so a sandboxed command cannot swap the policy
  that governs the next command) and builds the argv
  `helper.exe <policy.json> -- <shell> <shellArgs...> <command>`. It also points
  the child's `TEMP`/`TMP` at a dedicated per-session sandbox temp; the
  machine's real temp root is never a writable root, never granted to the cap
  SID, and never Low-labeled.
- **Factory** (`createSandboxProvider`): returns the Windows provider on win32
  and the sandbox-runtime provider (Seatbelt/bubblewrap) on macOS/Linux.
- The JS install never builds Rust. The signed binary is prebuilt on Windows CI
  and shipped in the package under `vendor/win32-x64/`. If it is absent at
  runtime, the provider reports honest UNCONTAINED `none` and passes commands
  through unchanged (the Node layer owns the "run uncontained" decision; the
  helper itself never runs a command uncontained).

## Build

Prerequisites on the Windows build agent:

- Rust stable with the MSVC toolchain (`rustup default stable-msvc`).
- The target: `rustup target add x86_64-pc-windows-msvc` (and
  `aarch64-pc-windows-msvc` for ARM64). `rust-toolchain.toml` pins both.
- Visual Studio Build Tools (the MSVC linker; the `windows` crate links against
  the Windows SDK import libs).

```powershell
cd packages\cortex\windows-helper
cargo build --release --target x86_64-pc-windows-msvc
cargo test  --target x86_64-pc-windows-msvc   # policy + command-line unit tests
```

The `windows` crate feature flags in `Cargo.toml` are scoped to only the module
trees the recipe touches. If a `cargo build` reports a missing symbol, it is
almost always a feature that needs adding or a symbol path that moved between
`windows` crate versions; fix the feature list / import rather than widening the
recipe.

First-build findings (all resolved; recorded so the reasoning is not lost):

- **Symbol paths and return-type wrapping (mechanical).** On `windows` 0.58 a
  handful of imports moved or needed newtype wrapping: `PSID` lives under
  `Win32::Security` (not `Foundation`), `LocalFree` under `Win32::Foundation`,
  `CreateRestrictedToken`'s flags take `CREATE_RESTRICTED_TOKEN_FLAGS(_)`,
  `CreateWellKnownSid`/`ConvertStringSidToSidW` take a `PSID` (use
  `PSID::default()` for the sizing call, not `None`), the `*W` security-info
  setters take `PCWSTR`, and the `BOOL` params take a bare `bool`. Each was fixed
  at the call site without changing the Win32 call sequence.
- **The restricting principal must be a normal account SID, not a capability
  SID (behavioral).** The scaffold derived the restricting SID with
  `DeriveCapabilitySidsFromName` (an `S-1-15-3-…` capability SID). `windows`
  0.58 does not expose that symbol under the enabled features, and more
  importantly `CreateRestrictedToken` **rejects a capability SID in its
  `SidsToRestrict` list with `ERROR_INVALID_PARAMETER`** — capability SIDs are
  only meaningful inside an AppContainer. Codex's shipped helper uses a synthetic
  account SID for exactly this reason. The helper now derives a deterministic
  `S-1-5-21-a-b-c-d` SID from the per-install + per-workspace name (a 128-bit
  hash fills the four sub-authorities) via `ConvertStringSidToSidW`. This keeps
  every property the design wanted (per-workspace determinism, ACE reuse across
  runs, no cross-workspace authorization) using the SID type the API accepts.
  The design note's phrase "the official `windows` crate covers every API" and
  its reference to `DeriveCapabilitySidsFromName` are superseded by this.
- **Policy loader tolerates a UTF-8 BOM.** The TS provider writes the policy
  file without a BOM, but a hand-authored policy (PowerShell `Set-Content`,
  Notepad) usually carries one and `serde_json` rejects it. `Policy::load` now
  strips a leading BOM before parsing so a manually-produced policy still loads.
- **`SETUP_FAILURE_EXIT` (87) disambiguation is implemented.** Because a real
  child can also exit 87, the helper now prints a stable stderr sentinel
  `cortex-sandbox-helper[setup-failure]:` ONLY on a containment-setup failure
  (when the child never ran). The TS side exports
  `WINDOWS_HELPER_SETUP_FAILURE_SENTINEL` and `isHelperSetupFailure({exitCode,
  stderr})`, which keys on the sentinel with the exit code as a cheap pre-check.
  A real child exiting 87 does not print the helper's own sentinel line, so the
  two cases are now distinguishable.

Output: `target\x86_64-pc-windows-msvc\release\cortex-sandbox-helper.exe`.

## Sign and timestamp (required for public distribution, not to run)

Signing is **not** required for the helper to run or contain: Windows runs an
unelevated unsigned exe, and the adversarial suite passes against a locally-built
unsigned binary. What signing buys is *trust/reputation* so that when you
distribute the binary to other people's machines, antivirus/EDR does not flag it.
An exe that manipulates tokens, edits ACLs, and spawns children is exactly the
behavior profile Microsoft Defender, SmartScreen, and third-party EDR treat as
suspicious, so **a publicly distributed build should be signed and timestamped.**
When you cannot sign (yet), the provider degrades gracefully rather than breaking
(see "Running unsigned" below).

For an open-source project publishing to npm, the practical signing paths are
[SignPath Foundation](https://signpath.io/solutions/open-source-community) (free
OV code signing for qualifying OSS, CI-integrated) or
[Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/)
(cheap, self-serve, Microsoft-trusted root). Pair either with `npm publish
--provenance` (a sigstore attestation proving the tarball was built from a
specific commit) for the OSS supply-chain trust story. `signtool` recipe:

```powershell
signtool sign `
  /fd SHA256 `
  /a `
  /tr http://timestamp.digicert.com `
  /td SHA256 `
  target\x86_64-pc-windows-msvc\release\cortex-sandbox-helper.exe

signtool verify /pa /v cortex-sandbox-helper.exe
```

- Use an OV or EV Authenticode code-signing certificate. EV (or enrolling the
  product in the Microsoft Trusted Signing / former Partner Center program)
  builds SmartScreen reputation fastest; a fresh OV cert still shows "unknown
  publisher" warnings until reputation accrues.
- **Always timestamp** (`/tr` + `/td SHA256`). Without a countersignature the
  signature expires with the certificate; with one it stays valid after the cert
  expires.
- The app manifest (`app.manifest`, embedded by `build.rs`) sets
  `requestedExecutionLevel=asInvoker`: the helper is unelevated and must never
  raise a UAC prompt.

## Running unsigned: graceful degradation and opt-in posture

Because an unsigned token-manipulating helper is a plausible antivirus
false-positive, the system is built so the worst case is "honestly reports
uncontained," never "breaks the user's shell." Four mechanisms:

1. **Execution preflight (`--selftest`).** `initialize()` does not just check that
   the binary exists; it runs `helper --selftest`, which opens the process token,
   builds a `WRITE_RESTRICTED` restricted token, and creates a job object (the
   AV-sensitive operations) with no filesystem side effects, then prints
   `cortex-sandbox-helper[selftest]: ok`. If the helper is present but cannot run
   (quarantined/blocked by security software, corrupted, or wrong-arch), the
   provider reports honest `none` up front instead of claiming `partial` and then
   failing every command. (`runHelperSelfTest` in `src/windows.ts`.)
2. **Mid-session degradation (`notifyWrappedSpawnFailure`).** If the helper passes
   the preflight but is quarantined LATER in the session, the next wrapped spawn
   fails to launch. Because a wrapped command runs *inside* the helper, a spawn
   error is unambiguously the helper failing (never the user's command), so the
   Bash tool tells the provider to drop to `none` (subsequent commands pass
   through uncontained, surfaced via `onDegraded` and the status line) and reports
   that the command did not run.
3. **Windows containment is opt-in until signed.** In cortex-code a fresh
   workspace defaults to rung `off` on Windows (every other platform defaults to
   `workspace`), so the unsigned helper is never spawned unless a user opts in
   with `/sandbox workspace`. A consumer shipping a signed helper flips this by
   setting `sandbox.rung`.
4. **Optional refuse-to-run (`sandbox.requireEnforcement`).** The opposite lever:
   a consumer who would rather fail closed than silently run uncontained sets
   this, and at a contained rung with no working backend, shell commands are
   blocked (not run uncontained). A working-but-partial backend (Tier 1: writes
   confined, secret reads not) still counts as enforcing and is allowed.

On the user-facing wording for a blocked helper: lead with the observable and the
consequence ("the helper is present but could not run, so shell commands run
WITHOUT OS containment"), name antivirus as the *likely* cause hedged rather than
asserted (it can also be a corrupted binary or a system policy), and give both
the restore action (allow/restore the exe, or use a signed build) and the dismiss
action (turn the sandbox off). Naming antivirus helps users resolve it fast
without misdirecting the ones whose cause is something else.

## Ship / bundle

Place the signed binary where the provider looks for it (see
`defaultHelperPath()` in `src/windows.ts`):

```
packages/cortex/vendor/win32-x64/cortex-sandbox-helper.exe
```

The package's `files` allowlist must include `vendor/` so the binary is
published in the npm tarball. A consumer that stores the helper elsewhere passes
an explicit `helperPath` to the provider. The build is wired as an npm script
(`build:helper:win`) that runs only on Windows; it is deliberately **not** part
of the default `build`, so `npm install`/`npm run build` on macOS/Linux/CI never
requires a Rust toolchain.

## Min-OS matrix

| OS | Tier 1 (this helper) |
|----|----------------------|
| Windows 10 1809 (build 17763) | Floor. Restricted tokens, capability SIDs, job objects, and the process mitigations used here are all available. |
| Windows 10 1903+ / Windows 11 | Supported. |
| Windows Server 2019 / 2022 | Supported (same API surface). |
| Windows 10 < 1809, Windows 8.1, 7 | Not supported. The provider should report `none`; do not ship the helper for these. |

Architectures: `x86_64` (primary) and `aarch64` (Windows on ARM). Build and sign
one binary per architecture and bundle under `vendor/win32-x64` and
`vendor/win32-arm64`; extend `defaultHelperPath()` to select by `process.arch`
when the ARM64 binary is added.

## What Tier 1 enforces (and what it does not)

Because secret reads are NOT denied (below), the provider reports filesystem
**`partial`**, never `enforced`, alongside network `none`.

> Terminology: "capability SID" below (and the `capabilitySidName` field in code)
> is a historical name for the **synthetic restricting SID**. As the first-build
> findings above explain, that SID is a deterministic `S-1-5-21` account SID, not
> a literal AppContainer capability SID (`S-1-15-3-…`); the field name was kept
> to avoid churning the TS interface and the Rust policy contract. Everything the
> word describes (a restricting principal that gates writes) is accurate.

**Enforced (writes + environment):**

- Writes are confined to the workspace roots + the per-session sandbox temp. A
  `WRITE_RESTRICTED` token means a write must satisfy BOTH the normal token AND a
  restricting capability SID; only the writable roots carry an allow ACE for that
  SID. Reads never consult the restricting list, so the repo, npm/pip/cargo
  caches, and git config stay readable with zero grants. The capability SID name
  is derived per install AND per workspace (base name + a hash of the canonical
  workspace roots), so the grant ACEs that persist on one workspace's
  directories never authorize a session running in another workspace.
- The agent config, `.git/hooks` / `.git/config`, and the policy file's own
  directory get deny-write ACEs for the capability SID. These are effective:
  writes do consult the restricting SID, and deny ACEs are evaluated before
  allows.
- Credential environment variables are stripped from the child by the Node
  provider before the helper is even spawned. On Tier 1 this is the PRIMARY
  credential control (see the read gap below).
- The child's `TEMP`/`TMP` point at the dedicated sandbox temp, and the
  machine's real temp root is excluded from the writable roots.
- With Low integrity on (opt-in, off by default), MIC adds a third write gate on
  top of the DACL checks (see the tradeoff below).
- The child runs in a kill-on-close job object, so it cannot outlive the helper,
  and under image-load mitigations that block DLL loads from remote or
  Low-labeled locations.

**NOT enforced (secret reads):** deny-read ACEs are applied to secret paths
(`~/.ssh`, `~/.aws`, credential files, ...) but they are **inert at Tier 1**. A
same-user `WRITE_RESTRICTED` token evaluates the restricting capability SID for
WRITE access only; reads are checked against the normal token, which can read
the user's own files, so `type %USERPROFILE%\.ssh\id_rsa` succeeds. What Tier 1
delivers against credential theft is the env scrub plus write confinement, not
file-read denial. Read denial requires the elevated Tier-2 dedicated sandbox
user, whose own token simply has no access to the signed-in user's secrets (the
already-applied deny ACEs also become meaningful for such a token). We surface
this plainly rather than implying containment we do not deliver.

**NOT enforced (network):** Tier 1 is unelevated and has no network boundary.
Proxy environment variables are the only lever and a command that opens a socket
directly ignores them. The provider therefore reports network **`none`**, never
`partial`, and the Workspace rung's network guarantee does not hold on Windows
until Tier 2 ships. In-process WebFetch is still gated by the app-level
`resolveNetworkAccess` policy, but shell egress is not contained.

**NOT enforced (window station / desktop):** the restricted child runs on the
parent's interactive window station and desktop, which exposes UI-message attack
surface (`SetWindowsHookEx`, `SendMessage`, clipboard) toward same-desktop
windows. A private winsta/desktop for the child is a known Tier-1 gap (TODO in
`process.rs`).

## Two decisions that diverge from the literal design (and why)

The scaffold intentionally departs from two phrases in the original design note.
Both are called out here so a reviewer can weigh them.

1. **Low integrity is opt-in, not the default.** The design note listed
   "drops to Low integrity" as part of the recipe; the shipped default is
   Medium (LUA_TOKEN), matching Codex, with `lowIntegrity: true` as the opt-in.
   Dropping to Low is real defense-in-depth (a third, MIC-level write gate), but
   it comes with costs: the helper must stamp an inheritable Low mandatory label
   on the writable roots so the Low child can write them, that label
   **persists** on the user's real project directory after the command finishes,
   and a Low child can be blocked from editing pre-existing Medium-labeled files
   inside the workspace. The capability-SID `WRITE_RESTRICTED` mechanism fully
   confines writes without Low, so Medium is the safer functional default. When
   Low is enabled, only the workspace roots and the dedicated per-session
   sandbox temp are ever labeled; the machine's real temp root is excluded from
   the writable roots and is never Low-labeled.

2. **The most aggressive process mitigations are wired but disabled by default.**
   The design lists "win32k lockdown, MS-signed-binary, image-load restrictions."
   The image-load restrictions (no remote, no Low-label, prefer System32) and
   extension-point-disable are enabled: they harden a coding agent without
   breaking it. But `BLOCK_NON_MICROSOFT_BINARIES` would block loading
   `node.exe`, `git.exe`, `python.exe`, `cargo.exe` (all non-Microsoft-signed) —
   i.e. the entire toolchain — and `WIN32K_SYSTEM_CALL_DISABLE` /
   `PROHIBIT_DYNAMIC_CODE` break GUI-linked tools and every JIT (Node/V8, .NET,
   PowerShell). Enabling them by default would make the sandbox unusable, so they
   are present as named constants with a single flip point (`DEFAULT_MITIGATIONS`
   in `process.rs`) for a hardened deployment that runs only Microsoft-signed,
   non-JIT console tools. Codex likewise does not enable them.

## Adversarial containment tests (run on Windows before trusting it)

These are codified as an automated suite in
`packages/cortex/tests/unit/sandbox/windows-containment.integration.test.ts`, which
drives the real `WindowsRestrictedTokenProvider` with the bundled binary and
skips on any non-win32 host or when the binary is absent. It uses **PowerShell**
as the shell, matching cortex's own `selectWindowsShell` and the helper's
command-line reconstruction (Node's `child_process.spawn` and PowerShell both
use CommandLineToArgvW quoting; `cmd.exe` has its own quote parser and is never
used by cortex on Windows, so the helper matches `spawn`, not `cmd`). Run it with
`npx vitest run tests/windows-containment.integration.test.ts` from
`packages/cortex`.

The suite asserts (verified passing on a local build) that each of these is
**denied** (non-zero, and the write does not land on disk):

- Write outside the workspace: `echo x > %USERPROFILE%\escape.txt`.
- Write the agent config: `echo x > %USERPROFILE%\.cortex\settings.json`.
- Write a git hook: `echo x > <repo>\.git\hooks\pre-commit`.
- Overwrite the session policy file: `echo x > <policyDir>\policy.json`.
- Write to the real temp root: `echo x > %USERPROFILE%\AppData\Local\Temp\escape.txt`
  (the child's `%TEMP%` points at the sandbox temp; the real root is not
  granted).
- DLL plant + load from the Low-labeled workspace (with Low integrity opted in).

And assert these **succeed** (the sandbox must not over-block):

- Read the repo, `%APPDATA%\npm`, `%USERPROFILE%\.cargo`, git config.
- Write inside the workspace and the sandbox temp (including via `%TEMP%`).
- Bind and connect to loopback (a local dev server / MCP over 127.0.0.1).

Do NOT assert that reading a secret (`type %USERPROFILE%\.ssh\id_rsa`) is
denied: at Tier 1 it is expected to SUCCEED (the deny-read ACEs are inert under
a same-user `WRITE_RESTRICTED` token; see above). A test may assert it succeeds
to document the gap; the read-denied assertion belongs to the future Tier-2
dedicated-user suite. Also assert that a credential env var (e.g.
`GITHUB_TOKEN`) is absent inside the sandboxed child, since the env scrub is
Tier 1's credential control.

A silently-broken sandbox is worse than none: if these do not all pass, the
provider must keep reporting UNCONTAINED `none` rather than claim the Tier-1
`partial`.

## Out of scope (future work)

- **Elevated Tier 2 (hard network).** A one-time admin setup that adds WFP
  filters blocking all egress for sandboxed commands except the local filtering
  proxy (WFP filters on IP and port; the proxy still does domain policy). This is
  where real network enforcement on Windows comes from. Not built.
- **Dedicated sandbox users.** Codex's stronger model runs commands as dedicated
  low-privilege accounts (`CodexSandboxOffline`/`Online`) rather than a
  restricted version of the signed-in user. Also a Tier-2 concern, and the
  prerequisite for secret-file READ denial on Windows: a dedicated user's token
  has no access to the signed-in user's files, and the deny-read ACEs Tier 1
  already applies start being evaluated for real.
- **CI signing pipeline.** Automating the build + sign + notarize + bundle on a
  Windows runner is not wired here; the commands above are the manual recipe.
- **ARM64 binary.** The build supports it; producing and bundling it is pending.
- **Unforgeable per-command setup-failure signal.** The helper prints the
  `cortex-sandbox-helper[setup-failure]:` sentinel to stderr, and Node exposes
  `isHelperSetupFailure` to recognize it, but nothing acts on it to change
  containment state. That is deliberate: stderr is the sandboxed child's own
  channel, so a malicious command could forge the sentinel (and exit 87) to trick
  the Node layer into degrading to uncontained — a self-inflicted escape. Only the
  helper-LAUNCH failure (an unforgeable spawn `'error'` on the helper itself, which
  the child cannot cause because the helper lives outside every writable root)
  drives a degrade. Making the *per-command* setup failure trustworthy needs a
  dedicated status channel: a pipe/handle Node creates and passes to the helper
  but NOT to the child, which the helper writes setup-success/failure to before
  spawning. Until then, a genuine per-command setup failure surfaces as exit 87
  with its human-readable reason on stderr, and the honest fix for a persistent
  one is `/sandbox off` or clearing the antivirus block. The preflight
  (`--selftest`) already catches the dominant case (a helper that cannot run or
  create a restricted token at all) at initialize time.

## Managed Cortex setup

The helper is now part of the Cortex package layout. `CortexAgent` manages its lifecycle when sandboxing is enabled. Strict managed setup requires the requested protections and rejects the current partial Tier 1 boundary; explicitly set `requireEnforcement: false` to accept it. Cortex Code retains its explicit degraded-operation preference and Windows opt-in default.
