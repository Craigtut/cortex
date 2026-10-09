/**
 * The pi-ai boundary for ProviderManager: every dynamic import of pi-ai,
 * and the pi shapes Cortex reads through it.
 *
 * Pi-ai is loaded dynamically so consumers never import it directly. If the
 * dependency is missing or unavailable, the loaders throw clear errors.
 */

// ---------------------------------------------------------------------------
// Pi-ai dynamic import types
// ---------------------------------------------------------------------------

/**
 * Shape of the pi-ai functions ProviderManager uses. pi-ai spreads these
 * across entrypoints: catalog reads live on `providers/all` and
 * thinking-level helpers on the root. `loadPiAi()` composes them back into
 * this single object. Requests go through the model runtime
 * (model-runtime.ts).
 */
export interface PiAiModule {
  getModel: (provider: string, modelId: string) => unknown;
  getModels: (provider: string) => Array<Record<string, unknown>>;
  getSupportedThinkingLevels?: ((model: unknown) => string[]) | undefined;
}

// ---------------------------------------------------------------------------
// Pi-ai dynamic import helpers
// ---------------------------------------------------------------------------

/**
 * Lazily load the pi-ai main module.
 * Throws a clear error if pi-ai is not installed.
 */
export async function loadPiAi(): Promise<PiAiModule> {
  try {
    // Compose the subset ProviderManager needs from each entrypoint: catalog
    // reads from `providers/all` and thinking-level helpers from root.
    // String-literal paths avoid bundler resolution.
    const catalogPath = '@earendil-works/pi-ai/providers/all';
    const rootPath = '@earendil-works/pi-ai';
    const [catalog, root] = await Promise.all([
      import(/* @vite-ignore */ catalogPath) as Promise<{
        getBuiltinModel: (provider: string, modelId: string) => unknown;
        getBuiltinModels: (provider: string) => Array<Record<string, unknown>>;
      }>,
      import(/* @vite-ignore */ rootPath) as Promise<{
        getSupportedThinkingLevels?: (model: unknown) => string[];
      }>,
    ]);
    return {
      getModel: catalog.getBuiltinModel,
      getModels: catalog.getBuiltinModels,
      getSupportedThinkingLevels: root.getSupportedThinkingLevels,
    };
  } catch {
    throw new Error(
      'pi-ai is not installed. Install @earendil-works/pi-ai to use ProviderManager.'
    );
  }
}
