import { rm } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { importSupplierProduct } from "@/server/catalog/import-product";
import { db } from "@/server/db";
import { createListing, publishListing, rejectListing } from "@/server/listing/service";
import { runCommand } from "@/server/telegram/commands";
import { runMatchingForVariant } from "@/server/matching/run-matching";
import { NECKLACE_PRODUCT_ID, NECKLACE_VARIANT_ID } from "@/server/mocks/fixtures/necklace";
import { repriceListing } from "@/server/repricer/run";
import { findListingsDueForSync, syncListing } from "@/server/sync/run";
import { type MockPipeline, createMockPipeline, seedHolidays } from "./pipeline-helpers";

let pipeline: MockPipeline;
let variantId: string;

beforeEach(async () => {
  pipeline = await createMockPipeline("2027-01-10T09:00:00Z");
  await seedHolidays();
  await importSupplierProduct(NECKLACE_PRODUCT_ID, pipeline.deps.importer);
  variantId = (await db.productVariant.findFirstOrThrow()).id;
  await runMatchingForVariant(variantId, pipeline.deps.matching);
  return async () => {
    await rm(pipeline.cacheDir, { recursive: true, force: true });
  };
});

afterAll(async () => {
  await db.$disconnect();
});

const listingDeps = () => pipeline.deps.listing;
const syncDeps = () => ({ ...pipeline.deps.listing, supplier: pipeline.supplier });

async function publishedListing() {
  const valentines = await db.holiday.findUniqueOrThrow({ where: { code: "valentines" } });
  const draft = await createListing(variantId, "EBAY", listingDeps(), { holiday: valentines });
  return publishListing(draft.id, listingDeps());
}

describe("creating a listing", () => {
  it("prices from the confirmed matches D and F only: $24.89, above the floor", async () => {
    const listing = await createListing(variantId, "EBAY", listingDeps());
    expect(listing).toMatchObject({
      status: "PENDING_APPROVAL",
      sku: "DP-CJNK001-RG",
      priceCents: 2489,
      floorCents: 2463,
      quantity: 5,
      externalId: null,
      holidayId: null,
    });
    expect(listing.priceCents).toBeGreaterThanOrEqual(listing.floorCents);
    // Nothing reaches the marketplace until it is approved.
    expect(pipeline.ebay.getListing("MOCK-EBAY-DP-CJNK001-RG")).toBeUndefined();
    expect(pipeline.listingNotices.sent).toEqual([
      {
        severity: "INFO",
        title: "eBay listing awaiting your approval",
        message: [
          "Custom Photo Projection Necklace",
          "SKU DP-CJNK001-RG",
          "Price $24.89 · floor $24.63 · quantity 5",
          "Cost $11.20 + $4.90 shipping · expected profit $3.70 per sale",
          "Supplier: CJ Dropshipping, US warehouse, 240 in stock",
          "Delivery: 2 days processing + 3–5 days shipping",
          "Nothing is on the marketplace yet. Approve or reject it here or on the Listings page.",
        ].join("\n"),
        actions: [
          { label: "Approve and publish", command: `approve ${listing.id}` },
          { label: "Reject", command: `reject ${listing.id}` },
        ],
      },
    ]);
  });

  it("returns the existing listing instead of creating a duplicate", async () => {
    const first = await createListing(variantId, "EBAY", listingDeps());
    const second = await createListing(variantId, "EBAY", listingDeps());
    expect(second.id).toBe(first.id);
    expect(await db.listing.count()).toBe(1);
    expect(pipeline.listingNotices.sent).toHaveLength(1);
  });

  it("publishes straight away when manual approve is off", async () => {
    const settings = structuredClone(pipeline.settings);
    settings.listing.manualApprove = false;
    const listing = await createListing(variantId, "EBAY", { ...listingDeps(), settings });
    expect(listing.status).toBe("ACTIVE");
    expect(listing.externalId).not.toBeNull();
    // Only the "listed" message: nothing waited for approval.
    expect(pipeline.listingNotices.sent.map((notice) => notice.title)).toEqual(["Listed on eBay"]);
  });

  it("refuses stock outside the US warehouse, and a product that would arrive later than the marketplace promise", async () => {
    // Only the China warehouse has stock: 2 + 14 days, over eBay's 10-day promise.
    pipeline.supplier.setStock(NECKLACE_VARIANT_ID, "US", 0);
    await importSupplierProduct(NECKLACE_PRODUCT_ID, pipeline.deps.importer);
    // The warehouse rule stops it first; with that rule off, the delivery promise does.
    await expect(createListing(variantId, "EBAY", listingDeps())).rejects.toMatchObject({ name: "ComplianceError", rule: "US_WAREHOUSE" });
    const settings = structuredClone(pipeline.settings);
    settings.listing.ebayUsWarehouseOnly = false;
    await expect(createListing(variantId, "EBAY", { ...listingDeps(), settings })).rejects.toMatchObject({ name: "ComplianceError", rule: "DELIVERY_PROMISE" });
    expect(await db.listing.count()).toBe(0);
  });

  it("refuses listing text that contains a trademark", async () => {
    await db.product.updateMany({ data: { title: "Photo Projection Necklace Pandora Style" } });
    await expect(createListing(variantId, "EBAY", listingDeps())).rejects.toMatchObject({ rule: "TRADEMARK" });
  });

  it("refuses Amazon listings from a supplier that cannot ship blind", async () => {
    await db.supplier.updateMany({ data: { supportsBlindShipping: false } });
    await expect(createListing(variantId, "AMAZON", listingDeps())).rejects.toMatchObject({ rule: "BLIND_SHIPPING" });
    await expect(createListing(variantId, "EBAY", listingDeps())).resolves.toMatchObject({ marketplace: "EBAY" });
  });
});

