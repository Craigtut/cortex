/**
 * Answers the agent's `getAuth(provider)` callback for an interactive
 * session: which stored credential serves a provider id. Provider
 * credentials resolve through Cortex's ProviderManager over the session's
 * credential store, which refreshes an OAuth token under the store's
 * cross-process lock, so a rotating refresh token is spent exactly once.
 */

import type { ModelAuth, ProviderManager } from '@animus-labs/cortex';
import type { CredentialStore } from '../config/credentials.js';

/**
 * Providers whose models carry their connection's own key: Cortex's
 * `createCustomModel()` (the synthetic id "custom", whatever the connection
 * is called) and `createOllamaModel()`. Cortex sends that key, or a
 * placeholder for a keyless endpoint, when this callback answers nothing.
 */
const MODEL_CARRIES_KEY: ReadonlySet<string> = new Set(['custom', 'ollama']);

export class AuthResolver {
  constructor(
    private readonly credentialStore: Pick<CredentialStore, 'getProvider'>,
    private readonly providerManager: Pick<ProviderManager, 'getAuth'>,
  ) {}

  /**
   * Request auth for a provider: a stored key, or OAuth refreshed under the
   * store's lock. Nothing for a local endpoint, whose model carries its key.
   *
   * Only a provider's own credential answers for it. A loop can outlive a
   * provider switch (a duplex talker still on the startup provider's model
   * after /model moved the session), and handing it the new provider's
   * credential would send a token to an endpoint it was not issued for.
   */
  async getAuth(provider: string): Promise<ModelAuth | undefined> {
    if (MODEL_CARRIES_KEY.has(provider)) return undefined;
    if (!await this.credentialStore.getProvider(provider)) {
      throw new Error(`No credentials for provider "${provider}". Run /login to connect.`);
    }
    const auth = await this.providerManager.getAuth(provider);
    if (!auth) throw new Error(`Unable to resolve credentials for provider "${provider}". Run /login to reconnect.`);
    return auth;
  }
}
