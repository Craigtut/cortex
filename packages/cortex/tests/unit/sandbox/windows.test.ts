import { describe, it, expect } from 'vitest';
import {
  WindowsRestrictedTokenProvider,
  serializeWindowsPolicy,
  buildHelperInvocation,
  deriveWorkspaceCapabilitySidName,
  isHelperSetupFailure,
  runHelperSelfTest,
  defaultHelperPath,
  WINDOWS_POLICY_VERSION,
  WINDOWS_HELPER_SETUP_FAILURE_EXIT,
  WINDOWS_HELPER_SETUP_FAILURE_SENTINEL,
  WINDOWS_HELPER_SELFTEST_OK,
  DEFAULT_CAPABILITY_SID_NAME,
} from '../../../src/sandbox/backends/windows.js';
import { existsSync } from 'node:fs';
import { buildDefaultPolicy } from '../../../src/sandbox/policy.js';
import type { SandboxPolicy, SandboxSpawnSpec } from '../../../src/index.js';

// All deterministic and platform-independent: the pure policy/argv logic and the
// provider's honest-status behavior are exercised without a Windows host or the
// helper binary. The Rust helper itself cannot be built or run here.

const WS_ROOT = 'C:\\Users\\dev\\project';
const SBX_TEMP = 'C:\\Users\\dev\\AppData\\Local\\Temp\\cortex-sbx-abc';
const POLICY_DIR = 'C:\\ProgramData\\cortex\\cortex-sbx-policy-1';

function windowsWorkspacePolicy(): SandboxPolicy {
  // buildDefaultPolicy canonicalizes via realpath; these Windows paths do not
  // exist on the test host, so they pass through verbatim (realpath no-ops).
  return buildDefaultPolicy('workspace', {
    workspaceRoots: [WS_ROOT],
    home: 'C:\\Users\\dev',
    sessionTmpDir: SBX_TEMP,
  });
}

function spec(overrides: Partial<SandboxSpawnSpec> = {}): SandboxSpawnSpec {
  return {
    shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    shellArgs: ['-NoProfile', '-NonInteractive', '-Command'],
    command: 'Get-ChildItem; $__ec=$LASTEXITCODE',
    cwd: WS_ROOT,
    env: { PATH: 'C:\\Windows\\System32', GITHUB_TOKEN: 'ghp_secret', HOME: 'C:\\Users\\dev' },
    ...overrides,
  };
}

