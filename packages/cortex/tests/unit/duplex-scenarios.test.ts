/**
 * Phase 3, item 2: scenario integration tests.
 *
 * Every other duplex suite checks a mechanism. This one checks the
 * EXPERIENCE: realistic multi-exchange sessions driven through the real
 * facade, asserting what the user and the consumer observe (what the
 * conversation said, what reached the log and in what order, what the
 * reasoner did and did NOT run) rather than what a private flag holds.
 *
 * Each scenario runs in both modes wherever it is meaningful in both. Where
 * duplex and passthrough legitimately differ, the passthrough case asserts
 * the difference instead of pretending it away: that difference is the
 * reason duplex exists.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Type } from 'typebox';
import type { AgentMessage } from '../../src/context-manager.js';
import type { CompleteFn } from '../../src/compaction/observational/types.js';
import type { CortexTool } from '../../src/tool-contract.js';
import type { ToolPermissionRequestContext } from '../../src/types.js';
import { buildBrokeredPermissionResolver } from '../../src/duplex/brokered-resolvers.js';
import {
  createDuplexScenario,
  createPassthroughScenario,
  createRealDuplexScenario,
  destroyLiveFacades,
  entriesOfType,
  duplexRouterOf,
  getBroker,
  installPermissionGate,
  lifecycleEvents,
  promptTexts,
  settle,
  stubChildAgents,
  stubLookupLoops,
  talkerHeadline,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { ScriptedPiAgent } from './duplex-scenario-harness.js';
import { partsOf } from './agent-loop/parts.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

/** A harmless stand-in for a consumer tool that needs permission. */
function deployTool(calls: string[]): CortexTool {
  return {
    name: 'Deploy',
    description: 'Deploy the current build.',
    parameters: Type.Object({ command: Type.Optional(Type.String()) }),
    execute: async (params: unknown) => {
      const command = String((params as { command?: string })?.command ?? '');
      calls.push(command);
      return `Deployed: ${command}`;
    },
  };
}

/** What the user actually heard, in order. */
function spokenLines(facade: { getLog: () => Array<{ type: string; content: string }> }): string[] {
  return facade.getLog()
    .filter((entry) => entry.type === 'reply')
    .map((entry) => entry.content);
}

// ---------------------------------------------------------------------------
// Scenario 1: a coding session with mid-work questions and a quick lookup
// ---------------------------------------------------------------------------

