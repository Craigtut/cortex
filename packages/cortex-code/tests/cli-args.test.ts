/**
 * The CLI's flags. `--compaction` chose between observational memory and
 * classic summarization; classic is gone, so the flag is an unknown
 * argument, not one that silently does nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseArgs } from '../src/cli-args.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function exitCodeOf(argv: string[]): { code: number | undefined; error: string } {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => { errors.push(String(message)); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  let code: number | undefined;
  vi.spyOn(process, 'exit').mockImplementation(((exitCode?: number) => {
    code = exitCode;
    throw new Error('exit');
  }) as never);
  try {
    parseArgs(['node', 'cortex', ...argv], '0.0.0-test');
  } catch {
    // process.exit, stubbed
  }
  return { code, error: errors.join('\n') };
}

describe('parseArgs', () => {
  it('rejects --compaction as an unknown argument', () => {
    expect(exitCodeOf(['--compaction', 'observational'])).toEqual({
      code: 1,
      error: 'Unknown argument: --compaction',
    });
  });

  it('accepts the flags it still has', () => {
    // Precondition for the rejection above: parsing itself works.
    expect(exitCodeOf(['--yolo', '--no-update-check']).code).toBeUndefined();
  });
});
