/**
 * Pure translation from a Cortex SandboxPolicy to an MXC (Microsoft eXecution
 * Containers) ContainerRequest for the Windows BaseContainer backend, plus the
 * Windows command-line quoting the request needs. No fs, no platform checks:
 * the provider gathers host facts and passes them in, so every rule here is
 * unit-testable on any OS.
 *
 * The request shapes mirror the subset of `@microsoft/mxc-sdk/v1` that Cortex
 * uses. The SDK is a Windows-only optional dependency that only the launcher
 * process loads, so its types are restated structurally instead of imported.
 *
 * See docs/cortex/sandboxing.md ("Windows backend: MXC BaseContainer").
 */
import { matchesAnyDomainPattern } from '../policy.js';
import type { SandboxNetworkPolicy, SandboxPolicy } from '../types.js';

export type MxcNetworkAction = 'allow' | 'deny';

export interface MxcNetworkRule {
  to?: Array<{ cidr: string }>;
}

export interface MxcNetworkPolicy {
  egress: { default: MxcNetworkAction; allow?: MxcNetworkRule[] };
  ingress: { default: MxcNetworkAction; hostLoopback: MxcNetworkAction };
}

export interface MxcFilesystemPolicy {
  readwritePaths: string[];
  readonlyPaths: string[];
  deniedPaths: string[];
}

/** The `ContainerRequest` Cortex sends, minus the per-launch working directory and environment. */
export interface MxcContainerRequest {
  command: string;
  filesystem: MxcFilesystemPolicy;
  network: MxcNetworkPolicy;
  ui: { disable: boolean; clipboard: 'none'; allowInputInjection: boolean };
  containment: {
    type: 'processcontainer';
    config: {
      ui: { isolation: 'desktop'; desktopSystemControl: boolean; systemSettings: string; ime: boolean };
    };
  };
}

/** Optional native capabilities a request depends on (MXC `BackendCapability` names). */
export type MxcRequiredCapability = 'filesystemDeniedPaths' | 'ingressHostLoopbackAllow';

/** Host facts the provider gathers once per policy (the read set is a snapshot). */
export interface MxcReadSet {
  /** Every reachable volume root plus each root's immediate children (root grants do not recurse). */
  volumeEntries: string[];
  /** The Windows directory, Program Files, Program Files (x86), and ProgramData. */
  platformRoots: string[];
}

export interface MxcRequestInputs {
  policy: SandboxPolicy;
  readSet: MxcReadSet;
  /**
   * The `denyRead` entries that exist right now. Deny paths are a per-command
   * snapshot, as in Codex: a secret created later is denied from the next command.
   */
  existingDenyRead: string[];
  /** Host-side code the launcher executes (the SDK, node.exe's directory). Carved out read-only. */
  hostCodePaths: string[];
}

export interface MxcRequestBase {
  request: Omit<MxcContainerRequest, 'command'>;
  requiredCapabilities: MxcRequiredCapability[];
  /** True when shell egress must go through the host-side domain proxy. */
  usesProxy: boolean;
  /** Human-readable notes about policy the request enforces more strictly than asked. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Windows paths
// ---------------------------------------------------------------------------

/** One separator style, no trailing separator (except a bare drive root), case-folded. */
export function normalizeWindowsPath(path: string): string {
  const slashed = path.replace(/\//g, '\\');
  const trimmed = /^[A-Za-z]:\\$/.test(slashed) ? slashed : slashed.replace(/\\+$/, '');
  return trimmed.toLowerCase();
}

/** True when `child` equals `parent` or lies inside it. */
export function isWindowsPathWithin(child: string, parent: string): boolean {
  const c = normalizeWindowsPath(child);
  const p = normalizeWindowsPath(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith('\\') ? p : p + '\\');
}

function isWithinAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWindowsPathWithin(path, root));
}

