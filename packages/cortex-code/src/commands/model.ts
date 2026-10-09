import { SelectList, Text, Container, type SelectItem } from '@earendil-works/pi-tui';
import type { Command, CommandSession } from './index.js';
import { compactContext } from './compact.js';
import { selectListTheme, colors } from '../tui/theme.js';
import { OverlayBox } from '../tui/overlay-box.js';
import { detectOllama, getOllamaContextWindow } from '../providers/ollama.js';
import { log } from '../logger.js';

// ---------------------------------------------------------------------------
// /model - Switch primary model (current provider)
// ---------------------------------------------------------------------------

export const modelCommand: Command = {
  name: 'model',
  description: 'Switch primary model',
  handler: async (session) => {
    const agent = session.getAgent();
    const app = session.getApp();
    if (!agent || !app) return;

    const provider = session.getProvider();
    const currentModelId = session.getModelId();
    await showModelPicker(session, provider, currentModelId, 'primary');
  },
};

// ---------------------------------------------------------------------------
// /provider - Switch provider, then pick a primary model
// ---------------------------------------------------------------------------

export const providerCommand: Command = {
  name: 'provider',
  description: 'Switch provider and model',
  handler: async (session) => {
    const agent = session.getAgent();
    const app = session.getApp();
    if (!agent || !app) return;

    const store = session.getCredentialStore();
    const credFile = await store.load();
    const providerIds = Object.keys(credFile.providers);
    const currentProvider = session.getProvider();
    const currentModelId = session.getModelId();

    // Auto-detect running Ollama and include it even without a credential entry
    if (!providerIds.includes('ollama')) {
      const entry = await session.getCredentialStore().getProvider('ollama');
      const ollama = await detectOllama({ baseUrl: entry?.baseUrl, apiKey: entry?.apiKey });
      if (ollama.running && ollama.models.length > 0) {
        providerIds.push('ollama');
      }
    }

    if (providerIds.length === 0) {
      app.transcript.addNotification('Provider', 'No providers configured. Use /login to add one.');
      return;
    }

    // Show provider picker with current model info next to each
    const items: SelectItem[] = providerIds.map(id => {
      const isCurrent = id === currentProvider;
      return {
        value: id,
        label: isCurrent ? `${id}` : id,
        description: isCurrent ? `${currentModelId} \u2190 current` : '',
      };
    });

    const list = new SelectList(items, Math.min(items.length, 8), selectListTheme);
    const overlayBox = new OverlayBox(list, 'Switch Provider');
    const handle = app.tui.showOverlay(overlayBox, {
      anchor: 'center',
      width: '55%',
      maxHeight: 12,
    });

    return new Promise<void>((resolve) => {
      list.onSelect = async (item) => {
        handle.hide();

        // Flow into primary model picker for the selected provider
        const selectedProvider = item.value;
        const modelId = selectedProvider === currentProvider ? currentModelId : '';
        await showModelPicker(session, selectedProvider, modelId, 'primary');
        app.focusEditor();
        resolve();
      };

      list.onCancel = () => {
        handle.hide();
        app.focusEditor();
        resolve();
      };
    });
  },
};

// ---------------------------------------------------------------------------
// /utility-model - Switch utility model (current provider)
// ---------------------------------------------------------------------------

export const utilityModelCommand: Command = {
  name: 'utility-model',
  description: 'Switch utility model',
  handler: async (session) => {
    const agent = session.getAgent();
    const app = session.getApp();
    if (!agent || !app) return;

    const provider = session.getProvider();
    const utilityModel = agent.getUtilityModel();
    // Only mark a model as current if the user explicitly overrode the utility model.
    // In auto mode, only the Auto option should show as current.
    const currentModelId = agent.isUtilityModelOverridden() ? utilityModel.modelId : '';
    await showModelPicker(session, provider, currentModelId, 'utility');
  },
};

// ---------------------------------------------------------------------------
// Shared: Model picker
// ---------------------------------------------------------------------------

