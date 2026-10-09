#!/usr/bin/env node
/**
 * Ask this host whether Cortex can contain commands in an MXC BaseContainer,
 * and record the evidence the Windows runbook asks for: the Windows build,
 * Node, the SDK Cortex resolves, the SDK's own getAvailableBackends(), and the
 * status the real MxcSandboxProvider reports for a default workspace policy.
 *
 * Prints the report, appends it to $GITHUB_STEP_SUMMARY, and writes
 * `available=true|false` to $GITHUB_OUTPUT when those are set. MXC being
 * unavailable is a finding, not an error: the exit code is 0 either way, and
 * 1 only when no report could be produced.
 *
 * Usage: node tools/mxc/probe-report.mjs   (build Cortex first)
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(repoRoot, 'packages', 'cortex', 'dist');

function load(relative) {
  const path = join(dist, relative);
  if (!existsSync(path)) throw new Error(`Build Cortex first (npm run build -w packages/cortex): ${path} is missing`);
  return import(pathToFileURL(path).href);
}

/** `10.0.26200.9457 (25H2)` from the registry, or the kernel release elsewhere. */
function windowsBuild() {
  if (process.platform !== 'win32') return `${process.platform} ${release()}`;
  const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
  const read = (name) => {
    try {
      const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true });
      return out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`))?.[1]?.trim();
    } catch {
      return undefined;
    }
  };
  const ubr = read('UBR');
  const display = read('DisplayVersion');
  const product = read('ProductName');
  const revision = ubr?.startsWith('0x') ? String(Number.parseInt(ubr, 16)) : ubr;
  return `${release()}${revision ? `.${revision}` : ''}${display ? ` (${display})` : ''}${product ? `, ${product}` : ''}`;
}

/** The SDK's raw backend list, read in a child process so a native fault cannot take the report down. */
function availableBackends(entry) {
  const script = 'const sdk = await import(process.argv[1]); console.log(JSON.stringify(sdk.getAvailableBackends(), null, 2));';
  try {
    return execFileSync(process.execPath, ['--input-type=module', '-e', script, entry], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    }).trim();
  } catch (error) {
    return `getAvailableBackends() failed: ${(error.stderr || error.message || String(error)).trim()}`;
  }
}

async function main() {
  const { resolveMxcSdk } = await load('sandbox/backends/mxc-host.js');
  const { unsupportedNodeReason } = await load('sandbox/backends/mxc-launcher.js');
  const { MxcSandboxProvider, buildDefaultPolicy } = await load('index.js');

  const report = {
    windows: windowsBuild(),
    arch: process.arch,
    node: process.version,
    nodeSupported: unsupportedNodeReason(process.version) ?? 'yes',
    sdk: 'not resolved',
    backends: 'not read (no SDK)',
    status: undefined,
  };
  const sdk = resolveMxcSdk();
  if (sdk) {
    const version = JSON.parse(readFileSync(join(sdk.packageRoot, 'package.json'), 'utf8')).version;
    report.sdk = `@microsoft/mxc-sdk ${version} at ${sdk.packageRoot}`;
    if (process.platform === 'win32') report.backends = availableBackends(sdk.entry);
  }

  const root = mkdtempSync(join(tmpdir(), 'cortex-mxc-probe-'));
  const workspace = mkdtempSync(join(root, 'ws-'));
  const provider = new MxcSandboxProvider();
  try {
    report.status = await provider.initialize(
      buildDefaultPolicy('workspace', { workspaceRoots: [workspace], home: homedir(), sessionTmpDir: mkdtempSync(join(root, 'tmp-')) }),
    );
  } finally {
    await provider.dispose();
    rmSync(root, { recursive: true, force: true });
  }

  const { status } = report;
  const available = status.backend === 'mxc-base-container' && status.filesystem === 'enforced' && status.network === 'enforced';
  const verdict = available
    ? 'MXC BaseContainer is available: the real-host checklist runs.'
    : 'MXC BaseContainer is NOT available on this host. The real-host checklist did not run, so this run does not validate Windows containment.';
  const markdown = [
    `## MXC probe: ${available ? 'available' : 'NOT available'}`,
    '',
    verdict,
    '',
    '| | |',
    '| --- | --- |',
    `| OS | ${report.windows} |`,
    `| Architecture | ${report.arch} |`,
    `| Node | ${report.node} (MXC stdio transfer: ${report.nodeSupported}) |`,
    `| SDK | ${report.sdk} |`,
    `| Cortex status | backend \`${status.backend}\`, filesystem \`${status.filesystem}\`, network \`${status.network}\` |`,
    '',
    ...(status.degradations.length ? ['Degradations:', '', ...status.degradations.map((d) => `- ${d}`), ''] : []),
    '<details><summary>getAvailableBackends()</summary>',
    '',
    '```json',
    report.backends,
    '```',
    '',
    '</details>',
    '',
  ].join('\n');

  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `available=${available}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
