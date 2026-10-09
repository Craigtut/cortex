# Windows sandbox: MXC setup and validation

Cortex contains commands on native Windows with Microsoft eXecution Containers
(MXC), BaseContainer tier only. This runbook covers what a Windows host needs,
how to confirm containment is active, and the checklist that still has to pass
on a real Windows 11 machine. The design and its tradeoffs are in
[`sandboxing.md`](./sandboxing.md) ("Windows backend: MXC BaseContainer").

## Requirements

- Windows 11 24H2 or 25H2 at build `.9278` or later (the August 2026 update,
  KB5120998), or 26H1/26H2. KB5120998 rolls MXC out gradually, so Cortex
  never compares build numbers; the runtime probe decides.
- Node 24.21 or later in the 24 line, or 26.8 or later (MXC's native stdio
  transfer).
- `@microsoft/mxc-sdk` 1.x installed where Cortex can resolve it:
  `npm install @microsoft/mxc-sdk` in the project that depends on Cortex, or
  `npm install -g @microsoft/mxc-sdk` next to a global Cortex Code install.
  Cortex declares it as an optional peer dependency so macOS and Linux installs
  never download its roughly 105 MB (plus node-pty).

Install Cortex and the SDK outside the agent's workspace. When they live inside
a writable root, the provider carves them out read-only but still reports
filesystem `partial`, because a contained command could shadow the SDK's
dependencies through Node module resolution.

## Confirm it is active

`agent.getSandboxState()` reports backend `mxc-base-container` with filesystem
and network `enforced`. Otherwise it reports backend `none` and the reason in
`status.degradations`, for example a missing SDK, a build without the process
security environment, a missing native capability (`filesystemDeniedPaths`,
`ingressHostLoopbackAllow`), or an unsupported Node. Strict managed setup
(`sandbox: true`) then rejects `CortexAgent.create()`. Cortex never substitutes
weaker containment and never accepts MXC's AppContainer tiers.

A command the launcher refuses to start fails with exit code 125 and a
`cortex-mxc-launcher:` line on stderr. The command did not run.

## What ships

Cortex ships no native binary for Windows. The launcher is JavaScript that
runs under the same `node.exe` as the agent. The native pieces (`mxc_ffi.dll`,
`wxc-exec.exe`, and the rest of `bin/<arch>/`) come from `@microsoft/mxc-sdk`
and carry embedded Authenticode signatures from Microsoft Corporation (issuer:
Microsoft Code Signing PCA 2024) for both x64 and arm64 in the 1.0.0 tarball.
That was read from the certificate tables; `signtool verify` has not been run
on Windows.

## Real-host validation checklist

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

## The removed restricted-token helper

Before MXC, Windows used a Cortex-built Rust helper that ran commands under a
`WRITE_RESTRICTED` token. It confined writes but could not deny secret reads or
enforce network policy, so it reported filesystem `partial` and network
`none`, and it was never Authenticode-signed. It was removed when MXC became
the Windows backend; its source remains in git history.
