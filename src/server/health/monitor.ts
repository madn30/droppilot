import type { AccountHealth, Marketplace } from "@prisma/client";
import { raiseAlert, resolveAlerts } from "../alerts/service";
import { db } from "../db";
import type { AccountHealthMetrics } from "../marketplaces/types";
import type { OrderDeps } from "../orders/deps";
import type { Settings } from "../settings/schema";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL_WINDOW_DAYS = 90;
// "Close to a limit" means having used 80% of the room the marketplace allows.
const WARNING_RATIO = 0.8;

type MetricKey = keyof AccountHealthMetrics;
type MetricState = "OK" | "NEAR" | "BREACHED";

interface Limit {
  metric: MetricKey;
  label: string;
  /** "max": the rate must stay below the limit. "min": it must stay above it. */
  kind: "max" | "min";
  limit: number;
}

function limitsFor(marketplace: Marketplace, health: Settings["health"]): Limit[] {
  if (marketplace === "EBAY") {
    return [{ metric: "defectRate", label: "transaction defect rate", kind: "max", limit: health.ebay.maxDefectRate }];
  }
  return [
    { metric: "defectRate", label: "order defect rate", kind: "max", limit: health.amazon.maxOrderDefectRate },
    { metric: "lateShipmentRate", label: "late shipment rate", kind: "max", limit: health.amazon.maxLateShipmentRate },
    { metric: "cancellationRate", label: "cancellation rate", kind: "max", limit: health.amazon.maxCancellationRate },
    { metric: "validTrackingRate", label: "valid tracking rate", kind: "min", limit: health.amazon.minValidTrackingRate },
  ];
}

function metricState(value: number | null, limit: Limit): MetricState {
  if (value === null) return "OK";
  if (limit.kind === "max") {
    if (value >= limit.limit) return "BREACHED";
    return value >= limit.limit * WARNING_RATIO ? "NEAR" : "OK";
  }
  if (value < limit.limit) return "BREACHED";
  // For a minimum, the room is what lies between the limit and a perfect 100%.
  return value < limit.limit + (1 - limit.limit) * (1 - WARNING_RATIO) ? "NEAR" : "OK";
}

/** Rates from our own order records, for the metrics a marketplace does not report. */
async function localMetrics(marketplace: Marketplace, now: Date): Promise<AccountHealthMetrics> {
  const orders = await db.order.findMany({
    where: { marketplace, orderedAt: { gte: new Date(now.getTime() - LOCAL_WINDOW_DAYS * DAY_MS) } },
    include: { supplierOrders: true },
  });
  if (orders.length === 0) {
    return { lateShipmentRate: null, cancellationRate: null, validTrackingRate: null, defectRate: null, returnRate: null };
  }

  const shippedAt = (order: (typeof orders)[number]) =>
    order.supplierOrders.flatMap((supplierOrder) => (supplierOrder.trackingUploadedAt ? [supplierOrder.trackingUploadedAt] : []))[0] ?? null;
  const withDeadline = orders.filter((order) => order.shipByDate && order.status !== "CANCELLED");
  const late = withDeadline.filter((order) => {
    const shipped = shippedAt(order);
    const deadline = order.shipByDate ?? now;
    return shipped ? shipped > deadline : now > deadline;
  });
  const shipped = orders.filter((order) => order.status === "SHIPPED" || order.status === "DELIVERED");

  return {
    lateShipmentRate: withDeadline.length === 0 ? null : late.length / withDeadline.length,
    cancellationRate: orders.filter((order) => order.status === "CANCELLED").length / orders.length,
    validTrackingRate: shipped.length === 0 ? null : shipped.filter((order) => shippedAt(order) !== null).length / shipped.length,
    // Defects and returns are judged by the marketplace; we cannot derive them.
    defectRate: null,
    returnRate: null,
  };
}

/**
 * Records a marketplace's account health, warns before a limit is reached,
 * and stops new listings while any metric is close to (or past) its limit.
 */
export async function captureAccountHealth(marketplace: Marketplace, deps: OrderDeps): Promise<AccountHealth> {
  const now = deps.now?.() ?? new Date();
  const reported = await deps.getMarketplace(marketplace).getAccountHealth();
  const local = await localMetrics(marketplace, now);
  const metrics: AccountHealthMetrics = {
    lateShipmentRate: reported.lateShipmentRate ?? local.lateShipmentRate,
    cancellationRate: reported.cancellationRate ?? local.cancellationRate,
    validTrackingRate: reported.validTrackingRate ?? local.validTrackingRate,
    defectRate: reported.defectRate,
    returnRate: reported.returnRate,
  };

  let atRisk = false;
  for (const limit of limitsFor(marketplace, deps.settings.health)) {
    const value = metrics[limit.metric];
    const state = metricState(value, limit);
    const type = `health.${marketplace}.${limit.metric}`;
    if (state === "OK" || value === null) {
      await resolveAlerts({ type }, now);
      continue;
    }
    atRisk = true;
    const percent = (rate: number) => `${(rate * 100).toFixed(2)}%`;
    await raiseAlert(
      {
        severity: state === "BREACHED" ? "CRITICAL" : "WARNING",
        type,
        title: `${marketplace} ${limit.label} is ${state === "BREACHED" ? "past" : "close to"} its limit`,
        message:
          `${limit.label} is ${percent(value)}; the limit is ${limit.kind === "max" ? "below" : "above"} ${percent(limit.limit)}.` +
          (deps.settings.health.pauseNewListingsNearLimit ? " New listings are paused until it recovers." : ""),
        context: { value, limit: limit.limit, state },
      },
      deps.notifiers,
    );
  }

  return db.accountHealth.create({
    data: {
      marketplace,
      ...metrics,
      newListingsPaused: atRisk && deps.settings.health.pauseNewListingsNearLimit,
      capturedAt: now,
    },
  });
}

/** Whether the latest health check stopped new listings on this marketplace. */
export async function newListingsPaused(marketplace: Marketplace): Promise<boolean> {
  const latest = await db.accountHealth.findFirst({ where: { marketplace }, orderBy: { capturedAt: "desc" } });
  return latest?.newListingsPaused ?? false;
}