async function onWin32<T>(fn: () => Promise<T>): Promise<T> {
  // Force the win32 branch regardless of the host running the test.
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

describe('serializeWindowsPolicy', () => {
  it('projects the policy into the helper contract with the version stamp', () => {
    const json = serializeWindowsPolicy(windowsWorkspacePolicy(), {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'cortex-sandbox-install-42-abc123',
      lowIntegrity: true,
    });
    expect(json.version).toBe(WINDOWS_POLICY_VERSION);
    expect(json.capabilitySidName).toBe('cortex-sandbox-install-42-abc123');
    expect(json.lowIntegrity).toBe(true);
    expect(json.writableRoots).toContain(WS_ROOT);
    expect(json.sandboxTemp).toBe(SBX_TEMP);
    // Secret stores and persistence targets flow through from the default policy.
    // (The deny-read ACEs are inert at Tier 1 but stay in the contract.)
    expect(json.denyReadPaths.some((p) => p.endsWith('.ssh'))).toBe(true);
    expect(json.denyWritePaths.some((p) => p.endsWith('.gitconfig'))).toBe(true);
  });

  it('appends the sandbox temp to writableRoots when the policy omits it', () => {
    const policy = windowsWorkspacePolicy();
    policy.filesystem.writableRoots = [WS_ROOT]; // no temp
    const json = serializeWindowsPolicy(policy, {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'x',
      lowIntegrity: true,
    });
    expect(json.writableRoots).toEqual([WS_ROOT, SBX_TEMP]);
  });

  it('does not duplicate the sandbox temp when already present', () => {
    const policy = windowsWorkspacePolicy();
    policy.filesystem.writableRoots = [WS_ROOT, SBX_TEMP];
    const json = serializeWindowsPolicy(policy, {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'x',
      lowIntegrity: false,
    });
    expect(json.writableRoots.filter((r) => r === SBX_TEMP)).toHaveLength(1);
    expect(json.lowIntegrity).toBe(false);
  });

  it('excludes the host temp root from writableRoots (never granted, never Low-labeled)', () => {
    const hostTemp = 'C:\\Users\\dev\\AppData\\Local\\Temp';
    const policy = windowsWorkspacePolicy();
    policy.filesystem.writableRoots = [WS_ROOT, hostTemp];
    const json = serializeWindowsPolicy(policy, {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'x',
      lowIntegrity: false,
      // Case and separator differences must not defeat the exclusion.
      hostTempDir: 'c:/users/dev/appdata/local/temp',
    });
    expect(json.writableRoots).toEqual([WS_ROOT, SBX_TEMP]);
  });

  it('adds the policy file directory to denyWritePaths so the sandbox protects its own policy', () => {
    const json = serializeWindowsPolicy(windowsWorkspacePolicy(), {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'x',
      lowIntegrity: false,
      policyFileDir: POLICY_DIR,
    });
    expect(json.denyWritePaths).toContain(POLICY_DIR);
  });

  it('adds the helper directory to denyWritePaths so a child cannot delete the helper it depends on', () => {
    const helperDir = 'C:\\app\\node_modules\\@animus-labs\\cortex-sandbox\\vendor\\win32-x64';
    const json = serializeWindowsPolicy(windowsWorkspacePolicy(), {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'x',
      lowIntegrity: false,
      helperDir,
    });
    expect(json.denyWritePaths).toContain(helperDir);
  });

  it('does not duplicate the policy dir in denyWritePaths when already present', () => {
    const policy = windowsWorkspacePolicy();
    policy.filesystem.denyWrite = [...policy.filesystem.denyWrite, POLICY_DIR.toLowerCase()];
    const json = serializeWindowsPolicy(policy, {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'x',
      lowIntegrity: false,
      policyFileDir: POLICY_DIR,
    });
    const matches = json.denyWritePaths.filter((p) => p.toLowerCase() === POLICY_DIR.toLowerCase());
    expect(matches).toHaveLength(1);
  });

  it('is JSON-round-trippable (no undefined or non-serializable fields)', () => {
    const json = serializeWindowsPolicy(windowsWorkspacePolicy(), {
      sandboxTemp: SBX_TEMP,
      capabilitySidName: 'x',
      lowIntegrity: true,
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('deriveWorkspaceCapabilitySidName', () => {
  it('is deterministic and scoped per workspace', () => {
    const a = deriveWorkspaceCapabilitySidName('cortex-sandbox', ['C:\\ws-a']);
    const b = deriveWorkspaceCapabilitySidName('cortex-sandbox', ['C:\\ws-b']);
    expect(a).toBe(deriveWorkspaceCapabilitySidName('cortex-sandbox', ['C:\\ws-a']));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^cortex-sandbox-[0-9a-f]{16}$/);
  });

  it('ignores path case, separator style, and root ordering', () => {
    const one = deriveWorkspaceCapabilitySidName('base', ['C:\\WS', 'D:\\Other']);
    expect(deriveWorkspaceCapabilitySidName('base', ['d:/other', 'c:/ws'])).toBe(one);
  });
});

describe('buildHelperInvocation', () => {
  it('puts the policy file first, then -- then shell+args+command', () => {
    const wrapped = buildHelperInvocation({
      helperPath: 'C:\\cortex\\helper.exe',
      policyFilePath: 'C:\\Temp\\policy.json',
      sandboxTemp: SBX_TEMP,
      spec: spec(),
      scrubEnv: (e) => e,
    });
    expect(wrapped.file).toBe('C:\\cortex\\helper.exe');
    expect(wrapped.args).toEqual([
      'C:\\Temp\\policy.json',
      '--',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-ChildItem; $__ec=$LASTEXITCODE',
    ]);
  });

  it('runs env through the scrubber', () => {
    const wrapped = buildHelperInvocation({
      helperPath: 'h.exe',
      policyFilePath: 'p.json',
      sandboxTemp: SBX_TEMP,
      spec: spec(),
      scrubEnv: (e) => {
        const { GITHUB_TOKEN: _drop, ...rest } = e;
        return rest;
      },
    });
    expect(wrapped.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(wrapped.env['PATH']).toBe('C:\\Windows\\System32');
  });

  it('points TEMP and TMP at the dedicated sandbox temp (the real temp root is not writable)', () => {
    const wrapped = buildHelperInvocation({
      helperPath: 'h.exe',
      policyFilePath: 'p.json',
      sandboxTemp: SBX_TEMP,
      spec: spec({
        env: { PATH: 'x', TEMP: 'C:\\Users\\dev\\AppData\\Local\\Temp', TMP: 'C:\\OtherTemp' },
      }),
      scrubEnv: (e) => e,
    });
    expect(wrapped.env['TEMP']).toBe(SBX_TEMP);
    expect(wrapped.env['TMP']).toBe(SBX_TEMP);
    expect(wrapped.env['PATH']).toBe('x');
  });

  it('preserves the -- separator so a command starting with a dash is not read as a flag', () => {
    const wrapped = buildHelperInvocation({
      helperPath: 'h.exe',
      policyFilePath: 'p.json',
      sandboxTemp: SBX_TEMP,
      spec: spec({ command: '--version' }),
      scrubEnv: (e) => e,
    });
    // Everything after the first '--' is the command tail, verbatim.
    const sep = wrapped.args.indexOf('--');
    expect(sep).toBe(1);
    expect(wrapped.args[wrapped.args.length - 1]).toBe('--version');
  });
});

describe('WindowsRestrictedTokenProvider.initialize (honest status)', () => {
  it('reports filesystem partial + network none when the helper is present (on win32)', async () => {
    let writtenJson: string | undefined;
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\helper.exe',
      capabilitySidName: 'cortex-sandbox-install-7',
      fileExists: () => true,
      selfTest: () => ({ ok: true }),
      createPolicyDir: () => POLICY_DIR,
      writePolicyFile: (dir, json) => {
        writtenJson = json;
        return `${dir}\\policy.json`;
      },
      removePolicyDir: () => {},
    });
    const status = await onWin32(() => provider.initialize(windowsWorkspacePolicy()));
    expect(status.backend).toBe('win-restricted-token');
    // 'partial', never 'enforced': Tier 1 confines writes and scrubs credential
    // env vars but cannot deny secret file reads (a same-user WRITE_RESTRICTED
    // token restricts writes only; reads ride the normal token).
    expect(status.filesystem).toBe('partial');
    expect(status.network).toBe('none');
    expect(status.degradations.some((d) => /secret file reads/i.test(d))).toBe(true);
    expect(status.degradations.some((d) => /network/i.test(d))).toBe(true);

    expect(writtenJson).toBeDefined();
    const parsed = JSON.parse(writtenJson as string);
    // The cap SID name is the base plus a stable per-workspace hash.
    expect(parsed.capabilitySidName).toBe(
      deriveWorkspaceCapabilitySidName('cortex-sandbox-install-7', [WS_ROOT]),
    );
    // Default integrity is Medium (Codex parity); Low is opt-in.
    expect(parsed.lowIntegrity).toBe(false);
    // The emitted policy protects its own directory from sandboxed writes.
    expect(parsed.denyWritePaths).toContain(POLICY_DIR);
  });

  it('derives a different capability SID name per workspace', async () => {
    async function capNameFor(root: string): Promise<string> {
      let writtenJson = '';
      const provider = new WindowsRestrictedTokenProvider({
        helperPath: 'h.exe',
        fileExists: () => true,
        selfTest: () => ({ ok: true }),
        createPolicyDir: () => POLICY_DIR,
        writePolicyFile: (_dir, json) => {
          writtenJson = json;
          return 'p.json';
        },
        removePolicyDir: () => {},
      });
      const policy = buildDefaultPolicy('workspace', {
        workspaceRoots: [root],
        home: 'C:\\Users\\dev',
        sessionTmpDir: SBX_TEMP,
      });
      await onWin32(() => provider.initialize(policy));
      return JSON.parse(writtenJson).capabilitySidName as string;
    }
    const a = await capNameFor('C:\\Users\\dev\\workspace-a');
    const b = await capNameFor('C:\\Users\\dev\\workspace-b');
    expect(a).not.toBe(b);
    expect(a).toBe(await capNameFor('C:\\Users\\dev\\workspace-a'));
  });

  it('honors the lowIntegrity opt-in', async () => {
    let writtenJson = '';
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'h.exe',
      fileExists: () => true,
      selfTest: () => ({ ok: true }),
      lowIntegrity: true,
      createPolicyDir: () => POLICY_DIR,
      writePolicyFile: (_dir, json) => {
        writtenJson = json;
        return 'p.json';
      },
      removePolicyDir: () => {},
    });
    await onWin32(() => provider.initialize(windowsWorkspacePolicy()));
    expect(JSON.parse(writtenJson).lowIntegrity).toBe(true);
  });

  it('refuses to enforce when the policy dir is inside a writable root (TOCTOU)', async () => {
    const removed: string[] = [];
    const nestedDir = 'C:\\Users\\dev\\project\\nested-policy';
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'h.exe',
      fileExists: () => true,
      selfTest: () => ({ ok: true }),
      createPolicyDir: () => nestedDir,
      writePolicyFile: () => {
        throw new Error('must not be called: the policy dir is rewritable by the sandbox');
      },
      removePolicyDir: (dir) => removed.push(dir),
    });
    const status = await onWin32(() => provider.initialize(windowsWorkspacePolicy()));
    expect(status.backend).toBe('none');
    expect(status.filesystem).toBe('none');
    expect(status.degradations[0]).toMatch(/inside a writable root/i);
    expect(removed).toEqual([nestedDir]);
  });

  it('reports fully uncontained none when the helper binary is absent (on win32)', async () => {
    const degraded: string[][] = [];
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\missing.exe',
      fileExists: () => false,
      onDegraded: (d) => degraded.push(d),
    });
    const status = await onWin32(() => provider.initialize(windowsWorkspacePolicy()));
    expect(status.backend).toBe('none');
    expect(status.filesystem).toBe('none');
    expect(status.network).toBe('none');
    expect(status.degradations[0]).toMatch(/helper not found/i);
    expect(degraded).toHaveLength(1);
  });

  it('degrades to honest none when the helper is present but the execution preflight fails', async () => {
    // The file exists, but the self-test cannot run it (antivirus quarantine,
    // corrupted binary, or a system policy). The provider must NOT claim
    // `partial` and then fail every command; it reports `none` up front.
    const degraded: string[][] = [];
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\helper.exe',
      fileExists: () => true,
      selfTest: () => ({ ok: false, detail: 'spawn error EACCES' }),
      onDegraded: (d) => degraded.push(d),
      writePolicyFile: () => {
        throw new Error('must not be reached: the helper cannot execute');
      },
    });
    const status = await onWin32(() => provider.initialize(windowsWorkspacePolicy()));
    expect(status.backend).toBe('none');
    expect(status.filesystem).toBe('none');
    expect(status.network).toBe('none');
    // The reason names the most likely cause and how to restore or dismiss it.
    const reason = status.degradations.join(' ');
    expect(reason).toMatch(/antivirus|security software/i);
    expect(reason).toMatch(/cortex-sandbox-helper\.exe/);
    expect(reason).toContain('spawn error EACCES');
    expect(degraded).toHaveLength(1);
  });

  it('runs the execution preflight only after confirming the helper exists', async () => {
    // A missing helper must report "not found", never invoke the self-test.
    let selfTestCalls = 0;
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\missing.exe',
      fileExists: () => false,
      selfTest: () => {
        selfTestCalls += 1;
        return { ok: true };
      },
    });
    const status = await onWin32(() => provider.initialize(windowsWorkspacePolicy()));
    expect(status.backend).toBe('none');
    expect(status.degradations[0]).toMatch(/not found/i);
    expect(selfTestCalls).toBe(0);
  });

  it('reports uncontained none on a non-win32 platform', async () => {
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\helper.exe',
      fileExists: () => true,
      selfTest: () => ({ ok: true }),
    });
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const status = await provider.initialize(windowsWorkspacePolicy());
      expect(status.backend).toBe('none');
      expect(status.degradations[0]).toMatch(/win32-only/i);
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('WindowsRestrictedTokenProvider.wrapSpawn', () => {
  async function enforcingProvider(): Promise<WindowsRestrictedTokenProvider> {
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\helper.exe',
      fileExists: () => true,
      selfTest: () => ({ ok: true }),
      createPolicyDir: () => POLICY_DIR,
      writePolicyFile: () => 'C:\\Temp\\policy.json',
      removePolicyDir: () => {},
    });
    await onWin32(() => provider.initialize(windowsWorkspacePolicy()));
    return provider;
  }

  it('wraps through the helper, scrubs credential env vars, and wires TEMP/TMP to the sandbox temp', async () => {
    const provider = await enforcingProvider();
    const wrapped = await provider.wrapSpawn(spec());
    expect(wrapped.file).toBe('C:\\cortex\\helper.exe');
    expect(wrapped.args[0]).toBe('C:\\Temp\\policy.json');
    expect(wrapped.args[1]).toBe('--');
    // GITHUB_TOKEN is a default credential var, scrubbed from the child.
    expect(wrapped.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(wrapped.env['PATH']).toBe('C:\\Windows\\System32');
    // Child temp writes land in the dedicated (writable) sandbox temp.
    expect(wrapped.env['TEMP']).toBe(SBX_TEMP);
    expect(wrapped.env['TMP']).toBe(SBX_TEMP);
  });

  it('passes the command through unwrapped when not enforcing', async () => {
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\missing.exe',
      fileExists: () => false,
    });
    // No initialize / helper absent => backend none => pass-through.
    const wrapped = await provider.wrapSpawn(spec());
    expect(wrapped.file).toBe(spec().shell);
    expect(wrapped.args).toEqual([...spec().shellArgs, spec().command]);
    expect(wrapped.env).toEqual(spec().env);
  });
});

