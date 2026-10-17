import { rm } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { importSupplierProduct } from "@/server/catalog/import-product";
import { db } from "@/server/db";
import { scoreDemandForVariant } from "@/server/demand/run-demand";
import { setMatchDecision } from "@/server/matching/decisions";
import { runMatchingForVariant } from "@/server/matching/run-matching";
import { NECKLACE_PRODUCT_ID, NECKLACE_VARIANT_ID } from "@/server/mocks/fixtures/necklace";
import { runTrendingDiscovery } from "@/server/discovery/trending";
import { runSeasonalDaily } from "@/server/seasonal/daily";
import { handleEndedHolidays, pauseListingsPastCutoff } from "@/server/seasonal/lifecycle";
import { type MockPipeline, createMockPipeline, seedHolidays } from "./pipeline-helpers";

let pipeline: MockPipeline;

beforeEach(async () => {
  pipeline = await createMockPipeline("2027-01-10T09:00:00Z");
  return async () => {
    await rm(pipeline.cacheDir, { recursive: true, force: true });
  };
});

afterAll(async () => {
  await db.$disconnect();
});

async function importAndMatch(): Promise<string> {
  await importSupplierProduct(NECKLACE_PRODUCT_ID, pipeline.deps.importer);
  const variant = await db.productVariant.findFirstOrThrow();
  await runMatchingForVariant(variant.id, pipeline.deps.matching);
  return variant.id;
}

describe("demand scoring", () => {
  it("scores the necklace from its confirmed matches only", async () => {
    const variantId = await importAndMatch();
    const result = await scoreDemandForVariant(variantId, pipeline.deps.demand);

    // Confirmed: D ($26.99) and F ($24.99). Rejected and review listings (A at $4.99, H…) must not count.
    const snapshot = await db.demandSnapshot.findFirstOrThrow();
    expect(snapshot).toMatchObject({ competitorCount: 2, lowestCompetitorCents: 2499, salesRank: 21_000 });

    expect(result.components.competition).toBeCloseTo(0.6);
    // Listed at $24.89: profit $3.70, a 14.9% margin out of a 30% "excellent" margin.
    expect(result.components.profitMargin).toBeCloseTo(370 / 2489 / 0.3, 3);
    // 2 processing + 5 delivery days.
    expect(result.components.deliverySpeed).toBeCloseTo(13 / 15);
    // Amazon rank 21,000 only: the supplier-trending flag is set by discovery, not here.
    expect(result.components.salesVelocity).toBeCloseTo(0.51, 2);
    expect(result.components.trendDirection).toBeGreaterThan(0.65);
    expect(result.score).toBe(snapshot.score);
  });

  it("stores the Google Trends reading and reuses it within a week", async () => {
    const variantId = await importAndMatch();
    await scoreDemandForVariant(variantId, pipeline.deps.demand);

    const trend = await db.trendSnapshot.findFirstOrThrow();
    expect(trend).toMatchObject({ keyword: "photo projection necklace", geo: "US", direction: "rising", peakMonth: 2 });
    expect(trend.series).toHaveLength(60);
    expect(trend.relatedQueries).toContain("personalized photo projection necklace");

    pipeline.clock.now = new Date("2027-01-13T09:00:00Z");
    await scoreDemandForVariant(variantId, pipeline.deps.demand);
    expect(await db.trendSnapshot.count()).toBe(1);

    pipeline.clock.now = new Date("2027-01-20T09:00:00Z");
    await scoreDemandForVariant(variantId, pipeline.deps.demand);
    expect(await db.trendSnapshot.count()).toBe(2);
    expect(await db.demandSnapshot.count()).toBe(3);
  });

  it("counts eBay sold data only when Marketplace Insights is enabled", async () => {
    const variantId = await importAndMatch();
    const without = await scoreDemandForVariant(variantId, pipeline.deps.demand);

    const settings = structuredClone(pipeline.settings);
    settings.demand.marketplaceInsightsEnabled = true;
    const withInsights = await scoreDemandForVariant(variantId, { ...pipeline.deps.demand, settings });
    // D sold 327 units in 90 days: a second, stronger sales signal next to the Amazon rank.
    expect(withInsights.components.salesVelocity).toBeGreaterThan(without.components.salesVelocity);
    const [, latest] = await db.demandSnapshot.findMany({ orderBy: { capturedAt: "asc" } });
    // Sold counts of rejected listings (A sold 812) must not leak in.
    expect(latest.soldLast30d).toBe(109);
    expect((await db.demandSnapshot.findFirstOrThrow({ orderBy: { capturedAt: "asc" } })).soldLast30d).toBeNull();
  });

  it("prices a unique product by margin target and gives it full marks for competition", async () => {
    const variantId = await importAndMatch();
    for (const match of await db.productMatch.findMany({ where: { status: "CONFIRMED" } })) {
      await setMatchDecision(match.id, "REJECTED");
    }
    const result = await scoreDemandForVariant(variantId, pipeline.deps.demand);
    const snapshot = await db.demandSnapshot.findFirstOrThrow();
    expect(snapshot).toMatchObject({ competitorCount: 0, lowestCompetitorCents: null, salesRank: null });
    expect(result.components.competition).toBe(1);
    expect(result.components.salesVelocity).toBe(0);
    // Margin target 25% → $29.89, well above the floor.
    expect(result.components.profitMargin).toBeGreaterThan(0.8);
  });

  it("gives no margin credit when the floor is above the cheapest confirmed competitor", async () => {
    const variantId = await importAndMatch();
    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1620);
    await importSupplierProduct(NECKLACE_PRODUCT_ID, pipeline.deps.importer);
    const result = await scoreDemandForVariant(variantId, pipeline.deps.demand);
    expect(result.components.profitMargin).toBe(0);
  });

  it("marks the product eligible only at or above the demand threshold", async () => {
    const variantId = await importAndMatch();
    const strict = structuredClone(pipeline.settings);
    strict.demand.threshold = 95;
    expect((await scoreDemandForVariant(variantId, { ...pipeline.deps.demand, settings: strict })).eligible).toBe(false);
    expect((await db.product.findFirstOrThrow()).status).toBe("MATCHING");

    const lenient = structuredClone(pipeline.settings);
    lenient.demand.threshold = 40;
    expect((await scoreDemandForVariant(variantId, { ...pipeline.deps.demand, settings: lenient })).eligible).toBe(true);
    expect((await db.product.findFirstOrThrow()).status).toBe("ELIGIBLE");
  });
});

