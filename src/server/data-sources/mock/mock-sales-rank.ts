import type { SalesRankPoint, SalesRankSource } from "../types";

const DAYS = 90;
const TRACKED_ASINS: Record<string, { startRank: number; endRank: number }> = {
  // Competitor F of the necklace scenario: steadily improving rank.
  B0MOCKNKF1: { startRank: 48_000, endRank: 21_000 },
};

/** Deterministic 90-day daily sales rank history for the fixture ASINs. */
export class MockSalesRankSource implements SalesRankSource {
  constructor(private readonly asOf: () => Date = () => new Date()) {}

  async getSalesRankHistory(asin: string): Promise<SalesRankPoint[] | null> {
    const tracked = TRACKED_ASINS[asin];
    if (!tracked) return null;

    const end = this.asOf();
    const points: SalesRankPoint[] = [];
    for (let index = 0; index < DAYS; index++) {
      const date = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() - (DAYS - 1 - index)));
      const progress = index / (DAYS - 1);
      points.push({
        date: date.toISOString().slice(0, 10),
        rank: Math.round(tracked.startRank + (tracked.endRank - tracked.startRank) * progress),
      });
    }
    return points;
  }
}
