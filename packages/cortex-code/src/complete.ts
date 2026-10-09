import { readFile } from 'node:fs/promises';

import {
  ProviderManager,
  completeModel,
  structuredCompletionRequest,
  parseSchemaCompletion,
  type CortexModel,
} from '@animus-labs/cortex';

import { loadConfig } from './config/config.js';
import { CredentialStore } from './config/credentials.js';
import { resolveStoredOAuthApiKey } from './utils/oauth-credentials.js';
import { defaultModelFor, resolveConfiguredModel } from './providers/model-resolution.js';

interface CompleteArgs {
  promptParts: string[];
  promptFile: string | undefined;
  schemaPath: string | undefined;
  model: string | undefined;
  provider: string | undefined;
  systemPrompt: string | undefined;
  systemFile: string | undefined;
  usePrimary: boolean;
  pretty: boolean;
  help: boolean;
}

interface ResolvedCompletionModel {
  provider: string;
  modelId: string;
  model: CortexModel;
}

export async function runComplete(argv: string[], options: { version: string }): Promise<void> {
  const args = parseCompleteArgs(argv);
  if (args.help) {
    printCompleteUsage(options.version);
    return;
  }

  const prompt = await readPrompt(args);
  if (!prompt.trim()) {
    throw new Error('A prompt is required. Pass text, --prompt-file <path>, or stdin.');
  }

  const schema = args.schemaPath
    ? JSON.parse(await readFile(args.schemaPath, 'utf-8')) as unknown
    : null;
  const systemPrompt = await readSystemPrompt(args);

  const providerManager = new ProviderManager();
  const credentialStore = new CredentialStore();
  const resolved = await resolveCompletionModel({
    providerManager,
    credentialStore,
    modelOverride: args.model,
    providerOverride: args.provider,
    usePrimary: args.usePrimary,
    cwd: process.cwd(),
  });
  const apiKey = await resolveApiKey(
    providerManager,
    credentialStore,
    resolved.model.provider,
    resolved.provider,
  );

  const result = await completeWithModel({
    model: resolved.model,
    apiKey,
    systemPrompt,
    prompt,
    schema,
  });

  const output = schema ? JSON.stringify(result, null, args.pretty ? 2 : 0) : String(result);
  process.stdout.write(`${output}\n`);
}

