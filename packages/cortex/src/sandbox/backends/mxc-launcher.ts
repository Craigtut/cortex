/**
 * MXC launcher: runs ONE command inside an MXC BaseContainer on behalf of
 * MxcSandboxProvider, or (with --probe) reports whether this host can.
 *
 * The provider returns `{ file: node.exe, args: [<launcher>, '--run'] }` from
 * wrapSpawn/wrapExec, so Bash, Grep, skill markers, and stdio MCP keep their
 * ordinary `{file, args, env}` spawn while MXC's SDK, which owns process
 * creation, runs here. The container request travels in launcher-only
 * environment chunks (Codex's transport), which are removed before the
 * contained command starts; the rest of the environment is the command's.
 *
 * The launcher runs on the HOST, outside the container, so it is
 * deliberately self-contained: it imports only Node builtins, and loads the
 * SDK from the absolute location the provider resolved. The provider runs a
 * private copy of this file from a directory no contained command can write.
 * Do not add imports of sibling modules; a test enforces this.
 *
 * Fail closed: if the tier gate or the spawn fails, the launcher prints
 * `cortex-mxc-launcher: <reason>` and exits 125 without running the command.
 */
import { finished } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';

export const LAUNCHER_ENV_PREFIX = 'CORTEX_MXC_REQUEST_';
export const LAUNCHER_ENV_COUNT = 'CORTEX_MXC_REQUEST_COUNT';
export const LAUNCHER_FAILURE_EXIT = 125;
export const LAUNCHER_ERROR_PREFIX = 'cortex-mxc-launcher:';
export const LAUNCHER_PAYLOAD_VERSION = 1;
/** Chunk and payload bounds, as in Codex's transport. Each chunk stays far below the 32,767-character variable limit. */
const CHUNK_SIZE = 4096;
const MAX_PAYLOAD = 1_000_000;

export interface LauncherPayload {
  version: typeof LAUNCHER_PAYLOAD_VERSION;
  /** file: URL of `@microsoft/mxc-sdk/v1`, resolved by the provider. */
  sdkEntry: string;
  /** The ContainerRequest without workingDirectory/environment (the launcher adds those). */
  request: Record<string, unknown> & { command: string };
  /** Native capabilities the request depends on (e.g. filesystemDeniedPaths). */
  requiredCapabilities: string[];
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Encode the payload as launcher-only environment variables. */
export function encodeLauncherPayload(payload: LauncherPayload): Record<string, string> {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  if (encoded.length > MAX_PAYLOAD) {
    throw new Error(`MXC launcher request is too large (${encoded.length} bytes encoded)`);
  }
  const env: Record<string, string> = {};
  let count = 0;
  for (let offset = 0; offset < encoded.length; offset += CHUNK_SIZE) {
    env[`${LAUNCHER_ENV_PREFIX}${count}`] = encoded.slice(offset, offset + CHUNK_SIZE);
    count++;
  }
  env[LAUNCHER_ENV_COUNT] = String(count);
  return env;
}

function isTransportKey(key: string): boolean {
  return key.toUpperCase().startsWith(LAUNCHER_ENV_PREFIX);
}

/**
 * Decode the payload and return the command's own environment with every
 * transport variable removed. Throws on a missing, truncated, or malformed
 * payload; the message never echoes payload contents.
 */
export function decodeLauncherPayload(env: Record<string, string | undefined>): {
  payload: LauncherPayload;
  childEnv: Record<string, string>;
} {
  const lookup = new Map<string, string>();
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isTransportKey(key)) lookup.set(key.toUpperCase(), value);
    else childEnv[key] = value;
  }
  const count = Number(lookup.get(LAUNCHER_ENV_COUNT));
  if (!Number.isInteger(count) || count < 1) throw new Error('invalid MXC launcher request');
  let encoded = '';
  for (let i = 0; i < count; i++) {
    const chunk = lookup.get(`${LAUNCHER_ENV_PREFIX}${i}`);
    if (chunk === undefined) throw new Error('invalid MXC launcher request');
    encoded += chunk;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    throw new Error('invalid MXC launcher request');
  }
  const p = parsed as Partial<LauncherPayload> | null;
  if (
    !p ||
    p.version !== LAUNCHER_PAYLOAD_VERSION ||
    typeof p.sdkEntry !== 'string' ||
    !p.sdkEntry.startsWith('file:') ||
    !p.request ||
    typeof p.request !== 'object' ||
    typeof p.request.command !== 'string' ||
    p.request.command.length === 0 ||
    !Array.isArray(p.requiredCapabilities) ||
    !p.requiredCapabilities.every((c) => typeof c === 'string')
  ) {
    throw new Error('invalid MXC launcher request');
  }
  return { payload: p as LauncherPayload, childEnv };
}

