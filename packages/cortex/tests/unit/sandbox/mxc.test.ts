import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { MxcSandboxProvider, type MxcProviderDeps } from '../../../src/sandbox/backends/mxc.js';
import { startMxcDomainProxy } from '../../../src/sandbox/backends/mxc-host.js';
import {
  LAUNCHER_ENV_COUNT,
  LAUNCHER_ERROR_PREFIX,
  LAUNCHER_FAILURE_EXIT,
  decodeLauncherPayload,
} from '../../../src/sandbox/backends/mxc-launcher.js';
import type { ProbeReport } from '../../../src/sandbox/backends/mxc-launcher.js';
import type { SandboxPolicy, SandboxSpawnSpec } from '../../../src/sandbox/types.js';

// The provider against a faked host boundary: no Windows, no SDK, no proxy
// sockets. The proxy itself is exercised for real at the bottom.

const WS = 'C:\\Users\\dev\\project';
const TMP = 'C:\\Users\\dev\\AppData\\Local\\Temp\\cortex-sbx-1';
const LAUNCHER_DIR = 'C:\\Users\\dev\\AppData\\Local\\Temp\\cortex-mxc-abc';
const LAUNCHER = `${LAUNCHER_DIR}\\mxc-launcher.mjs`;
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const SDK = { entry: 'file:///C:/npm/node_modules/@microsoft/mxc-sdk/dist/v1/index.js', packageRoot: 'C:\\npm\\node_modules\\@microsoft\\mxc-sdk' };

function policy(mode: SandboxPolicy['network']['mode'] = 'allowlist', writableRoots = [WS, TMP]): SandboxPolicy {
  return {
    rung: mode === 'deny' ? 'restricted' : 'workspace',
    filesystem: {
      writableRoots,
      denyRead: ['C:\\Users\\dev\\.ssh', 'C:\\Users\\dev\\.aws'],
      denyWrite: [`${WS}\\.git\\hooks`],
      sessionTmpDir: TMP,
    },
    network: { mode, allowedDomains: ['registry.npmjs.org'], deniedDomains: ['evil.example'], allowLocalBinding: true },
  };
}

interface Harness {
  deps: MxcProviderDeps;
  proxyDecide: () => (host: string, port: number) => Promise<boolean>;
  proxyClose: ReturnType<typeof vi.fn>;
  probeEnvs: Array<Record<string, string>>;
  existing: Set<string>;
}

function harness(overrides: Partial<MxcProviderDeps> = {}, report: ProbeReport = { ok: true, tier: 'base-container' }): Harness {
  let decide: ((host: string, port: number) => Promise<boolean>) | undefined;
  const proxyClose = vi.fn(async () => {});
  const probeEnvs: Array<Record<string, string>> = [];
  const existing = new Set(['C:\\Users\\dev\\.ssh']);
  const deps: MxcProviderDeps = {
    platform: 'win32',
    nodePath: NODE,
    resolveSdk: () => SDK,
    prepareLauncher: () => ({ dir: LAUNCHER_DIR, path: LAUNCHER }),
    removeDir: vi.fn(),
    gatherReadSet: async () => ({ volumeEntries: ['C:\\', 'C:\\Users'], platformRoots: ['C:\\Windows'] }),
    exists: (path) => existing.has(path),
    runProbe: vi.fn(async (_node: string, _launcher: string, env: Record<string, string>) => {
      probeEnvs.push(env);
      return report;
    }),
    startProxy: vi.fn(async (d) => {
      decide = d;
      return { url: 'http://127.0.0.1:4567', close: proxyClose };
    }),
    ...overrides,
  };
  return { deps, proxyDecide: () => decide!, proxyClose, probeEnvs, existing };
}

const spec: SandboxSpawnSpec = {
  shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  shellArgs: ['-NoProfile', '-Command'],
  command: 'echo "hi"',
  cwd: WS,
  env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\L', Path: 'C:\\bin', GITHUB_TOKEN: 'ghp_x', github_token: 'ghp_y', temp: 'C:\\Real\\Temp', http_proxy: 'http://corp:8080' },
};

const providers: MxcSandboxProvider[] = [];
afterEach(async () => { await Promise.all(providers.splice(0).map((p) => p.dispose())); });
function provider(h: Harness, options: ConstructorParameters<typeof MxcSandboxProvider>[0] = {}) {
  const p = new MxcSandboxProvider({ ...options, deps: h.deps });
  providers.push(p);
  return p;
}

