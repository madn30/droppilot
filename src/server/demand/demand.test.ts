import { describe, expect, it } from "vitest";
import { MockTrendsSource } from "../data-sources/mock/mock-trends";
import type { TrendPoint } from "../data-sources/types";
import { defaultSettings } from "../settings/schema";
import {
  competitionScore,
  deliverySpeedScore,
  demandScore,
  profitMarginScore,
  salesVelocityScore,
  trendDirectionScore,
} from "./score";
import { analyzeTrend, trendKeyword } from "./trend-analysis";

const weights = defaultSettings({ MIN_PROFIT: 300, MAX_ACCEPTABLE_LOSS: 100, DEMAND_THRESHOLD: 60 }).demand.weights;

/** `years` of monthly points starting January 2022, built from a function of (year index, month). */
function series(years: number, value: (year: number, month: number) => number): TrendPoint[] {
  const points: TrendPoint[] = [];
  for (let year = 0; year < years; year++) {
    for (let month = 1; month <= 12; month++) {
      points.push({ date: `${2022 + year}-${String(month).padStart(2, "0")}-01`, value: value(year, month) });
    }
  }
  return points;
}

describe("analyzeTrend", () => {
  it("detects rising interest over the years", () => {
    const result = analyzeTrend(series(5, (year) => 20 + year * 10));
    expect(result.direction).toBe("rising");
    expect(result.changeRate).toBeCloseTo(2);
    expect(result.peakMonth).toBeNull();
  });

  it("detects falling interest", () => {
    expect(analyzeTrend(series(5, (year) => 60 - year * 10))).toMatchObject({ direction: "falling" });
  });

  it("calls small changes flat", () => {
    expect(analyzeTrend(series(5, (year) => 50 + year))).toMatchObject({ direction: "flat" });
  });

  it("finds the yearly peak month of a seasonal product", () => {
    const result = analyzeTrend(series(5, (_, month) => (month === 12 ? 100 : month === 11 ? 60 : 20)));
    expect(result).toMatchObject({ direction: "flat", peakMonth: 12 });
  });

  it("reports no peak month for steady interest", () => {
    expect(analyzeTrend(series(5, (_, month) => 40 + (month % 3))).peakMonth).toBeNull();
  });

  it("reads nothing into a keyword with almost no search interest", () => {
    // Mostly zeros with a late spike: a ratio against a near-zero first year would be meaningless.
    const sparse = series(5, (year, month) => (year === 4 && month === 4 ? 100 : 0));
    expect(analyzeTrend(sparse)).toEqual({ direction: "flat", changeRate: 0, peakMonth: null });
  });

  it("does not guess from too little data", () => {
    expect(analyzeTrend([])).toEqual({ direction: "flat", changeRate: 0, peakMonth: null });
    expect(analyzeTrend(series(1, () => 50))).toMatchObject({ direction: "flat", changeRate: 0 });
  });

  it("reads the mock necklace trend as rising with a February peak", async () => {
    const trend = await new MockTrendsSource(() => new Date("2026-12-15T00:00:00Z")).getInterestOverTime("photo projection necklace", "US");
    const result = analyzeTrend(trend.points);
    expect(result.direction).toBe("rising");
    expect(result.peakMonth).toBe(2);
  });
});

describe("trendKeyword", () => {
  it("keeps the first product words and drops filler", () => {
    expect(trendKeyword("Custom Photo Projection Necklace")).toBe("photo projection necklace");
    expect(trendKeyword("New Fashion Personalized Heart Pendant Necklace for Women 2pcs Gift")).toBe("heart pendant necklace");
  });
});

describe("demand components", () => {
  it("scores sales velocity from the signals that exist", () => {
    expect(salesVelocityScore({ salesRank: null, ebaySold: null, supplierTrending: false })).toBe(0);
    expect(salesVelocityScore({ salesRank: 1_000, ebaySold: null, supplierTrending: false })).toBe(1);
    expect(salesVelocityScore({ salesRank: 500_000, ebaySold: null, supplierTrending: false })).toBe(0);
    expect(salesVelocityScore({ salesRank: 21_000, ebaySold: null, supplierTrending: false })).toBeCloseTo(0.51, 2);
    expect(salesVelocityScore({ salesRank: null, ebaySold: 1_000, supplierTrending: false })).toBe(1);
    expect(salesVelocityScore({ salesRank: null, ebaySold: 0, supplierTrending: false })).toBe(0);
    expect(salesVelocityScore({ salesRank: null, ebaySold: null, supplierTrending: true })).toBe(0.6);
    expect(salesVelocityScore({ salesRank: 1_000, ebaySold: null, supplierTrending: true })).toBeCloseTo(0.8);
  });

  it("scores trend direction around a flat 0.5", () => {
    expect(trendDirectionScore(0)).toBe(0.5);
    expect(trendDirectionScore(0.3)).toBeCloseTo(0.8);
    expect(trendDirectionScore(2)).toBe(1);
    expect(trendDirectionScore(-0.9)).toBe(0);
  });

  it("scores competition inversely", () => {
    expect(competitionScore(0)).toBe(1);
    expect(competitionScore(3)).toBe(0.5);
    expect(competitionScore(2)).toBeCloseTo(0.6);
    expect(competitionScore(30)).toBeLessThan(0.1);
  });

  it("scores margin, and gives nothing when the floor is above the market price", () => {
    expect(profitMarginScore(0.15, true)).toBeCloseTo(0.5);
    expect(profitMarginScore(0.45, true)).toBe(1);
    expect(profitMarginScore(0.45, false)).toBe(0);
    expect(profitMarginScore(-0.1, true)).toBe(0);
  });

  it("scores delivery speed", () => {
    expect(deliverySpeedScore(5)).toBe(1);
    expect(deliverySpeedScore(7)).toBeCloseTo(13 / 15);
    expect(deliverySpeedScore(20)).toBe(0);
    expect(deliverySpeedScore(40)).toBe(0);
  });

  it("mixes the components by weight into a 0–100 score", () => {
    const all = (value: number) => ({ salesVelocity: value, trendDirection: value, competition: value, profitMargin: value, deliverySpeed: value });
    expect(demandScore(all(1), weights)).toBe(100);
    expect(demandScore(all(0), weights)).toBe(0);
    expect(demandScore({ ...all(0), salesVelocity: 1 }, weights)).toBe(30);
    expect(demandScore({ ...all(0), deliverySpeed: 1 }, weights)).toBe(10);
    // Weights need not add up to 1.
    expect(demandScore({ ...all(0), salesVelocity: 1 }, { salesVelocity: 2, trendDirection: 1, competition: 1, profitMargin: 0, deliverySpeed: 0 })).toBe(50);
  });
});