describe('WindowsRestrictedTokenProvider.notifyWrappedSpawnFailure', () => {
  it('degrades to uncontained and passes subsequent spawns through', async () => {
    const degraded: string[][] = [];
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\helper.exe',
      fileExists: () => true,
      selfTest: () => ({ ok: true }),
      createPolicyDir: () => POLICY_DIR,
      writePolicyFile: () => 'C:\\Temp\\policy.json',
      removePolicyDir: () => {},
      onDegraded: (d) => degraded.push(d),
    });
    const before = await onWin32(() => provider.initialize(windowsWorkspacePolicy()));
    expect(before.backend).toBe('win-restricted-token');
    degraded.length = 0;

    provider.notifyWrappedSpawnFailure({ code: 'ENOENT', message: 'spawn ENOENT' });

    const after = provider.status();
    expect(after.backend).toBe('none');
    expect(after.filesystem).toBe('none');
    expect(after.degradations.join(' ')).toMatch(/failed to launch|antivirus|ENOENT/i);
    expect(degraded).toHaveLength(1);

    // Subsequent spawns are no longer wrapped — the command still runs.
    const wrapped = await provider.wrapSpawn(spec());
    expect(wrapped.file).toBe(spec().shell);
    expect(wrapped.args).toEqual([...spec().shellArgs, spec().command]);
  });

  it('is a no-op when already uncontained', () => {
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'C:\\cortex\\missing.exe',
      fileExists: () => false,
    });
    // Never initialized to an enforcing state; must not throw or fire onDegraded.
    expect(() =>
      provider.notifyWrappedSpawnFailure({ code: 'ENOENT', message: 'spawn ENOENT' }),
    ).not.toThrow();
    expect(provider.status().backend).toBe('none');
  });
});

