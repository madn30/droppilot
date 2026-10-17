"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/session";
import { logger } from "@/server/logger";
import { buildOrderDeps } from "@/server/orders/deps";
import { markCancelled, markHandledManually, processOrder } from "@/server/orders/fulfil";

export interface OrderActionState {
  error: string | null;
  done: string | null;
}

const inputSchema = z.object({
  orderId: z.string().min(1),
  decision: z.enum(["FULFIL_ANYWAY", "RETRY", "HANDLED_ELSEWHERE", "CANCELLED"]),
});

/** The admin's decision on an order that was not fulfilled automatically. */
export async function decideOrderAction(_previous: OrderActionState, formData: FormData): Promise<OrderActionState> {
  await requireAdmin();
  const { orderId, decision } = inputSchema.parse({ orderId: formData.get("orderId"), decision: formData.get("decision") });
  try {
    if (decision === "HANDLED_ELSEWHERE") {
      await markHandledManually(orderId);
    } else if (decision === "CANCELLED") {
      await markCancelled(orderId);
    } else {
      const result = await processOrder(orderId, await buildOrderDeps(), { force: decision === "FULFIL_ANYWAY" });
      if (result.outcome !== "ORDERED") {
        revalidatePath("/products");
        return { error: `The order was not placed (${result.outcome.toLowerCase().replaceAll("_", " ")}). See the alert for details.`, done: null };
      }
    }
  } catch (error) {
    logger.warn({ orderId, decision, err: error }, "order action failed");
    return { error: error instanceof Error ? error.message : String(error), done: null };
  }
  revalidatePath("/products");
  revalidatePath("/");
  return { error: null, done: "Done." };
}
