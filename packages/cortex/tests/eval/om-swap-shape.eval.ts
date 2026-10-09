/**
 * Does Anthropic accept the request a swap leaves in the middle of a tool
 * loop?
 *
 * When the latest user message is far back, a swap keeps that message, then
 * the verbatim tail, and removes the whole units between them: assistant
 * tool-call turns of the loop that is still running, thinking blocks
 * included. No other rewrite produces that shape. The design expects
 * Anthropic to need thinking blocks only on the last assistant turn of an
 * active tool loop, which the tail always keeps whole, and pi-ai sends
 * `prefix_mismatch_behavior: drop_block` for the models that support it
 * (Opus 5.5, Fable 5.1, Sonnet 5.5, Haiku 5.5). This runs a real tool loop
 * that swaps mid-run and checks that every request after the swap was
 * accepted and the loop finished coherently.
 *
 * The observer is a stub: the question is the request shape, not
 * observation quality, and a stub keeps the swap deterministic and cheap.
 *
 * Skipped unless credentials already exist (an `ANTHROPIC_API_KEY` or a
 * cached `.eval-credentials.json`, see helpers/auth.ts): it never starts an
 * interactive login on its own.
 *
 * Models: `CORTEX_EVAL_SWAP_MODELS` (comma-separated), default
 * claude-opus-5-5, claude-fable-5-1 (both drop_block) and claude-sonnet-5
 * (adaptive thinking without block binding). Roughly 40-60k input tokens per
 * model; Fable 5.1 is the expensive one.
 *
 * `CORTEX_EVAL_SWAP_BASE_URL` points the run at another Anthropic-compatible
 * endpoint (a recorded or mock server), which checks the eval's own
 * mechanics without a real provider.
 *
 * Run with: npm run test:eval -- om-swap-shape
 */

import * as os from 'node:os';
import { describe, it, expect } from 'vitest';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent } from '../../src/agent-loop.js';
import { wrapModel } from '../../src/model-wrapper.js';
import { TOOL_NAMES } from '../../src/tools/index.js';
import type { CortexTool } from '../../src/tool-contract.js';
import type { AgentMessage } from '../../src/context-manager.js';
import type { CompleteFn, ObservationEvent } from '../../src/compaction/index.js';
import { hasEvalCredentials } from './helpers/provider.js';
import { resolveEvalApiKey } from './helpers/auth.js';

const BASE_URL = process.env['CORTEX_EVAL_SWAP_BASE_URL'];
const MODELS = (process.env['CORTEX_EVAL_SWAP_MODELS'] ?? 'claude-opus-5-5,claude-fable-5-1,claude-sonnet-5')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id.length > 0);

const PARTS = 6;
const CODES = ['amber', 'cobalt', 'juniper', 'saffron', 'pewter', 'vermilion'];

/** About 2,400 tokens per part: three parts fill most of the 20,000-token window. */
function part(n: number): string {
  const lines = Array.from({ length: 160 }, (_, i) => `Part ${n}, line ${i + 1}: the archive records nothing remarkable here.`);
  return `${lines.join('\n')}\nCODE: ${CODES[n - 1]}`;
}

const readPart: CortexTool<{ n: number }, string> = {
  name: 'read_part',
  description: 'Return part n (1 to 6) of the archive. Read the parts one at a time: one call, then the next.',
  parameters: {
    type: 'object',
    properties: { n: { type: 'integer', minimum: 1, maximum: PARTS } },
    required: ['n'],
  },
  execute: async ({ n }) => part(n),
};

const PROMPT = 'Read parts 1 through 6 of the archive with read_part, in order, exactly one call per turn. '
  + 'Before each call, think briefly about what the previous part contained. Each part ends with a line '
  + '"CODE: <word>". After reading part 6, reply with only the code word from part 6.';

const STUB_OBSERVATION = '<observations>\nDate: Oct 9, 2026\n* 🟡 (10:00) The agent is reading the archive part by part with read_part; the parts read so far held only routine lines.\n</observations>\n\n'
  + '<current-task>\nPrimary: read the remaining archive parts in order, then reply with the code word from part 6.\n</current-task>';

type Content = Array<{ type: string; name?: string; arguments?: Record<string, unknown> }>;

function contentOf(message: AgentMessage): Content {
  return Array.isArray(message.content) ? message.content as Content : [];
}

/** The part numbers an assistant message calls read_part for. */
function partsCalled(message: AgentMessage): number[] {
  if (message.role !== 'assistant') return [];
  return contentOf(message)
    .filter((block) => block.type === 'toolCall' && block.name === 'read_part')
    .map((block) => Number(block.arguments?.['n']));
}

