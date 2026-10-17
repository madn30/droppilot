import { z } from "zod";
import { withRetry } from "../../http/retry";
import type { TrendData, TrendPoint, TrendsSource } from "../types";

const ENDPOINT = "https://serpapi.com/search.json";

const timeseriesSchema = z.object({
  error: z.string().optional(),
  interest_over_time: z
    .object({
      timeline_data: z.array(
        z.object({
          timestamp: z.string(),
          values: z.array(z.object({ extracted_value: z.number().nullish() })),
        }),
      ),
    })
    .optional(),
});

const relatedQueriesSchema = z.object({
  error: z.string().optional(),
  related_queries: z.object({ rising: z.array(z.object({ query: z.string() })).optional() }).optional(),
});

class SerpApiError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "SerpApiError";
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof SerpApiError && (error.status === null || error.status === 429 || error.status >= 500);
}

/** Google reports five-year interest weekly; one value per calendar month is enough for direction and seasonality. */
function toMonthlyPoints(weekly: { timestamp: string; values: { extracted_value?: number | null }[] }[]): TrendPoint[] {
  const byMonth = new Map<string, number[]>();
  for (const entry of weekly) {
    const value = entry.values[0]?.extracted_value;
    const seconds = Number(entry.timestamp);
    if (value === null || value === undefined || !Number.isFinite(seconds)) continue;
    const month = `${new Date(seconds * 1000).toISOString().slice(0, 7)}-01`;
    byMonth.set(month, [...(byMonth.get(month) ?? []), value]);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({ date, value: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) }));
}

export interface SerpApiTrendsOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Google Trends through SerpApi's official API: five years of interest plus related rising queries. */
export class SerpApiTrendsSource implements TrendsSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SerpApiTrendsOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async getInterestOverTime(keyword: string, geo: string): Promise<TrendData> {
    const timeseries = await this.search(keyword, geo, "TIMESERIES", timeseriesSchema);
    const related = await this.search(keyword, geo, "RELATED_QUERIES", relatedQueriesSchema);
    return {
      keyword,
      geo,
      points: toMonthlyPoints(timeseries.interest_over_time?.timeline_data ?? []),
      relatedRisingQueries: (related.related_queries?.rising ?? []).map((entry) => entry.query),
    };
  }

  private search<T extends { error?: string }>(keyword: string, geo: string, dataType: string, schema: z.ZodType<T>): Promise<T> {
    return withRetry(
      async () => {
        const url = new URL(ENDPOINT);
        url.search = new URLSearchParams({
          engine: "google_trends",
          q: keyword,
          geo,
          date: "today 5-y",
          data_type: dataType,
          api_key: this.options.apiKey,
        }).toString();

        let response: Response;
        try {
          response = await this.fetchImpl(url);
        } catch (error) {
          throw new SerpApiError(null, `SerpApi request failed: ${String(error)}`);
        }
        if (!response.ok) {
          throw new SerpApiError(response.status, `SerpApi returned HTTP ${response.status} for ${dataType} "${keyword}"`);
        }
        const body = schema.parse(await response.json());
        // Google has no data for rare keywords; SerpApi reports that as an error on a 200 response.
        if (body.error && !/hasn't returned any results/i.test(body.error)) {
          throw new SerpApiError(response.status, `SerpApi error for ${dataType} "${keyword}": ${body.error}`);
        }
        return body;
      },
      { retries: 3, baseDelayMs: 2000, maxDelayMs: 30_000, shouldRetry: isRetryable, sleep: this.options.sleep },
    );
  }
}
