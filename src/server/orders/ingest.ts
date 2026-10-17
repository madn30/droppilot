import type { Marketplace } from "@prisma/client";
import { formatMoney, marketplaceName } from "../alerts/notices";
import { sendNotice } from "../alerts/service";
import { db } from "../db";
import { logger } from "../logger";
import { sealAddress } from "./address";
import type { OrderDeps } from "./deps";

const DAY_MS = 24 * 60 * 60 * 1000;
// How far back the first poll looks, and how much each later poll overlaps the previous one.
const FIRST_POLL_DAYS = 7;
const OVERLAP_DAYS = 1;
// A listing with this many units ordered in 30 days is a top seller (checked every 30 minutes instead of two hours).
const TOP_SELLER_UNITS = 5;
const TOP_SELLER_WINDOW_DAYS = 30;

/**
 * Fetches new orders from a marketplace and stores them. Orders already stored
 * are skipped, so overlapping polls and retries are harmless.
 * Returns the ids of the newly stored orders.
 */
export async function pollOrders(marketplace: Marketplace, deps: OrderDeps): Promise<string[]> {
  const now = deps.now?.() ?? new Date();
  const latest = await db.order.findFirst({ where: { marketplace }, orderBy: { orderedAt: "desc" }, select: { orderedAt: true } });
  const since = latest ? new Date(latest.orderedAt.getTime() - OVERLAP_DAYS * DAY_MS) : new Date(now.getTime() - FIRST_POLL_DAYS * DAY_MS);

  const created: string[] = [];
  for (const order of await deps.getMarketplace(marketplace).getOrders(since)) {
    const known = await db.order.findUnique({ where: { marketplace_externalId: { marketplace, externalId: order.externalId } } });
    if (known) continue;

    const listings = await db.listing.findMany({ where: { marketplace, sku: { in: order.lines.map((line) => line.sku) } } });
    const listingBySku = new Map(listings.map((listing) => [listing.sku, listing]));
    const lines = order.lines.filter((line) => listingBySku.has(line.sku));
    if (lines.length === 0) {
      // The seller account may sell things this system did not list; those orders are not ours to fulfil.
      logger.info({ marketplace, orderId: order.externalId }, "order has no line from our listings; ignored");
      continue;
    }

    const stored = await db.order.create({
      data: {
        marketplace,
        externalId: order.externalId,
        status: "NEW",
        buyerName: order.buyerName,
        buyerUsername: order.buyerUsername ?? null,
        shippingAddress: sealAddress(order.shippingAddress),
        totalCents: order.totalCents,
        currency: order.currency,
        orderedAt: order.orderedAt,
        shipByDate: order.shipByDate,
        items: {
          create: lines.map((line) => ({
            listingId: listingBySku.get(line.sku)?.id ?? "",
            externalLineId: line.externalLineId,
            quantity: line.quantity,
            priceCents: line.priceCents,
          })),
        },
      },
    });
    created.push(stored.id);
    await sendNotice(
      {
        title: `New ${marketplaceName(marketplace)} order ${order.externalId}`,
        message: [
          ...lines.map((line) => `${line.quantity} × ${listingBySku.get(line.sku)?.title ?? line.sku} (SKU ${line.sku}) at ${formatMoney(line.priceCents)}`),
          `Total ${formatMoney(order.totalCents)}`,
          // The buyer's name and street stay on the Orders page.
          `Ships to ${[order.shippingAddress.city, order.shippingAddress.state, order.shippingAddress.country].filter(Boolean).join(", ")}`,
          `Ordered ${order.orderedAt.toISOString().slice(0, 16).replace("T", " ")} UTC${order.shipByDate ? ` · ship by ${order.shipByDate.toISOString().slice(0, 10)}` : ""}`,
          "Next: the price is re-checked and the supplier order is placed.",
        ].join("\n"),
      },
      deps.notifiers,
    );
  }

  if (created.length > 0) await refreshTopSellers(now);
  return created;
}

/** Flags listings that sold at least five units in the last 30 days, and clears the flag on the rest. */
async function refreshTopSellers(now: Date): Promise<void> {
  const since = new Date(now.getTime() - TOP_SELLER_WINDOW_DAYS * DAY_MS);
  const sales = await db.orderItem.groupBy({
    by: ["listingId"],
    where: { order: { orderedAt: { gte: since }, status: { not: "CANCELLED" } } },
    _sum: { quantity: true },
  });
  const topSellers = sales.filter((sale) => (sale._sum.quantity ?? 0) >= TOP_SELLER_UNITS).map((sale) => sale.listingId);
  await db.listing.updateMany({ where: { id: { in: topSellers } }, data: { isTopSeller: true } });
  await db.listing.updateMany({ where: { id: { notIn: topSellers }, isTopSeller: true }, data: { isTopSeller: false } });
}