describe('WindowsRestrictedTokenProvider.classifyFailure', () => {
  async function enforcing(): Promise<WindowsRestrictedTokenProvider> {
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'h.exe',
      fileExists: () => true,
      selfTest: () => ({ ok: true }),
      createPolicyDir: () => POLICY_DIR,
      writePolicyFile: () => 'p.json',
      removePolicyDir: () => {},
    });
    await onWin32(() => provider.initialize(windowsWorkspacePolicy()));
    return provider;
  }

  it('attributes an access-denied stderr to a filesystem-write denial', async () => {
    const provider = await enforcing();
    const denial = provider.classifyFailure({
      command: 'echo x > C:\\Windows\\y.txt',
      exitCode: 1,
      stderr: 'Access is denied.',
      stdout: '',
    });
    expect(denial?.dimension).toBe('filesystem-write');
    expect(denial?.escalatable).toBe(true);
  });

  it('returns null for a clean exit and for unrelated stderr', async () => {
    const provider = await enforcing();
    expect(
      provider.classifyFailure({ command: 'x', exitCode: 0, stderr: 'Access is denied.', stdout: '' }),
    ).toBeNull();
    expect(
      provider.classifyFailure({ command: 'x', exitCode: 1, stderr: 'command not found', stdout: '' }),
    ).toBeNull();
  });
});

