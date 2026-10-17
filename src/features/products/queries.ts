import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";

const productInclude = {
  variants: {
    orderBy: { sku: "asc" },
    include: {
      demandSnapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
      listings: { where: { status: { not: "ENDED" } }, select: { id: true, marketplace: true, status: true, externalId: true, groupKey: true } },
      _count: { select: { matches: { where: { status: "CONFIRMED" } } } },
    },
  },
  trendSnapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
  supplier: { select: { code: true, name: true } },
  images: { orderBy: { position: "asc" }, take: 1, select: { id: true, localPath: true } },
} satisfies Prisma.ProductInclude;

export type ProductWithDemand = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

export async function listProducts(): Promise<ProductWithDemand[]> {
  return db.product.findMany({ include: productInclude, orderBy: { updatedAt: "desc" }, take: 100 });
}
