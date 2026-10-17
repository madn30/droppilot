import type { SalesRankSource, TrendsSource } from "../data-sources/types";
import { db } from "../db";
import {
  computeFloorCents,
  computeProfitCents,
  marginTargetPriceCents,
  resolveListingPriceCents,
  roundUpToPriceEnding,
} from "../pricing/engine";
import type { Settings } from "../settings/schema";
import {
  type DemandComponents,
  competitionScore,
  deliverySpeedScore,
  demandScore,
  profitMarginScore,
  salesVelocityScore,
  trendDirectionScore,
} from "./score";
import { analyzeTrend, trendKeyword } from "./trend-analysis";

const TREND_GEO = "US";
// Google Trends moves slowly; one fetch per product per week is plenty.
const TREND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Demand is scored for the first marketplace we list on.
const PRICING_MARKETPLACE = "EBAY";

export interface DemandDeps {
  trends: TrendsSource;
  salesRank: SalesRankSource;
  /** eBay Marketplace Insights: units sold in the last 90 days per listing id. Used only when enabled in Settings. */
  soldQuantities?: (keyword: string) => Promise<Map<string, number>>;
  settings: Settings;
  now?: () => Date;
}

export interface DemandResult {
  variantId: string;
  score: number;
  components: DemandComponents;
  eligible: boolean;
}

/** Latest stored trend for the product, refreshed from Google Trends when it is older than a week. */
async function currentTrendChange(product: { id: string; title: string }, deps: DemandDeps, now: Date): Promise<number> {
  const keyword = trendKeyword(product.title);
  if (!keyword) return 0;

  const latest = await db.trendSnapshot.findFirst({
    where: { productId: product.id, keyword, geo: TREND_GEO },
    orderBy: { capturedAt: "desc" },
  });
  const points =
    latest && now.getTime() - latest.capturedAt.getTime() < TREND_MAX_AGE_MS
      ? null
      : await deps.trends.getInterestOverTime(keyword, TREND_GEO);

  if (!points) {
    // The stored series was written by this function; re-analysing it keeps one source of truth.
    return analyzeTrend(latest?.series as { date: string; value: number }[]).changeRate;
  }

  const analysis = analyzeTrend(points.points);
  await db.trendSnapshot.create({
    data: {
      productId: product.id,
      keyword,
      geo: TREND_GEO,
      direction: analysis.direction,
      peakMonth: analysis.peakMonth,
      series: points.points.map((point) => ({ ...point })),
      relatedQueries: points.relatedRisingQueries,
      capturedAt: now,
    },
  });
  return analysis.changeRate;
}

/**
 * Scores demand for one variant from its confirmed matches only, stores a
 * snapshot, and updates whether the product is eligible for auto-listing.
 */
export async function scoreDemandForVariant(variantId: string, deps: DemandDeps): Promise<DemandResult> {
  const now = deps.now?.() ?? new Date();
  const variant = await db.productVariant.findUniqueOrThrow({
    where: { id: variantId },
    include: {
      product: true,
      matches: { where: { status: "CONFIRMED" }, include: { competitorListing: true } },
    },
  });
  const competitors = variant.matches.map((match) => match.competitorListing);

  // Sales velocity: Amazon sales rank, eBay sold counts (only with Marketplace Insights access), supplier trending.
  let salesRank: number | null = null;
  for (const listing of competitors.filter((competitor) => competitor.marketplace === "AMAZON")) {
    const history = await deps.salesRank.getSalesRankHistory(listing.externalId);
    const latest = history?.at(-1)?.rank;
    if (latest !== undefined && (salesRank === null || latest < salesRank)) salesRank = latest;
  }
  let ebaySold: number | null = null;
  if (deps.settings.demand.marketplaceInsightsEnabled && deps.soldQuantities) {
    const sold = await deps.soldQuantities(variant.product.title);
    ebaySold = competitors
      .filter((competitor) => competitor.marketplace === "EBAY")
      .reduce((sum, competitor) => sum + (sold.get(competitor.externalId) ?? 0), 0);
  }

  const changeRate = await currentTrendChange(variant.product, deps, now);

  // Margin at the price we would list at: just under the cheapest confirmed competitor, or the margin target when unique.
  const cost = { costCents: variant.costCents, shippingCents: variant.shippingCents };
  const floorCents = computeFloorCents(cost, PRICING_MARKETPLACE, deps.settings);
  const lowestCompetitorCents =
    competitors.length === 0 ? null : Math.min(...competitors.map((competitor) => competitor.priceCents + competitor.shippingCents));
  const targetCents =
    lowestCompetitorCents === null
      ? roundUpToPriceEnding(marginTargetPriceCents(cost, PRICING_MARKETPLACE, deps.settings))
      : lowestCompetitorCents - deps.settings.repricer.undercutMinCents;
  const priceCents = resolveListingPriceCents(targetCents, floorCents);
  const marginRate = computeProfitCents(priceCents, cost, PRICING_MARKETPLACE, deps.settings) / priceCents;
  const canCompete = lowestCompetitorCents === null || priceCents <= lowestCompetitorCents;

  const components: DemandComponents = {
    salesVelocity: salesVelocityScore({ salesRank, ebaySold, supplierTrending: variant.product.supplierTrending }),
    trendDirection: trendDirectionScore(changeRate),
    competition: competitionScore(competitors.length),
    profitMargin: profitMarginScore(marginRate, canCompete),
    deliverySpeed: deliverySpeedScore(variant.processingDays + variant.deliveryDaysMax),
  };
  const score = demandScore(components, deps.settings.demand.weights);

  await db.demandSnapshot.create({
    data: {
      variantId: variant.id,
      score,
      components: { ...components },
      competitorCount: competitors.length,
      lowestCompetitorCents,
      salesRank,
      soldLast30d: ebaySold === null ? null : Math.round(ebaySold / 3),
      capturedAt: now,
    },
  });

  const eligible = await refreshProductEligibility(variant.productId, deps.settings.demand.threshold);
  return { variantId: variant.id, score, components, eligible };
}

/**
 * A product is eligible for auto-listing when the latest score of any of its
 * variants reaches the threshold. Products the user rejected or archived are left alone.
 */
async function refreshProductEligibility(productId: string, threshold: number): Promise<boolean> {
  const product = await db.product.findUniqueOrThrow({
    where: { id: productId },
    include: { variants: { include: { demandSnapshots: { orderBy: { capturedAt: "desc" }, take: 1 } } } },
  });
  const eligible = product.variants.some((variant) => (variant.demandSnapshots[0]?.score ?? -1) >= threshold);
  if (product.status !== "REJECTED" && product.status !== "ARCHIVED") {
    await db.product.update({ where: { id: productId }, data: { status: eligible ? "ELIGIBLE" : "MATCHING" } });
  }
  return eligible;
}
