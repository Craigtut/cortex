/**
 * Every compaction layer measures history on one basis: what buffering
 * waits for, what idle digestion's floor counts, what a chunk records as
 * observed, and the sizes an overflow drop reports all agree with the
 * estimate the swap, the tail and the view cut use.
 */
import { describe, it, expect, vi } from 'vitest';
import { CompactionManager, buildCompactionConfig } from '../../../src/compaction/index.js';
import { ObservationalMemoryEngine } from '../../../src/compaction/observational/index.js';
import type { CompleteFn } from '../../../src/compaction/observational/types.js';
import { historyTokens, messageTokens, observableHistoryTokens, observableTokens } from '../../../src/compaction/message-tokens.js';
import { extractTextContent } from '../../../src/compaction/tool-messages.js';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentContext } from '../../../src/context-manager.js';
import { charsForTokens, estimateTokens } from '../../../src/token-estimator.js';
import type { AgentMessage } from '../../../src/context-manager.js';
import type { ObservationEvent } from '../../../src/compaction/observational/types.js';
import { makeToolCallMsg, makeToolResultMsg } from './helpers.js';

const OBSERVED = '<observations>\n* (10:00) observed\n</observations>';

/**
 * A tool group whose result is all quotes: 1,250 tokens as text, more than
 * twice that once JSON escapes every quote.
 */
function quotedResult(id: string): AgentMessage[] {
  return [makeToolCallMsg([{ id, name: 'Read' }]), makeToolResultMsg(id, 'Read', '"'.repeat(5_000))];
}

function engineWith(complete: CompleteFn): ObservationalMemoryEngine {
  const engine = new ObservationalMemoryEngine({ maxAttempts: 1, bufferMinTokens: 3_000 });
  engine.setContextWindow(100_000);
  engine.setUtilityModelContextWindow(200_000);
  engine.setCompleteFn(complete);
  return engine;
}

describe('one token basis for history', () => {
  it('buffers at a turn end only once enough has accumulated on that basis', () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    const engine = engineWith(complete);
    const history = [...quotedResult('a'), ...quotedResult('b')];
    // Precondition: under the 3,000-token floor as the swap measures it.
    expect(historyTokens(history)).toBeLessThan(3_000);

    // Past the activation threshold, the interval is the floor.
    engine.onTurnEnd(95_000, 100_000, history, 0);

    expect(complete).not.toHaveBeenCalled();
  });

  it('holds idle digestion to the same floor', async () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    const engine = engineWith(complete);
    const history = [...quotedResult('a'), ...quotedResult('b')];
    expect(historyTokens(history)).toBeLessThan(3_000);

    expect(await engine.digestPendingBuffers(() => history)).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('records a chunk as observing what the observer read of its messages', async () => {
    const engine = engineWith(vi.fn<CompleteFn>().mockResolvedValue(OBSERVED));
    const history = [...quotedResult('a'), ...quotedResult('b'), ...quotedResult('c')];

    expect(await engine.digestPendingBuffers(() => history)).toBe(true);

    const [chunk] = engine.getState().bufferedChunks!;
    expect(chunk!.endIndex).toBe(history.length);
    expect(chunk!.messageTokensObserved).toBe(observableHistoryTokens(history));
  });

  it('reports an overflow drop leaving what the kept history and the log weigh', () => {
    const manager = new CompactionManager(buildCompactionConfig(), 1);
    manager.setContextWindow(100_000);
    manager.setModelContextWindow(100_000);
    manager.updateCurrentContextTokenCount(150_000);
    const history = Array.from({ length: 20 }, (_, i) =>
      ({ role: i % 2 ? 'assistant' : 'user', content: String(i % 10).repeat(charsForTokens(7_500)), timestamp: i + 1 }) as AgentMessage);
    manager.memory.restoreState({
      observations: '', continuationHint: null, observationTokenCount: 0, generationCount: 0,
      bufferedChunks: [{ observations: '* (10:00) the first exchanges', messageTokensObserved: 30_000, createdAt: new Date(), endIndex: 4 }],
      bufferWatermark: 4,
    });
    const events: ObservationEvent[] = [];
    manager.memory.onObservation((event) => events.push(event));
    let kept: AgentMessage[] = [];

    manager.handleOverflowError(() => history, (h) => { kept = h; });

    expect(events).toHaveLength(1);
    expect(events[0]!.tokensBefore).toBe(150_000);
    expect(events[0]!.tokensAfter).toBe(historyTokens(kept) + estimateTokens(manager.memory.getSlotContent()));
  });
});

const IMAGE = { type: 'image', data: 'A'.repeat(200_000), mimeType: 'image/png' };
/** An MCP server's tools declared mid-conversation: about 1,350 tokens of schema. */
const MCP_TOOLS = Array.from({ length: 4 }, (_, i) => ({
  name: `mcp__tracker__tool_${i}`,
  description: 'Query the issue tracker. '.repeat(20),
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to look for. '.repeat(30) } } },
}));
const declaration = (): AgentMessage =>
  ({ role: 'system', content: '', toolsAdded: MCP_TOOLS, timestamp: 5 }) as unknown as AgentMessage;
