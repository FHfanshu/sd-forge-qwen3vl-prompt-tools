export class SessionTransition {
  private pending: Promise<unknown> | null = null;

  run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.pending = next;
    return next.finally(() => {
      if (this.pending === next) this.pending = null;
    });
  }
}
