/**
 * Native Windows SandboxProvider backed by Microsoft eXecution Containers
 * (MXC), BaseContainer tier only.
 *
 * BaseContainer is enforced by the OS through the process security
 * environment (PSEC): no elevation, no host ACL edits. The AppContainer tiers
 * are never used, and nothing falls back to weaker containment: when the
 * probe fails, status is `none` with the reason.
 *
 * MXC's SDK owns process creation, so this provider never spawns the command
 * itself. wrapSpawn/wrapExec return `node <private launcher copy> --run` with
 * the container request in launcher-only environment chunks; the launcher
 * (mxc-launcher.ts) loads the SDK, re-checks the tier, spawns, and relays
 * stdio. The SDK and its native payload therefore never load into the agent
 * process.
 *
 * Network: direct non-loopback egress is denied by MXC. Allowlist and full
 * modes route HTTP(S) through a host-side proxy that applies the same domain
 * policy and resolver as macOS and Linux.
 *
 * See docs/cortex/sandboxing.md ("Windows backend: MXC BaseContainer").
 */
import { dirname } from 'node:path';
import { DEFAULT_CREDENTIAL_ENV_VARS } from '../policy.js';
import { MXC_SDK_PLATFORM_PACKAGE, defaultMxcHostDeps } from './mxc-host.js';
import {
  LAUNCHER_ENV_PREFIX,
  LAUNCHER_ERROR_PREFIX,
  LAUNCHER_FAILURE_EXIT,
  LAUNCHER_PAYLOAD_VERSION,
  encodeLauncherPayload,
  type LauncherPayload,
  type ProbeReport,
} from './mxc-launcher.js';
import {
  buildMxcRequestBase,
  decideProxyRequest,
  deleteWindowsEnv,
  isWindowsPathWithin,
  proxyEnvironment,
  setWindowsEnv,
  windowsCommandLine,
  type MxcReadSet,
  type MxcRequestBase,
} from './mxc-request.js';
import type {
  SandboxCommandFailure,
  SandboxDenial,
  SandboxExecSpec,
  SandboxPolicy,
  SandboxProvider,
  SandboxSpawnSpec,
  SandboxStatus,
  WrappedSpawn,
} from '../types.js';

/** A running host-side domain proxy. */
export interface MxcDomainProxy {
  url: string;
  close(): Promise<void>;
}

/** Host interactions, injectable so the provider is testable without Windows or the SDK. */
export interface MxcProviderDeps {
  platform: NodeJS.Platform;
  /** The Node binary that runs the launcher. */
  nodePath: string;
  /** Locate the SDK without loading it. Undefined when it is not installed. */
  resolveSdk(): { entry: string; packageRoot: string } | undefined;
  /** Copy the launcher into a fresh private directory and return both paths. */
  prepareLauncher(): { dir: string; path: string };
  removeDir(dir: string): void;
  /** Snapshot the read set: volume roots, their immediate children, platform roots. */
  gatherReadSet(): Promise<MxcReadSet>;
  exists(path: string): boolean;
  /** Run `node <launcher> --probe` with the given environment and parse its report. */
  runProbe(nodePath: string, launcherPath: string, env: Record<string, string>): Promise<ProbeReport>;
  startProxy(decide: (host: string, port: number) => Promise<boolean>): Promise<MxcDomainProxy>;
}

export interface MxcSandboxProviderOptions {
  /**
   * Decision for a shell destination the policy neither allows nor denies
   * (allowlist mode). Return true to allow. Absent: denied.
   */
  onNetworkRequest?: (req: { host: string; port: number | undefined }) => Promise<boolean>;
  /** Notified with the reasons whenever enforcement is reduced. */
  onDegraded?: (degradations: string[]) => void;
  /** Credential variable names removed from the contained environment. Defaults to DEFAULT_CREDENTIAL_ENV_VARS. */
  credentialEnvVars?: string[];
  /** Test seams. Production uses the real host. */
  deps?: Partial<MxcProviderDeps>;
}

const UNCONTAINED = (reason: string): SandboxStatus => ({
  filesystem: 'none',
  network: 'none',
  backend: 'none',
  degradations: [reason],
});

const SDK_MISSING =
  'MXC sandboxing needs @microsoft/mxc-sdk, which is not installed, so shell commands run WITHOUT OS ' +
  `containment. npm installs it with @animus-labs/cortex on Windows, through the optional dependency ` +
  `${MXC_SDK_PLATFORM_PACKAGE}. It goes missing when optional dependencies were skipped ` +
  '(--omit=optional) or node_modules or the lockfile came from another OS; run npm install on this ' +
  'machine to restore it.';

/** The command used only for the availability probe; it is never executed. */
const PROBE_COMMAND = 'cmd.exe /d /c exit 0';