describe('runHelperSelfTest', () => {
  const helperPresent = process.platform === 'win32' && existsSync(defaultHelperPath());

  it.skipIf(!helperPresent)('reports ok for the real bundled helper', () => {
    const result = runHelperSelfTest(defaultHelperPath());
    expect(result.ok).toBe(true);
  });

  it('reports not-ok with a detail when the helper path does not exist', () => {
    const result = runHelperSelfTest('C:\\definitely\\not\\here\\cortex-sandbox-helper.exe');
    expect(result.ok).toBe(false);
    expect(result.detail && result.detail.length).toBeGreaterThan(0);
  });

  it('keeps the ok sentinel in lockstep with the helper', () => {
    // If this constant drifts from SELFTEST_OK_SENTINEL in main.rs, the preflight
    // silently starts failing for a healthy helper. Pin it.
    expect(WINDOWS_HELPER_SELFTEST_OK).toBe('cortex-sandbox-helper[selftest]: ok');
  });
});

describe('isHelperSetupFailure', () => {
  it('is true only when the setup-failure exit code AND the stderr sentinel are both present', () => {
    expect(
      isHelperSetupFailure({
        exitCode: WINDOWS_HELPER_SETUP_FAILURE_EXIT,
        stderr: `${WINDOWS_HELPER_SETUP_FAILURE_SENTINEL} create restricted token: boom`,
      }),
    ).toBe(true);
  });

  it('is false for a real child that merely exits 87 without the sentinel', () => {
    expect(
      isHelperSetupFailure({ exitCode: WINDOWS_HELPER_SETUP_FAILURE_EXIT, stderr: 'my tool exited 87' }),
    ).toBe(false);
  });

  it('is false when the sentinel is present but the exit code is not the setup-failure code', () => {
    // Defense in depth: the sentinel is the authoritative signal, but a non-87
    // exit means the helper did not take the setup-failure path.
    expect(
      isHelperSetupFailure({ exitCode: 1, stderr: WINDOWS_HELPER_SETUP_FAILURE_SENTINEL }),
    ).toBe(false);
  });

  it('is false for a normal successful/failed command', () => {
    expect(isHelperSetupFailure({ exitCode: 0, stderr: '' })).toBe(false);
    expect(isHelperSetupFailure({ exitCode: 2, stderr: 'error: bad regex' })).toBe(false);
  });
});

describe('WindowsRestrictedTokenProvider capability SID default', () => {
  it('derives the capability SID name from the default base when the consumer omits it', async () => {
    let writtenJson = '';
    const provider = new WindowsRestrictedTokenProvider({
      helperPath: 'h.exe',
      fileExists: () => true,
      selfTest: () => ({ ok: true }),
      createPolicyDir: () => POLICY_DIR,
      writePolicyFile: (_dir, json) => {
        writtenJson = json;
        return 'p.json';
      },
      removePolicyDir: () => {},
    });
    await onWin32(() => provider.initialize(windowsWorkspacePolicy()));
    expect(JSON.parse(writtenJson).capabilitySidName).toBe(
      deriveWorkspaceCapabilitySidName(DEFAULT_CAPABILITY_SID_NAME, [WS_ROOT]),
    );
  });
});
