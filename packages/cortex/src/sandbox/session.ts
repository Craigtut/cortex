import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSandboxProvider } from './factory.js';
import { buildDefaultPolicy } from './policy.js';
import { sandboxFileDenial } from './file-policy.js';
import { createSandboxNetworkResolver } from './network-policy.js';
import { parseSandboxOptions, type SandboxOptions, type SandboxState } from './options.js';
import type {
  ResolveNetworkAccess, SandboxCommandFailure, SandboxExecSpec, SandboxPolicy,
  SandboxProvider, SandboxRung, SandboxSpawnSpec, SandboxStatus, WrappedSpawn,
} from './types.js';

const inactive = (reason: string): SandboxStatus => ({
  backend: 'none', filesystem: 'none', network: 'none', degradations: [reason],
});

/** One root agent owns this session. Every resident/child loop borrows its wrapper. */
export class SandboxSession implements SandboxProvider {
  private backend!: SandboxProvider;
  private policy: SandboxPolicy | undefined;
  private temp: string | undefined;
  private currentStatus = inactive('Sandbox is off');
  private closed = false;
  private transition: Promise<void> | undefined;
  private readonly onExit = () => {
    if (this.temp) { try { rmSync(this.temp, { recursive: true, force: true }); } catch { /* Best effort on exit. */ } }
  };
  private disposing: Promise<void> | undefined;
  private shellResolver: ResolveNetworkAccess;
  readonly resolveNetworkAccess: ResolveNetworkAccess;

  private constructor(private readonly options: SandboxOptions, private readonly cwd: string, decide?: ResolveNetworkAccess) {
    this.resolveNetworkAccess = createSandboxNetworkResolver(() => this.policy?.network, decide);
    this.shellResolver = this.resolveNetworkAccess;
  }

  static async create(options: boolean | SandboxOptions, cwd: string, decide?: ResolveNetworkAccess): Promise<SandboxSession | undefined> {
    const parsed = parseSandboxOptions(options);
    if (parsed.enabled === false) return undefined;
    const session = new SandboxSession(parsed, resolve(cwd), decide);
    session.backend = parsed.provider ?? createSandboxProvider({
      onNetworkRequest: async (request) => (await session.shellResolver({ ...request, via: 'shell' })).decision === 'allow',
      onDegraded: () => session.publishStatus(),
    });
    process.once('exit', session.onExit);
    try {
      await session.setRung(parsed.rung ?? 'workspace');
      return session;
    } catch (error) {
      await session.dispose().catch(() => {});
      throw error;
    }
  }

  /** Install the facade's broker-aware resolver before any tools can execute. */
  setNetworkResolver(resolver: ResolveNetworkAccess): void { this.shellResolver = resolver; }

  getState(): SandboxState {
    return structuredClone({
      enabled: true, rung: this.policy?.rung ?? 'off', status: this.status(),
      ...(this.policy ? { policy: this.policy } : {}),
    });
  }

  async setRung(rung: SandboxRung): Promise<void> {
    if (this.transition) throw new Error('Sandbox policy is already changing');
    const change = this.changeRung(rung);
    this.transition = change;
    try { await change; } finally { this.transition = undefined; }
  }

  private async changeRung(rung: SandboxRung): Promise<void> {
    if (this.closed) throw new Error('Sandbox has been disposed');
    parseSandboxOptions({ rung });
    if (rung === 'off') {
      await this.backend.dispose();
      this.policy = undefined;
      this.currentStatus = inactive('Sandbox is off');
      this.publishStatus();
      return;
    }
    this.temp ??= await mkdtemp(join(tmpdir(), 'cortex-sbx-'));
    const absolute = (paths: string[]) => paths.map((path) => resolve(this.cwd, path));
    const policy = buildDefaultPolicy(rung, {
      workspaceRoots: absolute(this.options.workspaceRoots ?? [this.cwd]),
      sessionTmpDir: this.temp,
      extraDenyRead: absolute(this.options.denyRead ?? []),
      extraDenyWrite: absolute(this.options.denyWrite ?? []),
      extraAllowedDomains: this.options.allowedDomains ?? [],
    });
    policy.network.deniedDomains = [...(this.options.deniedDomains ?? [])];
    await this.initialize(policy);
  }

