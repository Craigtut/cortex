import { describe, it, expect, vi } from 'vitest';
import { MicrocompactionEngine } from '../../../src/compaction/microcompaction.js';
import { extractTextContent } from '../../../src/compaction/tool-messages.js';
import type { AgentMessage } from '../../../src/context-manager.js';
import type { MicrocompactionConfig, PersistResultFn } from '../../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssistantMsg(content: string): AgentMessage {
  return { role: 'assistant', content, timestamp: 0 };
}

function makeToolResult(content: string, toolName: string): AgentMessage {
  return {
    role: 'user',
    content: [
      { type: 'tool_result', text: content, name: toolName },
    ],
    timestamp: 0,
  };
}

// Content of approximately N tokens (estimateTokens uses chars/4).
function makeContentOfTokens(tokens: number): string {
  return 'x'.repeat(tokens * 4);
}

/**
 * Build a history with an OLD tool result followed by a big assistant
 * message that pushes it back beyond the hot zone, plus a recent tail.
 *
 * The microcompaction algorithm walks newest -> oldest accumulating token
 * offsets, so the older result lands at tokenOffset ≈ pushTokens.
 */
function buildHistoryWithOldToolResult(
  toolContent: string,
  toolName: string,
  pushTokens: number,
): AgentMessage[] {
  return [
    makeToolResult(toolContent, toolName),                 // index 0: pushed back
    makeAssistantMsg(makeContentOfTokens(pushTokens)),     // index 1: pushes 0
    makeAssistantMsg('recent'),                            // index 2: tokenOffset = 0
  ];
}

function createEngine(persistResult?: PersistResultFn): MicrocompactionEngine {
  const config: Partial<MicrocompactionConfig> = {
    toolCategories: {
      WebFetch: 'non-reproducible',
      Bash: 'non-reproducible',
      Read: 'rereadable',
      Glob: 'rereadable',
      Grep: 'rereadable',
      SubAgent: 'ephemeral',
    },
    ...(persistResult ? { persistResult } : {}),
  };
  return new MicrocompactionEngine(config);
}

// ---------------------------------------------------------------------------
// Tests: Disk persistence in MicrocompactionEngine (maybePersistBeforeTrim)
// ---------------------------------------------------------------------------

