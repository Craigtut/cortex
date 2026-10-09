/**
 * The observation log: appending, landing reflections, merging chunks, and
 * the slot content it renders.
 */
import { describe, it, expect } from 'vitest';
import { ObservationLog } from '../../../../src/compaction/observational/log.js';
import { OBSERVATION_RECALL_INSTRUCTIONS } from '../../../../src/compaction/observational/constants.js';

const chunk = (observations: string, currentTask?: string) => ({
  observations,
  messageTokensObserved: 1,
  createdAt: new Date(),
  ...(currentTask ? { currentTask, suggestedResponse: 'Carry on.' } : {}),
});

describe('ObservationLog', () => {
  it('appends text and takes a given hint', () => {
    const log = new ObservationLog(false);
    log.append('* first');
    log.append('* second', { currentTask: 'Writing tests', suggestedResponse: 'Continue.' });
    expect(log.text).toBe('* first\n\n* second');
    expect(log.continuationHint?.currentTask).toBe('Writing tests');
    expect(log.tokenCount).toBeGreaterThan(0);
  });

  it('lands a reflection onto the log it condensed, keeping later appends', () => {
    const log = new ObservationLog(false);
    log.append('* old');
    const input = log.text;
    log.append('* newer');
    expect(log.reflect(input, '* condensed')).toBe(true);
    expect(log.text).toBe('* condensed\n\n* newer');
    expect(log.generationCount).toBe(1);
    // A reflection of a log since replaced lands nothing.
    expect(log.reflect('* old', '* stale')).toBe(false);
  });

  it('merges chunks with the latest chunk hint, or keeps the current one', () => {
    const log = new ObservationLog(false);
    log.append('', { currentTask: 'Earlier task', suggestedResponse: 'x' });
    expect(log.merge([chunk('a'), chunk('b')]).hint?.currentTask).toBe('Earlier task');
    const merged = log.merge([chunk('a', 'Task A'), chunk('b', 'Task B'), chunk('c')]);
    expect(merged.observations).toBe('a\n\nb\n\nc');
    expect(merged.hint?.currentTask).toBe('Task B');
  });

  it('renders recall instructions only when configured', () => {
    expect(new ObservationLog(true).slotContent()).toContain(OBSERVATION_RECALL_INSTRUCTIONS);
    expect(new ObservationLog(false).slotContent()).not.toContain(OBSERVATION_RECALL_INSTRUCTIONS);
  });
});
