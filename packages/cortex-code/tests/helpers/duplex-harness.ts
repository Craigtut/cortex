/**
 * Drive cortex-code against a REAL duplex CortexAgent, without a provider.
 *
 * cortex-code pins `mode: 'passthrough'`, so nothing in its own suite ever
 * saw the two-loop surface: a merged event bridge, callbacks fanned out to
 * both loops, and a reasoner that keeps working long after the talker has
 * spoken. The defects that pin conceals are only reproducible with a duplex
 * facade in the session, so this harness builds one.
 *
 * The only substitution is the pi-agent-core Agent each AgentLoop wraps:
 * `AgentLoop.create` is spied to construct a real loop over a scripted pi.
 * Everything above it (CortexAgent.create, the router, the control tools,
 * settlement predicates, the merged bridge, composite persistence) is the
 * shipped implementation.
 */

import { vi } from 'vitest';
import { AgentLoop, CortexAgent, wrapModel } from '@animus-labs/cortex';
import type { CortexAgentConfig, CortexModel } from '@animus-labs/cortex';
import { Session } from '../../src/session.js';
import { createFakeApp, type FakeApp } from './fake-app.js';

// ---------------------------------------------------------------------------
// Scripted pi agent
// ---------------------------------------------------------------------------

/** One scripted assistant turn. */
export interface ScriptedTurn {
  /** User-facing text of the assistant message ('' means a silent turn). */
  text?: string;
  /** Tool calls the message carries, executed in order like pi does. */
  calls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
}

export interface ScriptedPi {
  state: { messages: unknown[]; systemPrompt: string; tools: unknown[]; [k: string]: unknown };
  script: ScriptedTurn[];
  defaultText: string;
  /** Pause the next run after its input lands, until releaseRun(). */
  hold: boolean;
  /**
   * Pause after each turn_end, until releaseRun(). Models a long task: the
   * loop gate is held for the whole run, so nothing keyed on settlement can
   * fire, but turn boundaries keep going past.
   */
  holdAfterTurn: boolean;
  releaseRun: () => void;
  /** True between a run's start and its end. */
  running: boolean;
  /** Text chunks emitted per turn, before the turn_end. */
  streamChunks: string[];
  promptCalls: unknown[];
  emitEvent: (event: Record<string, unknown>) => void;
  prompt: (input: unknown) => Promise<unknown>;
  abort: () => void;
  [k: string]: unknown;
}

function usagePayload() {
  return {
    input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  };
}

