/**
 * Default primary models, resolved from the installed pi-ai catalog.
 *
 * A default is a model family, not a model id: each provider names the
 * family it defaults to (Claude Opus for Anthropic), and the newest version
 * of that family its catalog carries is the default. A pi-ai release that
 * adds Opus 6 moves the default with no change here. Providers without a
 * family of their own (aggregators such as OpenRouter) take the first
 * family in {@link FALLBACK_FAMILY_ORDER} they serve, and a provider that
 * serves none of them defaults to its first catalog model, so every
 * resolved default is a model its provider has.
 *
 * Reference: provider-manager.md
 */

import { builtinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';

/**
 * A model family: a pattern over model ids whose capture groups are the
 * version parts (numeric, compared left to right; missing parts count as
 * 0). Patterns are anchored at the end, so snapshot and variant ids
 * (`:batch`, `-fast`, `-latest`, dated releases) never match.
 */
type FamilyName =
  | 'claude-opus'
  | 'bedrock-claude-opus'
  | 'gpt-sol'
  | 'gemini-pro'
  | 'grok'
  | 'muse-spark'
  | 'kimi'
  | 'kimi-for-coding'
  | 'glm'
  | 'deepseek-pro'
  | 'qwen-max'
  | 'minimax'
  | 'mimo-pro'
  | 'mistral-large'
  | 'gpt-oss'
  | 'ring';

const FAMILIES: Record<FamilyName, RegExp> = {
  'claude-opus': /(?:^|[/.])claude-opus-(\d+)(?:[.-](\d{1,2}))?$/i,
  // Bedrock's global cross-region inference profile, invocable from any region.
  'bedrock-claude-opus': /^global\.anthropic\.claude-opus-(\d+)(?:-(\d{1,2}))?$/,
  'gpt-sol': /(?:^|\/)gpt-(\d+)(?:\.(\d+))?-sol$/i,
  'gemini-pro': /(?:^|\/)gemini-(\d+)(?:\.(\d+))?-pro(?:-preview)?$/i,
  grok: /(?:^|\/)grok-(\d+)(?:\.(\d+))?$/i,
  'muse-spark': /(?:^|\/)muse-spark-(\d+)(?:\.(\d+))?$/i,
  kimi: /(?:^|\/)kimi-k(\d+)(?:[.p](\d+))?$/i,
  'kimi-for-coding': /^kimi-for-coding$/,
  glm: /(?:^|\/)glm-(\d+)(?:[.p](\d+))?$/i,
  'deepseek-pro': /(?:^|\/)deepseek-v(\d+)(?:\.(\d+))?-pro$/i,
  'qwen-max': /(?:^|\/)qwen(\d+)(?:\.(\d+))?-max$/i,
  minimax: /(?:^|\/)minimax-m(\d+)(?:\.(\d+))?$/i,
  'mimo-pro': /(?:^|\/)mimo-v(\d+)(?:\.(\d+))?-pro$/i,
  'mistral-large': /^mistral-large-(\d{4})$/,
  'gpt-oss': /(?:^|\/)gpt-oss-(\d+)b$/i,
  ring: /^ring-(\d+)(?:\.(\d+))?-1t$/i,
};

/** The family each provider defaults to. */
export const PRIMARY_MODEL_FAMILIES: Readonly<Record<string, FamilyName>> = {
  anthropic: 'claude-opus',
  'amazon-bedrock': 'bedrock-claude-opus',
  openai: 'gpt-sol',
  'openai-codex': 'gpt-sol',
  azure: 'gpt-sol',
  google: 'gemini-pro',
  'google-vertex': 'gemini-pro',
  xai: 'grok',
  meta: 'muse-spark',
  groq: 'gpt-oss',
  cerebras: 'gpt-oss',
  mistral: 'mistral-large',
  deepseek: 'deepseek-pro',
  zai: 'glm',
  'zai-coding-cn': 'glm',
  moonshotai: 'kimi',
  'moonshotai-cn': 'kimi',
  'kimi-coding': 'kimi-for-coding',
  minimax: 'minimax',
  'minimax-cn': 'minimax',
  'qwen-token-plan': 'qwen-max',
  'qwen-token-plan-cn': 'qwen-max',
  'qwen-token-plan-individual': 'qwen-max',
  xiaomi: 'mimo-pro',
  'xiaomi-token-plan-cn': 'mimo-pro',
  'xiaomi-token-plan-ams': 'mimo-pro',
  'xiaomi-token-plan-sgp': 'mimo-pro',
  'ant-ling': 'ring',
};

/**
 * Families tried, in order, for a provider without its own (or whose own
 * family its catalog no longer serves): general-purpose flagships first.
 */
export const FALLBACK_FAMILY_ORDER: readonly FamilyName[] = [
  'claude-opus',
  'gpt-sol',
  'gemini-pro',
  'grok',
  'kimi',
  'glm',
  'deepseek-pro',
  'qwen-max',
  'minimax',
  'mimo-pro',
  'gpt-oss',
];

/** The newest id in `ids` matching `family`, or undefined. Ties keep catalog order. */
function newestInFamily(ids: readonly string[], family: RegExp): string | undefined {
  let best: { id: string; version: number[] } | undefined;
  for (const id of ids) {
    const match = family.exec(id);
    if (!match) continue;
    const version = match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
    if (!best || compareVersions(version, best.version) > 0) best = { id, version };
  }
  return best?.id;
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The default primary model for `provider` among `ids` (its catalog, in
 * catalog order): the newest of its family, else of the first fallback
 * family it serves, else its first model. Undefined only for an empty catalog.
 */
export function selectDefaultModelId(provider: string, ids: readonly string[]): string | undefined {
  const own = PRIMARY_MODEL_FAMILIES[provider];
  for (const family of own ? [own, ...FALLBACK_FAMILY_ORDER] : FALLBACK_FAMILY_ORDER) {
    const id = newestInFamily(ids, FAMILIES[family]);
    if (id) return id;
  }
  return ids[0];
}

/**
 * The default primary model id for `provider` from the installed pi-ai
 * catalog (enabled models only). Undefined when pi-ai has no models for it.
 */
export function resolveDefaultModelId(provider: string): string | undefined {
  let models: ReadonlyArray<{ id: string; enabled?: boolean }>;
  try {
    models = getBuiltinModels(provider as never) as ReadonlyArray<{ id: string; enabled?: boolean }>;
  } catch {
    return undefined;
  }
  return selectDefaultModelId(
    provider,
    models.filter((model) => model.enabled !== false).map((model) => model.id),
  );
}

/**
 * Default primary model ids for every provider in the installed pi-ai
 * catalog, resolved when the module loads. Used when a user first connects
 * a provider and no model is explicitly selected.
 */
export const PRIMARY_MODEL_DEFAULTS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    builtinProviders().flatMap((provider) => {
      const id = resolveDefaultModelId(provider.id);
      return id ? [[provider.id, id]] : [];
    }),
  ),
);