describe("publishing", () => {
  it("puts the approved draft live with realistic handling time and records the initial price", async () => {
    const listing = await publishedListing();
    expect(listing).toMatchObject({ status: "ACTIVE", priceCents: 2489, quantity: 5 });

    const live = pipeline.ebay.getListing(listing.externalId ?? "");
    expect(live).toMatchObject({
      sku: "DP-CJNK001-RG",
      title: "Custom Photo Projection Necklace Valentines Day Gift",
      priceCents: 2489,
      quantity: 5,
      handlingDays: 2,
      deliveryDaysMax: 5,
    });
    expect(live?.imageUrls).toHaveLength(6);
    expect(live?.itemSpecifics).toMatchObject({ Material: "copper", Shape: "heart", Personalized: "Yes" });

    expect(await db.priceHistory.findMany()).toMatchObject([{ priceCents: 2489, floorCents: 2463, costCents: 1120, reason: "INITIAL" }]);
    expect(pipeline.listingNotices.sent.at(-1)).toEqual({
      severity: "INFO",
      title: "Listed on eBay",
      message: [
        "Custom Photo Projection Necklace Valentines Day Gift",
        "SKU DP-CJNK001-RG · eBay item MOCK-EBAY-DP-CJNK001-RG",
        "Price $24.89 · floor $24.63 · quantity 5",
        "Cost $11.20 + $4.90 shipping · expected profit $3.70 per sale",
        "Supplier: CJ Dropshipping, US warehouse, 240 in stock",
        "Delivery: 2 days processing + 3–5 days shipping",
      ].join("\n"),
    });
  });

  it("lists on Amazon against the ASIN of the confirmed identical product, priced with Amazon's fees", async () => {
    const draft = await createListing(variantId, "AMAZON", listingDeps());
    // (16.10 × 1.03 + 3.00) / (1 − 0.15 − 0.06) = 24.79
    expect(draft).toMatchObject({ marketplace: "AMAZON", priceCents: 2489, floorCents: 2479 });

    const listing = await publishListing(draft.id, listingDeps());
    const live = pipeline.amazon.getListing(listing.externalId ?? "");
    // F (B0MOCKNKF1) is the confirmed Amazon match: we join its ASIN rather than create a duplicate product.
    expect(live).toMatchObject({ sku: "DP-CJNK001-RG", existingProductId: "B0MOCKNKF1", priceCents: 2489, handlingDays: 2 });
  });

  it("creates a new Amazon product when no confirmed Amazon match exists", async () => {
    await db.productMatch.updateMany({ where: { competitorListing: { marketplace: "AMAZON" } }, data: { status: "REJECTED" } });
    const draft = await createListing(variantId, "AMAZON", listingDeps());
    const listing = await publishListing(draft.id, listingDeps());
    expect(pipeline.amazon.getListing(listing.externalId ?? "")?.existingProductId).toBeUndefined();
  });

  it("cannot publish the same listing twice", async () => {
    const listing = await publishedListing();
    await expect(publishListing(listing.id, listingDeps())).rejects.toThrow(/cannot be published/);
  });

  it("enforces the limit of 20 live listings for a new account", async () => {
    const draft = await createListing(variantId, "EBAY", listingDeps());
    await db.listing.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        variantId,
        marketplace: "AMAZON" as const,
        externalId: `LIVE-${index}`,
        sku: `LIVE-${index}`,
        title: "Live listing",
        description: "",
        priceCents: 2489,
        floorCents: 2463,
        status: index % 2 === 0 ? ("ACTIVE" as const) : ("PAUSED" as const),
      })),
    });
    await expect(publishListing(draft.id, listingDeps())).rejects.toMatchObject({ rule: "LISTING_LIMIT" });
    expect((await db.listing.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("PENDING_APPROVAL");

    // A configured weekly growth raises the limit once a week has passed since the first listing.
    const growing = structuredClone(pipeline.settings);
    growing.listing.listingGrowthPerWeek = 5;
    await db.listing.updateMany({ where: { externalId: { not: null } }, data: { createdAt: new Date("2027-01-01T00:00:00Z") } });
    await expect(publishListing(draft.id, { ...listingDeps(), settings: growing })).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("re-prices at publish time when the supplier cost changed while the draft waited", async () => {
    const draft = await createListing(variantId, "EBAY", listingDeps());
    await db.productVariant.update({ where: { id: variantId }, data: { costCents: 1220 } });
    const listing = await publishListing(draft.id, listingDeps());
    expect(listing).toMatchObject({ priceCents: 2599, floorCents: 2590 });
  });

  it("lets a draft be rejected, but not a live listing", async () => {
    const draft = await createListing(variantId, "EBAY", listingDeps());
    await rejectListing(draft.id);
    expect((await db.listing.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("ENDED");

    // The variant can be listed again afterwards: the ended row is revived, not duplicated.
    const live = await publishedListing();
    expect(live.id).toBe(draft.id);
    expect(await db.listing.count()).toBe(1);
    await expect(rejectListing(live.id)).rejects.toThrow(/only drafts/);
  });
});

describe("listings with options", () => {
  /** Adds sibling variants of the necklace that differ only in colour. */
  async function addColours(colours: Record<string, { stock?: number; deliveryDaysMax?: number; warehouse?: string }>): Promise<void> {
    const original = await db.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    for (const [colour, overrides] of Object.entries(colours)) {
      await db.productVariant.create({
        data: {
          productId: original.productId,
          costCents: original.costCents,
          shippingCents: original.shippingCents,
          warehouse: original.warehouse,
          stock: original.stock,
          processingDays: original.processingDays,
          deliveryDaysMin: original.deliveryDaysMin,
          deliveryDaysMax: original.deliveryDaysMax,
          specs: original.specs ?? undefined,
          externalId: `${original.externalId}-${colour}`,
          sku: `CJNK001-${colour.toUpperCase()}`,
          attributes: { ...(original.attributes as Record<string, string>), color: colour },
          ...overrides,
        },
      });
    }
  }

  it("lists every sellable variant of the product as an option of one eBay listing", async () => {
    await addColours({ silver: {}, gold: {}, black: { stock: 0 }, slow: { deliveryDaysMax: 30 }, china: { warehouse: "CN" } });

    const draft = await createListing(variantId, "EBAY", listingDeps());
    const drafts = await db.listing.findMany({ orderBy: { sku: "asc" } });
    expect(drafts.map((row) => [row.sku, row.status, row.groupKey])).toEqual([
      ["DP-CJNK001-GOLD", "PENDING_APPROVAL", "DP-CJ-NECKLACE-001"],
      ["DP-CJNK001-RG", "PENDING_APPROVAL", "DP-CJ-NECKLACE-001"],
      ["DP-CJNK001-SILVER", "PENDING_APPROVAL", "DP-CJ-NECKLACE-001"],
    ]);
    expect(new Set(drafts.map((row) => row.title)).size).toBe(1);
    // One message for the listing, not one per option.
    expect(pipeline.listingNotices.sent).toHaveLength(1);
    expect(pipeline.listingNotices.sent[0].message).toContain("3 options by Color, $24.89 to $29.89:\nrose gold $24.89 ×5, gold $29.89 ×5, silver $29.89 ×5");

    const live = await publishListing(draft.id, listingDeps());
    expect(live).toMatchObject({ sku: "DP-CJNK001-RG", status: "ACTIVE", externalId: "MOCK-EBAY-DP-CJ-NECKLACE-001" });
    expect(await db.listing.findMany({ orderBy: { sku: "asc" }, select: { status: true, externalId: true } })).toEqual(
      Array.from({ length: 3 }, () => ({ status: "ACTIVE", externalId: "MOCK-EBAY-DP-CJ-NECKLACE-001" })),
    );
    // Silver has no confirmed competitors, so it is priced by the margin target; rose gold undercuts its competitors.
    expect(pipeline.ebay.getVariation("DP-CJNK001-SILVER")).toMatchObject({ options: { Color: "silver" }, priceCents: 2989, quantity: 5 });
    expect(pipeline.ebay.getVariation("DP-CJNK001-RG")).toMatchObject({ options: { Color: "rose gold" }, priceCents: 2489 });
    // The colour is the buyer's choice, so it is not a fixed fact of the listing.
    expect(pipeline.ebay.getVariation("DP-CJNK001-RG")?.itemSpecifics).toEqual({ Material: "copper", Shape: "heart", Length: "45 cm", Personalized: "Yes" });
    expect(await db.priceHistory.count()).toBe(3);
    expect(pipeline.listingNotices.sent.at(-1)?.title).toBe("Listed on eBay with 3 options");
  });

  it("includes other warehouses once the US-only setting is turned off", async () => {
    await addColours({ silver: {}, china: { warehouse: "CN" } });
    const settings = structuredClone(pipeline.settings);
    settings.listing.ebayUsWarehouseOnly = false;
    await createListing(variantId, "EBAY", { ...listingDeps(), settings });
    expect((await db.listing.findMany({ orderBy: { sku: "asc" } })).map((row) => row.sku)).toEqual(["DP-CJNK001-CHINA", "DP-CJNK001-RG", "DP-CJNK001-SILVER"]);
  });

  it("counts a listing with options once against the listing limit, and re-prices each option by its SKU", async () => {
    await addColours({ silver: {} });
    const settings = structuredClone(pipeline.settings);
    settings.listing.manualApprove = false;
    settings.listing.maxActiveListings = 1;
    const live = await createListing(variantId, "EBAY", { ...listingDeps(), settings });
    expect(live.status).toBe("ACTIVE");
    expect(await db.listing.count({ where: { status: "ACTIVE" } })).toBe(2);

    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1220);
    await syncListing(live.id, syncDeps());
    expect(pipeline.ebay.getVariation("DP-CJNK001-RG")?.priceCents).toBe(2599);
    expect(pipeline.ebay.getVariation("DP-CJNK001-SILVER")?.priceCents).toBe(2989);
  });

  it("does not add a variant to a product that is already listed with options", async () => {
    await addColours({ silver: {}, late: { stock: 0 } });
    const draft = await createListing(variantId, "EBAY", listingDeps());
    const late = await db.productVariant.findFirstOrThrow({ where: { sku: "CJNK001-LATE" } });
    await db.productVariant.update({ where: { id: late.id }, data: { stock: 9 } });
    expect((await createListing(late.id, "EBAY", listingDeps())).groupKey).toBe(draft.groupKey);
    expect(await db.listing.count()).toBe(2);
  });

  it("publishes as an ordinary listing when only one option is still sellable at approval", async () => {
    await addColours({ silver: {} });
    const draft = await createListing(variantId, "EBAY", listingDeps());
    await db.productVariant.updateMany({ where: { sku: "CJNK001-SILVER" }, data: { stock: 0 } });

    const live = await publishListing(draft.id, listingDeps());
    expect(live).toMatchObject({ status: "ACTIVE", groupKey: null, externalId: "MOCK-EBAY-DP-CJNK001-RG" });
    expect((await db.listing.findFirstOrThrow({ where: { sku: "DP-CJNK001-SILVER" } })).status).toBe("ENDED");
  });

  it("rejects all the options together", async () => {
    await addColours({ silver: {} });
    const draft = await createListing(variantId, "EBAY", listingDeps());
    await rejectListing(draft.id);
    expect(await db.listing.count({ where: { status: "ENDED" } })).toBe(2);
  });

  it("keeps one listing per variant on Amazon, which has no options here", async () => {
    await addColours({ silver: {} });
    const draft = await createListing(variantId, "AMAZON", listingDeps());
    expect(draft.groupKey).toBeNull();
    expect(await db.listing.count()).toBe(1);
  });
});

describe("commands from the chat", () => {
  const commandDeps = () => ({ listing: async () => listingDeps(), orders: async () => pipeline.orderDeps });

  it("lists drafts, publishes one on approve and discards one on reject", async () => {
    const draft = await createListing(variantId, "EBAY", listingDeps());
    expect((await runCommand("status", commandDeps())).text).toContain("Drafts awaiting approval: 1");
    const list = await runCommand("/drafts", commandDeps());
    expect(list.text).toContain(`approve ${draft.id}`);
    expect(list.actions?.[0]).toEqual({ label: expect.stringContaining("Approve: "), command: `approve ${draft.id}` });

    // As typed, as a button press, and as the clickable "/approve_<id>" form.
    expect((await runCommand(`/approve_${draft.id}`, commandDeps())).text).toMatch(/^Published on eBay: .+ \(item MOCK-EBAY-DP-CJNK001-RG\)\.$/);
    expect((await db.listing.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("ACTIVE");

    // Publishing twice is refused, and the admin is told why (the listener turns the error into a reply).
    await expect(runCommand(`approve ${draft.id}`, commandDeps())).rejects.toThrow(/cannot be published/);
  });

  it("rejects a draft, and answers unknown ids and words without doing anything", async () => {
    const draft = await createListing(variantId, "EBAY", listingDeps());
    expect((await runCommand("approve nope", commandDeps())).text).toContain("No listing with id nope");
    expect((await runCommand("launch rockets", commandDeps())).text).toContain('I don\'t know "launch"');
    expect((await runCommand("approve", commandDeps())).text).toContain("needs an id");
    expect((await runCommand(`REJECT ${draft.id}`, commandDeps())).text).toContain("Nothing was published");
    expect((await db.listing.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("ENDED");
    expect((await runCommand("drafts", commandDeps())).text).toBe("No drafts are waiting for approval.");
  });
});

describe("sync with the supplier", () => {
  it("re-prices to keep the profit when the supplier raises its price by $1", async () => {
    const listing = await publishedListing();
    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1220);

    pipeline.clock.now = new Date("2027-01-10T11:00:00Z");
    const result = await syncListing(listing.id, syncDeps());
    expect(result).toMatchObject({ costChanged: true, outcome: "REPRICED", priceCents: 2599 });

    expect(await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ status: "ACTIVE", priceCents: 2599, floorCents: 2590 });
    expect(pipeline.ebay.getListing(listing.externalId ?? "")?.priceCents).toBe(2599);
    expect((await db.productVariant.findUniqueOrThrow({ where: { id: variantId } })).costCents).toBe(1220);
    const history = await db.priceHistory.findMany({ orderBy: { createdAt: "asc" } });
    expect(history.map((entry) => [entry.priceCents, entry.costCents, entry.reason])).toEqual([
      [2489, 1120, "INITIAL"],
      [2599, 1220, "SUPPLIER_COST"],
    ]);

    // The admin is told exactly what changed, before and after.
    expect(pipeline.listingNotices.sent.at(-1)).toEqual({
      severity: "INFO",
      title: "Price changed on eBay: $24.89 → $25.99",
      message: [
        "Custom Photo Projection Necklace Valentines Day Gift",
        "SKU DP-CJNK001-RG · eBay item MOCK-EBAY-DP-CJNK001-RG",
        "Status: active (unchanged)",
        "Price: $24.89 → $25.99",
        "Price floor: $24.63 → $25.90",
        "Supplier cost: $11.20 → $12.20",
        "Expected profit per sale: $3.70 → $3.59",
        "Quantity on eBay: 5 (unchanged)",
        "Supplier: CJ Dropshipping, US warehouse, 240 in stock",
        "Delivery: 2 days processing + 3–5 days shipping",
      ].join("\n"),
    });
  });

  it("makes no marketplace call and writes no history when nothing changed", async () => {
    const listing = await publishedListing();
    const before = pipeline.ebay.updateCalls;
    expect(await syncListing(listing.id, syncDeps())).toMatchObject({ costChanged: false, outcome: "UNCHANGED", priceCents: 2489 });
    expect(await syncListing(listing.id, syncDeps())).toMatchObject({ outcome: "UNCHANGED" });
    expect(pipeline.ebay.updateCalls).toBe(before);
    expect(await db.priceHistory.count()).toBe(1);
    // Draft and listed only: a sync that changes nothing sends nothing.
    expect(pipeline.listingNotices.sent.map((notice) => notice.title)).toEqual(["eBay listing awaiting your approval", "Listed on eBay"]);
  });

  it("sets quantity 0 when the supplier is out of stock and resumes when stock returns", async () => {
    const listing = await publishedListing();
    const externalId = listing.externalId ?? "";

    pipeline.supplier.setStock(NECKLACE_VARIANT_ID, "US", 0);
    expect(await syncListing(listing.id, syncDeps())).toMatchObject({ stock: 0, outcome: "PAUSED_OUT_OF_STOCK" });
    expect(await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ status: "PAUSED", pauseReason: "OUT_OF_STOCK" });
    expect(pipeline.ebay.getListing(externalId)?.quantity).toBe(0);

    pipeline.supplier.setStock(NECKLACE_VARIANT_ID, "US", 3);
    expect(await syncListing(listing.id, syncDeps())).toMatchObject({ stock: 3, outcome: "RESUMED" });
    expect(await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ status: "ACTIVE", pauseReason: null, quantity: 3 });
    expect(pipeline.ebay.getListing(externalId)?.quantity).toBe(3);

    const [paused, resumed] = pipeline.listingNotices.sent.slice(-2);
    expect(paused.title).toBe("Paused on eBay: the supplier is out of stock");
    expect(paused.message).toContain("Status: active → paused");
    expect(paused.message).toContain("Quantity on eBay: 5 → 0");
    expect(resumed.title).toBe("Back on sale on eBay");
    expect(resumed.message).toContain("Quantity on eBay: 0 → 3");
    expect(resumed.message).toContain("US warehouse, 3 in stock");
  });

  it("pauses when a competitor is below our floor and the setting says pause, then resumes when the cost drops back", async () => {
    const listing = await publishedListing();
    const pausing = structuredClone(pipeline.settings);
    pausing.repricer.belowFloorAction = "PAUSE";
    const deps = { ...syncDeps(), settings: pausing };

    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1220);
    expect(await syncListing(listing.id, deps)).toMatchObject({ outcome: "PAUSED_BELOW_FLOOR" });
    expect(await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ status: "PAUSED", pauseReason: "BELOW_FLOOR", priceCents: 2489 });
    expect(pipeline.ebay.getListing(listing.externalId ?? "")?.quantity).toBe(0);

    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1120);
    expect(await syncListing(listing.id, deps)).toMatchObject({ outcome: "RESUMED", priceCents: 2489 });
    expect(await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ status: "ACTIVE", pauseReason: null });
    expect(pipeline.ebay.getListing(listing.externalId ?? "")?.quantity).toBe(5);
  });

  it("does not un-pause a listing that is paused for its holiday cut-off", async () => {
    const listing = await publishedListing();
    await db.listing.update({ where: { id: listing.id }, data: { status: "PAUSED", pauseReason: "HOLIDAY_CUTOFF" } });
    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1220);
    const before = pipeline.ebay.updateCalls;
    await syncListing(listing.id, syncDeps());
    expect(await db.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ status: "PAUSED", pauseReason: "HOLIDAY_CUTOFF", priceCents: 2599 });
    expect(pipeline.ebay.updateCalls).toBe(before);
  });
});

