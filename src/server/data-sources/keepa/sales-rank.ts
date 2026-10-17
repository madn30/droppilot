import { z } from "zod";
import { withRetry } from "../../http/retry";
import type { SalesRankPoint, SalesRankSource } from "../types";

const ENDPOINT = "https://api.keepa.com/product";
const AMAZON_US_DOMAIN = "1";
// Index of the sales rank history in a Keepa product's csv array.
const SALES_RANK_CSV = 3;
// Keepa time is minutes since 2011-01-01; this offset turns it into Unix minutes.
const KEEPA_EPOCH_MINUTES = 21_564_000;
const HISTORY_DAYS = 90;

const responseSchema = z.object({
  products: z.array(z.object({ csv: z.array(z.array(z.number()).nullable()).nullish() })).nullish(),
});

class KeepaError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "KeepaError";
  }
}

// 429 means the token bucket is empty; it refills over time, so waiting helps.
function isRetryable(error: unknown): boolean {
  return error instanceof KeepaError && (error.status === null || error.status === 429 || error.status >= 500);
}

export interface KeepaOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Amazon sales rank history from the Keepa API. */
export class KeepaSalesRankSource implements SalesRankSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: KeepaOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async getSalesRankHistory(asin: string): Promise<SalesRankPoint[] | null> {
    const body = await withRetry(
      async () => {
        const url = new URL(ENDPOINT);
        url.search = new URLSearchParams({
          key: this.options.apiKey,
          domain: AMAZON_US_DOMAIN,
          asin,
          days: String(HISTORY_DAYS),
        }).toString();

        let response: Response;
        try {
          response = await this.fetchImpl(url);
        } catch (error) {
          throw new KeepaError(null, `Keepa request failed: ${String(error)}`);
        }
        if (!response.ok) throw new KeepaError(response.status, `Keepa returned HTTP ${response.status} for ${asin}`);
        return responseSchema.parse(await response.json());
      },
      { retries: 3, baseDelayMs: 5000, maxDelayMs: 60_000, shouldRetry: isRetryable, sleep: this.options.sleep },
    );

    const history = body.products?.[0]?.csv?.[SALES_RANK_CSV];
    if (!history) return null;

    // The history is a flat list of [keepaTime, rank] pairs; -1 marks "no rank at that time".
    const points: SalesRankPoint[] = [];
    for (let index = 0; index + 1 < history.length; index += 2) {
      const rank = history[index + 1];
      if (rank < 0) continue;
      const date = new Date((history[index] + KEEPA_EPOCH_MINUTES) * 60_000).toISOString().slice(0, 10);
      points.push({ date, rank });
    }
    return points.length > 0 ? points : null;
  }
}