describe("daily seasonal job", () => {
  beforeEach(seedHolidays);

  it("discovers, matches and scores products for holidays inside their window and picks the top candidates", async () => {
    // Jan 10: Valentine's Day (Feb 14) is inside its 60-day window; Mother's Day (May 9) is not yet.
    const result = await runSeasonalDaily(pipeline.clock.now, pipeline.deps);

    expect(result.holidays.map((holiday) => holiday.code)).toEqual(["valentines"]);
    const [valentines] = result.holidays;
    expect(valentines).toMatchObject({ date: "2027-02-14", discovered: 1, failed: [] });

    const product = await db.product.findFirstOrThrow({ include: { variants: true } });
    expect(product).toMatchObject({ supplierTrending: true, status: "ELIGIBLE" });
    expect(await db.productMatch.count({ where: { status: "CONFIRMED" } })).toBe(2);

    expect(valentines.candidates).toHaveLength(1);
    expect(valentines.candidates[0]).toMatchObject({ variantId: product.variants[0].id });
    expect(valentines.candidates[0].score).toBeGreaterThanOrEqual(60);
    // Feb 14 − (2 processing + 5 delivery + 2 buffer) days.
    expect(valentines.candidates[0].cutoffDate.toISOString().slice(0, 10)).toBe("2027-02-05");

    // The pick becomes a draft listing awaiting approval, titled for the holiday.
    expect(valentines.notListed).toEqual([]);
    const listing = await db.listing.findFirstOrThrow({ include: { holiday: true } });
    expect(valentines.listed).toEqual([listing.id]);
    expect(listing).toMatchObject({
      status: "PENDING_APPROVAL",
      marketplace: "EBAY",
      title: "Custom Photo Projection Necklace Valentines Day Gift",
      priceCents: 2489,
      externalId: null,
    });
    expect(listing.holiday?.code).toBe("valentines");
    expect(listing.cutoffDate?.toISOString().slice(0, 10)).toBe("2027-02-05");
  });

  it("does not create a second listing when the job runs again", async () => {
    await runSeasonalDaily(pipeline.clock.now, pipeline.deps);
    const again = await runSeasonalDaily(pipeline.clock.now, pipeline.deps);
    expect(again.holidays[0]).toMatchObject({ candidates: [], listed: [] });
    expect(await db.listing.count()).toBe(1);
  });

  it("does nothing for holidays outside their window", async () => {
    const result = await runSeasonalDaily(new Date("2026-11-01T09:00:00Z"), pipeline.deps);
    expect(result.holidays).toEqual([]);
    expect(await db.product.count()).toBe(0);
  });

  it("offers no candidate once the product can no longer arrive in time", async () => {
    pipeline.clock.now = new Date("2027-02-08T09:00:00Z");
    const result = await runSeasonalDaily(pipeline.clock.now, pipeline.deps);
    expect(result.holidays[0]).toMatchObject({ code: "valentines", discovered: 1, candidates: [] });
  });

  it("does not offer a variant that already has a listing", async () => {
    await runSeasonalDaily(pipeline.clock.now, pipeline.deps);
    const variant = await db.productVariant.findFirstOrThrow();
    await db.listing.create({
      data: { variantId: variant.id, marketplace: "EBAY", sku: "DP-1", title: "Necklace", description: "", priceCents: 2489, floorCents: 2463, status: "PENDING_APPROVAL" },
    });
    const result = await runSeasonalDaily(pipeline.clock.now, pipeline.deps);
    expect(result.holidays[0].candidates).toEqual([]);
  });
});

