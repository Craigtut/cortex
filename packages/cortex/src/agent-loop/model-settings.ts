/**
 * The models a loop runs on and the settings bound to them: the primary
 * model, the utility model (auto-resolved per provider unless overridden),
 * the context window limit, and the provider cache retention and session
 * key. The single owner of keeping the compaction manager's view of those
 * (context windows, cache TTL) in step with them.
 */

// Static catalog reads come from pi-ai's durable `providers/all` entrypoint.
import { getBuiltinModel as getPiModel, getBuiltinModels as getPiModels } from '@earendil-works/pi-ai/providers/all';
import type { CompactionManager, ObservationalMemory } from '../compaction/index.js';
import { resolveContextBudget } from '../context-budget.js';
import { unwrapModel, wrapModel } from '../model-wrapper.js';
import type { CortexModel } from '../model-wrapper.js';
import { UTILITY_MODEL_OVERRIDES } from '../provider-registry.js';
import type { AgentLoopConfig, CortexLogger } from '../types.js';
import { inferUtilityModel } from '../utility-model-inference.js';
import type { CacheRetention, PiModel } from './pi-agent.js';

type CompactionTarget = Pick<CompactionManager, 'setModelContextWindow' | 'setContextWindow' | 'setCacheInfo'> & {
  memory: Pick<ObservationalMemory, 'setUtilityModelContextWindow'>;
};

export interface ModelSettingsPorts {
  /** Point pi's agent state at a new primary model. */
  writeAgentModel(model: PiModel): void;
  /** Null until the loop has built its compaction manager. */
  compaction(): CompactionTarget | null;
  /** The primary model or its window changed (budgets derived from it must follow). */
  onModelChanged(): void;
  logger: CortexLogger;
}

export class ModelSettings {
  private primaryModel: CortexModel;
  private primaryPiModel: PiModel;
  private utilityModel: CortexModel;
  private utilityPiModel: PiModel;
  private utilityOverridden = false;
  private limit: number | null;
  // Last "configured:effective" pair warned about, so the override notice
  // fires once per distinct outcome rather than on every recompute.
  private warnedContextWindowOverride: string | null = null;
  // Resolved by the consumer (resolveCacheRetention); null means pi-ai uses
  // its own default. Updated on interval changes (sleep/wake transitions).
  private retention: CacheRetention | null = null;
  // Stable cache/session key forwarded as prompt_cache_key; null lets the
  // provider generate one per request.
  private session: string | null;

  constructor(
    private readonly config: AgentLoopConfig,
    private readonly ports: ModelSettingsPorts,
  ) {
    this.primaryModel = config.model;
    this.primaryPiModel = unwrapModel(config.model) as PiModel;
    const utility = resolveUtilityModels(this.primaryModel, this.primaryPiModel, config.utilityModel);
    this.utilityModel = utility.utilityModel;
    this.utilityPiModel = utility.utilityPiModel;
    this.limit = config.contextWindowLimit ?? null;
    this.session = config.sessionId ? config.sessionId : null;
  }

  get primary(): CortexModel {
    return this.primaryModel;
  }

  get primaryPi(): PiModel {
    return this.primaryPiModel;
  }

  get utility(): CortexModel {
    return this.utilityModel;
  }

  get utilityPi(): PiModel {
    return this.utilityPiModel;
  }

  get isUtilityOverridden(): boolean {
    return this.utilityOverridden;
  }

  get contextWindowLimit(): number | null {
    return this.limit;
  }

  get cacheRetention(): CacheRetention | null {
    return this.retention;
  }

  get sessionId(): string | null {
    return this.session;
  }

  /** Point pi's agent state at the current primary model. */
  applyToAgent(): void {
    this.ports.writeAgentModel(this.primaryPiModel);
  }

  /** What auto-resolution would pick for the current primary, without applying it. */
  autoResolvedUtility(): CortexModel {
    return resolveUtilityModels(this.primaryModel, this.primaryPiModel, this.config.utilityModel).utilityModel;
  }

  setModel(model: CortexModel): void {
    this.primaryModel = model;
    this.primaryPiModel = unwrapModel(model) as PiModel;
    // Only auto-resolve utility model if the user hasn't manually overridden it
    if (!this.utilityOverridden) {
      const utilityModels = resolveUtilityModels(this.primaryModel, this.primaryPiModel, this.config.utilityModel);
      this.utilityModel = utilityModels.utilityModel;
      this.utilityPiModel = utilityModels.utilityPiModel;
    }
    this.applyToAgent();
    this.syncCompaction();
    this.ports.onModelChanged();
  }

  setUtilityModel(model: CortexModel): void {
    if (model.provider !== this.primaryModel.provider) {
      throw new Error(
        `Utility model provider "${model.provider}" does not match ` +
        `primary model provider "${this.primaryModel.provider}". ` +
        `The utility model must be from the same provider as the primary model.`,
      );
    }
    this.utilityModel = model;
    this.utilityPiModel = unwrapModel(model) as PiModel;
    this.utilityOverridden = true;
    this.ports.compaction()?.memory.setUtilityModelContextWindow(model.contextWindow);
  }

  resetUtilityModel(): void {
    this.utilityOverridden = false;
    const utilityModels = resolveUtilityModels(
      this.primaryModel,
      this.primaryPiModel,
      this.config.utilityModel,
    );
    this.utilityModel = utilityModels.utilityModel;
    this.utilityPiModel = utilityModels.utilityPiModel;
    this.ports.compaction()?.memory.setUtilityModelContextWindow(utilityModels.utilityModel.contextWindow);
  }

