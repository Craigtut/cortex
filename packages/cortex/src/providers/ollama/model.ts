import { wrapModel, unwrapModel } from '../../model-wrapper.js';
import { resolveOllamaRuntime } from './runtime.js';
import type { OllamaModelConfig, OllamaPiModel, OllamaRuntime } from './runtime.js';
import { ollamaThinkingMap } from './thinking.js';
import { OLLAMA_API } from './provider.js';

export async function createOllamaModel(config: OllamaModelConfig) {
  const runtime = await resolveOllamaRuntime(config);
  const model: OllamaPiModel & { cortexCapabilities: import('../../model-wrapper.js').ModelCapabilities } = {
    id: runtime.modelId, name: runtime.modelId, provider: 'ollama',
    api: OLLAMA_API,
    baseUrl: runtime.connection.baseUrl!,
    contextWindow: runtime.contextWindow, maxTokens: runtime.maxOutputTokens,
    reasoning: runtime.capabilities.includes('thinking'),
    thinkingLevelMap: ollamaThinkingMap(runtime.thinking)!,
    input: runtime.capabilities.includes('vision') ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ollamaRuntime: runtime,
    cortexCapabilities: {
      promptCaching: 'automatic-prefix',
      ...(runtime.trainedContextWindow ? { trainedContextWindow: runtime.trainedContextWindow } : {}),
      structuredOutput: 'json-schema',
      // One request per model by default (OLLAMA_NUM_PARALLEL=1).
      concurrency: config.parallelRequests === true ? 'parallel' : 'serial',
    },
  };
  return wrapModel(model, 'ollama', model.id, runtime.contextWindow);
}

export function getOllamaRuntimeInfo(model: import('../../model-wrapper.js').CortexModel): Pick<OllamaRuntime, 'contextWindow' | 'trainedContextWindow' | 'thinking'> | null {
  if (model.provider !== 'ollama') return null;
  const runtime = (unwrapModel(model) as OllamaPiModel).ollamaRuntime;
  return runtime ? { contextWindow: runtime.contextWindow,
    ...(runtime.trainedContextWindow ? { trainedContextWindow: runtime.trainedContextWindow } : {}),
    thinking: runtime.thinking } : null;
}
