/**
 * SandboxProvider implementation backed by @anthropic-ai/sandbox-runtime.
 *
 * Enforces on macOS (Seatbelt) and Linux (bubblewrap + seccomp) by translating a
 * SandboxPolicy into a SandboxRuntimeConfig and wrapping each shell spawn through
 * SandboxManager.wrapWithSandboxArgv. On unsupported platforms (Windows today) it
 * reports honest `none` status and passes spawns through unchanged.
 *
 * Note: SandboxManager is a process-global singleton, so at most one provider is
 * meaningfully active per process. Re-initialize to change policy (rung change).
 */
import { spawn } from 'node:child_process';
import {
  SandboxManager,
  type SandboxRuntimeConfig,
  type SandboxAskCallback,
} from '@anthropic-ai/sandbox-runtime';
import { DEFAULT_CREDENTIAL_ENV_VARS } from '../policy.js';
import { denialFromViolations, denialFromFailureHeuristic } from '../classify.js';
import type {
  SandboxProvider,
  SandboxPolicy,
  SandboxStatus,
  SandboxSpawnSpec,
  SandboxExecSpec,
  SandboxBackend,
  SandboxCommandFailure,
  SandboxDenial,
  WrappedSpawn,
} from '../types.js';

export interface SandboxRuntimeProviderOptions {
  /**
   * Interactive egress decision for a domain that is not already allow/denied
   * (Workspace rung). Return true to allow, false to deny. When omitted, an
   * unmatched domain is denied. Not consulted in `deny` mode (all denied) or
   * `full` mode (all auto-allowed).
   */
  onNetworkRequest?: (req: { host: string; port: number | undefined }) => Promise<boolean>;
  /** Notified with the honest degradation reasons whenever enforcement is reduced. */
  onDegraded?: (degradations: string[]) => void;
  /**
   * Credential environment-variable names to unset inside the sandbox (mode
   * "deny"). Defaults to DEFAULT_CREDENTIAL_ENV_VARS. Pass [] to disable, or your
   * own list to extend/replace coverage.
   */
  credentialEnvVars?: string[];
}

function backendForPlatform(): SandboxBackend {
  switch (process.platform) {
    case 'darwin':
      return 'seatbelt';
    case 'linux':
      return 'bubblewrap';
    default:
      return 'none';
  }
}

/**
 * Probe whether bubblewrap can actually create an unprivileged user namespace.
 * Presence of the bwrap binary is not enough: Ubuntu 23.10+/24.04 restrict
 * unprivileged user namespaces via AppArmor, so the binary exists but every
 * sandboxed command fails at run time. Returns ok:false with an actionable
 * reason so the provider can report honest `none` instead of a false `enforced`.
 */
async function probeBwrapUserns(): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: boolean; reason?: string }): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    try {
      const proc = spawn(
        'bwrap',
        ['--ro-bind', '/', '/', '--unshare-user', '--unshare-net', '--', 'true'],
        { stdio: 'ignore' },
      );
      proc.on('error', (e) => done({ ok: false, reason: `bwrap probe could not run: ${e.message}` }));
      proc.on('close', (code) =>
        done(
          code === 0
            ? { ok: true }
            : {
                ok: false,
                reason:
                  `bwrap could not create a user namespace (exit ${code}). On Ubuntu 23.10+/24.04 set ` +
                  `kernel.apparmor_restrict_unprivileged_userns=0 or install an AppArmor profile for bwrap.`,
              },
        ),
      );
    } catch (e) {
      done({ ok: false, reason: `bwrap probe error: ${e instanceof Error ? e.message : String(e)}` });
    }
  });
}

const UNCONTAINED = (reason: string): SandboxStatus => ({
  filesystem: 'none',
  network: 'none',
  backend: 'none',
  degradations: [reason],
});

/**
 * Single-quote one shell token. sandbox-runtime only wraps a shell command
 * STRING, so wrapExec composes one from a bare argv; that composition is a
 * security boundary, and a quoting bug would let a crafted ripgrep pattern or
 * path break out and run arbitrary shell. POSIX single quotes suppress EVERY
 * metacharacter ($, `, ;, &, |, >, *, quotes, spaces, newlines), so each token
 * reaches the program verbatim. The one character that cannot appear inside
 * single quotes is the single quote itself: close the quote, emit an escaped
 * literal quote ('\''), then reopen. Do not use metacharacter stripping here;
 * full single-quoting is what makes arbitrary arguments safe.
 *
 * @internal exported for unit testing.
 */
