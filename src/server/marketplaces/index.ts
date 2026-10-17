import type { Marketplace } from "@prisma/client";
import { getAspectFiller } from "../ai";
import { type Env, getEnv, isAmazonEnabled } from "../env";
import { AmazonAdapter } from "./amazon/amazon-adapter";
import { SpApiClient } from "./amazon/client";
import { EbayClient } from "./ebay/client";
import { EbayAdapter } from "./ebay/ebay-adapter";
import { MockAmazonAdapter, MockEbayAdapter } from "./mock/mock-marketplace";
import type { MarketplaceAdapter } from "./types";

let ebay: MarketplaceAdapter | undefined;
let amazon: MarketplaceAdapter | undefined;

function createEbayAdapter(): MarketplaceAdapter {
  return getEnv().MOCK_APIS ? new MockEbayAdapter() : createRealEbayAdapter();
}

/** The real eBay adapter (live mode). */
export function createRealEbayAdapter(): EbayAdapter {
  const env = getEnv();
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET || !env.EBAY_REFRESH_TOKEN) {
    throw new Error("EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_REFRESH_TOKEN are required when MOCK_APIS=false");
  }
  return new EbayAdapter(
    new EbayClient({
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
      refreshToken: env.EBAY_REFRESH_TOKEN,
      environment: env.EBAY_ENV,
    }),
    undefined,
    getAspectFiller(),
  );
}

/** The real Amazon adapter (live mode with Amazon configured). */
export function createRealAmazonAdapter(): AmazonAdapter {
  const env = getEnv();
  if (!env.SPAPI_LWA_CLIENT_ID || !env.SPAPI_LWA_CLIENT_SECRET || !env.SPAPI_REFRESH_TOKEN || !env.SPAPI_SELLER_ID) {
    throw new Error("Amazon is not configured: set the four SPAPI_ keys to use it");
  }
  return new AmazonAdapter(
    new SpApiClient({
      clientId: env.SPAPI_LWA_CLIENT_ID,
      clientSecret: env.SPAPI_LWA_CLIENT_SECRET,
      refreshToken: env.SPAPI_REFRESH_TOKEN,
      region: env.SPAPI_REGION,
    }),
    { sellerId: env.SPAPI_SELLER_ID },
  );
}

/** The marketplaces DropPilot works with: both in mock mode; in live mode Amazon only when it is configured. */
export function enabledMarketplaces(): Marketplace[] {
  return isAmazonEnabled(getEnv()) ? ["EBAY", "AMAZON"] : ["EBAY"];
}

// One instance per marketplace per process: the mocks are stateful and the real clients hold tokens and rate limiters.
export function getMarketplaceAdapter(marketplace: Marketplace): MarketplaceAdapter {
  switch (marketplace) {
    case "EBAY":
      ebay ??= createEbayAdapter();
      return ebay;
    case "AMAZON":
      amazon ??= getEnv().MOCK_APIS ? new MockAmazonAdapter() : createRealAmazonAdapter();
      return amazon;
  }
}

/**
 * The public page of one of our eBay listings; null for drafts and mock listings.
 * Amazon listings get no link: their id is our SKU until Amazon assigns an ASIN.
 */
export function listingUrl(env: Pick<Env, "MOCK_APIS" | "EBAY_ENV">, marketplace: Marketplace, externalId: string | null): string | null {
  if (env.MOCK_APIS || marketplace !== "EBAY" || !externalId) return null;
  return `https://${env.EBAY_ENV === "sandbox" ? "sandbox" : "www"}.ebay.com/itm/${encodeURIComponent(externalId)}`;
}
