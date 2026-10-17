import { db } from "../db";
import { type ListingDeps, createListing } from "../listing/service";
import { logger } from "../logger";
import { type DiscoveryDeps, evaluateSupplierProducts, pickListingCandidates } from "../seasonal/discovery";

const DAY_MS = 24 * 60 * 60 * 1000;
// A product scored within this many days is not evaluated again by trending discovery
// (the weekly re-matching keeps it current).
const RECENTLY_EVALUATED_DAYS = 7;
const PAGE_SIZE = 20;
// How deep into the supplier's trending list one run looks for products it has not evaluated yet.
const MAX_PAGES = 5;
// Trending picks are listed on eBay; Amazon listings are created from the Products page.
const TRENDING_MARKETPLACE = "EBAY";

export interface TrendingDeps extends DiscoveryDeps {
  listing: ListingDeps;
}

export interface TrendingDiscoveryResult {
  evaluated: number;
  failed: { externalId: string; error: string }[];
  /** Listings created for the best-scoring products (drafts while manual approve is on). */
  listed: string[];
  notListed: { variantId: string; error: string }[];
}

/**
 * The daily trending run: takes the supplier's trending products that are stocked in the
 * destination country and have not been evaluated lately, imports, matches and scores them,
 * then lists the top N that clear the demand threshold.
 */
export async function runTrendingDiscovery(now: Date, deps: TrendingDeps): Promise<TrendingDiscoveryResult> {
  const { trendingProductsPerRun, trendingAutoListTopN } = deps.listing.settings.discovery;
  if (trendingProductsPerRun === 0) return { evaluated: 0, failed: [], listed: [], notListed: [] };

  const supplier = deps.importer.supplier;
  const recent = new Date(now.getTime() - RECENTLY_EVALUATED_DAYS * DAY_MS);
  const fresh: string[] = [];
  for (let page = 1; page <= MAX_PAGES && fresh.length < trendingProductsPerRun; page++) {
    const results = await supplier.searchProducts({
      trending: true,
      stockedIn: deps.importer.destinationCountry,
      page,
      pageSize: PAGE_SIZE,
    });
    if (results.length === 0) break;
    const evaluatedLately = await db.product.findMany({
      where: {
        externalId: { in: results.map((product) => product.externalId) },
        variants: { some: { demandSnapshots: { some: { capturedAt: { gte: recent } } } } },
      },
      select: { externalId: true },
    });
    const skip = new Set(evaluatedLately.map((product) => product.externalId));
    for (const product of results) {
      if (!skip.has(product.externalId) && !fresh.includes(product.externalId) && fresh.length < trendingProductsPerRun) {
        fresh.push(product.externalId);
      }
    }
  }

  const evaluation = await evaluateSupplierProducts(fresh, new Set(fresh), deps);
  const candidates = (await pickListingCandidates(evaluation.productIds, deps.demand.settings)).slice(0, trendingAutoListTopN);

  const listed: string[] = [];
  const notListed: TrendingDiscoveryResult["notListed"] = [];
  for (const candidate of candidates) {
    try {
      listed.push((await createListing(candidate.variantId, TRENDING_MARKETPLACE, deps.listing)).id);
    } catch (error) {
      // A compliance refusal or a marketplace error for one product must not block the others; it is reported in the job result.
      logger.error({ variantId: candidate.variantId, err: error }, "trending listing was not created");
      notListed.push({ variantId: candidate.variantId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { evaluated: evaluation.productIds.length, failed: evaluation.failed, listed, notListed };
}
