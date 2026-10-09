import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ProviderManager, OAuthError } from '../../src/provider-manager.js';
import { PROVIDER_REGISTRY, OAUTH_PROVIDER_IDS } from '../../src/provider-registry.js';
import { isCortexModel, unwrapModel } from '../../src/model-wrapper.js';

// ---------------------------------------------------------------------------
// Mock pi-ai module
// ---------------------------------------------------------------------------

const mockGetModel = vi.fn();
const mockCreateModel = vi.fn();
const mockGetModels = vi.fn();
const mockGetEnvApiKey = vi.fn();
const mockGetSupportedThinkingLevels = vi.fn();
const mockCompleteSimple = vi.fn();

// The real root (pi's Models and createProvider build ProviderManager's
// runtime); only the thinking-level helper is substituted.
vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  getSupportedThinkingLevels: (...args: unknown[]) => mockGetSupportedThinkingLevels(...args),
}));

// pi-ai 0.80 split the API across entrypoints; loadPiAi() composes them, so
// mirror that split here: catalog reads from providers/all, wired to the
// same mock fns as the root mock above. Requests go through the model
// runtime, mocked below.
vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinModel: (...args: unknown[]) => mockGetModel(...args),
  getBuiltinModels: (...args: unknown[]) => mockGetModels(...args),
  // OAuth moved here: pi dropped its global registry entrypoint in favour of
  // a per-provider auth.oauth on the builtin provider list.
  builtinProviders: () => mockBuiltinProviders(),
}));

vi.mock('../../src/model-runtime.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  streamModel: (...args: unknown[]) => ({ result: () => mockCompleteSimple(...args) }),
  streamModelSimple: (...args: unknown[]) => ({ result: () => mockCompleteSimple(...args) }),
}));

// Mock pi's per-provider OAuth (formerly the pi-ai/oauth registry).
const mockLoginAnthropic = vi.fn();
const mockLoginCodex = vi.fn();
const mockRefresh = vi.fn(async (cred: Record<string, unknown>) => cred);
const mockToAuth = vi.fn(async (cred: Record<string, unknown>) => ({ apiKey: cred['access'] as string }));

function oauthProvider(id: string, name: string, login: unknown) {
  return {
    id,
    name,
    auth: {
      oauth: {
        name,
        login,
        refresh: (...args: unknown[]) => mockRefresh(...(args as [Record<string, unknown>])),
        toAuth: (...args: unknown[]) => mockToAuth(...(args as [Record<string, unknown>])),
      },
    },
  };
}

const mockBuiltinProviders = vi.fn(() => [
  oauthProvider('anthropic', 'Anthropic', mockLoginAnthropic),
  oauthProvider('openai-codex', 'OpenAI Codex', mockLoginCodex),
  oauthProvider('github-copilot', 'GitHub Copilot', vi.fn()),
  { id: 'openai', name: 'OpenAI', auth: {} },
]);

const PI_OAUTH_SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Authentication successful</title>
</head>
<body>
  <main>
    <h1>Authentication successful</h1>
    <p>Anthropic authentication completed. You can close this window.</p>
  </main>
</body>
</html>`;

const PI_OAUTH_FAILURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <title>Authentication failed</title>
</head>
<body>
  <main>
    <h1>Authentication failed</h1>
    <p>State mismatch.</p>
    <div class="details">expected state did not match</div>
  </main>
</body>
</html>`;

/** A loopback OAuth callback server bound to an OS-assigned ephemeral port. */
interface LocalOAuthServer {
  /** The actual bound port. Feed this into the ProviderManager route so the
   *  callback-page shim matches this server. */
  port: number;
  /** Issue a GET to this server and return the (possibly shim-rewritten) body. */
  request: (path: string) => Promise<string>;
  /** Stop the server. */
  close: () => Promise<void>;
}

/**
 * Start a loopback HTTP server that serves a pi-ai style OAuth callback page.
 *
 * It listens on port 0, so the OS assigns a free ephemeral port that is unique
 * across the whole machine. This is the crux of the parallel-safety fix: the
 * previous helper bound the *fixed* production ports (53692 / 1455), which
 * collide the moment two workers or two `vitest run` invocations overlap. An
 * OS-assigned port never collides. The caller wires `port` into the manager's
 * callback route so the shim still matches, exercising the exact same code
 * path without a fixed socket.
 */
async function startLocalOAuthServer(options: {
  html?: string;
  contentType?: string;
} = {}): Promise<LocalOAuthServer> {
  const { createServer } = await import('node:http');
  const html = options.html ?? PI_OAUTH_SUCCESS_HTML;
  const contentType = options.contentType ?? 'text/html; charset=utf-8';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(html);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    port,
    request: async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      return await response.text();
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    }),
  };
}

/** A ProviderManager, optionally with a provider's preferred callback route
 *  pointed at a test server. */