describe('scenario: coding session with mid-work questions and a lookup', () => {
  it('duplex answers every interruption while the work keeps running', async () => {
    const h = createDuplexScenario();
    stubLookupLoops((pi) => {
      pi.defaultText = 'resolveModel maps a model id onto a provider entry.';
    });

    // Exchange 1: the user asks for work. The talker speaks, then delegates.
    h.talkerPi.script = [{
      text: 'On it. I will look at the auth test.',
      calls: [{ name: 'spawn_task', args: { instructions: 'fix the failing auth test' } }],
    }];
    h.reasonerPi.hold = true;
    await h.facade.prompt('the auth test is failing, can you fix it?');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');

    // Exchange 2: a mid-work question, answered from the injected status
    // block. The work is not disturbed: no new reasoner run, no dispatch.
    const statusBlock = talkerHeadline(h.talkerLoop)!;
    expect(statusBlock).toContain('state="working"');
    expect(statusBlock).toContain('alias="task-1"');
    expect(statusBlock).toContain('fix the failing auth test');

    h.talkerPi.script = [{ text: 'Still working on it, no result back yet.' }];
    await h.facade.prompt('how is it going?');
    expect(h.reasonerPi.promptCalls).toHaveLength(1);
    expect(entriesOfType(h.facade, 'directive')).toHaveLength(1);

    // Exchange 3: a standalone factual question goes to a quick lookup, not
    // to the busy reasoner, and its answer comes back to the conversation.
    h.talkerPi.script = [
      {
        text: 'Let me check that.',
        calls: [{ name: 'quick_lookup', args: { question: 'what does resolveModel do?' } }],
      },
      { text: 'It maps a model id onto a provider entry.' },
    ];
    await h.facade.prompt('what does resolveModel do?');
    await waitUntil(
      () => entriesOfType(h.facade, 'lookup_result').length === 1,
      2000, 'lookup answered',
    );
    await waitUntil(() => !h.talkerLoop.isLoopActive, 2000, 'talker idle after lookup');
    // Still nothing asked of the reasoner: the lookup never touched it.
    expect(h.reasonerPi.promptCalls).toHaveLength(1);
    expect(promptTexts(h.talkerPi).some((text) => text.includes('resolveModel maps a model id')))
      .toBe(true);

    // Exchange 4: the work finishes and delivers; the talker performs it.
    h.reasonerPi.script = [{
      text: '',
      calls: [{
        name: 'Deliver',
        args: {
          content: 'Fixed the auth test: it needed a fresh token fixture.',
          wake: 'when_idle',
        },
      }],
    }];
    h.talkerPi.script = [{ text: 'Done: the auth test needed a fresh token fixture.' }];
    h.reasonerPi.releaseRun();
    await waitUntil(
      () => spokenLines(h.facade).length === 5,
      2000, 'result performed for the user',
    );

    expect(spokenLines(h.facade)).toEqual([
      'On it. I will look at the auth test.',
      'Still working on it, no result back yet.',
      'Let me check that.',
      'It maps a model id onto a provider entry.',
      'Done: the auth test needed a fresh token fixture.',
    ]);
    // One delegation, one lookup, one delivery: nothing was done twice.
    expect(entriesOfType(h.facade, 'directive')).toHaveLength(2);
    expect(entriesOfType(h.facade, 'delivery')).toHaveLength(1);
    expect(h.reasonerPi.promptCalls).toHaveLength(1);
  });

  it('passthrough serializes the same session behind the running turn', async () => {
    // The same user script with one loop: the mid-work question cannot be
    // answered until the work finishes. This is the difference duplex exists
    // for, so it is asserted rather than papered over.
    const h = createPassthroughScenario();
    h.reasonerPi.hold = true;
    h.reasonerPi.defaultText = 'Fixed the auth test.';

    const first = h.facade.prompt('the auth test is failing, can you fix it?');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');

    const second = h.facade.prompt('how is it going?');
    const third = h.facade.prompt('what does resolveModel do?');
    await settle();
    // Both follow-ups are still waiting on the held turn.
    expect(h.reasonerPi.promptCalls).toHaveLength(1);

    h.reasonerPi.releaseRun();
    await Promise.all([first, second, third]);

    expect(h.reasonerPi.promptCalls).toHaveLength(3);
    expect(promptTexts(h.reasonerPi)).toEqual([
      'the auth test is failing, can you fix it?',
      'how is it going?',
      'what does resolveModel do?',
    ]);
    // No conversation surface exists, so there is no delegation, no lookup,
    // and no delivery: the log is utterances only.
    expect(entriesOfType(h.facade, 'directive')).toHaveLength(0);
    expect(entriesOfType(h.facade, 'lookup_result')).toHaveLength(0);
    expect(entriesOfType(h.facade, 'delivery')).toHaveLength(0);
    expect(entriesOfType(h.facade, 'utterance').map((entry) => entry.content)).toEqual([
      'the auth test is failing, can you fix it?',
      'how is it going?',
      'what does resolveModel do?',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: deep research with a mid-flight redirect
// ---------------------------------------------------------------------------

describe('scenario: deep research redirected mid-flight', () => {
  it('duplex routes the redirect through the reasoner into the running sub-agent', async () => {
    const h = createDuplexScenario();
    const spawned = stubChildAgents(h.reasonerLoop, (pi) => { pi.hold = true; });

    // The user asks for research; the talker delegates.
    h.talkerPi.script = [{
      text: 'Starting the research now.',
      calls: [{ name: 'spawn_task', args: { instructions: 'survey the retrieval literature' } }],
    }];
    h.reasonerPi.defaultText = '';
    await h.facade.prompt('research the retrieval literature for me');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'reasoner dispatched');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');

    // The reasoner delegates the long part to a background sub-agent.
    const { taskId } = await h.reasonerLoop.spawnBackgroundSubAgent({
      instructions: 'read every retrieval paper you can find',
    });
    await waitUntil(() => spawned.children.length === 1, 2000, 'child running');
    const child = spawned.children[0]!;
    await waitUntil(() => child.loop.isPrompting, 2000, 'child run in flight');

    // The user changes direction mid-flight.
    h.talkerPi.script = [{
      text: 'Narrowing it to 2024 now.',
      calls: [{
        name: 'steer_task',
        args: { taskAlias: 'task-1', message: 'only cover papers from 2024' },
      }],
    }];
    h.reasonerPi.script = [{
      text: 'Redirecting the sub-agent.',
      calls: [{
        name: 'SteerSubAgent',
        args: { taskId, message: 'only cover papers from 2024' },
      }],
    }];
    await h.facade.prompt('actually, only cover 2024 papers');

    // The redirect reached the child THROUGH the reasoner (D20: no facade
    // fast-path to a named child), and did not cancel it.
    await waitUntil(
      () => child.pi.steeringQueue.length === 1,
      2000, 'child steered',
    );
    expect(String(child.pi.steeringQueue[0]!.content)).toContain('only cover papers from 2024');
    expect(h.reasonerLoop.getActiveSubAgents().map((snapshot) => snapshot.taskId))
      .toEqual([taskId]);

    // The reasoner really was the intermediary: the redirect appears in its
    // dispatch, and only then in the child.
    const dispatch = promptTexts(h.reasonerPi)[1]!;
    expect(dispatch).toContain('[Directive] Redirect for task "task-1"');
    expect(dispatch).toContain('actually, only cover 2024 papers');
    // And the user was told, before anything was dispatched.
    expect(spokenLines(h.facade)).toEqual([
      'Starting the research now.',
      'Narrowing it to 2024 now.',
    ]);

    child.pi.releaseRun();
  });

  it('a steer for a task the router never handed over is refused, not silently dropped', async () => {
    const h = createDuplexScenario();
    h.talkerPi.script = [{
      text: 'Updating that now.',
      calls: [{
        name: 'steer_task',
        args: { taskAlias: 'task-9', message: 'change direction' },
      }],
    }];
    await h.facade.prompt('change the direction of that scan');

    // A voiceable receipt, and the anomaly is in the log.
    expect(h.talkerPi.toolResults[0]!.text).toContain('No task called "task-9"');
    expect(h.talkerPi.toolResults[0]!.terminate).toBe(true);
    expect(lifecycleEvents(h.facade, 'dispatch_refused')).toHaveLength(1);
    expect(h.reasonerPi.promptCalls).toHaveLength(0);
  });

  it('passthrough steers the same running sub-agent through the same facade API', async () => {
    const h = createPassthroughScenario();
    const spawned = stubChildAgents(h.reasonerLoop, (pi) => { pi.hold = true; });

    const { taskId } = await h.reasonerLoop.spawnBackgroundSubAgent({
      instructions: 'read every retrieval paper you can find',
    });
    await waitUntil(() => spawned.children.length === 1, 2000, 'child running');
    const child = spawned.children[0]!;
    await waitUntil(() => child.loop.isPrompting, 2000, 'child run in flight');

    expect(h.facade.steerSubAgent(taskId, 'only cover papers from 2024')).toBe(true);
    await waitUntil(() => child.pi.steeringQueue.length === 1, 2000, 'child steered');
    expect(String(child.pi.steeringQueue[0]!.content)).toContain('only cover papers from 2024');
    child.pi.releaseRun();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: iterative design against the persistent reasoner
// ---------------------------------------------------------------------------

describe('scenario: iterative design against the persistent reasoner', () => {
  const EXCHANGES = [
    'lets design the caching layer',
    'use an LRU rather than a TTL',
    'what about the cold start case?',
    'add a write-through path too',
    'and make the eviction metric observable',
    'summarize the design we landed on',
  ];

  it('duplex accumulates one reasoner context across many exchanges', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.defaultText = '';
    const before = h.reasonerLoop;

    for (const [index, utterance] of EXCHANGES.entries()) {
      h.talkerPi.script = [{
        text: `Passing that along (${index + 1}).`,
        calls: [{ name: 'spawn_task', args: { instructions: `design step ${index + 1}` } }],
      }];
      await h.facade.prompt(utterance);
      await waitUntil(
        () => h.reasonerPi.promptCalls.length === index + 1,
        2000, `dispatch ${index + 1}`,
      );
      await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, `reasoner idle ${index + 1}`);
    }

    // One loop, six runs. This is the whole reason for a single persistent
    // reasoner rather than a task pool.
    expect(h.reasonerLoop).toBe(before);
    expect(h.reasonerPi.promptCalls).toHaveLength(EXCHANGES.length);

    // Its context accumulated: the first exchange is still in the history at
    // the end, alongside the last.
    const history = h.reasonerLoop.getConversationHistory();
    const historyText = JSON.stringify(history);
    expect(historyText).toContain('lets design the caching layer');
    expect(historyText).toContain('summarize the design we landed on');
    expect(history.length).toBeGreaterThan(EXCHANGES.length);

    // Pointer, not paraphrase: each dispatch carries only the NEW
    // conversation, because the reasoner already holds the rest.
    const lastDispatch = promptTexts(h.reasonerPi)[EXCHANGES.length - 1]!;
    expect(lastDispatch).toContain('summarize the design we landed on');
    expect(lastDispatch).not.toContain('lets design the caching layer');

    // Usage accumulates on the one loop rather than restarting per exchange.
    expect(h.reasonerLoop.getSessionUsage().totalTurns)
      .toBeGreaterThanOrEqual(EXCHANGES.length);
  });

  it('passthrough accumulates the same context on its single loop', async () => {
    const h = createPassthroughScenario();
    h.reasonerPi.defaultText = 'noted';
    for (const utterance of EXCHANGES) {
      await h.facade.prompt(utterance);
    }

    expect(h.reasonerPi.promptCalls).toHaveLength(EXCHANGES.length);
    const historyText = JSON.stringify(h.reasonerLoop.getConversationHistory());
    expect(historyText).toContain('lets design the caching layer');
    expect(historyText).toContain('summarize the design we landed on');
    expect(h.reasonerLoop.getSessionUsage().totalTurns)
      .toBeGreaterThanOrEqual(EXCHANGES.length);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3b: the same reasoner, across a real compaction
// ---------------------------------------------------------------------------

/**
 * Scenario 3 proves the reasoner loop is not thrown away between exchanges.
 * That is only half the persistent-reasoner argument: architecture.md answers
 * context rot with "compaction is controlled forgetting", so the other half
 * is that a session which actually crosses a threshold keeps its accumulated
 * understanding. Six short exchanges never come close to a threshold, so
 * nothing tested that until here.
 *
 * The threshold is lowered rather than the content inflated, and the session
 * is driven through the real create() so the staggered thresholds and the
 * facade's idle-digestion scheduling are the ones under test.
 *
 * Observer and reflector are model calls. They are stubbed, so this asserts
 * STRUCTURE and RETENTION (what the observer was shown, what survives in
 * context afterwards, what shape both transcripts are left in) and never
 * summary quality. Whether a real observer writes a good observation is a
 * model question no unit test answers.
 */
describe('scenario: the persistent reasoner across a compaction', () => {
  const EARLY_FACT = 'cache key is tenant id plus route';
  const LATE_FACT = 'eviction metric is a counter per tenant';

  /** Bulk that makes an exchange cost real context, as long work does. */
  function bulk(label: string): string {
    return `${label} ${'detail '.repeat(700)}`;
  }

  /**
   * Stub observer/reflector for one loop. It reports back what it was
   * actually shown, so "the early fact survived" means the pipeline carried
   * it, not that the test wrote it into the slot itself.
   */
  function stubObserver(loop: {
    getCompactionManager: () => { setObservationalCompleteFn: (fn: CompleteFn) => void };
  }, seen: string[]): void {
    loop.getCompactionManager().setObservationalCompleteFn(async (context) => {
      const text = JSON.stringify(context.messages);
      seen.push(text);
      const carried = text.includes(EARLY_FACT)
        ? `Design decision: ${EARLY_FACT}`
        : 'Design decision: (the early exchange was already gone)';
      return [
        '<observations>',
        'Date: Apr 10, 2026',
        '',
        `* \u{1F7E1} (10:00) ${carried}`,
        '</observations>',
        '',
        '<current-task>',
        'Designing the caching layer.',
        '</current-task>',
        '',
        '<suggested-response>',
        'Continue.',
        '</suggested-response>',
      ].join('\n');
    });
  }

  /** Tool calls and their results must pair up, in order, on every loop. */
  function assertTranscriptShape(messages: AgentMessage[]): void {
    const open = new Set<string>();
    for (const message of messages) {
      const record = message as unknown as {
        role: string;
        content?: unknown;
        toolCallId?: string;
      };
      if (record.role === 'assistant' && Array.isArray(record.content)) {
        for (const block of record.content as Array<{ type?: string; id?: string }>) {
          if (block.type === 'toolCall' && block.id) open.add(block.id);
        }
      }
      if (record.role === 'toolResult') {
        expect(open.has(String(record.toolCallId))).toBe(true);
        open.delete(String(record.toolCallId));
      }
    }
    // Nothing left hanging: every call this transcript makes was answered.
    expect([...open]).toEqual([]);
  }

  it('keeps one reasoner, and the early design, across a compaction it really crosses', async () => {
    const observerSaw: string[] = [];
    const talkerObserverSaw: string[] = [];
    const h = await createRealDuplexScenario({
      // Small window plus a low activation threshold: the session crosses a
      // real threshold instead of being handed a pre-compacted history.
      contextWindowLimit: 12_000,
      compaction: {
        observational: { activationThreshold: 0.35 },
      },
      duplex: { idleDigestionDelayMs: 5 },
    });
    stubObserver(h.reasonerLoop, observerSaw);
    stubObserver(h.talkerLoop, talkerObserverSaw);
    const reasonerBefore = h.reasonerLoop;

    // Exchange 1 establishes the fact everything later depends on.
    h.talkerPi.script = [{
      text: 'Starting the design.',
      calls: [{ name: 'spawn_task', args: { instructions: 'design the caching layer' } }],
    }];
    h.reasonerPi.script = [{ text: bulk(`Noted: the ${EARLY_FACT}.`) }];
    await h.facade.prompt(`lets design the caching layer, the ${EARLY_FACT}`);
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'first dispatch');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');

    // Several more exchanges pile context on top of it. Each reasoner run
    // makes a real tool call, so its transcript carries tool-call groups
    // that a badly placed compaction boundary could split.
    for (const [index, utterance] of [
      'use an LRU rather than a TTL',
      'what about the cold start case?',
      'add a write-through path too',
      `and make the eviction metric observable: the ${LATE_FACT}`,
    ].entries()) {
      h.talkerPi.script = [{
        text: `Passing that along (${index + 2}).`,
        calls: [{ name: 'steer_task', args: { taskAlias: 'task-1', message: utterance } }],
      }];
      h.reasonerPi.script = [
        {
          text: bulk(`Working on step ${index + 2}.`),
          calls: [{
            name: 'Deliver',
            args: { content: `Step ${index + 2} noted.`, wake: 'silent' },
          }],
        },
        { text: `Step ${index + 2} done.` },
      ];
      await h.facade.prompt(utterance);
      await waitUntil(
        () => h.reasonerPi.promptCalls.length === index + 2,
        2000, `dispatch ${index + 2}`,
      );
      await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, `reasoner idle ${index + 2}`);
    }
    // The transcripts really do carry tool-call groups going in.
    expect(
      h.reasonerLoop.getConversationHistory().filter((m) => String(m.role) === 'toolResult').length,
    ).toBeGreaterThan(0);

    const historyBefore = h.reasonerLoop.getConversationHistory().length;

    // The facade's idle digestion is where the blocking pass runs in duplex
    // (architecture.md: it fires while nobody is waiting).
    await waitUntil(() => observerSaw.length > 0, 3000, 'observer ran');
    await waitUntil(
      () => h.reasonerLoop.getObservationalMemoryState().observations.length > 0,
      3000, 'observations landed in context',
    );

    // Compaction really fired: the raw transcript shed messages.
    await waitUntil(
      () => h.reasonerLoop.getConversationHistory().length < historyBefore,
      3000, 'source history compacted',
    );

    // The observer was shown the early exchange, and what it wrote is what
    // the loop now carries in context.
    expect(observerSaw.some((seen) => seen.includes(EARLY_FACT))).toBe(true);
    const observations = h.reasonerLoop.getObservationalMemoryState().observations;
    expect(observations).toContain(EARLY_FACT);
    expect(observations).not.toContain('the early exchange was already gone');

    // Same loop object, same session, one reasoner. Forgetting happened
    // inside it rather than by replacing it.
    expect(h.reasonerLoop).toBe(reasonerBefore);
    expect(h.reasonerLoop.state).toBe('active');

    // The conversation carries on, and the next dispatch still lands.
    h.talkerPi.script = [{
      text: 'Summarizing now.',
      calls: [{ name: 'steer_task', args: { taskAlias: 'task-1', message: 'summarize it' } }],
    }];
    h.reasonerPi.script = [{ text: 'Here is the design we landed on.' }];
    const dispatchesBefore = h.reasonerPi.promptCalls.length;
    await h.facade.prompt('summarize the design we landed on');
    await waitUntil(
      () => h.reasonerPi.promptCalls.length === dispatchesBefore + 1,
      2000, 'post-compaction dispatch',
    );
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle after summary');

    // Neither transcript was left with an orphaned tool call.
    assertTranscriptShape(h.reasonerLoop.getConversationHistory());
    assertTranscriptShape(h.talkerLoop.getConversationHistory());

    // And on the wire the early fact is genuinely reachable: right after the
    // system head, the message array pi would send opens with the
    // observations slot carrying it, even though the raw exchange that
    // stated it is gone from the transcript. That is the whole "controlled
    // forgetting" claim.
    const wire = h.reasonerPi.state.messages;
    expect(String(wire[0]?.role)).toBe('system');
    expect(String(wire[1]?.role)).toBe('user');
    expect(JSON.stringify(wire[1]?.content)).toContain(EARLY_FACT);
    expect(JSON.stringify(h.reasonerLoop.getConversationHistory())).not.toContain(EARLY_FACT);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: permission brokering through conversation
// ---------------------------------------------------------------------------

describe('scenario: permission brokering through conversation', () => {
  /**
   * A duplex session whose reasoner has an ask-gated consumer tool wired
   * through the REAL permission gate and the REAL brokered resolver, so a
   * scripted tool call genuinely blocks on a spoken decision.
   */
  function brokeredScenario(overrides?: { askTimeoutMs?: number; watchdogIntervalMs?: number }) {
    const h = createDuplexScenario(
      overrides !== undefined
        ? {
            duplex: {
              ...(overrides.askTimeoutMs !== undefined ? { askTimeoutMs: overrides.askTimeoutMs } : {}),
              ...(overrides.watchdogIntervalMs !== undefined
                ? { watchdogIntervalMs: overrides.watchdogIntervalMs }
                : {}),
            },
          }
        : undefined,
    );
    const deployed: string[] = [];
    h.reasonerLoop.addConsumerTool(deployTool(deployed));
    installPermissionGate(
      h.reasonerLoop,
      h.reasonerPi,
      buildBrokeredPermissionResolver(
        async () => ({ decision: 'ask' }),
        undefined,
        () => getBroker(h.facade),
      ),
    );
    return { ...h, deployed };
  }

  /** Ask id of the pending ask, read the way a talker reads the voicing. */
  function pendingAskId(facade: ReturnType<typeof createDuplexScenario>['facade']): string {
    const ask = entriesOfType(facade, 'ask').at(-1)!;
    return String((ask.data as { askId: string }).askId);
  }

  it('voices the verbatim request, settles it from the user answer, and the work proceeds', async () => {
    const h = brokeredScenario();

    // The reasoner reaches an ask-gated tool while working.
    h.reasonerPi.script = [
      {
        text: 'Deploying.',
        calls: [{ name: 'Deploy', args: { command: 'ship --prod && rm -rf ~/stale' } }],
      },
      { text: 'Deployed.' },
    ];
    h.talkerPi.script = [{ text: 'Kicking that off.', calls: [{ name: 'spawn_task', args: { instructions: 'deploy' } }] }];
    // The voicing wakes the talker; that run reads the request out.
    h.talkerPi.script.push({
      text: 'It wants to run: ship --prod && rm -rf ~/stale. Allow that?',
    });
    await h.facade.prompt('please deploy');

    await waitUntil(() => entriesOfType(h.facade, 'ask').length === 1, 2000, 'ask raised');
    // The user was read the actual command, with its tail intact.
    const voiced = promptTexts(h.talkerPi).find((text) => text.includes('permission-request'))!;
    expect(voiced).toContain('ship --prod && rm -rf ~/stale');
    expect(h.deployed).toHaveLength(0);
    await waitUntil(() => !h.talkerLoop.isLoopActive, 2000, 'talker idle');

    // The user answers after hearing it.
    const askId = pendingAskId(h.facade);
    h.talkerPi.script = [{
      text: 'Approving that.',
      calls: [{ name: 'answer_ask', args: { askId, decision: 'allow' } }],
    }];
    await h.facade.prompt('yes, go ahead');

    await waitUntil(() => h.deployed.length === 1, 2000, 'tool ran after approval');
    expect(h.deployed[0]).toBe('ship --prod && rm -rf ~/stale');
    // The audit trail ties the approval to the words that granted it.
    const answer = entriesOfType(h.facade, 'ask_answer')[0]!;
    const yes = entriesOfType(h.facade, 'utterance').find((entry) => entry.content === 'yes, go ahead')!;
    expect(answer.data).toMatchObject({ decision: 'allow' });
    expect(answer.causedBy).toBe(yes.seq);
  });

  it('reports a read-out tool ask as voiced on the consumer surface, from the broker', async () => {
    const h = brokeredScenario();
    h.reasonerPi.script = [
      { text: 'Deploying.', calls: [{ name: 'Deploy', args: { command: 'ship --prod' } }] },
      { text: 'Stopped.' },
    ];
    h.talkerPi.script = [
      { text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'deploy' } }] },
      { text: 'It wants to run ship --prod. Allow that?' },
    ];
    await h.facade.prompt('please deploy');
    await waitUntil(() => entriesOfType(h.facade, 'ask').length === 1, 2000, 'ask raised');
    await waitUntil(() => !h.talkerLoop.isLoopActive, 2000, 'request read out');
    const askId = pendingAskId(h.facade);

    // Duplex never marks the loop registry: whether the user heard a
    // request is the broker's fact, and the facade overlays it.
    expect(h.reasonerLoop.getPendingAsks()).toMatchObject([{ askId, voiced: false }]);
    expect(h.facade.getPendingAsks()).toMatchObject([{ askId, voiced: true }]);
    expect(h.facade.getPendingAsks()).toHaveLength(1);

    getBroker(h.facade).answer(askId, 'deny', undefined);
    await waitUntil(() => h.facade.getPendingAsks().length === 0, 2000, 'ask settled');
  });

  /** Raise an ask, read it out, and leave the talker idle. Returns its id. */
  async function voicedAsk(h: ReturnType<typeof brokeredScenario>): Promise<string> {
    h.reasonerPi.script = [
      { text: 'Deploying.', calls: [{ name: 'Deploy', args: { command: 'ship --prod' } }] },
      { text: 'Deployed.' },
    ];
    h.talkerPi.script = [
      { text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'deploy' } }] },
      { text: 'It wants to run ship --prod. Allow that?' },
    ];
    await h.facade.prompt('please deploy');
    await waitUntil(() => entriesOfType(h.facade, 'ask').length === 1, 2000, 'ask raised');
    await waitUntil(() => !h.talkerLoop.isLoopActive, 2000, 'request read out');
    return pendingAskId(h.facade);
  }

  it('accepts a yes steered into a live talker turn, from the turn after it lands', async () => {
    const h = brokeredScenario();
    const askId = await voicedAsk(h);

    h.talkerPi.hold = true;
    h.talkerPi.script = [
      { text: 'Take your time.' },
      { text: 'Approving that.', calls: [{ name: 'answer_ask', args: { askId, decision: 'allow' } }] },
    ];
    void h.facade.prompt('hmm, let me think about it');
    await waitUntil(() => h.talkerLoop.isPrompting, 2000, 'talker turn live');
    h.facade.steer('yes, go ahead');

    // Logged as the user's words the moment they arrive.
    const yes = entriesOfType(h.facade, 'utterance').find((entry) => entry.content === 'yes, go ahead');
    expect(yes).toBeDefined();

    h.talkerPi.releaseRun();
    await waitUntil(() => h.deployed.length === 1, 2000, 'tool ran after approval');
    // One talker run: the steer joined the live turn rather than a later run.
    expect(h.talkerPi.promptCalls).toHaveLength(3);
    const answer = entriesOfType(h.facade, 'ask_answer')[0]!;
    expect(answer.data).toMatchObject({ decision: 'allow' });
    expect(answer.causedBy).toBe(yes!.seq);
  });

  it('refuses a steered yes in the run that is reading the request out', async () => {
    const h = brokeredScenario();
    h.reasonerPi.script = [
      { text: 'Deploying.', calls: [{ name: 'Deploy', args: { command: 'ship --prod' } }] },
      { text: 'Stopped.' },
    ];
    h.talkerPi.script = [
      { text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'deploy' } }] },
    ];
    await h.facade.prompt('please deploy');
    await waitUntil(() => entriesOfType(h.facade, 'ask').length === 1, 2000, 'ask raised');
    await waitUntil(() => !h.talkerLoop.isLoopActive, 2000, 'voicing run over');
    const askId = pendingAskId(h.facade);

    // The next talker run carries a fresh voicing; the user's steered yes
    // lands inside that same run.
    h.talkerPi.hold = true;
    h.talkerPi.script = [
      { text: 'It wants to run ship --prod. Allow that?' },
      { text: 'Approving that.', calls: [{ name: 'answer_ask', args: { askId, decision: 'allow' } }] },
      { text: 'Okay.' },
    ];
    // A conversation abort's hold, then input reopening it: a fresh read-out.
    getBroker(h.facade).holdVoicing();
    getBroker(h.facade).reopenVoicing();
    await waitUntil(() => h.talkerLoop.isPrompting, 2000, 'voicing run live');
    h.facade.steer('yes');
    h.talkerPi.releaseRun();
    await waitUntil(
      () => h.talkerPi.toolResults.some((result) => result.name === 'answer_ask'),
      2000, 'answer attempted',
    );
    await waitUntil(() => !h.talkerLoop.isLoopActive, 2000, 'talker idle');

    // Refused for carrying the voicing, not for lacking the user's words:
    // the steered yes did join the run.
    const refusals = lifecycleEvents(h.facade, 'dispatch_refused')
      .map((entry) => (entry.data as { reason?: string }).reason);
    expect(refusals).toContain('allow from the run that carried the voicing');
    expect(entriesOfType(h.facade, 'ask_answer')).toHaveLength(0);
    expect(h.deployed).toHaveLength(0);
    expect(getBroker(h.facade).pendingAskCount).toBe(1);
    getBroker(h.facade).answer(askId, 'deny', undefined);
  });

  it('keeps the broker the only writer of voiced: markAskVoiced cannot mark an unheard ask', async () => {
    const h = brokeredScenario();
    // The talker refuses the voicing, so the broker never reads it out.
    const original = h.talkerLoop.deliver.bind(h.talkerLoop);
    const deliver = vi.spyOn(h.talkerLoop, 'deliver').mockImplementation((content, options) => {
      if (content.includes('permission-request')) throw new Error('talker unavailable');
      return original(content, options);
    });
    h.reasonerPi.script = [
      { text: 'Deploying.', calls: [{ name: 'Deploy', args: { command: 'ship --prod' } }] },
      { text: 'Stopped.' },
    ];
    h.talkerPi.script = [{ text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'deploy' } }] }];
    await h.facade.prompt('please deploy');
    await waitUntil(() => entriesOfType(h.facade, 'ask').length === 1, 2000, 'ask raised');
    const askId = pendingAskId(h.facade);
    // Precondition: the loop registry holds the ask, and nobody heard it.
    expect(h.reasonerLoop.getPendingAsks().map((ask) => ask.askId)).toEqual([askId]);
    expect(h.facade.getPendingAsks()).toMatchObject([{ askId, voiced: false }]);

    expect(h.facade.markAskVoiced(askId)).toBe(false);
    expect(h.facade.getPendingAsks()).toMatchObject([{ askId, voiced: false }]);

    deliver.mockRestore();
    getBroker(h.facade).answer(askId, 'deny', undefined);
    await waitUntil(() => h.facade.getPendingAsks().length === 0, 2000, 'ask settled');
  });

  it('the watchdog tells the conversation the work is waiting on the user, without retiring it', async () => {
    const h = brokeredScenario({ watchdogIntervalMs: 60 });
    h.reasonerPi.script = [
      { text: 'Deploying.', calls: [{ name: 'Deploy', args: { command: 'ship --prod' } }] },
      { text: 'Stopped.' },
    ];
    h.talkerPi.script = [
      { text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'deploy' } }] },
      { text: 'It wants to run ship --prod. Allow that?' },
    ];
    await h.facade.prompt('please deploy');
    await waitUntil(() => entriesOfType(h.facade, 'ask').length === 1, 2000, 'ask raised');

    // The run is blocked on the user and silent: the watchdog speaks.
    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').some((entry) => entry.content.includes('permission answer')),
      2000, 'watchdog note',
    );
    const note = entriesOfType(h.facade, 'delivery')
      .find((entry) => entry.content.includes('permission answer'))!;
    expect(note.content).toContain('Background work (task-1) is paused waiting for the user');
    expect(note.content).toContain('(Deploy)');
    expect(note.data).toMatchObject({ synthetic: true, proposedWake: 'when_idle' });
    // A progress note concludes nothing: the task is still live work.
    expect(duplexRouterOf(h.facade).activeAliases()).toEqual(['task-1']);

    getBroker(h.facade).answer(pendingAskId(h.facade), 'deny', undefined);
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner done');
  });

  it('the watchdog reports a silent run with no ask as still running', async () => {
    const h = brokeredScenario({ watchdogIntervalMs: 60 });
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{ text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'index everything' } }] }];
    await h.facade.prompt('index everything');
    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').some((entry) => entry.content.includes('still running')),
      2000, 'watchdog note',
    );
    expect(duplexRouterOf(h.facade).activeAliases()).toEqual(['task-1']);
    h.reasonerPi.releaseRun();
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner done');
  });

  it('an unanswered ask times out as a deny the reasoner can see', async () => {
    const h = brokeredScenario({ askTimeoutMs: 40 });
    h.reasonerPi.script = [
      { text: 'Deploying.', calls: [{ name: 'Deploy', args: { command: 'ship --prod' } }] },
      { text: 'I could not deploy: permission was denied.' },
    ];
    h.talkerPi.script = [
      { text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'deploy' } }] },
      { text: 'It needs permission to run ship --prod.' },
    ];
    await h.facade.prompt('please deploy');

    await waitUntil(() => entriesOfType(h.facade, 'ask').length === 1, 2000, 'ask raised');
    // Nobody answers. The ask settles itself and unblocks the run.
    await waitUntil(
      () => entriesOfType(h.facade, 'ask_answer').length === 1,
      2000, 'ask timed out',
    );
    const answer = entriesOfType(h.facade, 'ask_answer')[0]!;
    expect(answer.data).toMatchObject({ decision: 'deny', timedOut: true });
    expect(h.deployed).toHaveLength(0);

    // The reasoner sees the denial as its tool result and keeps going.
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner unblocked');
    const blocked = h.reasonerPi.toolResults.find((result) => result.name === 'Deploy')!;
    expect(blocked.text).toContain('timed out');
    expect(getBroker(h.facade).pendingAskCount).toBe(0);
  });

  it("abort('work') settles a pending ask as a deny and records why", async () => {
    const h = brokeredScenario();
    h.reasonerPi.script = [
      { text: 'Deploying.', calls: [{ name: 'Deploy', args: { command: 'ship --prod' } }] },
    ];
    h.talkerPi.script = [
      { text: 'On it.', calls: [{ name: 'spawn_task', args: { instructions: 'deploy' } }] },
      { text: 'It needs permission to run ship --prod.' },
    ];
    await h.facade.prompt('please deploy');
    await waitUntil(() => entriesOfType(h.facade, 'ask').length === 1, 2000, 'ask raised');

    await h.facade.abort('work');

    await waitUntil(
      () => getBroker(h.facade).pendingAskCount === 0,
      2000, 'ask settled by the abort',
    );
    expect(h.deployed).toHaveLength(0);
    // A tool ask carries the run's abort signal, so the abort race settles
    // it and records ask_aborted; the broker's own settleAll would record
    // ask_dropped for an ask with no signal (a network ask). Exactly one
    // settlement record either way: an ask never vanishes unexplained.
    const settled = [
      ...lifecycleEvents(h.facade, 'ask_aborted'),
      ...lifecycleEvents(h.facade, 'ask_dropped'),
    ];
    expect(settled).toHaveLength(1);
    expect(settled[0]!.causedBy).toBe(entriesOfType(h.facade, 'ask')[0]!.seq);
    // No answer was recorded, because nobody answered.
    expect(entriesOfType(h.facade, 'ask_answer')).toHaveLength(0);
  });

  it('passthrough bypasses the broker entirely: the consumer resolver decides', async () => {
    const h = createPassthroughScenario();
    const deployed: string[] = [];
    h.reasonerLoop.addConsumerTool(deployTool(deployed));
    const seen: Array<{ toolName: string; context?: ToolPermissionRequestContext }> = [];
    installPermissionGate(h.reasonerLoop, h.reasonerPi, async (toolName, _args, context) => {
      seen.push({ toolName, ...(context ? { context } : {}) });
      return { decision: 'allow' };
    });

    h.reasonerPi.script = [
      { text: 'Deploying.', calls: [{ name: 'Deploy', args: { command: 'ship --prod' } }] },
      { text: 'Deployed.' },
    ];
    await h.facade.prompt('please deploy');

    // The consumer's own callback decided, with the P1 origin context.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolName).toBe('Deploy');
    expect(seen[0]!.context?.renderedRequest).toContain('ship --prod');
    expect(deployed).toEqual(['ship --prod']);
    // Nothing was brokered: no ask reached the log, nothing was voiced.
    expect(entriesOfType(h.facade, 'ask')).toHaveLength(0);
    expect(entriesOfType(h.facade, 'ask_answer')).toHaveLength(0);
    expect(lifecycleEvents(h.facade, 'ask_voiced')).toHaveLength(0);
  });

  it('a denial in passthrough reaches the loop exactly as the consumer wrote it', async () => {
    const h = createPassthroughScenario();
    const deployed: string[] = [];
    h.reasonerLoop.addConsumerTool(deployTool(deployed));
    installPermissionGate(h.reasonerLoop, h.reasonerPi, async () => ({
      decision: 'deny',
      reason: 'Production deploys are disabled in this session.',
    }));

    h.reasonerPi.script = [
      { text: 'Deploying.', calls: [{ name: 'Deploy', args: { command: 'ship --prod' } }] },
      { text: 'Cannot deploy.' },
    ];
    await h.facade.prompt('please deploy');

    expect(deployed).toHaveLength(0);
    const blocked = h.reasonerPi.toolResults.find((result) => result.name === 'Deploy')!;
    expect(blocked.text).toContain('Production deploys are disabled in this session.');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: passthrough parity against the post-P0/P1 baseline
// ---------------------------------------------------------------------------

describe('scenario: passthrough parity over a whole session', () => {
  /** Drive one multi-exchange session and report everything observable. */
  async function runSession(
    pi: ScriptedPiAgent,
    prompt: (input: string) => Promise<unknown>,
  ): Promise<{
    prompts: string[];
    results: unknown[];
    history: string;
    turns: number;
  }> {
    const results: unknown[] = [];
    pi.defaultText = 'done';
    for (const utterance of ['read the config', 'now change the port', 'and restart it']) {
      results.push(await prompt(utterance));
    }
    return {
      prompts: promptTexts(pi),
      results,
      // Timestamps are wall-clock and differ between two sessions run
      // back to back whenever a millisecond boundary falls between them;
      // comparing them compares the clock, not the behavior.
      history: JSON.stringify(pi.state.messages).replace(/"timestamp":\d+/g, '"timestamp":0'),
      turns: pi.modelCalls,
    };
  }

  it('a facade session and a bare AgentLoop session are indistinguishable', async () => {
    const direct = createPassthroughScenario();
    const viaFacade = createPassthroughScenario();

    const baseline = await runSession(
      direct.reasonerPi,
      (input) => direct.reasonerLoop.prompt(input),
    );
    const facadeRun = await runSession(
      viaFacade.reasonerPi,
      (input) => viaFacade.facade.prompt(input),
    );

    expect(facadeRun.prompts).toEqual(baseline.prompts);
    expect(facadeRun.results).toEqual(baseline.results);
    expect(facadeRun.turns).toBe(baseline.turns);
    expect(facadeRun.history).toBe(baseline.history);
    // The facade adds a log the bare loop has no equivalent of; that is the
    // one addition, and it is additive rather than a behavior change.
    expect(entriesOfType(viaFacade.facade, 'utterance')).toHaveLength(3);
  });

  it('pins the documented abort divergence rather than papering over it', async () => {
    // facade-api.md: a facade abort clears queued content that a direct
    // AgentLoop.abort() retains. A consumer migrating must re-issue.
    const direct = createPassthroughScenario();
    const viaFacade = createPassthroughScenario();

    direct.reasonerPi.hold = true;
    const directTurn = direct.reasonerLoop.prompt('start');
    await waitUntil(() => direct.reasonerPi.promptCalls.length === 1, 2000, 'direct running');
    direct.reasonerLoop.steer('extra direction');
    await direct.reasonerLoop.abort();
    await directTurn.catch(() => {});

    viaFacade.reasonerPi.hold = true;
    const facadeTurn = viaFacade.facade.prompt('start');
    await waitUntil(() => viaFacade.reasonerPi.promptCalls.length === 1, 2000, 'facade running');
    viaFacade.facade.steer('extra direction');
    await viaFacade.facade.abort();
    await facadeTurn.catch(() => {});

    // The steered content survives a direct abort and does not survive a
    // facade abort. Intended, documented, and asserted.
    expect(direct.reasonerPi.steeringQueue).toHaveLength(1);
    expect(viaFacade.reasonerPi.steeringQueue).toHaveLength(0);
  });

  it('records the queued content a facade abort drops, where the loop can report it', async () => {
    // Pi's own steering queue cannot be inspected, so content cleared there
    // leaves no record; loop-owned queued content does, and that is what
    // keeps a facade abort from swallowing a consumer's input silently.
    const h = createPassthroughScenario();
    h.reasonerPi.hold = true;
    const turn = h.facade.prompt('start');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'running');
    h.facade.deliver('a note for later', { wake: false });

    await h.facade.abort();
    await turn.catch(() => {});

    const dropped = lifecycleEvents(h.facade, 'queued_content_dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.data).toMatchObject({ reason: 'abort' });
    expect(JSON.stringify(dropped[0]!.data)).toContain('a note for later');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: what a consumer sees on the merged surfaces
// ---------------------------------------------------------------------------

describe('scenario: what the consumer observes across a duplex session', () => {
  it('labels every event with its loop and never as a pseudo-child', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.defaultText = '';
    const seen: Array<{ type: string; loopPath?: string; childTaskId?: string }> = [];
    h.facade.getEventBridge().on('turn_end', (event) => {
      seen.push({
        type: event.type,
        ...(event.loopPath !== undefined ? { loopPath: event.loopPath } : {}),
        ...(event.childTaskId !== undefined ? { childTaskId: event.childTaskId } : {}),
      });
    });

    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'do the work' } }],
    }];
    await h.facade.prompt('do the work');
    await waitUntil(() => seen.length >= 2, 2000, 'both loops emitted');

    expect(seen.map((event) => event.loopPath)).toEqual(
      expect.arrayContaining(['talker', 'reasoner']),
    );
    // The long-standing `if (event.childTaskId) return;` consumer filter
    // must still see main-loop events from both loops.
    expect(seen.every((event) => event.childTaskId === undefined)).toBe(true);
  });

  it('finalizes user-visible output from the talker only, never the reasoner prose', async () => {
    // onTurnComplete is the "the assistant finished saying something" signal
    // a TUI finalizes its assistant bubble on and a voice app speaks. Fanned
    // out across both resident loops it fires twice per exchange and one of
    // the two is the reasoner's internal working text, which the user was
    // never meant to see: the TUI interleaves it with the talker's speech,
    // and the voice app reads it aloud.
    const h = createDuplexScenario();
    const outputs: Array<{ text: string; loopPath: string }> = [];
    h.facade.onTurnComplete((output, origin) => {
      outputs.push({ text: output.userFacing, loopPath: origin.loopPath });
    });

    h.reasonerPi.hold = true;
    h.reasonerPi.script = [{ text: 'Reasoner internal final text.' }];
    h.talkerPi.script = [{
      text: 'Working on it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'do the work' } }],
    }];
    await h.facade.prompt('do the work');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work dispatched');

    // One exchange, one finalization: the spoken acknowledgment.
    expect(outputs).toEqual([{ text: 'Working on it.', loopPath: 'talker' }]);

    // Let the reasoner finish. Its final text surfaces as a delivery the
    // talker performs, which is a talker turn; the reasoner's own turn
    // completion is not a user-visible one and must not fire.
    h.reasonerPi.releaseRun();
    await h.facade.waitForWorkSettled();
    await settle();

    expect(outputs.map((output) => output.loopPath)).not.toContain('reasoner');
    expect(outputs.map((output) => output.text))
      .not.toContain('Reasoner internal final text.');
  });

  it('settles both predicates once the conversation and the work are done', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.reasonerPi.defaultText = '';
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'do the work' } }],
    }];
    await h.facade.prompt('do the work');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');

    // The conversation is idle while the work is not settled: the two
    // predicates are genuinely different facts.
    await h.facade.waitForConversationIdle();
    expect(h.facade.conversationIdle).toBe(true);
    expect(h.facade.workSettled).toBe(false);

    h.reasonerPi.releaseRun();
    await h.facade.waitForWorkSettled();
    expect(h.facade.workSettled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Grounding: what the system gives the talker to be honest with
// ---------------------------------------------------------------------------

describe('scenario: grounding material under repeated pressure', () => {
  it('never puts an outcome in the talker context while the work is unfinished', async () => {
    // The talker's grounding rules are prompt rules, and whether a model
    // obeys them needs a live provider. What IS testable is that the system
    // gives it nothing to hallucinate from: under repeated pressure, no
    // result content reaches the talker until the work delivers one.
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'audit the whole repo' } }],
    }];
    await h.facade.prompt('audit the whole repo');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');

    for (const pressure of [
      'just tell me what it found so far',
      'anything at all? even partial',
      'come on, give me the headline',
    ]) {
      h.talkerPi.script = [{ text: 'Nothing back from it yet.' }];
      await h.facade.prompt(pressure);
    }

    // Not one delivery, and the status block reports state without result.
    expect(entriesOfType(h.facade, 'delivery')).toHaveLength(0);
    const block = talkerHeadline(h.talkerLoop)!;
    expect(block).toContain('state="working"');
    expect(block).not.toContain('Last update');
    // Nothing resembling a finding reached the talker's transcript.
    expect(JSON.stringify(h.talkerPi.state.messages)).not.toContain('<background-update>');

    h.reasonerPi.releaseRun();
  });

  it('carries honest staleness once an update exists', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'audit the repo' } }],
    }];
    await h.facade.prompt('audit the repo');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work started');

    h.reasonerPi.emitEvent({
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'Bash',
      args: { command: 'npm test' },
    });

    const block = talkerHeadline(h.talkerLoop)!;
    // A number, not a vibe: the talker can say when it last saw this.
    expect(block).toMatch(/Current: Bash npm test \(as of \d+s ago\)/);
    h.reasonerPi.releaseRun();
  });
});

