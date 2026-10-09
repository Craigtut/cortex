/**
 * Reading the observer's and reflector's replies, and the error a reply that
 * cannot be used raises.
 *
 * A reply is unusable when it is empty, has no `<observations>` block, or
 * opens the block without closing it (the model stopped mid-output). Each is
 * a failed call, not an empty result: treating it as a result would record
 * nothing for messages that then leave context, or replace the whole log
 * with nothing.
 */

export type MemoryReplyProblem = 'empty' | 'unparseable' | 'truncated' | 'repetitive' | 'not-smaller';

/** A memory model reply that cannot be used. The call counts as failed. */
export class MemoryReplyError extends Error {
  readonly problem: MemoryReplyProblem;

  constructor(problem: MemoryReplyProblem, message: string) {
    super(message);
    this.name = 'MemoryReplyError';
    this.problem = problem;
  }
}

/**
 * The content of the `<observations>` block of a reply.
 *
 * @param raw - the reply text
 * @param role - 'observer' or 'reflector', for the error message
 * @throws MemoryReplyError when the reply is empty, has no block, or the
 *   block is not closed
 */
export function readObservationsBlock(raw: string, role: 'observer' | 'reflector'): string {
  if (raw.trim().length === 0) {
    throw new MemoryReplyError('empty', `The ${role} returned an empty reply`);
  }
  const open = /<observations>/i.exec(raw);
  if (!open) {
    throw new MemoryReplyError('unparseable', `The ${role} reply has no <observations> block`);
  }
  const start = open.index + open[0].length;
  const close = /<\/observations>/i.exec(raw.slice(start));
  if (!close) {
    throw new MemoryReplyError('truncated', `The ${role} reply ends inside its <observations> block`);
  }
  return raw.slice(start, start + close.index).trim();
}
