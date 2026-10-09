import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  preprocessSkillBody,
  substituteVariables,
  executeShellCommand,
} from '../../src/skill-preprocessor.js';
import { selectShell } from '../../src/tools/bash/shell.js';
import type { SandboxProvider, SandboxSpawnSpec } from '../../src/sandbox/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-preprocessor-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// substituteVariables tests
// ---------------------------------------------------------------------------

describe('substituteVariables', () => {
  it('substitutes ${VAR} references', () => {
    const result = substituteVariables(
      'Hello ${NAME}, welcome to ${PLACE}.',
      { NAME: 'Craig', PLACE: 'Animus' },
    );
    expect(result).toBe('Hello Craig, welcome to Animus.');
  });

  it('substitutes $ARGUMENTS', () => {
    const result = substituteVariables(
      'Args: $ARGUMENTS',
      { ARGUMENTS: 'hello world' },
    );
    expect(result).toBe('Args: hello world');
  });

  it('substitutes positional $1..$9', () => {
    const result = substituteVariables(
      'First: $1, Second: $2, Third: $3',
      { '1': 'a', '2': 'b', '3': 'c' },
    );
    expect(result).toBe('First: a, Second: b, Third: c');
  });

  it('replaces undefined variables with empty string', () => {
    const result = substituteVariables(
      'Value: ${MISSING}',
      {},
    );
    expect(result).toBe('Value: ');
  });

  it('handles multiple occurrences of the same variable', () => {
    const result = substituteVariables(
      '${X} and ${X} again',
      { X: 'test' },
    );
    expect(result).toBe('test and test again');
  });

  it('does not substitute inside unrelated patterns', () => {
    const result = substituteVariables(
      'Code: `${notAVar}` stays as-is',
      {},
    );
    // ${notAVar} uses valid variable name chars, so it does get substituted
    expect(result).toBe('Code: `` stays as-is');
  });
});

// ---------------------------------------------------------------------------
// executeShellCommand tests
// ---------------------------------------------------------------------------

