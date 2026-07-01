/**
 * A minimal FIFO async mutex. `run` queues `fn` so that only one critical section
 * executes at a time, regardless of how the previous one settled. Used to
 * serialize catalog read-modify-write sequences (and the git ops around them) so
 * concurrent MCP tool calls cannot clobber each other's manifest writes.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive even if this section rejected.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
