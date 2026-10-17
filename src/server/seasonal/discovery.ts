import type { Holiday } from "@prisma/client";
import { type ImportDeps, importSupplierProduct } from "../catalog/import-product";
import { db } from "../db";
import { type DemandDeps, scoreDemandForVariant } from "../demand/run-demand";
import { logger } from "../logger";
import { type MatchingDeps, runMatchingForVariant } from "../matching/run-matching";
import { shipsFromAllowedWarehouse } from "../compliance/guards";
import type { Settings } from "../settings/schema";
import { cutoffDate, startOfDayUtc } from "./calendar";

// Supplier products evaluated per holiday keyword on each daily run.
const PRODUCTS_PER_KEYWORD = 5;

export interface DiscoveryDeps {
  importer: ImportDeps;
  matching: MatchingDeps;
  demand: DemandDeps;
}

export interface DiscoveryResult {
  productIds: string[];
  failed: { externalId: string; error: string }[];
}

/**
 * Runs the pipeline for one holiday: search the supplier with the holiday's
 * keywords (trending products first), import what comes back, match each
 * variant against competitors and score its demand.
 */
export async function discoverForHoliday(holiday: Pick<Holiday, "code" | "keywords">, deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const supplier = deps.importer.supplier;
  const trending = new Set<string>();
  const found: string[] = [];
  for (const keyword of holiday.keywords) {
    // Only products stocked in the destination country: anything shipped from overseas would
    // miss the marketplace's delivery promise and be refused at listing time anyway.
    const stockedIn = deps.importer.destinationCountry;
    const trendingResults = await supplier.searchProducts({ keyword, trending: true, stockedIn, pageSize: PRODUCTS_PER_KEYWORD });
    const results = await supplier.searchProducts({ keyword, stockedIn, pageSize: PRODUCTS_PER_KEYWORD });
    for (const product of trendingResults) trending.add(product.externalId);
    const ordered = [...trendingResults, ...results].map((product) => product.externalId);
    for (const externalId of [...new Set(ordered)].slice(0, PRODUCTS_PER_KEYWORD)) {
      if (!found.includes(externalId)) found.push(externalId);
    }
  }

  return evaluateSupplierProducts(found, trending, deps);
}

/**
 * Imports each supplier product, matches every variant against competitors and scores its demand.
 * One broken product does not stop the rest; it is reported in the result.
 */
export async function evaluateSupplierProducts(externalIds: string[], trending: Set<string>, deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const productIds: string[] = [];
  const failed: DiscoveryResult["failed"] = [];
  for (const externalId of externalIds) {
    try {
      const imported = await importSupplierProduct(externalId, deps.importer);
      await db.product.update({ where: { id: imported.productId }, data: { supplierTrending: trending.has(externalId) } });
      const variants = await db.productVariant.findMany({ where: { productId: imported.productId }, select: { id: true, warehouse: true } });
      // Matching and scoring cost API calls; a variant that may not be listed (wrong warehouse) is not evaluated.
      for (const variant of variants.filter((candidate) => shipsFromAllowedWarehouse("EBAY", candidate, deps.demand.settings.listing))) {
        await runMatchingForVariant(variant.id, deps.matching);
        await scoreDemandForVariant(variant.id, deps.demand);
      }
      productIds.push(imported.productId);
    } catch (error) {
      logger.error({ externalId, err: error }, "discovery failed for a product");
      failed.push({ externalId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { productIds, failed };
}

export interface ListingCandidate {
  variantId: string;
  productId: string;
  score: number;
  processingDays: number;
  deliveryDaysMax: number;
}

/**
 * Variants worth listing among the given products, best demand score first:
 * the latest score is at or above the threshold, the supplier has stock in an allowed warehouse, and no listing exists yet.
 */
export async function pickListingCandidates(productIds: string[], settings: Pick<Settings, "demand" | "listing">): Promise<ListingCandidate[]> {
  const { threshold } = settings.demand;
  const variants = await db.productVariant.findMany({
    where: {
      productId: { in: productIds },
      product: { status: "ELIGIBLE" },
      stock: { gt: 0 },
      listings: { none: { status: { not: "ENDED" } } },
    },
    include: { demandSnapshots: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });
  return variants
    .flatMap((variant) => {
      const score = variant.demandSnapshots[0]?.score;
      // Candidates are listed on eBay.
      if (score === undefined || score < threshold || !shipsFromAllowedWarehouse("EBAY", variant, settings.listing)) return [];
      return [{ variantId: variant.id, productId: variant.productId, score, processingDays: variant.processingDays, deliveryDaysMax: variant.deliveryDaysMax }];
    })
    .sort((a, b) => b.score - a.score || a.variantId.localeCompare(b.variantId));
}

export interface HolidayCandidate {
  variantId: string;
  productId: string;
  score: number;
  cutoffDate: Date;
}

/** The top-N candidates for a holiday: those that can still arrive before it. */
export async function pickHolidayCandidates(
  holiday: Pick<Holiday, "autoListTopN">,
  holidayDate: Date,
  productIds: string[],
  settings: Pick<Settings, "demand" | "listing">,
  now: Date,
): Promise<HolidayCandidate[]> {
  const today = startOfDayUtc(now);
  return (await pickListingCandidates(productIds, settings))
    .map((candidate) => ({
      variantId: candidate.variantId,
      productId: candidate.productId,
      score: candidate.score,
      cutoffDate: cutoffDate(holidayDate, candidate.processingDays, candidate.deliveryDaysMax),
    }))
    .filter((candidate) => candidate.cutoffDate >= today)
    .slice(0, holiday.autoListTopN);
}
