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

/** A pi OAuth credential blob. `expires` is epoch millis. */
export interface PiOAuthCredential extends Record<string, unknown> {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
}

/** Request auth pi derives from a credential. */
interface PiModelAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}

/**
 * pi's per-provider OAuth implementation, reached through
 * `builtinProviders()`: pi has no global OAuth registry. Nor does it turn a
 * credential into an API key, so OAuthFlows.resolveApiKey derives one from
 * refresh + toAuth.
 */
export interface PiOAuthAuth {
  name: string;
  isSubscription?: boolean;
  loginLabel?: string;
  login: (interaction: PiAuthInteraction) => Promise<PiOAuthCredential>;
  refresh: (credential: PiOAuthCredential, signal: AbortSignal) => Promise<PiOAuthCredential>;
  toAuth: (credential: PiOAuthCredential) => Promise<PiModelAuth>;
}

/** pi's login prompt shapes. `select` resolves to the chosen option id. */
export type PiAuthPrompt = { signal?: AbortSignal } & (
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: readonly { id: string; label: string; description?: string }[] }
  | { type: 'manual_code'; message: string; placeholder?: string }
);

/** pi's login progress events. */
export type PiAuthEvent =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: 'progress'; message: string };

export interface PiAuthInteraction {
  signal: AbortSignal;
  prompt: (prompt: PiAuthPrompt) => Promise<string>;
  notify: (event: PiAuthEvent) => void;
}

interface PiBuiltinProvider {
  id: string;
  name?: string;
  auth?: { oauth?: PiOAuthAuth };
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

/**
 * Load pi's builtin provider list, asserting the symbol we need is really there.
 *
 * The assertion is the point. A dynamic import of a module that exports
 * nothing SUCCEEDS and yields `{}`, so a try/catch around the import cannot
 * detect an emptied entrypoint, and a cast to a hand-written all-optional
 * interface makes `{}` typecheck. Unchecked, a pi release that moves this
 * export reaches users as the false "provider does not support OAuth". Name
 * the missing function so it fails loudly here instead.
 */
async function loadPiBuiltinProviders(): Promise<PiBuiltinProvider[]> {
  let mod: Record<string, unknown>;
  try {
    const modulePath = '@earendil-works/pi-ai/providers/all';
    mod = await import(/* @vite-ignore */ modulePath) as Record<string, unknown>;
  } catch {
    throw new Error(
      'pi-ai is not installed. Install @earendil-works/pi-ai to use OAuth features.',
    );
  }

  const builtinProviders = mod['builtinProviders'];
  if (typeof builtinProviders !== 'function') {
    throw new Error(
      'pi-ai/providers/all does not export builtinProviders(). The installed ' +
        'pi-ai is incompatible with this version of Cortex.',
    );
  }
  return (builtinProviders as () => PiBuiltinProvider[])();
}

/**
 * Resolve one provider's OAuth implementation, or null if it has none.
 */
export async function loadPiOAuth(providerId: string): Promise<PiOAuthAuth | null> {
  const providers = await loadPiBuiltinProviders();
  return providers.find(p => p.id === providerId)?.auth?.oauth ?? null;
}

/** Provider ids whose pi definition ships an OAuth flow. */
export async function loadOAuthCapableProviderIds(): Promise<string[]> {
  const providers = await loadPiBuiltinProviders();
  return providers.filter(p => p.auth?.oauth).map(p => p.id).sort();
}
