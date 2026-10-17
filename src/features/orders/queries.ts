import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";

const orderInclude = {
  items: { include: { listing: { select: { title: true, sku: true, variant: { select: { productId: true } } } } } },
  supplierOrders: { orderBy: { createdAt: "desc" } },
} satisfies Prisma.OrderInclude;

export type OrderWithPipeline = Prisma.OrderGetPayload<{ include: typeof orderInclude }> & { openAlerts: string[] };

export async function listOrdersForProducts(productIds: string[]): Promise<OrderWithPipeline[]> {
  const orders = await db.order.findMany({
    where: { items: { some: { listing: { variant: { productId: { in: productIds } } } } } },
    include: orderInclude,
    orderBy: { orderedAt: "desc" },
  });
  const alerts = await db.alert.findMany({ where: { resolvedAt: null, orderId: { in: orders.map((order) => order.id) } } });
  return orders.map((order) => ({
    ...order,
    openAlerts: alerts.filter((alert) => alert.orderId === order.id).map((alert) => alert.message),
  }));
}
