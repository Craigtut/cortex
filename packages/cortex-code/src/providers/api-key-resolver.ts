/**
 * Answers the agent's `getAuth(provider)` callback for an interactive
 * session: which stored credential serves a provider id. Provider
 * credentials resolve through Cortex's ProviderManager over the session's
 * credential store, which refreshes an OAuth token under the store's
 * cross-process lock, so a rotating refresh token is spent exactly once.
 */

import type { ModelAuth, ProviderManager } from '@animus-labs/cortex';
import type { CredentialStore } from '../config/credentials.js';
import { log } from '../logger.js';

/** What a keyless local endpoint is sent; the OpenAI SDK requires a non-empty key. */
const NO_KEY = 'sk-no-key-required';

export class AuthResolver {
  constructor(
    private readonly credentialStore: CredentialStore,
    private readonly providerManager: Pick<ProviderManager, 'getAuth'>,
    /** The provider the session is currently on; changes with /model. */
    private readonly getSessionProvider: () => string,
  ) {}

  /** Request auth for a provider: a stored key, or OAuth refreshed under the store's lock. */
  async getAuth(provider: string): Promise<ModelAuth> {
    // Pi-agent-core passes the model's provider field. For anything built by
    // createCustomModel that is the synthetic id "custom", whose credential is
    // filed under the connection name instead (e.g. "ollama"), so a "custom"
    // request falls back to the session's provider name.
    //
    // Only "custom" does. Every other id names a real provider, and a real
    // provider's credential is filed under its own name or not stored at all:
    // borrowing a different provider's would send its token to an endpoint it
    // was not issued for. That is reachable, because a loop can outlive a
    // provider switch (a duplex talker still on the startup provider's model
    // after /model moved the session), and the honest answer there is that
    // this model has no credential.
    const entry = await this.credentialStore.getProvider(provider);
    if (!entry && provider === 'custom' && provider !== this.getSessionProvider()) {
      const sessionEntry = await this.credentialStore.getProvider(this.getSessionProvider());
      if (sessionEntry?.method === 'oauth') {
        log.warn('Not lending OAuth credentials to a custom-endpoint model', {
          sessionProvider: this.getSessionProvider(),
        });
        return { apiKey: NO_KEY };
      }
      // A borrowed entry is never an OAuth one: it is a custom endpoint's key.
      return { apiKey: sessionEntry?.apiKey || NO_KEY };
    }
    if (!entry) {
      // Keyless providers (e.g., Ollama) may not have a credential store
      // entry at all.
      if (provider === 'custom' || provider === 'ollama') return { apiKey: NO_KEY };
      throw new Error(`No credentials for provider "${provider}". Run /login to connect.`);
    }

    // Custom: the stored key, or a placeholder for keyless endpoints.
    if (entry.method === 'custom') return { apiKey: entry.apiKey || NO_KEY };

    const auth = await this.providerManager.getAuth(provider);
    if (!auth) throw new Error(`Unable to resolve credentials for provider "${provider}". Run /login to reconnect.`);
    return auth;
  }
}
