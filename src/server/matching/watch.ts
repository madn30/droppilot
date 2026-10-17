import { db } from "../db";
import type { MarketplaceAdapter } from "../marketplaces/types";

const SEARCH_LIMIT = 50;

/**
 * Variants for which a marketplace search now returns a listing that has never
 * been evaluated for them. Those are due for a matching run before the weekly one.
 * Only listing ids are fetched, so the check is cheap.
 */
export async function findVariantsWithNewCompetitors(marketplaces: MarketplaceAdapter[]): Promise<string[]> {
  const variants = await db.productVariant.findMany({
    where: { product: { status: { notIn: ["REJECTED", "ARCHIVED"] } } },
    include: {
      product: { select: { title: true } },
      matches: { select: { competitorListing: { select: { marketplace: true, externalId: true } } } },
    },
  });

  const due: string[] = [];
  // Variants of one product share its title, so each product is searched once per marketplace.
  const idsByTitle = new Map<string, Promise<string[]>>();
  for (const variant of variants) {
    const known = new Set(variant.matches.map((match) => `${match.competitorListing.marketplace}:${match.competitorListing.externalId}`));
    const title = variant.product.title;
    const found =
      idsByTitle.get(title) ??
      (async () => {
        const keys: string[] = [];
        for (const marketplace of marketplaces) {
          const ids = await marketplace.listCandidateIds(title, SEARCH_LIMIT);
          keys.push(...ids.map((id) => `${marketplace.marketplace}:${id}`));
        }
        return keys;
      })();
    idsByTitle.set(title, found);
    if ((await found).some((key) => !known.has(key))) due.push(variant.id);
  }
  return due;
}
