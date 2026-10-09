/**
 * OS-level sandbox seam for Cortex.
 *
 * Cortex owns managed sandbox setup through CortexAgentConfig.sandbox.
 * Platform backends translate SandboxPolicy into OS boundaries and wrap
 * subprocess spawns. AgentLoop accepts a borrowed provider for advanced use.
 *
 * See docs/cortex/sandboxing.md for the design.
 */

/** Trust rungs, most contained to least. Each is a preset over both axes. */
export type SandboxRung = 'restricted' | 'workspace' | 'trusted' | 'off';

export interface SandboxFilesystemPolicy {
  /**
   * Absolute paths the sandboxed process may write. Established from trusted
   * session configuration, NEVER from model-controlled tool input (a tool's
   * cwd argument must not widen this; see CVE-2025-59532 for why this matters).
   */
  writableRoots: string[];
  /** Absolute paths that must never be readable (secrets, credential stores). */
  denyRead: string[];
  /** Absolute paths that must never be written (agent config, .git/hooks, .git/config). */
  denyWrite: string[];
  /** Absolute paths re-allowed for read within a denyRead subtree. */
  allowRead?: string[];
  /**
   * The per-session writable temp dir (a member of writableRoots), created by
   * Cortex to scope temp writes instead of granting the whole machine
   * temp root. When set, a provider points the sandboxed child's TMPDIR/TEMP/TMP
   * at it so a tool writing to its default temp lands inside the boundary.
   * Absent when the whole os.tmpdir() is the writable temp (legacy behavior).
   */
  sessionTmpDir?: string;
}

export type SandboxNetworkMode = 'deny' | 'allowlist' | 'full';

export interface SandboxNetworkPolicy {
  /** deny = no egress; allowlist = only allowedDomains; full = unrestricted. */
  mode: SandboxNetworkMode;
  /** Domain patterns allowed without prompting. Supports a leading "*." wildcard. */
  allowedDomains: string[];
  /** Domain patterns always denied; evaluated before allowedDomains. */
  deniedDomains: string[];
  /**
   * Allow connecting/binding to loopback so local MCP servers and dev servers
   * remain reachable. Defaults to true. Note that open loopback is an attack
   * surface: an injected agent can reach local services through it.
   */
  allowLocalBinding?: boolean;
}

export interface SandboxPolicy {
  rung: SandboxRung;
  filesystem: SandboxFilesystemPolicy;
  network: SandboxNetworkPolicy;
}

/** How completely a dimension is actually enforced on this machine. */
export type SandboxEnforcement = 'enforced' | 'partial' | 'none';

export type SandboxBackend =
  | 'seatbelt'
  | 'bubblewrap'
  | 'mxc-base-container'
  | 'none';

/**
 * The honesty contract. A provider reports what it ACTUALLY enforces on this
 * machine, which may be less than the requested policy (e.g. bubblewrap blocked
 * by AppArmor, or a Windows build without MXC's BaseContainer). It must never claim
 * more than it delivers; the consumer decides whether to warn, degrade, or refuse.
 */
export interface SandboxStatus {
  filesystem: SandboxEnforcement;
  network: SandboxEnforcement;
  backend: SandboxBackend;
  /** Human-readable reasons enforcement is reduced from the requested policy. */
  degradations: string[];
}

/** A shell command spawn the provider will wrap. */
export interface SandboxSpawnSpec {
  /** The resolved shell binary that will execute the command. */
  shell: string;
  /** Shell flags that precede the command in an unsandboxed spawn (e.g. ['-c']). */
  shellArgs: string[];
  /** The fully-composed command string, including any cwd-capture suffix. */
  command: string;
  /** Working directory for the spawn. */
  cwd: string;
  /** Environment for the child (already sanitized by buildSafeEnv). */
  env: Record<string, string>;
}

/**
 * A direct program+args invocation the provider will wrap. Unlike
 * SandboxSpawnSpec, this is NOT a shell command: it is a bare binary plus its
 * arguments (e.g. the bundled ripgrep, a stdio MCP server). The provider is
 * responsible for composing a safely-quoted shell command from it so arbitrary
 * arguments (regex patterns, paths) cannot break out.
 */
export interface SandboxExecSpec {
  /** The program to run (an absolute path, or a name resolved via PATH). */
  file: string;
  /** Arguments passed to the program, exactly as they would be without a sandbox. */
  args: string[];
  /**
   * Working directory context for the spawn. The caller sets the child's ACTUAL
   * cwd on the spawn itself (execFile / transport option); a backend may read
   * this to scope a profile. The macOS/Linux provider derives containment from
   * absolute writableRoots and does not consult it, matching SandboxSpawnSpec.cwd.
   */
  cwd: string;
  /** Environment for the child (already sanitized by buildSafeEnv). */
  env: Record<string, string>;
}