describe('MxcSandboxProvider.initialize', () => {
  it('reports enforced BaseContainer containment when the probe passes', async () => {
    const h = harness();
    const status = await provider(h).initialize(policy());
    expect(status).toEqual({ backend: 'mxc-base-container', filesystem: 'enforced', network: 'enforced', degradations: [] });
  });

  it('probes with the real request shape through the private launcher copy', async () => {
    const h = harness();
    await provider(h).initialize(policy());
    expect(h.deps.runProbe).toHaveBeenCalledWith(NODE, LAUNCHER, expect.any(Object));
    const { payload, childEnv } = decodeLauncherPayload(h.probeEnvs[0]!);
    expect(payload.sdkEntry).toBe(SDK.entry);
    expect(payload.requiredCapabilities).toEqual(['filesystemDeniedPaths', 'ingressHostLoopbackAllow']);
    expect(payload.request['filesystem']).toMatchObject({ deniedPaths: ['C:\\Users\\dev\\.ssh'], readwritePaths: [WS, TMP] });
    expect(Object.keys(childEnv).map((k) => k.toUpperCase())).not.toContain('NODE_OPTIONS');
  });

  it('reports none with the reason, and tears down, when the probe fails; never another backend', async () => {
    const onDegraded = vi.fn();
    const h = harness({}, { ok: false, reason: 'MXC BaseContainer is not available on this host (processcontainer tiers: appcontainer-dacl)' });
    const status = await provider(h, { onDegraded }).initialize(policy());
    expect(status.backend).toBe('none');
    expect(status.filesystem).toBe('none');
    expect(status.degradations[0]).toMatch(/WITHOUT OS containment.*appcontainer-dacl/);
    expect(onDegraded).toHaveBeenCalledWith(status.degradations);
    expect(h.proxyClose).toHaveBeenCalled();
    expect(h.deps.removeDir).toHaveBeenCalledWith(LAUNCHER_DIR);
  });

  it('reports none when the SDK is not installed, without preparing anything', async () => {
    const h = harness({ resolveSdk: () => undefined });
    const status = await provider(h).initialize(policy());
    expect(status.backend).toBe('none');
    // npm installs the SDK with Cortex on Windows, so the reason points at a
    // reinstall rather than at installing the SDK by hand.
    expect(status.degradations[0]).toMatch(/@animus-labs\/cortex-win32/);
    expect(status.degradations[0]).toMatch(/--omit=optional/);
    expect(status.degradations[0]).toMatch(/run npm install/);
    expect(status.degradations[0]).not.toMatch(/npm install @microsoft\/mxc-sdk/);
    expect(h.deps.runProbe).not.toHaveBeenCalled();
    expect(h.deps.startProxy).not.toHaveBeenCalled();
  });

  it('reports none off Windows', async () => {
    const status = await provider(harness({ platform: 'darwin' })).initialize(policy());
    expect(status.backend).toBe('none');
    expect(status.degradations[0]).toMatch(/Windows-only/);
  });

  it('refuses a launcher copy that a contained command could rewrite', async () => {
    const h = harness({ prepareLauncher: () => ({ dir: `${WS}\\.cache\\mxc`, path: `${WS}\\.cache\\mxc\\l.mjs` }) });
    const status = await provider(h).initialize(policy());
    expect(status.backend).toBe('none');
    expect(status.degradations[0]).toMatch(/inside a writable root/);
    expect(h.deps.runProbe).not.toHaveBeenCalled();
  });

  it('reports none when the proxy cannot start', async () => {
    const h = harness({ startProxy: async () => { throw new Error('EADDRINUSE'); } });
    const status = await provider(h).initialize(policy());
    expect(status.backend).toBe('none');
    expect(status.degradations[0]).toMatch(/network proxy: EADDRINUSE/);
  });

  it('starts no proxy when the policy denies all egress', async () => {
    const h = harness();
    expect((await provider(h).initialize(policy('deny'))).network).toBe('enforced');
    expect(h.deps.startProxy).not.toHaveBeenCalled();
  });

  it('reports filesystem partial when host-side launcher code lives inside a writable root', async () => {
    const h = harness({ resolveSdk: () => ({ entry: SDK.entry, packageRoot: `${WS}\\node_modules\\@microsoft\\mxc-sdk` }) });
    const status = await provider(h).initialize(policy());
    expect(status.filesystem).toBe('partial');
    expect(status.backend).toBe('mxc-base-container');
    expect(status.degradations[0]).toMatch(/shadow its dependencies/);
  });

  it('closes the previous proxy and launcher copy when the policy changes', async () => {
    const h = harness();
    const p = provider(h);
    await p.initialize(policy());
    await p.initialize(policy('full'));
    expect(h.proxyClose).toHaveBeenCalledTimes(1);
    expect(h.deps.removeDir).toHaveBeenCalledTimes(1);
  });
});

