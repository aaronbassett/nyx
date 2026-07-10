/**
 * Minimal FIFO counting semaphore for bounding concurrent MCP requests (T019).
 *
 * D31 requires bounded concurrency against the owner's MCP servers. This keeps
 * at most `permits` operations in flight; the rest queue in arrival order.
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: (() => void)[] = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore requires a positive integer permit count, got ${String(permits)}`);
    }
    this.permits = permits;
  }

  private async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.permits += 1;
    } else {
      // Hand the permit straight to the next waiter (no increment/decrement).
      next();
    }
  }

  /** Run `fn` while holding a permit; the permit is always released. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
