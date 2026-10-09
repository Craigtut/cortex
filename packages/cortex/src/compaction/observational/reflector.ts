/**
 * Reflector module for the observational memory system.
 *
 * The Reflector condenses observations when they grow too large. It runs
 * on the utility model and uses progressive compression: starting with
 * no compression guidance (level 0) and escalating through levels 1-4
 * if the output exceeds the target token threshold.
 *
 * References:
 *   - observational-memory-architecture.md (Reflector System section)
 *   - compaction-strategy.md
 */

import type { CompleteFn } from '../compaction.js';
import type { ReflectorOutput } from './types.js';
import {
  REFLECTOR_SYSTEM_PROMPT,
  COMPRESSION_LEVEL_GUIDANCE,
} from './constants.js';
import { estimateTokens } from '../../token-estimator.js';
import { MemoryReplyError, readObservationsBlock } from './reply.js';
import { callWithPolicy, SINGLE_ATTEMPT } from './calls.js';
import type { CallPolicy } from './calls.js';

// ---------------------------------------------------------------------------
// Prompt Building
// ---------------------------------------------------------------------------

/**
 * Build the full reflector system prompt.
 *
 * Starts with the base reflector prompt, then appends compression level
 * guidance and optional consumer instructions.
 *
 * @param compressionLevel - Compression level (0-4). Level 0 adds no
 *   compression guidance.
 * @param customInstruction - Optional consumer-provided instruction to
 *   append to the prompt.
 * @returns The assembled system prompt string.
 */
