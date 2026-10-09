#!/usr/bin/env node
/**
 * Stage the two tarballs a Cortex release publishes, in publish order:
 *
 *   <out>/animus-labs-cortex-<version>-win32.tgz   Windows variant (--tag win32)
 *   <out>/animus-labs-cortex-<version>.tgz         main package, alias injected
 *
 * The main tarball holds exactly the files `npm pack` selects for
 * packages/cortex; only its package.json differs. See cortex-packages.mjs for
 * the shapes and why the alias is injected here.
 *
 * Usage:
 *   node tools/release/stage-cortex.mjs --out <dir>
 *   node tools/release/stage-cortex.mjs --check     stage into a temp dir, print, remove
 *
 * Build Cortex first (npm run build -w packages/cortex).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MXC_SDK, WIN32_DIST_TAG, stagedMainManifest, win32VariantManifest } from './cortex-packages.mjs';
import { npmJson } from './npm.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cortexDir = join(repoRoot, 'packages', 'cortex');

/** Pack `dir` without lifecycle scripts; returns the tarball path and its file list. */
function pack(dir, out) {
  const [result] = npmJson(['pack', dir, '--pack-destination', out, '--ignore-scripts']);
  return { tarball: join(out, result.filename), files: result.files.map((f) => f.path).sort() };
}

/**
 * @param {{ out: string }} options
 * @returns {Promise<{ version: string, alias: string, sdk: typeof MXC_SDK, variant: string, main: string, files: string[] }>}
 */
export async function stageCortex({ out }) {
  const hostModule = join(cortexDir, 'dist', 'sandbox', 'backends', 'mxc-host.js');
  if (!existsSync(join(cortexDir, 'dist', 'index.js')) || !existsSync(hostModule)) {
    throw new Error('Build Cortex before staging (npm run build -w packages/cortex)');
  }
  // The alias directory name is owned by the code that resolves through it.
  const { MXC_SDK_PLATFORM_PACKAGE: alias } = await import(pathToFileURL(hostModule).href);
  if (typeof alias !== 'string') throw new Error(`${hostModule} does not export MXC_SDK_PLATFORM_PACKAGE`);

  const main = JSON.parse(readFileSync(join(cortexDir, 'package.json'), 'utf8'));
  const [selection] = npmJson(['pack', '--dry-run', '--ignore-scripts'], { cwd: cortexDir });
  const files = selection.files.map((f) => f.path).sort();

  mkdirSync(out, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), 'cortex-stage-'));
  try {
    const variantDir = join(staging, 'win32');
    mkdirSync(variantDir);
    writeFileSync(join(variantDir, 'package.json'), `${JSON.stringify(win32VariantManifest(main), null, 2)}\n`);
    const variant = pack(variantDir, out);
    if (variant.files.join() !== 'package.json') {
      throw new Error(`the Windows variant must hold only package.json, got ${variant.files.join(', ')}`);
    }

    const mainDir = join(staging, 'main');
    for (const file of files) {
      mkdirSync(dirname(join(mainDir, file)), { recursive: true });
      copyFileSync(join(cortexDir, file), join(mainDir, file));
    }
    writeFileSync(join(mainDir, 'package.json'), `${JSON.stringify(stagedMainManifest(main, alias), null, 2)}\n`);
    const staged = pack(mainDir, out);
    if (staged.files.join('\n') !== files.join('\n')) {
      throw new Error('the staged main tarball does not hold the files npm pack selects for packages/cortex');
    }
    return { version: main.version, alias, sdk: MXC_SDK, variant: variant.tarball, main: staged.tarball, files };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = { out: undefined, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--check') args.check = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.check && !args.out) throw new Error('pass --out <dir> or --check');
  return args;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseArgs(process.argv.slice(2));
  const out = args.check ? mkdtempSync(join(tmpdir(), 'cortex-stage-check-')) : resolve(args.out);
  try {
    const staged = await stageCortex({ out });
    console.log(`Staged ${staged.files.length} files of @animus-labs/cortex ${staged.version}:`);
    console.log(`  1. ${staged.variant}  (publish with --tag ${WIN32_DIST_TAG})`);
    console.log(`  2. ${staged.main}  (optionalDependencies["${staged.alias}"])`);
    console.log(`  Windows variant depends on ${staged.sdk.name}@${staged.sdk.version}`);
  } finally {
    if (args.check) rmSync(out, { recursive: true, force: true });
  }
}