function makeProviderManager(
  routes?: Record<string, { path: string; port: number }>,
): ProviderManager {
  return new ProviderManager(routes ? { oauthCallbackRoutes: routes } : {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProviderManager', () => {
  let pm: ProviderManager;

  beforeEach(() => {
    pm = makeProviderManager();
    vi.clearAllMocks();
    mockGetSupportedThinkingLevels.mockReturnValue([]);
    mockGetModels.mockReturnValue([
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        input: ['text'],
        cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
        contextWindow: 200_000,
      },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  describe('listProviders', () => {
    it('returns the full PROVIDER_REGISTRY', () => {
      const providers = pm.listProviders();
      expect(providers).toBe(PROVIDER_REGISTRY);
      expect(providers.length).toBeGreaterThan(0);
    });

    it('includes anthropic and openai', () => {
      const providers = pm.listProviders();
      const ids = providers.map(p => p.id);
      expect(ids).toContain('anthropic');
      expect(ids).toContain('openai');
    });
  });

  describe('listOAuthProviders', () => {
    it('returns OAUTH_PROVIDER_IDS', () => {
      const oauthProviders = pm.listOAuthProviders();
      expect(oauthProviders).toBe(OAUTH_PROVIDER_IDS);
    });

    it('includes anthropic but not openai', () => {
      const oauthProviders = pm.listOAuthProviders();
      expect(oauthProviders).toContain('anthropic');
      expect(oauthProviders).not.toContain('openai');
    });
  });

  describe('listModels', () => {
    it('delegates to pi-ai getModels and maps to ModelInfo', async () => {
      mockGetModels.mockReturnValue([
        {
          name: 'claude-sonnet-4-20250514',
          displayName: 'Claude Sonnet 4',
          contextWindow: 200000,
          supportsThinking: true,
          supportsImages: true,
          pricing: { input: 3.0, output: 15.0 },
        },
        {
          name: 'claude-haiku-4-5-20250609',
          displayName: 'Claude Haiku 4.5',
          contextWindow: 200000,
          supportsThinking: false,
          supportsImages: true,
        },
      ]);

      const models = await pm.listModels('anthropic');

      expect(mockGetModels).toHaveBeenCalledWith('anthropic');
      expect(models).toHaveLength(2);

      expect(models[0]!.id).toBe('claude-sonnet-4-20250514');
      expect(models[0]!.name).toBe('Claude Sonnet 4');
      expect(models[0]!.contextWindow).toBe(200000);
      expect(models[0]!.supportsThinking).toBe(true);
      expect(models[0]!.supportsImages).toBe(true);
      expect(models[0]!.pricing).toEqual({ input: 3.0, output: 15.0 });

      expect(models[1]!.id).toBe('claude-haiku-4-5-20250609');
      expect(models[1]!.pricing).toBeUndefined();
    });

    it('handles models without displayName', async () => {
      mockGetModels.mockReturnValue([
        { name: 'some-model', contextWindow: 100000 },
      ]);

      const models = await pm.listModels('custom');

      expect(models[0]!.name).toBe('some-model');
    });

    it('defaults contextWindow to 200k when not present', async () => {
      mockGetModels.mockReturnValue([
        { name: 'test-model' },
      ]);

      const models = await pm.listModels('custom');

      expect(models[0]!.contextWindow).toBe(200_000);
    });

    it('returns empty array when provider has no models', async () => {
      mockGetModels.mockReturnValue([]);

      const models = await pm.listModels('unknown-provider');

      expect(models).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // OAuth
  // -----------------------------------------------------------------------

  describe('initiateOAuth', () => {
    it('calls the correct login function for anthropic', async () => {
      mockLoginAnthropic.mockResolvedValue({
        accessToken: 'test-token',
        email: 'user@example.com',
        expiresAt: Date.now() + 3600_000,
        refreshToken: 'refresh-token',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);

      expect(mockBuiltinProviders).toHaveBeenCalled();
      expect(mockLoginAnthropic).toHaveBeenCalledTimes(1);
      expect(typeof result.credentials).toBe('string');
      expect(result.meta.provider).toBe('anthropic');
      expect(result.meta.displayName).toBe('user@example.com');
      expect(result.meta.refreshable).toBe(true);
      expect(result.meta.expiresAt).toBeDefined();
    });

    it('passes a single interaction object with signal, prompt and notify', async () => {
      // pi replaced the callbacks bag with one AuthInteraction. Cortex adapts
      // its own OAuthCallbacks onto it, so consumers see no change and pi
      // sees exactly the three members it documents.
      mockLoginAnthropic.mockResolvedValue({});

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
        onManualCodeInput: vi.fn(),
        onSelect: vi.fn(),
      };

      await pm.initiateOAuth('anthropic', callbacks);

      const interaction = mockLoginAnthropic.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(interaction).sort()).toEqual(['notify', 'prompt', 'signal']);
      expect(interaction['signal']).toBeInstanceOf(AbortSignal);
      expect(typeof interaction['prompt']).toBe('function');
      expect(typeof interaction['notify']).toBe('function');
      // Adapters, not the consumer's functions handed through raw.
      expect(interaction['prompt']).not.toBe(callbacks.onPrompt);
      expect(interaction['notify']).not.toBe(callbacks.onProgress);
    });

    it('routes a progress event to onProgress', async () => {
      mockLoginAnthropic.mockImplementation(async (interaction) => {
        interaction.notify({ type: 'progress', message: 'Exchanging code...' });
        return {};
      });
      const onProgress = vi.fn();

      await pm.initiateOAuth('anthropic', { onAuth: vi.fn(), onPrompt: vi.fn(), onProgress });

      expect(onProgress).toHaveBeenCalledWith('Exchanging code...');
    });

    it('routes a select prompt to onSelect and returns the chosen id', async () => {
      let chosen: string | undefined;
      mockLoginAnthropic.mockImplementation(async (interaction) => {
        chosen = await interaction.prompt({
          type: 'select',
          message: 'Pick an org',
          options: [{ id: 'org-a', label: 'Org A' }, { id: 'org-b', label: 'Org B' }],
        });
        return {};
      });
      const onSelect = vi.fn(async () => 'org-b');

      await pm.initiateOAuth('anthropic', { onAuth: vi.fn(), onPrompt: vi.fn(), onSelect });

      expect(onSelect).toHaveBeenCalledWith({
        message: 'Pick an org',
        options: [{ id: 'org-a', label: 'Org A' }, { id: 'org-b', label: 'Org B' }],
      });
      expect(chosen).toBe('org-b');
    });

    it('rejects the prompt when the consumer cancels a select', async () => {
      // pi's contract is resolve-with-answer / reject-on-cancel. Cortex signals
      // cancel as undefined, which must not reach pi as the string "undefined".
      mockLoginAnthropic.mockImplementation(async (interaction) => {
        await interaction.prompt({ type: 'select', message: 'Pick', options: [{ id: 'a', label: 'A' }] });
        return {};
      });

      await expect(pm.initiateOAuth('anthropic', {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onSelect: vi.fn(async () => undefined),
      })).rejects.toThrow(/cancelled/i);
    });

    it('routes a manual_code prompt to onManualCodeInput', async () => {
      let code: string | undefined;
      mockLoginAnthropic.mockImplementation(async (interaction) => {
        code = await interaction.prompt({ type: 'manual_code', message: 'Paste the code' });
        return {};
      });
      const onManualCodeInput = vi.fn(async () => 'pasted-code');

      await pm.initiateOAuth('anthropic', { onAuth: vi.fn(), onPrompt: vi.fn(), onManualCodeInput });

      expect(onManualCodeInput).toHaveBeenCalled();
      expect(code).toBe('pasted-code');
    });

    it("hands onManualCodeInput the prompt's signal, which pi aborts when the browser callback wins", async () => {
      const promptAbort = new AbortController();
      let seen: AbortSignal | undefined;
      mockLoginAnthropic.mockImplementation(async (interaction) => {
        const pending = interaction.prompt({ type: 'manual_code', message: 'Paste the code', signal: promptAbort.signal })
          .catch(() => '');
        promptAbort.abort();
        await pending;
        return { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000 };
      });
      const onManualCodeInput = vi.fn((signal?: AbortSignal) => {
        seen = signal;
        return new Promise<string>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('closed'))));
      });

      await pm.initiateOAuth('anthropic', { onAuth: vi.fn(), onPrompt: vi.fn(), onManualCodeInput });

      expect(seen).toBe(promptAbort.signal);
      expect(seen?.aborted).toBe(true);
    });

    it('takes the first option of a select prompt when there is no onSelect', async () => {
      // pi 1.x Anthropic login starts by asking for a login method.
      let chosen: string | undefined;
      mockLoginAnthropic.mockImplementation(async (interaction) => {
        chosen = await interaction.prompt({
          type: 'select',
          message: 'Select Anthropic login method:',
          options: [{ id: 'browser', label: 'Browser login (default)' }, { id: 'copy_code', label: 'Copy code login' }],
        });
        return { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000 };
      });
      const onPrompt = vi.fn(async () => 'typed');

      await pm.initiateOAuth('anthropic', { onAuth: vi.fn(), onPrompt });

      expect(chosen).toBe('browser');
      expect(onPrompt).not.toHaveBeenCalled();
    });

    it('renders the custom callback page on whatever port the authorization URL names', async () => {
      // pi 1.1 binds Anthropic's callback to a free port when 53692 is taken,
      // and OpenRouter always uses an ephemeral port and a random path. The
      // flow reads the real callback from the authorization URL.
      const server = await startLocalOAuthServer();
      const renderCallbackPage = vi.fn(() => '<html><body>Branded</body></html>');
      let body = '';
      mockLoginAnthropic.mockImplementation(async (interaction) => {
        const redirect = encodeURIComponent(`http://localhost:${server.port}/fallback-callback`);
        interaction.notify({ type: 'auth_url', url: `https://claude.ai/oauth/authorize?redirect_uri=${redirect}` });
        body = await server.request('/fallback-callback');
        return { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000 };
      });
      const onAuth = vi.fn();
      try {
        // No preferred route for the provider at all: only the URL says where.
        const routeless = makeProviderManager({});
        await routeless.initiateOAuth('anthropic', { onAuth, onPrompt: vi.fn(), renderCallbackPage });
      } finally {
        await server.close();
      }

      expect(body).toContain('Branded');
      expect(renderCallbackPage).toHaveBeenCalledWith(expect.objectContaining({
        callbackPort: server.port,
        callbackPath: '/fallback-callback',
        status: 'success',
      }));
      expect(onAuth).toHaveBeenCalledWith(expect.objectContaining({
        flowType: 'localhost_callback',
        callbackPort: server.port,
        callbackPath: '/fallback-callback',
      }));
    });

    it('annotates localhost callback OAuth auth URLs', async () => {
      mockLoginAnthropic.mockImplementation(async (interaction) => {
        interaction.notify({
          type: 'auth_url',
          url: 'https://claude.ai/oauth/authorize?test=1',
          instructions: 'Complete login in your browser.',
        });
        return {};
      });

      const onAuth = vi.fn();

      await pm.initiateOAuth('anthropic', {
        onAuth,
        onPrompt: vi.fn(),
      });

      expect(onAuth).toHaveBeenCalledWith({
        url: 'https://claude.ai/oauth/authorize?test=1',
        instructions: 'Complete login in your browser.',
        flowType: 'localhost_callback',
        manualCodeRecommended: true,
        callbackPort: 53692,
        callbackPath: '/callback',
      });
    });

    it('extracts device codes from OAuth auth instructions', async () => {
      const mockLoginGitHub = vi.fn(async (interaction) => {
        interaction.notify({
          type: 'device_code',
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
        });
        return {};
      });
      mockBuiltinProviders.mockReturnValueOnce([
        oauthProvider('github-copilot', 'GitHub Copilot', mockLoginGitHub),
      ]);

      const onAuth = vi.fn();

      await pm.initiateOAuth('github-copilot', {
        onAuth,
        onPrompt: vi.fn(),
      });

      expect(onAuth).toHaveBeenCalledWith(expect.objectContaining({
        url: 'https://github.com/login/device',
        flowType: 'device_code',
        deviceCode: 'ABCD-1234',
      }));
    });

    it('normalizes OAuth prompt metadata', async () => {
      mockLoginAnthropic.mockImplementation(async (interaction) => {
        await interaction.prompt({
          type: 'text',
          message: 'Paste the redirect URL:',
          placeholder: 'http://localhost:53692/callback',
          allowEmpty: false,
        });
        return {};
      });

      const onPrompt = vi.fn(async () => 'code');

      await pm.initiateOAuth('anthropic', {
        onAuth: vi.fn(),
        onPrompt,
      });

      expect(onPrompt).toHaveBeenCalledWith({
        message: 'Paste the redirect URL:',
        placeholder: 'http://localhost:53692/callback',
        allowEmpty: false,
      });
    });

    it('renders a custom callback page for known pi-ai callback routes', async () => {
      const oauthServer = await startLocalOAuthServer();
      const localPm = makeProviderManager({
        anthropic: { path: '/callback', port: oauthServer.port },
      });
      let callbackHtml = '';
      mockLoginAnthropic.mockImplementation(async () => {
        callbackHtml = await oauthServer.request('/callback');
        return { accessToken: 'test-token' };
      });

      const renderCallbackPage = vi.fn((context) => {
        expect(context.provider).toBe('anthropic');
        expect(context.providerName).toBe('Anthropic');
        expect(context.status).toBe('success');
        expect(context.title).toBe('Authentication successful');
        expect(context.heading).toBe('Authentication successful');
        expect(context.message).toBe('Anthropic authentication completed. You can close this window.');
        expect(context.callbackPath).toBe('/callback');
        expect(context.callbackPort).toBe(oauthServer.port);
        expect(context.defaultHtml).toContain('Authentication successful');
        return '<!doctype html><html><body>Cortex OAuth complete</body></html>';
      });

      try {
        await localPm.initiateOAuth('anthropic', {
          onAuth: vi.fn(),
          onPrompt: vi.fn(),
          renderCallbackPage,
        });
      } finally {
        await oauthServer.close();
      }

      expect(renderCallbackPage).toHaveBeenCalledTimes(1);
      expect(callbackHtml).toContain('Cortex OAuth complete');
      expect(callbackHtml).not.toContain('Anthropic authentication completed');
    });

    it('leaves non-matching callback responses unchanged', async () => {
      const oauthServer = await startLocalOAuthServer();
      const localPm = makeProviderManager({
        anthropic: { path: '/callback', port: oauthServer.port },
      });
      let callbackHtml = '';
      mockLoginAnthropic.mockImplementation(async () => {
        callbackHtml = await oauthServer.request('/not-callback');
        return { accessToken: 'test-token' };
      });

      const renderCallbackPage = vi.fn(() => (
        '<!doctype html><html><body>Cortex OAuth complete</body></html>'
      ));

      try {
        await localPm.initiateOAuth('anthropic', {
          onAuth: vi.fn(),
          onPrompt: vi.fn(),
          renderCallbackPage,
        });
      } finally {
        await oauthServer.close();
      }

      expect(renderCallbackPage).not.toHaveBeenCalled();
      expect(callbackHtml).toContain('Anthropic authentication completed');
    });

    it('restores the callback page shim after login failure', async () => {
      const oauthServer = await startLocalOAuthServer();
      const localPm = makeProviderManager({
        anthropic: { path: '/callback', port: oauthServer.port },
      });
      const renderCallbackPage = vi.fn(() => (
        '<!doctype html><html><body>Cortex OAuth complete</body></html>'
      ));
      mockLoginAnthropic.mockRejectedValue(new Error('Login failed'));

      await expect(localPm.initiateOAuth('anthropic', {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        renderCallbackPage,
      })).rejects.toThrow('Login failed');

      // The route port matches the live server, so an un-restored shim would
      // rewrite this response. It staying unchanged proves the shim released.
      let callbackHtml = '';
      try {
        callbackHtml = await oauthServer.request('/callback');
      } finally {
        await oauthServer.close();
      }
      expect(renderCallbackPage).not.toHaveBeenCalled();
      expect(callbackHtml).toContain('Anthropic authentication completed');
    });

    it('rejects concurrent customized callback page shims', async () => {
      let finishLogin!: () => void;
      let resolveStarted!: () => void;
      const started = new Promise<void>(resolve => {
        resolveStarted = resolve;
      });

      mockLoginAnthropic.mockImplementationOnce(async () => {
        resolveStarted();
        return await new Promise<Record<string, unknown>>(resolve => {
          finishLogin = () => resolve({ accessToken: 'test-token' });
        });
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        renderCallbackPage: vi.fn(() => '<!doctype html><html><body>Done</body></html>'),
      };

      const firstLogin = pm.initiateOAuth('anthropic', callbacks);
      await started;

      // Stubbed probe on the second manager too, so this asserts the shim's
      // "already active" guard rather than any real port state. No server is
      // bound here: the shim is a process-wide ServerResponse.end patch.
      const secondProviderManager = makeProviderManager();
      await expect(secondProviderManager.initiateOAuth('anthropic', callbacks))
        .rejects.toThrow('already active');

      finishLogin();
      await firstLogin;
    });

    it('throws for unknown OAuth provider', async () => {
      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      await expect(pm.initiateOAuth('openai', callbacks))
        .rejects.toThrow('does not support OAuth');
    });

    it('serializes credentials as JSON string', async () => {
      const rawCredentials = { token: 'abc', nested: { key: 'val' } };
      mockLoginAnthropic.mockResolvedValue(rawCredentials);

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);

      expect(JSON.parse(result.credentials)).toEqual(rawCredentials);
    });

    it('rejects a second flow while one runs, and cancel still reaches the first', async () => {
      // Never settles, like pi-ai's callback-server wait.
      mockLoginCodex.mockImplementation(() => new Promise(() => {}));
      // A renderer installs the process-wide callback shim: the second flow
      // used to overwrite the active abort and then throw from the shim,
      // leaving cancel pointed at a dead flow.
      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        renderCallbackPage: vi.fn(() => '<!doctype html><html><body>Done</body></html>'),
      };
      const first = pm.initiateOAuth('openai-codex', callbacks);
      await vi.waitFor(() => expect(mockLoginCodex).toHaveBeenCalledTimes(1));

      await expect(pm.initiateOAuth('openai-codex', callbacks)).rejects.toMatchObject({
        name: 'OAuthError',
        code: 'flow_in_progress',
      });
      pm.cancelOAuth();

      const outcome = await Promise.race([
        first.then(() => 'resolved', (error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve('still hanging'), 500)),
      ]);
      expect(outcome).toMatchObject({ name: 'OAuthError', code: 'cancelled', provider: 'openai-codex' });
      expect(mockLoginCodex).toHaveBeenCalledTimes(1);
    });

    it('releases the flow slot after a failed login, so the next flow runs and is cancellable', async () => {
      mockLoginCodex.mockRejectedValueOnce(new Error('Login failed'));
      await expect(pm.initiateOAuth('openai-codex', { onAuth: vi.fn(), onPrompt: vi.fn() }))
        .rejects.toThrow('Login failed');

      mockLoginCodex.mockImplementationOnce(() => new Promise(() => {}));
      const next = pm.initiateOAuth('openai-codex', { onAuth: vi.fn(), onPrompt: vi.fn() });
      await vi.waitFor(() => expect(mockLoginCodex).toHaveBeenCalledTimes(2));
      pm.cancelOAuth();

      await expect(next).rejects.toMatchObject({ name: 'OAuthError', code: 'cancelled' });
    });
  });

  describe('cancelOAuth', () => {
    it('does nothing when no OAuth flow is active', () => {
      expect(() => pm.cancelOAuth()).not.toThrow();
    });

    it('aborts an active OAuth flow with a typed OAuthError', async () => {
      // Codex port (1455) so this is independent of anything holding 53692.
      // pi-ai's anthropic flow ignores the abort signal entirely, so cancel
      // must reject via Cortex's own race, not the login promise.
      let signalRef: AbortSignal | null = null;
      mockLoginCodex.mockImplementation(async (opts: Record<string, unknown>) => {
        signalRef = opts['signal'] as AbortSignal;
        return new Promise(() => {}); // never settles (pi-ai-style hang)
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const loginPromise = pm.initiateOAuth('openai-codex', callbacks);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(signalRef).not.toBeNull();
      expect(signalRef!.aborted).toBe(false);

      pm.cancelOAuth();

      expect(signalRef!.aborted).toBe(true);

      await expect(loginPromise).rejects.toMatchObject({
        name: 'OAuthError',
        code: 'cancelled',
        provider: 'openai-codex',
      });
    });
  });

  describe('initiateOAuth resilience', () => {
    it('throws OAuthError(unsupported_provider) for unknown providers', async () => {
      await expect(
        pm.initiateOAuth('definitely-not-a-provider', { onAuth: vi.fn(), onPrompt: vi.fn() }),
      ).rejects.toMatchObject({ name: 'OAuthError', code: 'unsupported_provider' });
      expect(mockLoginCodex).not.toHaveBeenCalled();
    });

    it('starts the login even when a preferred callback port is taken', async () => {
      // pi handles a taken port itself: Anthropic binds a free port instead,
      // Codex asks for the pasted redirect URL. A Cortex pre-check that
      // refused the flow would block both fallbacks.
      const { createServer } = await import('node:http');
      const squatter = createServer();
      await new Promise<void>((resolve) => squatter.listen(0, '127.0.0.1', resolve));
      const address = squatter.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      mockLoginCodex.mockResolvedValue({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3600_000 });
      try {
        const busyPm = makeProviderManager({ 'openai-codex': { path: '/auth/callback', port } });
        await busyPm.initiateOAuth('openai-codex', { onAuth: vi.fn(), onPrompt: vi.fn() });
        expect(mockLoginCodex).toHaveBeenCalledTimes(1);
      } finally {
        await new Promise<void>((resolve) => squatter.close(() => resolve()));
      }
    });

    it("reports pi's port-in-use login failure as callback_port_in_use", async () => {
      mockLoginCodex.mockRejectedValueOnce(new Error('Port 1455 is in use, probably by an unfinished login. Cancel that login and try again.'));

      await expect(pm.initiateOAuth('openai-codex', { onAuth: vi.fn(), onPrompt: vi.fn() }))
        .rejects.toMatchObject({ name: 'OAuthError', code: 'callback_port_in_use', provider: 'openai-codex', port: 1455 });
    });

    it('times out a hung flow with OAuthError(timed_out)', async () => {
      mockLoginCodex.mockImplementation(() => new Promise(() => {})); // never settles

      await expect(
        pm.initiateOAuth('openai-codex', {
          onAuth: vi.fn(),
          onPrompt: vi.fn(),
          timeoutMs: 60,
        }),
      ).rejects.toMatchObject({ name: 'OAuthError', code: 'timed_out' });

      // Flow released — a subsequent flow can start.
      pm.cancelOAuth();
    });

    it('fails immediately on a failed browser callback instead of hanging', async () => {
      // pi-ai serves its error page then hangs forever (never settles).
      // The render shim sees the error page; Cortex must reject right away.
      const oauthServer = await startLocalOAuthServer({ html: PI_OAUTH_FAILURE_HTML });
      const localPm = makeProviderManager({
        'openai-codex': { path: '/auth/callback', port: oauthServer.port },
      });
      mockLoginCodex.mockImplementation(async () => {
        await oauthServer.request('/auth/callback');
        return new Promise(() => {});
      });

      const err = await localPm
        .initiateOAuth('openai-codex', { onAuth: vi.fn(), onPrompt: vi.fn() })
        .then(() => null)
        .catch((e: unknown) => e);

      await oauthServer.close();

      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).code).toBe('callback_failed');
      expect((err as OAuthError).message).toContain('State mismatch');
    });
  });

  describe('resolveOAuthApiKey', () => {
    // A caller-held blob: expiry-check -> refresh -> toAuth through the
    // provider's pi OAuth. getAuth() is the store-backed path.
    const future = () => Date.now() + 3600_000;
    const past = () => Date.now() - 1_000;

    it('derives the key via toAuth without refreshing a live credential', async () => {
      const creds = { access: 'live-token', refresh: 'r', expires: future(), type: 'oauth' };

      const result = await pm.resolveOAuthApiKey('anthropic', JSON.stringify(creds));

      expect(result.apiKey).toBe('live-token');
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockToAuth).toHaveBeenCalledTimes(1);
      expect(result.changed).toBe(false);
      expect(result.meta.provider).toBe('anthropic');
    });

    it('refreshes an expired credential and reports the new blob', async () => {
      const creds = { access: 'stale', refresh: 'r', expires: past(), type: 'oauth' };
      mockRefresh.mockResolvedValueOnce({ access: 'fresh', refresh: 'r2', expires: future(), type: 'oauth' });

      const result = await pm.resolveOAuthApiKey('anthropic', JSON.stringify(creds));

      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(result.apiKey).toBe('fresh');
      expect(result.changed).toBe(true);
      expect(JSON.parse(result.credentials).access).toBe('fresh');
    });

    it('refreshes a credential that is close to expiry, not just a dead one', async () => {
      // A token expiring mid-request fails the request it was fetched for.
      const creds = { access: 'nearly', refresh: 'r', expires: Date.now() + 30_000, type: 'oauth' };
      mockRefresh.mockResolvedValueOnce({ access: 'fresh', refresh: 'r', expires: future(), type: 'oauth' });

      const result = await pm.resolveOAuthApiKey('anthropic', JSON.stringify(creds));

      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(result.apiKey).toBe('fresh');
    });

    it('throws when toAuth yields neither a key nor auth headers', async () => {
      mockToAuth.mockResolvedValueOnce({});

      await expect(
        pm.resolveOAuthApiKey('anthropic', JSON.stringify({ access: 'x', refresh: 'r', expires: future() })),
      ).rejects.toThrow('OAuth resolution failed');
    });

    it('refreshes once per call: concurrent calls each spend the blob they hold', async () => {
      // The positive precondition for the store-backed test below: without
      // a shared store there is nothing to serialize on.
      const creds = JSON.stringify({ access: 'stale', refresh: 'r', expires: past(), type: 'oauth' });
      mockRefresh.mockResolvedValue({ access: 'fresh', refresh: 'r2', expires: future(), type: 'oauth' });

      await Promise.all([1, 2, 3].map(() => pm.resolveOAuthApiKey('anthropic', creds)));

      expect(mockRefresh).toHaveBeenCalledTimes(3);
    });

    it('reports a provider with no OAuth support instead of silently failing', async () => {
      // The regression that shipped: an emptied pi entrypoint made every
      // provider look OAuth-less. Only a genuinely OAuth-less provider should.
      await expect(
        pm.resolveOAuthApiKey('openai', JSON.stringify({ access: 'x', refresh: 'r', expires: future() })),
      ).rejects.toThrow(/does not support OAuth/);
    });
  });

  describe('getAuth with a credential store', () => {
    const future = () => Date.now() + 3600_000;
    const past = () => Date.now() - 1_000;

    it('refreshes an expiring credential once for concurrent requests and stores the rotation', async () => {
      // A duplex talker, reasoner, and utility call can all ask at once.
      // Anthropic rotates the refresh token on use, so a second refresh with
      // the spent token fails with invalid_grant.
      const credentials = new InMemoryCredentialStore();
      await credentials.modify('anthropic', async () => ({ type: 'oauth', access: 'stale', refresh: 'r1', expires: past() }));
      mockRefresh.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { type: 'oauth', access: 'fresh', refresh: 'r2', expires: future() };
      });
      const manager = new ProviderManager({ credentials });

      const auths = await Promise.all([1, 2, 3].map(() => manager.getAuth('anthropic')));

      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(auths.map((auth) => auth?.apiKey)).toEqual(['fresh', 'fresh', 'fresh']);
      expect(await credentials.read('anthropic')).toMatchObject({ access: 'fresh', refresh: 'r2' });
    });

    it('stores the credential a login obtains', async () => {
      const credentials = new InMemoryCredentialStore();
      mockLoginAnthropic.mockResolvedValue({ type: 'oauth', access: 'new', refresh: 'r', expires: future() });
      const manager = new ProviderManager({ credentials, oauthCallbackRoutes: {} });

      await manager.initiateOAuth('anthropic', { onAuth: vi.fn(), onPrompt: vi.fn() });

      expect(await credentials.read('anthropic')).toMatchObject({ type: 'oauth', access: 'new' });
      expect(await manager.getAuth('anthropic')).toMatchObject({ apiKey: 'new' });
    });
  });

  // -----------------------------------------------------------------------
  // API Key
  // -----------------------------------------------------------------------

  describe('validateApiKey', () => {
    it('returns a valid result when completeSimple succeeds', async () => {
      const mockModel = { provider: 'anthropic', name: 'haiku' };
      mockGetModel.mockReturnValue(mockModel);
      mockCompleteSimple.mockResolvedValue({ content: '' });

      const valid = await pm.validateApiKey('anthropic', 'sk-ant-test-key');

      expect(valid).toEqual(
        expect.objectContaining({
          provider: 'anthropic',
          modelId: 'claude-haiku-4-5-20251001',
          valid: true,
          retryable: false,
          status: 'valid',
        }),
      );
      expect(mockGetModel).toHaveBeenCalledWith(
        'anthropic',
        'claude-haiku-4-5-20251001',
      );
      expect(mockCompleteSimple).toHaveBeenCalledWith(
        mockModel,
        { messages: [{ role: 'user', content: 'hi', timestamp: expect.any(Number) }] },
        { apiKey: 'sk-ant-test-key', maxTokens: 1 },
      );
    });

    it('classifies invalid credentials', async () => {
      mockGetModel.mockReturnValue({});
      mockCompleteSimple.mockRejectedValue(new Error('Invalid API key'));

      const valid = await pm.validateApiKey('anthropic', 'bad-key');

      expect(valid).toEqual(
        expect.objectContaining({
          valid: false,
          retryable: false,
          status: 'invalid_credentials',
          message: 'Invalid API key',
        }),
      );
    });

    it('classifies stopReason error validation results', async () => {
      mockGetModel.mockReturnValue({});
      mockCompleteSimple.mockResolvedValue({
        stopReason: 'error',
        errorMessage: 'Invalid API key',
      });

      const result = await pm.validateApiKey('anthropic', 'bad-key');

      expect(result).toEqual(
        expect.objectContaining({
          valid: false,
          retryable: false,
          status: 'invalid_credentials',
          message: 'Invalid API key',
        }),
      );
    });

    it('classifies transient provider failures separately', async () => {
      mockGetModel.mockReturnValue({});
      mockCompleteSimple.mockRejectedValue(new Error('503 Service Unavailable'));

      const result = await pm.validateApiKey('anthropic', 'test-key');

      expect(result).toEqual(
        expect.objectContaining({
          valid: false,
          retryable: true,
          status: 'transient_error',
          message: '503 Service Unavailable',
        }),
      );
    });

    it('falls back to first model when provider has no default', async () => {
      mockGetModels.mockReturnValue([
        { name: 'unknown-model-1' },
        { name: 'unknown-model-2' },
      ]);
      mockGetModel.mockReturnValue({});
      mockCompleteSimple.mockResolvedValue({ content: '' });

      const valid = await pm.validateApiKey('unknown-provider', 'some-key');

      expect(valid).toEqual(
        expect.objectContaining({
          provider: 'unknown-provider',
          modelId: 'unknown-model-1',
          valid: true,
          status: 'valid',
        }),
      );
      expect(mockGetModel).toHaveBeenCalledWith('unknown-provider', 'unknown-model-1');
    });

    it('returns a resolution error when provider has no models and no default', async () => {
      mockGetModels.mockReturnValue([]);

      await expect(pm.validateApiKey('empty-provider', 'some-key'))
        .resolves.toEqual(
          expect.objectContaining({
            provider: 'empty-provider',
            modelId: null,
            valid: false,
            retryable: false,
            status: 'resolution_error',
            message: 'No models found for provider "empty-provider"',
          }),
        );
    });
  });

  describe('checkEnvApiKey', () => {
    it('returns the env var value when set', () => {
      const originalEnv = process.env['ANTHROPIC_API_KEY'];
      process.env['ANTHROPIC_API_KEY'] = 'test-api-key';

      try {
        const key = pm.checkEnvApiKey('anthropic');
        expect(key).toBe('test-api-key');
      } finally {
        if (originalEnv !== undefined) {
          process.env['ANTHROPIC_API_KEY'] = originalEnv;
        } else {
          delete process.env['ANTHROPIC_API_KEY'];
        }
      }
    });

    it('returns null when env var is not set', () => {
      const originalEnv = process.env['ANTHROPIC_API_KEY'];
      delete process.env['ANTHROPIC_API_KEY'];

      try {
        const key = pm.checkEnvApiKey('anthropic');
        expect(key).toBeNull();
      } finally {
        if (originalEnv !== undefined) {
          process.env['ANTHROPIC_API_KEY'] = originalEnv;
        }
      }
    });

    it('returns null when env var is empty', () => {
      const originalEnv = process.env['ANTHROPIC_API_KEY'];
      process.env['ANTHROPIC_API_KEY'] = '';

      try {
        const key = pm.checkEnvApiKey('anthropic');
        expect(key).toBeNull();
      } finally {
        if (originalEnv !== undefined) {
          process.env['ANTHROPIC_API_KEY'] = originalEnv;
        } else {
          delete process.env['ANTHROPIC_API_KEY'];
        }
      }
    });

    it('returns null for unknown provider', () => {
      const key = pm.checkEnvApiKey('unknown-provider');
      expect(key).toBeNull();
    });

    it('returns null for OAuth-only provider without envVar', () => {
      const key = pm.checkEnvApiKey('openai-codex');
      expect(key).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Model Resolution
  // -----------------------------------------------------------------------

  describe('resolveModel', () => {
    it('wraps the pi-ai model as a CortexModel', async () => {
      const piModel = {
        provider: 'anthropic',
        name: 'claude-sonnet-4',
        contextWindow: 200_000,
      };
      mockGetModel.mockReturnValue(piModel);

      const cortexModel = await pm.resolveModel('anthropic', 'claude-sonnet-4');

      expect(isCortexModel(cortexModel)).toBe(true);
      expect(cortexModel.provider).toBe('anthropic');
      expect(cortexModel.modelId).toBe('claude-sonnet-4');
      expect(cortexModel.contextWindow).toBe(200_000);
      expect(cortexModel.__brand).toBe('CortexModel');
    });

    it('unwraps back to the original pi-ai model', async () => {
      const piModel = { provider: 'openai', name: 'gpt-4o', extra: 'data' };
      mockGetModel.mockReturnValue(piModel);

      const cortexModel = await pm.resolveModel('openai', 'gpt-4o');
      const unwrapped = unwrapModel(cortexModel);

      expect(unwrapped).toBe(piModel);
    });

    it('delegates to pi-ai getModel with correct args', async () => {
      mockGetModel.mockReturnValue({});

      await pm.resolveModel('google', 'gemini-2.0-flash');

      expect(mockGetModel).toHaveBeenCalledWith('google', 'gemini-2.0-flash');
    });

    it('throws for a model pi-ai does not know (getModel returns undefined)', async () => {
      mockGetModel.mockReturnValue(undefined);

      await expect(pm.resolveModel('anthropic', 'no-such-model')).rejects.toThrow(
        'Unknown model "no-such-model" for provider "anthropic"',
      );
    });

    it('throws when getModel returns null', async () => {
      mockGetModel.mockReturnValue(null);

      await expect(pm.resolveModel('openai', 'ghost')).rejects.toThrow(
        /Unknown model "ghost" for provider "openai"/,
      );
    });
  });

  describe('createCustomModel', () => {
    it('creates a CortexModel for a custom endpoint', async () => {
      const piModel = { modelId: 'llama3', baseUrl: 'http://localhost:11434/v1' };
      mockCreateModel.mockReturnValue(piModel);

      const cortexModel = await pm.createCustomModel({
        baseUrl: 'http://localhost:11434/v1',
        modelId: 'llama3',
        contextWindow: 8_000,
      });

      expect(isCortexModel(cortexModel)).toBe(true);
      expect(cortexModel.provider).toBe('custom');
      expect(cortexModel.modelId).toBe('llama3');
      expect(cortexModel.contextWindow).toBe(8_000);
    });

    it('defaults contextWindow to 128k', async () => {
      mockCreateModel.mockReturnValue({});

      const cortexModel = await pm.createCustomModel({
        baseUrl: 'http://localhost:11434/v1',
        modelId: 'my-model',
      });

      expect(cortexModel.contextWindow).toBe(128_000);
    });

    it('builds correct model shape from config', async () => {
      mockGetModel.mockReturnValue({});

      await pm.createCustomModel({
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'test',
        contextWindow: 32_000,
        apiKey: 'local-key',
      });

      // Should clone base model via getModel('openai', 'gpt-4.1')
      expect(mockGetModel).toHaveBeenCalledWith('openai', 'gpt-4.1');
    });

    it('uses openai-completions API and sets placeholder key for keyless endpoints', async () => {
      mockGetModel.mockReturnValue({});

      const cortexModel = await pm.createCustomModel({
        baseUrl: 'http://localhost:11434/v1',
        modelId: 'test',
      });

      const inner = unwrapModel(cortexModel) as Record<string, unknown>;
      expect(inner['api']).toBe('openai-completions');
      expect(inner['apiKey']).toBe('sk-no-key-required');
      expect(inner['provider']).toBe('custom');
    });

    it('uses provided apiKey when given', async () => {
      mockGetModel.mockReturnValue({});

      const cortexModel = await pm.createCustomModel({
        baseUrl: 'http://localhost:8080/v1',
        modelId: 'test',
        apiKey: 'local-key',
      });

      const inner = unwrapModel(cortexModel) as Record<string, unknown>;
      expect(inner['apiKey']).toBe('local-key');
    });
  });

  // -----------------------------------------------------------------------
  // Display name extraction (tested via OAuth results)
  // -----------------------------------------------------------------------

  describe('display name extraction', () => {
    it('extracts email from credentials', async () => {
      mockLoginAnthropic.mockResolvedValue({
        email: 'test@example.com',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.displayName).toBe('test@example.com');
    });

    it('extracts accountId when no email', async () => {
      mockLoginAnthropic.mockResolvedValue({
        accountId: 'user-123',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.displayName).toBe('user-123');
    });

    it('extracts email from JWT idToken', async () => {
      // Create a valid JWT payload with email
      const payload = { email: 'jwt@example.com', sub: '123' };
      const encodedPayload = btoa(JSON.stringify(payload));
      const idToken = `header.${encodedPayload}.signature`;

      mockLoginAnthropic.mockResolvedValue({ idToken });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.displayName).toBe('jwt@example.com');
    });

    it('returns undefined displayName when no identity fields', async () => {
      mockLoginAnthropic.mockResolvedValue({
        accessToken: 'token-only',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.displayName).toBeUndefined();
    });

    it('handles malformed JWT gracefully', async () => {
      mockLoginAnthropic.mockResolvedValue({
        idToken: 'not.a.valid.jwt',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      // Should not crash, displayName should be undefined
      expect(result.meta.displayName).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // OAuthMeta fields
  // -----------------------------------------------------------------------

  describe('OAuthMeta', () => {
    it('marks refreshable when refreshToken exists', async () => {
      mockLoginAnthropic.mockResolvedValue({
        refreshToken: 'refresh-token',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.refreshable).toBe(true);
    });

    it('marks not refreshable when no refreshToken', async () => {
      mockLoginAnthropic.mockResolvedValue({
        accessToken: 'no-refresh',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.refreshable).toBe(false);
    });

    it('includes expiresAt when present', async () => {
      const expires = Date.now() + 3600_000;
      mockLoginAnthropic.mockResolvedValue({
        expiresAt: expires,
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.expiresAt).toBe(expires);
    });

    it('omits expiresAt when not present', async () => {
      mockLoginAnthropic.mockResolvedValue({
        accessToken: 'no-expiry',
      });

      const callbacks = {
        onAuth: vi.fn(),
        onPrompt: vi.fn(),
        onProgress: vi.fn(),
      };

      const result = await pm.initiateOAuth('anthropic', callbacks);
      expect(result.meta.expiresAt).toBeUndefined();
    });
  });
});
