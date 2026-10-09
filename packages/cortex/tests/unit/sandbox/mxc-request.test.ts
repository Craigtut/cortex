import { describe, expect, it } from 'vitest';
import {
  MXC_LOOPBACK_RULE,
  buildMxcFilesystem,
  buildMxcNetwork,
  buildMxcRequestBase,
  decideProxyRequest,
  isWindowsPathWithin,
  proxyEnvironment,
  quoteWindowsArg,
  setWindowsEnv,
  windowsCommandLine,
  type MxcRequestInputs,
} from '../../../src/sandbox/backends/mxc-request.js';
import type { SandboxNetworkPolicy, SandboxPolicy } from '../../../src/sandbox/types.js';

// Pure policy translation: no Windows host and no SDK needed.

const WS = 'C:\\Users\\dev\\project';
const TMP = 'C:\\Users\\dev\\AppData\\Local\\Temp\\cortex-sbx-1';

function policy(overrides: Partial<SandboxPolicy['filesystem']> = {}, network?: Partial<SandboxNetworkPolicy>): SandboxPolicy {
  return {
    rung: 'workspace',
    filesystem: {
      writableRoots: [WS, TMP],
      denyRead: ['C:\\Users\\dev\\.ssh', 'C:\\Users\\dev\\.aws'],
      denyWrite: [`${WS}\\.git\\hooks`, `${WS}\\.git\\config`, 'C:\\Users\\dev\\.gitconfig'],
      sessionTmpDir: TMP,
      ...overrides,
    },
    network: { mode: 'allowlist', allowedDomains: ['registry.npmjs.org', '*.github.com'], deniedDomains: [], allowLocalBinding: true, ...network },
  };
}