/** Windows "the OS denied this" markers. Reads and writes are both confined, so the dimension is unknown. */
const WINDOWS_DENIAL_MARKERS: RegExp[] = [
  /access is denied/i,
  /\bERROR_ACCESS_DENIED\b/i,
  /unauthorizedaccessexception/i,
  /permission denied/i,
];

export class MxcSandboxProvider implements SandboxProvider {
  private currentStatus: SandboxStatus = UNCONTAINED('not initialized');
  private policy: SandboxPolicy | undefined;
  private sdk: { entry: string; packageRoot: string } | undefined;
  private launcher: { dir: string; path: string } | undefined;
  private readSet: MxcReadSet = { volumeEntries: [], platformRoots: [] };
  private hostCodePaths: string[] = [];
  private proxy: MxcDomainProxy | undefined;
  private readonly credentialEnvVars: string[];
  private readonly deps: MxcProviderDeps;

  constructor(private readonly options: MxcSandboxProviderOptions = {}) {
    this.credentialEnvVars = options.credentialEnvVars ?? [...DEFAULT_CREDENTIAL_ENV_VARS];
    this.deps = { ...defaultMxcHostDeps(), ...options.deps };
  }

  async initialize(policy: SandboxPolicy): Promise<SandboxStatus> {
    await this.teardown();
    this.policy = policy;
    const { deps } = this;
    if (deps.platform !== 'win32') {
      return this.setStatus(UNCONTAINED(`MXC sandboxing is Windows-only; running on ${deps.platform} uncontained`));
    }
    const sdk = deps.resolveSdk();
    if (!sdk) return this.setStatus(UNCONTAINED(SDK_MISSING));

    try {
      this.launcher = deps.prepareLauncher();
    } catch (error) {
      return this.fail(`could not prepare the MXC launcher: ${message(error)}`);
    }
    // The launcher runs on the host for every command. A copy a contained
    // command could rewrite would let one command run code uncontained.
    if (policy.filesystem.writableRoots.some((root) => isWindowsPathWithin(this.launcher!.dir, root))) {
      return this.fail(`the MXC launcher directory ${this.launcher.dir} is inside a writable root`);
    }
    this.sdk = sdk;
    this.hostCodePaths = [sdk.packageRoot, dirname(deps.nodePath)];
    try {
      this.readSet = await deps.gatherReadSet();
    } catch (error) {
      return this.fail(`could not enumerate the read set: ${message(error)}`);
    }

    const base = this.requestBase(policy);
    if (base.usesProxy) {
      try {
        this.proxy = await deps.startProxy((host, port) => this.allowProxyRequest(host, port));
      } catch (error) {
        return this.fail(`could not start the network proxy: ${message(error)}`);
      }
    }

    const probeEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key.toUpperCase() !== 'NODE_OPTIONS' && !key.toUpperCase().startsWith(LAUNCHER_ENV_PREFIX)) {
        probeEnv[key] = value;
      }
    }
    const report = await deps.runProbe(deps.nodePath, this.launcher.path, {
      ...probeEnv,
      ...encodeLauncherPayload(this.payload(base, PROBE_COMMAND)),
    });
    if (!report.ok) {
      return this.fail(report.reason ?? 'the MXC probe failed without a reason');
    }

    const degradations = [...base.notes];
    const exposed = this.hostCodePaths.filter((path) =>
      policy.filesystem.writableRoots.some((root) => isWindowsPathWithin(path, root)),
    );
    if (exposed.length > 0) {
      degradations.push(
        `Host-side code the MXC launcher runs for every command lives inside a writable root ` +
          `(${exposed.join(', ')}). It is carved out read-only, but a contained command could still ` +
          `shadow its dependencies through Node module resolution. Install Cortex and ` +
          `@microsoft/mxc-sdk outside the workspace for full containment.`,
      );
    }
    return this.setStatus({
      filesystem: exposed.length > 0 ? 'partial' : 'enforced',
      network: 'enforced',
      backend: 'mxc-base-container',
      degradations,
    });
  }

  async wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn> {
    if (!this.enforcing()) {
      return { file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env };
    }
    return this.launch([spec.shell, ...spec.shellArgs, spec.command], spec.env);
  }

  /** Grep's ripgrep and stdio MCP servers run in the same container shape as shell commands. */
  async wrapExec(spec: SandboxExecSpec): Promise<WrappedSpawn> {
    if (!this.enforcing()) return { file: spec.file, args: spec.args, env: spec.env };
    return this.launch([spec.file, ...spec.args], spec.env);
  }

  status(): SandboxStatus {
    return this.currentStatus;
  }

  /** Remove credential variables case-insensitively (Windows environment semantics). */
  scrubCredentialEnv(env: Record<string, string>): Record<string, string> {
    const scrubbed = { ...env };
    deleteWindowsEnv(scrubbed, this.credentialEnvVars);
    return scrubbed;
  }

  /** Best-effort attribution from stderr; MXC's denial capture is not wired. */
  classifyFailure(failure: SandboxCommandFailure): SandboxDenial | null {
    if (!this.enforcing() || failure.exitCode === null || failure.exitCode === 0) return null;
    if (failure.exitCode === LAUNCHER_FAILURE_EXIT && failure.stderr.includes(LAUNCHER_ERROR_PREFIX)) {
      return {
        dimension: 'unknown',
        detail: 'the MXC launcher reports that it could not start the command in a BaseContainer (see stderr)',
        escalatable: false,
      };
    }
    for (const pattern of WINDOWS_DENIAL_MARKERS) {
      const match = pattern.exec(failure.stderr);
      if (match) {
        return {
          dimension: 'unknown',
          detail: `stderr reports "${match[0]}" while the MXC sandbox was enforcing`,
          escalatable: true,
        };
      }
    }
    return null;
  }

  /**
   * Node could not start the launcher (ENOENT/EACCES/EPERM), so the command
   * did not run. Containment is reported as gone, loudly, rather than retried.
   */
  notifyWrappedSpawnFailure(error: { code?: string | undefined; message: string }): void {
    if (!this.enforcing()) return;
    void this.teardown();
    this.setStatus(
      UNCONTAINED(
        `The MXC launcher could not be started (${error.code ?? error.message}), so OS containment is ` +
          `disabled for this session and shell commands run WITHOUT it. Restart the session to re-enable it.`,
      ),
    );
  }

  async dispose(): Promise<void> {
    await this.teardown();
    this.currentStatus = UNCONTAINED('disposed');
  }

  private enforcing(): boolean {
    return (
      this.currentStatus.backend === 'mxc-base-container' &&
      this.policy !== undefined &&
      this.sdk !== undefined &&
      this.launcher !== undefined
    );
  }

  private requestBase(policy: SandboxPolicy): MxcRequestBase {
    return buildMxcRequestBase({
      policy,
      readSet: this.readSet,
      existingDenyRead: policy.filesystem.denyRead.filter((path) => this.deps.exists(path)),
      hostCodePaths: this.hostCodePaths,
    });
  }

  private payload(base: MxcRequestBase, command: string): LauncherPayload {
    return {
      version: LAUNCHER_PAYLOAD_VERSION,
      sdkEntry: this.sdk!.entry,
      request: { ...base.request, command },
      requiredCapabilities: base.requiredCapabilities,
    };
  }

  private launch(argv: string[], env: Record<string, string>): WrappedSpawn {
    const policy = this.policy!;
    // Deny paths are re-checked per command: a secret created mid-session is denied from the next one.
    const base = this.requestBase(policy);
    const childEnv = this.scrubCredentialEnv(env);
    deleteWindowsEnv(
      childEnv,
      Object.keys(childEnv).filter((key) => key.toUpperCase().startsWith(LAUNCHER_ENV_PREFIX)),
    );
    const tmp = policy.filesystem.sessionTmpDir;
    if (tmp) {
      setWindowsEnv(childEnv, 'TEMP', tmp);
      setWindowsEnv(childEnv, 'TMP', tmp);
    }
    if (this.proxy && base.usesProxy) {
      for (const [name, value] of Object.entries(proxyEnvironment(this.proxy.url))) {
        setWindowsEnv(childEnv, name, value);
      }
    }
    return {
      file: this.deps.nodePath,
      args: [this.launcher!.path, '--run'],
      env: { ...childEnv, ...encodeLauncherPayload(this.payload(base, windowsCommandLine(argv))) },
    };
  }

  private async allowProxyRequest(host: string, port: number): Promise<boolean> {
    const net = this.policy?.network;
    if (!net) return false;
    const decision = decideProxyRequest(net, host);
    if (decision !== 'ask') return decision === 'allow';
    try {
      return (await this.options.onNetworkRequest?.({ host, port })) ?? false;
    } catch {
      return false;
    }
  }

  /** Report `none` with the reason. Never falls back to another backend. */
  private async fail(reason: string): Promise<SandboxStatus> {
    await this.teardown();
    return this.setStatus(
      UNCONTAINED(`MXC BaseContainer sandboxing is unavailable, so shell commands run WITHOUT OS containment: ${reason}`),
    );
  }

  private async teardown(): Promise<void> {
    const proxy = this.proxy;
    const launcher = this.launcher;
    this.proxy = undefined;
    this.launcher = undefined;
    this.sdk = undefined;
    if (launcher) {
      try { this.deps.removeDir(launcher.dir); } catch { /* A leftover launcher copy is inert. */ }
    }
    await proxy?.close().catch(() => {});
  }

  private setStatus(status: SandboxStatus): SandboxStatus {
    this.currentStatus = status;
    if (status.degradations.length > 0) {
      try { this.options.onDegraded?.(status.degradations); } catch { /* Observers cannot change enforcement. */ }
    }
    return status;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
