import type { ProviderManager } from '@animus-labs/cortex';
import type { CredentialStore, CredentialEntry } from '../config/credentials.js';

/**
 * How many times to re-read and retry after a refresh failure that looks like a
 * lost rotation race. Each retry only happens when the store shows a *different*
 * credential (a concurrent winner has published one), so this never blindly
 * retries a genuine failure.
 */
const MAX_ROTATION_RETRIES = 3;

/**
 * Resolve a usable API key from a stored OAuth credential, refreshing and
 * persisting a rotated token when the access token has expired.
 *
 * Providers like Anthropic rotate the refresh token on every use and invalidate
 * the previous one, so two refreshes with the same stored token race: one wins,
 * the rest get invalid_grant. Intra-process bursts are collapsed by the caller's
 * single-flight, but separate processes (several interactive sessions, or
 * `cortex -p` runs resuming at once) can't share that. So when our refresh
 * fails, we re-read the credential store; if a concurrent winner has already
 * persisted a fresh credential, we retry with it instead of surfacing the
 * failure. A failure with no newer stored credential is genuine and rethrown.
 */
export async function resolveStoredOAuthApiKey(
  providerManager: ProviderManager,
  credentialStore: CredentialStore,
  provider: string,
  entry: CredentialEntry,
): Promise<string> {
  let current = entry;

  for (let attempt = 0; attempt <= MAX_ROTATION_RETRIES; attempt++) {
    try {
      const result = await providerManager.resolveOAuthApiKey(
        provider,
        current.oauthCredentials!,
      );
      // Persist refreshed credentials if they changed (rotation).
      if (result.changed) {
        await credentialStore.setProvider(provider, {
          ...current,
          oauthCredentials: result.credentials,
          oauthMeta: result.meta,
        });
      }
      if (!result.apiKey) {
        // Kimi Coding's OAuth authorizes with a header, which a key cannot carry.
        throw new Error(`OAuth for "${provider}" does not yield an API key`);
      }
      return result.apiKey;
    } catch (error) {
      // A concurrent refresh may have rotated (and invalidated) our token. If a
      // winner has since persisted a different credential, retry with it;
      // otherwise this is a genuine failure, so surface it.
      const fresh = await credentialStore.getProvider(provider);
      const rotated =
        fresh?.method === 'oauth' &&
        !!fresh.oauthCredentials &&
        fresh.oauthCredentials !== current.oauthCredentials;
      if (rotated && attempt < MAX_ROTATION_RETRIES) {
        current = fresh;
        continue;
      }
      throw error;
    }
  }

  // Unreachable: the loop either returns a key or throws.
  throw new Error(`Unable to resolve OAuth API key for provider "${provider}"`);
}
