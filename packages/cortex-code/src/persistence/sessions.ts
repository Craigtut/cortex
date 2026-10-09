import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { CortexAgentStateV2, PersistResultFn, SessionUsage } from '@animus-labs/cortex';

const SESSIONS_DIR = join(homedir(), '.cortex', 'sessions');

export interface SessionMeta {
  id: string;
  mode: string;
  provider: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  contextTokenCount: number;
  /** Accumulated session usage (cost, turns, tokens). Optional for backward compat. */
  usage?: SessionUsage;
}

export interface SavedSession {
  meta: SessionMeta;
  history: unknown[];
}

/** A session persisted as the facade's composite (v2) artifact. */
export interface SavedSessionState {
  meta: SessionMeta;
  state: CortexAgentStateV2;
}

/**
 * Filename of the composite artifact. It supersedes the v1 pair
 * (`history.json` + `observations.json`), which covered the reasoner only:
 * under duplex the reasoner holds the WORK transcript and the user's actual
 * dialogue lives on the talker, so a reasoner-only save silently drops half
 * the session and no later migration recovers it. Sessions written before
 * this file existed still load, through {@link loadSession}.
 *
 * The migration is one-way, deliberately. A session written here has no
 * `history.json`, so an older build resuming it reports "Session not found"
 * rather than loading a partial one. Writing both formats would mean every
 * save also emitting a reasoner-only artifact that is wrong under duplex,
 * which is the bug this file exists to close. The durable `transcript.jsonl`
 * is written by a separate writer and stays readable by anything.
 */
const STATE_FILE = 'state.json';

/**
 * Session history is restored into Cortex for model context, not replayed into
 * the transcript. Tool result `details` payloads are often bulky and can
 * duplicate file contents or diffs, especially for Edit/Write. Strip them
 * before persistence so autosave stays cheap during edit-heavy sessions.
 */
export function sanitizeHistoryForSave(history: unknown[]): unknown[] {
  return history.map((entry) => {
    if (typeof entry !== 'object' || entry === null || !('details' in entry)) {
      return entry;
    }

    const { details: _details, ...rest } = entry as Record<string, unknown>;
    return rest;
  });
}

function parseSessionMeta(v: unknown): SessionMeta | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const contextTokenCount = typeof o['contextTokenCount'] === 'number'
    ? o['contextTokenCount']
    : typeof o['tokenCount'] === 'number'
      ? o['tokenCount']
      : null;
  if (
    typeof o['id'] !== 'string' ||
    typeof o['mode'] !== 'string' ||
    typeof o['provider'] !== 'string' ||
    typeof o['model'] !== 'string' ||
    typeof o['cwd'] !== 'string' ||
    typeof o['createdAt'] !== 'number' ||
    typeof o['updatedAt'] !== 'number' ||
    contextTokenCount === null
  ) {
    return null;
  }

  // Fields this build does not know (older builds wrote `compactionStrategy`)
  // are ignored, so their sessions still list and resume.
  const usage = o['usage'] as SessionUsage | undefined;

  return {
    id: o['id'],
    mode: o['mode'],
    provider: o['provider'],
    model: o['model'],
    cwd: o['cwd'],
    createdAt: o['createdAt'],
    updatedAt: o['updatedAt'],
    contextTokenCount,
    ...(usage ? { usage } : {}),
  };
}

export function generateSessionId(): string {
  return randomUUID();
}

export async function saveSession(
  sessionId: string,
  history: unknown[],
  meta: SessionMeta,
): Promise<void> {
  const dir = join(SESSIONS_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  const sanitizedHistory = sanitizeHistoryForSave(history);

  await Promise.all([
    writeFile(join(dir, 'history.json'), JSON.stringify(sanitizedHistory)),
    writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2)),
  ]);
}

export async function loadSession(sessionId: string): Promise<SavedSession | null> {
  const dir = join(SESSIONS_DIR, sessionId);
  try {
    const [historyRaw, metaRaw] = await Promise.all([
      readFile(join(dir, 'history.json'), 'utf-8'),
      readFile(join(dir, 'meta.json'), 'utf-8'),
    ]);
    const history: unknown = JSON.parse(historyRaw);
    const meta: unknown = JSON.parse(metaRaw);

    if (!Array.isArray(history)) return null;
    const parsedMeta = parseSessionMeta(meta);
    if (!parsedMeta) return null;

    return { history, meta: parsedMeta };
  } catch {
    return null;
  }
}

/**
 * Strip bulky tool-result `details` from both loops' histories, the same way
 * the v1 path did for the single history it knew about.
 */
export function sanitizeStateForSave(state: CortexAgentStateV2): CortexAgentStateV2 {
  return {
    ...state,
    talkerHistory: sanitizeHistoryForSave(state.talkerHistory) as CortexAgentStateV2['talkerHistory'],
    reasonerHistory: sanitizeHistoryForSave(state.reasonerHistory) as CortexAgentStateV2['reasonerHistory'],
  };
}

export async function saveSessionState(
  sessionId: string,
  state: CortexAgentStateV2,
  meta: SessionMeta,
): Promise<void> {
  const dir = join(SESSIONS_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, STATE_FILE), JSON.stringify(sanitizeStateForSave(state))),
    writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2)),
  ]);
}

/**
 * Read a composite artifact. Returns null when this session predates the
 * composite format (or the file is unreadable), so the caller can fall back
 * to the v1 pair rather than losing the session.
 */
export async function loadSessionState(sessionId: string): Promise<SavedSessionState | null> {
  const dir = join(SESSIONS_DIR, sessionId);
  try {
    const [stateRaw, metaRaw] = await Promise.all([
      readFile(join(dir, STATE_FILE), 'utf-8'),
      readFile(join(dir, 'meta.json'), 'utf-8'),
    ]);
    const state: unknown = JSON.parse(stateRaw);
    const meta = parseSessionMeta(JSON.parse(metaRaw));
    if (!meta || !isCompositeState(state)) return null;
    return { meta, state };
  } catch {
    return null;
  }
}

