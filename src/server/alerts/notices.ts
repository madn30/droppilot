import type { Listing, Marketplace, ProductVariant } from "@prisma/client";
import { getEnv } from "../env";
import { listingUrl } from "../marketplaces";
import { computeProfitCents } from "../pricing/engine";
import type { Settings } from "../settings/schema";
import { supplierProductUrl } from "../suppliers";

// Wording shared by the messages that tell the admin what the system just did.

export function formatMoney(cents: number): string {
  return `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

export function marketplaceName(marketplace: Marketplace): string {
  return marketplace === "EBAY" ? "eBay" : "Amazon";
}

/** "Price: $24.89 → $25.99", or "Price: $24.89 (unchanged)". */
export function fromTo<T>(label: string, before: T, after: T, format: (value: T) => string): string {
  return before === after ? `${label}: ${format(after)} (unchanged)` : `${label}: ${format(before)} → ${format(after)}`;
}

type NoticeListing = Pick<Listing, "title" | "sku" | "marketplace" | "externalId" | "priceCents" | "floorCents" | "quantity">;
type NoticeVariant = Pick<
  ProductVariant,
  "costCents" | "shippingCents" | "warehouse" | "stock" | "processingDays" | "deliveryDaysMin" | "deliveryDaysMax"
>;
interface NoticeProduct {
  externalId: string;
  supplier: { code: string; name: string };
}

/** What identifies a listing in a message: its title, SKU and marketplace id. */
export function listingHeader(listing: NoticeListing): string[] {
  const id = listing.externalId ? ` · ${marketplaceName(listing.marketplace)} item ${listing.externalId}` : "";
  return [listing.title, `SKU ${listing.sku}${id}`];
}

/** Supplier side of a listing: cost, stock and how long delivery takes. */
export function supplierLines(variant: NoticeVariant, product: NoticeProduct): string[] {
  return [
    `Supplier: ${product.supplier.name}, ${variant.warehouse} warehouse, ${variant.stock} in stock`,
    `Delivery: ${variant.processingDays} days processing + ${variant.deliveryDaysMin}–${variant.deliveryDaysMax} days shipping`,
  ];
}

/** Links to the listing on its marketplace and to the product at the supplier; none in mock mode. */
export function linkLines(listing: NoticeListing, product: NoticeProduct): string[] {
  const env = getEnv();
  const marketplaceLink = listingUrl(env, listing.marketplace, listing.externalId);
  const supplierLink = supplierProductUrl(env, product.supplier.code, product.externalId);
  return [
    ...(marketplaceLink ? [`${marketplaceName(listing.marketplace)}: ${marketplaceLink}`] : []),
    ...(supplierLink ? [`${product.supplier.name}: ${supplierLink}`] : []),
  ];
}

/** Everything about a listing as it stands: price, floor, cost, profit, supplier and links. */
export function listingDetails(listing: NoticeListing, variant: NoticeVariant, product: NoticeProduct, settings: Settings): string[] {
  const profit = computeProfitCents(listing.priceCents, variant, listing.marketplace, settings);
  return [
    ...listingHeader(listing),
    `Price ${formatMoney(listing.priceCents)} · floor ${formatMoney(listing.floorCents)} · quantity ${listing.quantity}`,
    `Cost ${formatMoney(variant.costCents)} + ${formatMoney(variant.shippingCents)} shipping · expected profit ${formatMoney(profit)} per sale`,
    ...supplierLines(variant, product),
    ...linkLines(listing, product),
  ];
}
