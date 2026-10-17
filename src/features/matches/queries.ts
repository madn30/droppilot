import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";

const matchInclude = {
  competitorListing: { include: { images: { orderBy: { position: "asc" } } } },
  variant: { include: { product: { include: { images: { orderBy: { position: "asc" } } } } } },
} satisfies Prisma.ProductMatchInclude;

export type MatchWithEvidence = Prisma.ProductMatchGetPayload<{ include: typeof matchInclude }>;

/** Every match of the given products, whatever its status. */
export async function listMatchesForProducts(productIds: string[]): Promise<MatchWithEvidence[]> {
  return db.productMatch.findMany({
    where: { variant: { productId: { in: productIds } } },
    include: matchInclude,
    orderBy: [{ finalScore: "desc" }, { id: "asc" }],
  });
}
