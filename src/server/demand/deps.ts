import { getSalesRankSource, getTrendsSource } from "../data-sources";
import { getMarketplaceAdapter } from "../marketplaces";
import { getSettings } from "../settings/service";
import type { DemandDeps } from "./run-demand";

/** The real (or mock, under MOCK_APIS) collaborators for demand scoring, with current settings. */
export async function buildDemandDeps(): Promise<DemandDeps> {
  const ebay = getMarketplaceAdapter("EBAY");
  const { getSoldQuantities } = ebay;
  return {
    trends: getTrendsSource(),
    salesRank: getSalesRankSource(),
    soldQuantities: getSoldQuantities ? (keyword) => getSoldQuantities.call(ebay, keyword) : undefined,
    settings: await getSettings(),
  };
}
