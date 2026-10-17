import { describe, expect, it } from "vitest";
import { summarizeProduct } from "./summary";

function variant(overrides: Partial<Parameters<typeof summarizeProduct<string>>[0][number]> = {}) {
  return {
    warehouse: "CN",
    stock: 100,
    costCents: 88,
    shippingCents: 578,
    processingDays: 3,
    deliveryDaysMax: 7,
    demandSnapshots: [{ score: 54.5 }],
    _count: { matches: 0 },
    listings: [] as string[],
    ...overrides,
  };
}

describe("product summary", () => {
  it("rolls variants up into one line", () => {
    const summary = summarizeProduct(
      [
        variant(),
        variant({ warehouse: "US", costCents: 72, shippingCents: 507, deliveryDaysMax: 7, demandSnapshots: [{ score: 61 }], listings: ["eBay"] }),
        variant({ stock: 0, costCents: 465, shippingCents: 739, processingDays: 2, deliveryDaysMax: 4, _count: { matches: 3 } }),
      ],
      60,
    );
    expect(summary).toEqual({
      variantCount: 3,
      usVariantCount: 1,
      inStockCount: 2,
      landedCostCents: { min: 579, max: 1204 },
      totalDays: { min: 6, max: 10 },
      bestScore: 61,
      aboveThresholdCount: 1,
      confirmedCompetitors: 3,
      listings: ["eBay"],
    });
  });

  it("has no ranges or score before anything is imported or scored", () => {
    expect(summarizeProduct([], 60)).toMatchObject({ variantCount: 0, landedCostCents: null, totalDays: null, bestScore: null, confirmedCompetitors: 0 });
    expect(summarizeProduct([variant({ demandSnapshots: [] })], 60)).toMatchObject({ bestScore: null, aboveThresholdCount: 0 });
  });
});
