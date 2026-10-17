import type { TrendData, TrendPoint, TrendsSource } from "../types";

const MONTHS = 60;

// Keyword fragments → the month (1–12) in which interest peaks.
const SEASONAL_PEAKS: [RegExp, number][] = [
  [/valentine|necklace|heart|love/, 2],
  [/mother|mom/, 5],
  [/father|dad/, 6],
  [/school|backpack/, 8],
  [/halloween|costume|pumpkin/, 10],
  [/black friday|cyber monday/, 11],
  [/christmas|xmas|ornament|santa/, 12],
];

/**
 * Deterministic five-year monthly series: a slow upward trend plus a yearly
 * spike in the keyword's peak month. `asOf` fixes the last month of the series.
 */
export class MockTrendsSource implements TrendsSource {
  constructor(private readonly asOf: () => Date = () => new Date()) {}

  async getInterestOverTime(keyword: string, geo: string): Promise<TrendData> {
    const normalized = keyword.toLowerCase();
    const peakMonth = SEASONAL_PEAKS.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
    const end = this.asOf();

    const points: TrendPoint[] = [];
    for (let index = 0; index < MONTHS; index++) {
      const date = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - (MONTHS - 1 - index), 1));
      const month = date.getUTCMonth() + 1;
      const baseline = 30 + (index / (MONTHS - 1)) * 15;
      const seasonal = month === peakMonth ? 55 : month === previousMonth(peakMonth) ? 20 : 0;
      points.push({ date: date.toISOString().slice(0, 10), value: Math.round(Math.min(100, baseline + seasonal)) });
    }

    return {
      keyword,
      geo,
      points,
      relatedRisingQueries: [`personalized ${normalized}`, `${normalized} gift for her`, `custom ${normalized}`],
    };
  }
}

function previousMonth(month: number | null): number | null {
  if (month === null) return null;
  return month === 1 ? 12 : month - 1;
}