describe('MicrocompactionEngine disk persistence', () => {
  // Push the old tool result well beyond the degradation span so it gets a
  // placeholder action. With persister: extendedHotZone = 16k * 1.0 = 16k.
  // Degradation span at contextWindow=200k = 80k. So pushTokens > 96k.
  const PUSH_TO_PLACEHOLDER = 120_000;
  // Push just past the hot zone so the result gets a bookend action.
  const PUSH_TO_BOOKEND = 30_000;

  it('persists non-reproducible results on placeholder action with disk path', async () => {
    const persistResult = vi.fn().mockResolvedValue('/tmp/compaction/result-0.txt');
    const engine = createEngine(persistResult);

    const toolContent = 'WebFetch result content that is substantial enough to test persistence behavior';
    const history = buildHistoryWithOldToolResult(toolContent, 'WebFetch', PUSH_TO_PLACEHOLDER);

    const contextWindow = 200_000;
    const currentTokens = 130_000; // > 25% trim floor

    const result = await engine.apply(history, contextWindow, currentTokens, { cacheCold: true });

    expect(persistResult).toHaveBeenCalledOnce();
    const [content, metadata] = persistResult.mock.calls[0]!;
    expect(content).toBe(toolContent);
    expect(metadata.toolName).toBe('WebFetch');
    expect(metadata.messageIndex).toBe(0);
    expect(metadata.category).toBe('non-reproducible');

    const replaced = result[0]!;
    const text = extractTextContent(replaced);
    expect(text).toContain('/tmp/compaction/result-0.txt');
    expect(text).toContain('persisted');
    expect(Array.isArray(replaced.content)).toBe(true);
  });

  it('persists non-reproducible results on bookend action with disk path', async () => {
    const persistResult = vi.fn().mockResolvedValue('/tmp/compaction/bookend.txt');
    const engine = createEngine(persistResult);

    const toolContent = 'A'.repeat(20_000);
    const history = buildHistoryWithOldToolResult(toolContent, 'Bash', PUSH_TO_BOOKEND);

    const result = await engine.apply(history, 200_000, 100_000, { cacheCold: true });

    expect(persistResult).toHaveBeenCalledOnce();
    const replaced = result[0]!;
    const text = extractTextContent(replaced);
    // Bookend with persistence: header + head + middle marker + tail
    expect(text).toContain('Result persisted');
    expect(text).toContain('/tmp/compaction/bookend.txt');
    expect(text).toContain('tokens trimmed');
  });

  it('does not invoke persist callback for rereadable results', async () => {
    const persistResult = vi.fn().mockResolvedValue('/tmp/compaction/result-0.txt');
    const engine = createEngine(persistResult);

    const toolContent = 'Read file content that can be re-read from disk';
    const history = buildHistoryWithOldToolResult(toolContent, 'Read', PUSH_TO_PLACEHOLDER);

    const result = await engine.apply(history, 200_000, 130_000, { cacheCold: true });

    expect(persistResult).not.toHaveBeenCalled();

    const replaced = result[0]!;
    const text = extractTextContent(replaced);
    // Rereadable beyond degradation span -> placeholder (not clear)
    expect(text).toContain('Tool result trimmed');
    expect(text).toContain('Read');
    expect(Array.isArray(replaced.content)).toBe(true);
  });

  it('does not invoke persist callback for ephemeral results (cleared)', async () => {
    const persistResult = vi.fn().mockResolvedValue('/tmp/compaction/result-0.txt');
    const engine = createEngine(persistResult);

    const toolContent = 'SubAgent output - re-runnable';
    const history = buildHistoryWithOldToolResult(toolContent, 'SubAgent', PUSH_TO_PLACEHOLDER);

    const result = await engine.apply(history, 200_000, 130_000, { cacheCold: true });

    expect(persistResult).not.toHaveBeenCalled();

    const replaced = result[0]!;
    const text = extractTextContent(replaced);
    expect(text).toBe('[Tool result cleared]');
    expect(Array.isArray(replaced.content)).toBe(true);
  });

  it('uses standard placeholder when no persist callback is configured', async () => {
    const engine = createEngine(); // no persistResult

    const toolContent = 'WebFetch result with no persistence configured on this engine';
    // No persister: extendedHotZone = 16k * 1.5 = 24k. Push beyond 24k + 80k = 104k.
    const history = buildHistoryWithOldToolResult(toolContent, 'WebFetch', 130_000);

    const result = await engine.apply(history, 200_000, 140_000, { cacheCold: true });

    const replaced = result[0]!;
    const text = extractTextContent(replaced);
    expect(text).toContain('Tool result trimmed');
    expect(text).toContain('WebFetch');
    expect(text).not.toContain('persisted');
    expect(Array.isArray(replaced.content)).toBe(true);
  });

  it('persists each part separately in multi-part tool_result messages', async () => {
    // Parallel tool calls produce a single message with multiple tool_result
    // parts. Each part must be persisted independently so its disk path maps
    // to its own content, not a concatenation of all parts.
    const paths: string[] = [];
    const persistedContents: string[] = [];
    const persistResult = vi.fn().mockImplementation(async (content: string) => {
      const path = `/tmp/part-${paths.length}.txt`;
      paths.push(path);
      persistedContents.push(content);
      return path;
    });
    const engine = createEngine(persistResult);

    const partA = 'WebFetch A content unique to first parallel call';
    const partB = 'Bash B content totally different from A';
    const multiPart: AgentMessage = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', text: partA, name: 'WebFetch' },
        { type: 'tool_result', tool_use_id: 'toolu_b', text: partB, name: 'Bash' },
      ],
      timestamp: 0,
    };
    const history: AgentMessage[] = [
      multiPart,
      makeAssistantMsg(makeContentOfTokens(PUSH_TO_PLACEHOLDER)),
      makeAssistantMsg('recent'),
    ];

    const result = await engine.apply(history, 200_000, 130_000, { cacheCold: true });

    // Both parts should have been persisted separately
    expect(persistResult).toHaveBeenCalledTimes(2);
    expect(persistedContents).toContain(partA);
    expect(persistedContents).toContain(partB);

    // Each part's replacement should reference its own disk path
    const replaced = result[0]!;
    expect(Array.isArray(replaced.content)).toBe(true);
    const parts = replaced.content as Array<Record<string, unknown>>;
    expect(parts.length).toBe(2);

    const textA = parts[0]!.text as string;
    const textB = parts[1]!.text as string;

    // tool_use_id linkage preserved
    expect(parts[0]!.tool_use_id).toBe('toolu_a');
    expect(parts[1]!.tool_use_id).toBe('toolu_b');

    // Each part references its own path, not the other's
    expect(textA).toContain('persisted');
    expect(textB).toContain('persisted');
    // Because persist is called per-part with its own content, paths differ
    const aHasOwnPath = textA.includes(paths[persistedContents.indexOf(partA)]!);
    const bHasOwnPath = textB.includes(paths[persistedContents.indexOf(partB)]!);
    expect(aHasOwnPath).toBe(true);
    expect(bHasOwnPath).toBe(true);
  });

  it('falls back to standard trim when persist callback throws', async () => {
    const persistResult = vi.fn().mockRejectedValue(new Error('disk full'));
    const engine = createEngine(persistResult);

    const toolContent = 'WebFetch result that fails to persist to disk due to error';
    const history = buildHistoryWithOldToolResult(toolContent, 'WebFetch', PUSH_TO_PLACEHOLDER);

    const result = await engine.apply(history, 200_000, 130_000, { cacheCold: true });

    expect(persistResult).toHaveBeenCalledOnce();

    const replaced = result[0]!;
    const text = extractTextContent(replaced);
    expect(text).toContain('Tool result trimmed');
    expect(text).toContain('WebFetch');
    expect(text).not.toContain('persisted');
    expect(Array.isArray(replaced.content)).toBe(true);
  });
});