/** De-duplicate case-insensitively, keeping the first spelling. */
function uniquePaths(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    const key = normalizeWindowsPath(path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * Quote one argument exactly as libuv does for `child_process.spawn` on
 * Windows (`quote_cmd_arg`), so a command reaches the program inside the
 * container byte-for-byte as it would without the sandbox. The rules follow
 * CommandLineToArgvW: backslashes are literal unless they precede a quote, in
 * which case they double, and each embedded quote is backslash-escaped.
 */
export function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  // Build reversed, as libuv does, then flip: a backslash run doubles only
  // when it ends at a quote (or at the closing quote we add).
  const reversed: string[] = [];
  let quoteHit = true;
  for (let i = arg.length - 1; i >= 0; i--) {
    const ch = arg[i]!;
    reversed.push(ch);
    if (quoteHit && ch === '\\') {
      reversed.push('\\');
    } else if (ch === '"') {
      quoteHit = true;
      reversed.push('\\');
    } else {
      quoteHit = false;
    }
  }
  return `"${reversed.reverse().join('')}"`;
}

/** Compose a Windows command line from an argv, quoting each token like Node's spawn. */
export function windowsCommandLine(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('Cannot build a command line from an empty argv');
  return argv.map(quoteWindowsArg).join(' ');
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/**
 * Map Cortex's "read everything except secrets, write the workspace" policy
 * onto MXC's allowlists:
 *   - readwrite: the writable roots, minus any root inside a denied path;
 *   - denied: the secrets that exist now (enforced natively by PSEC FS_DENY);
 *   - readonly: the volume snapshot and platform roots (the read set), plus
 *     read-only carve-outs inside writable roots for `denyWrite` entries and
 *     host-side code. Carve-outs are kept even when the path does not exist yet,
 *     so the command cannot create it either.
 * Write and read lists are pruned of exact duplicates of a stricter list, the
 * same precedence MXC applies (deny > readonly > readwrite).
 */
export function buildMxcFilesystem(inputs: MxcRequestInputs): MxcFilesystemPolicy {
  const fs = inputs.policy.filesystem;
  const deniedPaths = uniquePaths(inputs.existingDenyRead);
  const readwritePaths = uniquePaths(fs.writableRoots).filter((root) => !isWithinAny(root, deniedPaths));
  const carveOuts = uniquePaths([...fs.denyWrite, ...inputs.hostCodePaths]).filter(
    (path) => isWithinAny(path, readwritePaths) && !isWithinAny(path, deniedPaths),
  );
  const carveOutKeys = new Set(carveOuts.map(normalizeWindowsPath));
  const writeKeys = new Set(
    readwritePaths.filter((p) => !carveOutKeys.has(normalizeWindowsPath(p))).map(normalizeWindowsPath),
  );
  const denyKeys = new Set(deniedPaths.map(normalizeWindowsPath));
  const readSet = uniquePaths([
    ...inputs.readSet.volumeEntries,
    ...inputs.readSet.platformRoots,
    ...(fs.allowRead ?? []),
  ]).filter((path) => {
    const key = normalizeWindowsPath(path);
    return !writeKeys.has(key) && !denyKeys.has(key);
  });
  return {
    readwritePaths: readwritePaths.filter((p) => writeKeys.has(normalizeWindowsPath(p))),
    readonlyPaths: uniquePaths([...readSet, ...carveOuts]),
    deniedPaths,
  };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** IPv4 and IPv6 loopback on every port: the only direct egress a proxied container gets. */
export const MXC_LOOPBACK_RULE: MxcNetworkRule = { to: [{ cidr: '127.0.0.0/8' }, { cidr: '::1/128' }] };

/**
 * Codex's network shape. Direct non-loopback egress is always denied by
 * per-container WFP. Allowlist and full modes route HTTP(S) through the
 * host-side domain proxy, which the container reaches over host loopback, so
 * they need `hostLoopback: allow` (bidirectional in PSEC, and covering every
 * loopback port). Deny mode keeps loopback only when the policy allows local
 * binding.
 */
export function buildMxcNetwork(net: SandboxNetworkPolicy): {
  network: MxcNetworkPolicy;
  usesProxy: boolean;
  notes: string[];
} {
  const loopback = net.allowLocalBinding !== false;
  const network: MxcNetworkPolicy = loopback
    ? { egress: { default: 'deny', allow: [MXC_LOOPBACK_RULE] }, ingress: { default: 'deny', hostLoopback: 'allow' } }
    : { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } };
  if (net.mode === 'deny') return { network, usesProxy: false, notes: [] };
  if (!loopback) {
    return {
      network,
      usesProxy: false,
      notes: [
        'Network egress is fully blocked: the policy disallows local binding, and under MXC the ' +
          'domain proxy is only reachable over host loopback, so allowed domains are unreachable too.',
      ],
    };
  }
  return { network, usesProxy: true, notes: [] };
}

/**
 * The host-side proxy's decision for one destination, matching the macOS and
 * Linux runtime: explicit denials first, then the mode, then the allowlist.
 * `ask` defers to the session's network resolver.
 */
export function decideProxyRequest(net: SandboxNetworkPolicy, host: string): 'allow' | 'deny' | 'ask' {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (matchesAnyDomainPattern(h, net.deniedDomains)) return 'deny';
  if (net.mode === 'deny') return 'deny';
  if (net.mode === 'full') return 'allow';
  if (matchesAnyDomainPattern(h, net.allowedDomains.filter((p) => p !== '*'))) return 'allow';
  return 'ask';
}

// ---------------------------------------------------------------------------
// Request and environment
// ---------------------------------------------------------------------------

/** UI restrictions. PowerShell needs Win32k and desktop handles at startup (Codex's finding). */
const UI: MxcContainerRequest['ui'] = { disable: false, clipboard: 'none', allowInputInjection: false };
const CONTAINMENT: MxcContainerRequest['containment'] = {
  type: 'processcontainer',
  config: { ui: { isolation: 'desktop', desktopSystemControl: false, systemSettings: 'none', ime: false } },
};

/** Everything in the request except the command line, plus the native capabilities it needs. */
export function buildMxcRequestBase(inputs: MxcRequestInputs): MxcRequestBase {
  const filesystem = buildMxcFilesystem(inputs);
  const { network, usesProxy, notes } = buildMxcNetwork(inputs.policy.network);
  const requiredCapabilities: MxcRequiredCapability[] = [];
  if (filesystem.deniedPaths.length > 0) requiredCapabilities.push('filesystemDeniedPaths');
  if (network.ingress.hostLoopback === 'allow') requiredCapabilities.push('ingressHostLoopbackAllow');
  return {
    request: { filesystem, network, ui: UI, containment: CONTAINMENT },
    requiredCapabilities,
    usesProxy,
    notes,
  };
}

/** Set a Windows environment variable, replacing any differently-cased spelling of the name. */
export function setWindowsEnv(env: Record<string, string>, name: string, value: string): void {
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) delete env[key];
  }
  env[name] = value;
}

/** Remove names case-insensitively (Windows environment semantics). */
export function deleteWindowsEnv(env: Record<string, string>, names: readonly string[]): void {
  const upper = new Set(names.map((n) => n.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (upper.has(key.toUpperCase())) delete env[key];
  }
}

/**
 * Proxy variables for the contained command. Windows names are
 * case-insensitive, so only one spelling of each is set. Loopback bypasses the
 * proxy: the container reaches it directly.
 */
export function proxyEnvironment(proxyUrl: string): Record<string, string> {
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    NODE_USE_ENV_PROXY: '1',
    NPM_CONFIG_PROXY: proxyUrl,
    NPM_CONFIG_HTTPS_PROXY: proxyUrl,
    YARN_HTTP_PROXY: proxyUrl,
    YARN_HTTPS_PROXY: proxyUrl,
    PIP_PROXY: proxyUrl,
  };
}
