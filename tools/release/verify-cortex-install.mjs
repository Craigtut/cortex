#!/usr/bin/env node
/**
 * Prove the Windows variant mechanism end to end before anything is published.
 * Serve the staged tarballs from a throwaway local registry (verdaccio),
 * publish them the way the release does (variant first under --tag win32, then
 * the main package), install the main package into fresh projects, and check
 * what npm put where:
 *
 * - On Windows, the variant and @microsoft/mxc-sdk are installed, and the
 *   installed Cortex resolves the SDK: by ordinary resolution in a hoisted
 *   install, and through the platform package in npm's nested layout, where
 *   ordinary resolution cannot reach it.
 * - Elsewhere, neither is installed, while the lockfile keeps both entries so
 *   it stays valid for a Windows install.
 *
 * `--os win32` asks npm to treat this machine as Windows for platform checks
 * (install scripts are then skipped), which proves the npm half of the
 * mechanism without a Windows host. It cannot prove a real Windows install.
 *
 * Only @animus-labs packages come from the local registry; everything else
 * comes from the configured registry, so this needs network access.
 *
 * Usage:
 *   node tools/release/verify-cortex-install.mjs [--tarballs <dir>] [--os win32 [--cpu x64]] [--keep]
 *
 * Without --tarballs it stages first, which needs Cortex built.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MXC_SDK, WIN32_DIST_TAG, win32VariantVersion } from './cortex-packages.mjs';
import { npm, npmJson } from './npm.mjs';
import { stageCortex } from './stage-cortex.mjs';

/** Pinned local registry. Installed with scripts disabled into the throwaway directory. */
const VERDACCIO = 'verdaccio@6.10.4';
const CORTEX = '@animus-labs/cortex';

