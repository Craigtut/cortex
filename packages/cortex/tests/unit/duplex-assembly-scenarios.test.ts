/**
 * Phase 3: scenarios driven through the REAL CortexAgent.create().
 *
 * Every other duplex scenario suite constructs the two loops directly and
 * hands them to the facade constructor, which means create()'s own assembly
 * never runs: the role prompts, the facade-set hard talker maxTurns, the
 * fail-fast talker retry policy, the staggered compaction thresholds, and
 * the brokered permission resolver are all computed by builders that unit
 * tests pin separately, and nothing crosses between "the config is right"
 * and "the behavior is right".
 *
 * These scenarios close that seam. They go through create(), and then assert
 * from BEHAVIOR that each assembled property is live: a talker that really
 * stops at its cap, a role prompt that is really in the string pi would
 * send, a resolver that really turns a reasoner tool call into a voiced ask.
 *
 * The one substitution is the pi agent (see createRealDuplexScenario): pi's
 * own Agent and every provider call stay out. So what these scenarios cannot
 * catch is a defect inside pi-agent-core or in the provider wiring below
 * streamFn; everything Cortex assembles above that is live.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Type } from 'typebox';
import type { AgentLoop } from '../../src/agent-loop.js';
import type { CortexTool } from '../../src/tool-contract.js';
import type { RetryScheduledInfo } from '../../src/types.js';
import { TALKER_MAX_TURNS } from '../../src/duplex/assembly.js';
import { REASONER_ROLE_PROMPT, TALKER_ROLE_PROMPT } from '../../src/duplex/prompts.js';
import { CONTROL_TOOL_NAMES } from '../../src/duplex/control-tools.js';
import {
  createRealDuplexScenario,
  destroyLiveFacades,
  entriesOfType,
  getBroker,
  nextRequestSystemPrompt,
  promptTexts,
  settle,
  talkerHeadline,
  waitUntil,
} from './duplex-scenario-harness.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await destroyLiveFacades();
});

/**
 * The activation threshold the loop's LIVE observational engine runs on.
 * There is no public accessor; reading the engine is deliberate, because the
 * point of this assertion is the value the loop actually compacts by rather
 * than the value the config builder returned.
 */
function observationalActivationThreshold(loop: AgentLoop): number {
  const engine = (loop.getCompactionManager() as unknown as {
    observationalEngine: { config: { activationThreshold: number } } | null;
  }).observationalEngine;
  if (!engine) throw new Error('loop is not running observational memory');
  return engine.config.activationThreshold;
}

/** A consumer tool that needs permission before it runs. */
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

// ---------------------------------------------------------------------------
// 1. The hard talker turn cap
// ---------------------------------------------------------------------------

describe('assembled duplex: the talker\'s hard turn cap bounds a real exchange', () => {
  /**
   * Pins: the facade-set talker budget guard being LIVE, not merely present
   * in buildTalkerConfig's return value, and consumer budget config being
   * unable to raise it (D17 / review-findings F9).
   *
   * The oscillation driven here is the exact one the D17 code comment names
   * as an open question: a fast-tier model that answers the "say something"
   * nudge with another silent tool call. Each control-tool result has its
   * terminate suppressed (empty spoken text), so nothing else in the system
   * ends this run. Only maxTurns does.
   */
  it('a talker oscillating on silent control-tool calls stops at the facade cap', async () => {
    const h = await createRealDuplexScenario({
      // A consumer asking for a huge turn budget: it routes to the reasoner
      // and must not reach the talker.
      budgetGuard: { maxTurns: 500, scope: 'prompt' },
    });
    h.reasonerPi.defaultText = '';
    // Far more turns than the cap, all silent, all non-terminating.
    h.talkerPi.script = Array.from({ length: 30 }, (_, index) => ({
      text: '',
      calls: [{ name: 'spawn_task', args: { instructions: `attempt ${index}` } }],
    }));

    await h.facade.prompt('do the thing').catch(() => {});
    await waitUntil(() => !h.talkerLoop.isLoopActive, 3000, 'talker run ended');

    // Exactly the facade's cap: the run was aborted by the budget guard, not
    // by the harness bound (40) and not by the consumer's 500.
    expect(h.talkerPi.modelCalls).toBe(TALKER_MAX_TURNS);
    expect(h.talkerLoop.getBudgetGuard().getTurnCount()).toBe(TALKER_MAX_TURNS);
    // The consumer's number went where the routing table says it goes.
    expect(h.reasonerLoop.getBudgetGuard().getTurnCount()).toBeLessThan(500);
    const reasonerConfig = h.loopConfigs.find((config) => config.loopPath === 'reasoner')!;
    const talkerConfig = h.loopConfigs.find((config) => config.loopPath === 'talker')!;
    expect(reasonerConfig.budgetGuard?.maxTurns).toBe(500);
    expect(talkerConfig.budgetGuard?.maxTurns).toBe(TALKER_MAX_TURNS);
  });
});

