/**
 * Skill Preprocessor: processes SKILL.md body at load time.
 *
 * Processing order (security-critical):
 * 1. Extract shell (!`cmd`) and script (!{script: path}) markers from the RAW
 *    body, BEFORE any variable substitution. This guarantees attacker-
 *    controlled argument VALUES (from a model-issued `load_skill` call) can
 *    never be spliced into the body and then re-scanned as executable markers.
 * 2. Substitute variables (${VAR}, $ARGUMENTS, $N) in the remaining prose only.
 *    Prose is injected into context as text, never executed, so substitution
 *    there is safe.
 * 3. Execute the markers:
 *    - Shell markers: variable references inside the author's command are
 *      substituted with SHELL-QUOTED values, so a value like `; rm -rf ~`
 *      stays a single inert string instead of becoming shell syntax. The
 *      resolved command is then screened by the framework catastrophic-command
 *      floor (findCatastrophicCommand) and hard-blocked if it is irreversible.
 *    - Script markers: run via dynamic import with a context object (no shell),
 *      so their path/args are substituted with plain (unquoted) values.
 *
 * Shell commands use the Bash tool's shell selection (PowerShell on Windows,
 * bash/zsh on Unix) and, when a sandbox provider is configured, run inside
 * the same OS boundary as the Bash tool.
 *
 * References:
 *   - docs/cortex/skill-system.md
 *   - docs/cortex/cross-platform-considerations.md
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { SandboxProvider } from './sandbox/types.js';
import { buildSafeEnv } from './tools/shared/safe-env.js';
import { findCatastrophicCommand } from './tools/bash/catastrophic.js';
import { selectShell } from './tools/bash/shell.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreprocessorConfig {
  /** Variables for ${VAR} and $N substitution. */
  variables: Record<string, string>;
  /** Context object passed to script executions. */
  scriptContext: Record<string, unknown>;
  /** Absolute path to the skill directory. */
  skillDir: string;
  /**
   * The loop's OS sandbox. Shell markers spawn through its wrapSpawn, like
   * the Bash tool. Script markers run in-process and are not contained.
   */
  sandbox?: SandboxProvider | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout for each shell command or script execution. */
const COMMAND_TIMEOUT_MS = 10_000;

/** Private, non-collidable sentinel wrapping an extracted marker placeholder. */
const MARKER_SENTINEL = '\u0000';

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

/** Match !`command` patterns (shell command markers). */
const SHELL_COMMAND_PATTERN = /^!`([^`]+)`$/gm;

/** Match !{script: path} or !{script: path, key: value, ...} patterns. */
const SCRIPT_PATTERN = /^!\{script:\s*([^,}]+)(?:,\s*([^}]+))?\}$/gm;

/** Match ${VAR} variable references. */
const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Match $N positional argument references (1-9). */
const POSITIONAL_PATTERN = /\$([1-9])/g;

/** Match $ARGUMENTS reference. */
const ARGUMENTS_PATTERN = /\$ARGUMENTS/g;

// ---------------------------------------------------------------------------
// Shell-safe value quoting
// ---------------------------------------------------------------------------

/**
 * Quote an arbitrary value so it is a single, inert shell token on the current
 * platform. This is what stops attacker-controlled argument values from
 * becoming shell syntax: `; rm -rf ~` quotes to `'; rm -rf ~'` (POSIX) and is
 * passed to the command as one literal string.
 */
function quoteForShell(value: string): string {
  if (process.platform === 'win32') {
    // PowerShell single-quoted string: a literal single quote is doubled.
    return `'${value.replace(/'/g, "''")}'`;
  }
  // POSIX single-quoted string: close, emit an escaped quote, reopen.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Preprocessor implementation
// ---------------------------------------------------------------------------

interface ExtractedMarker {
  token: string;
  kind: 'shell' | 'script';
  /** Raw author text: the shell command, or the script path. */
  raw: string;
  /** Script-only: the extra-args string from `!{script: path, k: v}`. */
  extra: string;
}

/**
 * Preprocess a SKILL.md body. Runs all stages:
 * 1. Extract shell/script markers from the raw body (before substitution).
 * 2. Substitute variables in the remaining prose.
 * 3. Execute markers (in parallel) and splice their output back in.
 */
