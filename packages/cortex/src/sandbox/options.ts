import { z } from 'zod';
import type { SandboxPolicy, SandboxProvider, SandboxRung, SandboxStatus } from './types.js';

/** Built-in sandbox configuration. Omit sandbox, or pass false, to opt out. */
export interface SandboxOptions {
  enabled?: boolean;
  /** Defaults to workspace. Off keeps the controller available for later changes. */
  rung?: SandboxRung;
  /** Defaults to the agent's workingDirectory. */
  workspaceRoots?: string[];
  /** Additional protected paths, on top of the built-in protections. */
  denyRead?: string[];
  denyWrite?: string[];
  /** Additional network rules; deny rules take precedence. */
  allowedDomains?: string[];
  deniedDomains?: string[];
  /** Refuse execution if the requested OS boundary is unavailable. Default true. */
  requireEnforcement?: boolean;
  /** Advanced: Cortex initializes and disposes this provider instead of the built-in backend. */
  provider?: SandboxProvider;
  onStatusChange?: (state: SandboxState) => void;
}

export interface SandboxState {
  enabled: boolean;
  rung: SandboxRung;
  policy?: SandboxPolicy;
  status: SandboxStatus;
}

export type SandboxConfig = boolean | SandboxOptions | SandboxProvider;

const nonempty = z.string().min(1);
const providerSchema = z.custom<SandboxProvider>((value) => {
  if (!value || typeof value !== 'object') return false;
  const provider = value as Record<string, unknown>;
  return ['initialize', 'wrapSpawn', 'dispose'].every((key) => typeof provider[key] === 'function');
}, 'Expected a SandboxProvider');

const optionsSchema = z.strictObject({
  enabled: z.boolean().optional(),
  rung: z.enum(['restricted', 'workspace', 'trusted', 'off']).optional(),
  workspaceRoots: z.array(nonempty).optional(),
  denyRead: z.array(nonempty).optional(),
  denyWrite: z.array(nonempty).optional(),
  allowedDomains: z.array(nonempty).optional(),
  deniedDomains: z.array(nonempty).optional(),
  requireEnforcement: z.boolean().optional(),
  provider: providerSchema.optional(),
  onStatusChange: z.custom<SandboxOptions['onStatusChange']>((value) => typeof value === 'function').optional(),
});

export function isSandboxProvider(value: unknown): value is SandboxProvider {
  return providerSchema.safeParse(value).success;
}

export function parseSandboxOptions(value: boolean | SandboxOptions): SandboxOptions {
  return optionsSchema.parse(typeof value === 'boolean' ? { enabled: value } : value) as SandboxOptions;
}
