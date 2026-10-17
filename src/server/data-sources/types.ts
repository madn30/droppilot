export interface TrendPoint {
  /** First day of the month, YYYY-MM-DD. */
  date: string;
  /** Relative interest 0–100. Not a volume and never a sales figure. */
  value: number;
}

export interface TrendData {
  keyword: string;
  geo: string;
  points: TrendPoint[];
  relatedRisingQueries: string[];
}

export interface TrendsSource {
  /** Five years of monthly Google Trends interest. */
  getInterestOverTime(keyword: string, geo: string): Promise<TrendData>;
}

export interface SalesRankPoint {
  date: string;
  rank: number;
}

export interface SalesRankSource {
  /** Amazon sales rank history for an ASIN; null when the ASIN is not tracked. */
  getSalesRankHistory(asin: string): Promise<SalesRankPoint[] | null>;
}