  async initialize(policy: SandboxPolicy): Promise<SandboxStatus> {
    this.policy = structuredClone(policy);
    try {
      this.currentStatus = await this.backend.initialize(this.policy);
    } catch (error) {
      this.currentStatus = inactive(`Sandbox initialization failed: ${error instanceof Error ? error.message : String(error)}`);
      // A failed initialization must not leave a previously active policy behind.
      await this.backend.dispose().catch(() => {});
    }
    this.publishStatus();
    this.assertEnforcement();
    return this.status();
  }

  status(): SandboxStatus {
    if (!this.policy || this.closed) return structuredClone(this.currentStatus);
    const live = this.backend.status?.();
    // Retain the initialization diagnostic when the backend was disposed after failure.
    return structuredClone(this.currentStatus.backend === 'none' ? this.currentStatus : live ?? this.currentStatus);
  }

  checkToolCall(name: string, args: unknown, cwd: string): string | null {
    if (this.closed) return 'Sandbox has been disposed';
    if (this.transition) return 'Sandbox policy is changing; retry after it settles';
    if (!this.policy) return null;
    try { this.assertEnforcement(); } catch (error) { return (error as Error).message; }
    return sandboxFileDenial(name, args, cwd, this.policy.filesystem);
  }

  private assertEnforcement(): void {
    if (!this.policy || this.options.requireEnforcement === false) return;
    const status = this.status();
    if (status.filesystem !== 'enforced' || ((this.policy.network.mode !== 'full' || this.policy.network.deniedDomains.length > 0) && status.network !== 'enforced')) {
      throw new Error(`Sandbox enforcement is required but unavailable: ${status.degradations.join('; ') || status.backend}. Set sandbox.requireEnforcement to false only to explicitly allow degraded operation.`);
    }
  }

  private assertAvailable(): void {
    if (this.closed) throw new Error('Sandbox has been disposed');
    if (this.transition) throw new Error('Sandbox policy is changing; retry after it settles');
    this.assertEnforcement();
  }

  async wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn> {
    this.assertAvailable();
    if (!this.policy || this.status().backend === 'none') {
      return { file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env };
    }
    const wrapped = await this.backend.wrapSpawn(spec);
    // An async backend may have lost enforcement while preparing the invocation.
    this.assertAvailable();
    return wrapped;
  }
  async wrapExec(spec: SandboxExecSpec): Promise<WrappedSpawn> {
    this.assertAvailable();
    if (!this.policy || this.status().backend === 'none') return { file: spec.file, args: spec.args, env: spec.env };
    if (!this.backend.wrapExec) throw new Error('Sandbox provider must implement wrapExec to contain direct subprocesses');
    const wrapped = await this.backend.wrapExec(spec);
    this.assertAvailable();
    return wrapped;
  }
  scrubCredentialEnv(env: Record<string, string>): Record<string, string> {
    return this.backend.scrubCredentialEnv?.(env) ?? env;
  }
  classifyFailure(failure: SandboxCommandFailure) { return this.backend.classifyFailure?.(failure) ?? null; }
  notifyWrappedSpawnFailure(error: { code?: string | undefined; message: string }): void {
    this.backend.notifyWrappedSpawnFailure?.(error);
    this.publishStatus();
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.closed = true;
    this.currentStatus = inactive('Sandbox has been disposed');
    this.disposing = (async () => {
      await this.transition?.catch(() => {});
      try { await this.backend.dispose(); } finally {
        process.removeListener('exit', this.onExit);
        if (this.temp) await rm(this.temp, { recursive: true, force: true });
        this.temp = undefined;
      }
    })();
    return this.disposing;
  }
  private publishStatus(): void {
    if (!this.backend) return;
    try { this.options.onStatusChange?.(this.getState()); } catch { /* Observers cannot change enforcement. */ }
  }
}
