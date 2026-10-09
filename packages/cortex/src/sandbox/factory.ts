/** Platform backends for Cortex-managed sessions and advanced integrations.
 * macOS/Linux use an isolated runtime process; Windows uses MXC BaseContainer.
 */
import type { SandboxRuntimeProviderOptions } from './backends/runtime.js';
import { SandboxRuntimeProcess } from './backends/runtime-process.js';
import { MxcSandboxProvider } from './backends/mxc.js';
import type { SandboxProvider } from './types.js';

/**
 * Options shared by every platform provider: `onNetworkRequest` answers shell
 * egress the policy leaves open, `onDegraded` hears reduced enforcement, and
 * `credentialEnvVars` lists the variables scrubbed from contained commands.
 */
export type CreateSandboxProviderOptions = SandboxRuntimeProviderOptions;

/**
 * Construct the platform-appropriate provider. `platform` is injectable purely
 * so the selection is unit-testable; it defaults to the real process platform
 * and callers should not pass it in production.
 */
export function createSandboxProvider(
  options: CreateSandboxProviderOptions = {},
  platform: NodeJS.Platform = process.platform,
): SandboxProvider {
  if (platform === 'win32') {
    // MXC when its probe passes at initialize; otherwise honest `none` with
    // the reason. There is no weaker Windows fallback.
    return new MxcSandboxProvider(options);
  }
  return new SandboxRuntimeProcess(options);
}
