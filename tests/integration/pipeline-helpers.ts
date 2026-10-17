import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Marketplace } from "@prisma/client";
import { MockNotifier } from "@/server/alerts/notifiers";
import { MockEmbeddingsProvider } from "@/server/ai/mock/mock-embeddings";
import { MockListingCopyGenerator } from "@/server/ai/mock/mock-listing-copy";
import { MockSpecExtractor } from "@/server/ai/mock/mock-spec-extractor";
import { MockVisionVerifier } from "@/server/ai/mock/mock-vision-verifier";
import { MockSalesRankSource } from "@/server/data-sources/mock/mock-sales-rank";
import { MockTrendsSource } from "@/server/data-sources/mock/mock-trends";
import { db } from "@/server/db";
import { MockImageFetcher } from "@/server/images/mock-image-fetcher";
import { MockAmazonAdapter, MockEbayAdapter } from "@/server/marketplaces/mock/mock-marketplace";
import type { SeasonalDeps } from "@/server/seasonal/daily";
import { type Settings, defaultSettings } from "@/server/settings/schema";
import type { OrderDeps } from "@/server/orders/deps";
import { MockSupplierAdapter } from "@/server/suppliers/mock/mock-supplier";
import { resetDatabase } from "./reset-db";

export interface MockPipeline {
  cacheDir: string;
  settings: Settings;
  supplier: MockSupplierAdapter;
  ebay: MockEbayAdapter;
  amazon: MockAmazonAdapter;
  /** Dependencies for the whole pipeline with every "now" pinned to `clock.now`. */
  deps: SeasonalDeps;
  orderDeps: OrderDeps;
  email: MockNotifier;
  telegram: MockNotifier;
  /** Receives the listing notices (draft waiting, listed), apart from the order alerts above. */
  listingNotices: MockNotifier;
  clock: { now: Date };
}

/** A clean database with the CJ supplier registered and every external API mocked. */
export async function createMockPipeline(now: string): Promise<MockPipeline> {
  await resetDatabase();
  await db.supplier.create({ data: { code: "cj", name: "CJ Dropshipping", supportsBlindShipping: true } });

  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "droppilot-pipeline-"));
  const settings = defaultSettings({ MIN_PROFIT: 300, MAX_ACCEPTABLE_LOSS: 100, DEMAND_THRESHOLD: 60 });
  const clock = { now: new Date(now) };
  const supplier = new MockSupplierAdapter();
  const ebay = new MockEbayAdapter();
  const amazon = new MockAmazonAdapter();
  const imageFetcher = new MockImageFetcher();

  const getMarketplace = (marketplace: Marketplace) => (marketplace === "EBAY" ? ebay : amazon);

  const listingNotices = new MockNotifier("listing-notices");
  const deps: SeasonalDeps = {
    importer: { supplier, imageFetcher, imageCacheDir: cacheDir, destinationCountry: "US" },
    matching: {
      marketplaces: [ebay, amazon],
      specExtractor: new MockSpecExtractor(),
      visionVerifier: new MockVisionVerifier(),
      embeddings: new MockEmbeddingsProvider(),
      imageFetcher,
      imageCacheDir: cacheDir,
      settings: settings.matching,
    },
    demand: {
      trends: new MockTrendsSource(() => clock.now),
      salesRank: new MockSalesRankSource(() => clock.now),
      soldQuantities: (keyword) => ebay.getSoldQuantities(keyword),
      settings,
      now: () => clock.now,
    },
    getMarketplace,
    listing: { copyGenerator: new MockListingCopyGenerator(), getMarketplace, notifiers: [listingNotices], settings, now: () => clock.now },
  };
  const email = new MockNotifier("email");
  const telegram = new MockNotifier("telegram");
  const orderDeps: OrderDeps = { supplier, getMarketplace, notifiers: [email, telegram], settings, now: () => clock.now };
  return { cacheDir, settings, supplier, ebay, amazon, deps, orderDeps, email, telegram, listingNotices, clock };
}

export async function seedHolidays(): Promise<void> {
  await db.holiday.createMany({
    data: [
      {
        code: "valentines",
        name: "Valentine's Day",
        dateRule: "02-14",
        keywords: ["valentines day gift", "gift for her"],
        categories: ["Jewelry"],
        retargetToCode: "mothers-day",
      },
      {
        code: "mothers-day",
        name: "Mother's Day",
        dateRule: "nth:5:2:0",
        keywords: ["mothers day gift", "gift for mom"],
        categories: ["Jewelry"],
        retargetToCode: "fathers-day",
      },
      { code: "fathers-day", name: "Father's Day", dateRule: "nth:6:3:0", keywords: ["fathers day gift"], categories: ["Tools"] },
    ],
  });
}
