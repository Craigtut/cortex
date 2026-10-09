import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Type } from 'typebox';
import { DeferredToolRegistry } from '../../../src/tools/tool-search/registry.js';
import {
  createToolSearchTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../../src/tools/tool-search/index.js';
import type { CortexTool } from '../../../src/tool-contract.js';
import { AgentLoop } from '../../../src/agent-loop.js';
import type { PiAgent, PiModel } from '../../../src/agent-loop.js';
import type { AgentLoopConfig } from '../../../src/types.js';
import { wrapModel } from '../../../src/model-wrapper.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, opts?: Partial<CortexTool>): CortexTool {
  return {
    name,
    description: opts?.description ?? `Description for ${name}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: '' }], details: {} }),
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// DeferredToolRegistry
// ---------------------------------------------------------------------------

describe('DeferredToolRegistry', () => {
  let registry: DeferredToolRegistry;

  beforeEach(() => {
    registry = new DeferredToolRegistry();
  });

  describe('setDeferredPool / getUndiscoveredNames', () => {
    it('lists pool names sorted alphabetically', () => {
      registry.setDeferredPool([
        makeTool('zeta'),
        makeTool('alpha'),
        makeTool('mu'),
      ]);
      expect(registry.getUndiscoveredNames()).toEqual(['alpha', 'mu', 'zeta']);
    });

    it('returns empty when pool is empty', () => {
      expect(registry.getUndiscoveredNames()).toEqual([]);
    });

    it('replaces the pool fully on each call', () => {
      registry.setDeferredPool([makeTool('a'), makeTool('b')]);
      registry.setDeferredPool([makeTool('c')]);
      expect(registry.getUndiscoveredNames()).toEqual(['c']);
    });

    it('excludes discovered tools from undiscovered names', () => {
      registry.setDeferredPool([makeTool('a'), makeTool('b'), makeTool('c')]);
      registry.markDiscovered(['b']);
      expect(registry.getUndiscoveredNames()).toEqual(['a', 'c']);
    });
  });

  describe('markDiscovered', () => {
    it('returns the newly added subset only', () => {
      registry.setDeferredPool([makeTool('a'), makeTool('b'), makeTool('c')]);
      expect(registry.markDiscovered(['a', 'b'])).toEqual(['a', 'b']);
      expect(registry.markDiscovered(['b', 'c'])).toEqual(['c']);
    });

    it('persists across pool replacements', () => {
      registry.setDeferredPool([makeTool('a')]);
      registry.markDiscovered(['a']);
      registry.setDeferredPool([makeTool('a'), makeTool('b')]);
      expect(registry.getDiscovered().has('a')).toBe(true);
    });
  });

  describe('formatSlotContent', () => {
    it('returns empty string when nothing is undiscovered', () => {
      expect(registry.formatSlotContent()).toBe('');
    });

    it('produces deterministic, byte-stable output for the same pool', () => {
      registry.setDeferredPool([makeTool('zeta'), makeTool('alpha'), makeTool('mu')]);
      const a = registry.formatSlotContent();
      const b = registry.formatSlotContent();
      expect(a).toBe(b);
      // Names should appear in sorted order in the output
      expect(a.indexOf('alpha')).toBeLessThan(a.indexOf('mu'));
      expect(a.indexOf('mu')).toBeLessThan(a.indexOf('zeta'));
    });

    it('changes when discovered set changes', () => {
      registry.setDeferredPool([makeTool('a'), makeTool('b')]);
      const before = registry.formatSlotContent();
      registry.markDiscovered(['a']);
      const after = registry.formatSlotContent();
      expect(before).not.toBe(after);
      expect(after).not.toContain('- a\n');
    });

    it('lists all undiscovered tools by name', () => {
      registry.setDeferredPool([makeTool('foo'), makeTool('bar'), makeTool('baz')]);
      const content = registry.formatSlotContent();
      expect(content).toContain('- bar');
      expect(content).toContain('- baz');
      expect(content).toContain('- foo');
    });
  });

  describe('resolveQuery — select format', () => {
    beforeEach(() => {
      registry.setDeferredPool([
        makeTool('mcp__obsidian__read_note'),
        makeTool('mcp__obsidian__write_note'),
        makeTool('mcp__playwright__browser_click'),
      ]);
    });

    it('loads a single tool by name', () => {
      const result = registry.resolveQuery('select:mcp__obsidian__read_note', 5);
      expect(result.resolved.map((t) => t.name)).toEqual(['mcp__obsidian__read_note']);
      expect(result.newlyDiscovered).toEqual(['mcp__obsidian__read_note']);
      expect(result.notFound).toEqual([]);
    });

    it('loads multiple tools by comma-separated name', () => {
      const result = registry.resolveQuery(
        'select:mcp__obsidian__read_note, mcp__playwright__browser_click',
        5,
      );
      expect(result.resolved.map((t) => t.name).sort()).toEqual([
        'mcp__obsidian__read_note',
        'mcp__playwright__browser_click',
      ]);
    });

    it('returns notFound for missing names', () => {
      const result = registry.resolveQuery('select:nope', 5);
      expect(result.notFound).toEqual(['nope']);
      expect(result.resolved).toEqual([]);
    });

    it('does not double-discover an already-loaded tool', () => {
      registry.resolveQuery('select:mcp__obsidian__read_note', 5);
      const result = registry.resolveQuery('select:mcp__obsidian__read_note', 5);
      expect(result.newlyDiscovered).toEqual([]);
      expect(result.resolved.map((t) => t.name)).toEqual(['mcp__obsidian__read_note']);
    });
  });

  describe('resolveQuery — exact and prefix match', () => {
    beforeEach(() => {
      registry.setDeferredPool([
        makeTool('mcp__obsidian__read_note'),
        makeTool('mcp__obsidian__write_note'),
        makeTool('mcp__playwright__browser_click'),
      ]);
    });

    it('matches an exact tool name', () => {
      const result = registry.resolveQuery('mcp__obsidian__read_note', 5);
      expect(result.resolved.map((t) => t.name)).toEqual(['mcp__obsidian__read_note']);
    });

    it('matches a prefix and returns sorted', () => {
      const result = registry.resolveQuery('mcp__obsidian', 5);
      expect(result.resolved.map((t) => t.name)).toEqual([
        'mcp__obsidian__read_note',
        'mcp__obsidian__write_note',
      ]);
    });

    it('respects max_results on prefix matches', () => {
      const result = registry.resolveQuery('mcp__obsidian', 1);
      expect(result.resolved).toHaveLength(1);
    });
  });

  describe('resolveQuery — keyword search', () => {
    beforeEach(() => {
      registry.setDeferredPool([
        makeTool('mcp__obsidian__read_note', {
          description: 'Read a note from the Obsidian vault',
          isMcp: true,
        }),
        makeTool('mcp__obsidian__search_notes', {
          description: 'Search notes by query',
          isMcp: true,
        }),
        makeTool('mcp__slack__post_message', {
          description: 'Send a message to a Slack channel',
          isMcp: true,
        }),
      ]);
    });

    it('matches by tool name part', () => {
      const result = registry.resolveQuery('obsidian read', 5);
      const names = result.resolved.map((t) => t.name);
      expect(names).toContain('mcp__obsidian__read_note');
      // The top result should be the one with both terms in name parts
      expect(names[0]).toBe('mcp__obsidian__read_note');
    });

    it('matches by description fallback', () => {
      const result = registry.resolveQuery('vault', 5);
      expect(result.resolved.map((t) => t.name)).toContain('mcp__obsidian__read_note');
    });

    it('respects required terms (+prefix)', () => {
      const result = registry.resolveQuery('+slack message', 5);
      expect(result.resolved.map((t) => t.name)).toEqual(['mcp__slack__post_message']);
    });

    it('returns empty when nothing scores', () => {
      const result = registry.resolveQuery('xyzunknownword', 5);
      expect(result.resolved).toEqual([]);
      expect(result.notFound).toEqual([]);
    });
  });

  describe('resolveQuery — edge cases', () => {
    it('returns nothing for empty query', () => {
      registry.setDeferredPool([makeTool('a')]);
      const result = registry.resolveQuery('   ', 5);
      expect(result.resolved).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// ToolSearch tool
// ---------------------------------------------------------------------------

describe('createToolSearchTool', () => {
  it('has the expected name and is alwaysLoad', () => {
    const tool = createToolSearchTool({
      registry: new DeferredToolRegistry(),
      onAfterDiscovery: () => {},
    });
    expect(tool.name).toBe(TOOL_SEARCH_TOOL_NAME);
    expect(tool.alwaysLoad).toBe(true);
  });

  it('triggers onAfterDiscovery when at least one new tool is loaded', async () => {
    const registry = new DeferredToolRegistry();
    registry.setDeferredPool([makeTool('a'), makeTool('b')]);
    let calls = 0;
    const tool = createToolSearchTool({
      registry,
      onAfterDiscovery: () => { calls++; },
    });
    await tool.execute({ query: 'select:a' });
    expect(calls).toBe(1);
  });

  it('does NOT trigger onAfterDiscovery when nothing new is loaded', async () => {
    const registry = new DeferredToolRegistry();
    registry.setDeferredPool([makeTool('a')]);
    registry.markDiscovered(['a']);
    let calls = 0;
    const tool = createToolSearchTool({
      registry,
      onAfterDiscovery: () => { calls++; },
    });
    await tool.execute({ query: 'select:a' });
    expect(calls).toBe(0);
  });

  it('reports loaded, alreadyAvailable, and notFound separately', async () => {
    const registry = new DeferredToolRegistry();
    registry.setDeferredPool([makeTool('a'), makeTool('b')]);
    registry.markDiscovered(['a']);
    const tool = createToolSearchTool({
      registry,
      onAfterDiscovery: () => {},
    });
    const result = await tool.execute({ query: 'select:a,b,nope' });
    expect(result.details.loaded).toEqual(['b']);
    expect(result.details.alreadyAvailable).toEqual(['a']);
    expect(result.details.notFound).toEqual(['nope']);
  });

  it('reports the remaining undiscovered count', async () => {
    const registry = new DeferredToolRegistry();
    registry.setDeferredPool([makeTool('a'), makeTool('b'), makeTool('c')]);
    const tool = createToolSearchTool({
      registry,
      onAfterDiscovery: () => {},
    });
    const result = await tool.execute({ query: 'select:a' });
    expect(result.details.totalDeferred).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AgentLoop integration
// ---------------------------------------------------------------------------

function createMinimalPiAgent(): PiAgent {
  const agent = {
    state: {
      messages: [] as Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>,
      systemPrompt: '',
      tools: [] as unknown[],
    },
    subscribe: () => () => {},
    prompt: async () => ({ content: 'ok' }),
    abort: () => {},
    async waitForIdle(): Promise<void> {},
    reset: () => {},
    steer: () => {},
  };
  return agent as unknown as PiAgent;
}

function buildConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  const rawModel = { provider: 'anthropic', name: 'claude-sonnet-4-20250514' } as PiModel;
  return {
    model: wrapModel(rawModel, rawModel.provider, rawModel.name, 200_000),
    workingDirectory: '/tmp/tool-search-test',
    slots: [],
    // Use classic compaction strategy to avoid the `_observations` slot
    // distracting from deferred tool slot placement assertions.
    ...overrides,
  };
}

function constructAgent(
  pi: PiAgent,
  config: AgentLoopConfig,
  tools: CortexTool[] = [],
): AgentLoop {
  const Ctor = AgentLoop as unknown as new (
    a: PiAgent,
    c: AgentLoopConfig,
    t: CortexTool[] | undefined,
    o: { enableSubAgentTool?: boolean; enableLoadSkillTool?: boolean },
  ) => AgentLoop;
  return new Ctor(pi, config, tools, { enableSubAgentTool: false, enableLoadSkillTool: false });
}

describe('AgentLoop integration with deferred tools', () => {
  it('does not register ToolSearch when deferredTools.enabled is false', () => {
    const pi = createMinimalPiAgent();
    constructAgent(pi, buildConfig());

    const lastCall = pi.state.tools as Array<{ name: string }>;
    const names = lastCall.map((t) => t.name);
    expect(names).not.toContain(TOOL_SEARCH_TOOL_NAME);
  });

  it('registers ToolSearch and creates _available_tools slot when enabled', () => {
    const pi = createMinimalPiAgent();
    const agent = constructAgent(pi, buildConfig({
      deferredTools: { enabled: true },
    }));

    const lastCall = pi.state.tools as Array<{ name: string }>;
    const names = lastCall.map((t) => t.name);
    expect(names).toContain(TOOL_SEARCH_TOOL_NAME);

    const cm = agent.getContextManager();
    expect(cm.slots).toContain('_available_tools');
    // The slot should be at index 0 (before any consumer slots)
    expect(cm.slots[0]).toBe('_available_tools');
  });

  it('places _available_tools before consumer slots', () => {
    const pi = createMinimalPiAgent();
    const agent = constructAgent(pi, buildConfig({
      deferredTools: { enabled: true },
      slots: ['consumer_a', 'consumer_b'],
    }));
    const cm = agent.getContextManager();
    expect(cm.slots).toEqual(['_available_tools', 'consumer_a', 'consumer_b', '_observations']);
  });

  it('defers tools with shouldDefer: true when enabled', () => {
    const pi = createMinimalPiAgent();
    const deferredTool: CortexTool = {
      name: 'SpecialThing',
      description: 'A tool the consumer wants deferred',
      parameters: Type.Object({}),
      shouldDefer: true,
      execute: async () => ({ content: [{ type: 'text', text: '' }], details: {} }),
    };
    constructAgent(pi, buildConfig({
      deferredTools: { enabled: true },
    }), [deferredTool]);

    const lastCall = pi.state.tools as Array<{ name: string }>;
    const names = lastCall.map((t) => t.name);
    // SpecialThing is deferred → NOT in the tools array
    expect(names).not.toContain('SpecialThing');
    // But ToolSearch IS
    expect(names).toContain(TOOL_SEARCH_TOOL_NAME);
  });

  it('respects consumer alwaysLoad override', () => {
    const pi = createMinimalPiAgent();
    const deferredTool: CortexTool = {
      name: 'mcp__my_server__mytool',
      description: 'Would normally be deferred if isMcp were true',
      parameters: Type.Object({}),
      shouldDefer: true,
      execute: async () => ({ content: [{ type: 'text', text: '' }], details: {} }),
    };
    constructAgent(pi, buildConfig({
      deferredTools: {
        enabled: true,
        alwaysLoad: ['mcp__my_server__mytool'],
      },
    }), [deferredTool]);

    const lastCall = pi.state.tools as Array<{ name: string }>;
    const names = lastCall.map((t) => t.name);
    // Consumer forced this tool to always load despite shouldDefer: true
    expect(names).toContain('mcp__my_server__mytool');
  });

  it('respects per-tool alwaysLoad: true', () => {
    const pi = createMinimalPiAgent();
    const tool: CortexTool = {
      name: 'ImportantTool',
      description: 'Must never defer',
      parameters: Type.Object({}),
      shouldDefer: true,    // Would be deferred
      alwaysLoad: true,     // But never defer takes precedence
      execute: async () => ({ content: [{ type: 'text', text: '' }], details: {} }),
    };
    constructAgent(pi, buildConfig({
      deferredTools: { enabled: true },
    }), [tool]);

    const lastCall = pi.state.tools as Array<{ name: string }>;
    const names = lastCall.map((t) => t.name);
    expect(names).toContain('ImportantTool');
  });

  it('populates _available_tools slot with deferred tool names', () => {
    const pi = createMinimalPiAgent();
    const agent = constructAgent(pi, buildConfig({
      deferredTools: { enabled: true },
    }), [
      {
        name: 'DeferredA',
        description: '',
        parameters: Type.Object({}),
        shouldDefer: true,
        execute: async () => ({ content: [{ type: 'text', text: '' }], details: {} }),
      },
      {
        name: 'DeferredB',
        description: '',
        parameters: Type.Object({}),
        shouldDefer: true,
        execute: async () => ({ content: [{ type: 'text', text: '' }], details: {} }),
      },
    ]);

    const cm = agent.getContextManager();
    const slotContent = cm.getSlot('_available_tools');
    expect(slotContent).toContain('- DeferredA');
    expect(slotContent).toContain('- DeferredB');
  });

  it('loading a tool via ToolSearch moves it from slot to tools array', async () => {
    const pi = createMinimalPiAgent();
    const agent = constructAgent(pi, buildConfig({
      deferredTools: { enabled: true },
    }), [
      {
        name: 'DeferredThing',
        description: 'This one is deferred',
        parameters: Type.Object({}),
        shouldDefer: true,
        execute: async () => ({ content: [{ type: 'text', text: 'done' }], details: {} }),
      },
    ]);

    const before = pi.state.tools as Array<{ name: string; execute: (...args: unknown[]) => unknown }>;
    expect(before.map((t) => t.name)).not.toContain('DeferredThing');

    // Execute ToolSearch via the pi-agent-core adapter form (toolCallId, params)
    const toolSearch = before.find((t) => t.name === TOOL_SEARCH_TOOL_NAME)!;
    await toolSearch.execute('test-call', { query: 'select:DeferredThing' });

    // After discovery, refreshTools should have updated agent.state.tools.
    const after = pi.state.tools as Array<{ name: string }>;
    expect(after.map((t) => t.name)).toContain('DeferredThing');

    // And the slot should no longer list it
    const slotContent = agent.getContextManager().getSlot('_available_tools');
    expect(slotContent ?? '').not.toContain('- DeferredThing');
  });
});