export function singleQuoteShellToken(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Compose a POSIX shell command string from a program and its arguments by
 * single-quoting every token. The result is safe to hand to a shell (and to
 * SandboxManager.wrapWithSandboxArgv, which wraps a command string).
 *
 * @internal exported for unit testing.
 */
export function composeShellCommand(file: string, args: string[]): string {
  return [file, ...args].map(singleQuoteShellToken).join(' ');
}

/**
 * Env var sandbox-runtime reads to place the sandboxed child's TMPDIR (falling
 * back to CLAUDE_TMPDIR, then /tmp/claude). The runtime overrides the child's
 * TMPDIR itself and adds this path to the child's writable set, so this, not the
 * spawn env, is the lever for redirecting "write to the temp dir".
 */
const SANDBOX_TMPDIR_ENV = 'CLAUDE_CODE_TMPDIR';

export class SandboxRuntimeProvider implements SandboxProvider {
  private currentStatus: SandboxStatus = UNCONTAINED('not initialized');
  private policy: SandboxPolicy | undefined;
  /** Prior CLAUDE_CODE_TMPDIR, captured when we point it at the session temp. */
  private priorTmpdirEnv: string | undefined;
  /** True once we have overridden CLAUDE_CODE_TMPDIR (so dispose restores it). */
  private managesTmpdirEnv = false;
  private readonly credentialEnvVars: string[];

  constructor(private readonly options: SandboxRuntimeProviderOptions = {}) {
    this.credentialEnvVars = options.credentialEnvVars ?? [...DEFAULT_CREDENTIAL_ENV_VARS];
  }

  async initialize(policy: SandboxPolicy): Promise<SandboxStatus> {
    this.policy = policy;
    this.applySessionTmpdirEnv(policy.filesystem.sessionTmpDir);
    const backend = backendForPlatform();

    if (backend === 'none' || !SandboxManager.isSupportedPlatform()) {
      return this.setStatus(
        UNCONTAINED(`OS sandbox not available on ${process.platform}; commands run uncontained`),
      );
    }

    // Re-initialize (e.g. a rung change): SandboxManager.initialize() early-returns
    // when already initialized, so without an explicit reset a second call is a
    // silent no-op that would report the new policy while enforcing the old one.
    if (this.currentStatus.backend !== 'none') {
      await SandboxManager.reset();
    }

    const degradations: string[] = [];
    if (backend === 'bubblewrap') {
      const dep = SandboxManager.checkDependencies();
      if (dep.errors.length > 0) {
        return this.setStatus(
          UNCONTAINED(`Linux sandbox dependencies missing: ${dep.errors.join('; ')}`),
        );
      }
      // checkDependencies() only probes bwrap/socat presence, not whether an
      // unprivileged user namespace can actually be created. Probe for real so we
      // report honest `none` instead of a false `enforced` on a restricted kernel.
      const probe = await probeBwrapUserns();
      if (!probe.ok) {
        return this.setStatus(UNCONTAINED(probe.reason ?? 'bubblewrap user namespace unavailable'));
      }
      degradations.push(...dep.warnings);
    }

    try {
      await SandboxManager.initialize(
        this.toRuntimeConfig(policy),
        this.askCallbackFor(policy),
        backend === 'seatbelt', // macOS: enable the real-time violation log monitor
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.setStatus(UNCONTAINED(`sandbox initialization failed: ${msg}`));
    }

    // Init succeeded. Dependency warnings (e.g. seccomp unavailable) are attached
    // as degradations but do not by themselves negate the primary fs/network
    // boundary, so we report enforced with the caveats surfaced.
    return this.setStatus({
      filesystem: 'enforced',
      network: 'enforced',
      backend,
      degradations,
    });
  }

  async wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn> {
    // Not enforcing (unsupported platform or failed init): pass through so the
    // command still runs. Status already reports this as uncontained.
    if (this.currentStatus.backend === 'none') {
      return { file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env };
    }
    const { argv } = await SandboxManager.wrapWithSandboxArgv(spec.command, spec.shell);
    const [file, ...args] = argv;
    return { file: file ?? spec.shell, args, env: spec.env };
  }

  /**
   * Wrap a bare program+args invocation (ripgrep, a stdio MCP server) so it runs
   * inside the same OS boundary as shell commands, enforcing denyRead over
   * secrets. sandbox-runtime has no argv-native wrap, so compose a POSIX-safe
   * command string from the argv (every token single-quoted) and wrap that.
   */
  async wrapExec(spec: SandboxExecSpec): Promise<WrappedSpawn> {
    // Not enforcing (unsupported platform or failed init): pass through so the
    // program still runs. Status already reports this as uncontained. Mirrors
    // wrapSpawn so behavior is unchanged when there is no real sandbox.
    if (this.currentStatus.backend === 'none') {
      return { file: spec.file, args: spec.args, env: spec.env };
    }
    const command = composeShellCommand(spec.file, spec.args);
    // No explicit shell: let the runtime pick its default. The single-quoted
    // command string is safe under any POSIX shell.
    const { argv } = await SandboxManager.wrapWithSandboxArgv(command, undefined);
    const [file, ...args] = argv;
    return { file: file ?? spec.file, args, env: spec.env };
  }

  /**
   * Point the sandboxed child's temp dir at the per-session writable temp. The
   * scoped policy makes only that subdir writable under the machine temp root,
   * so a tool writing to its default temp must land there or be denied. On the
   * sandbox-runtime backend the child's TMPDIR is NOT taken from the spawn env:
   * the runtime overrides it (see SANDBOX_TMPDIR_ENV) and adds that path to the
   * child's writable set. So the lever is that env var, which we point at the
   * scoped session temp (already a writable root, and one that actually exists,
   * unlike the runtime's /tmp/claude default). When the policy scopes no session
   * temp (legacy whole-temp-root behavior, or a reinit DOWN to the restricted
   * rung), any override we applied is undone: leaving it pointed at the prior
   * session dir, which is no longer a writable root, would give the child a
   * broken $TMPDIR. The prior value is also restored on dispose.
   */
  private applySessionTmpdirEnv(sessionTmpDir: string | undefined): void {
    if (sessionTmpDir === undefined) {
      // No scoped temp for this policy: undo any override so the child does not
      // inherit a stale, now-unwritable $TMPDIR after a downgrade to restricted.
      this.restoreSessionTmpdirEnv();
      return;
    }
    if (!this.managesTmpdirEnv) {
      this.priorTmpdirEnv = process.env[SANDBOX_TMPDIR_ENV];
      this.managesTmpdirEnv = true;
    }
    process.env[SANDBOX_TMPDIR_ENV] = sessionTmpDir;
  }

  /** Restore CLAUDE_CODE_TMPDIR to the value it held before this provider set it. */
  private restoreSessionTmpdirEnv(): void {
    if (!this.managesTmpdirEnv) return;
    if (this.priorTmpdirEnv === undefined) {
      delete process.env[SANDBOX_TMPDIR_ENV];
    } else {
      process.env[SANDBOX_TMPDIR_ENV] = this.priorTmpdirEnv;
    }
    this.managesTmpdirEnv = false;
    this.priorTmpdirEnv = undefined;
  }

  status(): SandboxStatus {
    return this.currentStatus;
  }

  /**
   * Remove the credential env vars this provider scrubs inside the sandbox, so an
   * escalated (unsandboxed) command still does not inherit ambient secrets. See
   * the SandboxProvider.scrubCredentialEnv contract.
   */
  scrubCredentialEnv(env: Record<string, string>): Record<string, string> {
    if (this.credentialEnvVars.length === 0) return env;
    const scrubbed: Record<string, string> = { ...env };
    for (const name of this.credentialEnvVars) {
      delete scrubbed[name];
    }
    return scrubbed;
  }

  /**
   * Attribute a failed sandboxed command to a sandbox denial (or return null).
   * macOS is precise: sandbox-runtime's unified-log monitor records violation
   * events tagged with the command, so a match IS a denial. Linux has no
   * per-violation signal, so a conservative stderr heuristic answers instead.
   * Best-effort either way; the caller treats null as "no note", and a macOS
   * violation that has not landed in the log tail yet is simply missed.
   */
  classifyFailure(failure: SandboxCommandFailure): SandboxDenial | null {
    // Not enforcing: spawns passed through unwrapped, so no failure here can
    // be the sandbox's doing.
    if (this.currentStatus.backend === 'none') return null;
    if (failure.exitCode === null || failure.exitCode === 0) return null;

    if (this.currentStatus.backend === 'seatbelt') {
      const store = SandboxManager.getSandboxViolationStore();
      return denialFromViolations(store.getViolationsForCommand(failure.command));
    }
    // Linux heuristic: generic permission markers need corroboration against
    // the active policy (a referenced blocked path or a network tool).
    if (!this.policy) return null;
    const { denyRead, denyWrite } = this.policy.filesystem;
    return denialFromFailureHeuristic(failure, { denyRead, denyWrite });
  }

  /**
   * The Bash tool calls this when a wrapped spawn fails to launch the wrapper
   * itself (spawn ENOENT/EACCES/EPERM). Here the wrapper is the system tool
   * sandbox-exec (macOS) or bwrap (Linux); if it cannot launch, containment is
   * broken, so degrade to honest `none`: subsequent wrapSpawn/wrapExec pass the
   * command through uncontained (rather than failing every one), the temp-env
   * override is undone, and the reason surfaces via status / onDegraded. The
   * failed command itself did not run. Safe to act on: a sandboxed child cannot
   * forge a wrapper-launch failure (the wrapper binary lives outside every
   * writable root, so the child cannot make it un-launchable). Unlikely in
   * practice since both wrappers are OS-managed, but kept so every provider
   * self-heals the same way.
   */
  notifyWrappedSpawnFailure(error: { code?: string | undefined; message: string }): void {
    if (this.currentStatus.backend === 'none') return;
    // Tear down the now-unused egress proxy/monitor, best-effort. A command
    // spawned after the status flips below passes through and never touches it,
    // so this async teardown cannot race a wrapped spawn.
    void SandboxManager.reset().catch(() => {});
    this.restoreSessionTmpdirEnv();
    this.setStatus(
      UNCONTAINED(
        `The OS sandbox wrapper failed to launch (${error.code ?? error.message}), so containment ` +
          `is now disabled for this session and shell commands run WITHOUT it. Restart the session ` +
          `to re-enable it.`,
      ),
    );
  }

  async dispose(): Promise<void> {
    if (this.currentStatus.backend !== 'none') {
      await SandboxManager.reset();
    }
    this.restoreSessionTmpdirEnv();
    this.currentStatus = UNCONTAINED('disposed');
  }

  private setStatus(status: SandboxStatus): SandboxStatus {
    this.currentStatus = status;
    if (status.degradations.length > 0) {
      this.options.onDegraded?.(status.degradations);
    }
    return status;
  }

  private askCallbackFor(policy: SandboxPolicy): SandboxAskCallback | undefined {
    if (policy.network.mode === 'full') {
      // Open network: still routed through the proxy, but every host is allowed.
      return async () => true;
    }
    if (policy.network.mode === 'allowlist') {
      const cb = this.options.onNetworkRequest;
      return cb ? (params) => cb({ host: params.host, port: params.port }) : undefined;
    }
    // deny mode: no fallthrough, everything blocked.
    return undefined;
  }

  private toRuntimeConfig(policy: SandboxPolicy): SandboxRuntimeConfig {
    const fs = policy.filesystem;
    const net = policy.network;
    const config: SandboxRuntimeConfig = {
      network: {
        allowedDomains: net.mode === 'deny' ? [] : net.allowedDomains,
        deniedDomains: net.deniedDomains,
        // deny mode is a hard block with no ask-callback fallthrough.
        strictAllowlist: net.mode === 'deny',
        allowLocalBinding: net.allowLocalBinding ?? true,
      },
      filesystem: {
        denyRead: fs.denyRead,
        allowWrite: fs.writableRoots,
        denyWrite: fs.denyWrite,
        ...(fs.allowRead ? { allowRead: fs.allowRead } : {}),
      },
    };
    // Scrub credential env vars from the child (filesystem deny-reads do not
    // cover secrets that live in the environment, and the seeded allowlist is a
    // ready exfil channel).
    if (this.credentialEnvVars.length > 0) {
      config.credentials = {
        envVars: this.credentialEnvVars.map((name) => ({ name, mode: 'deny' as const })),
      };
    }
    return config;
  }
}