function parseArgs(argv) {
  const args = { tarballs: undefined, os: undefined, cpu: undefined, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--tarballs') args.tarballs = argv[++i];
    else if (flag === '--os') args.os = argv[++i];
    else if (flag === '--cpu') args.cpu = argv[++i];
    else if (flag === '--keep') args.keep = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return args;
}

/** Find the two staged tarballs and the version they carry. */
function findTarballs(dir) {
  const names = readdirSync(dir).filter((name) => name.endsWith('.tgz'));
  const variantName = names.find((name) => name.endsWith(`-${WIN32_DIST_TAG}.tgz`));
  const match = variantName?.match(/^animus-labs-cortex-(.+)-win32\.tgz$/);
  if (!match || names.length !== 2) throw new Error(`expected a Cortex tarball and its -win32 variant in ${dir}, found ${names.join(', ') || 'none'}`);
  const version = match[1];
  const mainName = `animus-labs-cortex-${version}.tgz`;
  if (!names.includes(mainName)) throw new Error(`expected ${mainName} next to ${variantName}`);
  return { version, variant: join(dir, variantName), main: join(dir, mainName) };
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function startRegistry(work) {
  const dir = join(work, 'registry');
  mkdirSync(dir);
  npm(['install', '--prefix', dir, VERDACCIO, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', '--no-package-lock']);
  const config = join(dir, 'config.yaml');
  writeFileSync(config, [
    'storage: ./storage',
    'auth:',
    '  htpasswd:',
    '    file: ./htpasswd',
    '    max_users: 10',
    'packages:',
    "  '**':",
    '    access: $all',
    '    publish: $authenticated',
    'log: { type: stdout, format: pretty, level: warn }',
    '',
  ].join('\n'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const bin = join(dir, 'node_modules', 'verdaccio', 'bin', 'verdaccio');
  const child = spawn(process.execPath, [bin, '--config', config, '--listen', `127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  /** Stop the registry and wait for it to exit, so its storage can be removed (Windows locks open files). */
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`verdaccio exited ${child.exitCode}\n${output}`);
      try {
        if ((await fetch(`${url}/-/ping`)).ok) break;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error(`verdaccio did not start\n${output}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    const user = `release-check-${process.pid}`;
    const response = await fetch(`${url}/-/user/org.couchdb.user:${user}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: user, password: `pw-${Date.now()}` }),
    });
    const { token } = await response.json();
    if (!token) throw new Error(`could not register a user with the local registry (${response.status})`);
    return { url, token, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A project whose @animus-labs scope (and nothing else) resolves to the local registry. */
function makeProject(dir, registry) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'cortex-install-check', version: '0.0.0', private: true }, null, 2)}\n`);
  writeFileSync(join(dir, '.npmrc'), `@animus-labs:registry=${registry.url}/\n//${new URL(registry.url).host}/:_authToken=${registry.token}\n`);
  return dir;
}

function readJsonIfExists(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const results = [];
/** Record one check; `test` returns true, or a string describing the failure. */
async function check(name, test) {
  let outcome;
  try {
    outcome = await test();
  } catch (error) {
    outcome = error instanceof Error ? error.message : String(error);
  }
  const ok = outcome === true;
  results.push({ name, ok, detail: ok ? '' : String(outcome) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n     ${String(outcome)}`}`);
}

async function importHost(cortexDir) {
  return import(pathToFileURL(join(cortexDir, 'dist', 'sandbox', 'backends', 'mxc-host.js')).href);
}

function writeSummary(heading, context) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const failed = results.filter((r) => !r.ok).length;
  const lines = [
    `## ${heading}`,
    '',
    `${context}. ${failed === 0 ? `All ${results.length} checks passed.` : `**${failed} of ${results.length} checks failed.**`}`,
    '',
    '| Check | Result |',
    '| --- | --- |',
    ...results.map((r) => `| ${r.name} | ${r.ok ? 'pass' : `FAIL: ${r.detail.replaceAll('|', '\\|').replaceAll('\n', ' ')}`} |`),
    '',
  ];
  appendFileSync(file, `${lines.join('\n')}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.os ?? process.platform;
  const simulated = args.os !== undefined && args.os !== process.platform;
  const windows = target === 'win32';
  const platformArgs = simulated ? ['--os', args.os, ...(args.cpu ? ['--cpu', args.cpu] : []), '--ignore-scripts'] : [];

  const work = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-pkgcheck-')));
  let registry;
  let context = `${CORTEX} on ${process.platform}/${process.arch}`;
  try {
    let tarballDir = args.tarballs ? resolve(args.tarballs) : undefined;
    if (!tarballDir) {
      tarballDir = join(work, 'tarballs');
      await stageCortex({ out: tarballDir });
    }
    const tarballs = findTarballs(tarballDir);
    const { version } = tarballs;
    const variantVersion = win32VariantVersion(version);
    const npmVersion = npm(['--version']).stdout.trim();
    context =
      `${CORTEX} ${version} on ${process.platform}/${process.arch}` +
      (simulated ? ` treated as ${target} by npm (--os)` : '') +
      `, Node ${process.version}, npm ${npmVersion}`;
    console.log(`Verifying ${context}`);

    registry = await startRegistry(work);
    const publisher = makeProject(join(work, 'publisher'), registry);

    await check('npm refuses the prerelease variant without --tag', () => {
      const refused = npm(['publish', tarballs.variant], { cwd: publisher, allowFailure: true });
      return (refused.status !== 0 && /--tag/.test(refused.stderr)) || `npm publish exited ${refused.status}: ${refused.stderr.trim()}`;
    });
    npm(['publish', tarballs.variant, '--tag', WIN32_DIST_TAG], { cwd: publisher });
    npm(['publish', tarballs.main], { cwd: publisher });

    await check(`latest is ${version} and ${WIN32_DIST_TAG} is ${variantVersion}`, () => {
      const tags = npmJson(['view', CORTEX, 'dist-tags', '--prefer-online'], { cwd: publisher });
      return (tags.latest === version && tags[WIN32_DIST_TAG] === variantVersion) || `dist-tags ${JSON.stringify(tags)}`;
    });
    await check('the variant never satisfies a version range', () => {
      const matched = [npmJson(['view', `${CORTEX}@*`, 'version', '--prefer-online'], { cwd: publisher })].flat();
      return same(matched, [version]) || `${CORTEX}@* matched ${matched.join(', ')}`;
    });
    await check(`the variant is package.json only: os win32, depends on exactly ${MXC_SDK.name}@${MXC_SDK.version}`, () => {
      const manifest = npmJson(['view', `${CORTEX}@${variantVersion}`, '--prefer-online'], { cwd: publisher });
      if (!same(manifest.os, ['win32'])) return `os ${JSON.stringify(manifest.os)}`;
      if (!same(manifest.dependencies, { [MXC_SDK.name]: MXC_SDK.version })) return `dependencies ${JSON.stringify(manifest.dependencies)}`;
      const code = ['main', 'exports', 'bin', 'scripts', 'optionalDependencies'].filter((key) => manifest[key] !== undefined);
      return code.length === 0 || `unexpected ${code.join(', ')}`;
    });

    const install = ['install', `${CORTEX}@${version}`, '--no-audit', '--no-fund', '--prefer-online', ...platformArgs];
    const hoisted = makeProject(join(work, 'hoisted'), registry);
    npm(install, { cwd: hoisted, inherit: true });
    const modules = join(hoisted, 'node_modules');
    // The alias under test is the one the installed code resolves through.
    const hoistedHost = await importHost(join(modules, '@animus-labs', 'cortex'));
    const alias = hoistedHost.MXC_SDK_PLATFORM_PACKAGE;
    await check(`${CORTEX}@${version} declares ${alias} as an optional alias of ${variantVersion}, and no SDK of its own`, () => {
      const manifest = npmJson(['view', `${CORTEX}@${version}`, '--prefer-online'], { cwd: publisher });
      if (typeof alias !== 'string') return 'the installed Cortex does not export MXC_SDK_PLATFORM_PACKAGE';
      if (manifest.optionalDependencies?.[alias] !== `npm:${CORTEX}@${variantVersion}`) {
        return `optionalDependencies ${JSON.stringify(manifest.optionalDependencies)}`;
      }
      const own = ['dependencies', 'peerDependencies', 'optionalDependencies'].filter((key) => manifest[key]?.[MXC_SDK.name]);
      return own.length === 0 || `declares ${MXC_SDK.name} in ${own.join(', ')}`;
    });

    const sdkDir = join(modules, ...MXC_SDK.name.split('/'));
    const variantPkg = readJsonIfExists(join(modules, ...String(alias).split('/'), 'package.json'));
    const sdkPkg = readJsonIfExists(join(sdkDir, 'package.json'));
    if (windows) {
      await check(`${alias} and ${MXC_SDK.name} are installed`, () =>
        (variantPkg?.version === variantVersion && sdkPkg?.version === MXC_SDK.version) ||
        `variant ${variantPkg?.version ?? 'absent'}, SDK ${sdkPkg?.version ?? 'absent'}`);
    } else {
      await check(`neither ${alias} nor ${MXC_SDK.name} is installed`, () =>
        (!variantPkg && !sdkPkg) || `variant ${variantPkg?.version ?? 'absent'}, SDK ${sdkPkg?.version ?? 'absent'}`);
    }
    await check('the lockfile records the variant (os win32) and the SDK as optional', () => {
      const lock = JSON.parse(readFileSync(join(hoisted, 'package-lock.json'), 'utf8'));
      const variantEntry = lock.packages?.[`node_modules/${alias}`];
      const sdkEntry = lock.packages?.[`node_modules/${MXC_SDK.name}`];
      if (!variantEntry || !same(variantEntry.os, ['win32']) || variantEntry.optional !== true) return `variant entry ${JSON.stringify(variantEntry)}`;
      return (sdkEntry?.optional === true && sdkEntry.version === MXC_SDK.version) || `SDK entry ${JSON.stringify(sdkEntry)}`;
    });
    await check(windows ? 'the installed Cortex finds the hoisted SDK' : 'the installed Cortex finds no SDK', () => {
      const found = hoistedHost.resolveMxcSdk();
      if (!windows) return found === undefined || `found ${found.packageRoot}`;
      return found?.packageRoot === realpathSync(sdkDir) || `found ${found?.packageRoot ?? 'nothing'}`;
    });

    if (windows) {
      const nested = makeProject(join(work, 'nested'), registry);
      npm([...install, '--install-strategy=nested'], { cwd: nested, inherit: true });
      const cortexDir = join(nested, 'node_modules', '@animus-labs', 'cortex');
      const nestedSdk = join(cortexDir, 'node_modules', ...String(alias).split('/'), 'node_modules', ...MXC_SDK.name.split('/'));
      await check('npm --install-strategy=nested keeps the SDK under the platform package', () => {
        if (readJsonIfExists(join(nestedSdk, 'package.json'))?.version !== MXC_SDK.version) return `no SDK at ${nestedSdk}`;
        try {
          createRequire(join(cortexDir, 'dist', 'index.js')).resolve(`${MXC_SDK.name}/package.json`);
          return 'ordinary resolution from Cortex reaches the SDK, so this layout proves nothing';
        } catch {
          return true;
        }
      });
      const nestedHost = await importHost(cortexDir);
      await check('the installed Cortex finds the nested SDK through the platform package', () => {
        const found = nestedHost.resolveMxcSdk();
        return found?.packageRoot === realpathSync(nestedSdk) || `found ${found?.packageRoot ?? 'nothing'}`;
      });
    }
  } catch (error) {
    results.push({ name: 'the check could not finish', ok: false, detail: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    writeSummary(`Cortex install from the staged packages (${target}${simulated ? ', simulated by npm --os' : ''})`, context);
    await registry?.stop();
    if (args.keep) console.log(`Kept ${work}`);
    else {
      try {
        rmSync(work, { recursive: true, force: true, maxRetries: 5 });
      } catch (error) {
        console.warn(`Could not remove ${work}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`${failed.length} of ${results.length} checks failed`);
    process.exit(1);
  }
  console.log(`All ${results.length} checks passed`);
}

await main();
