import { describe, expect, it } from 'vitest';
import { createSandboxProvider } from '../../../src/sandbox/factory.js';
import { MxcSandboxProvider } from '../../../src/sandbox/backends/mxc.js';
import { SandboxRuntimeProcess } from '../../../src/sandbox/backends/runtime-process.js';

describe('createSandboxProvider', () => {
  it('selects MXC BaseContainer on win32, with no other Windows backend', () => {
    expect(createSandboxProvider({}, 'win32')).toBeInstanceOf(MxcSandboxProvider);
  });

  it('selects the sandbox-runtime process on darwin and linux', () => {
    expect(createSandboxProvider({}, 'darwin')).toBeInstanceOf(SandboxRuntimeProcess);
    expect(createSandboxProvider({}, 'linux')).toBeInstanceOf(SandboxRuntimeProcess);
  });

  it('falls back to the sandbox-runtime process on an unknown platform', () => {
    expect(createSandboxProvider({}, 'freebsd' as NodeJS.Platform)).toBeInstanceOf(SandboxRuntimeProcess);
  });
});
