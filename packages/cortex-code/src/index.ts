#!/usr/bin/env node

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

/**
 * @animus-labs/cortex-code
 *
 * CLI entry point for the Cortex Code terminal-based coding agent.
 *
 * Usage:
 *   cortex                          Start interactive session
 *   cortex --resume [session-id]    Resume last (or specific) session
 *   cortex --model <model>          Override default model
 *   cortex --yolo                   Start in YOLO mode (bypass permissions)
 *   cortex --duplex                 Run the talker/reasoner duplex agent
 */

import { ProviderManager, type ThinkingLevel } from '@animus-labs/cortex';
import { parseArgs } from './cli-args.js';
import { loadConfig } from './config/config.js';
import { CredentialStore } from './config/credentials.js';
import { runComplete } from './complete.js';
import type { Session as CortexCodeSession } from './session.js';

/**
 * Set once the interactive session exists, so the process-level crash and
 * signal handlers can restore the terminal before exiting. Null during CLI
 * argument parsing, the `complete` subcommand, and first-run setup.
 */
let activeSession: CortexCodeSession | null = null;

async function main(): Promise<void> {
  if (process.argv[2] === 'complete') {
    await runComplete(process.argv.slice(3), { version: PKG_VERSION });
    return;
  }

  const args = parseArgs(process.argv, PKG_VERSION);
  const cwd = process.cwd();

  // Load config
  const config = await loadConfig(cwd);
  const [
    { Session },
    { BUILD_MODE },
    { listSessions },
    { runFirstRunSetup },
    { defaultModelFor, resolveConfiguredModel },
    { resolveUpdateInfo },
  ] = await Promise.all([
    import('./session.js'),
    import('./modes/build.js'),
    import('./persistence/sessions.js'),
    import('./providers/setup-tui.js'),
    import('./providers/model-resolution.js'),
    import('./updates/checker.js'),
  ]);

  // Resolve update availability from the local cache (non-blocking: this also
  // kicks off a background registry refresh for the next launch).
  const updateCheckEnabled = args.updateCheck && config.updateCheck !== false;
  const updateInfo = await resolveUpdateInfo({ currentVersion: PKG_VERSION, enabled: updateCheckEnabled });

  // Load credentials. ProviderManager reads and refreshes provider
  // credentials through this store, under its cross-process file lock.
  const credentialStore = new CredentialStore();
  const providerManager = new ProviderManager({ credentials: credentialStore });
  const hasProviders = await credentialStore.hasProviders();

  let provider: string;
  let modelId: string;
  let model: Awaited<ReturnType<ProviderManager['resolveModel']>>;

  if (!hasProviders) {
    // No credentials stored: run first-run setup
    const setupResult = await runFirstRunSetup(providerManager, credentialStore, config.ollama, config.contextWindowLimit);
    provider = setupResult.provider;
    modelId = setupResult.modelId;
    model = setupResult.resolvedModel;
  } else {
    // Resolve from stored credentials
    const defaults = await credentialStore.getDefaults();
    const resolvedProvider = config.defaultProvider ?? defaults.provider;
    if (!resolvedProvider) {
      console.error('No provider configured. Run cortex to set up a provider.');
      process.exit(1);
    }
    provider = resolvedProvider;
    modelId = args.model ?? config.defaultModel ?? defaults.model ?? defaultModelFor(provider);

    // Resolve local connections through the shared provider configuration.
    const entry = await credentialStore.getProvider(provider);
    if (entry?.method === 'custom' || provider === 'ollama') {
      model = await resolveConfiguredModel(providerManager, provider, modelId, entry, config.ollama, config.contextWindowLimit);
    } else {
      try {
        model = await providerManager.resolveModel(provider, modelId);
      } catch (error) {
        // A stored model id can stop existing under us: pi prunes retired
        // models from its catalog on upgrade (0.80 -> 0.84 dropped 77 across
        // the providers Cortex supports), and resolveModel throws by design on
        // a catalog miss. Left uncaught that is a hard startup failure with no
        // way back in, so fall back to the provider default and say so.
        const fallbackId = defaultModelFor(provider);
        if (fallbackId === modelId) throw error;
        console.warn(
          `Model "${modelId}" is no longer available for provider "${provider}". ` +
          `Falling back to "${fallbackId}". Use /model to pick a different one.`,
        );
        model = await providerManager.resolveModel(provider, fallbackId);
        modelId = fallbackId;
      }
    }
  }

  // Handle resume
  let resumeSessionId: string | undefined;
  if (args.resume) {
    if (typeof args.resume === 'string') {
      resumeSessionId = args.resume;
    } else {
      // Resume most recent session
      const sessions = await listSessions();
      if (sessions.length > 0 && sessions[0]) {
        resumeSessionId = sessions[0].id;
        console.log(`Resuming session ${resumeSessionId}`);
      } else {
        console.log('No previous sessions found. Starting new session.');
      }
    }
  }

  const initialUtilityModelId = config.defaultUtilityModel
    ?? await credentialStore.getDefaultUtilityModel(provider)
    ?? undefined;

  // Resolve initial effort: CLI config > persisted default > 'medium'
  const VALID_EFFORTS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'max'];
  const persistedEffort = await credentialStore.getDefaultEffort();
  const configEffort = config.defaultEffort as ThinkingLevel | undefined;
  const rawEffort = configEffort ?? persistedEffort ?? 'medium';
  const initialEffort: ThinkingLevel = VALID_EFFORTS.includes(rawEffort as ThinkingLevel)
    ? rawEffort as ThinkingLevel
    : 'medium';

  // Create and start session
  let session: CortexCodeSession | null = null;
  let uninstallSignalHandlers: (() => void) | null = null;
  try {
    session = new Session({
      config,
      mode: BUILD_MODE,
      model,
      provider,
      modelId,
      providerManager,
      credentialStore,
      cwd,
      yoloMode: args.yolo,
      duplex: args.duplex,
      initialEffort,
      initialUtilityModelId,
      resumeSessionId,
      updateInfo,
      ...(args.compaction ? { compactionStrategy: args.compaction } : {}),
    });
    activeSession = session;
    uninstallSignalHandlers = installActivitySignalHandlers(session);

    await session.start();

    // If resuming, restore conversation history
    if (resumeSessionId) {
      await session.resume(resumeSessionId);
    }
  } catch (err) {
    uninstallSignalHandlers?.();
    await session?.recordFatalActivityError(err);
    // Tear down whatever start() already built (agent, MCP, sandbox runtime)
    // so a failed launch leaves no runtime process or temp directory behind.
    await session?.disposeSandbox().catch(() => {});
    throw err;
  }
}

