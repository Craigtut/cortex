/**
 * Slash commands Esc cancels. A command that does long work outside an
 * agent run (/compact, /model's "compact first") runs under a signal; Esc
 * aborts every such signal in flight, and the command reports what the
 * cancel left.
 */

export class CancellableCommands {
  private readonly inFlight = new Set<AbortController>();

  /** Run `work` under a signal {@link cancel} aborts. */
  async run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      return await work(controller.signal);
    } finally {
      this.inFlight.delete(controller);
    }
  }

  /** Abort every command in flight. Returns whether there was one. */
  cancel(reason: Error): boolean {
    const any = this.inFlight.size > 0;
    for (const controller of this.inFlight) controller.abort(reason);
    this.inFlight.clear();
    return any;
  }
}
