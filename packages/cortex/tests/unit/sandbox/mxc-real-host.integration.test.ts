/**
 * The real-host checklist from docs/cortex/windows-sandbox-build.md, automated
 * for a Windows 11 host where MXC BaseContainer is available. Everything runs
 * against the installed @microsoft/mxc-sdk and real containment: a
 * CortexAgent with the managed sandbox (`sandbox: true`), commands through the
 * agent's own Bash, Grep, and TaskOutput tools (captured from the pi Agent it
 * builds, the way the facade sandbox tests capture its permission hook), and
 * stdio MCP through the agent's MCP client.
 *
 * Gate: the suite runs on Windows when the real provider's probe reports
 * BaseContainer enforcement and skips otherwise. CORTEX_MXC_REAL_HOST=1 (set
 * by CI after its own probe passed) turns an unavailable host into a failure.
 * Items that need a desktop or a person (synthetic input, where a window
 * appears) and killing the agent process itself stay manual; see the runbook.
 * What the checklist asks to record rather than assert is printed and, in
 * CI, appended to the job summary.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBuiltinModel as getModel } from '@earendil-works/pi-ai/providers/all';
import { CortexAgent } from '../../../src/cortex-agent.js';
import { wrapModel } from '../../../src/model-wrapper.js';
import { executeShellCommand } from '../../../src/skill-preprocessor.js';
import { MxcSandboxProvider } from '../../../src/sandbox/backends/mxc.js';
import { resolveMxcSdk } from '../../../src/sandbox/backends/mxc-host.js';
import { LAUNCHER_ERROR_PREFIX, LAUNCHER_FAILURE_EXIT } from '../../../src/sandbox/backends/mxc-launcher.js';
import { createSandboxProvider } from '../../../src/sandbox/factory.js';
import { buildDefaultPolicy } from '../../../src/sandbox/policy.js';
import type { SandboxOptions } from '../../../src/sandbox/options.js';
import type { SandboxStatus } from '../../../src/sandbox/types.js';
import type { BashDetails } from '../../../src/tools/bash/index.js';
import { createBashTool } from '../../../src/tools/bash/index.js';
import { CwdTracker } from '../../../src/tools/shared/cwd-tracker.js';

interface PiTool {
  name: string;
  execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown }>;
}
interface CapturedPiAgent {
  options: { beforeToolCall?: (context: unknown) => Promise<unknown> };
  agent: { state: { tools?: PiTool[] } };
}

const piAgents = vi.hoisted(() => [] as CapturedPiAgent[]);
vi.mock('@earendil-works/pi-agent-core', async (original) => {
  const real = await original<typeof import('@earendil-works/pi-agent-core')>();
  return { ...real, Agent: class extends real.Agent {
    constructor(options: ConstructorParameters<typeof real.Agent>[0]) {
      super(options);
      piAgents.push({ options: options as unknown as CapturedPiAgent['options'], agent: this as unknown as CapturedPiAgent['agent'] });
    }
  } };
});

const IS_WINDOWS = process.platform === 'win32';
const REQUIRED = process.env['CORTEX_MXC_REAL_HOST'] === '1';
const SYSTEM_ROOT = process.env['SystemRoot'] ?? 'C:\\Windows';
const PS5 = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PWSH = [process.env['ProgramW6432'], process.env['ProgramFiles'], 'C:\\Program Files']
  .filter((dir): dir is string => typeof dir === 'string')
  .map((dir) => join(dir, 'PowerShell', '7', 'pwsh.exe'))
  .find((path) => existsSync(path));
const HOME = homedir();
const TAG = `cortex-mxc-${process.pid}-${Date.now()}`;

/** A fresh temp directory by its long path (os.tmpdir() can be an 8.3 short path). */
function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/** The real provider's verdict for a default workspace policy. */
async function probe(): Promise<SandboxStatus | undefined> {
  if (!IS_WINDOWS) return undefined;
  const root = tempDir('cortex-mxc-gate-');
  const provider = new MxcSandboxProvider();
  try {
    mkdirSync(join(root, 'ws'));
    mkdirSync(join(root, 'tmp'));
    return await provider.initialize(
      buildDefaultPolicy('workspace', { workspaceRoots: [join(root, 'ws')], home: HOME, sessionTmpDir: join(root, 'tmp') }),
    );
  } finally {
    await provider.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

const gate = await probe();
const AVAILABLE = gate?.backend === 'mxc-base-container' && gate.filesystem === 'enforced' && gate.network === 'enforced';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const observations: Array<[string, string]> = [];
function observe(item: string, value: string): void {
  observations.push([item, value]);
  console.log(`[mxc real host] ${item}: ${value}`);
}

/** A PowerShell single-quoted literal. */
function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=cortex', '-c', 'user.email=cortex@example.invalid', ...args], { cwd, encoding: 'utf8' });
}

/** A git repository with one commit, a README, and the consumer's .cortex directory. */
function makeRepo(dir: string): string {
  mkdirSync(join(dir, '.cortex'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), `readme ${TAG}\n`);
  git(dir, 'init', '-q');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** Run a command uncontained, as the host. */
function host(shell: string, command: string): string {
  return execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim();
}

interface Session {
  agent: CortexAgent;
  workspace: string;
  tool(name: string): PiTool;
  beforeToolCall(context: unknown): Promise<unknown>;
}

const agents: CortexAgent[] = [];
let calls = 0;

async function openSession(workspace: string, options: { shellPath?: string; sandbox?: SandboxOptions } = {}): Promise<Session> {
  const first = piAgents.length;
  const agent = await CortexAgent.create({
    model: wrapModel(getModel('anthropic', 'claude-sonnet-4-6'), 'anthropic', 'claude-sonnet-4-6'),
    workingDirectory: workspace,
    getApiKey: async () => 'unused',
    mode: 'passthrough',
    sandbox: { denyWrite: ['.cortex'], ...options.sandbox },
    ...(options.shellPath ? { bash: { shellPath: options.shellPath } } : {}),
    // Approves everything, including a Bash escalateOutsideSandbox request.
    resolvePermission: async () => true,
  });
  agents.push(agent);
  const captured = piAgents[first];
  if (!captured || piAgents.length !== first + 1) throw new Error('expected CortexAgent to build exactly one pi Agent');
  return {
    agent,
    workspace,
    tool(name) {
      const found = captured.agent.state.tools?.find((t) => t.name === name);
      if (!found) throw new Error(`the agent has no ${name} tool`);
      return found;
    },
    beforeToolCall: (context) => captured.options.beforeToolCall!(context),
  };
}

type BashRun = BashDetails & { text: string };

async function bash(session: Session, command: string, extra: Record<string, unknown> = {}): Promise<BashRun> {
  const result = await session.tool('Bash').execute(`call-${++calls}`, { command, timeout: 90_000, ...extra });
  return { ...(result.details as BashDetails), text: result.content.map((c) => c.text ?? '').join('\n') };
}

/** Assert a contained command failed and left no file behind. */
async function expectWriteDenied(session: Session, path: string): Promise<void> {
  const run = await bash(session, `Set-Content -LiteralPath ${q(path)} -Value escape`);
  const created = existsSync(path);
  if (created) rmSync(path, { force: true });
  expect(created, `${path} was written from inside the container`).toBe(false);
  expect(run.exitCode).not.toBe(0);
}

async function listen(address: string, body: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => res.end(body));
  await new Promise<void>((resolve) => server.listen(0, address, resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function reachable(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return await response.text();
  } catch {
    return undefined;
  }
}

/** Whether a host process whose command line contains `marker` is still running. */
function processWithMarker(marker: string): boolean {
  const out = host(PS5, `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ${q(`*${marker}*`)} -and $_.ProcessId -ne $PID }).Count`);
  return Number(out) > 0;
}

/** A second fixed drive other than the system drive, if this host has one. */
function secondDrive(): string | undefined {
  for (const letter of 'DEFGH') {
    const root = `${letter}:\\`;
    try {
      const probePath = join(root, `${TAG}.probe`);
      writeFileSync(probePath, 'x');
      rmSync(probePath);
      return root;
    } catch {
      continue;
    }
  }
  return undefined;
}

afterAll(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.destroy().catch(() => {})));
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary && observations.length > 0) {
    const rows = observations.map(([item, value]) => `| ${item} | ${value.replaceAll('|', '\\|').replaceAll('\n', ' ')} |`);
    appendFileSync(summary, ['', '## MXC real-host observations', '', '| Item | Observed |', '| --- | --- |', ...rows, ''].join('\n'));
  }
}, 120_000);

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe.runIf(REQUIRED && !AVAILABLE)('MXC real host (required)', () => {
  it('has MXC BaseContainer available', () => {
    throw new Error(`CORTEX_MXC_REAL_HOST=1 but MXC is unavailable: ${gate?.degradations.join('; ') ?? `not Windows (${process.platform})`}`);
  });
});

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

