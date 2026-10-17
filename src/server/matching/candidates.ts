import type { CompetitorCandidate, MarketplaceAdapter } from "../marketplaces/types";

const SEARCH_LIMIT = 50;

/**
 * Collects possible competitor listings from every marketplace: image search
 * with the supplier's main photo where the marketplace offers one, plus a
 * keyword search on the product title. Listings found both ways appear once.
 */
export async function findCandidates(
  product: { title: string; mainImage: Uint8Array | null },
  marketplaces: MarketplaceAdapter[],
): Promise<CompetitorCandidate[]> {
  const byKey = new Map<string, CompetitorCandidate>();
  for (const marketplace of marketplaces) {
    const found: CompetitorCandidate[] = [];
    if (marketplace.searchByImage && product.mainImage) {
      found.push(...(await marketplace.searchByImage(product.mainImage, SEARCH_LIMIT)));
    }
    found.push(...(await marketplace.searchByKeyword(product.title, SEARCH_LIMIT)));
    for (const candidate of found) {
      byKey.set(`${candidate.marketplace}:${candidate.externalId}`, candidate);
    }
  }
  return [...byKey.values()];
}
