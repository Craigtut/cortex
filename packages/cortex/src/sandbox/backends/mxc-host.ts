/**
 * Real host interactions for MxcSandboxProvider: locating the SDK, copying
 * the launcher to a private directory, snapshotting the read set, running the
 * launcher's probe, and the host-side domain proxy. Kept apart from the
 * provider so the provider's rules are testable with fakes on any platform.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProbeReport } from './mxc-launcher.js';
import type { MxcReadSet } from './mxc-request.js';
import type { MxcDomainProxy, MxcProviderDeps } from './mxc.js';

export function defaultMxcHostDeps(): MxcProviderDeps {
  return {
    platform: process.platform,
    nodePath: process.execPath,
    resolveSdk: resolveMxcSdk,
    prepareLauncher,
    removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    gatherReadSet,
    exists: (path) => existsSync(path),
    runProbe: runLauncherProbe,
    startProxy: startMxcDomainProxy,
  };
}

/** Locate `@microsoft/mxc-sdk/v1` from Cortex's own location, without loading it. */
export function resolveMxcSdk(): { entry: string; packageRoot: string } | undefined {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@microsoft/mxc-sdk/v1');
    const packageRoot = dirname(require.resolve('@microsoft/mxc-sdk/package.json'));
    return { entry: pathToFileURL(entry).href, packageRoot };
  } catch {
    return undefined;
  }
}

function launcherSource(): string {
  const local = fileURLToPath(new URL('./mxc-launcher.js', import.meta.url));
  if (existsSync(local)) return local;
  // Source-mode development uses the built artifact, like the POSIX worker.
  const built = fileURLToPath(new URL('../../../dist/sandbox/backends/mxc-launcher.js', import.meta.url));
  if (existsSync(built)) return built;
  throw new Error('Build Cortex before using the MXC sandbox (mxc-launcher.js not found)');
}

/**
 * Copy the self-contained launcher into a fresh directory under the host temp
 * root. The session temp is a sibling, never a parent, so no contained command
 * can write the copy. `.mjs` keeps it ESM without a package.json.
 */
function prepareLauncher(): { dir: string; path: string } {
  const source = launcherSource();
  const dir = mkdtempSync(join(tmpdir(), 'cortex-mxc-'));
  const path = join(dir, 'mxc-launcher.mjs');
  copyFileSync(source, path);
  return { dir, path };
}

/**
 * Snapshot the read set, as Codex does: each logical volume root plus its
 * immediate children (MXC volume-root grants do not recurse), and the Windows
 * platform directories. Entries that cannot be opened (System Volume
 * Information, pagefile.sys) are skipped: MXC fails closed on paths it cannot
 * resolve. Absent and unready drives are skipped.
 */
async function gatherReadSet(): Promise<MxcReadSet> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const perVolume = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        return [];
      }
      const children = await Promise.all(
        names.map(async (name) => {
          const child = root + name;
          try {
            await stat(child);
            return child;
          } catch {
            return undefined;
          }
        }),
      );
      return [root, ...children.filter((c): c is string => c !== undefined)];
    }),
  );
  const env = process.env;
  const platformRoots = [env['SystemRoot'] ?? env['windir'], env['ProgramFiles'], env['ProgramFiles(x86)'], env['ProgramData']]
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .filter((p) => {
      try { statSync(p); return true; } catch { return false; }
    });
  return { volumeEntries: perVolume.flat(), platformRoots };
}

function runLauncherProbe(nodePath: string, launcherPath: string, env: Record<string, string>): Promise<ProbeReport> {
  return new Promise((resolve) => {
    execFile(
      nodePath,
      [launcherPath, '--probe'],
      // Generous: the first load of the SDK's native libraries can be slow under real-time scanning.
      { env, timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const line = stdout.trim().split(/\r?\n/).pop() ?? '';
        try {
          const report = JSON.parse(line) as ProbeReport;
          if (typeof report.ok === 'boolean') {
            resolve(report);
            return;
          }
        } catch {
          // Fall through to the failure report.
        }
        const detail = stderr.trim() || error?.message || 'no output';
        resolve({ ok: false, reason: `the MXC launcher probe did not report (${detail})` });
      },
    );
  });
}

/**
 * Start the host-side domain proxy: the pinned sandbox-runtime's HTTP proxy
 * server (CONNECT and absolute-URI forwarding), deep-imported because the
 * runtime does not export it. The parity tests fail loudly if a version bump
 * moves it. Listens on IPv4 loopback only; the container reaches it through
 * MXC's host-loopback allowance.
 */
export async function startMxcDomainProxy(decide: (host: string, port: number) => Promise<boolean>): Promise<MxcDomainProxy> {
  const { createHttpProxyServer } = await import('@anthropic-ai/sandbox-runtime/dist/sandbox/http-proxy.js');
  const server = createHttpProxyServer({ filter: (port, host) => decide(host, port) });
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('the proxy did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
