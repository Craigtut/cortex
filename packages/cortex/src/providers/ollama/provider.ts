import { createProvider } from '@earendil-works/pi-ai';
import type { Provider } from '@earendil-works/pi-ai';
import type { OllamaPiModel } from './runtime.js';
import { streamOllama } from './stream.js';

/** The API id Cortex's native Ollama codec answers to. */
export const OLLAMA_API = 'cortex-ollama-chat';

/**
 * Cortex's native Ollama provider, registered on the model runtime. A local
 * server needs no credentials, so its auth always resolves.
 */
export function ollamaProvider(): Provider {
  return createProvider({
    id: 'ollama',
    name: 'Ollama',
    auth: {
      apiKey: {
        name: 'Ollama (no key needed)',
        resolve: async () => ({ auth: {}, source: 'local server' }),
      },
    },
    models: [],
    api: {
      stream: streamOllama,
      streamSimple: (model, context, options) => streamOllama(model, context, {
        ...options,
        // Agent-core represents off as an omitted reasoning option. Clamp models
        // which cannot disable thinking to their weakest supported level.
        reasoning: options?.reasoning ?? ((model as OllamaPiModel).ollamaRuntime.thinking === 'levels' ? 'low' : 'off'),
      }),
    },
  });
}
