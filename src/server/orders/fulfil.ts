import type { SupplierOrderStatus } from "@prisma/client";
import { formatMoney, marketplaceName } from "../alerts/notices";
import { raiseAlert, resolveAlerts, sendNotice } from "../alerts/service";
import { chooseShippingOption } from "../catalog/shipping-choice";
import { db } from "../db";
import { computeProfitCents } from "../pricing/engine";
import { SupplierError, type SupplierShippingOption } from "../suppliers/types";
import { openAddress } from "./address";
import type { OrderDeps } from "./deps";

export type FulfilOutcome = "ORDERED" | "NEEDS_DECISION" | "FAILED" | "SKIPPED";

export interface FulfilResult {
  orderId: string;
  outcome: FulfilOutcome;
  expectedProfitCents: number | null;
  /** The supplier order id, or several separated by ", " when the order ships in more than one parcel. */
  supplierOrderId: string | null;
}

interface Parcel {
  shipping: SupplierShippingOption;
  lines: { itemId: string; variantExternalId: string; quantity: number }[];
  costCents: number;
  revenueCents: number;
}

const PLACED_STATUSES: SupplierOrderStatus[] = ["PLACED", "SHIPPED", "DELIVERED"];

function dollars(cents: number): string {
  return `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

const FAILURE_ALERTS: Record<string, { type: string; title: string }> = {
  OUT_OF_STOCK: { type: "order.out_of_stock", title: "Supplier is out of stock for an order" },
  ADDRESS_INVALID: { type: "order.address_error", title: "Supplier rejected an order's address" },
  SHIPPING_UNAVAILABLE: { type: "order.shipping_unavailable", title: "No supplier shipping option for an order" },
  INSUFFICIENT_BALANCE: { type: "order.insufficient_balance", title: "Supplier balance is too low to place an order" },
  ORDER_HELD: { type: "order.held", title: "Supplier is holding an order for review" },
};
const GENERIC_FAILURE = { type: "order.supplier_error", title: "Supplier order failed" };
/** Raised when a supplier order was created unpaid; closed once the supplier reports it paid or shipped. */
export const PAYMENT_NEEDED_ALERT = "order.payment_needed";

const ORDER_ALERT_TYPES = [...Object.values(FAILURE_ALERTS).map((alert) => alert.type), GENERIC_FAILURE.type, "order.price_jump"];

/**
 * Fulfils one marketplace order at the supplier:
 *  - re-checks the supplier's price and stock;
 *  - still profitable, or a loss within MAX_ACCEPTABLE_LOSS → places the supplier order;
 *  - a bigger loss → does not order; raises an alert so the admin can decide;
 *  - out of stock, address rejected or any other supplier refusal → marks the order failed and alerts.
 * It never cancels the marketplace order.
 * New orders are processed automatically. An order that needs a decision or has failed is only
 * processed again when the admin asks: `force: true` orders whatever the loss ("fulfil anyway"),
 * `force: false` retries with the normal loss check.
 */
export async function processOrder(orderId: string, deps: OrderDeps, options: { force?: boolean } = {}): Promise<FulfilResult> {
  const now = deps.now?.() ?? new Date();
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: { include: { listing: { include: { variant: { include: { product: { include: { supplier: true } } } } } } } },
      supplierOrders: true,
    },
  });
  const actionable = order.status === "NEW" || ((order.status === "NEEDS_DECISION" || order.status === "FAILED") && options.force !== undefined);
  if (!actionable) {
    const placed = order.supplierOrders.flatMap((supplierOrder) => (supplierOrder.externalId ? [supplierOrder.externalId] : []));
    return { orderId, outcome: "SKIPPED", expectedProfitCents: null, supplierOrderId: placed.join(", ") || null };
  }

  const address = openAddress(order.shippingAddress);
  const fail = async (alert: { type: string; title: string }, message: string, supplierOrderId?: string): Promise<FulfilResult> => {
    if (supplierOrderId) {
      await db.supplierOrder.update({ where: { id: supplierOrderId }, data: { status: "FAILED", failureReason: message } });
    }
    await db.order.update({ where: { id: order.id }, data: { status: "FAILED" } });
    await raiseAlert(
      {
        severity: "CRITICAL",
        type: alert.type,
        title: `${alert.title}: ${order.marketplace} order ${order.externalId}`,
        message: `${message}\nThe marketplace order has NOT been cancelled. Retry, fulfil it another way, or cancel it yourself.`,
        orderId: order.id,
        actions: [
          { label: "Retry", command: `retry ${order.id}` },
          { label: "I fulfilled it myself", command: `handled ${order.id}` },
          { label: "I cancelled it on the marketplace", command: `cancelled ${order.id}` },
        ],
      },
      deps.notifiers,
    );
    return { orderId, outcome: "FAILED", expectedProfitCents: null, supplierOrderId: null };
  };

  // Re-check every line against the supplier as it is right now, and group the lines by the parcel they ship in.
  const parcels = new Map<string, Parcel>();
  for (const item of order.items) {
    const variant = item.listing.variant;
    let current;
    let shippingOptions: SupplierShippingOption[];
    try {
      current = await deps.supplier.getStockAndPrice(variant.externalId);
      shippingOptions = await deps.supplier.getShippingOptions(variant.externalId, address.country);
    } catch (error) {
      if (error instanceof SupplierError) return fail(FAILURE_ALERTS[error.code] ?? GENERIC_FAILURE, error.message);
      throw error;
    }
    const enoughStock = Object.fromEntries(
      Object.entries(current.stockByWarehouse).map(([warehouse, stock]) => [warehouse, stock >= item.quantity ? stock : 0]),
    );
    const option = chooseShippingOption(shippingOptions, enoughStock);
    if (!option) {
      return fail(FAILURE_ALERTS.OUT_OF_STOCK, `${variant.sku}: no supplier warehouse has ${item.quantity} in stock and ships to ${address.country}.`);
    }
    // Lines leaving the same warehouse by the same service travel together; anything else is its own supplier order.
    const key = `${option.warehouse}|${option.name}`;
    const parcel = parcels.get(key) ?? { shipping: option, lines: [], costCents: 0, revenueCents: 0 };
    parcel.lines.push({ itemId: item.id, variantExternalId: variant.externalId, quantity: item.quantity });
    parcel.costCents += current.costCents * item.quantity;
    parcel.revenueCents += item.priceCents * item.quantity;
    parcels.set(key, parcel);
  }
  if (parcels.size === 0) throw new Error(`Order ${order.externalId} has no items`);

  // Each parcel pays its own shipping fee; the order is judged on the total.
  const plans = [...parcels.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, parcel], index) => ({
      ...parcel,
      // A single parcel keeps the plain key, so orders placed before splitting existed still match.
      idempotencyKey: parcels.size === 1 ? `dp-${order.id}` : `dp-${order.id}-${index + 1}`,
      expectedProfitCents: computeProfitCents(
        parcel.revenueCents,
        { costCents: parcel.costCents, shippingCents: parcel.shipping.costCents },
        order.marketplace,
        deps.settings,
      ),
    }));
  // The marketplace's fixed fee is charged once per order, not once per parcel.
  const fixedFeeCents = (order.marketplace === "EBAY" ? deps.settings.fees.ebay : deps.settings.fees.amazon).fixedFeeCents;
  const expectedProfitCents = plans.reduce((sum, plan) => sum + plan.expectedProfitCents, 0) + fixedFeeCents * (plans.length - 1);
  const costCents = plans.reduce((sum, plan) => sum + plan.costCents, 0);
  const shippingCents = plans.reduce((sum, plan) => sum + plan.shipping.costCents, 0);

  const maxLoss = deps.settings.orders.maxAcceptableLossCents;
  if (expectedProfitCents < -maxLoss && !options.force) {
    await db.order.update({ where: { id: order.id }, data: { status: "NEEDS_DECISION" } });
    await raiseAlert(
      {
        severity: "CRITICAL",
        type: "order.price_jump",
        title: `Order would lose ${dollars(-expectedProfitCents)}: ${order.marketplace} order ${order.externalId}`,
        message:
          `The supplier now charges ${dollars(costCents)} plus ${dollars(shippingCents)} shipping, which makes this order a loss of ` +
          `${dollars(-expectedProfitCents)} (the limit is ${dollars(maxLoss)}). It has NOT been ordered.\n` +
          "Options on the Orders page: fulfil anyway, fulfil it with another supplier yourself, or cancel it on the marketplace.",
        orderId: order.id,
        context: { expectedProfitCents, costCents, shippingCents },
        actions: [
          { label: "Fulfil anyway", command: `fulfil ${order.id}` },
          { label: "I fulfilled it myself", command: `handled ${order.id}` },
          { label: "I cancelled it on the marketplace", command: `cancelled ${order.id}` },
        ],
      },
      deps.notifiers,
    );
    return { orderId, outcome: "NEEDS_DECISION", expectedProfitCents, supplierOrderId: null };
  }

  const supplier = order.items[0].listing.variant.product.supplier;
  const { payFromSupplierBalance: payFromBalance } = deps.settings.orders;
  const supplierOrderIds: string[] = [];
  const placedParcels: string[] = [];
  for (const plan of plans) {
    const already = order.supplierOrders.find(
      (supplierOrder) => supplierOrder.idempotencyKey === plan.idempotencyKey && PLACED_STATUSES.includes(supplierOrder.status),
    );
    if (already?.externalId) {
      // Placed by an earlier attempt that failed on a later parcel.
      supplierOrderIds.push(already.externalId);
      continue;
    }

    // The supplier order row is written first: its key makes a retry return the same supplier order, never a second one.
    const record = {
      status: "PENDING" as const,
      lineIds: plan.lines.map((line) => line.itemId),
      costCents: plan.costCents,
      shippingCents: plan.shipping.costCents,
      expectedProfitCents: plan.expectedProfitCents,
      blindShipping: supplier.supportsBlindShipping,
      failureReason: null,
    };
    const supplierOrder = await db.supplierOrder.upsert({
      where: { idempotencyKey: plan.idempotencyKey },
      create: { orderId: order.id, idempotencyKey: plan.idempotencyKey, ...record },
      update: record,
    });

    let result;
    try {
      result = await deps.supplier.placeOrder({
        idempotencyKey: plan.idempotencyKey,
        items: plan.lines.map((line) => ({ variantExternalId: line.variantExternalId, quantity: line.quantity })),
        shippingAddress: address,
        shippingOptionName: plan.shipping.name,
        warehouse: plan.shipping.warehouse,
        blindShipping: supplier.supportsBlindShipping,
        payFromBalance,
      });
    } catch (error) {
      if (!(error instanceof SupplierError)) throw error;
      const partial =
        supplierOrderIds.length > 0
          ? ` ${supplierOrderIds.length} of ${plans.length} parcels were already ordered (${supplierOrderIds.join(", ")}); Retry orders only the rest.`
          : "";
      return fail(FAILURE_ALERTS[error.code] ?? GENERIC_FAILURE, `${error.message}${partial}`, supplierOrder.id);
    }

    await db.supplierOrder.update({
      where: { id: supplierOrder.id },
      data: { status: "PLACED", externalId: result.supplierOrderId, costCents: result.costCents, shippingCents: result.shippingCents },
    });
    supplierOrderIds.push(result.supplierOrderId);
    placedParcels.push(
      `${supplier.name} order ${result.supplierOrderId}: ${plan.lines.reduce((sum, line) => sum + line.quantity, 0)} item(s) from the ` +
        `${plan.shipping.warehouse} warehouse by ${plan.shipping.name}, ${formatMoney(result.costCents)} + ${formatMoney(result.shippingCents)} shipping`,
    );
  }

  await db.order.update({ where: { id: order.id }, data: { status: "ORDERED", updatedAt: now } });
  for (const type of ORDER_ALERT_TYPES) await resolveAlerts({ type, orderId: order.id }, now);
  if (placedParcels.length > 0 && !payFromBalance) {
    // Nothing ships until the admin pays, so this stays open on the dashboard until the supplier reports the order moving.
    await raiseAlert(
      {
        severity: "WARNING",
        type: PAYMENT_NEEDED_ALERT,
        title: `Pay the supplier: ${formatMoney(costCents + shippingCents)} for ${marketplaceName(order.marketplace)} order ${order.externalId}`,
        message: [
          ...placedParcels,
          `The order was created at ${supplier.name} unpaid. Pay it there (Orders, awaiting payment) by card or PayPal; it ships only after payment.`,
          `Order total ${formatMoney(order.totalCents)} · expected profit ${formatMoney(expectedProfitCents)}`,
          ...(order.shipByDate ? [`Ship by ${order.shipByDate.toISOString().slice(0, 10)}`] : []),
        ].join("\n"),
        orderId: order.id,
        actions: [{ label: "I paid it", command: `paid ${order.id}` }],
      },
      deps.notifiers,
    );
  } else if (placedParcels.length > 0) {
    await sendNotice(
      {
        title: `Supplier order placed for ${marketplaceName(order.marketplace)} order ${order.externalId}`,
        message: [
          ...order.items.map((item) => `${item.quantity} × ${item.listing.title} (SKU ${item.listing.sku}) sold at ${formatMoney(item.priceCents)}`),
          ...placedParcels,
          `Order total ${formatMoney(order.totalCents)} · supplier total ${formatMoney(costCents + shippingCents)} · expected profit ${formatMoney(expectedProfitCents)}`,
          supplier.supportsBlindShipping ? "Blind shipping: no invoice, price or supplier branding in the parcel." : "Blind shipping is not available from this supplier.",
          "Next: the tracking number is uploaded as soon as the supplier ships.",
        ].join("\n"),
      },
      deps.notifiers,
    );
  }
  return { orderId, outcome: "ORDERED", expectedProfitCents, supplierOrderId: supplierOrderIds.join(", ") };
}

/** The admin fulfilled the order through another supplier; it leaves the automatic pipeline. */
export async function markHandledManually(orderId: string, now: Date = new Date()): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: { status: "ORDERED" } });
  for (const type of ORDER_ALERT_TYPES) await resolveAlerts({ type, orderId }, now);
}

/** The admin cancelled the order on the marketplace; this only records it. Nothing here cancels a marketplace order. */
export async function markCancelled(orderId: string, now: Date = new Date()): Promise<void> {
  await db.order.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
  for (const type of ORDER_ALERT_TYPES) await resolveAlerts({ type, orderId }, now);
}
