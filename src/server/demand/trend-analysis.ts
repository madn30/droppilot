import type { TrendPoint } from "../data-sources/types";

export type TrendDirection = "rising" | "flat" | "falling";

export interface TrendAnalysis {
  direction: TrendDirection;
  /** Change in average interest from the first to the last 12 months, e.g. 0.3 = +30%. */
  changeRate: number;
  /** Month (1–12) of the yearly peak, or null when interest is not seasonal. */
  peakMonth: number | null;
}

const DIRECTION_THRESHOLD = 0.15;
// A month counts as a seasonal peak when it averages this many times the overall mean.
const SEASONAL_PEAK_RATIO = 1.5;
// Below this average interest Google's index is mostly zeros and single spikes: too thin to read a direction or a season from.
const MIN_MEAN_INTEREST = 5;

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Reads direction and seasonality out of a monthly Google Trends series.
 * The values are relative interest (0–100): they say whether attention is
 * growing and when it peaks, never how many units sell.
 */
export function analyzeTrend(points: TrendPoint[]): TrendAnalysis {
  const values = points.map((point) => point.value);
  if (mean(values) < MIN_MEAN_INTEREST) return { direction: "flat", changeRate: 0, peakMonth: null };

  let changeRate = 0;
  // Direction needs two separate years to compare; anything shorter is treated as flat.
  if (values.length >= 24) {
    const first = mean(values.slice(0, 12));
    const last = mean(values.slice(-12));
    changeRate = first === 0 ? (last > 0 ? 1 : 0) : (last - first) / first;
  }
  const direction: TrendDirection =
    changeRate >= DIRECTION_THRESHOLD ? "rising" : changeRate <= -DIRECTION_THRESHOLD ? "falling" : "flat";

  let peakMonth: number | null = null;
  const overall = mean(values);
  if (values.length >= 12 && overall > 0) {
    const byMonth = new Map<number, number[]>();
    for (const point of points) {
      const month = Number(point.date.slice(5, 7));
      byMonth.set(month, [...(byMonth.get(month) ?? []), point.value]);
    }
    const [bestMonth, bestAverage] = [...byMonth.entries()]
      .map(([month, monthValues]) => [month, mean(monthValues)] as const)
      .reduce((best, entry) => (entry[1] > best[1] ? entry : best));
    if (bestAverage >= overall * SEASONAL_PEAK_RATIO) peakMonth = bestMonth;
  }

  return { direction, changeRate, peakMonth };
}

// Words that describe the offer rather than the product; Google Trends keywords must be short.
const FILLER_WORDS = new Set([
  "custom", "customized", "personalized", "personalised", "new", "hot", "sale", "fashion", "creative",
  "for", "with", "and", "the", "a", "an", "of", "in", "to", "women", "men", "womens", "mens", "girls",
  "boys", "kids", "her", "him", "gift", "gifts", "pcs", "set", "style", "cute", "simple", "luxury",
]);
const MAX_KEYWORD_WORDS = 3;

/** A short search phrase for a product, e.g. "Custom Photo Projection Necklace" → "photo projection necklace". */
export function trendKeyword(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !FILLER_WORDS.has(word));
  return words.slice(0, MAX_KEYWORD_WORDS).join(" ");
}
