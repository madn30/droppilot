import type { Marketplace, PriceChangeReason, RepricerStrategy } from "@prisma/client";
import { db } from "../db";
import type { MarketplaceAdapter } from "../marketplaces/types";
import {
  applyMarkup,
  computeFloorCents,
  marginTargetPriceCents,
  roundDownToPriceEnding,
  roundUpToPriceEnding,
  seasonalMarkupRate,
} from "../pricing/engine";
import { daysBetween, occurrenceOnOrAfter } from "../seasonal/calendar";
import type { Settings } from "../settings/schema";
import { type RepriceDecision, decidePrice, ratingAsPercent } from "./decide";

export interface RepricerDeps {
  getMarketplace: (marketplace: Marketplace) => MarketplaceAdapter;
  settings: Settings;
  now?: () => Date;
}

interface PricedVariant {
  id: string;
  costCents: number;
  shippingCents: number;
  processingDays: number;
  deliveryDaysMax: number;
  repricerStrategy: RepricerStrategy;
}

/**
 * The price a variant should have on a marketplace right now, from its
 * confirmed matches (on every marketplace: a buyer can shop on any of them).
 */
export async function priceVariant(
  variant: PricedVariant,
  marketplace: Marketplace,
  settings: Settings,
): Promise<{ decision: RepriceDecision; floorCents: number }> {
  const matches = await db.productMatch.findMany({
    where: { variantId: variant.id, status: "CONFIRMED" },
    include: { competitorListing: true },
  });
  const cost = { costCents: variant.costCents, shippingCents: variant.shippingCents };
  const floorCents = computeFloorCents(cost, marketplace, settings);
  const decision = decidePrice({
    strategy: variant.repricerStrategy,
    floorCents,
    competitors: matches.map(({ competitorListing }) => ({
      totalCents: competitorListing.priceCents + competitorListing.shippingCents,
      deliveryDays: competitorListing.deliveryDays,
      sellerRating: ratingAsPercent(competitorListing.sellerRating),
    })),
    ourDeliveryDays: variant.processingDays + variant.deliveryDaysMax,
    uniquePriceCents: roundUpToPriceEnding(marginTargetPriceCents(cost, marketplace, settings)),
    repricer: settings.repricer,
    maxMarkupRate: settings.pricing.maxMarkupRate,
  });
  return { decision, floorCents };
}

export interface RepriceResult {
  listingId: string;
  priceCents: number;
  priceChanged: boolean;
  paused: boolean;
  resumed: boolean;
}

/**
 * Re-prices one listing and applies the result to the marketplace and the
 * database. Running it again with nothing changed does nothing.
 */
export async function repriceListing(
  listingId: string,
  deps: RepricerDeps,
  options: { supplierCostChanged?: boolean } = {},
): Promise<RepriceResult> {
  const now = deps.now?.() ?? new Date();
  const listing = await db.listing.findUniqueOrThrow({ where: { id: listingId }, include: { variant: true, holiday: true } });
  const { decision, floorCents } = await priceVariant(listing.variant, listing.marketplace, deps.settings);

  // Optional seasonal markup, growing as the holiday approaches; it never pushes below the floor.
  let priceCents = decision.priceCents;
  let seasonal = false;
  if (listing.holiday && listing.cutoffDate) {
    const holidayDate = occurrenceOnOrAfter(listing.holiday.dateRule, listing.cutoffDate);
    const rate = seasonalMarkupRate(daysBetween(now, holidayDate), listing.holiday.listStartDaysBefore, deps.settings);
    if (rate > 0) {
      const marked = roundDownToPriceEnding(applyMarkup(priceCents, rate));
      if (marked !== null && marked > priceCents) {
        priceCents = marked;
        seasonal = true;
      }
    }
  }

  const live = listing.externalId !== null && (listing.status === "ACTIVE" || listing.status === "PAUSED");
  const ref = { externalId: listing.externalId ?? "", sku: listing.sku };
  const adapter = live ? deps.getMarketplace(listing.marketplace) : null;
  const pausedBelowFloor = listing.status === "PAUSED" && listing.pauseReason === "BELOW_FLOOR";

  if (decision.pause) {
    if (listing.status === "ACTIVE") {
      if (adapter) await adapter.updateListing(ref, { quantity: 0 });
      await db.listing.update({
        where: { id: listing.id },
        data: { status: "PAUSED", pauseReason: "BELOW_FLOOR", floorCents, lastRepricedAt: now },
      });
    }
    return { listingId, priceCents: listing.priceCents, priceChanged: false, paused: listing.status === "ACTIVE", resumed: false };
  }

  const priceChanged = priceCents !== listing.priceCents;
  // A listing paused for any other reason keeps its pause; only its stored price is refreshed.
  const sellable = listing.status === "ACTIVE" || pausedBelowFloor;
  if (adapter && sellable && (priceChanged || pausedBelowFloor)) {
    await adapter.updateListing(ref, {
      ...(priceChanged ? { priceCents } : {}),
      ...(pausedBelowFloor ? { quantity: listing.quantity } : {}),
    });
  }

  if (priceChanged) {
    const reason: PriceChangeReason = options.supplierCostChanged
      ? "SUPPLIER_COST"
      : seasonal
        ? "SEASONAL"
        : decision.reason === "FLOOR"
          ? "FLOOR"
          : "REPRICE";
    await db.priceHistory.create({
      data: { listingId: listing.id, priceCents, floorCents, costCents: listing.variant.costCents, reason, createdAt: now },
    });
  }
  await db.listing.update({
    where: { id: listing.id },
    data: {
      priceCents,
      floorCents,
      lastRepricedAt: now,
      ...(pausedBelowFloor ? { status: "ACTIVE", pauseReason: null } : {}),
    },
  });
  return { listingId, priceCents, priceChanged, paused: false, resumed: pausedBelowFloor };
}
