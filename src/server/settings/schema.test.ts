import { describe, expect, it } from "vitest";
import { defaultSettings, settingsSchema } from "./schema";
import { mergeWithDefaults } from "./service";

const env = { MIN_PROFIT: 300, MAX_ACCEPTABLE_LOSS: 100, DEMAND_THRESHOLD: 60 };

describe("settings", () => {
  it("produces defaults that satisfy the schema", () => {
    expect(settingsSchema.parse(defaultSettings(env))).toEqual(defaultSettings(env));
  });

  it("matches the documented defaults", () => {
    const settings = defaultSettings(env);
    expect(settings.fees.ebay).toEqual({ feeRate: 0.1325, fixedFeeCents: 30 });
    expect(settings.fees.amazon.feeRate).toBe(0.15);
    expect(settings.fees.returnsBufferRate).toBe(0.06);
    expect(settings.listing).toMatchObject({ manualApprove: true, maxActiveListings: 20 });
    expect(settings.orders.maxAcceptableLossCents).toBe(100);
    expect(settings.repricer.defaultStrategy).toBe("SLIGHTLY_BELOW");
  });

  it("takes env-driven defaults from the environment", () => {
    const settings = defaultSettings({ MIN_PROFIT: 450, MAX_ACCEPTABLE_LOSS: 0, DEMAND_THRESHOLD: 75 });
    expect(settings.pricing.minProfitCents).toBe(450);
    expect(settings.orders.maxAcceptableLossCents).toBe(0);
    expect(settings.demand.threshold).toBe(75);
  });

  it("fills settings missing from an older stored row with defaults, keeping stored values", () => {
    const stored = structuredClone(defaultSettings(env)) as { fees: { ebay: { feeRate: number } }; listing: Record<string, unknown> };
    stored.fees.ebay.feeRate = 0.2;
    delete stored.listing.deliveryPromiseDays;
    const merged = settingsSchema.parse(mergeWithDefaults(defaultSettings(env), stored));
    expect(merged.fees.ebay.feeRate).toBe(0.2);
    expect(merged.listing.deliveryPromiseDays).toEqual({ ebay: 10, amazon: 8 });
  });

  it("rejects rates outside 0–1", () => {
    const settings = defaultSettings(env);
    settings.fees.ebay.feeRate = 13.25;
    expect(settingsSchema.safeParse(settings).success).toBe(false);
  });

  it("rejects a review threshold above the confirm threshold", () => {
    const settings = defaultSettings(env);
    settings.matching.reviewThreshold = 0.9;
    expect(settingsSchema.safeParse(settings).success).toBe(false);
  });

  it("rejects an undercut range that is inverted", () => {
    const settings = defaultSettings(env);
    settings.repricer.undercutMinCents = 60;
    expect(settingsSchema.safeParse(settings).success).toBe(false);
  });
});
