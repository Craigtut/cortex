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
 * nothing.
 */
export async function compactContext(session: Pick<CommandSession, 'getAgent' | 'getApp'>): Promise<void> {
  const agent = session.getAgent();
  const app = session.getApp();
  if (!agent || !app) return;

  app.showStatusSpinner('Compacting context...');
  let result: CortexCompactNowResult;
  try {
    result = await agent.compactNow();
  } catch (err) {
    app.hideStatusSpinner();
    app.transcript.addNotification('Compaction Error', err instanceof Error ? err.message : String(err));
    return;
  }
  app.hideStatusSpinner();
  const report = describeCompaction(result);
  app.transcript.addNotification(report.title, report.body, report.failed ? { severity: 'error' } : undefined);
}

/**
 * The notice for a compactNow result: the work loop's, then, in duplex,
 * the conversation loop's.
 */
export function describeCompaction(result: CortexCompactNowResult): { title: string; body: string; failed: boolean } {
  const failed = result.reasoner.status === 'failed';
  const body = result.talker
    ? `Work: ${describeLoop(result.reasoner)}\nConversation: ${describeLoop(result.talker)}`
    : describeLoop(result.reasoner);
  return { title: failed ? 'Compaction Failed' : 'Compaction', body, failed };
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
