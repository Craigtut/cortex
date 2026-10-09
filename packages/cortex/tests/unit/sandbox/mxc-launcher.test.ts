import { describe, expect, it, vi } from 'vitest';
import { execFile, spawn as spawnChild } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LAUNCHER_ENV_COUNT,
  LAUNCHER_ENV_PREFIX,
  LAUNCHER_ERROR_PREFIX,
  LAUNCHER_FAILURE_EXIT,
  decodeLauncherPayload,
  encodeLauncherPayload,
  gateBaseContainer,
  runContained,
  runProbe,
  unsupportedNodeReason,
  type LauncherDeps,
  type LauncherPayload,
  type MxcAvailableBackend,
  type MxcProbeOutput,
  type MxcProcessLike,
  type MxcSdkLike,
} from '../../../src/sandbox/backends/mxc-launcher.js';

const LAUNCHER_SOURCE = fileURLToPath(new URL('../../../src/sandbox/backends/mxc-launcher.ts', import.meta.url));

function payload(overrides: Partial<LauncherPayload> = {}): LauncherPayload {
  return {
    version: 1,
    sdkEntry: 'file:///C:/sdk/dist/v1/index.js',
    request: { command: 'pwsh.exe -Command "echo hi"', filesystem: { readwritePaths: ['C:\\ws'] } },
    requiredCapabilities: ['filesystemDeniedPaths'],
    ...overrides,
  };
}

const BASE: MxcAvailableBackend = {
  backend: 'processcontainer',
  tier: 'base-container',
  capabilities: ['filesystemDeniedPaths', 'ingressHostLoopbackAllow'],
  warnings: [],
};

function fakeProcess(stdoutText: string, stderrText: string, exitCode: number) {
  const input = new PassThrough();
  const received: string[] = [];
  input.on('data', (chunk) => received.push(String(chunk)));
  const proc: MxcProcessLike = {
    standardInput: input,
    standardOutput: Readable.from([stdoutText]),
    standardError: Readable.from([stderrText]),
    wait: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { exitCode, timedOut: false };
    },
    kill: vi.fn(),
    dispose: vi.fn(),
  };
  return { proc, received };
}

function fakeSdk(opts: { backends?: MxcAvailableBackend[]; probe?: MxcProbeOutput; proc?: MxcProcessLike } = {}) {
  const sdk = {
    getAvailableBackends: vi.fn(() => opts.backends ?? [BASE]),
    probe: vi.fn((_request: Record<string, unknown>) => opts.probe ?? { tier: 'base-container', needsDaclAugmentation: false, warnings: [] }),
    spawn: vi.fn(async (_request: Record<string, unknown>) => opts.proc ?? fakeProcess('', '', 0).proc),
  } satisfies MxcSdkLike;
  return sdk;
}

function collect() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (c) => { text += String(c); });
  return { stream, text: () => text };
}

function deps(sdk: MxcSdkLike, env: Record<string, string>, extra: Partial<LauncherDeps> = {}) {
  const stdout = collect();
  const stderr = collect();
  const d: LauncherDeps = {
    env,
    cwd: 'C:\\ws',
    platform: 'win32',
    nodeVersion: 'v24.21.0',
    loadSdk: vi.fn(async () => sdk),
    stdin: Readable.from(['input-bytes']),
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...extra,
  };
  return { d, stdout, stderr };
}

