import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMxcSdk } from '../../../src/sandbox/backends/mxc-host.js';

// Install layouts built from plain files. Each case points resolution at a fake
// Cortex module inside the layout, the way the published package resolves from
// its own dist directory.

/** The alias the release staging gives the Windows variant (tools/release/cortex-packages.mjs). */
const PLATFORM_PACKAGE = '@animus-labs/cortex-win32';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-mxc-host-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

/** A package directory holding the SDK's real exports shape. */
function fakeSdk(dir: string, version = '1.0.0'): string {
  mkdirSync(join(dir, 'dist', 'v1'), { recursive: true });
  writeJson(join(dir, 'package.json'), {
    name: '@microsoft/mxc-sdk',
    version,
    type: 'module',
    exports: {
      './v1': { import: './dist/v1/index.js', default: './dist/v1/index.js' },
      './package.json': './package.json',
    },
  });
  writeFileSync(join(dir, 'dist', 'v1', 'index.js'), 'export {};\n');
  return dir;
}

/** The package.json-only Windows variant, installed under its alias directory. */
function fakePlatformPackage(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'package.json'), {
    name: '@animus-labs/cortex',
    version: '1.0.0-win32',
    os: ['win32'],
    dependencies: { '@microsoft/mxc-sdk': '1.0.0' },
  });
  return dir;
}

/** A Cortex package directory; returns the module location resolution starts from. */
function fakeCortex(dir: string): string {
  const backends = join(dir, 'dist', 'sandbox', 'backends');
  mkdirSync(backends, { recursive: true });
  writeJson(join(dir, 'package.json'), { name: '@animus-labs/cortex', version: '1.0.0', type: 'module' });
  const from = join(backends, 'mxc-host.js');
  writeFileSync(from, 'export {};\n');
  return from;
}

function expectSdkAt(found: ReturnType<typeof resolveMxcSdk>, packageRoot: string): void {
  expect(found).toBeDefined();
  expect(found!.packageRoot).toBe(realpathSync(packageRoot));
  expect(fileURLToPath(found!.entry)).toBe(join(realpathSync(packageRoot), 'dist', 'v1', 'index.js'));
}

describe('resolveMxcSdk', () => {
  it('finds a hoisted SDK through ordinary resolution from Cortex', () => {
    const modules = join(root, 'node_modules');
    const from = fakeCortex(join(modules, '@animus-labs', 'cortex'));
    fakePlatformPackage(join(modules, PLATFORM_PACKAGE));
    const sdk = fakeSdk(join(modules, '@microsoft', 'mxc-sdk'));
    expectSdkAt(resolveMxcSdk(from), sdk);
  });

  it('finds the SDK through the platform package when the layout keeps it nested (npm --install-strategy=nested)', () => {
    const cortex = join(root, 'node_modules', '@animus-labs', 'cortex');
    const from = fakeCortex(cortex);
    const platform = fakePlatformPackage(join(cortex, 'node_modules', PLATFORM_PACKAGE));
    const sdk = fakeSdk(join(platform, 'node_modules', '@microsoft', 'mxc-sdk'));
    expectSdkAt(resolveMxcSdk(from), sdk);
  });

  it('follows the platform package link in an isolated store layout (npm linked strategy, pnpm)', () => {
    const store = join(root, 'node_modules', '.store');
    const cortexModules = join(store, 'cortex@1.0.0', 'node_modules');
    const variantModules = join(store, 'cortex@1.0.0-win32', 'node_modules');
    const from = fakeCortex(join(cortexModules, '@animus-labs', 'cortex'));
    const variant = fakePlatformPackage(join(variantModules, '@animus-labs', 'cortex'));
    const sdk = fakeSdk(join(store, 'mxc-sdk@1.0.0', 'node_modules', '@microsoft', 'mxc-sdk'));
    mkdirSync(join(variantModules, '@microsoft'), { recursive: true });
    // Junctions need no privilege on Windows; the type is ignored elsewhere.
    symlinkSync(sdk, join(variantModules, '@microsoft', 'mxc-sdk'), 'junction');
    symlinkSync(variant, join(cortexModules, PLATFORM_PACKAGE), 'junction');
    expectSdkAt(resolveMxcSdk(from), sdk);
  });

  it('prefers an SDK the consumer installed over the pinned one under the platform package', () => {
    const modules = join(root, 'node_modules');
    const from = fakeCortex(join(modules, '@animus-labs', 'cortex'));
    const consumers = fakeSdk(join(modules, '@microsoft', 'mxc-sdk'), '1.1.0');
    const platform = fakePlatformPackage(join(modules, PLATFORM_PACKAGE));
    fakeSdk(join(platform, 'node_modules', '@microsoft', 'mxc-sdk'));
    expectSdkAt(resolveMxcSdk(from), consumers);
  });

  it('reports nothing when neither Cortex nor the platform package can reach the SDK', () => {
    const modules = join(root, 'node_modules');
    const from = fakeCortex(join(modules, '@animus-labs', 'cortex'));
    expect(resolveMxcSdk(from)).toBeUndefined();
    // The platform package without its dependency (an interrupted install).
    fakePlatformPackage(join(modules, PLATFORM_PACKAGE));
    expect(resolveMxcSdk(from)).toBeUndefined();
  });
});
