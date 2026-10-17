import { formatMoney, fromTo, linkLines, listingHeader, marketplaceName, supplierLines } from "../alerts/notices";
import type { Notifier } from "../alerts/notifiers";
import { sendNotice } from "../alerts/service";
import { db } from "../db";
import { MAX_LISTING_QUANTITY } from "../listing/service";
import { computeProfitCents } from "../pricing/engine";
import { type RepricerDeps, repriceListing } from "../repricer/run";
import type { SupplierAdapter } from "../suppliers/types";

export interface SyncDeps extends RepricerDeps {
  supplier: SupplierAdapter;
  /** Told about every change a sync makes: price, pause, resume, quantity, supplier cost. */
  notifiers: Notifier[];
}

const PAUSE_REASONS: Record<string, string> = {
  OUT_OF_STOCK: "the supplier is out of stock",
  BELOW_FLOOR: "competitors sell below our price floor",
};

export interface SyncResult {
  listingId: string;
  costChanged: boolean;
  stock: number;
  outcome: "PAUSED_OUT_OF_STOCK" | "PAUSED_BELOW_FLOOR" | "RESUMED" | "REPRICED" | "UNCHANGED";
  priceCents: number;
}

/**
 * Brings one live listing in line with the supplier: refreshes cost and stock,
 * pauses it when the supplier is out of stock, resumes it when stock returns,
 * and re-prices it so a supplier price rise never eats the profit.
 * Safe to run repeatedly: with nothing changed it makes no marketplace calls.
 */
export async function syncListing(listingId: string, deps: SyncDeps): Promise<SyncResult> {
  const now = deps.now?.() ?? new Date();
  const listing = await loadForSync(listingId);
  const { variant } = listing;
  if (!listing.externalId) throw new Error(`Listing ${listing.sku} is not published and cannot be synced`);
  const ref = { externalId: listing.externalId, sku: listing.sku };
  const adapter = deps.getMarketplace(listing.marketplace);

  const supplierState = await deps.supplier.getStockAndPrice(variant.externalId);
  const stock = supplierState.stockByWarehouse[variant.warehouse] ?? 0;
  const costChanged = supplierState.costCents !== variant.costCents;
  await db.productVariant.update({
    where: { id: variant.id },
    data: { costCents: supplierState.costCents, stock, lastSyncedAt: now },
  });

  if (stock <= 0) {
    if (listing.status === "ACTIVE") {
      await adapter.updateListing(ref, { quantity: 0 });
      await db.listing.update({ where: { id: listing.id }, data: { status: "PAUSED", pauseReason: "OUT_OF_STOCK" } });
    }
    await announceChanges(listing, supplierState.costCents, stock, deps);
    return { listingId, costChanged, stock, outcome: "PAUSED_OUT_OF_STOCK", priceCents: listing.priceCents };
  }

  const quantity = Math.min(stock, MAX_LISTING_QUANTITY);
  const backInStock = listing.status === "PAUSED" && listing.pauseReason === "OUT_OF_STOCK";
  if (backInStock || (listing.status === "ACTIVE" && quantity !== listing.quantity)) {
    await adapter.updateListing(ref, { quantity });
    await db.listing.update({
      where: { id: listing.id },
      data: { quantity, ...(backInStock ? { status: "ACTIVE", pauseReason: null } : {}) },
    });
  }

  const repriced = await repriceListing(listing.id, deps, { supplierCostChanged: costChanged });
  const outcome = repriced.paused
    ? "PAUSED_BELOW_FLOOR"
    : backInStock || repriced.resumed
      ? "RESUMED"
      : repriced.priceChanged
        ? "REPRICED"
        : "UNCHANGED";
  await announceChanges(listing, supplierState.costCents, stock, deps);
  return { listingId, costChanged, stock, outcome, priceCents: repriced.priceCents };
}

type ListingBeforeSync = Awaited<ReturnType<typeof loadForSync>>;

function loadForSync(listingId: string) {
  return db.listing.findUniqueOrThrow({
    where: { id: listingId },
    include: { variant: { include: { product: { include: { supplier: true } } } } },
  });
}

/** Sends one message describing what this sync changed; nothing when it changed nothing. */
async function announceChanges(before: ListingBeforeSync, costCents: number, stock: number, deps: SyncDeps): Promise<void> {
  const after = await db.listing.findUniqueOrThrow({ where: { id: before.id } });
  const { variant } = before;
  const name = marketplaceName(before.marketplace);
  const changed = {
    status: after.status !== before.status,
    price: after.priceCents !== before.priceCents,
    quantity: after.quantity !== before.quantity,
    cost: costCents !== variant.costCents,
    floor: after.floorCents !== before.floorCents,
  };
  if (!Object.values(changed).some(Boolean)) return;

  const title = changed.status
    ? after.status === "PAUSED"
      ? `Paused on ${name}: ${PAUSE_REASONS[after.pauseReason ?? ""] ?? "see the Listings page"}`
      : `Back on sale on ${name}`
    : changed.price
      ? `Price changed on ${name}: ${formatMoney(before.priceCents)} → ${formatMoney(after.priceCents)}`
      : changed.cost
        ? `Supplier cost changed: ${formatMoney(variant.costCents)} → ${formatMoney(costCents)}`
        : changed.quantity
          ? `Quantity changed on ${name}: ${before.quantity} → ${after.quantity}`
          : "Price floor changed";

  const profit = (priceCents: number, cost: number) =>
    computeProfitCents(priceCents, { costCents: cost, shippingCents: variant.shippingCents }, before.marketplace, deps.settings);
  await sendNotice(
    {
      title,
      message: [
        ...listingHeader(after),
        fromTo("Status", before.status, after.status, (status) => status.toLowerCase()),
        fromTo("Price", before.priceCents, after.priceCents, formatMoney),
        fromTo("Price floor", before.floorCents, after.floorCents, formatMoney),
        fromTo("Supplier cost", variant.costCents, costCents, formatMoney),
        fromTo("Expected profit per sale", profit(before.priceCents, variant.costCents), profit(after.priceCents, costCents), formatMoney),
        // A paused listing keeps its quantity in our records and shows 0 on the marketplace.
        fromTo(`Quantity on ${name}`, before.status === "ACTIVE" ? before.quantity : 0, after.status === "ACTIVE" ? after.quantity : 0, String),
        ...supplierLines({ ...variant, costCents, stock }, variant.product),
        ...linkLines(after, variant.product),
      ].join("\n"),
    },
    deps.notifiers,
  );
}

/**
 * Published listings whose supplier data is older than their check interval:
 * 30 minutes for top sellers, two hours otherwise (both configurable).
 * Listings paused for a holiday cut-off, account health or by hand are left alone.
 */
export async function findListingsDueForSync(now: Date, repricer: SyncDeps["settings"]["repricer"]): Promise<string[]> {
  const listings = await db.listing.findMany({
    where: {
      externalId: { not: null },
      OR: [{ status: "ACTIVE" }, { status: "PAUSED", pauseReason: { in: ["OUT_OF_STOCK", "BELOW_FLOOR"] } }],
    },
    include: { variant: { select: { lastSyncedAt: true } } },
  });
  return listings
    .filter((listing) => {
      const minutes = listing.isTopSeller ? repricer.topSellerIntervalMinutes : repricer.checkIntervalMinutes;
      const last = listing.variant.lastSyncedAt;
      return !last || now.getTime() - last.getTime() >= minutes * 60_000;
    })
    .map((listing) => listing.id);
}
