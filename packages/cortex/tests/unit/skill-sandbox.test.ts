/**
 * Skill shell markers (!`cmd`) run inside the loop's OS sandbox, the same
 * boundary as the Bash tool. The first suite proves an AgentLoop hands its
 * provider to the skill preprocessor; the second drives a REAL provider and
 * shows a denyRead secret stays unreadable through a marker whose argument
 * the model controls.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';
import { preprocessSkillBody } from '../../src/skill-preprocessor.js';
import type { SandboxProvider, SandboxSpawnSpec } from '../../src/sandbox/types.js';
import { SandboxRuntimeProvider, buildDefaultPolicy } from '../../src/sandbox/index.js';

function createPiAgent(): PiAgent {
  const agent = {
    state: { messages: [], systemPrompt: '', tools: [] },
    subscribe(_handler: (event: PiEvent) => void): () => void {
      return () => {};
    },
    async prompt(): Promise<unknown> {
      return undefined;
    },
    async continue(): Promise<unknown> {
      return undefined;
    },
    steer(): void {},
    abort(): void {},
    async waitForIdle(): Promise<void> {},
    reset(): void {
      agent.state.messages = [];
    },
  };
  return agent as unknown as PiAgent;
}

function createLoop(workingDirectory: string, sandbox?: SandboxProvider): AgentLoop {
  const raw = { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel;
  const config: AgentLoopConfig = {
    model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
    workingDirectory,
    initialBasePrompt: 'Test base prompt',
    slots: [],
    ...(sandbox ? { sandbox } : {}),
  };
  return new (AgentLoop as unknown as new (agent: PiAgent, config: AgentLoopConfig) => AgentLoop)(
    createPiAgent(),
    config,
  );
}

function writeSkill(dir: string, name: string, body: string): string {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillPath, `---\nname: ${name}\ndescription: test skill\n---\n${body}\n`);
  return skillPath;
}

describe("an AgentLoop's skill markers and its sandbox provider", () => {
  it("runs load_skill shell markers through the loop's provider", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-skill-sandbox-'));
    try {
      const skillPath = writeSkill(root, 'status', '!`echo raw`');
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

      // Precondition: a loop without a provider runs the marker's own command.
      const bare = createLoop(root);
      bare.getSkillRegistry().addSkill({ path: skillPath, source: 'test' });
      await bare.loadSkill('status');
      expect(bare.getSkillBuffer()[0]!.content).toContain('raw');
      bare.destroy();

      const loop = createLoop(root, provider);
      loop.getSkillRegistry().addSkill({ path: skillPath, source: 'test' });
      await loop.loadSkill('status');

      expect(specs).toHaveLength(1);
      expect(specs[0]).toMatchObject({ command: 'echo raw', cwd: path.dirname(skillPath) });
      const content = loop.getSkillBuffer()[0]!.content;
      expect(content).toContain('contained');
      expect(content).not.toContain('raw');
      loop.destroy();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

const ENFORCEABLE = process.platform === 'darwin' || process.platform === 'linux';

describe.skipIf(!ENFORCEABLE)('skill shell markers against a real OS sandbox', () => {
  it('cannot read a denyRead secret through a model-supplied marker argument', async () => {
    const SECRET = 'SKILL_MARKER_SECRET_DO_NOT_LEAK';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-skill-integ-'));
    const ws = path.join(root, 'ws');
    const skillDir = path.join(ws, 'skills', 'show');
    const vault = path.join(root, 'vault');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(vault, { recursive: true });
    const wsFile = path.join(ws, 'notes.txt');
    const secretFile = path.join(vault, 'credentials');
    fs.writeFileSync(wsFile, 'WORKSPACE_NOTE\n');
    fs.writeFileSync(secretFile, `aws_secret = ${SECRET}\n`);

    // A trusted skill whose argument the model picks at load_skill time.
    const body = '!`cat $1`';
    const run = (file: string, sandbox?: SandboxProvider): Promise<string> =>
      preprocessSkillBody(body, {
        variables: { '1': file, ARGUMENTS: file },
        scriptContext: {},
        skillDir,
        ...(sandbox ? { sandbox } : {}),
      });

    // Precondition: uncontained, the marker reads the secret.
    expect(await run(secretFile)).toContain(SECRET);

    const provider = new SandboxRuntimeProvider();
    try {
      const status = await provider.initialize(
        buildDefaultPolicy('workspace', {
          workspaceRoots: [ws],
          home: os.homedir(),
          sessionTmpDir: path.join(root, 'tmp'),
          extraDenyRead: [secretFile],
        }),
      );
      // No boundary on this host (e.g. bubblewrap userns unavailable).
      if (status.filesystem !== 'enforced') return;

      // A workspace read still works through the contained spawn.
      expect(await run(wsFile, provider)).toContain('WORKSPACE_NOTE');
      // The kernel denies the secret.
      expect(await run(secretFile, provider)).not.toContain(SECRET);
    } finally {
      await provider.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
