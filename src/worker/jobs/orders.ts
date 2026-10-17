import type { Marketplace } from "@prisma/client";
import type { Queue } from "bullmq";
import { z } from "zod";
import { enabledMarketplaces } from "@/server/marketplaces";
import { captureAccountHealth } from "@/server/health/monitor";
import { buildOrderDeps } from "@/server/orders/deps";
import { type FulfilResult, processOrder } from "@/server/orders/fulfil";
import { pollOrders } from "@/server/orders/ingest";
import { type TrackingResult, updateTracking } from "@/server/orders/tracking";
import { PROCESS_ORDER_JOB } from "../queues";

const processOrderDataSchema = z.object({ orderId: z.string().min(1) });

/** Stores new marketplace orders and queues each one for fulfilment. */
export async function pollAllOrders(queue: Queue): Promise<{ newOrders: number }> {
  const deps = await buildOrderDeps();
  let newOrders = 0;
  for (const marketplace of enabledMarketplaces()) {
    const created = await pollOrders(marketplace, deps);
    await queue.addBulk(
      created.map((orderId) => ({ name: PROCESS_ORDER_JOB, data: { orderId }, opts: { jobId: `${PROCESS_ORDER_JOB}-${orderId}` } })),
    );
    newOrders += created.length;
  }
  return { newOrders };
}

export async function processOneOrder(data: unknown): Promise<FulfilResult> {
  const { orderId } = processOrderDataSchema.parse(data);
  return processOrder(orderId, await buildOrderDeps());
}

export async function trackOrders(): Promise<TrackingResult> {
  return updateTracking(await buildOrderDeps());
}

export async function checkAccountHealth(): Promise<{ marketplace: Marketplace; newListingsPaused: boolean }[]> {
  const deps = await buildOrderDeps();
  const results = [];
  for (const marketplace of enabledMarketplaces()) {
    const health = await captureAccountHealth(marketplace, deps);
    results.push({ marketplace, newListingsPaused: health.newListingsPaused });
  }
  return results;
}