// ---------------------------------------------------------------------------
// The SDK surface the launcher uses (structural; the SDK is an optional peer)
// ---------------------------------------------------------------------------

export interface MxcAvailableBackend {
  backend: string;
  tier?: string;
  capabilities: string[];
  warnings: string[];
}

export interface MxcProbeOutput {
  tier?: string;
  needsDaclAugmentation?: boolean;
  warnings: string[];
  error?: string;
}

export interface MxcProcessLike {
  readonly standardInput: Writable | null;
  readonly standardOutput: Readable | null;
  readonly standardError: Readable | null;
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  kill(): void;
  dispose(): void;
}

export interface MxcSdkLike {
  getAvailableBackends(): MxcAvailableBackend[];
  probe(request: Record<string, unknown>): MxcProbeOutput;
  spawn(request: Record<string, unknown>): Promise<MxcProcessLike>;
}

function asSdk(module: unknown): MxcSdkLike {
  const m = module as Partial<MxcSdkLike> | null;
  if (!m || typeof m.getAvailableBackends !== 'function' || typeof m.probe !== 'function' || typeof m.spawn !== 'function') {
    throw new Error('the installed @microsoft/mxc-sdk does not export the v1 getAvailableBackends/probe/spawn API');
  }
  return m as MxcSdkLike;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * On Windows, MXC's native stdio transfer needs Node 24.21+ within 24.x, or
 * 26.8+. Returns the reason when this Node cannot run contained commands.
 */
export function unsupportedNodeReason(version: string): string | null {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  const ok = (major === 24 && minor >= 21) || (major === 26 && minor >= 8) || major > 26;
  return ok ? null : `Node ${version} cannot transfer stdio into MXC containers (needs 24.21+ or 26.8+)`;
}

export interface GateResult {
  tier: string;
  capabilities: string[];
  warnings: string[];
}

/**
 * Accept only the BaseContainer tier, enforced by the OS through PSEC. The
 * AppContainer tiers (and any DACL augmentation, which edits host ACLs) are
 * refused, never used as a fallback. Throws with the reason.
 */
export function gateBaseContainer(sdk: MxcSdkLike, payload: LauncherPayload): GateResult {
  const backends = sdk.getAvailableBackends();
  const processContainers = backends.filter((b) => b.backend === 'processcontainer');
  const base = processContainers.find((b) => b.tier === 'base-container');
  if (!base) {
    const seen = processContainers.map((b) => b.tier ?? 'unknown').join(', ') || 'none';
    const warnings = processContainers.flatMap((b) => b.warnings);
    throw new Error(
      `MXC BaseContainer is not available on this host (processcontainer tiers: ${seen}). It needs ` +
        `Windows 11 24H2/25H2 with the August 2026 update (KB5120998) or 26H1/26H2, with the ` +
        `process security environment enabled` + (warnings.length ? `; MXC reported: ${warnings.join('; ')}` : ''),
    );
  }
  const missing = payload.requiredCapabilities.filter((c) => !base.capabilities.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `this Windows build's BaseContainer lacks ${missing.join(', ')}` +
        (base.warnings.length ? ` (${base.warnings.join('; ')})` : ''),
    );
  }
  const probe = sdk.probe(payload.request);
  if (probe.error) throw new Error(`MXC tier probe failed: ${probe.error}`);
  if (probe.tier !== 'base-container') {
    throw new Error(`MXC would run this request at tier ${probe.tier ?? 'unknown'}, not base-container`);
  }
  if (probe.needsDaclAugmentation) {
    throw new Error('MXC would augment host DACLs for this request; refusing');
  }
  return { tier: probe.tier, capabilities: base.capabilities, warnings: [...base.warnings, ...probe.warnings] };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface LauncherDeps {
  env: Record<string, string | undefined>;
  cwd: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  loadSdk: (entry: string) => Promise<unknown>;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

export interface ProbeReport {
  ok: boolean;
  reason?: string;
  tier?: string;
  capabilities?: string[];
  warnings?: string[];
}

/** Variables MXC requires in an explicit environment. */
const REQUIRED_ENV = ['SystemRoot', 'LOCALAPPDATA'];

function explicitEnvironment(childEnv: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(childEnv)) {
    // Drive-cwd entries ("=C:") and empty names are not valid variable names.
    if (key.length === 0 || key.includes('=') || key.includes('\0')) continue;
    environment[key] = value;
  }
  const present = new Set(Object.keys(environment).map((k) => k.toUpperCase()));
  const missing = REQUIRED_ENV.filter((name) => !present.has(name.toUpperCase()));
  if (missing.length > 0) {
    throw new Error(`the command environment lacks ${missing.join(' and ')}, which MXC requires`);
  }
  return environment;
}

function writeAndDrain(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve) => stream.write(text, () => resolve()));
}

