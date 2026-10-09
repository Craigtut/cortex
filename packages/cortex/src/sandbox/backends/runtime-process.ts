import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { DEFAULT_CREDENTIAL_ENV_VARS } from '../policy.js';
import type { SandboxRuntimeProviderOptions } from './runtime.js';
import type {
  SandboxProvider, SandboxStatus, SandboxPolicy, SandboxSpawnSpec, SandboxExecSpec,
  WrappedSpawn, SandboxCommandFailure, SandboxDenial,
} from '../types.js';

const statusSchema = z.object({
  backend: z.enum(['seatbelt', 'bubblewrap', 'none']),
  filesystem: z.enum(['enforced', 'partial', 'none']), network: z.enum(['enforced', 'partial', 'none']),
  degradations: z.array(z.string()),
});
const responseSchema = z.object({
  id: z.number().int().nonnegative().optional(), event: z.enum(['network', 'status']).optional(),
  result: z.unknown().optional(), error: z.string().optional(), status: statusSchema.optional(),
  request: z.object({ host: z.string(), port: z.number().optional() }).optional(),
});
const unavailable = (reason: string): SandboxStatus => ({ backend: 'none', filesystem: 'none', network: 'none', degradations: [reason] });

/** Isolates the upstream process-global proxy, policy, and temp environment per root agent. */
export class SandboxRuntimeProcess implements SandboxProvider {
  private child: ChildProcess | undefined;
  private currentStatus = unavailable('Sandbox is not initialized');
  private sequence = 0;
  private pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private disposing: Promise<void> | undefined;

  constructor(private readonly options: SandboxRuntimeProviderOptions = {}) {}

  async initialize(policy: SandboxPolicy): Promise<SandboxStatus> {
    if (this.disposing) await this.disposing;
    this.disposing = undefined;
    if (!this.child) this.start();
    await this.request('initialize', { policy, credentialEnvVars: this.options.credentialEnvVars });
    return this.status();
  }
  async wrapSpawn(spec: SandboxSpawnSpec): Promise<WrappedSpawn> {
    return this.request('wrapSpawn', spec) as Promise<WrappedSpawn>;
  }
  async wrapExec(spec: SandboxExecSpec): Promise<WrappedSpawn> {
    return this.request('wrapExec', spec) as Promise<WrappedSpawn>;
  }
  scrubCredentialEnv(env: Record<string, string>): Record<string, string> {
    const safe = { ...env };
    for (const key of this.options.credentialEnvVars ?? DEFAULT_CREDENTIAL_ENV_VARS) delete safe[key];
    return safe;
  }
  async classifyFailure(failure: SandboxCommandFailure): Promise<SandboxDenial | null> {
    return this.request('classifyFailure', failure) as Promise<SandboxDenial | null>;
  }
  notifyWrappedSpawnFailure(error: { code?: string | undefined; message: string }): void {
    this.updateStatus(unavailable(`Sandbox wrapper failed to launch: ${error.message}`));
    void this.request('notifyWrappedSpawnFailure', error).catch(() => {});
  }
  status(): SandboxStatus { return structuredClone(this.currentStatus); }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposing = (async () => {
      const child = this.child;
      if (!child) return;
      try { await this.request('dispose', undefined); } finally {
        this.child = undefined;
        if (child.connected) child.disconnect();
        const timeout = setTimeout(() => child.kill('SIGKILL'), 1000);
        timeout.unref();
        child.once('exit', () => clearTimeout(timeout));
        this.rejectPending(new Error('Sandbox worker disposed'));
        this.updateStatus(unavailable('Sandbox has been disposed'));
      }
    })();
    return this.disposing;
  }

  private start(): void {
    let entry = new URL('./runtime-worker.js', import.meta.url);
    // Source-mode development still uses the deliberately built worker artifact.
    if (!existsSync(entry)) entry = new URL('../../../dist/sandbox/backends/runtime-worker.js', import.meta.url);
    if (!existsSync(entry)) throw new Error('Build Cortex before starting the built-in sandbox worker');
    const child = fork(entry, [], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    this.child = child;
    child.on('message', (raw) => { if (this.child === child) this.receive(raw); });
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.rejectPending(error);
      this.updateStatus(unavailable(error.message));
    };
    child.on('error', fail);
    child.on('exit', (code, signal) => fail(new Error(`Sandbox worker exited (${signal ?? code})`)));
  }

  private receive(raw: unknown): void {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.status) this.updateStatus(message.status);
    if (message.event === 'network' && message.id !== undefined && message.request) {
      const id = message.id;
      const request = message.request;
      void Promise.resolve().then(() => this.options.onNetworkRequest?.({ host: request.host, port: request.port }) ?? false)
        .catch(() => false).then((allow) => {
          if (this.child?.connected) this.child.send({ id, method: 'networkAnswer', payload: allow });
        });
      return;
    }
    if (message.id === undefined) return;
    const call = this.pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer);
    this.pending.delete(message.id);
    if (message.error) call.reject(new Error(message.error)); else call.resolve(message.result);
  }
  private request(method: string, payload: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('Sandbox worker is unavailable'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sandbox worker ${method} timed out`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, method, payload }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  private rejectPending(error: Error): void {
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
  }
  private updateStatus(status: SandboxStatus): void {
    const changed = JSON.stringify(status) !== JSON.stringify(this.currentStatus);
    this.currentStatus = status;
    if (changed && status.degradations.length) {
      try { this.options.onDegraded?.(status.degradations); } catch { /* Observers cannot break IPC. */ }
    }
  }
}