function isCompositeState(v: unknown): v is CortexAgentStateV2 {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o['version'] === 2 &&
    Array.isArray(o['log']) &&
    Array.isArray(o['talkerHistory']) &&
    Array.isArray(o['reasonerHistory'])
  );
}

export async function saveObservationalState(
  sessionId: string,
  state: unknown,
): Promise<void> {
  const dir = join(SESSIONS_DIR, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'observations.json'), JSON.stringify(state));
}

export async function loadObservationalState(
  sessionId: string,
): Promise<unknown | null> {
  try {
    const raw = await readFile(join(SESSIONS_DIR, sessionId, 'observations.json'), 'utf-8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Sanitize a tool name for use in a filename. Tool names can include MCP
 * namespacing (e.g. `mcp__playwright__browser_snapshot`), which is already
 * filename-safe, but we still strip anything outside [A-Za-z0-9_-] to be safe.
 */
function safeToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Build a persistor that writes oversized tool results to
 * `~/.cortex/sessions/{sessionId}/tool-results/`. The returned absolute path
 * is embedded in the replacement text Cortex writes into the conversation, so
 * the agent can re-read the full content via the Read tool. Paths live in
 * message `content`, which survives `sanitizeHistoryForSave`, so they remain
 * valid across session reload.
 */
export function createToolResultPersistor(sessionId: string): PersistResultFn {
  const dir = join(SESSIONS_DIR, sessionId, 'tool-results');
  let dirReady: Promise<void> | null = null;

  return async (content, metadata) => {
    if (!dirReady) {
      dirReady = mkdir(dir, { recursive: true }).then(() => undefined);
    }
    await dirReady;

    const tool = safeToolName(metadata.toolName);
    let filename: string;
    if (metadata.toolCallId) {
      filename = `${tool}-${metadata.toolCallId}.md`;
    } else {
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
      const idx = metadata.messageIndex ?? 0;
      filename = `${tool}-msg${idx}-${hash}.md`;
    }

    const fullPath = join(dir, filename);
    await writeFile(fullPath, content, 'utf-8');
    return fullPath;
  };
}

export async function listSessions(): Promise<SessionMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  const sessions: SessionMeta[] = [];

  for (const entry of entries) {
    try {
      const metaRaw = await readFile(join(SESSIONS_DIR, entry, 'meta.json'), 'utf-8');
      const meta: unknown = JSON.parse(metaRaw);
      const parsedMeta = parseSessionMeta(meta);
      if (parsedMeta) sessions.push(parsedMeta);
    } catch {
      // Skip invalid session directories
    }
  }

  // Sort by most recently updated first
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  return sessions;
}

/**
 * Debounce writes of the composite artifact. The facade already debounces
 * `onStateChanged` and hands over a snapshot taken at a consistent point, so
 * this layer only coalesces bursts of disk writes; it never assembles state
 * of its own.
 */
export function createDebouncedStateSaver(
  sessionId: string,
  delayMs: number = 500,
): {
  save: (state: CortexAgentStateV2, meta: SessionMeta) => void;
  flush: () => Promise<void>;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingState: CortexAgentStateV2 | null = null;
  let pendingMeta: SessionMeta | null = null;

  const doSave = async (): Promise<void> => {
    if (!pendingState || !pendingMeta) return;
    const state = pendingState;
    const meta = pendingMeta;
    pendingState = null;
    pendingMeta = null;
    await saveSessionState(sessionId, state, meta);
  };

  return {
    save(state: CortexAgentStateV2, meta: SessionMeta): void {
      pendingState = state;
      pendingMeta = meta;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        doSave().catch(() => {
          // Swallow save errors silently
        });
      }, delayMs);
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await doSave();
    },
  };
}

/**
 * Create a debounced save function that batches rapid save calls.
 *
 * History, meta, and (optionally) observational memory state are written
 * together in the same flush so `history.json` and `observations.json` cannot
 * drift out of sync. The buffer watermark persisted in the observational state
 * indexes into the conversation history, so a stale pairing would mis-align it
 * on resume; writing them atomically keeps the watermark valid.
 *
 * Retained for reading and rewriting sessions in the pre-composite (v1)
 * layout; live sessions save through {@link createDebouncedStateSaver}.
 */
export function createDebouncedSaver(
  sessionId: string,
  delayMs: number = 500,
): {
  save: (history: unknown[], meta: SessionMeta, omState?: unknown) => void;
  flush: () => Promise<void>;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingHistory: unknown[] | null = null;
  let pendingMeta: SessionMeta | null = null;
  let pendingOmState: unknown = null;
  let hasPendingOmState = false;

  const doSave = async (): Promise<void> => {
    if (pendingHistory && pendingMeta) {
      const writes: Promise<void>[] = [saveSession(sessionId, pendingHistory, pendingMeta)];
      if (hasPendingOmState && pendingOmState != null) {
        writes.push(saveObservationalState(sessionId, pendingOmState));
      }
      await Promise.all(writes);
      pendingHistory = null;
      pendingMeta = null;
      pendingOmState = null;
      hasPendingOmState = false;
    }
  };

  return {
    save(history: unknown[], meta: SessionMeta, omState?: unknown): void {
      pendingHistory = history;
      pendingMeta = meta;
      if (omState !== undefined) {
        pendingOmState = omState;
        hasPendingOmState = true;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        doSave().catch(() => {
          // Swallow save errors silently
        });
      }, delayMs);
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await doSave();
    },
  };
}
