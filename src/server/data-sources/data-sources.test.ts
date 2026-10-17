import { describe, expect, it } from "vitest";
import { KeepaSalesRankSource } from "./keepa/sales-rank";
import { SerpApiTrendsSource } from "./serpapi/google-trends";

function fakeFetch(handler: (url: URL) => { status?: number; body: unknown }) {
  const urls: URL[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    const reply = handler(url);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  return { urls, fetchImpl };
}

const unix = (date: string) => String(Date.parse(`${date}T00:00:00Z`) / 1000);

describe("SerpApiTrendsSource", () => {
  const timeline = {
    interest_over_time: {
      timeline_data: [
        { date: "Jan 3 – 9, 2027", timestamp: unix("2027-01-03"), values: [{ query: "necklace", value: "40", extracted_value: 40 }] },
        { date: "Jan 10 – 16, 2027", timestamp: unix("2027-01-10"), values: [{ query: "necklace", value: "50", extracted_value: 50 }] },
        { date: "Feb 7 – 13, 2027", timestamp: unix("2027-02-07"), values: [{ query: "necklace", value: "100", extracted_value: 100 }] },
        { date: "Feb 14 – 20, 2027", timestamp: unix("2027-02-14"), values: [{ query: "necklace", value: "<1", extracted_value: null }] },
      ],
    },
  };
  const related = { related_queries: { rising: [{ query: "photo necklace for her", value: "Breakout" }], top: [{ query: "necklace" }] } };

  it("requests five years of US interest and averages weekly values per month", async () => {
    const { urls, fetchImpl } = fakeFetch((url) => ({ body: url.searchParams.get("data_type") === "TIMESERIES" ? timeline : related }));
    const data = await new SerpApiTrendsSource({ apiKey: "serp-key", fetch: fetchImpl }).getInterestOverTime("photo necklace", "US");

    expect(data).toEqual({
      keyword: "photo necklace",
      geo: "US",
      points: [
        { date: "2027-01-01", value: 45 },
        { date: "2027-02-01", value: 100 },
      ],
      relatedRisingQueries: ["photo necklace for her"],
    });
    expect(urls).toHaveLength(2);
    expect(urls[0].origin + urls[0].pathname).toBe("https://serpapi.com/search.json");
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({
      engine: "google_trends",
      q: "photo necklace",
      geo: "US",
      date: "today 5-y",
      data_type: "TIMESERIES",
      api_key: "serp-key",
    });
    expect(urls[1].searchParams.get("data_type")).toBe("RELATED_QUERIES");
  });

  it("returns an empty series when Google has no data for the keyword", async () => {
    const { fetchImpl } = fakeFetch(() => ({ body: { error: "Google hasn't returned any results for this query." } }));
    const data = await new SerpApiTrendsSource({ apiKey: "k", fetch: fetchImpl }).getInterestOverTime("zzzz", "US");
    expect(data.points).toEqual([]);
    expect(data.relatedRisingQueries).toEqual([]);
  });

  it("fails on other API errors and retries rate limits", async () => {
    const bad = fakeFetch(() => ({ body: { error: "Invalid API key." } }));
    await expect(new SerpApiTrendsSource({ apiKey: "k", fetch: bad.fetchImpl }).getInterestOverTime("x", "US")).rejects.toThrow(/Invalid API key/);

    let calls = 0;
    const limited = fakeFetch((url) => {
      calls++;
      if (calls === 1) return { status: 429, body: {} };
      return { body: url.searchParams.get("data_type") === "TIMESERIES" ? timeline : related };
    });
    const source = new SerpApiTrendsSource({ apiKey: "k", fetch: limited.fetchImpl, sleep: async () => undefined });
    expect((await source.getInterestOverTime("x", "US")).points).toHaveLength(2);
    expect(calls).toBe(3);
  });
});

describe("KeepaSalesRankSource", () => {
  // Keepa minutes for 2026-12-14 and 2026-12-15 (minutes since 2011-01-01).
  const keepaMinutes = (date: string) => Date.parse(`${date}T00:00:00Z`) / 60_000 - 21_564_000;
  const product = {
    products: [{ csv: [null, null, null, [keepaMinutes("2026-12-14"), 25_000, keepaMinutes("2026-12-14") + 600, -1, keepaMinutes("2026-12-15"), 21_000]] }],
    tokensLeft: 50,
  };

  it("reads the sales rank history and skips gaps", async () => {
    const { urls, fetchImpl } = fakeFetch(() => ({ body: product }));
    const history = await new KeepaSalesRankSource({ apiKey: "keepa-key", fetch: fetchImpl }).getSalesRankHistory("B0TEST");
    expect(history).toEqual([
      { date: "2026-12-14", rank: 25_000 },
      { date: "2026-12-15", rank: 21_000 },
    ]);
    expect(urls[0].origin + urls[0].pathname).toBe("https://api.keepa.com/product");
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ key: "keepa-key", domain: "1", asin: "B0TEST", days: "90" });
  });

  it("returns null when Keepa has no rank for the ASIN", async () => {
    for (const body of [{ products: [] }, { products: [{ csv: null }] }, { products: [{ csv: [null, null, null, [100, -1]] }] }]) {
      const { fetchImpl } = fakeFetch(() => ({ body }));
      expect(await new KeepaSalesRankSource({ apiKey: "k", fetch: fetchImpl }).getSalesRankHistory("B0NONE")).toBeNull();
    }
  });

  it("waits and retries when the token bucket is empty", async () => {
    let calls = 0;
    const { fetchImpl } = fakeFetch(() => (++calls === 1 ? { status: 429, body: { refillIn: 1000 } } : { body: product }));
    const sleeps: number[] = [];
    const source = new KeepaSalesRankSource({ apiKey: "k", fetch: fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
    expect(await source.getSalesRankHistory("B0TEST")).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });
});
