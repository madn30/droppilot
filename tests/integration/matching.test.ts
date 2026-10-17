import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MockEmbeddingsProvider } from "@/server/ai/mock/mock-embeddings";
import { MockSpecExtractor } from "@/server/ai/mock/mock-spec-extractor";
import { MockVisionVerifier } from "@/server/ai/mock/mock-vision-verifier";
import type { ImagePair, VisionVerdict, VisionVerifier } from "@/server/ai/types";
import { importSupplierProduct } from "@/server/catalog/import-product";
import { db } from "@/server/db";
import { MockImageFetcher } from "@/server/images/mock-image-fetcher";
import { MockAmazonAdapter, MockEbayAdapter } from "@/server/marketplaces/mock/mock-marketplace";
import type { CompetitorCandidate, MarketplaceAdapter } from "@/server/marketplaces/types";
import { setMatchDecision } from "@/server/matching/decisions";
import { type MatchingDeps, runMatchingForVariant } from "@/server/matching/run-matching";
import { findVariantsWithNewCompetitors } from "@/server/matching/watch";
import { NECKLACE_PRODUCT_ID, necklaceProduct } from "@/server/mocks/fixtures/necklace";
import { defaultSettings } from "@/server/settings/schema";
import { MockSupplierAdapter } from "@/server/suppliers/mock/mock-supplier";
import { resetDatabase } from "./reset-db";

const settings = defaultSettings({ MIN_PROFIT: 300, MAX_ACCEPTABLE_LOSS: 100, DEMAND_THRESHOLD: 60 }).matching;

/** Counts vision calls so tests can check when the (expensive) check is skipped. */
class CountingVisionVerifier implements VisionVerifier {
  calls: ImagePair[][] = [];
  private readonly inner = new MockVisionVerifier();
  verifySameProduct(pairs: ImagePair[]): Promise<VisionVerdict> {
    this.calls.push(pairs);
    return this.inner.verifySameProduct(pairs);
  }
}

let cacheDir: string;
let variantId: string;
let vision: CountingVisionVerifier;
let deps: MatchingDeps;

beforeEach(async () => {
  await resetDatabase();
  await db.supplier.create({ data: { code: "cj", name: "CJ Dropshipping", supportsBlindShipping: true } });
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "droppilot-matching-"));
  const imageFetcher = new MockImageFetcher();
  await importSupplierProduct(NECKLACE_PRODUCT_ID, {
    supplier: new MockSupplierAdapter(),
    imageFetcher,
    imageCacheDir: cacheDir,
    destinationCountry: "US",
  });
  variantId = (await db.productVariant.findFirstOrThrow()).id;
  vision = new CountingVisionVerifier();
  deps = {
    marketplaces: [new MockEbayAdapter(), new MockAmazonAdapter()],
    specExtractor: new MockSpecExtractor(),
    visionVerifier: vision,
    embeddings: new MockEmbeddingsProvider(),
    imageFetcher,
    imageCacheDir: cacheDir,
    settings,
  };
  return async () => {
    await rm(cacheDir, { recursive: true, force: true });
  };
});

afterAll(async () => {
  await db.$disconnect();
});

async function matchesByListing() {
  const matches = await db.productMatch.findMany({ include: { competitorListing: true } });
  return Object.fromEntries(matches.map((match) => [match.competitorListing.externalId, match]));
}