describe("repricer", () => {
  it("uses the variant's strategy", async () => {
    const listing = await publishedListing();
    await db.productVariant.update({ where: { id: variantId }, data: { repricerStrategy: "MATCH" } });
    pipeline.clock.now = new Date("2027-01-10T11:00:00Z");
    expect(await repriceListing(listing.id, listingDeps())).toMatchObject({ priceCents: 2499, priceChanged: true });
    const last = await db.priceHistory.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    expect(last.reason).toBe("REPRICE");
  });

  it("follows a confirmed competitor's price change", async () => {
    const listing = await publishedListing();
    await db.competitorListing.updateMany({ where: { externalId: "B0MOCKNKF1" }, data: { priceCents: 2599 } });
    // F is now $25.99, so D ($26.99) and F put the reference at $25.99.
    expect(await repriceListing(listing.id, listingDeps())).toMatchObject({ priceCents: 2589 });
    expect(pipeline.ebay.getListing(listing.externalId ?? "")?.priceCents).toBe(2589);
  });

  it("applies the optional seasonal markup as the holiday approaches", async () => {
    const listing = await publishedListing();
    const seasonal = structuredClone(pipeline.settings);
    seasonal.pricing.seasonalMarkupRate = 0.1;
    // Jan 30: 15 of 60 days left → 7.5% markup on $24.89 = $26.76 → $25.99.
    pipeline.clock.now = new Date("2027-01-30T09:00:00Z");
    expect(await repriceListing(listing.id, { ...listingDeps(), settings: seasonal })).toMatchObject({ priceCents: 2599, priceChanged: true });
    expect((await db.priceHistory.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).reason).toBe("SEASONAL");
  });
});

describe("sync schedule", () => {
  it("checks top sellers every 30 minutes and other listings every two hours", async () => {
    const listing = await publishedListing();
    const now = new Date("2027-01-10T12:00:00Z");
    const setLastSynced = (minutesAgo: number) =>
      db.productVariant.update({ where: { id: variantId }, data: { lastSyncedAt: new Date(now.getTime() - minutesAgo * 60_000) } });
    const due = () => findListingsDueForSync(now, pipeline.settings.repricer);

    await setLastSynced(45);
    expect(await due()).toEqual([]);
    await db.listing.update({ where: { id: listing.id }, data: { isTopSeller: true } });
    expect(await due()).toEqual([listing.id]);

    await db.listing.update({ where: { id: listing.id }, data: { isTopSeller: false } });
    await setLastSynced(121);
    expect(await due()).toEqual([listing.id]);

    await db.listing.update({ where: { id: listing.id }, data: { status: "PAUSED", pauseReason: "HOLIDAY_CUTOFF" } });
    expect(await due()).toEqual([]);
    await db.listing.update({ where: { id: listing.id }, data: { pauseReason: "OUT_OF_STOCK" } });
    expect(await due()).toEqual([listing.id]);
  });
});