/** A wrapped spawn that launches the same command under the sandbox. */
export interface WrappedSpawn {
  file: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * One network egress request, regardless of which path it travels. Shell
 * commands reach the network through the sandbox egress proxy; WebFetch runs
 * in-process on Node fetch. Both are the same question to the end user
 * ("the agent wants to reach example.com"), so both are described by this
 * shape and resolved by the same consumer decision function.
 */
export interface NetworkAccessRequest {
  /** Hostname being reached (no scheme, no port). */
  host: string;
  /** Destination port when known (shell CONNECT requests carry one). */
  port?: number | undefined;
  /** Which egress path is asking: a sandboxed shell command or the in-process WebFetch tool. */
  via: 'shell' | 'webfetch';
  /** Full URL for webfetch requests. Shell egress only sees host and port. */
  url?: string | undefined;
}

/** How durable an allow is. The consumer owns grant storage; this is its vocabulary. */
export type NetworkAccessScope = 'once' | 'session' | 'always';

export interface NetworkAccessDecision {
  /**
   * `allow` and `deny` are final. `ask` defers the decision to the human:
   * in a duplex CortexAgent the facade's permission broker voices the
   * request through the conversation and settles it from the user's spoken
   * answer; anywhere no broker exists (passthrough, direct AgentLoop use)
   * an `ask` is treated as deny, so the unanswered case fails closed.
   */
  decision: 'allow' | 'deny' | 'ask';
  /** Scope of an allow, when the consumer wants to report it (informational to core). */
  scope?: NetworkAccessScope | undefined;
}

/**
 * The single egress decision function, supplied by the consumer. Core calls it
 * from in-process egress points (WebFetch); the consumer additionally wires the
 * same function into its SandboxProvider's ask-callback so shell egress and
 * in-process egress share one allowlist and one prompt. The consumer owns the
 * allow logic (seeded allowlist, grants, prompting); core only asks.
 */
export type ResolveNetworkAccess = (req: NetworkAccessRequest) => Promise<NetworkAccessDecision>;

/** Attribution of a failed tool result to a sandbox denial, for self-explaining UX. */
export interface SandboxDenial {
  dimension: 'filesystem-read' | 'filesystem-write' | 'network' | 'unknown';
  /** Human- and model-readable explanation, e.g. "network egress to example.com". */
  detail: string;
  /** Whether re-running the command uncontained can be offered as an escalation. */
  escalatable: boolean;
}

/**
 * A completed, failed shell command that ran inside the sandbox, as the Bash
 * tool hands it to classifyFailure for denial attribution.
 */
export interface SandboxCommandFailure {
  /** The composed command string exactly as it was passed to wrapSpawn. */
  command: string;
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

/**
 * Backend contract. Managed CortexAgent sessions own initialization and cleanup;
 * advanced callers may also initialize a provider and lend it to AgentLoop.
 */
export interface SandboxProvider {
  /**
   * Establish enforcement for the given policy (start egress proxy, prepare the
   * OS profile). Called by the owner before use and on policy changes. Returns the honest
   * status of what is actually enforced.
   */
  initialize(policy: SandboxPolicy): Promise<SandboxStatus>;
  /** Optional in-process tool policy, checked by Cortex before permissions. */
  checkToolCall?(name: string, args: unknown, cwd: string): string | null;
  /**
   * Wrap a shell command spawn so it launches contained, returning the argv and
   * env to spawn. Async because a backend may generate an OS profile or await a
   * proxy per call. It prepares the invocation; it does not launch a process.
   */
  wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn>;
  /**
   * Wrap a direct program+args invocation (NOT a shell command) so it launches
   * contained, returning the argv and env to spawn. This exists so subprocess-
   * spawning tools OTHER than Bash (the Grep tool's ripgrep, a stdio MCP server)
   * run inside the same OS boundary as shell commands. Without it their spawns
   * bypass the sandbox and its denyRead protection over secrets (~/.ssh, ~/.aws,
   * credential stores). Optional for interface compatibility, but any provider
   * that reports `filesystem: 'enforced'` should implement it. Async for the same
   * reason as wrapSpawn (a backend may generate an OS profile or await a proxy
   * per call). It must pass through unchanged when the sandbox is not enforcing,
   * so behavior is identical to having no provider on unsupported platforms.
   */
  wrapExec?(spec: SandboxExecSpec): Promise<WrappedSpawn>;
  /**
   * Strip the credential environment variables this provider scrubs from a
   * sandboxed child. The Bash tool applies this to an approved escalation (which
   * skips wrapSpawn), so a command that leaves the OS boundary for one run still
   * does not inherit ambient secrets: escalation is a single-command fs/network
   * exit, not a move to the uncontained Off rung.
   */
  scrubCredentialEnv?(env: Record<string, string>): Record<string, string>;
  /**
   * Optionally classify a failed sandboxed command as a sandbox denial so the
   * caller can surface a self-explaining message and offer escalation. Returns
   * null when the failure is not attributable to the sandbox. Reliable on macOS
   * (violation log), best-effort on Linux (stderr heuristic).
   */
  classifyFailure?(failure: SandboxCommandFailure): SandboxDenial | null | Promise<SandboxDenial | null>;
  /**
   * Called by the Bash tool when a sandbox-WRAPPED spawn fails at the process
   * 'error' stage AND the error code means the wrapper binary could not be found
   * or executed (`ENOENT`/`EACCES`/`EPERM`): the wrapper itself (sandbox-exec,
   * bwrap, or node.exe running the MXC launcher) could not launch, so the command
   * did not run. A likely cause is security software blocking the wrapper
   * mid-session. The provider should mark itself uncontained so subsequent
   * spawns pass through (self-heal to warn-and-continue) and surface the reason
   * via its status / onDegraded channel.
   *
   * This signal is safe to act on because a sandboxed child cannot forge it: the
   * wrapper's own spawn either succeeds or fails before any child runs, and the
   * child cannot make the wrapper binary un-launchable (it lives outside every
   * writable root). The Bash tool deliberately does NOT call this for transient
   * spawn-environment errors (fd/memory pressure, an over-long command line),
   * which are not the wrapper's fault, nor for a wrapped command's stderr/exit
   * (which the child fully controls and could forge to induce a containment
   * drop). Optional: a provider whose wrapper is a system tool
   * (Seatbelt/bubblewrap) may omit it.
   */
  notifyWrappedSpawnFailure?(error: { code?: string | undefined; message: string }): void;
  /** Current enforcement status (after initialize), for transparency surfaces. */
  status?(): SandboxStatus;
  /** Tear down the egress proxy and any transient OS state. */
  dispose(): Promise<void>;
}