const BASE_ENV = { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', PATH: 'C:\\bin' };

describe('launcher transport', () => {
  it('round-trips a payload and strips every transport variable from the command env', () => {
    const p = payload();
    const env = { ...BASE_ENV, ...encodeLauncherPayload(p) };
    const { payload: decoded, childEnv } = decodeLauncherPayload(env);
    expect(decoded).toEqual(p);
    expect(childEnv).toEqual(BASE_ENV);
  });

  it('chunks a large request below the per-variable limit', () => {
    const big = payload({ request: { command: 'x', filesystem: { readonlyPaths: Array.from({ length: 400 }, (_, i) => `C:\\dir-${i}`) } } });
    const env = encodeLauncherPayload(big);
    expect(Number(env[LAUNCHER_ENV_COUNT])).toBeGreaterThan(1);
    for (const value of Object.values(env)) expect(value.length).toBeLessThanOrEqual(4096);
    expect(decodeLauncherPayload(env).payload).toEqual(big);
  });

  it('removes differently-cased transport variables too', () => {
    const env = { ...BASE_ENV, ...encodeLauncherPayload(payload()), [`${LAUNCHER_ENV_PREFIX.toLowerCase()}stale`]: 'x' };
    expect(Object.keys(decodeLauncherPayload(env).childEnv).some((k) => k.toUpperCase().startsWith(LAUNCHER_ENV_PREFIX))).toBe(false);
  });

  it('rejects missing, truncated, and malformed payloads without echoing them', () => {
    const good = encodeLauncherPayload(payload());
    expect(() => decodeLauncherPayload(BASE_ENV)).toThrow('invalid MXC launcher request');
    expect(() => decodeLauncherPayload({ ...good, [LAUNCHER_ENV_COUNT]: '2' })).toThrow('invalid MXC launcher request');
    const encode = (value: unknown) => ({ [LAUNCHER_ENV_COUNT]: '1', [`${LAUNCHER_ENV_PREFIX}0`]: Buffer.from(JSON.stringify(value)).toString('base64') });
    for (const bad of [
      { ...payload(), version: 2 },
      { ...payload(), sdkEntry: 'C:\\sdk\\index.js' },
      { ...payload(), request: { command: '' } },
      { ...payload(), requiredCapabilities: [1] },
      'not-json-object',
    ]) {
      expect(() => decodeLauncherPayload(encode(bad))).toThrow('invalid MXC launcher request');
    }
    expect(() => decodeLauncherPayload({ [LAUNCHER_ENV_COUNT]: '1', [`${LAUNCHER_ENV_PREFIX}0`]: '%%%' })).toThrow('invalid MXC launcher request');
  });

  it('refuses a request too large to transport', () => {
    expect(() => encodeLauncherPayload(payload({ request: { command: 'x'.repeat(800_000) } }))).toThrow(/too large/);
  });
});

describe('unsupportedNodeReason', () => {
  it.each([
    ['v24.20.9', false],
    ['v24.21.0', true],
    ['v25.9.0', false],
    ['v26.7.0', false],
    ['v26.8.0', true],
    ['v27.0.0', true],
  ])('%s supported=%s', (version, supported) => {
    expect(unsupportedNodeReason(version) === null).toBe(supported);
  });
});

describe('gateBaseContainer', () => {
  it('accepts the BaseContainer tier with the required capabilities', () => {
    const sdk = fakeSdk();
    expect(gateBaseContainer(sdk, payload()).tier).toBe('base-container');
    expect(sdk.probe).toHaveBeenCalledWith(payload().request);
  });

  it('refuses a host that only offers AppContainer tiers', () => {
    const sdk = fakeSdk({ backends: [{ ...BASE, tier: 'appcontainer-dacl', warnings: ['no PSEC'] }] });
    expect(() => gateBaseContainer(sdk, payload())).toThrow(/not available.*appcontainer-dacl.*no PSEC/s);
    expect(sdk.probe).not.toHaveBeenCalled();
  });

  it('refuses when no processcontainer backend exists', () => {
    expect(() => gateBaseContainer(fakeSdk({ backends: [] }), payload())).toThrow(/tiers: none/);
  });

  it('refuses when a required capability is missing', () => {
    const sdk = fakeSdk({ backends: [{ ...BASE, capabilities: ['filesystemDeniedPaths'] }] });
    expect(() => gateBaseContainer(sdk, payload({ requiredCapabilities: ['ingressHostLoopbackAllow'] }))).toThrow(/lacks ingressHostLoopbackAllow/);
  });

  it('refuses when the request itself would run at another tier or edit DACLs', () => {
    expect(() => gateBaseContainer(fakeSdk({ probe: { tier: 'appcontainer-bfs', warnings: [] } }), payload())).toThrow(/appcontainer-bfs/);
    expect(() => gateBaseContainer(fakeSdk({ probe: { tier: 'base-container', needsDaclAugmentation: true, warnings: [] } }), payload())).toThrow(/DACL/);
    expect(() => gateBaseContainer(fakeSdk({ probe: { error: 'detector failed', warnings: [] } }), payload())).toThrow(/detector failed/);
  });
});

describe('runContained', () => {
  it('spawns with the request, the cwd, and the scrubbed explicit environment, then relays stdio and the exit code', async () => {
    const { proc, received } = fakeProcess('out-text', 'err-text', 7);
    const sdk = fakeSdk({ proc });
    const { d, stdout, stderr } = deps(sdk, { ...BASE_ENV, '=C:': 'C:\\', ...encodeLauncherPayload(payload()) });
    expect(await runContained(d)).toBe(7);
    expect(sdk.spawn).toHaveBeenCalledWith({
      ...payload().request,
      workingDirectory: 'C:\\ws',
      environment: BASE_ENV,
      inheritDefaultEnvironment: false,
    });
    expect(stdout.text()).toBe('out-text');
    expect(stderr.text()).toBe('err-text');
    expect(received.join('')).toBe('input-bytes');
    expect(proc.dispose).toHaveBeenCalled();
  });

  it('fails closed without spawning when the gate refuses', async () => {
    const sdk = fakeSdk({ backends: [{ ...BASE, tier: 'appcontainer-dacl' }] });
    const { d, stderr } = deps(sdk, { ...BASE_ENV, ...encodeLauncherPayload(payload()) });
    expect(await runContained(d)).toBe(LAUNCHER_FAILURE_EXIT);
    expect(sdk.spawn).not.toHaveBeenCalled();
    expect(stderr.text()).toContain(LAUNCHER_ERROR_PREFIX);
    expect(stderr.text()).toContain('the command did not run');
  });

  it('fails closed when the environment lacks what MXC requires', async () => {
    const sdk = fakeSdk();
    const { d, stderr } = deps(sdk, { PATH: 'C:\\bin', ...encodeLauncherPayload(payload()) });
    expect(await runContained(d)).toBe(LAUNCHER_FAILURE_EXIT);
    expect(sdk.spawn).not.toHaveBeenCalled();
    expect(stderr.text()).toMatch(/SystemRoot and LOCALAPPDATA/);
  });

  it('fails closed when the SDK cannot load or lacks the v1 API', async () => {
    const env = { ...BASE_ENV, ...encodeLauncherPayload(payload()) };
    const missing = deps(fakeSdk(), env, { loadSdk: async () => { throw new Error('Cannot find module'); } });
    expect(await runContained(missing.d)).toBe(LAUNCHER_FAILURE_EXIT);
    expect(missing.stderr.text()).toMatch(/could not load @microsoft\/mxc-sdk/);
    const wrong = deps(fakeSdk(), env, { loadSdk: async () => ({ run: () => {} }) });
    expect(await runContained(wrong.d)).toBe(LAUNCHER_FAILURE_EXIT);
    expect(wrong.stderr.text()).toMatch(/does not export the v1/);
  });

  it('refuses an unsupported Node on Windows only', async () => {
    const env = { ...BASE_ENV, ...encodeLauncherPayload(payload()) };
    const win = deps(fakeSdk(), env, { nodeVersion: 'v25.2.1' });
    expect(await runContained(win.d)).toBe(LAUNCHER_FAILURE_EXIT);
    expect(win.stderr.text()).toMatch(/needs 24\.21\+ or 26\.8\+/);
    const other = deps(fakeSdk(), env, { nodeVersion: 'v25.2.1', platform: 'linux' });
    expect(await runContained(other.d)).toBe(0);
  });
});

describe('runProbe', () => {
  it('reports availability as one JSON line', async () => {
    const ok = deps(fakeSdk(), { ...BASE_ENV, ...encodeLauncherPayload(payload()) });
    expect(await runProbe(ok.d)).toBe(0);
    expect(JSON.parse(ok.stdout.text())).toMatchObject({ ok: true, tier: 'base-container' });
    const bad = deps(fakeSdk({ backends: [] }), { ...BASE_ENV, ...encodeLauncherPayload(payload()) });
    expect(await runProbe(bad.d)).toBe(0);
    expect(JSON.parse(bad.stdout.text())).toMatchObject({ ok: false, reason: expect.stringMatching(/not available/) });
  });
});

describe('launcher self-containment', () => {
  it('imports only Node builtins, so a private copy runs without its siblings', () => {
    const source = readFileSync(LAUNCHER_SOURCE, 'utf8');
    const specifiers = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s!.startsWith('node:'))).toEqual([]);
  });
});