function inputs(p: SandboxPolicy, extra: Partial<MxcRequestInputs> = {}): MxcRequestInputs {
  return {
    policy: p,
    readSet: { volumeEntries: ['C:\\', 'C:\\Users', 'C:\\Program Files', 'D:\\', 'D:\\data'], platformRoots: ['C:\\Windows', 'C:\\ProgramData'] },
    existingDenyRead: ['C:\\Users\\dev\\.ssh'],
    hostCodePaths: ['C:\\Program Files\\nodejs', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@microsoft\\mxc-sdk'],
    ...extra,
  };
}

/**
 * CommandLineToArgvW for arguments after the program name (msvcrt 2008+
 * rules), used to prove quoting round-trips rather than to match strings.
 */
function parseWindowsArgs(commandLine: string): string[] {
  const args: string[] = [];
  let i = 0;
  const n = commandLine.length;
  while (i < n) {
    while (i < n && (commandLine[i] === ' ' || commandLine[i] === '\t')) i++;
    if (i >= n) break;
    let arg = '';
    let inQuotes = false;
    while (i < n) {
      const ch = commandLine[i]!;
      if (!inQuotes && (ch === ' ' || ch === '\t')) break;
      if (ch === '\\') {
        let count = 0;
        while (commandLine[i] === '\\') { count++; i++; }
        if (commandLine[i] === '"') {
          arg += '\\'.repeat(Math.floor(count / 2));
          if (count % 2 === 1) { arg += '"'; i++; }
        } else {
          arg += '\\'.repeat(count);
        }
        continue;
      }
      if (ch === '"') {
        if (inQuotes && commandLine[i + 1] === '"') { arg += '"'; i += 2; continue; }
        inQuotes = !inQuotes;
        i++;
        continue;
      }
      arg += ch;
      i++;
    }
    args.push(arg);
  }
  return args;
}

describe('quoteWindowsArg (libuv quote_cmd_arg parity)', () => {
  it.each([
    ['', '""'],
    ['plain', 'plain'],
    ['a b', '"a b"'],
    ['hello"world', '"hello\\"world"'],
    ['hello""world', '"hello\\"\\"world"'],
    ['hello\\world', 'hello\\world'],
    ['hello\\\\world', 'hello\\\\world'],
    ['hello\\"world', '"hello\\\\\\"world"'],
    ['hello\\\\"world', '"hello\\\\\\\\\\"world"'],
    ['hello world\\', '"hello world\\\\"'],
    ['C:\\Program Files\\x.exe', '"C:\\Program Files\\x.exe"'],
  ])('quotes %j as %j', (input, expected) => {
    expect(quoteWindowsArg(input)).toBe(expected);
  });

  it('round-trips arbitrary arguments through CommandLineToArgvW rules', () => {
    const alphabet = ['a', 'Z', ' ', '\t', '"', '\\', '$', '&', '|', '%', 'é', '😀'];
    let seed = 7;
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let trial = 0; trial < 500; trial++) {
      const args = Array.from({ length: 1 + (next() % 4) }, () =>
        Array.from({ length: next() % 9 }, () => alphabet[next() % alphabet.length]).join(''),
      );
      const line = windowsCommandLine(['prog.exe', ...args]);
      expect(parseWindowsArgs(line).slice(1)).toEqual(args);
    }
  });

  it('builds the PowerShell command line Node would build', () => {
    expect(windowsCommandLine(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-NoProfile', '-Command', 'echo "hi"'])).toBe(
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -Command "echo \\"hi\\""',
    );
    expect(() => windowsCommandLine([])).toThrow();
  });
});

describe('isWindowsPathWithin', () => {
  it('compares case-insensitively across separator styles, without prefix confusion', () => {
    expect(isWindowsPathWithin('c:/users/DEV/project/src', WS)).toBe(true);
    expect(isWindowsPathWithin(WS, WS + '\\')).toBe(true);
    expect(isWindowsPathWithin('C:\\Users\\dev\\project-other', WS)).toBe(false);
    expect(isWindowsPathWithin('C:\\anything', 'C:\\')).toBe(true);
  });
});

describe('buildMxcFilesystem', () => {
  it('grants writes to the writable roots and denies the existing secrets', () => {
    const fs = buildMxcFilesystem(inputs(policy()));
    expect(fs.readwritePaths).toEqual([WS, TMP]);
    expect(fs.deniedPaths).toEqual(['C:\\Users\\dev\\.ssh']);
  });

  it('reads through the volume snapshot and platform roots', () => {
    const fs = buildMxcFilesystem(inputs(policy()));
    expect(fs.readonlyPaths).toEqual(expect.arrayContaining(['C:\\', 'C:\\Users', 'D:\\data', 'C:\\Windows', 'C:\\ProgramData']));
  });

  it('carves denyWrite entries inside writable roots out read-only, including missing ones', () => {
    const fs = buildMxcFilesystem(inputs(policy()));
    expect(fs.readonlyPaths).toEqual(expect.arrayContaining([`${WS}\\.git\\hooks`, `${WS}\\.git\\config`]));
    // Outside every writable root it is already read-only through the read set.
    expect(fs.readonlyPaths).not.toContain('C:\\Users\\dev\\.gitconfig');
  });

  it('carves host-side code out read-only only when it sits inside a writable root', () => {
    const sdkInWorkspace = `${WS}\\node_modules\\@microsoft\\mxc-sdk`;
    const fs = buildMxcFilesystem(inputs(policy(), { hostCodePaths: [sdkInWorkspace, 'C:\\Program Files\\nodejs'] }));
    expect(fs.readonlyPaths).toContain(sdkInWorkspace);
    expect(fs.readonlyPaths).not.toContain('C:\\Program Files\\nodejs');
  });

  it('drops a writable root inside a denied path and carve-outs under denied paths', () => {
    const p = policy({ writableRoots: [WS, 'C:\\Users\\dev\\.ssh\\scratch'], denyWrite: ['C:\\Users\\dev\\.ssh\\scratch\\x'] });
    const fs = buildMxcFilesystem(inputs(p));
    expect(fs.readwritePaths).toEqual([WS]);
    expect(fs.readonlyPaths).not.toContain('C:\\Users\\dev\\.ssh\\scratch\\x');
  });

  it('removes read entries that duplicate a writable root or a denied path', () => {
    const p = policy({ writableRoots: ['D:\\data'] });
    const fs = buildMxcFilesystem(inputs(p, { existingDenyRead: ['C:\\Program Files'] }));
    expect(fs.readwritePaths).toEqual(['D:\\data']);
    expect(fs.readonlyPaths).not.toContain('D:\\data');
    expect(fs.readonlyPaths).not.toContain('C:\\Program Files');
  });

  it('adds allowRead entries to the read set and de-duplicates case-insensitively', () => {
    const p = policy({ allowRead: ['C:\\Users\\dev\\.ssh\\known_hosts', 'c:\\windows'] });
    const fs = buildMxcFilesystem(inputs(p));
    expect(fs.readonlyPaths).toContain('C:\\Users\\dev\\.ssh\\known_hosts');
    expect(fs.readonlyPaths.filter((x) => x.toLowerCase() === 'c:\\windows')).toHaveLength(1);
  });
});

describe('buildMxcNetwork', () => {
  it('routes allowlist egress through the proxy over loopback, denying everything else', () => {
    const { network, usesProxy, notes } = buildMxcNetwork(policy().network);
    expect(usesProxy).toBe(true);
    expect(notes).toEqual([]);
    expect(network.egress).toEqual({ default: 'deny', allow: [MXC_LOOPBACK_RULE] });
    expect(network.ingress).toEqual({ default: 'deny', hostLoopback: 'allow' });
    expect(MXC_LOOPBACK_RULE.to).toEqual([{ cidr: '127.0.0.0/8' }, { cidr: '::1/128' }]);
  });

  it('uses the proxy for full mode too, so denied domains still apply', () => {
    expect(buildMxcNetwork(policy({}, { mode: 'full' }).network).usesProxy).toBe(true);
  });

  it('denies all egress in deny mode, keeping loopback only when local binding is allowed', () => {
    const open = buildMxcNetwork(policy({}, { mode: 'deny' }).network);
    expect(open.usesProxy).toBe(false);
    expect(open.network.ingress.hostLoopback).toBe('allow');
    const closed = buildMxcNetwork(policy({}, { mode: 'deny', allowLocalBinding: false }).network);
    expect(closed.network).toEqual({ egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } });
  });

  it('blocks all egress, and says so, when allowlist mode forbids local binding', () => {
    const { network, usesProxy, notes } = buildMxcNetwork(policy({}, { allowLocalBinding: false }).network);
    expect(usesProxy).toBe(false);
    expect(network.egress.allow).toBeUndefined();
    expect(network.ingress.hostLoopback).toBe('deny');
    expect(notes[0]).toMatch(/fully blocked/);
  });
});