export function buildReflectorPrompt(
  compressionLevel: number,
  customInstruction?: string,
): string {
  let prompt = REFLECTOR_SYSTEM_PROMPT;

  const guidance = COMPRESSION_LEVEL_GUIDANCE[compressionLevel];
  if (compressionLevel > 0 && guidance) {
    prompt += `\n\n## Compression Target\n\n${guidance}`;
  }

  if (customInstruction) {
    prompt += `\n\n## Additional Instructions\n\n${customInstruction}`;
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Message Building
// ---------------------------------------------------------------------------

/**
 * Build the message array to send to the reflector LLM.
 *
 * Creates two user messages: one containing the observations to reflect on,
 * and one with the output instruction.
 *
 * @param observations - The full observation text to consolidate.
 * @returns An array of message objects for the LLM call.
 */
export function buildReflectorMessages(
  observations: string,
): unknown[] {
  return [
    {
      role: 'user',
      content:
        'Here are all current observations to reflect on and consolidate:\n\n' +
        observations,
    },
    {
      role: 'user',
      content:
        'Produce your consolidated reflections. Follow the observation format exactly. Output ONLY the consolidated observations, nothing else.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Output Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the raw LLM output from the reflector.
 *
 * Strips analysis/thinking tags, then returns the content of the required
 * `<observations>` block. An empty block is a failure here: a reflection
 * replaces the whole log, so an empty one would erase it.
 *
 * @param raw - The raw string output from the reflector LLM call.
 * @returns The cleaned observation text.
 * @throws MemoryReplyError when the reply is empty, has no observations
 *   block, ends inside it, or the block is empty
 */
export function parseReflectorOutput(raw: string): string {
  let output = raw;

  // Strip analysis/thinking tags if present
  output = output.replace(/<analysis>[\s\S]*?<\/analysis>/g, '');
  output = output.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');

  const observations = readObservationsBlock(output, 'reflector');
  if (observations.length === 0) {
    throw new MemoryReplyError('empty', 'The reflector returned an empty observations block');
  }
  return observations;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Check whether the reflector output is within the target token budget.
 *
 * @param output - The parsed reflector output text.
 * @param targetTokens - The maximum allowed token count.
 * @returns `true` if estimated tokens are at or below the target.
 */
export function validateCompression(
  output: string,
  targetTokens: number,
): boolean {
  return estimateTokens(output) <= targetTokens;
}

// ---------------------------------------------------------------------------
// Applying a reflection
// ---------------------------------------------------------------------------

/**
 * The log after a reflection lands, or null when it no longer applies.
 *
 * A reflection condenses the log as it was when the reflector started
 * (`input`). The log is append-only between reflections, so whatever was
 * appended since is a suffix the reflection never saw: it is kept after the
 * reflected text. A log that no longer starts with `input` was replaced in
 * the meantime (another reflection, a restore), and the result is stale.
 */
export function applyReflection(current: string, input: string, reflected: string): string | null {
  if (!current.startsWith(input)) return null;
  return reflected + current.slice(input.length);
}

// ---------------------------------------------------------------------------
// Threshold Computation
// ---------------------------------------------------------------------------

/**
 * Compute the effective reflection threshold by clamping to both the
 * primary model's context window and the utility model's context window.
 *
 * The threshold is the smaller of:
 * - `reflectionThreshold` as a percentage of the primary context window
 * - 50% of the utility model's context window (to ensure the reflector
 *   input fits within the utility model)
 *
 * @param contextWindow - The primary model's context window size in tokens.
 * @param reflectionThreshold - Fraction of the context window (e.g. 0.20).
 * @param utilityModelContextWindow - The utility model's context window
 *   size in tokens.
 * @returns The effective reflection threshold in tokens.
 */
export function computeEffectiveReflectionThreshold(
  contextWindow: number,
  reflectionThreshold: number,
  utilityModelContextWindow: number,
): number {
  return Math.min(
    contextWindow * reflectionThreshold,
    utilityModelContextWindow * 0.5,
  );
}

// ---------------------------------------------------------------------------
// Reflector Execution
// ---------------------------------------------------------------------------

const MAX_RETRIES = 4;
const MAX_COMPRESSION_LEVEL = 4;

/**
 * Run the reflector with progressive compression retry.
 *
 * Starts at compression level 0 and escalates if the output exceeds the
 * reflection threshold. Retries up to 3 times, incrementing the
 * compression level each time (capped at level 4).
 *
 * Even if the final attempt does not validate, it is returned when it is
 * smaller than the input: the observation slot will be larger than ideal,
 * but the next reflection cycle will try again.
 *
 * @param complete - The LLM completion function.
 * @param observations - The full observation text to consolidate.
 * @param config - Configuration with reflectionThreshold (in tokens) and
 *   optional reflectorInstruction.
 * @returns The reflector output with consolidated observations and the
 *   compression level that was applied.
 * @param call - Retry and timeout policy for each level's call (default:
 *   one attempt, no timeout) and the signal that cancels the whole run
 * @throws MemoryCallError when a level's call produced no usable reply
 * @throws MemoryReplyError when the final reflection is no smaller than its
 *   input
 */
export async function runReflector(
  complete: CompleteFn,
  observations: string,
  config: {
    reflectionThreshold: number;
    reflectorInstruction?: string;
  },
  call: { policy?: CallPolicy; signal?: AbortSignal } = {},
): Promise<ReflectorOutput> {
  let level = 0;
  let retries = 0;
  let parsedOutput = '';

  while (true) {
    const systemPrompt = buildReflectorPrompt(level, config.reflectorInstruction);
    const messages = buildReflectorMessages(observations);
    // A failed attempt retries this level; a usable but oversized reply
    // escalates to the next one below.
    parsedOutput = await callWithPolicy(
      async (signal) => parseReflectorOutput(
        await complete({ systemPrompt, messages }, { purpose: 'reflector', signal }),
      ),
      call.policy ?? SINGLE_ATTEMPT,
      call.signal,
    );

    if (validateCompression(parsedOutput, config.reflectionThreshold)) {
      return { observations: parsedOutput, compressionLevel: level };
    }

    if (level >= MAX_COMPRESSION_LEVEL || retries >= MAX_RETRIES) {
      break;
    }

    level++;
    retries++;
  }

  // Over target at every level. Still worth keeping only if it shrank the
  // log; a reflection no smaller than its input would only lose detail.
  if (estimateTokens(parsedOutput) >= estimateTokens(observations)) {
    throw new MemoryReplyError('not-smaller', 'The reflection is no smaller than the observations it condensed');
  }
  return { observations: parsedOutput, compressionLevel: level };
}