export async function preprocessSkillBody(
  body: string,
  config: PreprocessorConfig,
): Promise<string> {
  // Stage 1: extract markers from the RAW body, BEFORE variable substitution.
  // Substituting first would let a model-controlled argument value (e.g. one
  // containing a "!`...`" sequence) be re-scanned and executed as a marker.
  const markers: ExtractedMarker[] = [];
  let counter = 0;
  // Per-invocation nonce so a crafted argument value cannot forge a placeholder
  // token and hijack a marker's output slot during the final splice.
  const nonce = randomUUID();
  const mask = (kind: 'shell' | 'script', raw: string, extra: string): string => {
    const token = `${MARKER_SENTINEL}SKILLMARK-${nonce}-${counter++}${MARKER_SENTINEL}`;
    markers.push({ token, kind, raw, extra });
    return token;
  };

  // Shell markers first, then scripts. Both patterns are line-anchored, so
  // masking one does not disturb the other.
  let masked = body.replace(
    new RegExp(SHELL_COMMAND_PATTERN.source, 'gm'),
    (_full, command: string) => mask('shell', command, ''),
  );
  masked = masked.replace(
    new RegExp(SCRIPT_PATTERN.source, 'gm'),
    (_full, scriptPath: string, extraArgs: string | undefined) =>
      mask('script', scriptPath.trim(), (extraArgs ?? '').trim()),
  );

  // Stage 2: variable substitution over the prose only (markers are masked).
  let content = substituteVariables(masked, config.variables);

  // Stage 3: execute markers in parallel.
  if (markers.length > 0) {
    const results = await Promise.allSettled(
      markers.map((m) =>
        m.kind === 'shell'
          ? executeShellMarker(m.raw, config)
          : executeScript(
              substituteVariables(m.raw, config.variables),
              substituteVariables(m.extra, config.variables),
              config,
            ),
      ),
    );

    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i]!;
      const result = results[i]!;
      const output = result.status === 'fulfilled'
        ? result.value
        : `[Error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}]`;
      // Use a callback to prevent $& and other replacement patterns in output.
      content = content.replace(marker.token, () => output);
    }
  }

  return content;
}

/**
 * Substitute ${VAR}, $ARGUMENTS, and $N references with their values.
 */
export function substituteVariables(
  body: string,
  variables: Record<string, string>,
): string {
  let result = body;

  // Replace $ARGUMENTS first (before ${} to avoid partial matching)
  result = result.replace(ARGUMENTS_PATTERN, () => variables['ARGUMENTS'] ?? '');

  // Replace positional $1..$9
  result = result.replace(POSITIONAL_PATTERN, (_match, num: string) => {
    return variables[num] ?? '';
  });

  // Replace ${VAR} references
  result = result.replace(VARIABLE_PATTERN, (_match, varName: string) => {
    return variables[varName] ?? '';
  });

  return result;
}

/**
 * Single combined pattern for the three variable classes ($ARGUMENTS, $1..$9,
 * ${VAR}). Matched in ONE pass so a substituted value that itself contains a
 * later token (e.g. an argument value of `$1`) is never re-scanned.
 */
const QUOTED_VARIABLE_PATTERN = /\$ARGUMENTS|\$([1-9])|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Substitute variable references into a shell command, quoting each value so it
 * stays a single inert token. Author markers reference `$ARGUMENTS`/`$1`/
 * `${VAR}` exactly as before; only the substituted VALUE is quoted, so attacker
 * data can never become shell syntax.
 *
 * CRITICAL: this MUST be a single left-to-right pass. String.prototype.replace
 * never re-scans the text it inserts, so a value that contains a token like
 * `$1` is emitted verbatim (already quoted) and not re-substituted. A previous
 * multi-pass version (one replace() per class) was bypassable: a value inserted
 * by an earlier pass could contain a later-pass token, and splicing a balanced
 * `'...'` value into the middle of an already-quoted region broke quote balance
 * and exposed live shell syntax.
 *
 * Assumes each variable reference sits at an UNQUOTED position in the author's
 * command (`!`echo $ARGUMENTS``), which is the documented convention. An author
 * who wraps a reference in their own quotes (`!`echo '$ARGUMENTS'``) defeats the
 * value's own quoting; that deeper case is out of scope for this single-pass fix.
 */
function substituteVariablesQuoted(
  command: string,
  variables: Record<string, string>,
): string {
  return command.replace(
    QUOTED_VARIABLE_PATTERN,
    (_match, positional: string | undefined, braced: string | undefined) => {
      if (positional !== undefined) return quoteForShell(variables[positional] ?? '');
      if (braced !== undefined) return quoteForShell(variables[braced] ?? '');
      return quoteForShell(variables['ARGUMENTS'] ?? '');
    },
  );
}

/**
 * Resolve and run a single shell marker. Variable values are shell-quoted, then
 * the resolved command is screened by the framework catastrophic-command floor
 * before execution. A catastrophic command (e.g. `rm -rf /`, or `rm -rf $1`
 * whose argument resolves to `/`) is hard-blocked and never runs.
 */
