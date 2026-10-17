import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter";
import { backoffDelayMs, withRetry } from "./retry";

function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      now: () => time,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        time += ms;
      },
    },
  };
}

describe("RateLimiter", () => {
  it("spaces task starts by the minimum interval and keeps their order", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock.deps);
    const starts: number[] = [];
    const results = await Promise.all(
      ["a", "b", "c"].map((name) =>
        limiter.schedule(async () => {
          starts.push(clock.deps.now());
          return name;
        }),
      ),
    );
    expect(results).toEqual(["a", "b", "c"]);
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it("does not wait when calls are already far enough apart", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(1000, clock.deps);
    await limiter.schedule(async () => undefined);
    await clock.deps.sleep(5000);
    clock.sleeps.length = 0;
    await limiter.schedule(async () => undefined);
    expect(clock.sleeps).toEqual([]);
  });

  it("keeps running queued tasks after one fails", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(100, clock.deps);
    const failed = limiter.schedule(async () => {
      throw new Error("boom");
    });
    const next = limiter.schedule(async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});

describe("withRetry", () => {
  const options = { retries: 3, baseDelayMs: 100, maxDelayMs: 350, shouldRetry: () => true, random: () => 1 };

  it("doubles the delay up to the cap", () => {
    expect([0, 1, 2, 3].map((attempt) => backoffDelayMs(attempt, options))).toEqual([100, 200, 350, 350]);
    expect(backoffDelayMs(1, { ...options, random: () => 0 })).toBe(100);
  });

  it("retries until the task succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("transient");
        return "done";
      },
      { ...options, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(result).toBe("done");
    expect(sleeps).toEqual([100, 200]);
  });

  it("gives up after the configured retries and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { ...options, sleep: async () => undefined },
      ),
    ).rejects.toThrow("fail 4");
    expect(calls).toBe(4);
  });

  it("does not retry errors that shouldRetry rejects", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("permanent");
        },
        { ...options, shouldRetry: () => false, sleep: async () => undefined },
      ),
    ).rejects.toThrow("permanent");
    expect(calls).toBe(1);
  });
});
