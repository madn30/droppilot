import type { SupplierOrderStatus } from "@prisma/client";
import { marketplaceName } from "../alerts/notices";
import { raiseAlert, resolveAlerts, sendNotice } from "../alerts/service";
import { db } from "../db";
import type { OrderDeps } from "./deps";
import { PAYMENT_NEEDED_ALERT } from "./fulfil";

/** Whether every parcel of the order (ignoring failed attempts) has reached one of the given states. */
async function allParcels(orderId: string, statuses: SupplierOrderStatus[]): Promise<boolean> {
  const parcels = await db.supplierOrder.findMany({ where: { orderId, status: { not: "FAILED" } }, select: { status: true } });
  return parcels.every((parcel) => statuses.includes(parcel.status));
}

export interface TrackingResult {
  checked: number;
  /** Orders that became fully shipped in this run (every parcel has its tracking uploaded). */
  uploaded: string[];
  delivered: string[];
}

/**
 * Follows every supplier order that is on its way: stores tracking events,
 * uploads the tracking number to the marketplace as soon as there is one
 * (which marks the order shipped), and records delivery.
 */
export async function updateTracking(deps: OrderDeps): Promise<TrackingResult> {
  const now = deps.now?.() ?? new Date();
  const supplierOrders = await db.supplierOrder.findMany({
    where: { status: { in: ["PLACED", "SHIPPED"] }, externalId: { not: null } },
    include: { order: { include: { items: true } } },
  });

  const uploaded: string[] = [];
  const delivered: string[] = [];
  for (const supplierOrder of supplierOrders) {
    const { order } = supplierOrder;
    const tracking = await deps.supplier.getTracking(supplierOrder.externalId ?? "");

    await db.trackingEvent.createMany({
      data: tracking.events.map((event) => ({ supplierOrderId: supplierOrder.id, ...event })),
      skipDuplicates: true,
    });

    // A supplier order created unpaid: once the supplier shows it paid or moving, the reminder to pay is closed.
    if (tracking.trackingNumber || tracking.events.some((event) => event.status === "PAID")) {
      await resolveAlerts({ type: PAYMENT_NEEDED_ALERT, orderId: order.id }, now);
    }

    if (tracking.status === "CANCELLED") {
      await db.supplierOrder.update({ where: { id: supplierOrder.id }, data: { status: "FAILED", failureReason: "Cancelled by the supplier" } });
      await db.order.update({ where: { id: order.id }, data: { status: "FAILED" } });
      await raiseAlert(
        {
          severity: "CRITICAL",
          type: "order.supplier_cancelled",
          title: `Supplier cancelled an order: ${order.marketplace} order ${order.externalId}`,
          message: `Supplier order ${supplierOrder.externalId} was cancelled by the supplier. The marketplace order has NOT been cancelled; retry or handle it yourself.`,
          orderId: order.id,
        },
        deps.notifiers,
      );
      continue;
    }

    if (tracking.trackingNumber && !supplierOrder.trackingUploadedAt) {
      const carrier = tracking.carrier ?? "Other";
      // A supplier order placed before orders could be split covers every line.
      const lines = order.items.filter((item) => supplierOrder.lineIds.length === 0 || supplierOrder.lineIds.includes(item.id));
      // Marketplace first: if the upload fails, nothing is marked shipped and the next run tries again.
      await deps.getMarketplace(order.marketplace).uploadTracking(order.externalId, {
        trackingNumber: tracking.trackingNumber,
        carrier,
        lines: lines.map((item) => ({ externalLineId: item.externalLineId, quantity: item.quantity })),
      });
      await db.supplierOrder.update({
        where: { id: supplierOrder.id },
        data: { status: "SHIPPED", trackingNumber: tracking.trackingNumber, carrier, trackingUploadedAt: now },
      });
      const allShipped = await allParcels(order.id, ["SHIPPED", "DELIVERED"]);
      if (allShipped) {
        await db.order.update({ where: { id: order.id }, data: { status: "SHIPPED" } });
        uploaded.push(order.id);
      }
      await sendNotice(
        {
          title: `Tracking uploaded for ${marketplaceName(order.marketplace)} order ${order.externalId}`,
          message: [
            `${carrier} ${tracking.trackingNumber}`,
            `Supplier order ${supplierOrder.externalId}, ${lines.reduce((sum, item) => sum + item.quantity, 0)} item(s)`,
            allShipped
              ? `${marketplaceName(order.marketplace)} now shows the order as shipped.`
              : "Other parcels of this order have not shipped yet.",
          ].join("\n"),
        },
        deps.notifiers,
      );
    }

    if (tracking.status === "DELIVERED" && (tracking.trackingNumber || supplierOrder.trackingUploadedAt)) {
      await db.supplierOrder.update({ where: { id: supplierOrder.id }, data: { status: "DELIVERED" } });
      if (await allParcels(order.id, ["DELIVERED"])) {
        await db.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });
        delivered.push(order.id);
        await sendNotice(
          {
            title: `Delivered: ${marketplaceName(order.marketplace)} order ${order.externalId}`,
            message: `The carrier reports delivery${tracking.trackingNumber ? ` (${tracking.carrier ?? "carrier"} ${tracking.trackingNumber})` : ""}. Supplier order ${supplierOrder.externalId}.`,
          },
          deps.notifiers,
        );
      }
    }
  }
  return { checked: supplierOrders.length, uploaded, delivered };
}
