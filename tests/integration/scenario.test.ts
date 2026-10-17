import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { publishListing } from "@/server/listing/service";
import { NECKLACE_VARIANT_ID } from "@/server/mocks/fixtures/necklace";
import { processOrder } from "@/server/orders/fulfil";
import { pollOrders } from "@/server/orders/ingest";
import { updateTracking } from "@/server/orders/tracking";
import { runSeasonalDaily } from "@/server/seasonal/daily";
import { syncListing } from "@/server/sync/run";
import { createMockPipeline, seedHolidays } from "./pipeline-helpers";

afterAll(async () => {
  await db.$disconnect();
});

// The reference scenario from the project brief, start to finish, on mock adapters.
describe("Custom Photo Projection Necklace, end to end", () => {
  it("discovers, matches, lists at $24.89, re-prices, fulfils an order, pauses at the cut-off and re-targets", async () => {
    const pipeline = await createMockPipeline("2027-01-10T09:00:00Z");
    await seedHolidays();
    const listingDeps = pipeline.deps.listing;
    const at = (iso: string) => {
      pipeline.clock.now = new Date(iso);
      return pipeline.clock.now;
    };

    // Jan 10 — the daily job discovers the necklace for Valentine's Day, matches and scores it, and drafts a listing.
    const daily = await runSeasonalDaily(pipeline.clock.now, pipeline.deps);
    expect(daily.holidays[0]).toMatchObject({ code: "valentines", discovered: 1, notListed: [] });

    const matches = await db.productMatch.findMany({ include: { competitorListing: true } });
    const byStatus = (status: string) =>
      matches.filter((match) => match.status === status).map((match) => match.competitorListing.externalId).sort();
    expect(byStatus("CONFIRMED")).toEqual(["B0MOCKNKF1", "EBAY-D"]);
    expect(byStatus("REVIEW")).toEqual(["EBAY-H"]);
    expect(byStatus("REJECTED")).toEqual(["EBAY-A", "EBAY-B", "EBAY-C", "EBAY-E", "EBAY-G"]);

    // The repricer used only D ($26.99) and F ($24.99): $24.89, above the $24.63 floor.
    const draft = await db.listing.findFirstOrThrow();
    expect(draft).toMatchObject({ status: "PENDING_APPROVAL", priceCents: 2489, floorCents: 2463 });

    const listing = await publishListing(draft.id, listingDeps);
    const externalId = listing.externalId ?? "";
    expect(pipeline.ebay.getListing(externalId)).toMatchObject({ priceCents: 2489, quantity: 5 });

    // Jan 20 — the supplier raises its price by $1; the sync re-prices to keep the profit.
    at("2027-01-20T09:00:00Z");
    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1220);
    expect(await syncListing(listing.id, { ...listingDeps, supplier: pipeline.supplier })).toMatchObject({ outcome: "REPRICED", priceCents: 2599 });
    expect(pipeline.ebay.getListing(externalId)?.priceCents).toBe(2599);

    // Feb 3 — an order arrives: it is auto-ordered at the supplier and its tracking is uploaded.
    at("2027-02-03T15:30:00Z");
    pipeline.ebay.simulateOrder({
      externalId: "ORDER-FEB-3",
      orderedAt: new Date("2027-02-03T15:00:00Z"),
      shipByDate: new Date("2027-02-05T23:59:59Z"),
      buyerName: "Jane Doe",
      shippingAddress: { name: "Jane Doe", line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
      totalCents: 2599,
      currency: "USD",
      lines: [{ externalLineId: "L-1", sku: listing.sku, quantity: 1, priceCents: 2599 }],
    });
    const [orderId] = await pollOrders("EBAY", pipeline.orderDeps);
    // 25.99 × 0.8075 − 0.30 − 12.20 − 4.90 = 3.59
    expect(await processOrder(orderId, pipeline.orderDeps)).toMatchObject({ outcome: "ORDERED", expectedProfitCents: 359 });
    expect(await updateTracking(pipeline.orderDeps)).toMatchObject({ uploaded: [orderId] });
    expect(pipeline.ebay.getUploadedTracking("ORDER-FEB-3")?.trackingNumber).toMatch(/^MOCKTRK/);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("SHIPPED");
    expect((await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe("ACTIVE");

    // Feb 8 — past the Valentine's cut-off (Feb 5): the listing is paused.
    const feb8 = await runSeasonalDaily(at("2027-02-08T04:00:00Z"), pipeline.deps);
    expect(feb8.paused).toEqual([listing.id]);
    expect(await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ status: "PAUSED", pauseReason: "HOLIDAY_CUTOFF" });
    expect(pipeline.ebay.getListing(externalId)?.quantity).toBe(0);

    // Feb 16 — two days after Valentine's Day: the listing is re-targeted to Mother's Day and sells again.
    const feb16 = await runSeasonalDaily(at("2027-02-16T04:00:00Z"), pipeline.deps);
    expect(feb16.retargeted).toEqual([listing.id]);
    const retargeted = await db.listing.findUniqueOrThrow({ where: { id: listing.id }, include: { holiday: true } });
    expect(retargeted).toMatchObject({ status: "ACTIVE", pauseReason: null, title: "Custom Photo Projection Necklace Mothers Day Gift" });
    expect(retargeted.holiday?.code).toBe("mothers-day");
    expect(pipeline.ebay.getListing(externalId)).toMatchObject({ title: "Custom Photo Projection Necklace Mothers Day Gift", quantity: 5 });

    expect(await db.alert.count()).toBe(0);
    await rm(pipeline.cacheDir, { recursive: true, force: true });
  });
});