describe("trending discovery", () => {
  it("evaluates the supplier's trending products and drafts a listing for the best ones, with no holiday attached", async () => {
    const result = await runTrendingDiscovery(pipeline.clock.now, pipeline.deps);
    expect(result).toMatchObject({ evaluated: 1, failed: [], notListed: [] });

    const product = await db.product.findFirstOrThrow();
    expect(product).toMatchObject({ supplierTrending: true, status: "ELIGIBLE" });
    const listing = await db.listing.findFirstOrThrow();
    expect(result.listed).toEqual([listing.id]);
    expect(listing).toMatchObject({
      status: "PENDING_APPROVAL",
      marketplace: "EBAY",
      title: "Custom Photo Projection Necklace",
      priceCents: 2489,
      holidayId: null,
      cutoffDate: null,
    });
  });

  it("does not evaluate the same product again within a week", async () => {
    await runTrendingDiscovery(pipeline.clock.now, pipeline.deps);
    pipeline.clock.now = new Date("2027-01-13T09:00:00Z");
    expect(await runTrendingDiscovery(pipeline.clock.now, pipeline.deps)).toMatchObject({ evaluated: 0, listed: [] });
    expect(await db.demandSnapshot.count()).toBe(1);

    pipeline.clock.now = new Date("2027-01-20T09:00:00Z");
    expect(await runTrendingDiscovery(pipeline.clock.now, pipeline.deps)).toMatchObject({ evaluated: 1 });
  });

  it("skips products that are not stocked in the destination country", async () => {
    pipeline.supplier.setStock(NECKLACE_VARIANT_ID, "US", 0);
    expect(await runTrendingDiscovery(pipeline.clock.now, pipeline.deps)).toMatchObject({ evaluated: 0 });
    expect(await db.product.count()).toBe(0);
  });

  it("lists nothing below the demand threshold, and can be switched off", async () => {
    const strict = structuredClone(pipeline.settings);
    strict.demand.threshold = 95;
    const strictDeps = { ...pipeline.deps, demand: { ...pipeline.deps.demand, settings: strict }, listing: { ...pipeline.deps.listing, settings: strict } };
    expect(await runTrendingDiscovery(pipeline.clock.now, strictDeps)).toMatchObject({ evaluated: 1, listed: [] });

    const off = structuredClone(pipeline.settings);
    off.discovery.trendingProductsPerRun = 0;
    const offDeps = { ...pipeline.deps, listing: { ...pipeline.deps.listing, settings: off } };
    expect(await runTrendingDiscovery(new Date("2027-03-01T09:00:00Z"), offDeps)).toEqual({ evaluated: 0, failed: [], listed: [], notListed: [] });
  });
});