async function prepare(deps: LauncherDeps): Promise<{ sdk: MxcSdkLike; payload: LauncherPayload; childEnv: Record<string, string>; gate: GateResult }> {
  const nodeReason = deps.platform === 'win32' ? unsupportedNodeReason(deps.nodeVersion) : null;
  if (nodeReason) throw new Error(nodeReason);
  const { payload, childEnv } = decodeLauncherPayload(deps.env);
  let module: unknown;
  try {
    module = await deps.loadSdk(payload.sdkEntry);
  } catch (error) {
    throw new Error(`could not load @microsoft/mxc-sdk: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sdk = asSdk(module);
  const gate = gateBaseContainer(sdk, payload);
  return { sdk, payload, childEnv, gate };
}

/** `--probe`: report availability as one JSON line. Always exits 0 once it can report. */
export async function runProbe(deps: LauncherDeps): Promise<number> {
  let report: ProbeReport;
  try {
    const { gate } = await prepare(deps);
    report = { ok: true, tier: gate.tier, capabilities: gate.capabilities, warnings: gate.warnings };
  } catch (error) {
    report = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  await writeAndDrain(deps.stdout, `${JSON.stringify(report)}\n`);
  return 0;
}

/** `--run`: run the command in a BaseContainer, relay stdio, return its exit code. */
export async function runContained(deps: LauncherDeps): Promise<number> {
  let proc: MxcProcessLike;
  try {
    const { sdk, payload, childEnv } = await prepare(deps);
    proc = await sdk.spawn({
      ...payload.request,
      workingDirectory: deps.cwd,
      environment: explicitEnvironment(childEnv),
      inheritDefaultEnvironment: false,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await writeAndDrain(deps.stderr, `${LAUNCHER_ERROR_PREFIX} ${reason}; the command did not run\n`);
    return LAUNCHER_FAILURE_EXIT;
  }

  // Take every stream before wait(): the SDK drains untaken streams itself.
  const input = proc.standardInput;
  const output = proc.standardOutput;
  const errorOutput = proc.standardError;
  if (input) {
    input.on('error', () => { /* The command may exit before reading all of stdin. */ });
    deps.stdin.pipe(input);
  }
  const relays: Promise<void>[] = [];
  for (const [source, target] of [[output, deps.stdout], [errorOutput, deps.stderr]] as const) {
    if (!source) continue;
    source.pipe(target, { end: false });
    relays.push(finished(source).catch(() => {}));
  }
  try {
    const result = await proc.wait();
    await Promise.all(relays);
    await Promise.all([writeAndDrain(deps.stdout, ''), writeAndDrain(deps.stderr, '')]);
    return result.exitCode;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await writeAndDrain(deps.stderr, `${LAUNCHER_ERROR_PREFIX} ${reason}\n`);
    return LAUNCHER_FAILURE_EXIT;
  } finally {
    if (input) deps.stdin.unpipe(input);
    try { proc.dispose(); } catch { /* Already released. */ }
  }
}

// Entry point. Runs only as a launcher: a mode flag AND the transport
// variables must both be present, so importing this module (the provider
// does, for encodeLauncherPayload) never starts anything.
const mode = process.argv[2];
if ((mode === '--run' || mode === '--probe') && process.env[LAUNCHER_ENV_COUNT] !== undefined) {
  const deps: LauncherDeps = {
    env: { ...process.env },
    cwd: process.cwd(),
    platform: process.platform,
    nodeVersion: process.version,
    loadSdk: (entry) => import(entry),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const kill = (): void => process.exit(LAUNCHER_FAILURE_EXIT);
  process.once('SIGINT', kill);
  process.once('SIGTERM', kill);
  const code = await (mode === '--probe' ? runProbe(deps) : runContained(deps));
  process.exit(code);
}
