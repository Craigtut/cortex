import type { CompactNowResult, CortexCompactNowResult } from '@animus-labs/cortex';
import type { Command, CommandSession } from './index.js';

export const compactCommand: Command = {
  name: 'compact',
  description: 'Compact the context now',
  handler: async (session) => {
    await compactContext(session);
  },
};

/**
 * Compact now and say what happened: shared by /compact and /model's
 * "compact first". compactNow moves older messages into memory whatever the
 * context usage, keeping the most recent ones verbatim; a failure changes
 * nothing, and Esc cancels it.
 */
export async function compactContext(
  session: Pick<CommandSession, 'getAgent' | 'getApp' | 'runCancellable'>,
): Promise<void> {
  const agent = session.getAgent();
  const app = session.getApp();
  if (!agent || !app) return;

  app.showStatusSpinner('Compacting context... (Esc to cancel)');
  let result: CortexCompactNowResult;
  let cancelled = false;
  try {
    result = await session.runCancellable(async (signal) => {
      const compacted = await agent.compactNow({ signal });
      cancelled = signal.aborted;
      return compacted;
    });
  } catch (err) {
    app.hideStatusSpinner();
    app.transcript.addNotification('Compaction Error', err instanceof Error ? err.message : String(err));
    return;
  }
  app.hideStatusSpinner();
  const report = describeCompaction(result, cancelled);
  app.transcript.addNotification(report.title, report.body, report.failed ? { severity: 'error' } : undefined);
}

/**
 * The notice for a compactNow result: the work loop's, then, in duplex,
 * the conversation loop's. A cancel that stopped the work loop's compaction
 * is not a failure; one that came after it compacted changes nothing here.
 */
export function describeCompaction(
  result: CortexCompactNowResult,
  cancelled = false,
): { title: string; body: string; failed: boolean } {
  const stopped = result.reasoner.status === 'failed';
  const body = result.talker
    ? `Work: ${describeLoop(result.reasoner)}\nConversation: ${describeLoop(result.talker)}`
    : describeLoop(result.reasoner);
  if (stopped && cancelled) return { title: 'Compaction Cancelled', body, failed: false };
  return { title: stopped ? 'Compaction Failed' : 'Compaction', body, failed: stopped };
}

function describeLoop(result: CompactNowResult): string {
  switch (result.status) {
    case 'compacted': {
      const beforeK = (result.tokensBefore / 1000).toFixed(1);
      const afterK = (result.tokensAfter / 1000).toFixed(1);
      const moved = `Moved ${result.removedMessages} ${result.removedMessages === 1 ? 'message' : 'messages'} into memory, ${beforeK}k to ${afterK}k tokens.`;
      return result.reflection.status === 'failed'
        ? `${moved} Condensing memory failed (${result.reflection.error.message}); it stays as it was.`
        : moved;
    }
    case 'nothing-to-compact':
      return 'Nothing to compact: the recent messages already fit.';
    case 'failed':
      return `Nothing changed: ${result.error.message}`;
  }
}