function parseCompleteArgs(argv: string[]): CompleteArgs {
  const args: CompleteArgs = {
    promptParts: [],
    promptFile: undefined,
    schemaPath: undefined,
    model: undefined,
    provider: undefined,
    systemPrompt: undefined,
    systemFile: undefined,
    usePrimary: false,
    pretty: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    switch (arg) {
      case '--schema':
        args.schemaPath = requireValue(argv, ++i, '--schema');
        break;
      case '--model':
        args.model = requireValue(argv, ++i, '--model');
        break;
      case '--provider':
        args.provider = requireValue(argv, ++i, '--provider');
        break;
      case '--system':
        args.systemPrompt = requireValue(argv, ++i, '--system');
        break;
      case '--system-file':
        args.systemFile = requireValue(argv, ++i, '--system-file');
        break;
      case '--prompt-file':
        args.promptFile = requireValue(argv, ++i, '--prompt-file');
        break;
      case '--primary':
        args.usePrimary = true;
        break;
      case '--pretty':
        args.pretty = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown complete option: ${arg}`);
        }
        args.promptParts.push(arg);
        break;
    }
  }

  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function readPrompt(args: CompleteArgs): Promise<string> {
  if (args.promptFile) {
    return readFile(args.promptFile, 'utf-8');
  }
  if (args.promptParts.length > 0) {
    return args.promptParts.join(' ');
  }
  if (!process.stdin.isTTY) {
    return readStdin();
  }
  return '';
}

async function readSystemPrompt(args: CompleteArgs): Promise<string> {
  if (args.systemFile) {
    return readFile(args.systemFile, 'utf-8');
  }
  return args.systemPrompt ?? '';
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function resolveCompletionModel(input: {
  providerManager: ProviderManager;
  credentialStore: CredentialStore;
  modelOverride: string | undefined;
  providerOverride: string | undefined;
  usePrimary: boolean;
  cwd: string;
}): Promise<ResolvedCompletionModel> {
  const config = await loadConfig(input.cwd);
  const defaults = await input.credentialStore.getDefaults();
  const provider = input.providerOverride ?? config.defaultProvider ?? defaults.provider;
  if (!provider) {
    throw new Error('No provider configured. Run cortex to set up a provider.');
  }

  const entry = await input.credentialStore.getProvider(provider);
  // Only reached for when nothing else names a model: a provider without a
  // default (Ollama) must not fail a call that did name one.
  const providerDefaultModel = (): string => entry?.method === 'custom' && entry.modelId
    ? entry.modelId
    : defaultModelFor(provider);
  const primaryModelId = input.modelOverride
    ?? config.defaultModel
    ?? defaults.model
    ?? providerDefaultModel();
  const utilityModelId = input.usePrimary
    ? primaryModelId
    : input.modelOverride
      ?? config.defaultUtilityModel
      ?? await input.credentialStore.getDefaultUtilityModel(provider)
      ?? primaryModelId;

  const model = await resolveConfiguredModel(input.providerManager, provider, utilityModelId, entry, config.ollama, config.contextWindowLimit);
  return { provider, modelId: utilityModelId, model };
}

async function resolveApiKey(
  providerManager: ProviderManager,
  credentialStore: CredentialStore,
  modelProvider: string,
  configuredProvider: string,
): Promise<string> {
  let credentialProvider = modelProvider;
  let entry = await credentialStore.getProvider(modelProvider);
  if (!entry && modelProvider !== configuredProvider) {
    credentialProvider = configuredProvider;
    entry = await credentialStore.getProvider(configuredProvider);
  }
  if (!entry) {
    if (modelProvider === 'custom' || configuredProvider === 'ollama') {
      return 'sk-no-key-required';
    }
    throw new Error(`No credentials for provider "${modelProvider}". Run cortex to connect.`);
  }

  if (entry.method === 'api_key' && entry.apiKey) {
    return entry.apiKey;
  }

  if (entry.method === 'oauth' && entry.oauthCredentials) {
    // Shared with the interactive path: refreshes, persists rotation, and
    // recovers from a cross-process refresh race (another `cortex -p` run or
    // interactive session rotating the same token concurrently).
    return resolveStoredOAuthApiKey(providerManager, credentialStore, credentialProvider, entry);
  }

  if (entry.method === 'custom') {
    return entry.apiKey || 'sk-no-key-required';
  }

  throw new Error(`Unable to resolve API key for provider "${modelProvider}"`);
}

async function completeWithModel(input: {
  model: CortexModel;
  apiKey: string;
  systemPrompt: string;
  prompt: string;
  schema: unknown | null;
}): Promise<unknown> {
  const toolName = 'structured_output';
  const context: Record<string, unknown> = {
    systemPrompt: input.systemPrompt,
    messages: [{ role: 'user', content: input.prompt, timestamp: Date.now() }],
  };
  const completeOptions: Record<string, unknown> = { apiKey: input.apiKey };
  if (input.schema) {
    const request = structuredCompletionRequest(input.model, input.schema, {
      name: toolName, description: 'Produce structured output', parameters: input.schema,
    });
    Object.assign(context, request.context);
    Object.assign(completeOptions, request.options);
  }

  const result = await completeModel(
    input.model,
    context as unknown as Parameters<typeof completeModel>[1],
    completeOptions,
  );
  checkForSilentError(result);

  if (input.schema) {
    if (input.model.capabilities?.structuredOutput === 'json-schema') return parseSchemaCompletion(result, input.schema);
    const toolArgs = extractToolCallArgs(result, toolName);
    if (toolArgs) {
      return toolArgs;
    }
    const text = extractText(result);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Model did not return structured output.');
    }
  }

  return extractText(result);
}

function checkForSilentError(result: unknown): void {
  if (!result || typeof result !== 'object') return;
  const msg = result as Record<string, unknown>;
  if (msg['stopReason'] === 'error') {
    const errorMessage = typeof msg['errorMessage'] === 'string'
      ? msg['errorMessage']
      : 'Unknown pi-ai error';
    throw new Error(`LLM call failed: ${errorMessage}`);
  }
}

function extractToolCallArgs(result: unknown, toolName: string): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;

  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      (part as Record<string, unknown>)['type'] === 'toolCall' &&
      (part as Record<string, unknown>)['name'] === toolName
    ) {
      const args = (part as Record<string, unknown>)['arguments'];
      if (args && typeof args === 'object') {
        return args as Record<string, unknown>;
      }
    }
  }

  return null;
}

function extractText(result: unknown): string {
  if (!result || typeof result !== 'object') {
    return String(result ?? '');
  }

  const content = (result as Record<string, unknown>)['content'];
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (part && typeof part === 'object') {
      const value = part as Record<string, unknown>;
      if (value['type'] === 'text' && typeof value['text'] === 'string') {
        parts.push(value['text']);
      }
    }
  }
  return parts.join('');
}

function printCompleteUsage(version: string): void {
  console.log(`
cortex v${version} - Lightweight completion

Usage:
  cortex complete [options] <prompt>
  cortex complete --schema schema.json <prompt>
  echo "Prompt" | cortex complete --schema schema.json

Options:
  --schema <path>          Return JSON matching the schema
  --model <model>          Override the configured model
  --provider <provider>    Override the configured provider
  --system <prompt>        System prompt text
  --system-file <path>     Read the system prompt from a file
  --prompt-file <path>     Read the user prompt from a file
  --primary                Use the primary model instead of the utility model
  --pretty                 Pretty-print structured JSON
  --help                   Show this help
`.trim());
}
