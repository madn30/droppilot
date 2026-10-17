import { describe, expect, it } from "vitest";
import { defaultSettings } from "../settings/schema";
import { type CompetitorOffer, type RepriceInput, decidePrice, ratingAsPercent } from "./decide";

const settings = defaultSettings({ MIN_PROFIT: 300, MAX_ACCEPTABLE_LOSS: 100, DEMAND_THRESHOLD: 60 });

// The scenario's two confirmed competitors.
const D: CompetitorOffer = { totalCents: 2699, deliveryDays: 7, sellerRating: 98.9 };
const F: CompetitorOffer = { totalCents: 2499, deliveryDays: 5, sellerRating: 88 };

function input(overrides: Partial<RepriceInput> = {}): RepriceInput {
  return {
    strategy: "SLIGHTLY_BELOW",
    floorCents: 2463,
    competitors: [D, F],
    ourDeliveryDays: 7,
    uniquePriceCents: 2989,
    repricer: settings.repricer,
    maxMarkupRate: settings.pricing.maxMarkupRate,
    ...overrides,
  };
}

describe("decidePrice", () => {
  it("prices the scenario at $24.89: $0.10 under the cheapest confirmed competitor", () => {
    expect(decidePrice(input())).toEqual({ priceCents: 2489, pause: false, reason: "UNDERCUT", referenceCents: 2499 });
  });

  it("undercuts by the maximum with the cheapest strategy", () => {
    // 24.99 − 0.50 = 24.49 → the nearest ending at or below is 23.99, which is under the floor.
    expect(decidePrice(input({ strategy: "CHEAPEST" }))).toMatchObject({ priceCents: 2489, reason: "FLOOR" });
    expect(decidePrice(input({ strategy: "CHEAPEST", floorCents: 2000 }))).toMatchObject({ priceCents: 2399, reason: "UNDERCUT" });
  });

  it("matches the reference price without exceeding it", () => {
    expect(decidePrice(input({ strategy: "MATCH" }))).toMatchObject({ priceCents: 2499, reason: "MATCH" });
    expect(decidePrice(input({ strategy: "MATCH", competitors: [{ ...F, totalCents: 2550 }] }))).toMatchObject({ priceCents: 2499 });
  });

  it("uses total price, not the item price alone", () => {
    // A $19.99 item with $6 shipping costs the buyer $25.99.
    const cheapItemDearShipping: CompetitorOffer = { totalCents: 2599, deliveryDays: 6, sellerRating: 99 };
    expect(decidePrice(input({ competitors: [cheapItemDearShipping] }))).toMatchObject({ priceCents: 2589, referenceCents: 2599 });
  });

  it("ignores a cheaper competitor with a poor seller rating or much slower delivery", () => {
    const badSeller: CompetitorOffer = { totalCents: 2299, deliveryDays: 5, sellerRating: 62 };
    const slowBoat: CompetitorOffer = { totalCents: 2199, deliveryDays: 25, sellerRating: 99 };
    expect(decidePrice(input({ competitors: [D, F, badSeller, slowBoat] }))).toMatchObject({ priceCents: 2489, referenceCents: 2499 });
  });

  it("falls back to the cheapest of all when no competitor is comparable", () => {
    const slowBoat: CompetitorOffer = { totalCents: 2799, deliveryDays: 25, sellerRating: 99 };
    expect(decidePrice(input({ competitors: [slowBoat] }))).toMatchObject({ priceCents: 2789, referenceCents: 2799 });
  });

  it("prices a unique product at the margin target", () => {
    expect(decidePrice(input({ competitors: [] }))).toEqual({ priceCents: 2989, pause: false, reason: "UNIQUE", referenceCents: null });
  });

  describe("premium strategy", () => {
    it("prices above the reference by up to the max markup when we are the fastest", () => {
      // 24.99 × 1.20 = 29.99.
      expect(decidePrice(input({ strategy: "PREMIUM", ourDeliveryDays: 3 }))).toMatchObject({ priceCents: 2999, reason: "PREMIUM" });
    });

    it("only matches when a comparable competitor is as fast or faster, or its speed is unknown", () => {
      expect(decidePrice(input({ strategy: "PREMIUM", ourDeliveryDays: 5 }))).toMatchObject({ priceCents: 2499, reason: "MATCH" });
      const unknownSpeed = { ...D, deliveryDays: null };
      expect(decidePrice(input({ strategy: "PREMIUM", ourDeliveryDays: 3, competitors: [unknownSpeed] }))).toMatchObject({ reason: "MATCH" });
    });
  });

  describe("floor", () => {
    it("stays at the floor when the supplier raises its price by $1", () => {
      // Floor $25.90 is now above the cheapest competitor ($24.99).
      expect(decidePrice(input({ floorCents: 2590 }))).toEqual({ priceCents: 2599, pause: false, reason: "FLOOR", referenceCents: 2499 });
    });

    it("pauses instead when that is the configured action", () => {
      const pausing = { ...settings.repricer, belowFloorAction: "PAUSE" as const };
      expect(decidePrice(input({ floorCents: 2590, repricer: pausing }))).toMatchObject({ priceCents: 2599, pause: true });
    });

    it("does not pause when only the undercut, not the competitor itself, is below the floor", () => {
      const pausing = { ...settings.repricer, belowFloorAction: "PAUSE" as const };
      // Floor 24.95 → we can sell at 24.99, level with the competitor.
      expect(decidePrice(input({ floorCents: 2495, repricer: pausing }))).toMatchObject({ priceCents: 2499, pause: false, reason: "FLOOR" });
    });

    it("never returns a price below the floor, whatever the strategy", () => {
      for (const strategy of ["CHEAPEST", "MATCH", "SLIGHTLY_BELOW", "PREMIUM"] as const) {
        for (const floorCents of [1500, 2463, 2490, 2590, 4000]) {
          expect(decidePrice(input({ strategy, floorCents })).priceCents).toBeGreaterThanOrEqual(floorCents);
        }
      }
    });
  });
});

describe("ratingAsPercent", () => {
  it("converts star ratings and keeps percentages", () => {
    expect(ratingAsPercent(4.4)).toBeCloseTo(88);
    expect(ratingAsPercent(98.9)).toBe(98.9);
    expect(ratingAsPercent(null)).toBeNull();
  });
});