  setContextWindow(contextWindow: number): void {
    this.primaryPiModel = {
      ...this.primaryPiModel,
      contextWindow,
    };
    this.primaryModel = wrapModel(
      this.primaryPiModel,
      this.primaryModel.provider,
      this.primaryModel.modelId,
      contextWindow,
    );
    this.applyToAgent();
    this.syncContextWindow();
    this.ports.onModelChanged();
  }

  setContextWindowLimit(limit: number | null): void {
    resolveContextBudget(this.primaryModel.contextWindow, limit);
    this.limit = limit;
    this.syncContextWindow();
    this.ports.onModelChanged();
  }

  setCacheRetention(value: CacheRetention): void {
    this.retention = value;
    this.syncCacheInfo();
  }

  setSessionId(value: string | null): void {
    this.session = value;
  }

  /**
   * Bring the compaction manager in line with every setting it derives
   * from: context windows and cache TTL. Called once the manager exists
   * and whenever the primary model changes.
   */
  syncCompaction(): void {
    this.syncContextWindow();
    this.syncCacheInfo();
  }

  private syncContextWindow(): void {
    const compaction = this.ports.compaction();
    if (compaction) this.updateEffectiveContextWindow(compaction);
  }

  /**
   * L1 microcompaction gates trimming on whether the prompt cache has gone
   * cold, which depends on the provider and the retention in force
   * ('none' until the consumer sets one).
   */
  private syncCacheInfo(): void {
    this.ports.compaction()?.setCacheInfo(
      this.primaryModel.provider,
      this.retention ?? 'none',
      this.primaryModel.capabilities?.promptCaching,
      this.primaryModel.capabilities?.promptCacheLifetimes,
    );
  }

  /**
   * Recompute and apply the effective context window from the model
   * and the user-configured limit.
   */
  private updateEffectiveContextWindow(compaction: CompactionTarget): void {
    const budget = resolveContextBudget(this.primaryModel.contextWindow, this.limit);
    // Hard overflow protection uses backend capacity. Proactive compaction uses
    // the loop budget. Neither value changes the provider's runtime allocation.
    compaction.setModelContextWindow(budget.capacity);
    compaction.setContextWindow(budget.effective);
    if (budget.adjustmentReason) {
      this.warnContextWindowOverride(this.limit, budget.effective, budget.adjustmentReason);
    }

    // Set utility model context window for observational memory clamps
    const utilityModel = this.utilityModel;
    if (utilityModel) {
      compaction.memory.setUtilityModelContextWindow(utilityModel.contextWindow);
    }
  }

  /**
   * Report a budget clamped by backend capacity, once per distinct outcome.
   */
  private warnContextWindowOverride(
    configured: number | null,
    effective: number,
    reason: string,
  ): void {
    if (configured === null || configured === effective) return;
    const key = `${configured}:${effective}`;
    if (this.warnedContextWindowOverride === key) return;
    this.warnedContextWindowOverride = key;
    this.ports.logger.warn('configured contextWindowLimit is not the value in force', {
      configured,
      effective,
      reason,
    });
  }
}

/**
 * Resolve the utility model from the public CortexModel boundary.
 * If 'default' or undefined, look up the provider default and preserve
 * the raw provider-specific fields from the primary pi-ai model.
 */
function inferDefaultUtilityModel(provider: string): PiModel | null {
  const overrideModelId = UTILITY_MODEL_OVERRIDES[provider];
  if (overrideModelId) {
    try {
      const overrideModel = (getPiModel as unknown as (provider: string, modelId: string) => unknown)(provider, overrideModelId);
      if (overrideModel) return overrideModel as PiModel;
    } catch {
      return null;
    }
  }

  try {
    const models = (getPiModels as unknown as (provider: string) => PiModel[])(provider);
    return inferUtilityModel(models as unknown as Array<Record<string, unknown>>) as PiModel | null;
  } catch {
    return null;
  }
}

export function resolveUtilityModels(
  primaryModel: CortexModel,
  primaryPiModel: PiModel,
  utilityModelConfig?: CortexModel | 'default',
): {
  utilityModel: CortexModel;
  utilityPiModel: PiModel;
} {
  const primaryProvider = primaryModel.provider;

  if (!utilityModelConfig || utilityModelConfig === 'default') {
    const utilityPiModel = inferDefaultUtilityModel(primaryProvider);
    if (!utilityPiModel) {
      return {
        utilityModel: primaryModel,
        utilityPiModel: primaryPiModel,
      };
    }

    const rawUtilityId = utilityPiModel['id'];
    const rawUtilityName = utilityPiModel['name'];
    const utilityModelId = typeof rawUtilityId === 'string' ? rawUtilityId : String(rawUtilityId ?? rawUtilityName);

    return {
      utilityPiModel,
      utilityModel: wrapModel(
        utilityPiModel,
        primaryProvider,
        utilityModelId,
        utilityPiModel.contextWindow ?? primaryModel.contextWindow,
      ),
    };
  }

  if (utilityModelConfig.provider !== primaryProvider) {
    throw new Error(
      `Utility model provider "${utilityModelConfig.provider}" does not match ` +
      `primary model provider "${primaryProvider}". ` +
      `The utility model must be from the same provider as the primary model.`,
    );
  }

  return {
    utilityModel: utilityModelConfig,
    utilityPiModel: unwrapModel(utilityModelConfig) as PiModel,
  };
}
