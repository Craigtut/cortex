import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createGrepTool } from '../../../src/tools/grep.js';
import type {
  SandboxProvider,
  SandboxExecSpec,
  SandboxStatus,
  WrappedSpawn,
} from '../../../src/sandbox/types.js';

// A provider whose wrapExec RECORDS the spec and returns the invocation
// UNCHANGED, so the real bundled ripgrep still runs and stdout parsing is
// exercised end to end. The Grep tool only ever calls wrapExec; the remaining
// members are no-op stubs to satisfy the SandboxProvider contract.
function makeRecordingProvider(overrides?: {
  wrapExec?: SandboxProvider['wrapExec'];
}): { provider: SandboxProvider; calls: SandboxExecSpec[] } {
  const calls: SandboxExecSpec[] = [];
  const provider: SandboxProvider = {
    async initialize() {
      return { filesystem: 'enforced', network: 'enforced', backend: 'seatbelt', degradations: [] };
    },
    async wrapSpawn(spec) {
      return { file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env };
    },
    wrapExec:
      overrides && 'wrapExec' in overrides
        ? overrides.wrapExec
        : async (spec: SandboxExecSpec): Promise<WrappedSpawn> => {
            calls.push(spec);
            return { file: spec.file, args: spec.args, env: spec.env };
          },
    async dispose() {},
  };
  return { provider, calls };
}

const readText = (result: { content: Array<{ type: string }> }): string =>
  (result.content[0] as { type: 'text'; text: string }).text;

const ENFORCED: SandboxStatus = {
  filesystem: 'enforced',
  network: 'enforced',
  backend: 'seatbelt',
  degradations: [],
};
const NONE: SandboxStatus = {
  filesystem: 'none',
  network: 'none',
  backend: 'none',
  degradations: [],
};

/**
 * A provider whose wrapExec maps every invocation to a process that exits 2 with
 * empty stdout, exactly how Seatbelt/bwrap surface a denied read to ripgrep.
 * `process.execPath` keeps it cross-platform. `status` sets the reported
 * enforcement so a test can pick contained vs uncontained behavior.
 */
function denyingProvider(status: SandboxStatus): SandboxProvider {
  return {
    async initialize() {
      return status;
    },
    status() {
      return status;
    },
    async wrapSpawn(spec) {
      return { file: spec.shell, args: [...spec.shellArgs, spec.command], env: spec.env };
    },
    async wrapExec(spec: SandboxExecSpec): Promise<WrappedSpawn> {
      return { file: process.execPath, args: ['-e', 'process.exit(2)'], env: spec.env };
    },
    async dispose() {},
  };
}

describe('Grep tool sandbox routing', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-grep-sbx-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes ripgrep through wrapExec when a provider is present', async () => {
    fs.writeFileSync(path.join(tmpDir, 'match.ts'), 'hello world\n');
    fs.writeFileSync(path.join(tmpDir, 'nomatch.ts'), 'goodbye\n');

    const { provider, calls } = makeRecordingProvider();
    const grep = createGrepTool({ defaultCwd: tmpDir, sandbox: provider });

    const result = await grep.execute({ pattern: 'hello' });

    // The spawn went through the sandbox seam...
    expect(calls).toHaveLength(1);
    const spec = calls[0]!;
    // ...wrapping the bundled ripgrep binary with the search pattern as an arg.
    expect(spec.file).toMatch(/\brg(\.exe)?$/);
    expect(spec.args).toContain('hello');
    // ...and the results are still parsed identically (the wrapper ran rg).
    const text = readText(result);
    expect(text).toContain('match.ts');
    expect(text).not.toContain('nomatch.ts');
    expect(result.details.usingFallback).toBe(false);
  });

  it('passes wrapExec a sanitized env (dangerous vars stripped, PATH kept)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'needle\n');

    const prevLd = process.env['LD_PRELOAD'];
    process.env['LD_PRELOAD'] = '/tmp/evil.so';
    try {
      const { provider, calls } = makeRecordingProvider();
      const grep = createGrepTool({ defaultCwd: tmpDir, sandbox: provider });

      await grep.execute({ pattern: 'needle' });

      expect(calls).toHaveLength(1);
      const env = calls[0]!.env;
      // buildSafeEnv strips loader-injection vars but keeps ordinary ones.
      expect(env['LD_PRELOAD']).toBeUndefined();
      expect(env['PATH']).toBe(process.env['PATH']);
    } finally {
      if (prevLd === undefined) delete process.env['LD_PRELOAD'];
      else process.env['LD_PRELOAD'] = prevLd;
    }
  });

  it('runs ripgrep raw (no wrapExec) when no provider is configured', async () => {
    fs.writeFileSync(path.join(tmpDir, 'match.ts'), 'hello world\n');

    const grep = createGrepTool({ defaultCwd: tmpDir });
    const result = await grep.execute({ pattern: 'hello' });

    const text = readText(result);
    expect(text).toContain('match.ts');
    expect(result.details.usingFallback).toBe(false);
  });

  it('runs ripgrep raw when the provider does not implement wrapExec', async () => {
    fs.writeFileSync(path.join(tmpDir, 'match.ts'), 'hello world\n');

    // A custom provider that omits wrapExec must not change behavior: the
    // `sandbox?.wrapExec` guard falls through to a raw run.
    const { provider } = makeRecordingProvider({ wrapExec: undefined });
    const grep = createGrepTool({ defaultCwd: tmpDir, sandbox: provider });

    const result = await grep.execute({ pattern: 'hello' });

    const text = readText(result);
    expect(text).toContain('match.ts');
    expect(result.details.usingFallback).toBe(false);
  });

  it('does not fall back to an in-process read when a sandboxed ripgrep read is denied', async () => {
    // The regression this guards: a kernel-denied ripgrep read (exit 2) used to
    // throw, the tool swallowed it, and the pure-JS fallback then fs.readFile'd
    // the same path uncontained, returning the secret the sandbox just blocked.
    const secret = path.join(tmpDir, 'credentials');
    fs.writeFileSync(secret, 'aws_secret = SUPERSECRET_AKIA_DO_NOT_LEAK\n');

    const grep = createGrepTool({ defaultCwd: tmpDir, sandbox: denyingProvider(ENFORCED) });
    const result = await grep.execute({
      pattern: 'SUPERSECRET_AKIA_DO_NOT_LEAK',
      path: secret,
      output_mode: 'content',
    });

    const text = readText(result);
    expect(text).not.toContain('SUPERSECRET_AKIA_DO_NOT_LEAK'); // the secret never leaks
    expect(result.details.usingFallback).toBe(false); // the in-process JS path never ran
  });

  it('still falls back to JS on a ripgrep failure when filesystem is not enforced', async () => {
    // Guard the other direction: without filesystem enforcement, a ripgrep
    // failure must still fall back to the JS engine (the resilience the fix
    // disables only under containment).
    const file = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(file, 'token FINDME_UNCONTAINED here\n');

    const grep = createGrepTool({ defaultCwd: tmpDir, sandbox: denyingProvider(NONE) });
    const result = await grep.execute({
      pattern: 'FINDME_UNCONTAINED',
      path: file,
      output_mode: 'content',
    });

    const text = readText(result);
    expect(text).toContain('FINDME_UNCONTAINED'); // JS fallback read the file and matched
    expect(result.details.usingFallback).toBe(true);
  });
});
