import { describe, expect, it } from "vitest";
import type { TrendingDiscoveryResult } from "@/server/discovery/trending";
import { trendingSummary } from "./seasonal";

const EMPTY: TrendingDiscoveryResult = { evaluated: 0, failed: [], listed: [], notListed: [] };

describe("trendingSummary", () => {
  it("says nothing was scored when every product failed, instead of blaming the demand threshold", () => {
    const lines = trendingSummary({ ...EMPTY, failed: [{ externalId: "P1", error: "Jina embeddings returned HTTP 403" }] }, []);
    expect(lines).toEqual([
      "0 trending supplier product(s) imported, matched and scored, 1 failed",
      "Nothing was scored, so nothing was listed.",
      "Failed P1: Jina embeddings returned HTTP 403",
    ]);
  });

  it("blames the demand threshold only when products were scored and none were picked", () => {
    expect(trendingSummary({ ...EMPTY, evaluated: 2 }, [])[1]).toBe("None reached the demand threshold, so nothing was listed.");
  });

  it("lists the refusals when picked products could not be listed", () => {
    const lines = trendingSummary({ ...EMPTY, evaluated: 1, notListed: [{ variantId: "V1", error: "eBay refused" }] }, []);
    expect(lines.slice(1)).toEqual(["Nothing was listed:", "Not listed: eBay refused"]);
  });

  it("names the created listings", () => {
    const lines = trendingSummary({ ...EMPTY, evaluated: 1, listed: ["L1"] }, ["  Lamp (SKU CJ-1)"]);
    expect(lines.slice(1)).toEqual(["Listed (1):", "  Lamp (SKU CJ-1)"]);
  });
});