describe.skipIf(!AVAILABLE)('MXC real-host checklist', () => {
  const root = AVAILABLE ? tempDir('cortex-mxc-real-') : '';
  const drive = AVAILABLE ? secondDrive() : undefined;
  const driveFile = drive ? join(drive, `${TAG}-readable.txt`) : undefined;
  const sshDir = join(HOME, '.ssh');
  const sshKey = join(sshDir, `${TAG}_ed25519`);
  const createdSshDir = AVAILABLE && !existsSync(sshDir);

  beforeAll(() => {
    // Fixtures the host creates before any session starts: a secret, and a
    // second-drive file that reads must reach (entries made under a volume
    // root after a session starts are not in its read set).
    mkdirSync(sshDir, { recursive: true });
    writeFileSync(sshKey, `PRIVATE ${TAG}\n`);
    if (driveFile) writeFileSync(driveFile, `drive ${TAG}\n`);
  });
  afterAll(() => {
    rmSync(sshKey, { force: true });
    if (createdSshDir) rmSync(sshDir, { recursive: true, force: true });
    if (driveFile) rmSync(driveFile, { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('1. probe and status: enforced BaseContainer, strict setup refuses without the SDK, no host ACL change', async () => {
    const workspace = makeRepo(join(root, 'acl'));
    const aclBefore = host(PS5, `icacls ${q(workspace)} /T /C`);
    const session = await openSession(workspace);
    const state = session.agent.getSandboxState()!;
    expect(state.status).toEqual({ backend: 'mxc-base-container', filesystem: 'enforced', network: 'enforced', degradations: [] });
    expect((await bash(session, 'Write-Output contained')).exitCode).toBe(0);
    await session.agent.destroy();
    expect(host(PS5, `icacls ${q(workspace)} /T /C`)).toBe(aclBefore);

    const withoutSdk = new MxcSandboxProvider({ deps: { resolveSdk: () => undefined } });
    await expect(CortexAgent.create({
      model: wrapModel(getModel('anthropic', 'claude-sonnet-4-6'), 'anthropic', 'claude-sonnet-4-6'),
      workingDirectory: workspace,
      getApiKey: async () => 'unused',
      mode: 'passthrough',
      sandbox: { provider: withoutSdk },
    })).rejects.toThrow(/enforcement is required but unavailable.*@microsoft\/mxc-sdk/s);
  }, 180_000);

  const shells = [
    ...(PWSH ? [{ name: 'pwsh.exe', shellPath: PWSH }] : []),
    { name: 'powershell.exe 5.1', shellPath: PS5 },
  ];

  describe.each(shells)('in $name', ({ name, shellPath }) => {
    let session: Session;
    let workspace: string;
    beforeAll(async () => {
      workspace = makeRepo(join(root, `ws-${name.replace(/\W/g, '')}`));
      session = await openSession(workspace, { shellPath });
    }, 120_000);

    it('2. writes outside the workspace are denied; the workspace and the session TEMP are writable', async () => {
      await expectWriteDenied(session, join(HOME, `${TAG}-escape.txt`));
      await expectWriteDenied(session, `C:\\${TAG}-escape.txt`);
      if (drive) await expectWriteDenied(session, join(drive, `${TAG}-escape.txt`));
      else observe('second drive', 'none on this host; the second-drive write and read items did not run');

      const inside = await bash(session, `Set-Content -LiteralPath inside.txt -Value ok`);
      expect(inside.exitCode).toBe(0);
      expect(readFileSync(join(workspace, 'inside.txt'), 'utf8').trim()).toBe('ok');

      const sessionTemp = session.agent.getSandboxState()!.policy!.filesystem.sessionTmpDir!;
      const temp = await bash(session, 'Set-Content -LiteralPath (Join-Path $env:TEMP probe.txt) -Value ok; Write-Output $env:TEMP');
      expect(temp.exitCode).toBe(0);
      expect(temp.stdout.trim().toLowerCase()).toBe(sessionTemp.toLowerCase());
      expect(existsSync(join(sessionTemp, 'probe.txt'))).toBe(true);
    }, 180_000);

    it('3. .git hooks and config and the consumer .cortex directory are protected; git commit works', async () => {
      await expectWriteDenied(session, join(workspace, '.git', 'hooks', 'pre-commit'));
      const config = readFileSync(join(workspace, '.git', 'config'), 'utf8');
      const appended = await bash(session, `Add-Content -LiteralPath ${q(join(workspace, '.git', 'config'))} -Value '[core]'`);
      expect(appended.exitCode).not.toBe(0);
      expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe(config);
      await expectWriteDenied(session, join(workspace, '.cortex', 'settings.json'));

      const commit = await bash(session, 'git -c user.name=cortex -c user.email=cortex@example.invalid commit -q --allow-empty -m contained; git log --oneline -1');
      expect(commit.exitCode, commit.stderr).toBe(0);
      expect(commit.stdout).toContain('contained');

      // A protected path that does not exist when the session starts.
      const bare = makeRepo(join(root, `no-hooks-${name.replace(/\W/g, '')}`));
      rmSync(join(bare, '.git', 'hooks'), { recursive: true, force: true });
      const hookless = await openSession(bare, { shellPath });
      const created = await bash(hookless, "New-Item -ItemType Directory -Path '.git\\hooks' | Out-Null");
      const hooksExist = existsSync(join(bare, '.git', 'hooks'));
      observe(`creating a missing .git\\hooks in ${name}`, hooksExist ? `allowed (exit ${created.exitCode})` : `denied (exit ${created.exitCode})`);
      expect(hooksExist).toBe(false);
      await hookless.agent.destroy();
    }, 180_000);

    it('4. secret reads are denied, including a secret created mid-session; credential variables are empty', async () => {
      const key = await bash(session, `Get-Content -LiteralPath ${q(sshKey)}`);
      expect(key.stdout).not.toContain(TAG);
      expect(key.exitCode).not.toBe(0);
      const listing = await bash(session, `Get-ChildItem -LiteralPath ${q(sshDir)} -Name`);
      expect(listing.stdout).not.toContain(`${TAG}_ed25519`);

      // A default-denied location that does not exist yet, created after the session started.
      const late = ['.aws', '.azure', '.kube', '.gnupg'].map((dir) => join(HOME, dir)).find((dir) => !existsSync(dir));
      if (late) {
        mkdirSync(late);
        try {
          writeFileSync(join(late, 'credentials'), `LATE ${TAG}\n`);
          const read = await bash(session, `Get-Content -LiteralPath ${q(join(late, 'credentials'))}`);
          expect(read.stdout).not.toContain(TAG);
        } finally {
          rmSync(late, { recursive: true, force: true });
        }
      } else {
        observe('mid-session secret', 'every candidate secret directory already existed; not tested');
      }

      const npmrc = join(HOME, '.npmrc');
      if (existsSync(npmrc)) {
        const read = await bash(session, `Get-Content -LiteralPath ${q(npmrc)}`);
        expect(read.exitCode).not.toBe(0);
      }

      const previous = process.env['GITHUB_TOKEN'];
      process.env['GITHUB_TOKEN'] = `ghp_${TAG}`;
      try {
        const token = await bash(session, 'Write-Output "[$env:GITHUB_TOKEN]"');
        expect(token.stdout.trim()).toBe('[]');
      } finally {
        if (previous === undefined) delete process.env['GITHUB_TOKEN'];
        else process.env['GITHUB_TOKEN'] = previous;
      }
    }, 180_000);

    it('5. reads stay broad', async () => {
      expect((await bash(session, 'Get-Content README.md')).stdout).toContain(TAG);
      expect((await bash(session, 'git status --short')).exitCode).toBe(0);
      expect((await bash(session, 'node -v')).stdout.trim()).toBe(process.version);
      expect((await bash(session, 'npm -v')).exitCode).toBe(0);
      const gitDir = 'C:\\Program Files\\Git';
      if (existsSync(gitDir)) expect((await bash(session, `Get-ChildItem -LiteralPath ${q(gitDir)} -Name`)).exitCode).toBe(0);
      const appDataNpm = join(process.env['APPDATA'] ?? '', 'npm');
      if (process.env['APPDATA'] && existsSync(appDataNpm)) {
        expect((await bash(session, `Get-ChildItem -LiteralPath ${q(appDataNpm)} -Name`)).exitCode).toBe(0);
      }
      if (driveFile) expect((await bash(session, `Get-Content -LiteralPath ${q(driveFile)}`)).stdout).toContain(TAG);
    }, 180_000);

    it('6. egress goes only through the proxy; restricted mode blocks it all', async () => {
      const allowed = await bash(session, 'curl.exe -s -o NUL -w "%{http_code}" https://registry.npmjs.org/');
      expect(allowed.stdout.trim()).toBe('200');
      const refused = await bash(session, 'curl.exe -s -o NUL -w "%{http_code}" https://example.com/');
      expect(refused.stdout.trim()).not.toBe('200');
      const direct = await bash(session, 'curl.exe -s -o NUL --max-time 15 --noproxy "*" https://registry.npmjs.org/');
      expect(direct.exitCode).not.toBe(0);
      const raw = await bash(session, "$c = New-Object Net.Sockets.TcpClient; try { $c.ConnectAsync('1.1.1.1', 443).Wait(5000) } catch { $false }");
      expect(raw.stdout.trim()).not.toBe('True');
      expect((await bash(session, 'npm view left-pad version')).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
      expect((await bash(session, 'git ls-remote https://github.com/git/git HEAD')).stdout).toMatch(/^[0-9a-f]{40}\s+HEAD/);
      const iwr = await bash(session, "(Invoke-WebRequest -UseBasicParsing -Uri https://registry.npmjs.org/ -TimeoutSec 20).StatusCode");
      observe(`Invoke-WebRequest in ${name}`, iwr.exitCode === 0 ? `status ${iwr.stdout.trim()}` : `failed: ${iwr.stderr.trim().split('\n')[0]}`);

      await session.agent.setSandboxRung('restricted');
      try {
        const blocked = await bash(session, 'curl.exe -s -o NUL --max-time 15 https://registry.npmjs.org/');
        expect(blocked.exitCode).not.toBe(0);
        expect((await bash(session, 'Write-Output "[$env:HTTPS_PROXY][$env:HTTP_PROXY]"')).stdout.trim()).toBe('[][]');
      } finally {
        await session.agent.setSandboxRung('workspace');
      }
    }, 300_000);
  });

  describe('in the discovered shell', () => {
    let session: Session;
    let workspace: string;
    beforeAll(async () => {
      workspace = makeRepo(join(root, 'ws-default'));
      session = await openSession(workspace);
    }, 120_000);

    it('7. loopback: host servers on 127.0.0.1 and ::1, and a contained background server, are reachable', async () => {
      const v4 = await listen('127.0.0.1', `v4 ${TAG}`);
      const v6 = await listen('::1', `v6 ${TAG}`);
      try {
        expect((await bash(session, `curl.exe -s --noproxy "*" http://127.0.0.1:${v4.port}/`)).stdout).toContain(`v4 ${TAG}`);
        expect((await bash(session, `curl.exe -s --noproxy "*" http://[::1]:${v6.port}/`)).stdout).toContain(`v6 ${TAG}`);

        const port = await freePort();
        const server = await bash(session, `node -e "require('http').createServer((q, s) => s.end('bg ${TAG}')).listen(${port}, '127.0.0.1')"`, { background: true });
        expect(server.taskId).toBeTruthy();
        try {
          let fromHost: string | undefined;
          for (let i = 0; i < 20 && !fromHost; i++) {
            fromHost = await reachable(`http://127.0.0.1:${port}/`);
            if (!fromHost) await new Promise((r) => setTimeout(r, 500));
          }
          expect(fromHost).toBe(`bg ${TAG}`);
          expect((await bash(session, `curl.exe -s --noproxy "*" http://127.0.0.1:${port}/`)).stdout).toContain(`bg ${TAG}`);
        } finally {
          await session.tool('TaskOutput').execute(`call-${++calls}`, { task_id: server.taskId, action: 'kill' });
        }

        await session.agent.setSandboxRung('restricted');
        try {
          expect((await bash(session, `curl.exe -s --noproxy "*" http://127.0.0.1:${v4.port}/`)).stdout).toContain(`v4 ${TAG}`);
        } finally {
          await session.agent.setSandboxRung('workspace');
        }
      } finally {
        v4.server.close();
        v6.server.close();
      }
    }, 300_000);

    it('8. the host clipboard is isolated', async () => {
      let hostClipboard = true;
      try {
        host(PS5, `Set-Clipboard -Value ${q(`host ${TAG}`)}`);
        hostClipboard = host(PS5, 'Get-Clipboard') === `host ${TAG}`;
      } catch {
        hostClipboard = false;
      }
      if (!hostClipboard) {
        observe('clipboard', 'the host has no usable clipboard (no interactive session); not tested');
        return;
      }
      expect((await bash(session, 'Get-Clipboard')).stdout).not.toContain(`host ${TAG}`);
      await bash(session, `Set-Clipboard -Value ${q(`contained ${TAG}`)}`);
      expect(host(PS5, 'Get-Clipboard')).toBe(`host ${TAG}`);
    }, 120_000);

    it('9. background tasks live until killed; detached and timed-out processes do not outlive their command', async () => {
      // Positive control: the host sees a contained process by its command line.
      const backgroundMarker = `${TAG}-background`;
      const task = await bash(session, `node -e "setTimeout(() => {}, 120000)" ${backgroundMarker}`, { background: true });
      expect(task.taskId).toBeTruthy();
      await new Promise((r) => setTimeout(r, 5000));
      expect(processWithMarker(backgroundMarker)).toBe(true);
      await session.tool('TaskOutput').execute(`call-${++calls}`, { task_id: task.taskId, action: 'kill' });
      await new Promise((r) => setTimeout(r, 3000));
      expect(processWithMarker(backgroundMarker)).toBe(false);

      const detachedMarker = `${TAG}-detached`;
      await bash(session, `Start-Process -FilePath node -ArgumentList ${q(`-e "setTimeout(() => {}, 120000)" ${detachedMarker}`)}; Start-Sleep -Seconds 2`);
      await new Promise((r) => setTimeout(r, 3000));
      const detachedAlive = processWithMarker(detachedMarker);
      observe('detached Start-Process child after its command returned', detachedAlive ? 'still running' : 'killed');
      expect(detachedAlive).toBe(false);

      const timeoutMarker = `${TAG}-timeout`;
      const timedOut = await bash(session, `node -e "setTimeout(() => {}, 120000)" ${timeoutMarker}`, { timeout: 4000 });
      expect(timedOut.timedOut).toBe(true);
      await new Promise((r) => setTimeout(r, 3000));
      expect(processWithMarker(timeoutMarker)).toBe(false);
    }, 180_000);

    it('10. Grep runs through wrapExec: workspace content is found, a secret is not', async () => {
      const grep = session.tool('Grep');
      const found = await grep.execute(`call-${++calls}`, { pattern: TAG, path: workspace, output_mode: 'content' });
      expect(found.content.map((c) => c.text).join('\n')).toContain(TAG);
      const secret = await grep.execute(`call-${++calls}`, { pattern: TAG, path: sshDir, output_mode: 'content' });
      expect(secret.content.map((c) => c.text).join('\n')).not.toContain(`PRIVATE ${TAG}`);
      expect((secret.details as { usingFallback: boolean }).usingFallback).toBe(false);
    }, 120_000);

    it('11. a stdio MCP server runs contained through wrapExec and stops on disconnect', async () => {
      const require = createRequire(import.meta.url);
      const serverModule = require.resolve('@modelcontextprotocol/sdk/server/index.js');
      const stdioModule = require.resolve('@modelcontextprotocol/sdk/server/stdio.js');
      const typesModule = require.resolve('@modelcontextprotocol/sdk/types.js');
      const script = join(root, 'mcp-server.cjs');
      writeFileSync(script, `
const fs = require('node:fs');
const { Server } = require(${JSON.stringify(serverModule)});
const { StdioServerTransport } = require(${JSON.stringify(stdioModule)});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(typesModule)});
const server = new Server({ name: 'files', version: '1.0.0' }, { capabilities: { tools: {} } });
const pathArg = { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] };
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'write', description: 'write a file', inputSchema: pathArg },
  { name: 'read', description: 'read a file', inputSchema: pathArg },
] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === 'write') { fs.writeFileSync(args.path, args.content ?? 'x'); return { content: [{ type: 'text', text: 'written' }] }; }
    return { content: [{ type: 'text', text: fs.readFileSync(args.path, 'utf8') }] };
  } catch (error) {
    return { content: [{ type: 'text', text: 'error: ' + error.message }], isError: true };
  }
});
server.connect(new StdioServerTransport());
`);
      const manager = session.agent.getMcpClientManager();
      const serverMarker = `${TAG}-mcp`;
      await manager.connect('files', { transport: 'stdio', command: process.execPath, args: [script, serverMarker], cwd: workspace });
      const call = async (tool: string, args: Record<string, unknown>) => {
        const found = manager.getTools().find((t) => t.name === `files__${tool}`);
        if (!found) throw new Error(`no files__${tool}; tools: ${manager.getTools().map((t) => t.name).join(', ')}`);
        const result = (await found.execute(`call-${++calls}`, args as never)) as { content: Array<{ text?: string }> };
        return result.content.map((c) => c.text ?? '').join('\n');
      };
      const inside = join(workspace, 'mcp-inside.txt');
      expect(await call('write', { path: inside, content: 'mcp' })).toBe('written');
      expect(readFileSync(inside, 'utf8')).toBe('mcp');
      const outside = join(HOME, `${TAG}-mcp-escape.txt`);
      expect(await call('write', { path: outside, content: 'escape' })).toMatch(/^error:/);
      const escaped = existsSync(outside);
      if (escaped) rmSync(outside, { force: true });
      expect(escaped).toBe(false);
      expect(await call('read', { path: sshKey })).not.toContain(TAG);
      expect(processWithMarker(serverMarker)).toBe(true);

      await manager.disconnect('files');
      await new Promise((r) => setTimeout(r, 3000));
      expect(processWithMarker(serverMarker)).toBe(false);
    }, 180_000);

    it('12. the Bash tool execute path: exit codes, streams, cwd, UTF-8, quoting, long commands, escalation, skill markers', async () => {
      expect((await bash(session, 'exit 3')).exitCode).toBe(3);
      const streams = await bash(session, "Write-Output 'to stdout'; [Console]::Error.WriteLine('to stderr')");
      expect(streams.stdout).toContain('to stdout');
      expect(streams.stdout).not.toContain('to stderr');
      expect(streams.stderr).toContain('to stderr');

      mkdirSync(join(workspace, 'sub dir'), { recursive: true });
      expect((await bash(session, "Set-Location 'sub dir'")).finalCwd).toBe(join(workspace, 'sub dir'));
      expect((await bash(session, '(Get-Location).Path')).stdout.trim()).toBe(join(workspace, 'sub dir'));
      await bash(session, `Set-Location ${q(workspace)}`);

      expect((await bash(session, 'Write-Output "héllo 世界"')).stdout.trim()).toBe('héllo 世界');
      expect((await bash(session, `Write-Output 'a "b" C:\\path\\'`)).stdout.trim()).toBe('a "b" C:\\path\\');

      const padding = 'x'.repeat(25_000);
      const long = await bash(session, `Write-Output long-ok # ${padding}`);
      observe('25,000-character command', long.exitCode === 0 ? 'ran' : `failed (${long.exitCode}): ${long.stderr.split('\n')[0]}`);
      expect(long.stdout.trim()).toBe('long-ok');

      const escapeTarget = join(HOME, `${TAG}-escalated.txt`);
      const args = { command: `Set-Content -LiteralPath ${q(escapeTarget)} -Value escalated`, escalateOutsideSandbox: true };
      expect(await session.beforeToolCall({ toolCall: { name: 'Bash', id: 'escalate', arguments: args }, args })).toBeUndefined();
      try {
        const escalated = await bash(session, args.command, { escalateOutsideSandbox: true });
        expect(escalated.exitCode).toBe(0);
        expect(existsSync(escapeTarget)).toBe(true);
      } finally {
        rmSync(escapeTarget, { force: true });
      }
      // Only that one command ran uncontained.
      await expectWriteDenied(session, escapeTarget);

      // Skill shell markers spawn through the same provider.
      const provider = createSandboxProvider();
      try {
        const temp = tempDir('cortex-mxc-skill-tmp-');
        await provider.initialize(buildDefaultPolicy('workspace', { workspaceRoots: [workspace], home: HOME, sessionTmpDir: temp }));
        const markerTarget = join(HOME, `${TAG}-skill-escape.txt`);
        await executeShellCommand(`Set-Content -LiteralPath ${q(markerTarget)} -Value escape`, workspace, provider);
        const markerEscaped = existsSync(markerTarget);
        if (markerEscaped) rmSync(markerTarget, { force: true });
        expect(markerEscaped).toBe(false);
        expect(await executeShellCommand('Write-Output skill-ok', workspace, provider)).toContain('skill-ok');
      } finally {
        await provider.dispose();
      }
    }, 300_000);

    it('14. per-command cost (recorded) on this architecture', async () => {
      const uncontained = createBashTool({ cwdTracker: new CwdTracker(workspace) });
      const time = async (run: () => Promise<unknown>) => {
        const samples: number[] = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          await run();
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        return samples[2]!;
      };
      const contained = await time(() => bash(session, 'Write-Output hi'));
      const plain = await time(() => uncontained.execute({ command: 'Write-Output hi' }));
      observe(`echo hi, median of 5 on ${process.arch}`, `contained ${contained.toFixed(0)} ms, uncontained ${plain.toFixed(0)} ms, launcher overhead ${(contained - plain).toFixed(0)} ms`);
      expect(contained).toBeGreaterThan(0);
    }, 180_000);
  });

  it('13. failure handling: a missing SDK fails the next command closed; an SDK inside the workspace is partial', async () => {
    const sdk = resolveMxcSdk();
    expect(sdk).toBeDefined();
    const workspace = makeRepo(join(root, 'ws-failure'));
    const session = await openSession(workspace);
    expect((await bash(session, 'Write-Output before')).exitCode).toBe(0);
    const moved = `${sdk!.packageRoot}.${TAG}`;
    renameSync(sdk!.packageRoot, moved);
    try {
      const marker = join(workspace, 'should-not-exist.txt');
      const run = await bash(session, `Set-Content -LiteralPath ${q(marker)} -Value ran`);
      expect(run.exitCode).toBe(LAUNCHER_FAILURE_EXIT);
      expect(run.stderr).toContain(LAUNCHER_ERROR_PREFIX);
      expect(existsSync(marker)).toBe(false);
    } finally {
      renameSync(moved, sdk!.packageRoot);
    }

    // The repository holds node_modules\@microsoft\mxc-sdk, so as a workspace it exposes the SDK.
    const repoRoot = join(sdk!.packageRoot, '..', '..', '..');
    const exposed = await openSession(repoRoot, { sandbox: { requireEnforcement: false } });
    const status = exposed.agent.getSandboxState()!.status;
    expect(status.filesystem).toBe('partial');
    expect(status.degradations.join('\n')).toMatch(/Node module resolution/);
  }, 180_000);
});
