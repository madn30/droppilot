import type { Marketplace } from "@prisma/client";
import type { Settings } from "../settings/schema";

export interface SupplierCost {
  costCents: number;
  shippingCents: number;
}

// Listing prices always end in .89 or .99.
const PRICE_ENDINGS = [89, 99] as const;

function marketplaceFees(settings: Settings, marketplace: Marketplace): { feeRate: number; fixedFeeCents: number } {
  return marketplace === "EBAY" ? settings.fees.ebay : settings.fees.amazon;
}

/** Share of the sale price we keep after percentage fees and the returns buffer. */
function keepRate(settings: Settings, marketplace: Marketplace): number {
  return 1 - marketplaceFees(settings, marketplace).feeRate - settings.fees.paymentFeeRate - settings.fees.returnsBufferRate;
}

/**
 * Lowest price that still earns the minimum profit:
 *   floor = (cost + shipping + MIN_PROFIT + fixed fee) / (1 - marketplaceFee - paymentFee - returnsBuffer)
 * The supplier cost is first inflated by the price buffer, so a small supplier
 * increase does not immediately push a listing below its floor.
 */
export function computeFloorCents(cost: SupplierCost, marketplace: Marketplace, settings: Settings): number {
  const rate = keepRate(settings, marketplace);
  if (rate <= 0) {
    throw new Error(`Fees and buffers for ${marketplace} add up to 100% or more; no price can be profitable`);
  }
  const bufferedCost = (cost.costCents + cost.shippingCents) * (1 + settings.pricing.priceBufferRate);
  const fixed = settings.pricing.minProfitCents + marketplaceFees(settings, marketplace).fixedFeeCents;
  return Math.ceil((bufferedCost + fixed) / rate);
}

/** Profit at a given price against the supplier's actual (unbuffered) cost. Negative means a loss. */
export function computeProfitCents(
  priceCents: number,
  cost: SupplierCost,
  marketplace: Marketplace,
  settings: Settings,
): number {
  const kept = priceCents * keepRate(settings, marketplace) - marketplaceFees(settings, marketplace).fixedFeeCents;
  return Math.round(kept - cost.costCents - cost.shippingCents);
}

/** Smallest price ending in .89 or .99 that is at least `cents`. */
export function roundUpToPriceEnding(cents: number): number {
  const whole = Math.ceil(cents);
  const dollars = Math.floor(whole / 100) * 100;
  for (const ending of PRICE_ENDINGS) {
    if (dollars + ending >= whole) return dollars + ending;
  }
  return dollars + 100 + PRICE_ENDINGS[0];
}

/** Largest price ending in .89 or .99 that is at most `cents`; null when `cents` is below $0.89. */
export function roundDownToPriceEnding(cents: number): number | null {
  const whole = Math.floor(cents);
  const dollars = Math.floor(whole / 100) * 100;
  for (const ending of [...PRICE_ENDINGS].reverse()) {
    if (dollars + ending <= whole) return dollars + ending;
  }
  const previous = dollars - 100 + PRICE_ENDINGS[PRICE_ENDINGS.length - 1];
  return previous > 0 ? previous : null;
}

/**
 * Turns a target price into a listing price: the nearest .89/.99 at or below
 * the target, but never below the floor (the floor is rounded up instead).
 */
export function resolveListingPriceCents(targetCents: number, floorCents: number): number {
  const rounded = roundDownToPriceEnding(targetCents);
  if (rounded === null || rounded < floorCents) return roundUpToPriceEnding(floorCents);
  return rounded;
}

/** Target price for a product with no confirmed competitors: priced to the margin target. */
export function marginTargetPriceCents(cost: SupplierCost, marketplace: Marketplace, settings: Settings): number {
  const rate = keepRate(settings, marketplace) - settings.pricing.uniqueMarginTargetRate;
  if (rate <= 0) {
    throw new Error(`Margin target leaves no room after ${marketplace} fees and buffers`);
  }
  const base = cost.costCents + cost.shippingCents + marketplaceFees(settings, marketplace).fixedFeeCents;
  return Math.ceil(base / rate);
}

/**
 * Seasonal markup that ramps linearly from 0 when the listing window opens to
 * the full configured rate on the event date. 0 outside the window.
 */
export function seasonalMarkupRate(daysUntilEvent: number, listStartDaysBefore: number, settings: Settings): number {
  if (listStartDaysBefore <= 0 || daysUntilEvent < 0 || daysUntilEvent > listStartDaysBefore) return 0;
  return settings.pricing.seasonalMarkupRate * (1 - daysUntilEvent / listStartDaysBefore);
}

export function applyMarkup(priceCents: number, markupRate: number): number {
  return Math.round(priceCents * (1 + markupRate));
}