describe("holiday listing lifecycle", () => {
  beforeEach(seedHolidays);

  /** An active eBay listing for Valentine's Day 2027, published on the mock marketplace. */
  async function createValentinesListing() {
    await importSupplierProduct(NECKLACE_PRODUCT_ID, pipeline.deps.importer);
    const variant = await db.productVariant.findFirstOrThrow();
    const valentines = await db.holiday.findUniqueOrThrow({ where: { code: "valentines" } });
    const title = "Custom Photo Projection Necklace Valentines Day Gift";
    const { externalId } = await pipeline.ebay.publishListing({
      sku: "DP-NECKLACE",
      title,
      description: "A necklace",
      priceCents: 2489,
      quantity: 5,
      imageUrls: [],
      detailImageUrls: [],
      itemSpecifics: {},
      handlingDays: 2,
      deliveryDaysMax: 5,
    });
    return db.listing.create({
      data: {
        variantId: variant.id,
        marketplace: "EBAY",
        externalId,
        sku: "DP-NECKLACE",
        title,
        description: "A necklace",
        priceCents: 2489,
        floorCents: 2463,
        quantity: 5,
        status: "ACTIVE",
        holidayId: valentines.id,
        cutoffDate: new Date("2027-02-05T00:00:00Z"),
      },
    });
  }

  const deps = () => ({ getMarketplace: pipeline.deps.getMarketplace });

  it("keeps selling through the cut-off day and pauses the day after", async () => {
    const listing = await createValentinesListing();
    const externalId = listing.externalId ?? "";

    expect(await pauseListingsPastCutoff(new Date("2027-02-03T12:00:00Z"), deps())).toEqual([]);
    expect(await pauseListingsPastCutoff(new Date("2027-02-05T23:00:00Z"), deps())).toEqual([]);
    expect(pipeline.ebay.getListing(externalId)?.quantity).toBe(5);

    expect(await pauseListingsPastCutoff(new Date("2027-02-08T09:00:00Z"), deps())).toEqual([listing.id]);
    expect(await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({
      status: "PAUSED",
      pauseReason: "HOLIDAY_CUTOFF",
      quantity: 5,
    });
    expect(pipeline.ebay.getListing(externalId)?.quantity).toBe(0);

    // Running again changes nothing.
    expect(await pauseListingsPastCutoff(new Date("2027-02-09T09:00:00Z"), deps())).toEqual([]);
  });

  it("re-targets to Mother's Day two days after Valentine's Day and resumes selling", async () => {
    const listing = await createValentinesListing();
    const externalId = listing.externalId ?? "";
    await pauseListingsPastCutoff(new Date("2027-02-08T09:00:00Z"), deps());

    expect(await handleEndedHolidays(new Date("2027-02-15T09:00:00Z"), deps())).toEqual({ retargeted: [], ended: [] });

    expect(await handleEndedHolidays(new Date("2027-02-16T09:00:00Z"), deps())).toEqual({ retargeted: [listing.id], ended: [] });
    const updated = await db.listing.findUniqueOrThrow({ where: { id: listing.id }, include: { holiday: true } });
    expect(updated).toMatchObject({
      title: "Custom Photo Projection Necklace Mothers Day Gift",
      status: "ACTIVE",
      pauseReason: null,
    });
    expect(updated.holiday?.code).toBe("mothers-day");
    // Mother's Day 2027 is May 9; minus 9 days.
    expect(updated.cutoffDate?.toISOString().slice(0, 10)).toBe("2027-04-30");
    expect(pipeline.ebay.getListing(externalId)).toMatchObject({ title: "Custom Photo Projection Necklace Mothers Day Gift", quantity: 5 });

    // The next day it is a Mother's Day listing in season: nothing more to do.
    expect(await handleEndedHolidays(new Date("2027-02-17T09:00:00Z"), deps())).toEqual({ retargeted: [], ended: [] });
  });

  it("does not resume a listing that was paused for another reason", async () => {
    const listing = await createValentinesListing();
    await db.listing.update({ where: { id: listing.id }, data: { status: "PAUSED", pauseReason: "OUT_OF_STOCK" } });
    await pipeline.ebay.updateListing({ externalId: listing.externalId ?? "", sku: listing.sku }, { quantity: 0 });

    await handleEndedHolidays(new Date("2027-02-16T09:00:00Z"), deps());
    expect(await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ status: "PAUSED", pauseReason: "OUT_OF_STOCK" });
    expect(pipeline.ebay.getListing(listing.externalId ?? "")?.quantity).toBe(0);
  });

  it("ends the listing when the holiday has no successor", async () => {
    const listing = await createValentinesListing();
    const fathersDay = await db.holiday.findUniqueOrThrow({ where: { code: "fathers-day" } });
    await db.listing.update({
      where: { id: listing.id },
      data: { holidayId: fathersDay.id, cutoffDate: new Date("2027-06-11T00:00:00Z"), title: "Custom Photo Projection Necklace Fathers Day Gift" },
    });

    // Father's Day 2027 is June 20; it ends June 22.
    expect(await handleEndedHolidays(new Date("2027-06-21T09:00:00Z"), deps())).toEqual({ retargeted: [], ended: [] });
    expect(await handleEndedHolidays(new Date("2027-06-22T09:00:00Z"), deps())).toEqual({ retargeted: [], ended: [listing.id] });
    expect((await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe("ENDED");
    expect(pipeline.ebay.getListing(listing.externalId ?? "")?.ended).toBe(true);
  });

  it("re-targets a draft that was never published without calling the marketplace", async () => {
    const listing = await createValentinesListing();
    await db.listing.update({ where: { id: listing.id }, data: { externalId: null, status: "PENDING_APPROVAL" } });
    expect(await handleEndedHolidays(new Date("2027-02-16T09:00:00Z"), deps())).toEqual({ retargeted: [listing.id], ended: [] });
    expect(await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({
      status: "PENDING_APPROVAL",
      title: "Custom Photo Projection Necklace Mothers Day Gift",
    });
  });
});
