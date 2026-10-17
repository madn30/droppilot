import { getEnv, isAmazonEnabled } from "../env";
import { createRealAmazonAdapter } from "../marketplaces";
import { KeepaSalesRankSource } from "./keepa/sales-rank";
import { MockSalesRankSource } from "./mock/mock-sales-rank";
import { MockTrendsSource } from "./mock/mock-trends";
import { SerpApiTrendsSource } from "./serpapi/google-trends";
import type { SalesRankSource, TrendsSource } from "./types";

function requireKey(name: "SERPAPI_KEY"): string {
  const value = getEnv()[name];
  if (!value) throw new Error(`${name} is required when MOCK_APIS=false`);
  return value;
}

export function getTrendsSource(): TrendsSource {
  if (getEnv().MOCK_APIS) return new MockTrendsSource();
  return new SerpApiTrendsSource({ apiKey: requireKey("SERPAPI_KEY") });
}

export function getSalesRankSource(): SalesRankSource {
  const env = getEnv();
  if (env.MOCK_APIS) return new MockSalesRankSource();
  // Sales rank is read for Amazon matches only; without Amazon there is nothing to look up.
  if (!isAmazonEnabled(env)) return { getSalesRankHistory: async () => null };
  if (env.KEEPA_API_KEY) return new KeepaSalesRankSource({ apiKey: env.KEEPA_API_KEY });

  // No Keepa subscription: Amazon's own catalog gives the current rank, which is all demand scoring uses.
  const amazon = createRealAmazonAdapter();
  return {
    getSalesRankHistory: async (asin) => {
      const rank = await amazon.getSalesRank(asin);
      return rank === null ? null : [{ date: new Date().toISOString().slice(0, 10), rank }];
    },
  };
}
