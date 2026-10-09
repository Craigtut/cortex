#!/usr/bin/env node
// Build Cortex first. This probes one selected model sequentially and never unloads it.
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ProviderManager, completeModel } from '../packages/cortex/dist/index.js';

const { values } = parseArgs({ options: {
  model: { type: 'string' }, host: { type: 'string' },
  repeats: { type: 'string', default: '3' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('Usage: node tools/benchmark-ollama.mjs --model <installed-model> [--host <url>] [--repeats 3]');
  console.log('Runs new-prefix, repeat-prefix, and appended-turn requests sequentially. Uses the existing allocation; never unloads models.');
  process.exit(0);
}
if (!values.model) throw new Error('Provide --model');
const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be between 1 and 20');
let metrics;
const model = await new ProviderManager().createOllamaModel({
  modelId: values.model, baseUrl: values.host,
  onMetrics: value => { metrics = value; },
});
console.log(JSON.stringify({ model: model.modelId, contextWindow: model.contextWindow,
  trainedContextWindow: model.capabilities?.trainedContextWindow }));

const lines = Math.min(250, Math.floor(model.contextWindow / 100));
const prefix = `Synthetic benchmark ${randomUUID()}.\n` + Array.from({ length: lines }, (_, i) =>
  `Reference item ${i}: a stable example for measuring repeated prompt processing.\n`).join('');
const context = { systemPrompt: 'Answer with the word OK. Do not call tools.', messages: [
  { role: 'user', content: prefix + '\nAcknowledge this reference.', timestamp: Date.now() },
] };
async function run(phase, input) {
  metrics = undefined;
  const result = await completeModel(model, input, {
    maxTokens: 32, temperature: 0,
    onPayload: payload => {
      payload.options.top_p = 1;
    },
  });
  if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error(result.errorMessage);
  console.log(JSON.stringify({ phase, ...metrics, stopReason: result.stopReason,
    ...(metrics?.generationMs > 0 ? { outputTokensPerSecond: metrics.outputTokens * 1000 / metrics.generationMs } : {}),
  }));
  return result;
}
const answer = await run('new-prefix', context);
for (let i = 0; i < repeats; i++) await run(`repeat-prefix-${i + 1}`, context);
await run('appended-turn', { ...context, messages: [...context.messages, answer,
  { role: 'user', content: 'Acknowledge again.', timestamp: Date.now() },
] });
