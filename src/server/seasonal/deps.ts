import { getListingCopyGenerator } from "../ai";
import { getNotifiers } from "../alerts/notifiers";
import { buildDemandDeps } from "../demand/deps";
import { getEnv } from "../env";
import { getImageFetcher } from "../images/fetcher";
import { getMarketplaceAdapter } from "../marketplaces";
import { buildMatchingDeps } from "../matching/deps";
import { getSupplierAdapter } from "../suppliers";
import type { SeasonalDeps } from "./daily";

// Listings ship to US buyers first.
const DESTINATION_COUNTRY = "US";

/** The real (or mock, under MOCK_APIS) collaborators for the daily seasonal job. */
export async function buildSeasonalDeps(): Promise<SeasonalDeps> {
  const demand = await buildDemandDeps();
  return {
    listing: { copyGenerator: getListingCopyGenerator(), getMarketplace: getMarketplaceAdapter, notifiers: getNotifiers(), settings: demand.settings },
    importer: {
      supplier: getSupplierAdapter(),
      imageFetcher: getImageFetcher(),
      imageCacheDir: getEnv().IMAGE_CACHE_DIR,
      destinationCountry: DESTINATION_COUNTRY,
    },
    matching: await buildMatchingDeps(),
    demand,
    getMarketplace: getMarketplaceAdapter,
  };
}
