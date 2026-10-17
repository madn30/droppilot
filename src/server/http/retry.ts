export interface RetryOptions {
  /** Attempts after the first one. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** 0–1; injectable so tests are deterministic. */
  random?: () => number;
}

/** Delay before retry number `attempt` (0-based): exponential, capped, with 50–100% jitter. */
export function backoffDelayMs(attempt: number, options: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "random">): number {
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  const random = options.random ?? Math.random;
  return Math.round(exponential * (0.5 + random() * 0.5));
}

/** Runs `task`, retrying with exponential backoff while `shouldRetry` accepts the error. */
export async function withRetry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= options.retries || !options.shouldRetry(error)) throw error;
      await sleep(backoffDelayMs(attempt, options));
    }
  }
}
