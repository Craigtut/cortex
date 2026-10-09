/**
 * Bash tool: execute shell commands in the host environment.
 *
 * Cross-platform: bash/zsh on macOS and Linux, PowerShell on Windows.
 * Tracks working directory across calls within an agentic loop.
 * Supports background execution with auto-yield.
 *
 * Reference: docs/cortex/tools/bash.md
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import { Type, type Static } from 'typebox';
import type { CwdTracker } from '../shared/cwd-tracker.js';
import type { ToolContentDetails, ToolExecuteContext } from '../../types.js';
import type { SandboxDenial, SandboxProvider } from '../../sandbox/types.js';
import { killProcessTree } from '../shared/process-tree.js';
import { buildSafeEnv, runSafetyChecks } from './safety.js';
import { selectShell, buildShellCommand } from './shell.js';
import {
  type BackgroundTask,
  type CortexToolRuntime,
  attachRuntimeAwareTool,
  globalBackgroundTaskStore,
} from '../runtime.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const BashParams = Type.Object({
  command: Type.String({ description: 'The shell command to execute' }),
  timeout: Type.Optional(
    Type.Number({ description: 'Timeout in milliseconds. Default: 120000 (2 min). Max: 600000 (10 min).' }),
  ),
  description: Type.Optional(
    Type.String({ description: 'Human-readable explanation of the command.' }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: 'Run the command in the background immediately. Default: false. You are woken automatically when a backgrounded command finishes, so do not poll in a loop. To wait for an external condition, background a SINGLE command that blocks until the condition holds (e.g. `gh run watch <id> --exit-status`, or `until gh release view "$TAG" >/dev/null 2>&1; do sleep 20; done`) rather than re-running a quick check.' }),
  ),
  escalateOutsideSandbox: Type.Optional(
    Type.Boolean({ description: 'Request to run this ONE command outside the OS sandbox. Use only after a command failed because the sandbox blocked it (a sandbox-denial note on the failure). Requires explicit human approval; every other command stays sandboxed. Default: false.' }),
  ),
});

export type BashParamsType = Static<typeof BashParams>;

export { BASH_ESCALATION_PERMISSION_NAME } from '../tool-names.js';

/**
 * Whether a spawn-error code means the sandbox WRAPPER binary could not be found
 * or executed (so containment genuinely failed and should degrade), as opposed
 * to a transient spawn-environment error (fd/memory pressure, an over-long
 * command line) that is not the wrapper's fault. Degrading on the latter would
 * let a caller drop containment by forcing a spawn error, so only these codes
 * count. Exported for testing.
 */
export function isWrapperLaunchErrorCode(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM';
}

/**
 * True when a tool call is a Bash escalation request: the Bash tool invoked
 * with `escalateOutsideSandbox: true`. Shared by the permission adaptation in
 * AgentLoop and by consumers that need to recognize the same shape.
 */
export function isBashEscalationRequest(toolName: string, toolArgs: unknown): boolean {
  if (toolName !== 'Bash') return false;
  const args = toolArgs as Record<string, unknown> | null | undefined;
  return args?.['escalateOutsideSandbox'] === true;
}

// ---------------------------------------------------------------------------
// Details type
// ---------------------------------------------------------------------------

export interface BashDetails {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  duration: number;
  interrupted: boolean;
  timedOut: boolean;
  backgrounded: boolean;
  taskId: string | null;
  finalCwd: string;
}

/**
 * Partial result details emitted during bash streaming via onUpdate.
 */
