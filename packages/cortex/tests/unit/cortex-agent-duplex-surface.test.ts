/**
 * Consumer-visible duplex facade surfaces, driven as sessions.
 *
 * Every test here reproduces the symptom a consumer sees rather than the
 * internal state change behind it: what text the talker's model is actually
 * handed, what a settlement predicate reports while a resolver is blocked,
 * what an exported conversation contains, and which budget guard a UI reads
 * back. The harness is the Phase 3 scripted-pi one, so the tool batch, the
 * terminate guards, and the real permission gate all run.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createPassthroughScenario,
  createRealDuplexScenario,
  createScriptedPiAgent,
  destroyLiveFacades,
  duplexRouterOf,
  entriesOfType,
  getBroker,
  lifecycleEvents,
  promptTexts,
  settle,
  talkerHeadline,
  testModel,
  waitUntil,
} from './duplex-scenario-harness.js';
import type { ScriptedPiAgent } from './duplex-scenario-harness.js';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiModel } from '../../src/agent-loop.js';
import { wrapModel } from '../../src/model-wrapper.js';
import type { AgentLoopConfig } from '../../src/types.js';
import type { AgentMessage } from '../../src/context-manager.js';
import type { CortexAgentConfig } from '../../src/cortex-agent.js';
import type { NetworkAccessRequest } from '../../src/sandbox/types.js';
import type { CortexLogger } from '../../src/types.js';
import { partsOf } from './agent-loop/parts.js';

afterEach(async () => {
  await destroyLiveFacades();
  vi.restoreAllMocks();
});

/** A logger that records what it was told, for the assembly warnings. */
function recordingLogger(): { logger: CortexLogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => { warnings.push(message); },
      error: () => {},
    },
  };
}

// ---------------------------------------------------------------------------
// The session-log read surface: the facade must expose the hole-aware read,
// not just the entries-only one
// ---------------------------------------------------------------------------

describe('facade session-log reads', () => {
  it('exposes the hole-aware read, which getLog() cannot express', async () => {
    // A tiny retention cap so eviction is guaranteed, and the entry types
    // are mixed so churn-first retention leaves a hole rather than a clean
    // leading truncation.
    const { facade } = await createRealDuplexScenario({
      sessionLog: { maxEntries: 3 },
    });
    for (let i = 0; i < 6; i++) {
      facade.deliver(`notification ${i}`, { wake: false });
    }

    const entries = facade.getLog();
    const events = facade.getLogEvents();

    // getLog() hands back entries with nothing marking what is missing.
    expect(entries.length).toBeLessThan(6);
    // getLogEvents() says so, and says it the same way a reconnecting
    // subscriber would be told.
    const gaps = events.filter((event) => event.kind === 'gap');
    expect(gaps.length).toBeGreaterThan(0);
    expect(events.filter((event) => event.kind === 'entry')).toHaveLength(entries.length);
  });

  it('rejects after destroy, like its two neighbours', async () => {
    const { facade } = await createRealDuplexScenario();
    await facade.destroy();
    expect(() => facade.getLogEvents()).toThrow('CortexAgent has been destroyed');
  });
});

// ---------------------------------------------------------------------------
// Router tuning has to reach the router
//
// `DuplexTuningConfig extends Omit<DuplexRouterOptions, 'now'>`, so every
// router option is settable by a consumer the moment it is declared and
// typechecks at their call site. The facade used to copy them with a
// hand-written key list, which is how `delegationMaxAgeMs` shipped accepted
// and then dropped.
// ---------------------------------------------------------------------------