describe('scenario: work that finished stops being described as live', () => {
  /**
   * The reviewer's probe: after the reasoner delivered and went idle, the
   * block still read `<task alias="task-1" age="0s">build the release</task>`
   * beside `<work state="idle">`, so the talker was told finished work was in
   * progress. Verified failing against the pre-fix registry, which had no
   * retirement path at all.
   */
  it('drops a finished delegation from the block instead of listing it forever', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'build the release' } }],
    }];
    h.reasonerPi.script = [{ text: 'The release is built.' }];
    await h.facade.prompt('build the release');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work dispatched');

    // Precondition, so the negative assertions below cannot pass by the task
    // never having been rendered at all: while the work is genuinely live,
    // the block does list it.
    const during = talkerHeadline(h.talkerLoop)!;
    expect(during).toContain('alias="task-1"');
    expect(during).toContain('build the release');

    h.reasonerPi.releaseRun();
    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length === 1,
      2000, 'the result was delivered',
    );
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 2000, 'reasoner idle');

    // Either nothing left to say, or a block that no longer claims the task
    // is running. What must never happen is a live task beside an idle loop.
    // Coalesced to '' rather than guarded by a null check, so the assertion
    // always runs: a null block that asserted nothing would look like a pass.
    const after = talkerHeadline(h.talkerLoop) ?? '';
    expect(after).not.toContain('build the release');
    expect(after).not.toContain('alias="task-1"');
  });
});

