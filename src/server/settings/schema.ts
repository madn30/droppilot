import { z } from "zod";
import type { Env } from "../env";

// Rates are fractions (0.1325 = 13.25%); money is integer cents.
const rate = z.number().min(0).max(1);
const cents = z.number().int().min(0);
const wholeNumber = z.number().int().min(0);

export const REPRICER_STRATEGIES = ["CHEAPEST", "MATCH", "SLIGHTLY_BELOW", "PREMIUM"] as const;
export const BELOW_FLOOR_ACTIONS = ["STAY_AT_FLOOR", "PAUSE"] as const;

const marketplaceFees = z.object({ feeRate: rate, fixedFeeCents: cents });

export const settingsSchema = z.object({
  fees: z.object({
    ebay: marketplaceFees,
    amazon: marketplaceFees,
    paymentFeeRate: rate,
    returnsBufferRate: rate,
  }),
  pricing: z.object({
    minProfitCents: cents,
    priceBufferRate: rate,
    seasonalMarkupRate: rate,
    uniqueMarginTargetRate: rate,
    maxMarkupRate: rate,
  }),
  repricer: z
    .object({
      defaultStrategy: z.enum(REPRICER_STRATEGIES),
      undercutMinCents: cents,
      undercutMaxCents: cents,
      belowFloorAction: z.enum(BELOW_FLOOR_ACTIONS),
      checkIntervalMinutes: z.number().int().min(1),
      topSellerIntervalMinutes: z.number().int().min(1),
    })
    .refine((repricer) => repricer.undercutMinCents <= repricer.undercutMaxCents, {
      path: ["undercutMaxCents"],
      message: "Must be at least the minimum undercut.",
    }),
  matching: z
    .object({
      confirmThreshold: rate,
      reviewThreshold: rate,
      imageMatchThreshold: rate,
      sizeToleranceRate: rate,
      weights: z.object({ image: rate, spec: rate, vision: rate }),
    })
    .refine((matching) => matching.reviewThreshold <= matching.confirmThreshold, {
      path: ["reviewThreshold"],
      message: "Must not exceed the confirm threshold.",
    }),
  demand: z.object({
    threshold: z.number().min(0).max(100),
    marketplaceInsightsEnabled: z.boolean(),
    weights: z.object({
      salesVelocity: rate,
      trendDirection: rate,
      competition: rate,
      profitMargin: rate,
      deliverySpeed: rate,
    }),
  }),
  discovery: z.object({
    // Trending supplier products evaluated per daily run; 0 turns trending discovery off.
    trendingProductsPerRun: wholeNumber,
    // How many of the evaluated products are listed (as drafts while manual approve is on).
    trendingAutoListTopN: wholeNumber,
  }),
  listing: z.object({
    manualApprove: z.boolean(),
    maxActiveListings: wholeNumber,
    listingGrowthPerWeek: wholeNumber,
    // Longest processing + delivery time (in days) a listing may promise on each marketplace.
    deliveryPromiseDays: z.object({ ebay: z.number().int().min(1), amazon: z.number().int().min(1) }),
    // eBay listings state a US item location, so only US-warehouse stock is listed while this is on. Amazon is always US-only.
    ebayUsWarehouseOnly: z.boolean(),
  }),
  orders: z.object({
    maxAcceptableLossCents: cents,
    pollIntervalMinutes: z.number().int().min(1),
    // On: supplier orders are paid from the supplier balance. Off: they are created unpaid and the admin pays each one at the supplier.
    payFromSupplierBalance: z.boolean(),
  }),
  health: z.object({
    pauseNewListingsNearLimit: z.boolean(),
    amazon: z.object({
      maxOrderDefectRate: rate,
      maxLateShipmentRate: rate,
      maxCancellationRate: rate,
      minValidTrackingRate: rate,
    }),
    ebay: z.object({ maxDefectRate: rate }),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;

type EnvDefaults = Pick<Env, "MIN_PROFIT" | "MAX_ACCEPTABLE_LOSS" | "DEMAND_THRESHOLD">;

// Used to seed the Settings row; afterwards the row is the source of truth.
export function defaultSettings(env: EnvDefaults): Settings {
  return {
    fees: {
      // eBay's 13.25% final value fee already includes payment processing.
      ebay: { feeRate: 0.1325, fixedFeeCents: 30 },
      amazon: { feeRate: 0.15, fixedFeeCents: 0 },
      paymentFeeRate: 0,
      returnsBufferRate: 0.06,
    },
    pricing: {
      minProfitCents: env.MIN_PROFIT,
      priceBufferRate: 0.03,
      seasonalMarkupRate: 0,
      uniqueMarginTargetRate: 0.25,
      maxMarkupRate: 0.2,
    },
    repricer: {
      defaultStrategy: "SLIGHTLY_BELOW",
      undercutMinCents: 10,
      undercutMaxCents: 50,
      belowFloorAction: "STAY_AT_FLOOR",
      checkIntervalMinutes: 120,
      topSellerIntervalMinutes: 30,
    },
    matching: {
      confirmThreshold: 0.85,
      reviewThreshold: 0.6,
      imageMatchThreshold: 0.85,
      sizeToleranceRate: 0.1,
      weights: { image: 0.4, spec: 0.3, vision: 0.3 },
    },
    demand: {
      threshold: env.DEMAND_THRESHOLD,
      marketplaceInsightsEnabled: false,
      weights: {
        salesVelocity: 0.3,
        trendDirection: 0.2,
        competition: 0.2,
        profitMargin: 0.2,
        deliverySpeed: 0.1,
      },
    },
    discovery: {
      trendingProductsPerRun: 5,
      trendingAutoListTopN: 3,
    },
    listing: {
      manualApprove: true,
      maxActiveListings: 20,
      listingGrowthPerWeek: 0,
      deliveryPromiseDays: { ebay: 10, amazon: 8 },
      ebayUsWarehouseOnly: true,
    },
    orders: {
      maxAcceptableLossCents: env.MAX_ACCEPTABLE_LOSS,
      pollIntervalMinutes: 10,
      payFromSupplierBalance: true,
    },
    health: {
      pauseNewListingsNearLimit: true,
      amazon: {
        maxOrderDefectRate: 0.01,
        maxLateShipmentRate: 0.04,
        maxCancellationRate: 0.025,
        minValidTrackingRate: 0.95,
      },
      ebay: { maxDefectRate: 0.02 },
    },
  };
}
