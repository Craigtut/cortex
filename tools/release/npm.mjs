/**
 * Run the npm CLI from the release tools on every OS. Under `npm run`, the
 * npm that started the script runs directly through Node. Otherwise `npm` from
 * PATH runs; on Windows that is npm.cmd, which Node only starts through a
 * shell, so every argument is double-quoted to keep cmd.exe from reading
 * characters like `^` or `>` in version ranges.
 */
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

/**
 * @param {string[]} args
 * @param {{ cwd?: string, allowFailure?: boolean, inherit?: boolean }} [options]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function npm(args, options = {}) {
  const execPath = process.env.npm_execpath;
  const direct = execPath !== undefined && basename(execPath).startsWith('npm-cli');
  const isWindows = process.platform === 'win32';
  for (const arg of args) {
    if (isWindows && !direct && arg.includes('"')) throw new Error(`cannot pass ${arg} to npm through cmd.exe`);
  }
  const [file, argv] = direct
    ? [process.execPath, [execPath, ...args]]
    : ['npm', isWindows ? args.map((arg) => `"${arg}"`) : args];
  const result = spawnSync(file, argv, {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: !direct && isWindows,
    stdio: options.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const outcome = { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (outcome.status !== 0 && !options.allowFailure) {
    throw new Error(`npm ${args.join(' ')} exited ${outcome.status}\n${outcome.stderr || outcome.stdout}`);
  }
  return outcome;
}

/** Run npm with --json and parse what it prints. */
export function npmJson(args, options = {}) {
  const { stdout } = npm([...args, '--json'], options);
  return JSON.parse(stdout);
}