export function createScriptedPi(): ScriptedPi {
  let handler: ((event: Record<string, unknown>) => void) | null = null;
  let release: (() => void) | null = null;
  let rejectHold: ((err: Error) => void) | null = null;
  let idleResolve: (() => void) | null = null;
  let controller: AbortController | null = null;
  let callCounter = 0;

  const pi: ScriptedPi = {
    state: { messages: [], systemPrompt: '', tools: [] },
    script: [],
    defaultText: 'ok',
    hold: false,
    holdAfterTurn: false,
    running: false,
    streamChunks: [],
    promptCalls: [],

    subscribe(cb: (event: Record<string, unknown>) => void): () => void {
      handler = cb;
      return () => { handler = null; };
    },

    emitEvent(event: Record<string, unknown>): void {
      handler?.(event);
    },

    releaseRun(): void {
      release?.();
      release = null;
      rejectHold = null;
    },

    async prompt(input: unknown): Promise<unknown> {
      pi.promptCalls.push(input);
      pi.running = true;
      const local = new AbortController();
      controller = local;
      try {
        pi.emitEvent({ type: 'agent_start' });
        const runMessages: unknown[] = Array.isArray(input)
          ? [...(input as unknown[])]
          : [{ role: 'user', content: String(input), timestamp: Date.now() }];
        pi.state.messages.push(...runMessages);

        if (pi.hold) {
          pi.hold = false;
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            rejectHold = reject;
          });
        }

        let lastText = '';
        // Bounded so a scenario that never terminates fails as a test rather
        // than as a hang.
        for (let turn = 0; turn < 20; turn++) {
          const scripted: ScriptedTurn = pi.script.shift() ?? { text: pi.defaultText };
          const text = scripted.text ?? pi.defaultText;
          lastText = text;
          const calls = scripted.calls ?? [];

          if (pi.streamChunks.length > 0) {
            pi.emitEvent({ type: 'message_start' });
            for (const chunk of pi.streamChunks) {
              pi.emitEvent({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: chunk },
              });
            }
            pi.streamChunks = [];
          }

          const content: Array<Record<string, unknown>> = [];
          if (text.length > 0) content.push({ type: 'text', text });
          const callIds: string[] = [];
          for (const call of calls) {
            callCounter += 1;
            const id = call.id ?? `call-${callCounter}`;
            callIds.push(id);
            content.push({ type: 'toolCall', id, name: call.name, arguments: call.args ?? {} });
          }

          const assistant = {
            role: 'assistant',
            content,
            stopReason: calls.length > 0 ? 'toolUse' : 'stop',
            usage: usagePayload(),
            timestamp: Date.now(),
          };
          pi.state.messages.push(assistant);
          runMessages.push(assistant);

          const toolResultMessages: unknown[] = [];
          let terminateBatch = calls.length > 0;
          for (const [index, call] of calls.entries()) {
            const callId = callIds[index]!;
            // The pi events the real EventBridge maps to tool_call_start /
            // tool_call_end, so a consumer's tool rendering is driven the way
            // production drives it rather than by a hand-built bridge event.
            pi.emitEvent({
              type: 'tool_execution_start',
              toolCallId: callId,
              toolName: call.name,
              args: call.args ?? {},
            });
            const tool = (pi.state.tools as Array<{
              name: string;
              execute: (id: string, params: unknown) => Promise<unknown>;
            }>).find((candidate) => candidate.name === call.name);
            let raw: unknown;
            let isError = false;
            if (!tool) {
              raw = { content: [{ type: 'text', text: `Unknown tool: ${call.name}` }] };
              isError = true;
            } else {
              try {
                raw = await tool.execute(callId, call.args ?? {});
              } catch (err) {
                raw = {
                  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
                };
                isError = true;
              }
            }
            const normalized = (raw && typeof raw === 'object' && 'content' in (raw as object))
              ? raw as { content: unknown; terminate?: boolean }
              : { content: [{ type: 'text', text: String(raw ?? '') }] };
            const after = await (pi['afterToolCall'] as
              | ((ctx: Record<string, unknown>) => Promise<{ content?: unknown; terminate?: boolean } | undefined>)
              | undefined)?.({
                toolCall: { name: call.name },
                assistantMessage: assistant,
                args: call.args ?? {},
                result: normalized,
                isError,
              });
            const finalContent = after?.content ?? normalized.content;
            const terminate = after?.terminate ?? normalized.terminate ?? false;
            if (!terminate) terminateBatch = false;
            pi.emitEvent({
              type: 'tool_execution_end',
              toolCallId: callId,
              toolName: call.name,
              result: { content: finalContent },
              isError,
              durationMs: 1,
            });
            const resultMessage = {
              role: 'toolResult',
              toolCallId: callId,
              toolName: call.name,
              content: finalContent,
              isError,
              timestamp: Date.now(),
            };
            toolResultMessages.push(resultMessage);
            pi.state.messages.push(resultMessage);
            runMessages.push(resultMessage);
          }

          pi.emitEvent({ type: 'turn_end', message: assistant, toolResults: toolResultMessages });

          if (pi.holdAfterTurn) {
            await new Promise<void>((resolve, reject) => {
              release = resolve;
              rejectHold = reject;
            });
          }

          if (local.signal.aborted) {
            const err = new Error('Request was aborted.');
            err.name = 'AbortError';
            throw err;
          }
          if (calls.length === 0 || terminateBatch) break;
        }

        pi.emitEvent({ type: 'agent_end', messages: runMessages });
        return { content: lastText };
      } finally {
        pi.running = false;
        controller = null;
        idleResolve?.();
        idleResolve = null;
      }
    },

    abort(): void {
      controller?.abort();
      if (rejectHold) {
        const err = new Error('Request was aborted.');
        err.name = 'AbortError';
        rejectHold(err);
      }
      release = null;
      rejectHold = null;
    },

    async continue(): Promise<unknown> {
      throw new Error('continue() is not used by these tests');
    },

    async waitForIdle(): Promise<void> {
      if (!pi.running) return;
      return new Promise<void>((resolve) => { idleResolve = resolve; });
    },

    reset(): void {
      pi.state.messages = [];
    },

    steer(message: unknown): void {
      (pi['steeringQueue'] as unknown[]).push(message);
    },

    followUp(message: unknown): void {
      (pi['followUpQueue'] as unknown[]).push(message);
    },

    clearSteeringQueue(): void {
      pi['steeringQueue'] = [];
    },

    clearFollowUpQueue(): void {
      pi['followUpQueue'] = [];
    },

    hasQueuedMessages(): boolean {
      return (pi['steeringQueue'] as unknown[]).length > 0
        || (pi['followUpQueue'] as unknown[]).length > 0;
    },
  };
  pi['steeringQueue'] = [];
  pi['followUpQueue'] = [];
  return pi;
}

