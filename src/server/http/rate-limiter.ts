export interface RateLimiterDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realDeps: RateLimiterDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Serialises calls to one API and spaces their start times by at least
 * `minIntervalMs`. Limits are per process: the app and the worker each hold
 * their own, so retry-on-429 remains the backstop when both call the same API.
 */
export class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private nextStartAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly deps: RateLimiterDeps = realDeps,
  ) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const wait = this.nextStartAt - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
      this.nextStartAt = this.deps.now() + this.minIntervalMs;
      return task();
    });
    // A failed task must not block the tasks queued behind it.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