async function executeShellMarker(
  rawCommand: string,
  config: PreprocessorConfig,
): Promise<string> {
  const command = substituteVariablesQuoted(rawCommand, config.variables);

  const catastrophic = findCatastrophicCommand(command, {
    cwd: config.skillDir,
    home: homedir(),
  });
  if (catastrophic) {
    return `[Error: blocked by catastrophic-command floor: ${catastrophic.reason}]`;
  }

  return executeShellCommand(command, config.skillDir, config.sandbox);
}

/**
 * Execute a shell command and return stdout.
 * Uses the Bash tool's shell selection and, when a sandbox provider is given,
 * its wrapped spawn, so the command runs inside the same OS boundary.
 */
export async function executeShellCommand(
  command: string,
  cwd: string,
  sandbox?: SandboxProvider,
): Promise<string> {
  const shell = selectShell();
  // Sanitize the environment (strip injection vectors: LD_/DYLD_ preloads,
  // NODE_OPTIONS, BASH_ENV, and similar) just like the Bash tool. SKILL.md
  // shell hooks are author-controlled but must not run with a raw env.
  const env = buildSafeEnv(process.env);

  // Invoke the shell directly with the command as an argument, which avoids
  // the double-shell invocation exec() would add.
  let file = shell.shell;
  let args = [...shell.args, command];
  let spawnEnv = env;
  if (sandbox) {
    // A provider that cannot wrap the command fails closed: it never runs
    // uncontained.
    try {
      const wrapped = await sandbox.wrapSpawn({ shell: shell.shell, shellArgs: shell.args, command, cwd, env });
      file = wrapped.file;
      args = wrapped.args;
      spawnEnv = wrapped.env;
    } catch (err) {
      return `[Error: sandbox could not wrap command: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }

  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024, // 1MB
        env: spawnEnv,
      },
      (error: Error | null, stdout: string, _stderr: string) => {
        if (error) {
          if ('killed' in error && (error as { killed?: boolean }).killed) {
            resolve('[Error: command timed out]');
          } else {
            const exitCode = 'code' in error && (error as Record<string, unknown>)['code'] != null
              ? (error as Record<string, unknown>)['code']
              : 'unknown';
            resolve(`[Error: command failed with exit code ${exitCode}]`);
          }
          return;
        }
        resolve(stdout.trim());
      },
    );

    child.on('error', () => {
      resolve('[Error: failed to execute command]');
    });
  });
}

/**
 * Execute a JavaScript script and return its output.
 * Scripts are loaded via dynamic import() and must export a default
 * async function.
 */
export async function executeScript(
  scriptPath: string,
  extraArgsStr: string,
  config: PreprocessorConfig,
): Promise<string> {
  const absolutePath = path.isAbsolute(scriptPath)
    ? scriptPath
    : path.resolve(config.skillDir, scriptPath);

  // Security: reject paths that escape the skill directory
  const relative = path.relative(config.skillDir, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return '[Error: script path must be within the skill directory]';
  }

  // Parse extra args from "key: value, key2: value2" format
  const scriptArgs: Record<string, string> = {};
  if (extraArgsStr) {
    const pairs = extraArgsStr.split(',');
    for (const pair of pairs) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx > 0) {
        const key = pair.substring(0, colonIdx).trim();
        const value = pair.substring(colonIdx + 1).trim();
        scriptArgs[key] = value;
      }
    }
  }

  // Build context: consumer context spread first, then Cortex built-ins
  // override (skillDir and scriptArgs are Cortex-owned and cannot be
  // overridden by consumer). args/rawArgs come pre-merged in
  // config.scriptContext from the registry with the same precedence.
  const ctx: Record<string, unknown> = {
    ...config.scriptContext,
    skillDir: config.skillDir,
    scriptArgs,
  };

  // Execute with timeout
  const timeoutPromise = new Promise<string>((resolve) => {
    setTimeout(() => resolve('[Error: script timed out]'), COMMAND_TIMEOUT_MS);
  });

  const executionPromise = (async (): Promise<string> => {
    try {
      // Dynamic import of the script file
      const fileUrl = pathToFileURL(absolutePath).href;
      const mod = await import(fileUrl);
      const fn = mod.default ?? mod;

      if (typeof fn !== 'function') {
        return '[Error: script does not export a function]';
      }

      const result = await fn(ctx);
      return typeof result === 'string' ? result : String(result ?? '');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `[Error: script failed: ${message}]`;
    }
  })();

  return Promise.race([executionPromise, timeoutPromise]);
}
