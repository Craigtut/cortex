# Sandboxing for consumers

Sandboxing is an opt-in capability of `@animus-labs/cortex`. Cortex creates the backend, policy, network gate, and temporary directory, shares them with its loops and sub-agents, and cleans up on `destroy()`. No separate sandbox package is needed.

## Enable it

Add one setting to your existing agent config:

```ts
const agent = await CortexAgent.create({
  model,
  workingDirectory: projectDirectory,
  getApiKey,
  sandbox: true,
});

try {
  await agent.prompt('Review this project');
} finally {
  await agent.destroy();
}
```

Omit `sandbox`, pass `false`, or set `{ enabled: false }` to opt out. Enabling it chooses the workspace policy. Cortex uses `workingDirectory` as the writable workspace and creates a private temporary directory. Built-in defaults protect common credential locations and dangerous configuration paths, including Git hooks and Git config.

Sandboxing and approval are separate settings. Existing permission callbacks continue to decide when to ask the user. Sandbox policy still blocks protected file operations if a callback approves them, and applies when no callback is supplied.

## Settings

Use an object when the defaults need adjustment:

```ts
const agent = await CortexAgent.create({
  model,
  workingDirectory: projectDirectory,
  getApiKey,
  sandbox: {
    workspaceRoots: [projectDirectory, sharedBuildDirectory],
    denyRead: [credentialsFile],
    denyWrite: [applicationSettingsDirectory],
    allowedDomains: ['api.example.com'],
    deniedDomains: ['blocked.example.com'],
    onStatusChange: (state) => updateSandboxIndicator(state),
  },
});
```

Paths resolve relative to `workingDirectory`. `workspaceRoots` replaces the default workspace list; deny paths and allowed domains extend the built-in protections and seeded registry list. Denied domains take precedence.

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` when settings are supplied | Opt out without removing config. |
| `rung` | `workspace` | Choose `restricted`, `workspace`, `trusted`, or `off`. |
| `workspaceRoots` | `[workingDirectory]` | Directories writable at workspace/trusted rungs. |
| `denyRead`, `denyWrite` | `[]` | Protect application secrets and settings in addition to defaults. |
| `allowedDomains`, `deniedDomains` | `[]` | Extend network policy. |
| `requireEnforcement` | `true` | Refuse setup/execution if the requested OS boundary is unavailable or partial. |
| `onStatusChange` | absent | Observe effective policy and enforcement. |
| `provider` | platform backend | Advanced backend override; Cortex initializes and disposes it. |

A host that cannot enforce the requested policy causes `CortexAgent.create()` to reject. An enforcement failure during the session blocks later tool execution. To explicitly allow degraded operation, set `requireEnforcement: false` and use `onStatusChange` or `getSandboxState()` to display what is actually enforced. This does not turn missing OS protections into working protections.

## Network decisions

Cortex applies the same network policy to sandboxed shell traffic and WebFetch. Workspace policy pre-allows seeded package registries and your `allowedDomains`. Unknown domains are denied unless you supply `resolveNetworkAccess`:

```ts
const agent = await CortexAgent.create({
  model,
  workingDirectory: projectDirectory,
  getApiKey,
  sandbox: true,
  resolveNetworkAccess: async (request) => {
    const allowed = await askUserAboutHost(request.host);
    return allowed
      ? { decision: 'allow', scope: 'session' }
      : { decision: 'deny' };
  },
});
```

Cortex wires the backend callback automatically, including the duplex permission broker. There is no second callback to attach after creation. Session grants apply to both request paths; persistence of longer-lived preferences belongs to the consumer. Explicit denials always win. Restricted policy denies network access. WebFetch's separate SSRF protections remain in force.

## Inspect and change policy

`agent.getSandboxState()` returns a snapshot of the effective rung, policy, backend, and filesystem/network enforcement. It returns `undefined` when there is no managed sandbox.

After work settles, trusted host code can call `await agent.setSandboxRung('restricted')`. Calls during active work are rejected. Connected stdio MCP servers must be disconnected first and reconnected afterward, because an already running subprocess keeps the OS profile it launched with. Do not expose this method as a model tool. Consumers decide which policy changes their users may make and whether preferences should persist.

To begin uncontained but allow later activation, use `{ rung: 'off' }`. This keeps a managed controller available without starting an OS backend. `sandbox: false` creates no controller.

## Consumer responsibilities and limits

Use trusted host configuration for writable roots, secrets, and settings. Add product-specific credential files to `denyRead` and product configuration to `denyWrite`. Do not derive writable roots from model tool arguments or untrusted repository settings.

Built-in Read, Write, Edit, UndoEdit, and Glob receive in-process path checks. Bash, Grep, skill shell markers, and managed stdio MCP spawns use the backend. Custom tools that perform their own filesystem or network operations still run inside the host process; they must use the same policy or an appropriate isolated execution path. Remote MCP servers run outside this host's sandbox. Skill script markers (`!{script: ...}`) run in the host process, outside the subprocess boundary, and should come from trusted skills. See [architecture and limits](./sandboxing.md).

Single-command Bash escalation is still a separate approval. Cortex uses `BASH_ESCALATION_PERMISSION_NAME` (`Bash(escalate)`) and refuses escalation without a permission resolver. A consumer resolver must treat it as a request to leave containment, rather than blindly allowing it.

Native Windows uses Microsoft eXecution Containers (MXC), BaseContainer tier only. It needs Windows 11 24H2/25H2 with the August 2026 update (KB5120998) or 26H1/26H2, and Node 24.21+ (or 26.8+). Microsoft's SDK, `@microsoft/mxc-sdk`, needs no separate install: on Windows npm installs it with Cortex, through the optional dependency `@animus-labs/cortex-win32`, and macOS and Linux installs never download it. It goes missing when optional dependencies were omitted (`--omit=optional`) or `node_modules` or the lockfile came from another OS; `npm install` on the Windows machine restores it. An SDK the project installs itself takes precedence. When any requirement is missing, status is `none` with the reason and strict setup refuses; Cortex never substitutes weaker containment. Contained HTTP(S) clients must honor `HTTP_PROXY`/`HTTPS_PROXY`, because direct egress is blocked. See the [Windows runbook](./windows-sandbox-build.md) for the validation checklist.

## Advanced providers and migration

Most consumers should use `sandbox: true` or settings. The platform implementations remain separate modules within Cortex. `createSandboxProvider`, `buildDefaultPolicy`, and the provider/policy types are exported from `@animus-labs/cortex` for advanced integrations.

An uninitialized custom backend can be supplied through `sandbox: { provider }`; Cortex owns initialization, policy, temporary-directory lifetime, and disposal. A custom backend must implement the network behavior it promises in its status. The built-in network callback wiring applies to the default backend.

For compatibility, passing an already initialized `SandboxProvider` directly as `sandbox` still borrows that provider. Its owner must initialize, wire network callbacks, and dispose it. `AgentLoopConfig.sandbox` also remains this low-level borrowed-provider API. Use `CortexAgent` for managed setup.

Consumers of the former separate package should remove that dependency and replace provider construction and teardown with settings on `CortexAgent.create()`. Move product-specific deny paths and network domains into the settings object. Remove manual temporary-directory creation and `getNetworkAccessResolver()` wiring when adopting managed setup.
