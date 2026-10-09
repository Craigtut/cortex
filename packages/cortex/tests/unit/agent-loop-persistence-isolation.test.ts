/**
 * Two loops in one process, both on the default compaction config. Each
 * loop's persistResult (stamped with its own loopPath) must stay its own:
 * a loop without one must not inherit another loop's.
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../src/agent-loop.js';
import type { PiEvent } from '../../src/event-bridge.js';
import type { AgentLoopConfig, PersistResultFn } from '../../src/types.js';
import { wrapModel } from '../../src/model-wrapper.js';
import { DEFAULT_TOOL_THRESHOLDS } from '../../src/tool-result-persistence.js';
import { MICROCOMPACTION_DEFAULTS } from '../../src/compaction/microcompaction.js';

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

type Ctor = new (
  agent: PiAgent,
  config: AgentLoopConfig,
  tools?: unknown[],
  options?: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
) => AgentLoop;

/** A loop on the default compaction config (no `compaction` key). */
function createLoop(overrides: Partial<AgentLoopConfig>): { loop: AgentLoop; pi: PiAgent } {
  const pi = createPiAgent();
  const raw = { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel;
  const config: AgentLoopConfig = {
    model: wrapModel(raw, raw.provider, raw.name, raw.contextWindow),
    workingDirectory: process.cwd(),
    initialBasePrompt: 'Test base prompt',
    slots: [],
    ...overrides,
  };
  const loop = new (AgentLoop as unknown as Ctor)(pi, config, [], {
    enableSubAgentTool: false,
    enableLoadSkillTool: false,
  });
  loop.refreshTools();
  return { loop, pi };
}

/** Run the loop's Bash tool with output past its persistence threshold. */
async function runOversizedBash(pi: PiAgent, toolCallId: string): Promise<string> {
  const tools = pi.state.tools as unknown as Array<{
    name: string;
    execute: (id: string, params: unknown) => Promise<{ content: Array<{ text?: string }> }>;
  }>;
  const bash = tools.find((t) => t.name === 'Bash');
  if (!bash) throw new Error('Bash tool not registered');
  const result = await bash.execute(toolCallId, {
    command: `node -e "process.stdout.write('x'.repeat(${DEFAULT_TOOL_THRESHOLDS['Bash']! * 4 + 5_000}))"`,
  });
  return result.content[0]?.text ?? '';
}

describe('result persistence across loops on the default compaction config', () => {
  it("does not hand one loop's persistResult to a later loop that has none", async () => {
    const persistA = vi.fn<PersistResultFn>().mockResolvedValue('/tmp/loop-a-result.txt');
    const a = createLoop({ persistResult: persistA, loopPath: 'a' });

    // Precondition: loop A persists its own oversized output under its path.
    const textA = await runOversizedBash(a.pi, 'tc-a');
    expect(textA).toContain('[Result persisted: /tmp/loop-a-result.txt');
    expect(persistA).toHaveBeenCalledOnce();
    expect(persistA.mock.calls[0]![1]).toMatchObject({ toolCallId: 'tc-a', loopPath: 'a' });

    const b = createLoop({ loopPath: 'b' });
    const textB = await runOversizedBash(b.pi, 'tc-b');

    // Loop B trimmed its oversized output itself, with no persister.
    expect(textB).toContain('[Result truncated:');
    expect(textB).toContain('tokens trimmed');
    expect(textB).not.toContain('[Result persisted');
    expect(persistA).toHaveBeenCalledOnce();

    a.loop.destroy();
    b.loop.destroy();
  }, 20_000);

  it('leaves the shared microcompaction defaults untouched', () => {
    const { loop } = createLoop({ persistResult: vi.fn<PersistResultFn>(), loopPath: 'c' });
    expect(MICROCOMPACTION_DEFAULTS.persistResult).toBeUndefined();
    loop.destroy();
  });
});
