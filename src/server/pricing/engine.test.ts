import { describe, expect, it } from "vitest";
import { type Settings, defaultSettings } from "../settings/schema";
import {
  applyMarkup,
  computeFloorCents,
  computeProfitCents,
  marginTargetPriceCents,
  resolveListingPriceCents,
  roundDownToPriceEnding,
  roundUpToPriceEnding,
  seasonalMarkupRate,
} from "./engine";

const settings = defaultSettings({ MIN_PROFIT: 300, MAX_ACCEPTABLE_LOSS: 100, DEMAND_THRESHOLD: 60 });
const necklace = { costCents: 1120, shippingCents: 490 };

function withSettings(change: (draft: Settings) => void): Settings {
  const draft = structuredClone(settings);
  change(draft);
  return draft;
}

describe("computeFloorCents", () => {
  it("matches the formula without a price buffer", () => {
    const noBuffer = withSettings((draft) => {
      draft.pricing.priceBufferRate = 0;
    });
    // (11.20 + 4.90 + 3.00 + 0.30) / (1 - 0.1325 - 0 - 0.06) = 19.40 / 0.8075 = 24.0248
    expect(computeFloorCents(necklace, "EBAY", noBuffer)).toBe(2403);
    // (11.20 + 4.90 + 3.00) / (1 - 0.15 - 0.06) = 19.10 / 0.79 = 24.1772
    expect(computeFloorCents(necklace, "AMAZON", noBuffer)).toBe(2418);
  });

  it("inflates the supplier cost by the price buffer", () => {
    // (16.10 × 1.03 + 3.30) / 0.8075 = 19.883 / 0.8075 = 24.6229
    expect(computeFloorCents(necklace, "EBAY", settings)).toBe(2463);
  });

  it("rises when the supplier raises its price by $1", () => {
    // (17.10 × 1.03 + 3.30) / 0.8075 = 20.913 / 0.8075 = 25.8985
    expect(computeFloorCents({ costCents: 1220, shippingCents: 490 }, "EBAY", settings)).toBe(2590);
  });

  it("includes the payment fee when one is configured", () => {
    const withPaymentFee = withSettings((draft) => {
      draft.pricing.priceBufferRate = 0;
      draft.fees.paymentFeeRate = 0.029;
    });
    // 19.40 / (1 - 0.1325 - 0.029 - 0.06) = 19.40 / 0.7785 = 24.9197
    expect(computeFloorCents(necklace, "EBAY", withPaymentFee)).toBe(2492);
  });

  it("refuses fee settings that make every price unprofitable", () => {
    const impossible = withSettings((draft) => {
      draft.fees.ebay.feeRate = 0.95;
    });
    expect(() => computeFloorCents(necklace, "EBAY", impossible)).toThrow(/100%/);
  });

  it("always yields at least the minimum profit at the floor, even after the buffered increase", () => {
    const floor = computeFloorCents(necklace, "EBAY", settings);
    expect(computeProfitCents(floor, necklace, "EBAY", settings)).toBeGreaterThanOrEqual(300);
    const afterIncrease = { costCents: Math.round(1120 * 1.03), shippingCents: Math.round(490 * 1.03) };
    expect(computeProfitCents(floor, afterIncrease, "EBAY", settings)).toBeGreaterThanOrEqual(299);
  });
});

describe("computeProfitCents", () => {
  it("uses the actual supplier cost", () => {
    // 24.89 × 0.8075 − 0.30 − 16.10 = 3.6987
    expect(computeProfitCents(2489, necklace, "EBAY", settings)).toBe(370);
  });

  it("goes negative when the supplier cost jumps", () => {
    // 24.89 × 0.8075 − 0.30 − 21.10 = −1.3013
    expect(computeProfitCents(2489, { costCents: 1620, shippingCents: 490 }, "EBAY", settings)).toBe(-130);
  });
});

describe("price endings", () => {
  it.each([
    [2463, 2489],
    [2489, 2489],
    [2490, 2499],
    [2499, 2499],
    [2500, 2589],
    [2590, 2599],
    [1, 89],
    [2462.2, 2489],
  ])("rounds %d up to %d", (input, expected) => {
    expect(roundUpToPriceEnding(input)).toBe(expected);
  });

  it.each([
    [2489, 2489],
    [2498, 2489],
    [2499, 2499],
    [2488, 2399],
    [2500, 2499],
    [100, 99],
    [89, 89],
    [88, null],
  ])("rounds %d down to %s", (input, expected) => {
    expect(roundDownToPriceEnding(input)).toBe(expected);
  });
});

describe("resolveListingPriceCents", () => {
  it("prices the scenario at $24.89: $0.10 under the lowest confirmed competitor ($24.99)", () => {
    const floor = computeFloorCents(necklace, "EBAY", settings);
    expect(resolveListingPriceCents(2499 - 10, floor)).toBe(2489);
  });

  it("never goes below the floor when the target is lower", () => {
    const floor = computeFloorCents({ costCents: 1220, shippingCents: 490 }, "EBAY", settings);
    const price = resolveListingPriceCents(2489, floor);
    expect(price).toBe(2599);
    expect(price).toBeGreaterThanOrEqual(floor);
  });

  it("rounds the floor up, not down, when the rounded target would dip under it", () => {
    expect(resolveListingPriceCents(2495, 2491)).toBe(2499);
  });
});

describe("marginTargetPriceCents", () => {
  it("prices a unique product to the margin target", () => {
    // (16.10 + 0.30) / (0.8075 − 0.25) = 16.40 / 0.5575 = 29.417
    const target = marginTargetPriceCents(necklace, "EBAY", settings);
    expect(target).toBe(2942);
    const price = resolveListingPriceCents(roundUpToPriceEnding(target), computeFloorCents(necklace, "EBAY", settings));
    expect(price).toBe(2989);
    expect(computeProfitCents(price, necklace, "EBAY", settings) / price).toBeGreaterThanOrEqual(0.25);
  });

  it("refuses a margin target that fees make unreachable", () => {
    const greedy = withSettings((draft) => {
      draft.pricing.uniqueMarginTargetRate = 0.9;
    });
    expect(() => marginTargetPriceCents(necklace, "EBAY", greedy)).toThrow(/Margin target/);
  });
});

describe("seasonal markup", () => {
  const seasonal = withSettings((draft) => {
    draft.pricing.seasonalMarkupRate = 0.1;
  });

  it("ramps from 0 at the start of the window to the full rate on the day", () => {
    expect(seasonalMarkupRate(60, 60, seasonal)).toBe(0);
    expect(seasonalMarkupRate(30, 60, seasonal)).toBeCloseTo(0.05);
    expect(seasonalMarkupRate(0, 60, seasonal)).toBeCloseTo(0.1);
  });

  it("is 0 outside the window and when no markup is configured", () => {
    expect(seasonalMarkupRate(61, 60, seasonal)).toBe(0);
    expect(seasonalMarkupRate(-1, 60, seasonal)).toBe(0);
    expect(seasonalMarkupRate(10, 60, settings)).toBe(0);
  });

  it("applies to a price", () => {
    expect(applyMarkup(2489, 0.05)).toBe(2613);
  });
});
