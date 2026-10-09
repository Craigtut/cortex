import { appendFile, mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { BASH_ESCALATION_PERMISSION_NAME } from '@animus-labs/cortex';
import type { ClassifiedError } from '@animus-labs/cortex';

const ACTIVITY_VERSION = 1;
const DEFAULT_MAX_EVENT_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ROTATED_EVENT_LOGS = 3;
const DEFAULT_SESSIONS_DIR = join(homedir(), '.cortex', 'sessions');
const MAX_GENERIC_PERMISSION_STRING_CHARS = 4_000;
const MAX_PERMISSION_PREVIEW_CHARS = 240;

export type ActivityStatus =
  | 'working'
  | 'awaiting_input'
  | 'awaiting_permission'
  | 'done'
  | 'error';

export type ActivityEventType =
  | 'status_changed'
  | 'turn_started'
  | 'turn_ended'
  | 'tool_call_started'
  | 'tool_call_ended'
  | 'permission_requested'
  | 'permission_resolved'
  | 'error';

export type ActivityErrorCategory =
  | 'rate_limit'
  | 'authentication'
  | 'billing'
  | 'network'
  | 'context_overflow'
  | 'cancelled'
  | 'other';

export type PermissionResolution =
  | 'allowed'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'error';

export interface ActiveToolActivity {
  toolCallId: string;
  toolName: string;
  startedAt: string;
  displaySummary: string;
  childTaskId: string | null;
}

export interface TurnActivity {
  id: string;
  status: 'running' | 'completed';
  startedAt: string;
  endedAt: string | null;
}

export interface AwaitingPermissionActivity {
  id: string;
  toolName: string;
  displaySummary: string;
  /** Tool arguments sanitized for external display and storage. */
  args: unknown;
  requestedAt: string;
  /**
   * Cortex's per-ask nonce for this permission request, when the resolver
   * received one. Lets external readers correlate this activity record with
   * the ask identity Cortex threads through its own callbacks and events.
   */
  askId?: string;
}

export interface ActivityFinalExit {
  code: number | null;
  signal: string | null;
  reason: string;
}

export interface ActivityError {
  category: ActivityErrorCategory;
  message: string;
  occurredAt: string;
}

export interface SessionActivityState {
  version: 1;
  sessionId: string;
  status: ActivityStatus;
  updatedAt: string;
  sequence: number;
  cwd: string;
  turn: TurnActivity | null;
  activeTools: ActiveToolActivity[];
  awaitingPermission: AwaitingPermissionActivity | null;
  lastError: ActivityError | null;
  finalExit: ActivityFinalExit | null;
}

export interface ActivityEvent {
  version: 1;
  sequence: number;
  sessionId: string;
  type: ActivityEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ToolActivityInput {
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  childTaskId?: string | undefined;
}

export interface ToolEndActivityInput {
  toolCallId: string;
  toolName: string;
  durationMs?: number | undefined;
  isError?: boolean | undefined;
  error?: string | undefined;
  childTaskId?: string | undefined;
}

export interface FileSessionActivityReporterOptions {
  sessionsDir?: string | undefined;
  maxEventLogBytes?: number | undefined;
  maxRotatedEventLogs?: number | undefined;
  now?: (() => Date) | undefined;
  onWriteError?: ((error: unknown) => void) | undefined;
}

export interface PermissionRequestHandle {
  id: string;
  written: Promise<void>;
}

interface PendingEvent {
  type: ActivityEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface TextArgSummary {
  preview: string;
  bytes: number;
  lines: number;
  truncated: boolean;
}

function truncateForSummary(value: string, maxChars = 160): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars - 3) + '...';
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

export function buildActivityDisplaySummary(
  toolName: string,
  rawArgs: unknown,
): string {
  const args = toRecord(rawArgs);

  switch (toolName) {
    case 'Bash': {
      const command = firstString(args, ['command']);
      return command ? `Run shell: ${truncateForSummary(command)}` : 'Run shell';
    }
    case BASH_ESCALATION_PERMISSION_NAME: {
      // An out-of-band decider (companion app) sees only this summary, so the
      // uncontained-run stakes and the exact command must both be in it.
      const command = firstString(args, ['command']);
      return command
        ? `Run shell OUTSIDE the sandbox: ${truncateForSummary(command)}`
        : 'Run shell OUTSIDE the sandbox';
    }
    case 'Edit': {
      const filePath = firstString(args, ['file_path', 'path']);
      return filePath ? `Edit ${filePath}` : 'Edit file';
    }
    case 'Write': {
      const filePath = firstString(args, ['file_path', 'path']);
      return filePath ? `Write ${filePath}` : 'Write file';
    }
    case 'Read': {
      const filePath = firstString(args, ['file_path', 'path']);
      return filePath ? `Read ${filePath}` : 'Read file';
    }
    case 'Glob': {
      const pattern = firstString(args, ['pattern']);
      return pattern ? `Search files: ${pattern}` : 'Search files';
    }
    case 'Grep': {
      const pattern = firstString(args, ['pattern']);
      return pattern ? `Search text: ${pattern}` : 'Search text';
    }
    case 'WebFetch': {
      const url = firstString(args, ['url']);
      return url ? `Fetch ${truncateForSummary(url)}` : 'Fetch web page';
    }
    case 'SubAgent': {
      const description = firstString(args, ['description', 'instructions', 'prompt']);
      return description ? `Run sub-agent: ${truncateForSummary(description, 120)}` : 'Run sub-agent';
    }
    default:
      return `Run ${toolName}`;
  }
}

export function buildActivityPermissionArgs(
  toolName: string,
  rawArgs: unknown,
): unknown {
  const args = toRecord(rawArgs);

  switch (toolName) {
    case 'Write': {
      const filePath = firstString(args, ['file_path', 'path']);
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      return {
        file_path: filePath,
        content: summarizeTextArg(content),
      };
    }
    case 'Edit': {
      const filePath = firstString(args, ['file_path', 'path']);
      const oldString = typeof args['old_string'] === 'string' ? args['old_string'] : '';
      const newString = typeof args['new_string'] === 'string' ? args['new_string'] : '';
      return {
        file_path: filePath,
        old_string: summarizeTextArg(oldString),
        new_string: summarizeTextArg(newString),
        replace_all: Boolean(args['replace_all']),
      };
    }
    default:
      return sanitizePermissionValue(rawArgs);
  }
}

export function normalizeActivityErrorCategory(
  category: ClassifiedError['category'] | string,
): ActivityErrorCategory {
  switch (category) {
    case 'authentication':
    case 'billing':
    case 'rate_limit':
    case 'context_overflow':
    case 'network':
    case 'cancelled':
      return category;
    default:
      return 'other';
  }
}

/** An out-of-band answer to a pending permission request. */
export type ExternalDecision = 'allow' | 'deny';

/**
 * Watch a control file for an out-of-band allow/deny decision written by a
 * separate process (for example a companion app answering a native approval
 * card). Generic on purpose: the caller owns the path and the trust model; this
 * only runs the read / validate / consume / poll loop.
 *
 * - Resolves with the decision once a complete, valid file lands, and removes
 *   the file when it does so a stale answer can't resolve a later prompt.
 * - A garbled or partially written file (invalid JSON) is left in place and
 *   retried on the next tick, so a non-atomic writer can't have its decision
 *   silently dropped.
 * - Never rejects. If `signal` aborts (the prompt was answered elsewhere) it
 *   stops polling, best-effort removes any answer that landed late, and stays
 *   unresolved.
 */
export function watchDecisionFile(
  filePath: string,
  signal: AbortSignal,
  pollMs = 200,
): Promise<ExternalDecision> {
  return new Promise<ExternalDecision>((resolve) => {
    const poll = async (): Promise<void> => {
      while (!signal.aborted) {
        let raw: string | undefined;
        try {
          raw = await readFile(filePath, 'utf8');
        } catch {
          // Not written yet (ENOENT) or unreadable; keep polling.
        }
        if (raw !== undefined) {
          let parsed: { decision?: unknown } | undefined;
          try {
            parsed = JSON.parse(raw) as { decision?: unknown };
          } catch {
            // Likely a partial write: leave the file so the next tick retries
            // once the writer has finished.
          }
          if (parsed) {
            // A complete write (valid JSON): consume the file either way.
            await rm(filePath, { force: true });
            if (parsed.decision === 'allow' || parsed.decision === 'deny') {
              resolve(parsed.decision);
              return;
            }
            // Complete but malformed shape: ignore it and keep waiting.
          }
        }
        await new Promise<void>((r) => setTimeout(r, pollMs));
      }
      // Answered elsewhere: drop any decision that landed late so it doesn't
      // linger in the control directory.
      await rm(filePath, { force: true }).catch(() => {});
    };
    void poll();
  });
}

export class FileSessionActivityReporter {
  private readonly activityDir: string;
  private readonly controlDir: string;
  private readonly statePath: string;
  private readonly eventsPath: string;
  private readonly maxEventLogBytes: number;
  private readonly maxRotatedEventLogs: number;
  private readonly now: () => Date;
  private readonly onWriteError: ((error: unknown) => void) | undefined;

  private state: SessionActivityState;
  private sequence = 0;
  private turnCounter = 0;
  private queue: Promise<void> = Promise.resolve();
  private activeTools = new Map<string, ActiveToolActivity>();
  private toolStartMs = new Map<string, number>();
  private currentTurnStartMs: number | null = null;

  constructor(
    private readonly sessionId: string,
    cwd: string,
    options: FileSessionActivityReporterOptions = {},
  ) {
    const sessionsDir = options.sessionsDir ?? DEFAULT_SESSIONS_DIR;
    this.activityDir = join(sessionsDir, sessionId, 'activity');
    this.controlDir = join(sessionsDir, sessionId, 'control');
    this.statePath = join(this.activityDir, 'state.json');
    this.eventsPath = join(this.activityDir, 'events.jsonl');
    this.maxEventLogBytes = options.maxEventLogBytes ?? DEFAULT_MAX_EVENT_LOG_BYTES;
    this.maxRotatedEventLogs = options.maxRotatedEventLogs ?? DEFAULT_MAX_ROTATED_EVENT_LOGS;
    this.now = options.now ?? (() => new Date());
    this.onWriteError = options.onWriteError;

    const timestamp = this.timestamp();
    this.state = {
      version: ACTIVITY_VERSION,
      sessionId,
      status: 'working',
      updatedAt: timestamp,
      sequence: 0,
      cwd,
      turn: null,
      activeTools: [],
      awaitingPermission: null,
      lastError: null,
      finalExit: null,
    };
  }

  /**
   * Absolute path of the control file an external process writes to answer a
   * pending permission request out-of-band (for example a companion app
   * answering a native card), keyed by the permission id. It lives in a
   * `control/` sibling of `activity/` so the activity surface stays a one-way
   * contract: the agent writes `activity/`, an external answerer writes
   * `control/`, and neither reads the other's writes back. The session polls
   * this path while a prompt is open and applies the decision if it lands. See
   * `resolvePermission` in session.ts and `watchDecisionFile` above.
   */
  decisionPath(permissionId: string): string {
    return join(this.controlDir, `${permissionId}.json`);
  }

  initialize(): Promise<void> {
    const timestamp = this.timestamp();
    return this.commit([
      {
        type: 'status_changed',
        timestamp,
        payload: { from: null, to: 'working' },
      },
    ], timestamp);
  }

  recordWorking(): Promise<void> {
    return this.transitionStatus('working');
  }

  recordAwaitingInput(): Promise<void> {
    if (this.state.status === 'done' || this.state.status === 'error') return this.flush();
    this.state.awaitingPermission = null;
    return this.transitionStatus('awaiting_input');
  }

  recordTurnStarted(): void {
    const timestamp = this.timestamp();
    const turnId = `turn-${++this.turnCounter}`;
    this.currentTurnStartMs = this.nowMs();
    this.state.turn = {
      id: turnId,
      status: 'running',
      startedAt: timestamp,
      endedAt: null,
    };
    const statusEvent = this.setStatusInMemory('working', timestamp);
    void this.commit([
      ...maybeEvent(statusEvent),
      {
        type: 'turn_started',
        timestamp,
        payload: { turnId },
      },
    ], timestamp);
  }

  recordTurnEnded(): void {
    const timestamp = this.timestamp();
    const endedAtMs = this.nowMs();
    const turn = this.state.turn;
    const turnId = turn?.id ?? `turn-${++this.turnCounter}`;
    const durationMs = this.currentTurnStartMs === null
      ? 0
      : Math.max(0, endedAtMs - this.currentTurnStartMs);

    this.state.turn = {
      id: turnId,
      status: 'completed',
      startedAt: turn?.startedAt ?? timestamp,
      endedAt: timestamp,
    };
    this.currentTurnStartMs = null;

    void this.commit([
      {
        type: 'turn_ended',
        timestamp,
        payload: { turnId, durationMs },
      },
    ], timestamp);
  }

  recordToolStarted(input: ToolActivityInput): void {
    const timestamp = this.timestamp();
    const key = this.toolKey(input.toolCallId, input.childTaskId);
    const displaySummary = buildActivityDisplaySummary(input.toolName, input.args ?? {});
    const activity: ActiveToolActivity = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      startedAt: timestamp,
      displaySummary,
      childTaskId: input.childTaskId ?? null,
    };

    this.activeTools.set(key, activity);
    this.toolStartMs.set(key, this.nowMs());
    this.state.activeTools = [...this.activeTools.values()];
    const statusEvent = this.setStatusInMemory('working', timestamp);

    const payload: Record<string, unknown> = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      displaySummary,
    };
    if (input.childTaskId) payload['childTaskId'] = input.childTaskId;

    void this.commit([
      ...maybeEvent(statusEvent),
      {
        type: 'tool_call_started',
        timestamp,
        payload,
      },
    ], timestamp);
  }

  recordToolEnded(input: ToolEndActivityInput): void {
    const timestamp = this.timestamp();
    const key = this.toolKey(input.toolCallId, input.childTaskId);
    const startedMs = this.toolStartMs.get(key);
    const durationMs = input.durationMs ?? (
      startedMs === undefined ? 0 : Math.max(0, this.nowMs() - startedMs)
    );

    this.activeTools.delete(key);
    this.toolStartMs.delete(key);
    this.state.activeTools = [...this.activeTools.values()];

    const payload: Record<string, unknown> = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      durationMs,
      isError: Boolean(input.isError),
    };
    if (input.error) payload['error'] = input.error;
    if (input.childTaskId) payload['childTaskId'] = input.childTaskId;

    void this.commit([
      {
        type: 'tool_call_ended',
        timestamp,
        payload,
      },
    ], timestamp);
  }

  recordPermissionRequested(
    toolName: string,
    toolArgs: unknown,
    options?: { askId?: string },
  ): PermissionRequestHandle {
    const timestamp = this.timestamp();
    const id = `perm-${randomUUID()}`;
    const displaySummary = buildActivityDisplaySummary(toolName, toolArgs);
    const sanitizedArgs = buildActivityPermissionArgs(toolName, toolArgs);
    const permission: AwaitingPermissionActivity = {
      id,
      toolName,
      displaySummary,
      args: sanitizedArgs,
      requestedAt: timestamp,
      ...(options?.askId !== undefined ? { askId: options.askId } : {}),
    };

    this.state.awaitingPermission = permission;
    const statusEvent = this.setStatusInMemory('awaiting_permission', timestamp);

    const written = this.commit([
      ...maybeEvent(statusEvent),
      {
        type: 'permission_requested',
        timestamp,
        payload: {
          id,
          toolName,
          displaySummary,
          args: permission.args,
          ...(options?.askId !== undefined ? { askId: options.askId } : {}),
        },
      },
    ], timestamp);

    return { id, written };
  }

  recordPermissionResolved(
    id: string,
    toolName: string,
    resolution: PermissionResolution,
  ): Promise<void> {
    const timestamp = this.timestamp();
    this.state.awaitingPermission = null;
    const statusEvent = this.setStatusInMemory('working', timestamp);

    return this.commit([
      ...maybeEvent(statusEvent),
      {
        type: 'permission_resolved',
        timestamp,
        payload: { id, toolName, resolution },
      },
    ], timestamp);
  }

  recordError(error: ClassifiedError | Error | string, terminal = false): Promise<void> {
    const timestamp = this.timestamp();
    const activityError = classifyActivityError(error, timestamp);
    this.state.lastError = activityError;
    const statusEvent = terminal ? this.setStatusInMemory('error', timestamp) : null;
    if (terminal) {
      this.state.finalExit = null;
    }

    return this.commit([
      ...maybeEvent(statusEvent),
      {
        type: 'error',
        timestamp,
        payload: {
          category: activityError.category,
          message: activityError.message,
          terminal,
        },
      },
    ], timestamp);
  }

  recordDone(finalExit: ActivityFinalExit): Promise<void> {
    const timestamp = this.timestamp();
    const previous = this.state.status;
    this.state.awaitingPermission = null;
    this.activeTools.clear();
    this.toolStartMs.clear();
    this.state.activeTools = [];
    this.state.finalExit = finalExit;
    this.setStatusInMemory('done', timestamp);

    return this.commit([
      {
        type: 'status_changed',
        timestamp,
        payload: { from: previous, to: 'done', finalExit },
      },
    ], timestamp);
  }

  flush(): Promise<void> {
    return this.queue;
  }

  getStateSnapshot(): SessionActivityState {
    return safeJsonClone(this.state) as SessionActivityState;
  }

  private transitionStatus(status: ActivityStatus): Promise<void> {
    const timestamp = this.timestamp();
    const statusEvent = this.setStatusInMemory(status, timestamp);
    return this.commit(maybeEvent(statusEvent), timestamp);
  }

  private setStatusInMemory(status: ActivityStatus, timestamp: string): PendingEvent | null {
    const previous = this.state.status;
    this.state.status = status;
    this.state.updatedAt = timestamp;
    if (previous === status) return null;
    return {
      type: 'status_changed',
      timestamp,
      payload: { from: previous, to: status },
    };
  }

  private commit(events: PendingEvent[], timestamp: string): Promise<void> {
    const serializedEvents = events.map((event) => this.serializeEvent(event));
    this.state.sequence = this.sequence;
    this.state.updatedAt = timestamp;
    const stateSnapshot = safeJsonClone(this.state) as SessionActivityState;

    return this.enqueue(async () => {
      await this.ensureActivityDir();
      if (serializedEvents.length > 0) {
        await this.appendEvents(serializedEvents);
      }
      await writeJsonAtomic(this.statePath, stateSnapshot);
    });
  }

  private serializeEvent(event: PendingEvent): string {
    const activityEvent: ActivityEvent = {
      version: ACTIVITY_VERSION,
      sequence: ++this.sequence,
      sessionId: this.sessionId,
      type: event.type,
      timestamp: event.timestamp,
      payload: safeJsonClone(event.payload) as Record<string, unknown>,
    };
    return JSON.stringify(activityEvent) + '\n';
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task).catch((error: unknown) => {
      this.onWriteError?.(error);
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async ensureActivityDir(): Promise<void> {
    await mkdir(this.activityDir, { recursive: true, mode: 0o700 });
  }

  private async appendEvents(lines: string[]): Promise<void> {
    const payload = lines.join('');
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    await this.rotateEventsIfNeeded(payloadBytes);
    await appendFile(this.eventsPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  }

  private async rotateEventsIfNeeded(nextWriteBytes: number): Promise<void> {
    if (this.maxRotatedEventLogs <= 0) return;
    let currentSize = 0;
    try {
      currentSize = (await stat(this.eventsPath)).size;
    } catch {
      return;
    }

    if (currentSize + nextWriteBytes <= this.maxEventLogBytes) return;

    const oldest = this.rotatedEventsPath(this.maxRotatedEventLogs);
    await unlink(oldest).catch(() => {});

    for (let index = this.maxRotatedEventLogs - 1; index >= 1; index--) {
      await rename(
        this.rotatedEventsPath(index),
        this.rotatedEventsPath(index + 1),
      ).catch(() => {});
    }

    await rename(this.eventsPath, this.rotatedEventsPath(1)).catch(() => {});
  }

  private rotatedEventsPath(index: number): string {
    return join(this.activityDir, `events.${index}.jsonl`);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private nowMs(): number {
    return this.now().getTime();
  }

  private toolKey(toolCallId: string, childTaskId?: string): string {
    return `${childTaskId ?? 'parent'}:${toolCallId}`;
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function summarizeTextArg(text: string): TextArgSummary {
  const preview = truncateForSummary(text, MAX_PERMISSION_PREVIEW_CHARS);
  return {
    preview,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: countLines(text),
    truncated: preview.length !== text.length,
  };
}

function sanitizePermissionValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return truncateForSummary(value, MAX_GENERIC_PERMISSION_STRING_CHARS);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizePermissionValue(item, seen))
      .filter((item) => item !== undefined);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = sanitizePermissionValue(item, seen);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

function safeJsonClone(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item === 'function' || typeof item === 'symbol') return undefined;
    if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
  if (serialized === undefined) return null;
  return JSON.parse(serialized);
}

function maybeEvent(event: PendingEvent | null): PendingEvent[] {
  return event ? [event] : [];
}

function classifyActivityError(error: ClassifiedError | Error | string, occurredAt: string): ActivityError {
  if (typeof error === 'object' && error !== null && 'category' in error) {
    const classified = error as ClassifiedError;
    return {
      category: normalizeActivityErrorCategory(classified.category),
      message: classified.originalMessage,
      occurredAt,
    };
  }

  return {
    category: 'other',
    message: error instanceof Error ? error.message : String(error),
    occurredAt,
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const data = JSON.stringify(value, null, 2) + '\n';
  const handle = await open(tmpPath, 'w', 0o600);
  let shouldUnlink = true;

  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(tmpPath, path);
    shouldUnlink = false;
    await fsyncDir(dir);
  } finally {
    if (shouldUnlink) {
      await handle.close().catch(() => {});
      await unlink(tmpPath).catch(() => {});
    }
  }
}

async function fsyncDir(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort across platforms and filesystems.
  }
}
