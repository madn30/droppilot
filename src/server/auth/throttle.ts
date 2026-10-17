const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * Slows down password guessing: after five failed logins within 15 minutes,
 * further attempts are refused until the oldest failure ages out.
 * There is a single admin account, so one counter for the whole app is enough.
 */
export class LoginThrottle {
  private failures: number[] = [];

  isBlocked(now: number): boolean {
    this.failures = this.failures.filter((time) => now - time < WINDOW_MS);
    return this.failures.length >= MAX_FAILURES;
  }

  recordFailure(now: number): void {
    this.failures.push(now);
  }

  reset(): void {
    this.failures = [];
  }
}

export const loginThrottle = new LoginThrottle();