async function showModelPicker(
  session: any,
  provider: string,
  currentModelId: string,
  tier: 'primary' | 'utility' = 'primary',
): Promise<void> {
  const app = session.getApp();
  if (!app) return;

  log.info('/model: fetching models', { provider });
  app.showStatusSpinner('Loading models...');

  // List models for the selected provider
  let models: Array<{ id: string; name: string; contextWindow: number }>;
  try {
    if (provider === 'ollama') {
      // Ollama models come from the local Ollama API, not pi-ai's registry
      const entry = await session.getCredentialStore().getProvider('ollama');
      const ollama = await detectOllama({ baseUrl: entry?.baseUrl, apiKey: entry?.apiKey });
      // Fetch context windows in parallel (fast local /api/show calls)
      const contextWindows = await Promise.all(
        ollama.models.map(m => getOllamaContextWindow(ollama.host, m.name, { apiKey: entry?.apiKey })),
      );
      models = ollama.models.map((m, i) => ({
        id: m.name,
        name: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
        contextWindow: contextWindows[i] ?? 0,
      }));
    } else {
      const pm = session.getProviderManager();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), 10_000),
      );
      const rawModels = await Promise.race([pm.listModels(provider), timeoutPromise]);
      models = rawModels.map((m: any) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow }));
    }
  } catch (err) {
    log.error('/model: listModels failed', { error: err instanceof Error ? err.message : String(err) });
    models = [];
  }

  app.hideStatusSpinner();
  log.info('/model: got models', { count: models.length });

  if (models.length === 0) {
    app.transcript.addNotification(
      'Model',
      `Could not retrieve model list for ${provider}. Use --model <id> flag at startup.`,
    );
    app.focusEditor();
    return;
  }

  const items: SelectItem[] = [];

  // For utility tier, add an "(auto)" option at the top to reset to auto-resolution.
  // Label it with the model auto-resolution will ACTUALLY use (the primary model
  // for Ollama/custom endpoints Cortex can't enumerate), not a value re-inferred
  // from the local model list that the agent never consults.
  if (tier === 'utility') {
    const agent = session.getAgent();
    const autoModelId = agent?.getAutoResolvedUtilityModel().modelId ?? provider;
    items.push({
      value: '__auto__',
      label: `Auto (${autoModelId})`,
      description: agent?.isUtilityModelOverridden() ? '' : '\u2190 current',
    });
  }

  for (const m of models) {
    const isCurrent = m.id === currentModelId;
    const ctxK = m.contextWindow > 0
      ? `${(m.contextWindow / 1000).toFixed(0)}k${provider === 'ollama' ? ' trained maximum' : ''}`
      : 'context unknown';
    const item: SelectItem = {
      value: m.id,
      label: isCurrent ? `${m.id} \u2190 current` : m.id,
    };
    if (m.name !== m.id) {
      item.description = `${m.name} (${ctxK})`;
    } else {
      item.description = ctxK;
    }
    items.push(item);
  }

  const titleSuffix = tier === 'utility' ? ' (Utility)' : '';
  const list = new SelectList(items, Math.min(items.length, 12), selectListTheme);
  const overlayBox = new OverlayBox(list, `${provider} Models${titleSuffix}`);
  const handle = app.tui.showOverlay(overlayBox, {
    anchor: 'center',
    width: '60%',
    maxHeight: 18,
  });

  return new Promise<void>((resolve) => {
    list.onSelect = async (item) => {
      handle.hide();
      app.focusEditor();

      const agent = session.getAgent();
      if (!agent) { resolve(); return; }

      if (tier === 'utility') {
        // Utility model selection
        if (item.value === '__auto__') {
          await session.resetUtilityModel();
          const resolved = agent.getUtilityModel();
          app.transcript.addNotification('Model', `Utility model reset to auto (${resolved.modelId}).`);
        } else {
          try {
            await session.setUtilityModel(item.value);
            app.transcript.addNotification('Model', `Utility model set to ${item.value}.`);
          } catch (err) {
            app.transcript.addNotification('Model Error', `Failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        resolve();
        return;
      }

      // Primary model selection
      // Local allocation can change outside Cortex. Reselecting refreshes it.
      if (provider !== 'ollama' && item.value === currentModelId && provider === session.getProvider()) {
        app.transcript.addNotification('Model', `Already using ${item.value}.`);
        resolve();
        return;
      }

      // Check context window warning
      const selectedModel = models.find(m => m.id === item.value);
      const currentTokens = Math.max(
        agent.currentContextTokenCount,
        agent.estimateCurrentContextTokens(),
      );

      if (selectedModel && selectedModel.contextWindow > 0 && currentTokens > selectedModel.contextWindow) {
        await showModelSwitchWarning(session, provider, item.value, currentTokens, selectedModel.contextWindow);
      } else {
        await doModelSwitch(session, provider, item.value);
      }
      resolve();
    };

    list.onCancel = () => {
      handle.hide();
      app.focusEditor();
      resolve();
    };
  });
}

// ---------------------------------------------------------------------------
// Shared: Model switch warning
// ---------------------------------------------------------------------------

async function showModelSwitchWarning(
  session: any,
  provider: string,
  modelId: string,
  currentTokens: number,
  newContextWindow: number,
): Promise<void> {
  const app = session.getApp();
  if (!app) return;

  const currentK = (currentTokens / 1000).toFixed(1);
  const newK = (newContextWindow / 1000).toFixed(0);

  const warningItems: SelectItem[] = [
    { value: 'compact-first', label: 'Run /compact first, then switch' },
    { value: 'switch-anyway', label: 'Switch anyway (compaction will trigger automatically)' },
    { value: 'cancel', label: 'Cancel' },
  ];

  const container = new Container();
  container.addChild(new Text(
    `Current context usage (${currentK}k tokens) exceeds the new model's context window (${newK}k).`,
    0, 0,
  ));
  container.addChild(new Text('', 0, 0));

  const warningList = new SelectList(warningItems, 3, selectListTheme);
  container.addChild(warningList);

  const overlayBox = new OverlayBox(container, 'Warning');
  const warningHandle = app.tui.showOverlay(overlayBox, {
    anchor: 'center',
    width: '65%',
    maxHeight: 12,
  });

  return new Promise<void>((resolve) => {
    warningList.onSelect = async (choice) => {
      warningHandle.hide();
      app.focusEditor();
      await applySwitchWarningChoice(session, choice.value, provider, modelId);
      resolve();
    };

    warningList.onCancel = () => {
      warningHandle.hide();
      app.focusEditor();
      resolve();
    };
  });
}

/**
 * What a choice in the context-window warning does. Compacting first goes
 * through compactNow, which keeps the recent messages and changes nothing
 * if it fails; the switch happens either way.
 */
export async function applySwitchWarningChoice(
  session: Pick<CommandSession, 'getAgent' | 'getApp' | 'getProvider' | 'runCancellable' | 'switchModel' | 'switchProvider'>,
  choice: string,
  provider: string,
  modelId: string,
): Promise<void> {
  switch (choice) {
    case 'compact-first':
      await compactContext(session);
      await doModelSwitch(session, provider, modelId);
      break;
    case 'switch-anyway':
      await doModelSwitch(session, provider, modelId);
      break;
    case 'cancel':
      break;
  }
}

// ---------------------------------------------------------------------------
// Shared: Execute model switch
// ---------------------------------------------------------------------------

async function doModelSwitch(session: any, provider: string, modelId: string): Promise<void> {
  const app = session.getApp();
  if (!app) return;

  try {
    if (provider !== session.getProvider()) {
      await session.switchProvider(provider, modelId);
      app.transcript.addNotification('Model', `Switched to ${provider}/${modelId}.`);
    } else {
      await session.switchModel(modelId);
      app.transcript.addNotification('Model', `Switched to ${modelId}.`);
    }
  } catch (err) {
    app.transcript.addNotification(
      'Model Error',
      `Failed to switch: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