describe('MxcSandboxProvider.wrapSpawn / wrapExec', () => {
  it('launches node with the private launcher and the quoted command line in the transport', async () => {
    const h = harness();
    const p = provider(h);
    await p.initialize(policy());
    const wrapped = await p.wrapSpawn(spec);
    expect(wrapped.file).toBe(NODE);
    expect(wrapped.args).toEqual([LAUNCHER, '--run']);
    const { payload } = decodeLauncherPayload(wrapped.env);
    expect(payload.request.command).toBe('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "echo \\"hi\\""');
  });

  it('scrubs credentials case-insensitively and points temp and proxy variables at the sandbox', async () => {
    const h = harness();
    const p = provider(h);
    await p.initialize(policy());
    const { childEnv } = decodeLauncherPayload((await p.wrapSpawn(spec)).env);
    const upper = Object.fromEntries(Object.entries(childEnv).map(([k, v]) => [k.toUpperCase(), v]));
    expect(upper['GITHUB_TOKEN']).toBeUndefined();
    expect(upper['TEMP']).toBe(TMP);
    expect(upper['TMP']).toBe(TMP);
    expect(upper['HTTP_PROXY']).toBe('http://127.0.0.1:4567');
    expect(upper['HTTPS_PROXY']).toBe('http://127.0.0.1:4567');
    const names = Object.keys(childEnv).map((k) => k.toUpperCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it('sets no proxy variables when egress is denied', async () => {
    const h = harness();
    const p = provider(h);
    await p.initialize(policy('deny'));
    const { childEnv } = decodeLauncherPayload((await p.wrapSpawn(spec)).env);
    expect(childEnv['http_proxy']).toBe('http://corp:8080');
    expect(childEnv['HTTPS_PROXY']).toBeUndefined();
  });

  it('re-checks deny paths per command, so a secret created mid-session is denied', async () => {
    const h = harness();
    const p = provider(h);
    await p.initialize(policy());
    const denied = async () =>
      (decodeLauncherPayload((await p.wrapSpawn(spec)).env).payload.request['filesystem'] as { deniedPaths: string[] }).deniedPaths;
    expect(await denied()).toEqual(['C:\\Users\\dev\\.ssh']);
    h.existing.add('C:\\Users\\dev\\.aws');
    expect(await denied()).toEqual(['C:\\Users\\dev\\.ssh', 'C:\\Users\\dev\\.aws']);
  });

  it('wraps direct program invocations the same way (Grep, stdio MCP)', async () => {
    const h = harness();
    const p = provider(h);
    await p.initialize(policy());
    const wrapped = await p.wrapExec({ file: 'C:\\rg\\rg.exe', args: ['--json', 'a b', 'C:\\ws'], cwd: WS, env: spec.env });
    expect(wrapped.args).toEqual([LAUNCHER, '--run']);
    expect(decodeLauncherPayload(wrapped.env).payload.request.command).toBe('C:\\rg\\rg.exe --json "a b" C:\\ws');
  });

  it('passes commands through unchanged when not enforcing', async () => {
    const p = provider(harness({}, { ok: false, reason: 'no PSEC' }));
    await p.initialize(policy());
    expect(await p.wrapSpawn(spec)).toEqual({ file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env });
    expect(await p.wrapExec({ file: 'rg', args: ['x'], cwd: WS, env: {} })).toEqual({ file: 'rg', args: ['x'], env: {} });
  });

  it('never forwards a transport variable already present in the incoming environment', async () => {
    const h = harness();
    const p = provider(h);
    await p.initialize(policy());
    const wrapped = await p.wrapSpawn({ ...spec, env: { ...spec.env, CORTEX_MXC_REQUEST_9: 'forged' } });
    expect(wrapped.env['CORTEX_MXC_REQUEST_9']).toBeUndefined();
    expect(wrapped.env[LAUNCHER_ENV_COUNT]).toBeDefined();
  });
});

describe('MxcSandboxProvider network decisions', () => {
  it('applies the domain policy at the proxy and asks the resolver about the rest', async () => {
    const onNetworkRequest = vi.fn(async ({ host }: { host: string }) => host === 'approved.example');
    const h = harness();
    await provider(h, { onNetworkRequest }).initialize(policy());
    const decide = h.proxyDecide();
    expect(await decide('registry.npmjs.org', 443)).toBe(true);
    expect(await decide('evil.example', 443)).toBe(false);
    expect(await decide('approved.example', 443)).toBe(true);
    expect(await decide('other.example', 443)).toBe(false);
    expect(onNetworkRequest).toHaveBeenCalledTimes(2);
    expect(onNetworkRequest).toHaveBeenCalledWith({ host: 'approved.example', port: 443 });
  });

  it('denies when the resolver throws', async () => {
    const h = harness();
    await provider(h, { onNetworkRequest: async () => { throw new Error('boom'); } }).initialize(policy());
    expect(await h.proxyDecide()('other.example', 443)).toBe(false);
  });
});

describe('MxcSandboxProvider failures and teardown', () => {
  it('reports a launcher that could not start as lost containment', async () => {
    const onDegraded = vi.fn();
    const h = harness();
    const p = provider(h, { onDegraded });
    await p.initialize(policy());
    p.notifyWrappedSpawnFailure({ code: 'ENOENT', message: 'spawn node ENOENT' });
    expect(p.status().backend).toBe('none');
    expect(p.status().degradations[0]).toMatch(/could not be started \(ENOENT\)/);
    expect(onDegraded).toHaveBeenCalled();
  });

  it('attributes launcher refusals and Windows access denials', async () => {
    const p = provider(harness());
    await p.initialize(policy());
    expect(p.classifyFailure({ command: 'x', exitCode: LAUNCHER_FAILURE_EXIT, stderr: `${LAUNCHER_ERROR_PREFIX} gate`, stdout: '' })).toMatchObject({ escalatable: false });
    expect(p.classifyFailure({ command: 'x', exitCode: 1, stderr: 'Access is denied.', stdout: '' })).toMatchObject({ dimension: 'unknown', escalatable: true });
    expect(p.classifyFailure({ command: 'x', exitCode: 1, stderr: 'file not found', stdout: '' })).toBeNull();
    expect(p.classifyFailure({ command: 'x', exitCode: 0, stderr: 'Access is denied.', stdout: '' })).toBeNull();
  });

  it('closes the proxy and removes the launcher copy on dispose', async () => {
    const h = harness();
    const p = provider(h);
    await p.initialize(policy());
    await p.dispose();
    expect(h.proxyClose).toHaveBeenCalled();
    expect(h.deps.removeDir).toHaveBeenCalledWith(LAUNCHER_DIR);
    expect(p.status().backend).toBe('none');
  });
});

describe('startMxcDomainProxy (real sandbox-runtime proxy server)', () => {
  let target: Server | undefined;
  afterEach(() => { target?.close(); target = undefined; });

  function viaProxy(proxyUrl: string, url: string): Promise<number> {
    const proxy = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: proxy.hostname, port: proxy.port, path: url, method: 'GET', headers: { host: new URL(url).host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('forwards allowed destinations and refuses denied ones, consulting the decision per host', async () => {
    target = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => target!.listen(0, '127.0.0.1', r));
    const port = (target.address() as { port: number }).port;
    const decide = vi.fn(async (host: string) => host === '127.0.0.1');
    const proxy = await startMxcDomainProxy(decide);
    try {
      expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await viaProxy(proxy.url, `http://127.0.0.1:${port}/`)).toBe(200);
      expect(await viaProxy(proxy.url, `http://localhost:${port}/`)).toBe(403);
      expect(decide).toHaveBeenCalledWith('127.0.0.1', port);
    } finally {
      await proxy.close();
    }
  });
});