describe("matching the necklace against competitors A–H", () => {
  it("confirms only D and F, sends H to review and rejects the rest for the right reason", async () => {
    const summary = await runMatchingForVariant(variantId, deps);
    expect(summary).toMatchObject({ candidates: 8, confirmed: 2, review: 1, rejected: 5, isUnique: false });

    const matches = await matchesByListing();
    const verdicts = Object.fromEntries(
      Object.entries(matches).map(([id, match]) => [id, { status: match.status, failures: match.hardRuleFailures }]),
    );
    expect(verdicts).toEqual({
      "EBAY-A": { status: "REJECTED", failures: ["shape", "personalization"] },
      "EBAY-B": { status: "REJECTED", failures: ["personalization"] },
      "EBAY-C": { status: "REJECTED", failures: ["material", "personalization"] },
      "EBAY-D": { status: "CONFIRMED", failures: [] },
      "EBAY-E": { status: "REJECTED", failures: ["giftBox"] },
      B0MOCKNKF1: { status: "CONFIRMED", failures: [] },
      "EBAY-G": { status: "REJECTED", failures: ["sizeCm"] },
      "EBAY-H": { status: "REVIEW", failures: [] },
    });
  });

  it("scores images as the share of supplier photos reused by the competitor", async () => {
    await runMatchingForVariant(variantId, deps);
    const matches = await matchesByListing();
    expect(matches["EBAY-D"]).toMatchObject({ matchedImageCount: 4, specScore: 1 });
    expect(matches["EBAY-D"].imageScore).toBeCloseTo(4 / 6);
    expect(matches["EBAY-D"].finalScore).toBeCloseTo(0.4 * (4 / 6) + 0.3 + 0.3 * 0.95);
    expect(matches["EBAY-D"].finalScore).toBeGreaterThanOrEqual(0.85);

    expect(matches.B0MOCKNKF1.matchedImageCount).toBe(5);
    expect(matches["EBAY-A"].matchedImageCount).toBe(0);

    const h = matches["EBAY-H"];
    expect(h.matchedImageCount).toBe(3);
    expect(h.visionVerdict).toMatchObject({ same: true, confidence: 0.68 });
    expect(h.finalScore).toBeGreaterThanOrEqual(0.6);
    expect(h.finalScore).toBeLessThan(0.85);
  });

  it("runs the vision check only for listings that pass the hard rules, with at most four pairs", async () => {
    await runMatchingForVariant(variantId, deps);
    const checked = vision.calls.map((pairs) => new URL(pairs[0].competitor.url).pathname.split("/")[2]).sort();
    expect(checked).toEqual(["amazon-F", "ebay-D", "ebay-H"]);
    expect(vision.calls.every((pairs) => pairs.length === 4)).toBe(true);
    const matches = await matchesByListing();
    expect(matches["EBAY-E"].visionVerdict).toBeNull();
  });

  it("stores the extracted specs, fingerprints and cached images it worked from", async () => {
    await runMatchingForVariant(variantId, deps);
    const variant = await db.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    expect(variant.specs).toMatchObject({ material: "copper", shape: "heart", sizeCm: 45, personalization: true, giftBox: false });

    const supplierImages = await db.productImage.findMany();
    expect(supplierImages.every((image) => image.pHash?.length === 16 && image.embedding.length > 0)).toBe(true);

    const d = await db.competitorListing.findFirstOrThrow({ where: { externalId: "EBAY-D" }, include: { images: true } });
    expect(d.extractedSpecs).toMatchObject({ material: "copper", personalization: true });
    expect(d.images).toHaveLength(6);
    expect(d.images.every((image) => image.localPath && image.pHash && image.embedding.length > 0)).toBe(true);
  });

  it("is repeatable: a second run changes nothing and creates no duplicates", async () => {
    const first = await runMatchingForVariant(variantId, deps);
    const second = await runMatchingForVariant(variantId, deps);
    expect(second).toEqual(first);
    expect(await db.productMatch.count()).toBe(8);
    expect(await db.competitorListing.count()).toBe(8);
    expect(await db.competitorImage.count()).toBe(39);
  });

  it("keeps the user's decisions across re-runs and lets them override the algorithm", async () => {
    await runMatchingForVariant(variantId, deps);
    const before = await matchesByListing();
    await setMatchDecision(before["EBAY-H"].id, "CONFIRMED");
    await setMatchDecision(before["EBAY-D"].id, "REJECTED");

    const summary = await runMatchingForVariant(variantId, deps);
    expect(summary).toMatchObject({ confirmed: 2, review: 0, rejected: 6 });

    const after = await matchesByListing();
    expect(after["EBAY-H"]).toMatchObject({ status: "CONFIRMED", decidedBy: "USER" });
    expect(after["EBAY-D"]).toMatchObject({ status: "REJECTED", decidedBy: "USER" });
    expect(after["EBAY-D"].decidedAt).not.toBeNull();
    expect(after.B0MOCKNKF1).toMatchObject({ status: "CONFIRMED", decidedBy: "AUTO" });
  });

  it("marks the variant unique when no competitor is confirmed, and clears the flag when one is", async () => {
    await runMatchingForVariant(variantId, deps);
    const matches = await matchesByListing();
    await setMatchDecision(matches["EBAY-D"].id, "REJECTED");
    await setMatchDecision(matches.B0MOCKNKF1.id, "REJECTED");
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: variantId } })).isUnique).toBe(true);

    await setMatchDecision(matches["EBAY-H"].id, "CONFIRMED");
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: variantId } })).isUnique).toBe(false);
  });
});