describe('buildMxcRequestBase', () => {
  it('pins the processcontainer backend with desktop UI isolation and no clipboard', () => {
    const { request } = buildMxcRequestBase(inputs(policy()));
    expect(request.containment).toEqual({
      type: 'processcontainer',
      config: { ui: { isolation: 'desktop', desktopSystemControl: false, systemSettings: 'none', ime: false } },
    });
    expect(request.ui).toEqual({ disable: false, clipboard: 'none', allowInputInjection: false });
  });

  it('requires the native capabilities the request depends on', () => {
    expect(buildMxcRequestBase(inputs(policy())).requiredCapabilities).toEqual(['filesystemDeniedPaths', 'ingressHostLoopbackAllow']);
    const bare = buildMxcRequestBase(inputs(policy({}, { mode: 'deny', allowLocalBinding: false }), { existingDenyRead: [] }));
    expect(bare.requiredCapabilities).toEqual([]);
  });
});

describe('decideProxyRequest', () => {
  const net = policy().network;
  it('allows allowlisted hosts, case-insensitively and with a trailing dot', () => {
    expect(decideProxyRequest(net, 'REGISTRY.npmjs.org.')).toBe('allow');
    expect(decideProxyRequest(net, 'api.github.com')).toBe('allow');
  });
  it('asks about unlisted hosts in allowlist mode', () => {
    expect(decideProxyRequest(net, 'example.com')).toBe('ask');
    expect(decideProxyRequest({ ...net, allowedDomains: ['*'] }, 'example.com')).toBe('ask');
  });
  it('applies explicit denials before full mode and denies everything in deny mode', () => {
    expect(decideProxyRequest({ ...net, mode: 'full', deniedDomains: ['evil.com'] }, 'evil.com')).toBe('deny');
    expect(decideProxyRequest({ ...net, mode: 'full' }, 'example.com')).toBe('allow');
    expect(decideProxyRequest({ ...net, mode: 'deny' }, 'registry.npmjs.org')).toBe('deny');
  });
});

describe('Windows environment helpers', () => {
  it('replaces a differently-cased variable instead of duplicating it', () => {
    const env: Record<string, string> = { http_proxy: 'http://old', Path: 'C:\\x' };
    setWindowsEnv(env, 'HTTP_PROXY', 'http://new');
    expect(env).toEqual({ HTTP_PROXY: 'http://new', Path: 'C:\\x' });
  });

  it('sets one spelling of each proxy variable and bypasses loopback', () => {
    const env = proxyEnvironment('http://127.0.0.1:9');
    expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:9');
    expect(env['NO_PROXY']).toContain('127.0.0.1');
    const upper = Object.keys(env).map((k) => k.toUpperCase());
    expect(new Set(upper).size).toBe(upper.length);
  });
});