describe('duplex router tuning', () => {
  it('applies delegationMaxAgeMs, so stale work stops being reported as live', async () => {
    const { facade, talkerLoop, talkerPi, reasonerPi } = await createRealDuplexScenario({
      duplex: { delegationMaxAgeMs: 30 },
    });
    // Hold the reasoner so the delegation is never retired by a result: the
    // age bound is the only thing that can drop it, which is the point.
    reasonerPi.hold = true;
    talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'audit the deploy config' } }],
    }];

    await facade.prompt('audit the deploy config please');
    await waitUntil(
      () => (talkerHeadline(talkerLoop) ?? '').includes('audit the deploy config'),
      2000, 'delegation reported to the talker',
    );

    // Past the bound, the talker must stop being told this work is live, or
    // its grounding rules have it answering "still working on it" forever.
    await waitUntil(
      () => !(talkerHeadline(talkerLoop) ?? '').includes('audit the deploy config'),
      2000, 'stale delegation retired',
    );

    reasonerPi.releaseRun();
  });

  it('still applies the neighbouring keys the hand-written list did carry', async () => {
    const { facade } = await createRealDuplexScenario({
      duplex: { maxDispatchesPerTurn: 1 },
    });
    const options = (duplexRouterOf(facade) as unknown as {
      options: { maxDispatchesPerTurn: number; delegationMaxAgeMs: number };
    }).options;
    expect(options.maxDispatchesPerTurn).toBe(1);
    // And an unset key keeps the router's own default rather than undefined.
    expect(options.delegationMaxAgeMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// utilityModel: per-loop, but only where the provider constraint allows
// ---------------------------------------------------------------------------

/**
 * A same-provider utility model with an id auto-resolution cannot produce.
 *
 * Deliberately not the real fast-tier id: the talker's own auto-resolved
 * utility model IS that id, so an assertion against it passes whether or not
 * anything copied the setting. The distinctive id is what makes "the talker
 * got the model the consumer chose" a claim that can fail.
 */
const UTILITY_MODEL_ID = 'claude-haiku-test-only-utility';

function anthropicUtilityModel() {
  return wrapModel(
    { provider: 'anthropic', name: UTILITY_MODEL_ID } as PiModel,
    'anthropic',
    UTILITY_MODEL_ID,
  );
}

/** A talker on a different provider, so the constraint actually bites. */
function openAiTalkerModel() {
  return wrapModel(
    { provider: 'openai', name: 'gpt-4o-mini' } as PiModel,
    'openai',
    'gpt-4o-mini',
  );
}

describe('duplex utilityModel routing', () => {
  it('copies the configured utility model to the talker when the providers agree', async () => {
    const utility = anthropicUtilityModel();
    const { talkerLoop, reasonerLoop } = await createRealDuplexScenario({
      utilityModel: utility,
    });

    // The common case: the talker defaults to the fast tier of the primary
    // provider, so the setting applies to both loops and the talker's
    // observational spend goes to the model the consumer chose.
    expect(reasonerLoop.getUtilityModel().modelId).toBe(utility.modelId);
    expect(talkerLoop.getUtilityModel().modelId).toBe(utility.modelId);
  });

  it('a cross-provider utility model would break assembly if copied blind', async () => {
    // The precondition for the next test, asserted rather than assumed: a
    // loop REJECTS a utility model from another provider, so this is not a
    // question of degraded behavior. Copying blind fails construction.
    await expect(AgentLoop.create({
      model: openAiTalkerModel(),
      utilityModel: anthropicUtilityModel(),
      workingDirectory: '/tmp/test-workspace',
      initialBasePrompt: 'probe',
    })).rejects.toThrow(/does not match primary model provider/);
  });

  it('skips it and says so when the talker runs on another provider', async () => {
    const { logger, warnings } = recordingLogger();
    const utility = anthropicUtilityModel();
    const { facade, talkerLoop, reasonerLoop } = await createRealDuplexScenario({
      logger,
      utilityModel: utility,
      talker: { model: openAiTalkerModel() },
    });

    // Duplex still assembles, which is the whole point of not copying.
    expect(facade.getModel().provider).toBe('anthropic');
    expect(reasonerLoop.getUtilityModel().modelId).toBe(utility.modelId);
    expect(talkerLoop.getUtilityModel().modelId).not.toBe(utility.modelId);

    // And the one case we cannot honor is visible, naming both sides and
    // what actually runs rather than only what was skipped.
    const warned = warnings.filter((line) => line.includes('utilityModel'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(UTILITY_MODEL_ID);
    expect(warned[0]).toContain('gpt-4o-mini');
    expect(warned[0]).toContain('auto-resolved utility model');
  });

  it('stays quiet when the providers agree', async () => {
    const { logger, warnings } = recordingLogger();
    await createRealDuplexScenario({ logger, utilityModel: anthropicUtilityModel() });
    expect(warnings.filter((line) => line.includes('utilityModel'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// N6: contextWindowLimit is declared per-loop and must be per-loop
// ---------------------------------------------------------------------------

describe('duplex contextWindowLimit routing', () => {
  it('applies the configured limit to the talker, not the reasoner alone', async () => {
    const { talkerLoop, reasonerLoop } = await createRealDuplexScenario({
      contextWindowLimit: 50_000,
    });

    // The compaction budget the loop actually runs on. The talker holds the
    // conversation, so a reasoner-only limit leaves the fastest-growing
    // surface uncapped.
    expect(reasonerLoop.effectiveContextWindow).toBe(50_000);
    expect(talkerLoop.effectiveContextWindow).toBe(50_000);
  });

  it('setContextWindowLimit reaches both resident loops', async () => {
    const { facade, talkerLoop, reasonerLoop } = await createRealDuplexScenario();

    facade.setContextWindowLimit(40_000);

    expect(reasonerLoop.effectiveContextWindow).toBe(40_000);
    expect(talkerLoop.effectiveContextWindow).toBe(40_000);

    facade.setContextWindowLimit(null);
    // Back to the talker's own window: its auto-resolved model, not the reasoner's.
    expect(talkerLoop.effectiveContextWindow).toBe(talkerLoop.getModel().contextWindow);
    expect(reasonerLoop.effectiveContextWindow).toBe(testModel().contextWindow);
  });
});

// ---------------------------------------------------------------------------
// N1: settlement predicates must read the facade's merged ask registry
//
// A network egress ask is the case that separates the two registries: it is
// minted by the broker and never enters any loop's own pending-ask map, so a
// predicate reading the reasoner's map reports settled while the resolver
// that raised it is still blocked.
// ---------------------------------------------------------------------------

/** Config whose network resolver always defers to the user. */
const ASKING_NETWORK: Partial<CortexAgentConfig> = {
  resolveNetworkAccess: async () => ({ decision: 'ask' as const }),
};

const EGRESS: NetworkAccessRequest = {
  host: 'example.com',
  via: 'shell',
} as NetworkAccessRequest;

describe('duplex settlement predicates and broker-minted asks', () => {
  it('workSettled stays false while a network resolver is blocked', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario(ASKING_NETWORK);
    const resolver = facade.getNetworkAccessResolver();
    if (!resolver) throw new Error('duplex did not wire a network resolver');

    let resolverSettled = false;
    const blocked = resolver(EGRESS).then((decision) => {
      resolverSettled = true;
      return decision;
    });

    // The ask is voiced, which wakes the talker; wait for that turn to end
    // so nothing but the ask itself can hold the predicate down.
    await waitUntil(() => facade.getPendingAsks().length === 1, 2000, 'ask raised');
    await waitUntil(() => facade.conversationIdle, 2000, 'talker idle again');

    expect(resolverSettled).toBe(false);
    expect(facade.workSettled).toBe(false);

    // And the awaitable form does not resolve either.
    let settledEarly = false;
    void facade.waitForWorkSettled().then(() => { settledEarly = true; });
    await settle();
    expect(settledEarly).toBe(false);

    // Answering releases both the resolver and the wait.
    const askId = facade.getPendingAsks()[0]!.askId;
    getBroker(facade).answer(askId, 'deny', undefined);
    await expect(blocked).resolves.toEqual({ decision: 'deny' });
    await waitUntil(() => settledEarly, 2000, 'waitForWorkSettled resolves');
    expect(facade.workSettled).toBe(true);
    expect(talkerPi.promptCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// isAutoApprove has to reach the network resolver through the facade
//
// The broker suite covers the resolver by handing it the callback directly,
// which passes whether or not anything wires it. This drives the wiring:
// config in, CortexAgent.create() assembling, the resolver the facade
// actually enforces coming back out of getNetworkAccessResolver().
// ---------------------------------------------------------------------------

describe('duplex auto-approve and network egress', () => {
  it('does not voice an egress ask at a consumer that asked not to be interrupted', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario({
      ...ASKING_NETWORK,
      isAutoApprove: () => true,
      // Bounds the pre-change shape: unwired, this brokers a real ask, and
      // the assertions below should fail rather than hang to a default
      // two-minute timeout.
      duplex: { askTimeoutMs: 50 },
    });
    const resolver = facade.getNetworkAccessResolver();
    if (!resolver) throw new Error('duplex did not wire a network resolver');

    const decision = resolver(EGRESS);
    await settle();

    // The symptom: nothing is minted and nothing is read out.
    expect(facade.getPendingAsks()).toEqual([]);
    expect(promptTexts(talkerPi).join('\n')).not.toContain('<permission-request');
    await expect(decision).resolves.toEqual({ decision: 'allow' });

    // Passing for the right reason: the auto-approve branch ran, and left
    // the audit entry that is the only record of a decision the user never
    // saw. Without this the test would also pass if egress were denied.
    const audit = lifecycleEvents(facade, 'ask_auto_approved');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.content).toContain('example.com');
  });

  it('still brokers the ask when the callback reads false', async () => {
    const { facade } = await createRealDuplexScenario({
      ...ASKING_NETWORK,
      isAutoApprove: () => false,
    });
    const resolver = facade.getNetworkAccessResolver();
    if (!resolver) throw new Error('duplex did not wire a network resolver');

    void resolver(EGRESS);
    await waitUntil(() => facade.getPendingAsks().length === 1, 2000, 'ask brokered');
    expect(lifecycleEvents(facade, 'ask_auto_approved')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H1: the same wiring on the TOOL resolver
//
// withBrokeredPermissions passes isAutoApprove to both resolvers, and only
// the network one was guarded. The two arguments are wired at different
// positions in different calls, so covering one says nothing about the other.
// ---------------------------------------------------------------------------

/** A tool that exists and reports having run, so "allowed" is observable. */
const PROBE_TOOL = {
  name: 'probe',
  description: 'A no-op tool used to observe whether the permission gate allowed a call.',
  parameters: { type: 'object', properties: {} },
  execute: async () => 'probe ran',
} as unknown as NonNullable<CortexAgentConfig['tools']>[number];

/** Config whose tool resolver always defers to the user. */
const ASKING_TOOLS: Partial<CortexAgentConfig> = {
  resolvePermission: async () => ({ decision: 'ask' as const }),
  tools: [PROBE_TOOL],
};

describe('duplex auto-approve and tool asks', () => {
  it('does not voice a tool ask at a consumer that asked not to be interrupted', async () => {
    const { facade, talkerPi, reasonerPi } = await createRealDuplexScenario({
      ...ASKING_TOOLS,
      isAutoApprove: () => true,
      // Bounds the unwired shape: without auto-approve this brokers a real
      // ask, and the assertions should fail rather than hang on the default.
      duplex: { askTimeoutMs: 50 },
    });
    reasonerPi.script = [{ text: '', calls: [{ name: 'probe' }] }];

    facade.deliver('run the probe', { target: 'work' });
    await waitUntil(() => reasonerPi.toolResults.length === 1, 2000, 'tool call settled');

    // The symptom: nothing minted, nothing read out, and the call proceeds.
    // The log entry rather than getPendingAsks(): the registry is empty by
    // this point either way, because the gate only returns once the ask has
    // settled, so a registry check here cannot tell the two shapes apart.
    expect(entriesOfType(facade, 'ask')).toEqual([]);
    expect(promptTexts(talkerPi).join('\n')).not.toContain('<permission-request');
    expect(reasonerPi.toolResults[0]!.text).toContain('probe ran');

    // Passing for the right reason: the auto-approve branch ran and left the
    // audit entry that is the only record of a decision the user never saw.
    // Without this the test would also pass if the tool were never gated.
    const audit = lifecycleEvents(facade, 'ask_auto_approved');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.content).toContain('probe');
  });

  it('still brokers a tool ask when the callback reads false', async () => {
    const { facade, reasonerPi } = await createRealDuplexScenario({
      ...ASKING_TOOLS,
      isAutoApprove: () => false,
    });
    reasonerPi.script = [{ text: '', calls: [{ name: 'probe' }] }];

    facade.deliver('run the probe', { target: 'work' });
    await waitUntil(() => facade.getPendingAsks().length === 1, 2000, 'ask brokered');
    expect(lifecycleEvents(facade, 'ask_auto_approved')).toHaveLength(0);
    expect(facade.getPendingAsks()[0]!.toolName).toBe('probe');
  });
});

// ---------------------------------------------------------------------------
// V4: a quick-lookup loop's ask must be visible too
//
// Lookups are built through AgentLoop.create, not createChildAgent, so
// nothing mirrors their asks into the reasoner's registry, and they are
// `tool` kind, so the old network-only filter dropped them as well. A
// blocked lookup was therefore invisible on every consumer surface.
// ---------------------------------------------------------------------------

/**
 * Lookup loops over scripted pi agents WITH the real permission gate, built
 * from the config create() assembled for that loop. stubLookupLoops does the
 * scripting but installs no gate, and the gate is the whole point here.
 */
function stubGatedLookupLoops(setup: (pi: ScriptedPiAgent) => void): {
  built: Array<{ loop: AgentLoop; pi: ScriptedPiAgent; config: AgentLoopConfig }>;
} {
  const statics = AgentLoop as unknown as {
    buildPiAgentConfig: (params: {
      cortexConfig: AgentLoopConfig;
      cacheBreakpointState: { agentLoop: AgentLoop | null };
    }) => Record<string, unknown>;
    wireManagedPiAgent: (loop: AgentLoop, pi: unknown) => void;
  };
  const Ctor = AgentLoop as unknown as new (
    pi: unknown,
    config: AgentLoopConfig,
    tools?: unknown[],
    options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
  ) => AgentLoop;
  const built: Array<{ loop: AgentLoop; pi: ScriptedPiAgent; config: AgentLoopConfig }> = [];
  vi.spyOn(AgentLoop, 'create').mockImplementation(async (config) => {
    const pi = createScriptedPiAgent();
    setup(pi);
    const loop = new Ctor(pi, config, [], {
      enableSubAgentTool: false,
      enableLoadSkillTool: false,
    });
    const agentConfig = statics.buildPiAgentConfig({
      cortexConfig: config,
      cacheBreakpointState: { agentLoop: loop },
    });
    pi.afterToolCall = agentConfig['afterToolCall'] as typeof pi.afterToolCall;
    pi.beforeToolCall = agentConfig['beforeToolCall'] as typeof pi.beforeToolCall;
    statics.wireManagedPiAgent(loop, pi);
    built.push({ loop, pi, config });
    return loop;
  });
  return { built };
}

/** A talker turn that dispatches one quick lookup. */
const LOOKUP_TURN = {
  text: 'Let me check that.',
  calls: [{ name: 'quick_lookup', args: { question: 'what does resolveModel do?' } }],
};

describe('duplex pending asks from a quick lookup', () => {
  it('shows a blocked lookup on the facade surface, attributed to its own loop', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario({
      resolvePermission: async () => ({ decision: 'ask' as const }),
      // Long enough that the ask is still blocked when we assert.
      duplex: { lookupTimeoutMs: 5_000 },
    });
    const { built } = stubGatedLookupLoops((pi) => {
      pi.script = [{
        text: '',
        calls: [{ name: 'Read', args: { file_path: '/tmp/test-workspace/models.ts' } }],
      }];
    });

    talkerPi.script = [LOOKUP_TURN];
    await facade.prompt('what does resolveModel do?');
    await waitUntil(() => facade.getPendingAsks().length === 1, 2000, 'lookup ask visible');

    const ask = facade.getPendingAsks()[0]!;
    expect(ask.loopPath).toMatch(/^lookup\//);
    expect(ask.toolName).toBe('Read');
    expect(ask.renderedRequest).toContain('models.ts');
    // The reasoner never saw it: it is not in that subtree.
    expect(built).toHaveLength(1);
    expect(facade.getPendingAsks()).toHaveLength(1);
  });

  it('does not let the ask outlive the lookup that raised it', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario({
      resolvePermission: async () => ({ decision: 'ask' as const }),
      // The lookup's own wall-clock bound, well under the broker's ask
      // timeout, so this measures the lookup teardown and not the broker.
      duplex: { lookupTimeoutMs: 60 },
    });
    stubGatedLookupLoops((pi) => {
      pi.script = [{
        text: '',
        calls: [{ name: 'Read', args: { file_path: '/tmp/test-workspace/models.ts' } }],
      }];
    });

    talkerPi.script = [LOOKUP_TURN];
    await facade.prompt('what does resolveModel do?');
    await waitUntil(() => facade.getPendingAsks().length === 1, 2000, 'lookup ask raised');

    // The lookup times out and is destroyed. Its ask must go with it, or the
    // facade would now be reporting a blocked request against a loop that no
    // longer exists, for the broker's whole (much longer) ask timeout.
    await waitUntil(() => facade.getPendingAsks().length === 0, 3000, 'ask settled with the lookup');
    await waitUntil(() => facade.workSettled, 3000, 'work settles');
  });
});

// ---------------------------------------------------------------------------
// H2: the talker's error and retry log producers
//
// wireErrorProducers is called for both loops and only the reasoner's half
// was asserted. The talker is the presence loop, so its failures are the
// ones a user experiences as silence, and the session log is where a
// consumer looks to explain that silence.
// ---------------------------------------------------------------------------

/** Log entries produced by one loop, by type. */
function entriesFrom(
  facade: Parameters<typeof entriesOfType>[0],
  type: Parameters<typeof entriesOfType>[1],
  loopPath: string,
) {
  return entriesOfType(facade, type).filter((entry) => entry.loopPath === loopPath);
}

describe('duplex talker log producers', () => {
  it('records a talker retry in the session log, attributed to the talker', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario();
    // Network class: the retry hook fires before the backoff wait, so this
    // asserts without waiting one out.
    talkerPi.failWith = new Error('ECONNRESET while contacting the provider');

    void facade.prompt('hello').catch(() => {});
    await waitUntil(
      () => entriesFrom(facade, 'retrying', 'talker').length === 1,
      2000, 'talker retry logged',
    );

    const entry = entriesFrom(facade, 'retrying', 'talker')[0]!;
    expect(entry.content).toContain('ECONNRESET');
    expect(entry.data).toMatchObject({ category: 'network', attempt: 1, maxAttempts: 2 });
    // The reasoner is fine and must not be blamed for it.
    expect(entriesFrom(facade, 'retrying', 'reasoner')).toHaveLength(0);

    await facade.abort('conversation');
  });

  it('records a fatal talker error in the session log, attributed to the talker', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario();
    // Authentication class is fatal, so the ladder never runs and onError
    // fires promptly rather than after a backoff.
    talkerPi.failWith = new Error('401 Unauthorized: invalid api key');

    void facade.prompt('hello').catch(() => {});
    await waitUntil(
      () => entriesFrom(facade, 'error', 'talker').length === 1,
      2000, 'talker error logged',
    );

    const entry = entriesFrom(facade, 'error', 'talker')[0]!;
    expect(entry.content).toContain('Unauthorized');
    expect(entry.data).toMatchObject({ category: 'authentication', severity: 'fatal' });
    // A talker failure is the consumer's to see, not something the reasoner
    // announces: it must not become a spoken delivery about background work.
    expect(promptTexts(talkerPi).join('\n')).not.toContain('background work');
  });
});

// ---------------------------------------------------------------------------
// S6: getConversationHistory() must be the conversation
// ---------------------------------------------------------------------------

/** Flatten a transcript to searchable text, whatever shape its blocks take. */
function transcriptText(messages: AgentMessage[]): string {
  return messages
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content)))
    .join('\n');
}

describe('duplex getConversationHistory', () => {
  it('exports the dialogue, not the work transcript with its dispatch scaffolding', async () => {
    const { facade, talkerPi, reasonerPi } = await createRealDuplexScenario();
    talkerPi.script = [{
      text: 'Sure, taking a look at the config now.',
      calls: [{ name: 'spawn_task', args: { instructions: 'audit the config' } }],
    }];

    await facade.prompt('please audit the deploy config');
    await waitUntil(() => reasonerPi.promptCalls.length > 0, 2000, 'dispatch reached the reasoner');

    const exported = transcriptText(facade.getConversationHistory());

    // What a consumer rendering "the conversation" expects to find.
    expect(exported).toContain('please audit the deploy config');
    expect(exported).toContain('Sure, taking a look at the config now.');
    // What it must not find: the reasoner's work transcript is made of
    // directives with the user's words quoted inside a context fence.
    expect(exported).not.toContain('[Directive]');
    expect(exported).not.toContain('<conversation-context>');

    // The work transcript is still reachable, through the composite artifact.
    const state = await facade.getState();
    expect(transcriptText(state.reasonerHistory)).toContain('[Directive]');
    expect(transcriptText(state.talkerHistory)).toContain('please audit the deploy config');
  });

  it('passthrough stamps a parked delivery run with that delivery, not with nothing', async () => {
    const { facade, reasonerPi } = createPassthroughScenario();
    reasonerPi.hold = true;
    const first = facade.prompt('start the long thing');
    await waitUntil(() => reasonerPi.promptCalls.length === 1, 2000, 'run live');
    // Parks behind the live run; the sweep run answers it.
    reasonerPi.script = [{ text: 'First done.' }, { text: 'Picked up the note.' }];
    expect(facade.deliver('also note this').outcome).toBe('parked');
    reasonerPi.releaseRun();
    await first;
    await waitUntil(() => reasonerPi.promptCalls.length === 2 && facade.conversationIdle, 2000, 'sweep ran');

    const note = facade.getLog().find((entry) => entry.content === 'also note this')!;
    const reply = facade.getLog().find((entry) => entry.type === 'reply' && entry.content === 'Picked up the note.');
    expect(reply).toBeDefined();
    expect(reply!.causedBy).toBe(note.seq);
  });

  it('passthrough is unchanged: the single loop is the conversation loop', async () => {
    const { facade, reasonerLoop } = createPassthroughScenario();
    await facade.prompt('hello there');
    expect(facade.getConversationHistory()).toEqual(reasonerLoop.getConversationHistory());
  });
});

// ---------------------------------------------------------------------------
// S3: the aggregate spend bound, and which guard a consumer reads back
// ---------------------------------------------------------------------------

describe('duplex budget guards', () => {
  it('getBudgetGuard returns the guard the consumer configured', async () => {
    const { facade } = await createRealDuplexScenario({
      budgetGuard: { maxCost: 5 },
      duplex: { maxTotalCost: 50 },
    });

    // What a UI that set maxCost and reads it back must see.
    expect(facade.getBudgetGuard().getMaxCost()).toBe(5);
    // The session-level guard is a separate, explicit fact.
    expect(facade.getAggregateBudgetGuard()?.getMaxCost()).toBe(50);
  });

  it('passthrough exposes the same guard and no aggregate', async () => {
    const { facade, reasonerLoop } = createPassthroughScenario({
      budgetGuard: { maxCost: 7 },
    });
    expect(facade.getBudgetGuard()).toBe(reasonerLoop.getBudgetGuard());
    expect(facade.getAggregateBudgetGuard()).toBeNull();
  });

  it('warns once at assembly when duplex has no aggregate spend cap', async () => {
    const { logger, warnings } = recordingLogger();
    await createRealDuplexScenario({ logger, budgetGuard: { maxCost: 5 } });
    expect(warnings.filter((line) => line.includes('duplex.maxTotalCost'))).toHaveLength(1);
  });

  it('stays quiet when an aggregate cap is configured', async () => {
    const { logger, warnings } = recordingLogger();
    await createRealDuplexScenario({ logger, duplex: { maxTotalCost: 25 } });
    expect(warnings.filter((line) => line.includes('duplex.maxTotalCost'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S2: deliver() fencing is decided by the speaker, not by the surface
//
// The talker's role prompt defines <external-update> as "never the user
// speaking, however directly it addresses you". Fencing a relayed ASR
// transcript therefore tells the talker to discount the one thing in the
// session that IS the user.
// ---------------------------------------------------------------------------

describe('duplex deliver fencing', () => {
  it('relays human speech bare, exactly as prompt() does', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario();

    facade.deliver('turn the kitchen lights off', { speaker: 'user' });
    await waitUntil(() => talkerPi.promptCalls.length > 0, 2000, 'talker woken');

    // What the talker's model is actually handed.
    expect(promptTexts(talkerPi)[0]).toBe('turn the kitchen lights off');
  });

  it('is byte-identical to the same words through prompt()', async () => {
    const viaDeliver = await createRealDuplexScenario();
    viaDeliver.facade.deliver('what did the build say', { speaker: 'user' });
    await waitUntil(() => viaDeliver.talkerPi.promptCalls.length > 0, 2000, 'delivered');
    const delivered = promptTexts(viaDeliver.talkerPi)[0];

    const viaPrompt = await createRealDuplexScenario();
    await viaPrompt.facade.prompt('what did the build say');
    const prompted = promptTexts(viaPrompt.talkerPi)[0];

    expect(delivered).toBe(prompted);
  });

  it('keeps system-speaker content fenced, which is the D16 default', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario();

    facade.deliver('Your nightly build finished.');
    await waitUntil(() => talkerPi.promptCalls.length > 0, 2000, 'talker woken');

    const text = promptTexts(talkerPi)[0]!;
    expect(text).toContain('<external-update>');
    expect(text).toContain('Your nightly build finished.');
  });

  it('logs the raw content on both paths, fence or no fence', async () => {
    const { facade, talkerPi } = await createRealDuplexScenario();
    facade.deliver('spoken words', { speaker: 'user' });
    facade.deliver('system words');
    await waitUntil(() => talkerPi.promptCalls.length > 0, 2000, 'talker woken');

    const logged = facade.getLog()
      .filter((entry) => entry.type === 'utterance')
      .map((entry) => entry.content);
    expect(logged).toContain('spoken words');
    expect(logged).toContain('system words');
    expect(logged.some((line) => line.includes('<external-update>'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S5: a scope that settles asks must retract their voicings too
// ---------------------------------------------------------------------------

describe('duplex abort and parked ask voicings', () => {
  it("abort('work') does not let a dead request get read out afterwards", async () => {
    const { facade, talkerLoop, talkerPi } = await createRealDuplexScenario(ASKING_NETWORK);
    const resolver = facade.getNetworkAccessResolver();
    if (!resolver) throw new Error('duplex did not wire a network resolver');

    // Busy talker, so the voicing parks instead of being read out now.
    talkerPi.hold = true;
    const spoken = facade.prompt('kick something off');
    await waitUntil(() => talkerPi.promptCalls.length === 1, 2000, 'talker busy');

    const blocked = resolver(EGRESS);
    await waitUntil(() => talkerLoop.pendingWakeDeliveryCount === 1, 2000, 'voicing parked');

    // The work is stopped, so the request dies with it.
    await facade.abort('work');
    expect(await blocked).toEqual({ decision: 'deny' });
    expect(facade.getPendingAsks()).toEqual([]);

    // Release the talker. Its next run must not read out a request that no
    // longer exists: the user would answer it into an empty registry and be
    // told there is nothing pending.
    talkerPi.releaseRun();
    await spoken;
    await waitUntil(() => facade.conversationIdle, 2000, 'talker idle');
    await settle();

    const voiced = promptTexts(talkerPi).filter((text) => text.includes('<permission-request'));
    expect(voiced).toEqual([]);
    expect(lifecycleEvents(facade, 'ask_voicing_dropped')).toHaveLength(1);
  });

  it('leaves other parked content, and its cause tags, alone', async () => {
    const { facade, talkerLoop, talkerPi } = await createRealDuplexScenario(ASKING_NETWORK);
    const resolver = facade.getNetworkAccessResolver();
    if (!resolver) throw new Error('duplex did not wire a network resolver');

    talkerPi.hold = true;
    const spoken = facade.prompt('kick something off');
    await waitUntil(() => talkerPi.promptCalls.length === 1, 2000, 'talker busy');

    const blocked = resolver(EGRESS);
    await waitUntil(() => talkerLoop.pendingWakeDeliveryCount === 1, 2000, 'voicing parked');
    // A user barge-in parks behind the voicing.
    const bargeIn = facade.prompt('actually, also check the logs');
    await waitUntil(() => talkerLoop.pendingWakeDeliveryCount === 2, 2000, 'barge-in parked');

    await facade.abort('work');
    expect(await blocked).toEqual({ decision: 'deny' });
    // Only the voicing was retracted.
    expect(talkerLoop.pendingWakeDeliveryCount).toBe(1);

    talkerPi.releaseRun();
    await Promise.all([spoken, bargeIn]);
    await waitUntil(() => facade.conversationIdle, 2000, 'talker idle');

    const sweep = promptTexts(talkerPi).join('\n');
    expect(sweep).toContain('actually, also check the logs');
    expect(sweep).not.toContain('<permission-request');
  });

  it('tells its own voicing from other parked content with the same text', async () => {
    const { facade, talkerLoop, talkerPi } = await createRealDuplexScenario(ASKING_NETWORK);
    const resolver = facade.getNetworkAccessResolver();
    if (!resolver) throw new Error('duplex did not wire a network resolver');

    talkerPi.hold = true;
    const spoken = facade.prompt('kick something off');
    await waitUntil(() => talkerPi.promptCalls.length === 1, 2000, 'talker busy');
    const blocked = resolver(EGRESS);
    await waitUntil(() => talkerLoop.pendingWakeDeliveryCount === 1, 2000, 'voicing parked');

    // Another producer parks content that happens to read exactly like it.
    const voicingText = partsOf(talkerLoop).queues.wake[0]!.content;
    facade.deliver(voicingText, { speaker: 'user' });
    expect(talkerLoop.pendingWakeDeliveryCount).toBe(2);
    expect(partsOf(talkerLoop).queues.wake[1]!.content).toBe(voicingText);

    await facade.abort('work');
    expect(await blocked).toEqual({ decision: 'deny' });
    // Only the session's own delivery went; the look-alike stays parked.
    expect(talkerLoop.pendingWakeDeliveryCount).toBe(1);
    expect(lifecycleEvents(facade, 'ask_voicing_dropped')).toHaveLength(1);

    talkerPi.releaseRun();
    await spoken;
    await waitUntil(() => facade.conversationIdle, 2000, 'talker idle');
  });
});