function installActivitySignalHandlers(session: CortexCodeSession): () => void {
  // SIGHUP does not exist on Windows and process.once() throws for it there.
  // SIGTERM is supported (synthetically) on all platforms Node targets.
  const signals: NodeJS.Signals[] = process.platform === 'win32'
    ? ['SIGTERM']
    : ['SIGTERM', 'SIGHUP'];
  const disposers: Array<() => void> = [];
  let exiting = false;

  for (const signal of signals) {
    const listener = () => {
      // Restore the terminal out of raw mode immediately (idempotent) so the
      // user is never left with a wedged shell, even if activity recording hangs.
      session.restoreTerminal();
      if (exiting) {
        process.exit(exitCodeForSignal(signal));
      }
      exiting = true;
      const timeout = setTimeout(() => {
        process.exit(exitCodeForSignal(signal));
      }, 2_000);
      void Promise.allSettled([
        session.recordSignalActivityError(signal),
        session.disposeSandbox(),
      ]).finally(() => {
        clearTimeout(timeout);
        process.exit(exitCodeForSignal(signal));
      });
    };
    try {
      process.once(signal, listener);
      disposers.push(() => {
        process.off(signal, listener);
      });
    } catch {
      // Signal not supported on this platform; skip it.
    }
  }

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  switch (signal) {
    case 'SIGHUP':
      return 129;
    case 'SIGTERM':
      return 143;
    default:
      return 1;
  }
}

/**
 * Restore the terminal, log, and exit on an otherwise-unhandled crash. Without
 * this, an uncaughtException or unhandledRejection would terminate the process
 * with the terminal still in raw mode, leaving the user's shell wedged. These
 * handlers are cross-platform (unlike POSIX signals).
 */
function handleFatalCrash(kind: string, err: unknown): void {
  try {
    activeSession?.restoreTerminal();
  } catch {
    // Best-effort terminal restore; never mask the original crash.
  }
  console.error(`Fatal ${kind}:`, err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}

process.on('uncaughtException', (err) => handleFatalCrash('exception', err));
process.on('unhandledRejection', (reason) => handleFatalCrash('rejection', reason));

// Run
main().catch((err) => {
  activeSession?.restoreTerminal();
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