// ---------------------------------------------------------------------------
// Facade assembly
// ---------------------------------------------------------------------------

type LoopCtor = new (
  agent: unknown,
  config: Record<string, unknown>,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

type LoopStatics = {
  buildPiAgentConfig: (params: {
    cortexConfig: Record<string, unknown>;
    cacheBreakpointState: { agentLoop: AgentLoop | null };
  }) => Record<string, unknown>;
  wireManagedPiAgent: (loop: AgentLoop, pi: unknown) => void;
};

export function testModel(): CortexModel {
  return wrapModel(
    { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as never,
    'anthropic',
    'claude-sonnet-4-20250514',
  );
}

export interface DuplexHarness {
  agent: CortexAgent;
  talkerLoop: AgentLoop;
  reasonerLoop: AgentLoop;
  talkerPi: ScriptedPi;
  reasonerPi: ScriptedPi;
}

const liveAgents: CortexAgent[] = [];

/** Tear down every facade a test built. Call from afterEach. */
export async function destroyHarnessAgents(): Promise<void> {
  for (const agent of liveAgents.splice(0)) {
    await agent.destroy().catch(() => {});
  }
}

/**
 * A duplex CortexAgent assembled by the real `create()`, with scripted pi
 * agents underneath. Pass the same config object cortex-code's Session
 * builds, with `mode` flipped, so what is under test is the session's own
 * wiring rather than a hand-written approximation of it.
 */
export async function createDuplexAgent(
  config: Partial<CortexAgentConfig> = {},
): Promise<DuplexHarness> {
  const statics = AgentLoop as unknown as LoopStatics;
  const LoopCtor = AgentLoop as unknown as LoopCtor;
  const built = new Map<string, { loop: AgentLoop; pi: ScriptedPi }>();

  vi.spyOn(AgentLoop, 'create').mockImplementation(async (loopConfig) => {
    const pi = createScriptedPi();
    const extras = loopConfig as {
      tools?: unknown[];
      enableSubAgentTool?: boolean;
      enableLoadSkillTool?: boolean;
      loopPath?: string;
      initialBasePrompt?: string;
    };
    const loop = new LoopCtor(pi, loopConfig as unknown as Record<string, unknown>, extras.tools ?? [], {
      enableSubAgentTool: extras.enableSubAgentTool ?? true,
      enableLoadSkillTool: extras.enableLoadSkillTool ?? true,
    });
    const agentConfig = statics.buildPiAgentConfig({
      cortexConfig: loopConfig as unknown as Record<string, unknown>,
      cacheBreakpointState: { agentLoop: loop },
    });
    pi['afterToolCall'] = agentConfig['afterToolCall'];
    pi['beforeToolCall'] = agentConfig['beforeToolCall'];
    statics.wireManagedPiAgent(loop, pi);
    // create() applies the base prompt after construction; without it the
    // facade's assertPromptable() rejects every prompt as unconfigured.
    if (typeof extras.initialBasePrompt === 'string') {
      loop.setBasePrompt(extras.initialBasePrompt);
    }
    built.set(extras.loopPath ?? 'main', { loop, pi });
    return loop;
  });

  const agent = await CortexAgent.create({
    model: testModel(),
    workingDirectory: '/tmp/cortex-code-duplex',
    initialBasePrompt: 'Test base prompt',
    ...config,
    // Duplex unless the caller's own config already says so. A session that
    // resolved its mode from the flag must reach create() carrying that mode,
    // not have it substituted here; the throw below turns a session that
    // resolved to passthrough into a loud failure rather than a silent pass.
    mode: config.mode ?? 'duplex',
    duplex: {
      minDeliverySpacingMs: 0,
      idlePollMs: 5,
      whenIdleDegradeMs: 60_000,
      watchdogIntervalMs: 3_600_000,
      idleDigestionDelayMs: 3_600_000,
      ...config.duplex,
    },
  });
  liveAgents.push(agent);

  const talker = built.get('talker');
  const reasoner = built.get('reasoner');
  if (!talker || !reasoner) throw new Error('create() did not build both resident loops');
  return {
    agent,
    talkerLoop: talker.loop,
    talkerPi: talker.pi,
    reasonerLoop: reasoner.loop,
    reasonerPi: reasoner.pi,
  };
}

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

/** The private Session surface these tests drive. */
export interface SessionInternals {
  agent: CortexAgent | null;
  app: unknown;
  sessionId: string;
  agentMode: 'passthrough' | 'duplex';
  /** Busy state keyed on work settlement. */
  work: { readonly isRunning: boolean; readonly promptInFlight: boolean; begin(): void };
  /** What the session writes to disk, and when. */
  checkpoints: {
    saver: { save: (...args: unknown[]) => void; flush: () => Promise<void> };
    writeInitial: () => Promise<void>;
  };
  buildAgentConfig: () => CortexAgentConfig;
  wireEvents: () => void;
  /** The footer and environment views over the session's state. */
  status: { pushInitialFooter: (branch: string, effortLevel: string) => void };
  handleInput: (text: string) => Promise<void>;
}

export function makeSession(cwd: string, overrides: Record<string, unknown> = {}): {
  session: Session;
  internals: SessionInternals;
} {
  const session = new Session({
    config: {} as never,
    mode: { name: 'test', systemPrompt: 'Test base prompt', contextSlots: [] } as never,
    model: {} as never,
    provider: 'test',
    modelId: 'test',
    providerManager: {} as never,
    credentialStore: {} as never,
    cwd,
    yoloMode: false,
    initialEffort: 'medium',
    resumeSessionId: undefined,
    ...overrides,
  } as never);
  return { session, internals: session as unknown as SessionInternals };
}

export interface DuplexSession {
  session: Session;
  internals: SessionInternals;
  app: FakeApp;
  harness: DuplexHarness;
}

/**
 * A Session whose declared mode is duplex, wired to a duplex facade built
 * from that same session's own config. Everything the session does with the
 * agent from here on is production code.
 */
export async function createDuplexSession(
  cwd: string,
  overrides: Record<string, unknown> = {},
  agentConfig: Partial<CortexAgentConfig> = {},
): Promise<DuplexSession> {
  // The `--duplex` flag, through the session's own resolution, rather than a
  // write to the private field: the mode these tests run under is then the
  // one a user gets, and the plumbing is under test on every duplex case in
  // the suite rather than only in the one file that asserts on the flag.
  const { session, internals } = makeSession(cwd, { duplex: true, ...overrides });
  const harness = await createDuplexAgent({
    ...internals.buildAgentConfig(),
    model: testModel(),
    ...agentConfig,
  });
  const app = createFakeApp();
  internals.agent = harness.agent;
  internals.app = app;
  internals.wireEvents();
  // Stands in for start()'s opening footer push, by calling the same method,
  // so the state a test reads is the state a real session opens with.
  internals.status.pushInitialFooter('', 'medium');
  // Stands in for start(), which checkpoints the session before it can do any
  // work and skips that for a resumed one so the saved artifact survives
  // until resume() reads it.
  if (overrides['resumeSessionId'] === undefined) {
    await internals.checkpoints.writeInitial();
  }
  return { session, internals, app, harness };
}

export interface PassthroughSession {
  session: Session;
  internals: SessionInternals;
  app: FakeApp;
  agent: CortexAgent;
  reasonerPi: ScriptedPi;
}

/**
 * The same wiring in the mode cortex-code actually ships. Keying the busy
 * state on a settlement predicate rather than on loop completion has to leave
 * the single-loop path behaving exactly as it did.
 */
export async function createPassthroughSession(
  cwd: string,
  overrides: Record<string, unknown> = {},
): Promise<PassthroughSession> {
  const { session, internals } = makeSession(cwd, overrides);
  const statics = AgentLoop as unknown as LoopStatics;
  const LoopCtor = AgentLoop as unknown as LoopCtor;
  let reasonerPi: ScriptedPi | null = null;

  vi.spyOn(AgentLoop, 'create').mockImplementation(async (loopConfig) => {
    const pi = createScriptedPi();
    reasonerPi = pi;
    const loop = new LoopCtor(pi, loopConfig as unknown as Record<string, unknown>, []);
    const agentConfig = statics.buildPiAgentConfig({
      cortexConfig: loopConfig as unknown as Record<string, unknown>,
      cacheBreakpointState: { agentLoop: loop },
    });
    pi['afterToolCall'] = agentConfig['afterToolCall'];
    statics.wireManagedPiAgent(loop, pi);
    const initial = (loopConfig as { initialBasePrompt?: string }).initialBasePrompt;
    if (typeof initial === 'string') loop.setBasePrompt(initial);
    return loop;
  });

  const agent = await CortexAgent.create({
    ...internals.buildAgentConfig(),
    model: testModel(),
  });
  liveAgents.push(agent);
  if (!reasonerPi) throw new Error('create() did not build the reasoner loop');

  const app = createFakeApp();
  internals.agent = agent;
  internals.app = app;
  internals.wireEvents();
  // See createDuplexSession: stands in for start()'s startup checkpoint.
  if (overrides['resumeSessionId'] === undefined) {
    await internals.checkpoints.writeInitial();
  }
  return { session, internals, app, agent, reasonerPi };
}

/** Put the reasoner into a long-running task and wait until it is really in it. */
export async function startHeldReasonerWork(harness: DuplexHarness): Promise<void> {
  harness.reasonerPi.hold = true;
  harness.agent.deliver('Refactor the payments module', { target: 'work' });
  await waitUntil(() => harness.reasonerPi.running, 2000, 'reasoner run started');
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

/** Poll until `predicate` holds; throws after `timeoutMs`. Never sleeps fixed. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * Let pending microtasks and short timers run. Used only to give a NEGATIVE
 * assertion ("nothing else happened") a chance to be wrong; positive
 * assertions always poll.
 */
export async function settle(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// ---------------------------------------------------------------------------
// Fan-out callback dispatch
// ---------------------------------------------------------------------------

/**
 * Fire a loop's retry and compaction callbacks the way the framework fires
 * them, **including the loop's own origin stamp**: these reach the loop's
 * own notifiers rather than fabricating a `LoopOriginContext`, so the
 * origin a consumer handler receives is the real one the loop would have
 * supplied.
 *
 * Standing in for the framework's dispatch is deliberate. What is under test
 * is whether the consumer discriminates on the origin; staging a genuine
 * transient failure or a genuine token-threshold breach would exercise the
 * framework's retry and compaction engines instead, and those have their own
 * suites.
 */
type RetryNotifier = { emit(info: unknown, origin: unknown): void };

/** The loop's turn runner owns the retry notifiers; `origin` is the loop's own. */
function retryParts(loop: AgentLoop): {
  runner: { retryScheduled: RetryNotifier; retrySucceeded: RetryNotifier };
  origin: unknown;
} {
  return (loop as unknown as { parts: ReturnType<typeof retryParts> }).parts;
}

export function fireRetryScheduled(loop: AgentLoop, info: Record<string, unknown>): void {
  const { runner, origin } = retryParts(loop);
  runner.retryScheduled.emit(info, origin);
}

export function fireRetrySucceeded(loop: AgentLoop, info: Record<string, unknown>): void {
  const { runner, origin } = retryParts(loop);
  runner.retrySucceeded.emit(info, origin);
}

export function retryScheduledInfo(delayMs = 30_000): Record<string, unknown> {
  return {
    category: 'network',
    attempt: 1,
    maxAttempts: 3,
    delayMs,
    nextAttemptAt: Date.now() + delayMs,
    originalMessage: 'connection reset',
  };
}

/**
 * Give a loop an older exchange it has already observed (one buffered chunk)
 * and a short recent one, under a 20,000-token window, so compactNow
 * swaps the older exchange out without calling the memory model.
 */
export function seedObservedExchange(loop: AgentLoop): void {
  loop.setContextWindowLimit(20_000);
  loop.restoreConversationHistory([
    { role: 'user', content: 'a'.repeat(20_000), timestamp: 1 },
    { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(20_000) }], timestamp: 2 },
    { role: 'user', content: 'the latest question', timestamp: 3 },
    { role: 'assistant', content: [{ type: 'text', text: 'c'.repeat(2_000) }], timestamp: 4 },
  ] as never);
  loop.restoreObservationalMemoryState({
    observations: '',
    continuationHint: null,
    observationTokenCount: 0,
    generationCount: 0,
    bufferedChunks: [{ observations: '* (10:00) the older exchange', messageTokensObserved: 10_000, createdAt: new Date(), endIndex: 2 }],
    bufferWatermark: 2,
  });
}
