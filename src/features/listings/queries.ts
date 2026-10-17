import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";

const listingInclude = {
  variant: { include: { product: { select: { title: true, externalId: true, supplier: { select: { code: true, name: true } } } } } },
  holiday: { select: { name: true } },
} satisfies Prisma.ListingInclude;

export type ListingWithVariant = Prisma.ListingGetPayload<{ include: typeof listingInclude }>;

export async function listListingsForProducts(productIds: string[]): Promise<ListingWithVariant[]> {
  return db.listing.findMany({
    where: { variant: { productId: { in: productIds } } },
    include: listingInclude,
    // The options of one listing stay next to each other, in SKU order.
    orderBy: [{ updatedAt: "desc" }, { sku: "asc" }],
  });
}
