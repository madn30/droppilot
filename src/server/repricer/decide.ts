import type { RepricerStrategy } from "@prisma/client";
import { resolveListingPriceCents, roundDownToPriceEnding, roundUpToPriceEnding } from "../pricing/engine";
import type { Settings } from "../settings/schema";

export interface CompetitorOffer {
  /** Price plus shipping: what the buyer actually pays. */
  totalCents: number;
  deliveryDays: number | null;
  /** Seller rating as a percentage (0–100), or null when unknown. */
  sellerRating: number | null;
}

export interface RepriceInput {
  strategy: RepricerStrategy;
  floorCents: number;
  /** Confirmed matches only. */
  competitors: CompetitorOffer[];
  /** Our processing + slowest delivery estimate. */
  ourDeliveryDays: number;
  /** Price for a product nobody else sells (the margin target). */
  uniquePriceCents: number;
  repricer: Settings["repricer"];
  maxMarkupRate: number;
}

export type RepriceReason = "UNIQUE" | "UNDERCUT" | "MATCH" | "PREMIUM" | "FLOOR";

export interface RepriceDecision {
  priceCents: number;
  /** True when the competitor is below our floor and the setting says to pause rather than sit at the floor. */
  pause: boolean;
  reason: RepriceReason;
  /** The competitor price the decision was measured against, when there is one. */
  referenceCents: number | null;
}

// Sellers rated below this, or this many days slower than us, are not who a buyer compares us with.
const MIN_COMPARABLE_RATING = 80;
const MAX_EXTRA_DELIVERY_DAYS = 7;

/** Amazon rates sellers out of 5 stars, eBay as a percentage; both become a percentage. */
export function ratingAsPercent(rating: number | null): number | null {
  if (rating === null) return null;
  return rating <= 5 ? rating * 20 : rating;
}

function isComparable(offer: CompetitorOffer, ourDeliveryDays: number): boolean {
  const ratingOk = offer.sellerRating === null || offer.sellerRating >= MIN_COMPARABLE_RATING;
  const speedOk = offer.deliveryDays === null || offer.deliveryDays <= ourDeliveryDays + MAX_EXTRA_DELIVERY_DAYS;
  return ratingOk && speedOk;
}

/**
 * Decides a listing's price from its confirmed competitors.
 *  - No competitors: the margin-target price.
 *  - Otherwise the reference is the cheapest *comparable* competitor by total price
 *    (poorly rated or much slower sellers are ignored; if none is comparable, the cheapest of all).
 *  - cheapest: the largest undercut; slightly_below: the smallest undercut; match: at the reference;
 *    premium: above the reference by up to the max markup, but only when we deliver faster than every comparable seller.
 *  - Prices end in .89/.99 and never go below the floor.
 */
export function decidePrice(input: RepriceInput): RepriceDecision {
  const floorPrice = roundUpToPriceEnding(input.floorCents);

  if (input.competitors.length === 0) {
    return {
      priceCents: resolveListingPriceCents(input.uniquePriceCents, input.floorCents),
      pause: false,
      reason: "UNIQUE",
      referenceCents: null,
    };
  }

  const comparable = input.competitors.filter((offer) => isComparable(offer, input.ourDeliveryDays));
  const considered = comparable.length > 0 ? comparable : input.competitors;
  const referenceCents = Math.min(...considered.map((offer) => offer.totalCents));

  const knownSpeeds = comparable.flatMap((offer) => (offer.deliveryDays === null ? [] : [offer.deliveryDays]));
  const weAreFastest =
    comparable.length === 0 || (knownSpeeds.length === comparable.length && knownSpeeds.every((days) => input.ourDeliveryDays < days));

  let targetCents: number;
  let reason: RepriceReason;
  switch (input.strategy) {
    case "CHEAPEST":
      targetCents = referenceCents - input.repricer.undercutMaxCents;
      reason = "UNDERCUT";
      break;
    case "SLIGHTLY_BELOW":
      targetCents = referenceCents - input.repricer.undercutMinCents;
      reason = "UNDERCUT";
      break;
    case "PREMIUM":
      if (weAreFastest) {
        targetCents = Math.round(referenceCents * (1 + input.maxMarkupRate));
        reason = "PREMIUM";
      } else {
        targetCents = referenceCents;
        reason = "MATCH";
      }
      break;
    case "MATCH":
      targetCents = referenceCents;
      reason = "MATCH";
      break;
  }

  const rounded = roundDownToPriceEnding(targetCents);
  if (rounded === null || rounded < input.floorCents) {
    // Undercutting would lose money. If even the competitor's own price is below our floor we cannot compete at all.
    const competitorBelowFloor = referenceCents < floorPrice;
    return {
      priceCents: floorPrice,
      pause: competitorBelowFloor && input.repricer.belowFloorAction === "PAUSE",
      reason: "FLOOR",
      referenceCents,
    };
  }
  return { priceCents: rounded, pause: false, reason, referenceCents };
}