describe('executeShellCommand', () => {
  it('executes a simple command and returns stdout', async () => {
    const result = await executeShellCommand('echo "hello world"', tmpDir);
    expect(result).toBe('hello world');
  });

  it('returns error marker for failing commands', async () => {
    const result = await executeShellCommand('exit 1', tmpDir);
    expect(result).toMatch(/\[Error: command failed with exit code/);
  });

  it('uses the skill directory as cwd', async () => {
    // Create a file in tmpDir and cat it
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'file content');
    const result = await executeShellCommand('cat test.txt', tmpDir);
    expect(result).toBe('file content');
  });

  it('sanitizes the environment (strips injection vectors like NODE_OPTIONS)', async () => {
    const prev = process.env['NODE_OPTIONS'];
    process.env['NODE_OPTIONS'] = '--inspect=0';
    try {
      const result = await executeShellCommand('echo "opt=[${NODE_OPTIONS}]"', tmpDir);
      expect(result).toBe('opt=[]');
    } finally {
      if (prev === undefined) delete process.env['NODE_OPTIONS'];
      else process.env['NODE_OPTIONS'] = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// preprocessSkillBody integration tests
// ---------------------------------------------------------------------------

describe('preprocessSkillBody', () => {
  it('runs variable substitution before shell commands', async () => {
    const body = 'Agent: ${AGENT_NAME}\nVersion: ${VERSION}';

    const result = await preprocessSkillBody(body, {
      variables: { AGENT_NAME: 'Animus', VERSION: '1.0' },
      scriptContext: {},
      skillDir: tmpDir,
    });

    expect(result).toBe('Agent: Animus\nVersion: 1.0');
  });

  it('processes shell commands', async () => {
    const body = '## Status\n!`echo "ok"`\n\n## Done';

    const result = await preprocessSkillBody(body, {
      variables: {},
      scriptContext: {},
      skillDir: tmpDir,
    });

    expect(result).toContain('ok');
    expect(result).toContain('## Done');
  });

  it('handles shell command failures gracefully', async () => {
    const body = '## Result\n!`nonexistent_command_xyz123`\n\nDone.';

    const result = await preprocessSkillBody(body, {
      variables: {},
      scriptContext: {},
      skillDir: tmpDir,
    });

    expect(result).toContain('[Error:');
    expect(result).toContain('Done.');
  });

  it('processes script markers', async () => {
    // Create a test script
    const scriptDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'test.mjs');
    fs.writeFileSync(scriptPath, `
export default async function(ctx) {
  return 'Hello from script: ' + ctx.skillDir;
}
`);

    const body = '!{script: scripts/test.mjs}';

    const result = await preprocessSkillBody(body, {
      variables: {},
      scriptContext: {},
      skillDir: tmpDir,
    });

    expect(result).toContain('Hello from script:');
    expect(result).toContain(tmpDir);
  });

  it('handles script failures gracefully', async () => {
    const scriptDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'failing.mjs');
    fs.writeFileSync(scriptPath, `
export default async function(ctx) {
  throw new Error('deliberate failure');
}
`);

    const body = '!{script: scripts/failing.mjs}';

    const result = await preprocessSkillBody(body, {
      variables: {},
      scriptContext: {},
      skillDir: tmpDir,
    });

    expect(result).toContain('[Error: script failed: deliberate failure]');
  });

  it('passes script args from the marker syntax', async () => {
    const scriptDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'args.mjs');
    fs.writeFileSync(scriptPath, `
export default async function(ctx) {
  return 'limit=' + ctx.scriptArgs.limit;
}
`);

    const body = '!{script: scripts/args.mjs, limit: 5}';

    const result = await preprocessSkillBody(body, {
      variables: {},
      scriptContext: {},
      skillDir: tmpDir,
    });

    expect(result).toContain('limit=5');
  });

  it('merges consumer script context', async () => {
    const scriptDir = path.join(tmpDir, 'scripts');
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'ctx.mjs');
    fs.writeFileSync(scriptPath, `
export default async function(ctx) {
  return 'contact=' + ctx.contactName;
}
`);

    const body = '!{script: scripts/ctx.mjs}';

    const result = await preprocessSkillBody(body, {
      variables: {},
      scriptContext: { contactName: 'Craig' },
      skillDir: tmpDir,
    });

    expect(result).toContain('contact=Craig');
  });

  it('runs shell commands and scripts in parallel', async () => {
    // Both should complete
    const body = '!`echo "cmd1"`\n!`echo "cmd2"`';

    const result = await preprocessSkillBody(body, {
      variables: {},
      scriptContext: {},
      skillDir: tmpDir,
    });

    expect(result).toContain('cmd1');
    expect(result).toContain('cmd2');
  });

  it('combines all three preprocessor types', async () => {
    const body = `Agent: \${AGENT_NAME}
Status: !` + '`echo "running"`' + `
Args: $ARGUMENTS`;

    const result = await preprocessSkillBody(body, {
      variables: { AGENT_NAME: 'Test', ARGUMENTS: 'arg1 arg2' },
      scriptContext: {},
      skillDir: tmpDir,
    });

    expect(result).toContain('Agent: Test');
    expect(result).toContain('running');
    expect(result).toContain('Args: arg1 arg2');
  });
});

// ---------------------------------------------------------------------------
// Shell markers under an OS sandbox provider
// ---------------------------------------------------------------------------

describe('shell markers with a sandbox provider', () => {
  /** A provider whose wrapped spawn runs a different command, so output shows which spawn ran. */
  function recordingProvider(): { provider: SandboxProvider; specs: SandboxSpawnSpec[] } {
    const specs: SandboxSpawnSpec[] = [];
    const provider: SandboxProvider = {
      initialize: async () => {
        throw new Error('not used');
      },
      dispose: async () => {},
      wrapSpawn: async (spec) => {
        specs.push(spec);
        return { file: spec.shell, args: [...spec.shellArgs, 'echo contained'], env: spec.env };
      },
    };
    return { provider, specs };
  }

  it('launches the marker through the provider-wrapped spawn', async () => {
    // Precondition: without a provider the marker runs its own command.
    const bare = await preprocessSkillBody('!`echo raw`', { variables: {}, scriptContext: {}, skillDir: tmpDir });
    expect(bare).toBe('raw');

    const { provider, specs } = recordingProvider();
    const result = await preprocessSkillBody('!`echo raw`', {
      variables: {},
      scriptContext: {},
      skillDir: tmpDir,
      sandbox: provider,
    });

    expect(result).toBe('contained');
    expect(specs).toHaveLength(1);
    const shell = selectShell();
    expect(specs[0]).toMatchObject({ command: 'echo raw', cwd: tmpDir, shell: shell.shell, shellArgs: shell.args });
  });

  it('wraps quoted argument values exactly as the shell would receive them', async () => {
    const { provider, specs } = recordingProvider();
    await preprocessSkillBody('!`cat $1`', {
      variables: { '1': '; echo pwned' },
      scriptContext: {},
      skillDir: tmpDir,
      sandbox: provider,
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.command).toBe("cat '; echo pwned'");
  });

  it('does not run the command uncontained when the provider cannot wrap it', async () => {
    const provider: SandboxProvider = {
      initialize: async () => {
        throw new Error('not used');
      },
      dispose: async () => {},
      wrapSpawn: async () => {
        throw new Error('profile generation failed');
      },
    };
    const result = await preprocessSkillBody('!`echo raw`', {
      variables: {},
      scriptContext: {},
      skillDir: tmpDir,
      sandbox: provider,
    });
    expect(result).toMatch(/^\[Error: .*profile generation failed\]$/);
  });
});