// ---------------------------------------------------------------------------
// 2. Role prompts on the wire
// ---------------------------------------------------------------------------

describe('assembled duplex: each loop carries its own role prompt', () => {
  /**
   * Pins: appendRolePrompt being applied by create() and reaching the string
   * the provider would actually receive. Asserted on the transcript pi's
   * next request is built from, after the loop's real pre-request sync,
   * rather than on a Cortex-side getter.
   */
  it('the talker prompt pi would send carries the consumer prompt then the talker role', async () => {
    const h = await createRealDuplexScenario({
      initialBasePrompt: 'You are Ada, the house assistant.',
    });

    const talkerPrompt = nextRequestSystemPrompt(h.talkerPi);
    const reasonerPrompt = nextRequestSystemPrompt(h.reasonerPi);

    // Consumer identity first, role prompt after (system-prompt.md ordering).
    expect(talkerPrompt).toContain('You are Ada, the house assistant.');
    expect(talkerPrompt).toContain(TALKER_ROLE_PROMPT);
    expect(talkerPrompt.indexOf('You are Ada, the house assistant.'))
      .toBeLessThan(talkerPrompt.indexOf(TALKER_ROLE_PROMPT));

    // The rules the talker keys its injection handling on are really there.
    expect(talkerPrompt).toContain('<background-update>');
    expect(talkerPrompt).toContain('<permission-request');

    // And the two loops did not get each other's role.
    expect(reasonerPrompt).toContain(REASONER_ROLE_PROMPT);
    expect(reasonerPrompt).not.toContain(TALKER_ROLE_PROMPT);
    expect(talkerPrompt).not.toContain(REASONER_ROLE_PROMPT);
  });

  it('a mid-session base prompt change re-applies both role prompts', async () => {
    const h = await createRealDuplexScenario();
    h.facade.setBasePrompt('You are Bea now.');

    expect(nextRequestSystemPrompt(h.talkerPi)).toContain('You are Bea now.');
    expect(nextRequestSystemPrompt(h.talkerPi)).toContain(TALKER_ROLE_PROMPT);
    expect(nextRequestSystemPrompt(h.reasonerPi)).toContain(REASONER_ROLE_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// 3. The brokered resolver
// ---------------------------------------------------------------------------

describe('assembled duplex: the brokered resolver is the one a tool call hits', () => {
  /**
   * Pins: withBrokeredPermissions running inside create() AND its output
   * reaching the reasoner's permission gate. The consumer resolver here says
   * `ask`; if create() handed the raw resolver to the loop instead of the
   * brokered wrapper, that `ask` would block the run with nothing voiced,
   * no ask entry, and no way for the user to answer.
   */
  it('a reasoner ask becomes a voiced conversation ask and settles from the user answer', async () => {
    const deployed: string[] = [];
    const resolverCalls: string[] = [];
    const h = await createRealDuplexScenario({
      tools: [deployTool(deployed)],
      resolvePermission: async (toolName) => {
        resolverCalls.push(toolName);
        return { decision: 'ask' };
      },
    });

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
    // The consumer's own resolver was consulted, through the wrapper.
    expect(resolverCalls).toEqual(['Deploy']);
    // The wrapper turned its `ask` into a voiced conversation ask.
    const voiced = promptTexts(h.talkerPi).find((text) => text.includes('permission-request'))!;
    expect(voiced).toContain('ship --prod');
    expect(deployed).toHaveLength(0);
    await waitUntil(() => !h.talkerLoop.isLoopActive, 2000, 'talker idle');

    // No askId: the tool does not take one, and the answer binds to the ask
    // that was voiced. Passing one here would read as if it selected the
    // target when nothing would be reading it.
    h.talkerPi.script = [{
      text: 'Approving.',
      calls: [{ name: 'answer_ask', args: { decision: 'allow' } }],
    }];
    await h.facade.prompt('yes, go ahead');

    await waitUntil(() => deployed.length === 1, 2000, 'tool ran after approval');
    expect(deployed).toEqual(['ship --prod']);
    expect(getBroker(h.facade).pendingAskCount).toBe(0);
  });

  /**
   * Pins: the talker being constructed with NO resolver (communication.md).
   * Wiring the broker as the talker's own resolver would deadlock answer_ask
   * against the ask it is answering, so this is asserted on the assembled
   * config rather than on the builder's return value.
   */
  it('the talker gets no permission resolver even when the consumer configures one', async () => {
    const h = await createRealDuplexScenario({
      resolvePermission: async () => ({ decision: 'ask' }),
      resolveNetworkAccess: async () => ({ decision: 'allow' }),
    });
    const talkerConfig = h.loopConfigs.find((config) => config.loopPath === 'talker')!;
    const reasonerConfig = h.loopConfigs.find((config) => config.loopPath === 'reasoner')!;

    expect(talkerConfig.resolvePermission).toBeUndefined();
    expect(talkerConfig.resolveNetworkAccess).toBeUndefined();
    // The reasoner's is the wrapper, not the consumer's own function.
    expect(reasonerConfig.resolvePermission).toBeDefined();
    expect(h.talkerPi.beforeToolCall).toBeUndefined();
    expect(h.reasonerPi.beforeToolCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-fast talker retries and staggered compaction
// ---------------------------------------------------------------------------

describe('assembled duplex: the talker\'s posture differs from the reasoner\'s', () => {
  /**
   * Pins: TALKER_RETRY_POLICY reaching the talker loop. The default policy
   * would schedule the first retry 120 seconds out with 20 attempts, which
   * on the presence loop is minutes of silence; the fail-fast policy is one
   * second and two attempts. Read off the retry hook, which fires before the
   * backoff wait, so nothing here waits out a backoff.
   */
  it('a transient talker failure schedules a fail-fast retry, not a two-minute one', async () => {
    const h = await createRealDuplexScenario();
    const scheduled: RetryScheduledInfo[] = [];
    h.talkerLoop.onRetryScheduled((info) => scheduled.push(info));
    h.talkerPi.failWith = new Error('ECONNRESET while contacting the provider');

    void h.facade.prompt('hello').catch(() => {});
    await waitUntil(() => scheduled.length === 1, 2000, 'retry scheduled');

    expect(scheduled[0]).toMatchObject({
      category: 'network',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    // Stop before the backoff elapses; the assertion above is the proof.
    await h.facade.abort('conversation');
  });

  /**
   * Pins: the compaction stagger reaching the engine each loop actually
   * compacts by, so a blocking activation on one loop never coincides with
   * one on the other. Read off the live managers rather than the config.
   */
  it('the talker compacts strictly before the reasoner under observational memory', async () => {
    const h = await createRealDuplexScenario({
      compaction: { observational: { activationThreshold: 0.8 } },
    });

    const reasonerThreshold = observationalActivationThreshold(h.reasonerLoop);
    const talkerThreshold = observationalActivationThreshold(h.talkerLoop);
    expect(reasonerThreshold).toBe(0.8);
    expect(talkerThreshold).toBeLessThan(reasonerThreshold);

    // And the presence loop never blocks a turn to compact (F7).
    const talkerConfig = h.loopConfigs.find((config) => config.loopPath === 'talker')!;
    expect(talkerConfig.compaction?.nonBlocking).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The rest of what create() wires, proven live
// ---------------------------------------------------------------------------

describe('assembled duplex: the wiring create() does after construction', () => {
  it('gives the talker the control tools, a headline feed, and no built-in toolset', async () => {
    const h = await createRealDuplexScenario();

    const talkerTools = (h.talkerPi.state.tools as Array<{ name: string }>).map((t) => t.name);
    for (const name of CONTROL_TOOL_NAMES) expect(talkerTools).toContain(name);
    expect(talkerTools).not.toContain('Bash');
    expect(talkerTools).not.toContain('Read');
    expect(talkerTools).not.toContain('SubAgent');

    // The nonce never reaches the talker through a tool schema either, and
    // this reads the schema the talker was ACTUALLY given rather than one
    // built for the occasion: buildControlTools() output proves what the
    // builder makes, not what create() registered, and the two are only the
    // same until someone wires a different toolset.
    const registeredAnswerAsk = (h.talkerPi.state.tools as Array<{ name: string }>)
      .find((tool) => tool.name === 'answer_ask')!;
    expect(registeredAnswerAsk).toBeDefined();
    const answerAskSchema = JSON.stringify(registeredAnswerAsk);
    expect(answerAskSchema).not.toContain('askId');
    expect(answerAskSchema).not.toContain('ask id');
    // Passing for the right reason: the parameters it does take are here,
    // so an empty or renamed schema fails instead of satisfying the above.
    expect(answerAskSchema).toContain('decision');
    expect(answerAskSchema).toContain('reason');

    // The reasoner keeps the working surface plus the duplex tools.
    const reasonerTools = (h.reasonerPi.state.tools as Array<{ name: string }>).map((t) => t.name);
    expect(reasonerTools).toContain('Deliver');
    expect(reasonerTools).toContain('SteerSubAgent');
    expect(reasonerTools).toContain('Bash');
    for (const name of CONTROL_TOOL_NAMES) expect(reasonerTools).not.toContain(name);

    // The headline provider is wired (talkerHeadline throws when it is not);
    // with nothing running yet it has nothing to report.
    expect(talkerHeadline(h.talkerLoop)).toBeNull();
  });

  it('derives a distinct talker cache identity from the consumer session id', async () => {
    const h = await createRealDuplexScenario({ sessionId: 'session-42' });
    // The reasoner keeps the bare id so a mode flip keeps its prefix cache.
    expect(h.reasonerLoop.getSessionId()).toBe('session-42');
    expect(h.talkerLoop.getSessionId()).toBe('session-42:talker');
  });

  it('runs one whole delegate-and-deliver exchange end to end through create()', async () => {
    const h = await createRealDuplexScenario();
    h.reasonerPi.defaultText = '';
    h.talkerPi.script = [{
      text: 'On it.',
      calls: [{ name: 'spawn_task', args: { instructions: 'fix the failing test' } }],
    }];
    await h.facade.prompt('the test is failing');
    await waitUntil(() => h.reasonerPi.promptCalls.length === 1, 2000, 'dispatched');

    // The dispatch carries the conversation as context, never as instruction.
    const dispatch = promptTexts(h.reasonerPi)[0]!;
    expect(dispatch).toContain('<conversation-context>');
    expect(dispatch).toContain('the test is failing');
    expect(dispatch).toContain('[Directive] New task "task-1"');

    h.reasonerPi.script = [{
      text: '',
      calls: [{
        name: 'Deliver',
        args: { content: 'Fixed it: a stale fixture.', wake: 'interrupt' },
      }],
    }];
    h.talkerPi.script = [{ text: 'Done: it was a stale fixture.' }];
    h.facade.deliver('any update?', { target: 'work' });

    await waitUntil(
      () => entriesOfType(h.facade, 'delivery').length === 1,
      2000, 'delivered',
    );
    await settle();
    // The delivery reached the talker inside the wrapper its role prompt
    // keys on, which is the pairing the two halves of assembly have to agree
    // about.
    const carried = promptTexts(h.talkerPi).find((text) => text.includes('Fixed it'))!;
    expect(carried).toContain('<background-update>');
  });
});
