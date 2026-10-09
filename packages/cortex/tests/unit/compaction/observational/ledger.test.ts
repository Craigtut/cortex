/**
 * The ObservationLedger's index bookkeeping: the observed prefix, chunk
 * ranges, and the pending call, moved with every rewrite of the source.
 */
import { describe, it, expect } from 'vitest';
import { ObservationLedger } from '../../../../src/compaction/observational/ledger.js';

const chunk = (observations: string) => ({ observations, messageTokensObserved: 1, createdAt: new Date() });

function ledgerWithChunks(...ends: number[]): ObservationLedger {
  const ledger = new ObservationLedger();
  for (const end of ends) {
    const token = ledger.begin(end);
    ledger.land(token, chunk(`to ${end}`));
  }
  return ledger;
}

describe('ObservationLedger', () => {
  it('lands a call at the range it began with', () => {
    const ledger = ledgerWithChunks(3, 7);
    expect(ledger.completedChunks().map((c) => c.endIndex)).toEqual([3, 7]);
    expect(ledger.watermark).toBe(7);
  });

  it('lands nothing for a stale token', () => {
    const ledger = new ObservationLedger();
    const token = ledger.begin(4);
    ledger.invalidatePending();
    expect(ledger.land(token, chunk('late'))).toBe(false);
    expect(ledger.watermark).toBe(0);
  });

  describe('removePrefix', () => {
    it('merges every chunk covering a removed message and shifts the rest', () => {
      const ledger = ledgerWithChunks(3, 7, 10);
      const merged = ledger.removePrefix(7);
      expect(merged.map((c) => c.endIndex)).toEqual([3, 7]);
      expect(ledger.completedChunks().map((c) => c.endIndex)).toEqual([3]);
      expect(ledger.observedPrefix).toBe(0);
    });

    it('keeps a straddling chunk merged and its remaining messages observed', () => {
      const ledger = ledgerWithChunks(3, 7);
      const merged = ledger.removePrefix(5);
      expect(merged).toHaveLength(2);
      expect(ledger.observedPrefix).toBe(2);
      expect(ledger.watermark).toBe(2);
    });

    it('keeps one observed message at index 0 when asked', () => {
      const ledger = ledgerWithChunks(6, 9);
      ledger.removePrefix(6, 2);
      // Message 2 moved to index 0 and stays observed; chunk [6, 9) follows.
      expect(ledger.observedPrefix).toBe(1);
      expect(ledger.completedChunks().map((c) => c.endIndex)).toEqual([4]);
    });

    it('never removes past the watermark', () => {
      const ledger = ledgerWithChunks(3);
      ledger.removePrefix(8);
      expect(ledger.watermark).toBe(0);
    });

    it('moves a pending call with its messages', () => {
      const ledger = ledgerWithChunks(4);
      const token = ledger.begin(9);
      ledger.removePrefix(4);
      expect(ledger.pendingRange()).toEqual({ start: 0, end: 5 });
      expect(ledger.land(token, chunk('late'))).toBe(true);
      expect(ledger.watermark).toBe(5);
    });
  });

  describe('tail trims', () => {
    it('clamps every index to the surviving length', () => {
      const ledger = ledgerWithChunks(4);
      ledger.begin(9);
      ledger.onTailTrimmed(6);
      expect(ledger.pendingRange()).toEqual({ start: 4, end: 6 });
      ledger.onTailTrimmed(2);
      expect(ledger.watermark).toBe(2);
    });
  });

  describe('restore', () => {
    it('drops chunks saved without a watermark', () => {
      const ledger = new ObservationLedger();
      ledger.restore({ chunks: [chunk('old')] });
      expect(ledger.completedChunks()).toEqual([]);
      expect(ledger.watermark).toBe(0);
    });

    it('clamps ranged chunks to the restored history', () => {
      const ledger = new ObservationLedger();
      ledger.restore({ chunks: [{ ...chunk('a'), endIndex: 3 }, { ...chunk('b'), endIndex: 8 }], watermark: 8, observedPrefix: 1 }, 5);
      expect(ledger.observedPrefix).toBe(1);
      expect(ledger.completedChunks().map((c) => c.endIndex)).toEqual([3, 5]);
    });
  });
});