export interface BashStreamUpdate {
  /** New stdout chunk since last update (complete lines only). */
  stdout: string;
  /** New stderr chunk since last update. */
  stderr: string;
  /** Total stdout lines emitted so far. */
  totalLines: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const AUTO_YIELD_THRESHOLD = 10_000; // 10 seconds
const CWD_MARKER = '___CWD___';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface BashToolConfig {
  runtime?: CortexToolRuntime | undefined;
  cwdTracker?: CwdTracker | undefined;
  /** Custom shell path override. */
  shellPath?: string | undefined;
  /** Auto-yield threshold in ms. Default: 10000. */
  autoYieldThreshold?: number | undefined;
  /** Callback for tracking subprocess PIDs (for cleanup on exit). */
  onProcessSpawned?: ((pid: number) => void) | undefined;
  /** Callback for removing tracked PIDs when process exits. */
  onProcessExited?: ((pid: number) => void) | undefined;
  /**
   * Fired when a backgrounded task (explicit `background: true` or an
   * auto-yielded long-running command) finishes. The agent uses this to wake
   * its loop and deliver the result, so it does not have to poll repeatedly.
   */
  onBackgroundTaskComplete?: ((taskId: string) => void) | undefined;
  /**
   * Fired when a command goes to the background (explicitly or by
   * auto-yield), inside the tool call that backgrounded it.
   */
  onBackgroundTaskStarted?: ((taskId: string) => void) | undefined;
  /** Utility model completion function for Layer 7 safety classifier. */
  utilityComplete?: ((context: unknown) => Promise<unknown>) | undefined;
  /** Whether the consumer is currently auto-approving tool calls. */
  isAutoApprove?: boolean | (() => boolean) | undefined;
  /**
   * Consumer-set environment variable overrides that bypass the security blocklist.
   * Merged ON TOP of the sanitized environment for shell subprocesses.
   * Used for macOS dock icon suppression vars (DYLD_INSERT_LIBRARIES, etc.).
   */
  envOverrides?: Record<string, string> | undefined;
  /**
   * Optional OS-level sandbox. When present, each shell spawn is passed through
   * provider.wrapSpawn after safety checks and the cwd-capture suffix, launching
   * the command inside an OS boundary. No-op when omitted.
   */
  sandbox?: SandboxProvider | undefined;
  /**
   * Assert that a permission gate screens calls BEFORE they reach execute()
   * (AgentLoop sets this when the consumer configured resolvePermission,
   * which runs via beforeToolCall and can block the call). Security-relevant
   * for escalation: `escalateOutsideSandbox` is honored only when true, because
   * reaching execute() then means the gate approved the escalation. When
   * false/omitted, an escalation request is refused (fail closed) rather than
   * granting the model an unapproved uncontained run.
   */
  permissionGated?: boolean | undefined;
}

export function getBackgroundTask(id: string): BackgroundTask | undefined {
  return globalBackgroundTaskStore.get(id);
}

export function getAllBackgroundTasks(): Map<string, BackgroundTask> {
  return globalBackgroundTaskStore.getAll();
}

// ---------------------------------------------------------------------------
// Output handling
// ---------------------------------------------------------------------------

/**
 * Sanitize output by stripping binary control characters.
 * Preserves tab, newline, and carriage return.
 */
function sanitizeOutput(output: string): string {
  // eslint-disable-next-line no-control-regex
  return output.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Extract CWD from output using the CWD_MARKER.
 * Returns [cleanedOutput, extractedCwd].
 */
function extractCwd(output: string): [string, string | null] {
  const markerIdx = output.lastIndexOf(CWD_MARKER);
  if (markerIdx === -1) return [output, null];

  const beforeMarker = output.slice(0, markerIdx);
  const afterMarker = output.slice(markerIdx + CWD_MARKER.length).trim();

  // The CWD is on the line after the marker
  const lines = afterMarker.split('\n');
  const cwd = (lines[0] ?? '').trim();

  return [beforeMarker.trimEnd(), cwd || null];
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createBashTool(config: BashToolConfig): {
  name: string;
  description: string;
  parameters: typeof BashParams;
  execute: (params: BashParamsType, context?: ToolExecuteContext) => Promise<ToolContentDetails<BashDetails>>;
} {
  const cwdTracker = config.runtime?.cwdTracker ?? config.cwdTracker;
  if (!cwdTracker) {
    throw new Error('createBashTool requires either runtime or cwdTracker');
  }
  const backgroundTasks = config.runtime?.backgroundTasks ?? globalBackgroundTaskStore;
  const autoYieldThreshold = config.autoYieldThreshold ?? AUTO_YIELD_THRESHOLD;

  const tool = {
    name: 'Bash',
    description: 'Execute a shell command in the host environment.',
    parameters: BashParams,

    async execute(params: BashParamsType, context?: ToolExecuteContext): Promise<ToolContentDetails<BashDetails>> {
      backgroundTasks.cleanupCompletedTasks();
      const timeout = Math.min(params.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
      const background = params.background ?? false;
      const startTime = Date.now();

      // Run safety checks (Layers 2-7)
      const safetyResult = await runSafetyChecks(
        params.command,
        cwdTracker.getDefaultDir(),
        cwdTracker.getCwd(),
        {
          utilityComplete: config.utilityComplete,
          description: params.description,
          isAutoApprove: typeof config.isAutoApprove === 'function'
            ? config.isAutoApprove()
            : config.isAutoApprove,
        },
      );

      if (!safetyResult.allowed) {
        return {
          content: [{ type: 'text', text: safetyResult.reason ?? 'Command blocked by safety check.' }],
          details: {
            stdout: '',
            stderr: '',
            exitCode: null,
            duration: Date.now() - startTime,
            interrupted: false,
            timedOut: false,
            backgrounded: false,
            taskId: null,
            finalCwd: cwdTracker.getCwd(),
          },
        };
      }

      // Single-command escalation out of the sandbox. Only meaningful when a
      // provider is configured; otherwise the flag is ignored (there is no
      // sandbox to escape). Honoring it requires a permission gate in front of
      // this tool: the gate saw the call as BASH_ESCALATION_PERMISSION_NAME and
      // approving it is what authorizes the uncontained run. Without a gate,
      // refuse (fail closed) so the model can never grant itself escalation.
      const escalated = params.escalateOutsideSandbox === true && config.sandbox !== undefined;
      if (escalated && config.permissionGated !== true) {
        return {
          content: [{ type: 'text', text: 'Escalation outside the sandbox is unavailable: no permission gate is configured to approve it. The command was not run. Re-run without escalateOutsideSandbox to execute inside the sandbox.' }],
          details: {
            stdout: '',
            stderr: '',
            exitCode: null,
            duration: Date.now() - startTime,
            interrupted: false,
            timedOut: false,
            backgrounded: false,
            taskId: null,
            finalCwd: cwdTracker.getCwd(),
          },
        };
      }

      // Select shell
      const shellConfig = selectShell(config.shellPath);

      // Verify shell exists
      try {
        fs.accessSync(shellConfig.shell, fs.constants.X_OK);
      } catch {
        return {
          content: [{ type: 'text', text: `Shell not found: ${shellConfig.shell}. Configure a custom shell in settings.` }],
          details: {
            stdout: '',
            stderr: '',
            exitCode: null,
            duration: Date.now() - startTime,
            interrupted: false,
            timedOut: false,
            backgrounded: false,
            taskId: null,
            finalCwd: cwdTracker.getCwd(),
          },
        };
      }

      // Build safe environment (Layer 1), with consumer overrides merged on top
      const safeEnv = buildSafeEnv(process.env, config.envOverrides);

      const isWindows = process.platform === 'win32';
      const fullCommand = buildShellCommand(params.command, CWD_MARKER);

      // Resolve the spawn, optionally wrapped by an OS sandbox. The wrapper is a
      // pure transform applied AFTER safety checks and the cwd-capture suffix, so
      // the working-directory tracking and all safety layers still run first.
      // No-op when no provider is configured. An approved escalation skips the
      // wrap for this one command; the provider stays active for every other.
      const sandboxWrapped = config.sandbox !== undefined && !escalated;
      const spawnCwd = cwdTracker.getCwd();
      let spawnFile = shellConfig.shell;
      let spawnArgs = [...shellConfig.args, fullCommand];
      let spawnEnv: Record<string, string> = safeEnv;
      if (config.sandbox && sandboxWrapped) {
        const wrapped = await config.sandbox.wrapSpawn({
          shell: shellConfig.shell,
          shellArgs: shellConfig.args,
          command: fullCommand,
          cwd: spawnCwd,
          env: safeEnv,
        });
        spawnFile = wrapped.file;
        spawnArgs = wrapped.args;
        spawnEnv = wrapped.env;
      } else if (config.sandbox && escalated) {
        // An approved escalation leaves the OS boundary for this one command, but
        // must not also hand it the ambient credential env vars the sandbox
        // scrubs (AWS/GITHUB/NPM tokens, etc.): escalation is a single-command
        // fs/network exit, not a move to Off, so "secrets stay unreadable" still
        // holds. The command runs uncontained on disk and network, without them.
        spawnEnv = config.sandbox.scrubCredentialEnv?.(safeEnv) ?? safeEnv;
      }

      // Spawn the process
      const proc = child_process.spawn(
        spawnFile,
        spawnArgs,
        {
          cwd: spawnCwd,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: !isWindows, // Process group for Unix cleanup
        },
      );

      // Track PID
      if (proc.pid && config.onProcessSpawned) {
        config.onProcessSpawned(proc.pid);
      }

      // Background execution
      if (background) {
        const taskId = backgroundTasks.nextTaskId();
        const task: BackgroundTask = {
          id: taskId,
          command: params.command.slice(0, 120),
          process: proc,
          stdout: '',
          stderr: '',
          exitCode: null,
          completed: false,
          notified: false,
          startTime: Date.now(),
        };
        backgroundTasks.set(task);
        config.onBackgroundTaskStarted?.(taskId);

        proc.stdout?.setEncoding('utf8');
        proc.stderr?.setEncoding('utf8');
        proc.stdout?.on('data', (data: string) => { task.stdout += data; });
        proc.stderr?.on('data', (data: string) => { task.stderr += data; });
        proc.on('close', (code) => {
          task.exitCode = code;
          task.completed = true;
          if (proc.pid && config.onProcessExited) {
            config.onProcessExited(proc.pid);
          }
          config.onBackgroundTaskComplete?.(taskId);
        });

        return {
          content: [{ type: 'text', text: `Command running in background. Task ID: ${taskId}\nYou will be notified automatically when it finishes; no need to poll. Use TaskOutput to check progress, send input, or kill.` }],
          details: {
            stdout: '',
            stderr: '',
            exitCode: null,
            duration: 0,
            interrupted: false,
            timedOut: false,
            backgrounded: true,
            taskId,
            finalCwd: cwdTracker.getCwd(),
          },
        };
      }

      // Foreground execution
      return new Promise<ToolContentDetails<BashDetails>>((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let autoYielded = false;
        let taskId: string | null = null;

        // Streaming state: buffer chunks and emit complete lines every 100ms
        const onUpdate = context?.onUpdate;
        let pendingStdout = '';
        let pendingStderr = '';
        let totalLinesEmitted = 0;

        const flushStreamUpdate = (): void => {
          if (!onUpdate) return;
          // Only emit complete lines (hold partial lines in the buffer)
          const lastNewline = pendingStdout.lastIndexOf('\n');
          const lastStderrNewline = pendingStderr.lastIndexOf('\n');
          if (lastNewline === -1 && lastStderrNewline === -1) return;

          let stdoutChunk = '';
          if (lastNewline >= 0) {
            stdoutChunk = pendingStdout.slice(0, lastNewline + 1);
            pendingStdout = pendingStdout.slice(lastNewline + 1);
            totalLinesEmitted += stdoutChunk.split('\n').length - 1;
          }

          let stderrChunk = '';
          if (lastStderrNewline >= 0) {
            stderrChunk = pendingStderr.slice(0, lastStderrNewline + 1);
            pendingStderr = pendingStderr.slice(lastStderrNewline + 1);
          }

          onUpdate({
            content: [{ type: 'text', text: stdoutChunk + stderrChunk }],
            details: { stdout: stdoutChunk, stderr: stderrChunk, totalLines: totalLinesEmitted },
          });
        };

        const streamInterval = onUpdate ? setInterval(flushStreamUpdate, 100) : null;

        proc.stdout?.setEncoding('utf8');
        proc.stderr?.setEncoding('utf8');
        proc.stdout?.on('data', (data: string) => {
          stdout += data;
          pendingStdout += data;
        });
        proc.stderr?.on('data', (data: string) => {
          stderr += data;
          pendingStderr += data;
        });

        // Timeout handler
        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          killProcessTree(proc);
        }, timeout);

        // Auto-yield handler
        const autoYieldTimer = setTimeout(() => {
          if (!proc.exitCode && proc.pid) {
            autoYielded = true;
            taskId = backgroundTasks.nextTaskId();
            const task: BackgroundTask = {
              id: taskId,
              command: params.command.slice(0, 120),
              process: proc,
              stdout,
              stderr,
              exitCode: null,
              completed: false,
              notified: false,
              startTime: Date.now(),
            };
            backgroundTasks.set(task);
            config.onBackgroundTaskStarted?.(taskId);

            // Remove original foreground listeners to prevent memory leak
            proc.stdout?.removeAllListeners('data');
            proc.stderr?.removeAllListeners('data');
            // Continue collecting output for the background task
            proc.stdout?.on('data', (data: string) => { task.stdout += data; });
            proc.stderr?.on('data', (data: string) => { task.stderr += data; });
            proc.on('close', (code) => {
              task.exitCode = code;
              task.completed = true;
              if (proc.pid && config.onProcessExited) {
                config.onProcessExited(proc.pid);
              }
              if (taskId) config.onBackgroundTaskComplete?.(taskId);
            });

            clearTimeout(timeoutTimer);
            if (streamInterval) {
              clearInterval(streamInterval);
              flushStreamUpdate();
            }

            const [cleanedOutput] = extractCwd(sanitizeOutput(stdout));
            resolve({
              content: [{ type: 'text', text: `${cleanedOutput}\n\n[Command auto-yielded after ${autoYieldThreshold}ms. Task ID: ${taskId}. You will be notified automatically when it finishes; no need to poll.]` }],
              details: {
                stdout: cleanedOutput,
                stderr,
                exitCode: null,
                duration: Date.now() - startTime,
                interrupted: false,
                timedOut: false,
                backgrounded: true,
                taskId,
                finalCwd: cwdTracker.getCwd(),
              },
            });
          }
        }, autoYieldThreshold);

        proc.on('close', async (code) => {
          clearTimeout(timeoutTimer);
          clearTimeout(autoYieldTimer);
          if (streamInterval) {
            clearInterval(streamInterval);
            flushStreamUpdate();
          }

          if (proc.pid && config.onProcessExited) {
            config.onProcessExited(proc.pid);
          }

          // If already auto-yielded, don't resolve again
          if (autoYielded) return;

          const rawOutput = sanitizeOutput(stdout);
          const [cleanedOutput, newCwd] = extractCwd(rawOutput);

          // Update CWD tracker
          if (newCwd) {
            cwdTracker.updateCwd(newCwd);
          }

          const duration = Date.now() - startTime;

          let text = cleanedOutput;
          if (stderr) {
            text += `\nstderr: ${stderr}`;
          }
          if (timedOut) {
            text += `\nCommand timed out after ${timeout}ms.`;
          }
          if (code !== null && code !== 0) {
            text += `\nExit code: ${code}`;
          }

          // Self-explaining denial (best-effort): when a sandboxed command
          // fails, ask the provider whether the failure is attributable to the
          // sandbox, so the model learns what was blocked and that escalation
          // exists instead of blindly retrying. Attribution is precise on macOS
          // (violation log) and heuristic on Linux; a missed match just means
          // no note.
          //
          // NOTE: we deliberately do NOT key any containment-state change on a
          // wrapped command's stderr/exit (e.g. the MXC launcher's
          // `cortex-mxc-launcher:` failure line), because the child fully
          // controls its own stderr and exit code and could forge such a signal
          // to trick the provider into degrading to uncontained — a
          // self-inflicted sandbox escape. A genuine per-command containment
          // failure still surfaces its human-readable reason on stderr, and the
          // command did not run.
          if (sandboxWrapped && !timedOut && code !== null && code !== 0) {
            let denial: SandboxDenial | null = null;
            try {
              denial = await config.sandbox?.classifyFailure?.({
                command: fullCommand,
                exitCode: code,
                stderr,
                stdout: cleanedOutput,
              }) ?? null;
            } catch {
              // Attribution is advisory; never let it break the result.
            }
            if (denial) {
              text += `\n[This command ran inside the OS sandbox and the failure looks like a sandbox denial (${denial.dimension}): ${denial.detail}.`;
              if (denial.escalatable) {
                text += ' If it genuinely needs the blocked access, you may re-run it with escalateOutsideSandbox: true to request running this ONE command outside the sandbox; the user must approve.';
              }
              text += ']';
            }
          }

          resolve({
            content: [{ type: 'text', text: text || '(no output)' }],
            details: {
              stdout: cleanedOutput,
              stderr,
              exitCode: code,
              duration,
              interrupted: false,
              timedOut,
              backgrounded: false,
              taskId: null,
              finalCwd: newCwd ?? cwdTracker.getCwd(),
            },
          });
        });

        proc.on('error', (err) => {
          clearTimeout(timeoutTimer);
          clearTimeout(autoYieldTimer);
          if (streamInterval) {
            clearInterval(streamInterval);
            flushStreamUpdate();
          }

          if (autoYielded) return;

          let text = `Failed to execute command: ${err.message}`;
          if (sandboxWrapped && config.sandbox) {
            // A wrapped spawn's file IS the sandbox wrapper (sandbox-exec,
            // bwrap, or node.exe for the MXC launcher), so a spawn 'error' is
            // the WRAPPER failing to start, never the user's command (which
            // runs inside it). But ONLY codes that mean "the wrapper binary
            // could not be found or executed" (quarantined/blocked by
            // antivirus, missing, wrong-arch) justify
            // dropping containment. Transient spawn-environment errors — fd or
            // memory pressure (EMFILE/ENFILE/ENOMEM/EAGAIN) or an over-long
            // command line — are NOT the wrapper's fault; degrading on those
            // would let a caller escape the sandbox by forcing a spawn error, so
            // they are reported as an ordinary "did not run" without degrading.
            const code = (err as NodeJS.ErrnoException).code;
            if (isWrapperLaunchErrorCode(code)) {
              config.sandbox.notifyWrappedSpawnFailure?.({ code, message: err.message });
              // Only tell the model containment dropped if the provider ACTUALLY
              // degraded. A provider that omits the hook (or chose to stay
              // contained) leaves the boundary intact, so claiming it is gone
              // would be false and would invite an uncontained retry that still
              // wraps. Absent status() we assume still-contained (the safe
              // direction). This keeps the message honest regardless of which
              // provider is wired.
              const dropped = config.sandbox.status?.().backend === 'none';
              text = dropped
                ? `The command did not run: the OS sandbox wrapper could not be launched ` +
                  `(${err.message}). This often means security software blocked or quarantined it. ` +
                  `OS containment is now disabled for the rest of this session; re-run the command ` +
                  `(it will run without the sandbox) or check whether your security software is blocking it.`
                : `The command did not run: the OS sandbox wrapper could not be launched ` +
                  `(${err.message}). This often means security software blocked or quarantined it. ` +
                  `OS containment is still active; retry, or check whether your security software is blocking it.`;
            } else {
              text =
                `The command did not run (${err.message}). The OS sandbox is still active; this is ` +
                `not a sandbox failure (e.g. resource pressure or an over-long command line).`;
            }
          }

          resolve({
            content: [{ type: 'text', text }],
            details: {
              stdout,
              stderr,
              exitCode: null,
              duration: Date.now() - startTime,
              interrupted: false,
              timedOut: false,
              backgrounded: false,
              taskId: null,
              finalCwd: cwdTracker.getCwd(),
            },
          });
        });
      });
    },
  };

  return attachRuntimeAwareTool(tool, {
    toolKind: 'Bash',
    cloneForRuntime: (runtime) => createBashTool({
      ...config,
      runtime,
      cwdTracker: runtime.cwdTracker,
    }),
  });
}

