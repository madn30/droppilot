import type { Settings } from "../settings/schema";

export interface DemandComponents {
  salesVelocity: number;
  trendDirection: number;
  competition: number;
  profitMargin: number;
  deliverySpeed: number;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// An Amazon sales rank at or better than this is a fast seller; at or beyond SLOW it barely sells.
const FAST_RANK = 1_000;
const SLOW_RANK = 500_000;
// Units sold in 90 days across confirmed eBay listings that count as a proven seller.
const STRONG_EBAY_SOLD = 300;
// Appearing in the supplier's trending list is a real but indirect signal.
const SUPPLIER_TRENDING_SCORE = 0.6;

export interface VelocitySignals {
  /** Best current Amazon sales rank among confirmed matches. */
  salesRank: number | null;
  /** Units sold in the last 90 days across confirmed eBay matches; null unless Marketplace Insights is enabled. */
  ebaySold: number | null;
  supplierTrending: boolean;
}

/** Average of the sales signals that are available; 0 when there is no evidence of sales at all. */
export function salesVelocityScore(signals: VelocitySignals): number {
  const scores: number[] = [];
  if (signals.salesRank !== null) {
    const rank = Math.max(1, signals.salesRank);
    scores.push(clamp((Math.log10(SLOW_RANK) - Math.log10(rank)) / (Math.log10(SLOW_RANK) - Math.log10(FAST_RANK))));
  }
  if (signals.ebaySold !== null) {
    scores.push(clamp(Math.log10(1 + signals.ebaySold) / Math.log10(1 + STRONG_EBAY_SOLD)));
  }
  if (signals.supplierTrending) scores.push(SUPPLIER_TRENDING_SCORE);
  return scores.length === 0 ? 0 : scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

/** Flat interest scores 0.5; ±50% over five years reaches the ends of the scale. */
export function trendDirectionScore(changeRate: number): number {
  return clamp(0.5 + changeRate);
}

/** No confirmed competitor scores 1; each additional one makes the market less attractive. */
export function competitionScore(confirmedCompetitors: number): number {
  return 1 / (1 + confirmedCompetitors / 3);
}

// A 30% margin after fees is excellent for this business.
const EXCELLENT_MARGIN = 0.3;

/** 0 when our floor is above the market price: the product cannot be sold profitably at all. */
export function profitMarginScore(marginRate: number, canCompete: boolean): number {
  return canCompete ? clamp(marginRate / EXCELLENT_MARGIN) : 0;
}

const FAST_DELIVERY_DAYS = 5;
const SLOW_DELIVERY_DAYS = 20;

/** Processing plus the slowest delivery estimate: 5 days or less scores 1, 20 or more scores 0. */
export function deliverySpeedScore(totalDays: number): number {
  return clamp((SLOW_DELIVERY_DAYS - totalDays) / (SLOW_DELIVERY_DAYS - FAST_DELIVERY_DAYS));
}

/** Weighted mix of the components, 0–100. */
export function demandScore(components: DemandComponents, weights: Settings["demand"]["weights"]): number {
  const total = weights.salesVelocity + weights.trendDirection + weights.competition + weights.profitMargin + weights.deliverySpeed;
  if (total === 0) return 0;
  const weighted =
    weights.salesVelocity * components.salesVelocity +
    weights.trendDirection * components.trendDirection +
    weights.competition * components.competition +
    weights.profitMargin * components.profitMargin +
    weights.deliverySpeed * components.deliverySpeed;
  return Math.round((weighted / total) * 1000) / 10;
}