const textBasis = (message: AgentMessage): number => estimateTokens(extractTextContent(message));

describe('what a message costs in context', () => {
  it('counts an image at what pi estimates for it', () => {
    const asked = { role: 'user', content: [{ type: 'text', text: 'what is wrong here?' }, IMAGE], timestamp: 1 } as unknown as AgentMessage;
    const shot = { role: 'toolResult', toolCallId: 's', toolName: 'Screenshot', content: [IMAGE], isError: false, timestamp: 2 } as unknown as AgentMessage;

    expect(messageTokens(asked)).toBe(estimateMessageTokens(asked as Message));
    expect(messageTokens(asked)).toBeGreaterThan(textBasis(asked) + 1_000);
    expect(messageTokens(shot)).toBeGreaterThan(1_000);
  });

  it("counts a system message's tool declarations and sections", () => {
    const patch = { role: 'system', content: '', sections: { Environment: 'Working directory: /repo. '.repeat(100) }, timestamp: 6 } as unknown as AgentMessage;

    expect(messageTokens(declaration())).toBeGreaterThanOrEqual(estimateTokens(JSON.stringify(MCP_TOOLS)));
    expect(messageTokens(patch)).toBeGreaterThanOrEqual(estimateTokens('Working directory: /repo. '.repeat(100).trim()));
  });

  it('leaves thinking out', () => {
    const answer = { role: 'assistant', content: [{ type: 'text', text: 'done' }, makeToolCallMsg([{ id: 't', name: 'Read' }]).content[0]], timestamp: 3 };
    const thought = { ...answer, content: [{ type: 'thinking', thinking: 'x'.repeat(10_000) }, ...answer.content] };

    expect(messageTokens(thought as unknown as AgentMessage)).toBe(messageTokens(answer as unknown as AgentMessage));
    expect(messageTokens(thought as unknown as AgentMessage)).toBeLessThan(100);
  });

  it('measures shapes pi cannot on the text basis, without throwing', () => {
    const shapes = [
      { role: 'assistant', content: 'restored as a string '.repeat(50), timestamp: 1 },
      { role: 'user', content: [{ type: 'tool_result', name: 'Read', text: 'legacy result '.repeat(50) }], timestamp: 2 },
      { role: 'toolResult', toolCallId: 'x', toolName: 'Read', timestamp: 3 },
      { role: 'assistant', content: [{ type: 'text' }], timestamp: 4 },
      { role: 'compactionSummary', summary: 'custom', timestamp: 5 },
    ] as unknown as AgentMessage[];

    for (const message of shapes) {
      expect(messageTokens(message)).toBe(textBasis(message));
    }
    expect(messageTokens(shapes[0]!)).toBeGreaterThan(0);
    expect(messageTokens(shapes[1]!)).toBeGreaterThan(0);
  });

  it('tells the observer only what it reads', () => {
    const asked = { role: 'user', content: [{ type: 'text', text: 'what is wrong here?' }, IMAGE], timestamp: 1 } as unknown as AgentMessage;

    expect(observableTokens(declaration())).toBe(0);
    expect(observableTokens(asked)).toBe(textBasis(asked));
  });

  it('does not wake the observer for a tool declaration it would not read', () => {
    const complete = vi.fn<CompleteFn>().mockResolvedValue(OBSERVED);
    const engine = engineWith(complete);
    const history = [{ role: 'user', content: 'connect the tracker', timestamp: 1 } as AgentMessage, declaration(), declaration(), declaration()];
    // Precondition: past the floor in context, nothing to the observer.
    expect(historyTokens(history)).toBeGreaterThan(3_000);

    engine.onTurnEnd(95_000, 100_000, history, 0);

    expect(complete).not.toHaveBeenCalled();
  });

  it('estimates the context with its system head once, tool declarations included', () => {
    const manager = new CompactionManager(buildCompactionConfig(), 1);
    manager.setContextWindow(100_000);
    const sections = { Instructions: 'You are a careful coding agent. '.repeat(50) };
    const head = { role: 'system', content: '', sections, toolsAdded: MCP_TOOLS, timestamp: 0 } as unknown as AgentMessage;
    const messages = [head, { role: 'user', content: 'hello', timestamp: 1 } as AgentMessage];
    const context = { systemPrompt: sections.Instructions, model: null, messages, tools: [], thinkingLevel: 'medium' } as unknown as AgentContext;

    expect(manager.estimateCurrentContextTokens(context)).toBe(historyTokens(messages));
    expect(historyTokens(messages)).toBeGreaterThan(estimateTokens(JSON.stringify(MCP_TOOLS)));
  });
});