// ---------------------------------------------------------------------------
// The work fails: the one thing the system could never say
// ---------------------------------------------------------------------------

describe('scenario: the reasoner fails', () => {
  /**
   * The consumer symptom, not the internal state change: after a failed
   * reasoner run the user hears NOTHING, and the status block still lists the
   * work as live, so the grounding rules have the talker honestly answer
   * "still working on it" for the rest of the session. Verified failing
   * against the pre-fix facade, which produced zero deliveries here.
   */
  async function failedWork(
    h: ReturnType<typeof createDuplexScenario>,
  ): Promise<void> {
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'build the release' } }],
    }];
    await h.facade.prompt('build the release');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'work dispatched');
  }

  /** Talker-facing text of every delivery the router handed over. */
  function deliveredToTalker(h: ReturnType<typeof createDuplexScenario>): string {
    return JSON.stringify(h.talkerPi.state.messages);
  }

  it('speaks up when a run ends on an error instead of leaving the user waiting', async () => {
    const h = createDuplexScenario();
    // pi's failure stub: the run ends, but its last assistant message carries
    // an error stop reason and no result.
    h.reasonerPi.script = [{ text: '', stopReason: 'error' }];
    await failedWork(h);

    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length === 1,
      2000, 'the failure was delivered',
    );
    const delivery = entriesOfType(h.facade, 'delivery')[0]!;
    expect(delivery.content).toContain('stopped with an error');
    expect(delivery.wake).toBe('interrupt');
    // And it actually reached the conversation surface, fenced as an update.
    await waitUntil(
      () => deliveredToTalker(h).includes('stopped with an error'),
      2000, 'the talker was told',
    );
    expect(deliveredToTalker(h)).toContain('background-update');
  });

  it('speaks up on a fatal error the ladder will never retry', async () => {
    const h = createDuplexScenario();
    // A real classification path: authentication is the one fatal category,
    // and a fatal failure throws out of the run without a loop_end at all,
    // so nothing downstream of the run boundary can notice it.
    h.reasonerPi.failWith = new Error('401 Unauthorized: invalid x-api-key');
    await failedWork(h);

    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length === 1,
      2000, 'the fatal failure was delivered',
    );
    const delivery = entriesOfType(h.facade, 'delivery')[0]!;
    expect(delivery.content).toContain('cannot recover from');
    expect(delivery.content).toContain('invalid x-api-key');
    expect(delivery.content).toContain('will not retry');
  });

  it('speaks up when the retry ladder gives up, and stops claiming to be retrying', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.hold = true;
    await failedWork(h);

    // The ladder itself is the loop's, tested there; what is wired here is
    // what the facade does with its signals, so they are fired through the
    // loop's own retry notifiers.
    const { runner, origin } = partsOf(h.reasonerLoop);
    runner.retryScheduled.emit({
      category: 'server_error',
      attempt: 3,
      maxAttempts: 5,
      delayMs: 1000,
      nextAttemptAt: Date.now() + 1000,
      originalMessage: '500 internal server error',
    }, origin);

    // Mid-ladder the block says retrying, not working: "still working on it"
    // is the answer that makes the user wait through a failing session.
    const retryingBlock = talkerHeadline(h.talkerLoop)!;
    expect(retryingBlock).toMatch(
      /Retrying after a server_error failure: attempt 3 of 5 \(as of \d+s ago\)/,
    );

    runner.retryExhausted.emit({ attempts: 5, category: 'server_error' }, origin);
    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length === 1,
      2000, 'the exhausted ladder was delivered',
    );
    expect(entriesOfType(h.facade, 'delivery')[0]!.content)
      .toContain('given up retrying');
    // And the block stops claiming a retry is coming.
    expect(talkerHeadline(h.talkerLoop)!).not.toContain('Retrying after');

    h.reasonerPi.releaseRun();
  });

  it('stays quiet mid-ladder and says "retrying", not "it failed"', async () => {
    // The consumer symptom: on the first transient provider failure of a
    // session, the user was told "it stopped with an error, offer to try
    // again" at interrupt class while the block simultaneously and correctly
    // said "Retrying after a server_error failure: attempt 1 of 3". Two
    // contradictory facts about one event, with the wrong one louder.
    //
    // pi emits agent_end for a failed attempt too, so loop_end fires
    // mid-ladder; only the recorded errorMessage distinguishes it from a run
    // that really is over.
    const h = createDuplexScenario({
      retryPolicy: { backoffMs: [1], maxBackoffMs: 1, maxAttempts: 3 },
    });
    h.reasonerPi.script = [
      { text: '', runErrorMessage: '500 internal server error' },
      { text: 'Built it on the retry.' },
    ];
    await failedWork(h);

    // The ladder really ran: one retry attempt, through continue().
    await waitUntil(() => h.reasonerPi.continueCalls === 1, 3000, 'the ladder retried');
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 3000, 'the turn finished');

    // Not one failure delivery anywhere in the ladder, and the result that
    // did arrive is the successful one.
    const deliveries = entriesOfType(h.facade, 'delivery');
    expect(deliveries.map((entry) => entry.content))
      .not.toContain(expect.stringContaining('stopped with an error'));
    for (const entry of deliveries) {
      expect(entry.content).not.toContain('stopped with an error');
      expect(entry.content).not.toContain('given up retrying');
    }
    expect(deliveredToTalker(h)).toContain('Built it on the retry.');
  });

  it('shows the retry in the block while the ladder is still running', async () => {
    // A long backoff keeps the turn parked mid-ladder, which is exactly the
    // window the user asks "how's it going?" in.
    const h = createDuplexScenario({
      retryPolicy: { backoffMs: [60_000], maxBackoffMs: 60_000, maxAttempts: 3 },
    });
    h.reasonerPi.script = [{ text: '', runErrorMessage: '500 internal server error' }];
    await failedWork(h);
    await waitUntil(
      () => talkerHeadline(h.talkerLoop)?.includes('Retrying after') === true,
      3000, 'the block reports the retry',
    );

    const block = talkerHeadline(h.talkerLoop)!;
    expect(block).toMatch(/Retrying after a server_error failure: attempt 1 of \d+/);
    // And the block is the ONLY thing saying anything about it so far.
    expect(entriesOfType(h.facade, 'delivery')).toHaveLength(0);
  });

  it('announces an exhausted ladder exactly once, in the better of the two wordings', async () => {
    // A terminal ladder reaches the announcer twice: onRetryExhausted fires,
    // then emitError for the same failure a few statements later in the same
    // unwind. The user hears about it once, and hears the wording that knows
    // how many attempts there were. This is the property the once-per-failure
    // guard actually protects; before, repeat suppression leaned on the
    // router's content-hash dedup, which has a 120s window the real backoff
    // ladder outlives.
    const h = createDuplexScenario({
      retryPolicy: { backoffMs: [1], maxBackoffMs: 1, maxAttempts: 1 },
    });
    h.reasonerPi.script = [
      { text: '', runErrorMessage: '500 internal server error' },
      { text: '', runErrorMessage: '500 internal server error' },
    ];
    await failedWork(h);

    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length > 0,
      3000, 'the exhausted ladder was announced',
    );
    await waitUntil(() => !h.reasonerLoop.isLoopActive, 3000, 'the turn is over');
    await settle();

    const deliveries = entriesOfType(h.facade, 'delivery');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.content).toContain('given up retrying');
    // Not the onError wording, which fires for the same failure right after.
    expect(deliveries[0]!.content).not.toContain('stopped and produced no result');
  });

  it('takes the retry line down when the user aborts mid-backoff', async () => {
    // An abort inside a backoff window produces no run start, no run end,
    // and neither onRetrySucceeded nor onRetryExhausted, so nothing else in
    // the system would ever retract "Retrying, attempt 1 of 3". It would sit
    // in the block for the rest of the session, ageing.
    const h = createDuplexScenario({
      retryPolicy: { backoffMs: [60_000], maxBackoffMs: 60_000, maxAttempts: 3 },
    });
    h.reasonerPi.script = [{ text: '', runErrorMessage: '500 internal server error' }];
    await failedWork(h);
    await waitUntil(
      () => talkerHeadline(h.talkerLoop)?.includes('Retrying after') === true,
      3000, 'the block reports the retry',
    );

    await h.facade.abort('work');
    await waitUntil(
      () => talkerHeadline(h.talkerLoop)?.includes('Retrying after') !== true,
      3000, 'the retry line came down',
    );
    // And the abort itself is not announced as a failure.
    for (const entry of entriesOfType(h.facade, 'delivery')) {
      expect(entry.content).not.toContain('stopped and produced no result');
    }
  });

  it('says nothing extra when the user aborted the work themselves', async () => {
    const h = createDuplexScenario();
    h.reasonerPi.script = [{ text: '', stopReason: 'aborted' }];
    await failedWork(h);
    await settle();

    // An abort is the user's own doing and already acknowledged on the
    // conversation surface; reporting it back is noise, not surfacing.
    expect(entriesOfType(h.facade, 'delivery')).toHaveLength(0);
  });
});
