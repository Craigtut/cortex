/** Built-in sandbox policy, platform adapters, and public configuration. */
export type {
  SandboxRung,
  SandboxFilesystemPolicy,
  SandboxNetworkMode,
  SandboxNetworkPolicy,
  SandboxPolicy,
  SandboxEnforcement,
  SandboxBackend,
  SandboxStatus,
  SandboxSpawnSpec,
  SandboxExecSpec,
  WrappedSpawn,
  SandboxDenial,
  SandboxCommandFailure,
  SandboxProvider,
  NetworkAccessRequest,
  NetworkAccessScope,
  NetworkAccessDecision,
  ResolveNetworkAccess,
} from './types.js';

export { SandboxRuntimeProvider } from './backends/runtime.js';
export type { SandboxRuntimeProviderOptions } from './backends/runtime.js';
export { MxcSandboxProvider } from './backends/mxc.js';
export { resolveMxcSdk } from './backends/mxc-host.js';
export type { MxcSandboxProviderOptions, MxcProviderDeps, MxcDomainProxy } from './backends/mxc.js';
export { createSandboxProvider } from './factory.js';
export type { CreateSandboxProviderOptions } from './factory.js';
export { denialFromViolations, denialFromFailureHeuristic } from './classify.js';
export type { ViolationLike, DenialCorroborationContext } from './classify.js';
export {
  buildDefaultPolicy,
  defaultSecretReadDenies,
  defaultDangerousWriteDenies,
  matchesDomainPattern,
  matchesAnyDomainPattern,
  SEEDED_REGISTRY_DOMAINS,
  DEFAULT_CREDENTIAL_ENV_VARS,
} from './policy.js';
export type { DefaultPolicyOptions } from './policy.js';

export type { SandboxConfig, SandboxOptions, SandboxState } from './options.js';
