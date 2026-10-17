import type { Marketplace } from "@prisma/client";
import type { Settings } from "../settings/schema";

/** A listing action that the compliance rules forbid. Never retried, always surfaced. */
export class ComplianceError extends Error {
  constructor(
    readonly rule: "DROPSHIP_SUPPLIER" | "BLIND_SHIPPING" | "DELIVERY_PROMISE" | "LISTING_LIMIT" | "TRADEMARK" | "ACCOUNT_HEALTH" | "US_WAREHOUSE",
    message: string,
  ) {
    super(message);
    this.name = "ComplianceError";
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Only dropshipping/wholesale suppliers may be sourced from: never retail arbitrage. */
export function assertDropshipSupplier(supplier: { code: string; isDropshipSupplier: boolean }): void {
  if (!supplier.isDropshipSupplier) {
    throw new ComplianceError("DROPSHIP_SUPPLIER", `Supplier "${supplier.code}" is not a dropshipping supplier`);
  }
}

/** On Amazon we are the seller of record, so the supplier must ship without its own branding or invoices. */
export function assertBlindShippingForAmazon(marketplace: Marketplace, supplier: { code: string; supportsBlindShipping: boolean }): void {
  if (marketplace === "AMAZON" && !supplier.supportsBlindShipping) {
    throw new ComplianceError("BLIND_SHIPPING", `Supplier "${supplier.code}" cannot ship blind, which Amazon listings require`);
  }
}

/**
 * Whether a variant's warehouse may be listed on the marketplace. Amazon listings always ship from a
 * United States warehouse (a commitment in the account's plan of action). eBay listings do too while the
 * setting is on: the listing's item location is the US warehouse, which would be false for other stock.
 */
export function shipsFromAllowedWarehouse(marketplace: Marketplace, variant: { warehouse: string }, settings: Settings["listing"]): boolean {
  const usOnly = marketplace === "AMAZON" || settings.ebayUsWarehouseOnly;
  return !usOnly || variant.warehouse === "US";
}

export function assertAllowedWarehouse(marketplace: Marketplace, variant: { sku: string; warehouse: string }, settings: Settings["listing"]): void {
  if (!shipsFromAllowedWarehouse(marketplace, variant, settings)) {
    throw new ComplianceError(
      "US_WAREHOUSE",
      `${variant.sku} ships from the ${variant.warehouse} warehouse; ${marketplace === "AMAZON" ? "Amazon" : "eBay"} listings must ship from a United States warehouse`,
    );
  }
}

/** Never list a product whose estimated delivery exceeds what the marketplace listing may promise. */
/** Whether processing plus delivery fits the marketplace's delivery promise. */
export function deliversWithinPromise(
  marketplace: Marketplace,
  variant: { processingDays: number; deliveryDaysMax: number },
  settings: Settings["listing"],
): boolean {
  const promise = marketplace === "EBAY" ? settings.deliveryPromiseDays.ebay : settings.deliveryPromiseDays.amazon;
  return variant.processingDays + variant.deliveryDaysMax <= promise;
}

export function assertDeliveryWithinPromise(
  marketplace: Marketplace,
  variant: { processingDays: number; deliveryDaysMax: number },
  settings: Settings["listing"],
): void {
  const promise = marketplace === "EBAY" ? settings.deliveryPromiseDays.ebay : settings.deliveryPromiseDays.amazon;
  const total = variant.processingDays + variant.deliveryDaysMax;
  if (!deliversWithinPromise(marketplace, variant, settings)) {
    throw new ComplianceError(
      "DELIVERY_PROMISE",
      `Delivery takes up to ${total} days (processing ${variant.processingDays} + delivery ${variant.deliveryDaysMax}), over the ${promise}-day promise for ${marketplace}`,
    );
  }
}

/** How many listings may be live now: the starting limit plus the weekly growth since the first listing went live. */
export function allowedLiveListings(settings: Settings["listing"], firstListedAt: Date | null, now: Date): number {
  const weeks = firstListedAt ? Math.floor((now.getTime() - firstListedAt.getTime()) / WEEK_MS) : 0;
  return settings.maxActiveListings + Math.max(0, weeks) * settings.listingGrowthPerWeek;
}

export function assertListingLimit(liveListings: number, settings: Settings["listing"], firstListedAt: Date | null, now: Date): void {
  const allowed = allowedLiveListings(settings, firstListedAt, now);
  if (liveListings >= allowed) {
    throw new ComplianceError("LISTING_LIMIT", `${liveListings} listings are live; the account limit is currently ${allowed}`);
  }
}

// Brand names and protected marks that must never appear in a title or description.
// The copy generator is told to avoid them; this list is the backstop for the best-known ones.
// Marks that are also everyday words (apple, coach, frozen…) are left out: they would block honest listings.
const TRADEMARKS = [
  "adidas", "airpods", "barbie", "bluey", "bose", "burberry", "cartier", "chanel", "disney", "dior", "dyson",
  "fendi", "gucci", "harry potter", "hello kitty", "hermes", "iphone", "ipad", "kindle", "lego", "louis vuitton",
  "marvel", "mickey mouse", "minecraft", "nba", "nfl", "nike", "nintendo", "pandora", "playstation", "pokemon",
  "prada", "ray-ban", "rolex", "samsung", "star wars", "swarovski", "taylor swift", "tiffany", "versace", "xbox",
];

/** Trademarks found in the text, lower case. */
export function findTrademarks(text: string): string[] {
  const normalized = text.toLowerCase();
  return TRADEMARKS.filter((mark) => new RegExp(`(^|[^a-z0-9])${mark.replace("-", "[- ]?")}([^a-z0-9]|$)`).test(normalized));
}

export function assertNoTrademarks(copy: { title: string; description: string }): void {
  const found = findTrademarks(`${copy.title}\n${copy.description}`);
  if (found.length > 0) {
    throw new ComplianceError("TRADEMARK", `Listing text contains brand names or trademarks: ${found.join(", ")}`);
  }
}