// End-to-end through the real entry point: a node process runs the launcher
// source (Node strips the types; --no-warnings keeps stderr exact on Node
// versions that still flag type stripping) against a fake SDK module that
// spawns a real child.
describe('launcher entry point', () => {
  function runLauncher(args: string[], env: Record<string, string>, input: string) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawnChild(process.execPath, ['--no-warnings', LAUNCHER_SOURCE, ...args], { env, stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += String(c); });
      child.stderr.on('data', (c) => { stderr += String(c); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  function fakeSdkModule(dir: string): string {
    const file = join(dir, 'fake-mxc-sdk.mjs');
    writeFileSync(
      file,
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
export function getAvailableBackends() {
  return [{ backend: 'processcontainer', tier: 'base-container', capabilities: ['filesystemDeniedPaths'], warnings: [] }];
}
export function probe() { return { tier: 'base-container', needsDaclAugmentation: false, warnings: [] }; }
export { spawnContained as spawn };
async function spawnContained(request) {
  writeFileSync(request.environment.FAKE_RECORD, JSON.stringify(request));
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(
    "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write('OUT:'+s.toUpperCase());process.stderr.write('ERR');process.exit(7);});",
  )}], { env: request.environment, cwd: request.workingDirectory, stdio: 'pipe' });
  return {
    standardInput: child.stdin, standardOutput: child.stdout, standardError: child.stderr,
    wait: () => new Promise((r) => child.on('close', (code) => r({ exitCode: code, timedOut: false }))),
    kill() { child.kill(); }, dispose() {},
  };
}
`,
    );
    return pathToFileURL(file).href;
  }

  it('runs the command through the SDK, relays stdio, exits with its code, and hides the transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mxc-launcher-e2e-'));
    try {
      const record = join(dir, 'request.json');
      const sdkEntry = fakeSdkModule(dir);
      const env = {
        ...BASE_ENV,
        PATH: process.env['PATH'] ?? '',
        FAKE_RECORD: record,
        ...encodeLauncherPayload(payload({ sdkEntry })),
      };
      const result = await runLauncher(['--run'], env, 'hello');
      expect(result.stderr).toBe('ERR');
      expect(result.stdout).toBe('OUT:HELLO');
      expect(result.code).toBe(7);
      const request = JSON.parse(readFileSync(record, 'utf8')) as { command: string; environment: Record<string, string>; workingDirectory: string };
      expect(request.command).toBe(payload().request.command);
      expect(request.environment['FAKE_RECORD']).toBe(record);
      expect(Object.keys(request.environment).some((k) => k.startsWith(LAUNCHER_ENV_PREFIX))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('does nothing without a mode flag, and does nothing without the transport', async () => {
    const quiet = await runLauncher([], { ...BASE_ENV, ...encodeLauncherPayload(payload()) }, '');
    expect(quiet).toEqual({ code: 0, stdout: '', stderr: '' });
    const noTransport = await runLauncher(['--run'], { ...BASE_ENV }, '');
    expect(noTransport).toEqual({ code: 0, stdout: '', stderr: '' });
  }, 30_000);

  it('probes through the real entry point', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mxc-launcher-e2e-'));
    try {
      const env = { ...BASE_ENV, ...encodeLauncherPayload(payload({ sdkEntry: fakeSdkModule(dir) })) };
      const result = await new Promise<string>((resolve, reject) =>
        execFile(process.execPath, ['--no-warnings', LAUNCHER_SOURCE, '--probe'], { env }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
      );
      expect(JSON.parse(result)).toMatchObject({ ok: true, tier: 'base-container', capabilities: ['filesystemDeniedPaths'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