function hasThinking(message: AgentMessage): boolean {
  return message.role === 'assistant' && contentOf(message).some((block) => block.type === 'thinking');
}

function textOf(message: AgentMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return contentOf(message)
    .filter((block) => block.type === 'text')
    .map((block) => (block as unknown as { text: string }).text)
    .join('');
}

describe.skipIf(!hasEvalCredentials('anthropic'))('a swap in the middle of a running tool loop (Anthropic)', () => {
  for (const modelId of MODELS) {
    it(`${modelId}: every request after the swap is accepted and the loop finishes`, async () => {
      const builtin = getBuiltinModel('anthropic' as never, modelId as never);
      const raw = BASE_URL ? { ...(builtin as object), baseUrl: BASE_URL } : builtin;
      const loop = await AgentLoop.create({
        model: wrapModel(raw, 'anthropic', modelId),
        workingDirectory: os.tmpdir(),
        initialBasePrompt: 'You are a careful assistant that follows instructions exactly.',
        thinkingLevel: 'high',
        // Effective window 20,000 tokens: activation at 50%, a verbatim tail
        // of 4,000 (one or two parts), so the loop swaps after part three.
        contextWindowLimit: 20_000,
        compaction: { observational: { activationThreshold: 0.5 } },
        getApiKey: (provider) => resolveEvalApiKey(provider),
        disableTools: Object.values(TOOL_NAMES),
        tools: [readPart as unknown as CortexTool],
        enableSubAgentTool: false,
        enableLoadSkillTool: false,
      });
      const observer = (async () => STUB_OBSERVATION) as CompleteFn;
      loop.getCompactionManager().setObservationalCompleteFn(observer);

      const errors: string[] = [];
      loop.onError((error) => errors.push(error.originalMessage ?? String(error)));
      const swaps: ObservationEvent[] = [];
      loop.onObservation((event) => { if (event.removedMessages.length > 0) swaps.push(event); });

      // What each request carried: pi reads its transform hook per call.
      const pi = (loop as unknown as { agent: PiAgent }).agent as unknown as {
        transformContext: (messages: unknown[]) => Promise<AgentMessage[]>;
      };
      const sent: AgentMessage[][] = [];
      const transform = pi.transformContext;
      pi.transformContext = async (messages) => {
        const out = await transform(messages);
        sent.push([...out]);
        return out;
      };

      try {
        // A rejected request ends the run; report what was sent before failing.
        let runError: string | null = null;
        try {
          await loop.prompt(PROMPT);
        } catch (err) {
          runError = err instanceof Error ? err.message : String(err);
        }

        const historyStart = loop.getContextManager().historyStart;
        const shaped = sent.filter((messages) => {
          const history = messages.slice(historyStart);
          const called = history.flatMap(partsCalled);
          return textOf(history[0]).includes('Read parts 1 through 6')
            && called.length > 0
            && !called.includes(1);
        });
        const lastAssistant = (messages: AgentMessage[]): AgentMessage | undefined =>
          [...messages].reverse().find((message) => message.role === 'assistant');
        const final = loop.getConversationHistory().filter((message) => message.role === 'assistant').at(-1);
        const usage = loop.getSessionUsage();

        console.log(JSON.stringify({
          modelId,
          requests: sent.length,
          swaps: swaps.map((event) => ({ trigger: event.trigger, removed: event.removedMessages.length })),
          removedMiddleRequests: shaped.length,
          withThinkingOnLastAssistant: shaped.filter((messages) => hasThinking(lastAssistant(messages) ?? ({} as AgentMessage))).length,
          finalText: textOf(final as AgentMessage | undefined).slice(0, 80),
          costUsd: usage.totalCost,
          runError,
          errors,
        }));

        // Preconditions: the loop really swapped while running, and sent
        // requests whose kept units start mid-loop (part 1's turn removed,
        // the latest user message kept at the front).
        expect(swaps.some((event) => event.trigger === 'activation'
          && event.removedMessages.some((message) => partsCalled(message).length > 0))).toBe(true);
        expect(shaped.length, 'no request carried the removed-middle shape').toBeGreaterThan(0);
        expect(
          shaped.some((messages) => hasThinking(lastAssistant(messages) ?? ({} as AgentMessage))),
          'inconclusive: no removed-middle request kept a thinking block on its last assistant turn',
        ).toBe(true);

        // The question: the provider accepted every one of them.
        expect(runError).toBeNull();
        expect(errors).toEqual([]);
        expect(textOf(final as AgentMessage | undefined).toLowerCase()).toContain('vermilion');
      } finally {
        await loop.destroy();
      }
    }, 300_000);
  }
});
