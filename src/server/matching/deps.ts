import { getEmbeddingsProvider, getSpecExtractor, getVisionVerifier } from "../ai";
import { getEnv } from "../env";
import { getImageFetcher } from "../images/fetcher";
import { enabledMarketplaces, getMarketplaceAdapter } from "../marketplaces";
import { getSettings } from "../settings/service";
import type { MatchingDeps } from "./run-matching";

/** The real (or mock, under MOCK_APIS) collaborators for a matching run, with current settings. */
export async function buildMatchingDeps(): Promise<MatchingDeps> {
  return {
    marketplaces: enabledMarketplaces().map(getMarketplaceAdapter),
    specExtractor: getSpecExtractor(),
    visionVerifier: getVisionVerifier(),
    embeddings: getEmbeddingsProvider(),
    imageFetcher: getImageFetcher(),
    imageCacheDir: getEnv().IMAGE_CACHE_DIR,
    settings: (await getSettings()).matching,
  };
}