describe("matching never relies on the title alone", () => {
  function singleListing(candidate: CompetitorCandidate): MarketplaceAdapter {
    return {
      marketplace: "EBAY",
      searchByKeyword: async () => [candidate],
      listCandidateIds: async () => [candidate.externalId],
      publishListing: () => Promise.reject(new Error("not used")),
      updateListing: () => Promise.reject(new Error("not used")),
      endListing: () => Promise.reject(new Error("not used")),
      getOrders: async () => [],
      uploadTracking: () => Promise.reject(new Error("not used")),
      getAccountHealth: () => Promise.reject(new Error("not used")),
    };
  }

  // Same title, same description and the very same photos as the supplier.
  const lookalike: CompetitorCandidate = {
    marketplace: "EBAY",
    externalId: "EBAY-LOOKALIKE",
    title: necklaceProduct.title,
    description: "Personalized photo projection necklace, heart pendant, 45cm chain, opp bag.",
    url: "https://www.ebay.com/itm/EBAY-LOOKALIKE",
    priceCents: 1999,
    shippingCents: 0,
    currency: "USD",
    deliveryDays: 6,
    sellerRating: 99,
    soldCount: 10,
    imageUrls: necklaceProduct.imageUrls,
    itemSpecifics: { Material: "Copper", Shape: "Heart", Color: "Rose Gold", Length: "45cm", Personalized: "Yes" },
  };

  it("confirms the lookalike when its stated material is the same", async () => {
    const summary = await runMatchingForVariant(variantId, { ...deps, marketplaces: [singleListing(lookalike)] });
    expect(summary).toMatchObject({ candidates: 1, confirmed: 1 });
  });

  it("rejects the same title and photos when the stated material differs", async () => {
    const silver = { ...lookalike, itemSpecifics: { ...lookalike.itemSpecifics, Material: "925 Silver" } };
    const summary = await runMatchingForVariant(variantId, { ...deps, marketplaces: [singleListing(silver)] });
    expect(summary).toMatchObject({ candidates: 1, confirmed: 0, rejected: 1, isUnique: true });

    const match = await db.productMatch.findFirstOrThrow();
    expect(match.imageScore).toBe(1);
    expect(match.hardRuleFailures).toEqual(["material"]);
    expect(match.status).toBe("REJECTED");
  });

  it("re-extracts specs when a known listing changes its text", async () => {
    await runMatchingForVariant(variantId, { ...deps, marketplaces: [singleListing(lookalike)] });
    const changed = { ...lookalike, title: `${lookalike.title} 925 Sterling Silver`, itemSpecifics: { Shape: "Heart", Length: "45cm", Personalized: "Yes" } };
    const summary = await runMatchingForVariant(variantId, { ...deps, marketplaces: [singleListing(changed)] });
    expect(summary).toMatchObject({ confirmed: 0, rejected: 1 });
    expect((await db.productMatch.findFirstOrThrow()).hardRuleFailures).toEqual(["material"]);
  });
});

describe("watching for new competitor listings", () => {
  it("flags a variant only when a search returns a listing it has not been matched against", async () => {
    await runMatchingForVariant(variantId, deps);
    expect(await findVariantsWithNewCompetitors(deps.marketplaces)).toEqual([]);

    const newcomer: MarketplaceAdapter = {
      marketplace: "EBAY",
      searchByKeyword: async () => [],
      listCandidateIds: async () => ["EBAY-D", "EBAY-NEW"],
      publishListing: () => Promise.reject(new Error("not used")),
      updateListing: () => Promise.reject(new Error("not used")),
      endListing: () => Promise.reject(new Error("not used")),
      getOrders: async () => [],
      uploadTracking: () => Promise.reject(new Error("not used")),
      getAccountHealth: () => Promise.reject(new Error("not used")),
    };
    expect(await findVariantsWithNewCompetitors([newcomer])).toEqual([variantId]);

    // A listing known on another marketplace under the same id is still new here.
    const sameIdElsewhere: MarketplaceAdapter = { ...newcomer, marketplace: "AMAZON", listCandidateIds: async () => ["EBAY-D"] };
    expect(await findVariantsWithNewCompetitors([sameIdElsewhere])).toEqual([variantId]);
  });

  it("ignores products that were rejected or archived", async () => {
    await db.product.updateMany({ data: { status: "ARCHIVED" } });
    expect(await findVariantsWithNewCompetitors(deps.marketplaces)).toEqual([]);
  });
});

describe("unique products", () => {
  it("marks a variant unique when the marketplaces return nothing", async () => {
    const empty: MarketplaceAdapter = {
      marketplace: "EBAY",
      searchByKeyword: async () => [],
      listCandidateIds: async () => [],
      publishListing: () => Promise.reject(new Error("not used")),
      updateListing: () => Promise.reject(new Error("not used")),
      endListing: () => Promise.reject(new Error("not used")),
      getOrders: async () => [],
      uploadTracking: () => Promise.reject(new Error("not used")),
      getAccountHealth: () => Promise.reject(new Error("not used")),
    };
    const summary = await runMatchingForVariant(variantId, { ...deps, marketplaces: [empty] });
    expect(summary).toMatchObject({ candidates: 0, confirmed: 0, isUnique: true });
  });
});
