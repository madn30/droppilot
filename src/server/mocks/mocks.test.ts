import { describe, expect, it } from "vitest";
import { MockEmbeddingsProvider } from "../ai/mock/mock-embeddings";
import { MockListingCopyGenerator } from "../ai/mock/mock-listing-copy";
import { MockSpecExtractor } from "../ai/mock/mock-spec-extractor";
import { MockVisionVerifier } from "../ai/mock/mock-vision-verifier";
import { MockSalesRankSource } from "../data-sources/mock/mock-sales-rank";
import { MockTrendsSource } from "../data-sources/mock/mock-trends";
import { MockAmazonAdapter, MockEbayAdapter } from "../marketplaces/mock/mock-marketplace";
import { MockSupplierAdapter } from "../suppliers/mock/mock-supplier";
import { SupplierError, type SupplierOrderInput } from "../suppliers/types";
import {
  NECKLACE_PRODUCT_ID,
  NECKLACE_VARIANT_ID,
  necklaceCompetitors,
  necklaceProduct,
} from "./fixtures/necklace";

function competitor(externalId: string) {
  const listing = necklaceCompetitors.find((candidate) => candidate.externalId === externalId);
  if (!listing) throw new Error(`No fixture ${externalId}`);
  return listing;
}

const order: SupplierOrderInput = {
  idempotencyKey: "order-1",
  items: [{ variantExternalId: NECKLACE_VARIANT_ID, quantity: 1 }],
  shippingAddress: { name: "Jane Doe", line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
  shippingOptionName: "CJPacket US Warehouse",
  warehouse: "US",
  blindShipping: true,
  payFromBalance: true,
};

describe("MockSupplierAdapter", () => {
  it("serves the necklace scenario: $11.20 cost, $4.90 US shipping, 6 images", async () => {
    const supplier = new MockSupplierAdapter();
    const [summary] = await supplier.searchProducts({ keyword: "photo projection necklace" });
    expect(summary).toMatchObject({ externalId: NECKLACE_PRODUCT_ID, fromCostCents: 1120 });

    const product = await supplier.getProduct(NECKLACE_PRODUCT_ID);
    expect(product?.imageUrls).toHaveLength(6);
    expect(product?.isPersonalized).toBe(true);

    const [variant] = await supplier.getVariants(NECKLACE_PRODUCT_ID);
    expect(variant.costCents).toBe(1120);

    const options = await supplier.getShippingOptions(NECKLACE_VARIANT_ID, "US");
    expect(options.find((option) => option.warehouse === "US")).toMatchObject({ costCents: 490, deliveryDaysMax: 5 });
    expect(await supplier.getShippingOptions(NECKLACE_VARIANT_ID, "DE")).toEqual([]);
  });

  it("finds products by occasion keyword and by the trending list", async () => {
    const supplier = new MockSupplierAdapter();
    expect(await supplier.searchProducts({ keyword: "Valentines Day Gift" })).toHaveLength(1);
    expect(await supplier.searchProducts({ keyword: "valentines day gift", trending: true })).toHaveLength(1);
    expect(await supplier.searchProducts({ keyword: "halloween decoration" })).toEqual([]);
  });

  it("returns nothing for unknown products and keywords", async () => {
    const supplier = new MockSupplierAdapter();
    expect(await supplier.getProduct("nope")).toBeNull();
    expect(await supplier.searchProducts({ keyword: "garden hose" })).toEqual([]);
  });

  it("reflects simulated price changes without leaking between instances", async () => {
    const supplier = new MockSupplierAdapter();
    supplier.setCost(NECKLACE_VARIANT_ID, 1220);
    expect((await supplier.getStockAndPrice(NECKLACE_VARIANT_ID)).costCents).toBe(1220);
    expect((await new MockSupplierAdapter().getStockAndPrice(NECKLACE_VARIANT_ID)).costCents).toBe(1120);
  });

  it("places an order once per idempotency key and exposes tracking", async () => {
    const supplier = new MockSupplierAdapter();
    const first = await supplier.placeOrder(order);
    const retry = await supplier.placeOrder(order);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ costCents: 1120, shippingCents: 490 });
    expect((await supplier.getStockAndPrice(NECKLACE_VARIANT_ID)).stockByWarehouse.US).toBe(239);

    const tracking = await supplier.getTracking(first.supplierOrderId);
    expect(tracking.status).toBe("SHIPPED");
    expect(tracking.trackingNumber).toMatch(/^MOCKTRK/);
    await expect(supplier.getTracking("CJ-REAL-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails with typed errors when out of stock or the address is incomplete", async () => {
    const supplier = new MockSupplierAdapter();
    supplier.setStock(NECKLACE_VARIANT_ID, "US", 0);
    await expect(supplier.placeOrder(order)).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
    await expect(
      supplier.placeOrder({ ...order, idempotencyKey: "order-2", shippingAddress: { ...order.shippingAddress, postalCode: "" } }),
    ).rejects.toBeInstanceOf(SupplierError);
    await expect(
      supplier.placeOrder({ ...order, idempotencyKey: "order-3", warehouse: "DE" }),
    ).rejects.toMatchObject({ code: "SHIPPING_UNAVAILABLE" });
  });
});

describe("mock marketplaces", () => {
  it("splits the fixture competitors by marketplace", async () => {
    const ebay = await new MockEbayAdapter().searchByKeyword("photo projection necklace", 50);
    const amazon = await new MockAmazonAdapter().searchByKeyword("photo projection necklace", 50);
    expect(ebay.map((listing) => listing.externalId).sort()).toEqual(
      ["A", "B", "C", "D", "E", "G", "H"].map((id) => `EBAY-${id}`),
    );
    expect(amazon.map((listing) => listing.externalId)).toEqual(["B0MOCKNKF1"]);
    expect(await new MockEbayAdapter().searchByImage(new Uint8Array(), 3)).toHaveLength(3);
  });

  it("matches the scenario prices", () => {
    const prices = Object.fromEntries(necklaceCompetitors.map((listing) => [listing.externalId, listing.priceCents]));
    expect(prices).toEqual({
      "EBAY-A": 499,
      "EBAY-B": 1593,
      "EBAY-C": 5861,
      "EBAY-D": 2699,
      "EBAY-E": 2995,
      B0MOCKNKF1: 2499,
      "EBAY-G": 2250,
      "EBAY-H": 2749,
    });
  });

  it("publishes idempotently per SKU, updates, and records orders and tracking", async () => {
    const ebay = new MockEbayAdapter();
    const draft = {
      sku: "DP-1",
      title: "Necklace",
      description: "A necklace",
      priceCents: 2489,
      quantity: 5,
      imageUrls: [],
      detailImageUrls: [],
      itemSpecifics: {},
      handlingDays: 2,
      deliveryDaysMax: 5,
    };
    const { externalId } = await ebay.publishListing(draft);
    expect((await ebay.publishListing(draft)).externalId).toBe(externalId);

    await ebay.updateListing({ externalId, sku: "DP-1" }, { priceCents: 2589, quantity: 0 });
    expect(ebay.getListing(externalId)).toMatchObject({ priceCents: 2589, quantity: 0 });
    await expect(ebay.updateListing({ externalId: "missing", sku: "DP-1" }, { quantity: 0 })).rejects.toThrow(/Unknown/);
    // A mock listing published by another process is adopted rather than rejected.
    await ebay.updateListing({ externalId: "MOCK-EBAY-DP-9", sku: "DP-9" }, { quantity: 2 });
    expect(ebay.getListing("MOCK-EBAY-DP-9")).toMatchObject({ sku: "DP-9", quantity: 2 });

    ebay.simulateOrder({
      externalId: "ORDER-1",
      orderedAt: new Date("2027-02-03T12:00:00Z"),
      shipByDate: null,
      buyerName: "Jane Doe",
      shippingAddress: order.shippingAddress,
      totalCents: 2489,
      currency: "USD",
      lines: [{ externalLineId: "1", sku: "DP-1", quantity: 1, priceCents: 2489 }],
    });
    expect(await ebay.getOrders(new Date("2027-02-01T00:00:00Z"))).toHaveLength(1);
    expect(await ebay.getOrders(new Date("2027-02-04T00:00:00Z"))).toHaveLength(0);

    const lines = [{ externalLineId: "1", quantity: 1 }];
    await ebay.uploadTracking("ORDER-1", { trackingNumber: "T1", carrier: "USPS", lines });
    expect(ebay.getUploadedTracking("ORDER-1")).toEqual({ trackingNumber: "T1", carrier: "USPS", lines });
    await expect(ebay.uploadTracking("ORDER-2", { trackingNumber: "T2", carrier: "USPS", lines })).rejects.toThrow(/Unknown/);
  });
});

describe("MockSpecExtractor", () => {
  const extractor = new MockSpecExtractor();

  it("extracts the supplier product's specs from free text", async () => {
    const specs = await extractor.extractSpecs({
      title: necklaceProduct.title,
      description: necklaceProduct.description,
      itemSpecifics: {},
    });
    expect(specs).toEqual({
      material: "copper",
      shape: "heart",
      sizeCm: 45,
      color: "rose gold",
      personalization: true,
      giftBox: false,
      packQuantity: 1,
    });
  });

  it.each([
    ["EBAY-A", { shape: "round", personalization: false }],
    ["EBAY-B", { shape: "heart", personalization: false }],
    ["EBAY-C", { material: "925 silver", personalization: false }],
    ["EBAY-D", { material: "copper", shape: "heart", sizeCm: 45, personalization: true, giftBox: false }],
    ["EBAY-E", { personalization: true, giftBox: true }],
    ["B0MOCKNKF1", { material: "copper", shape: "heart", sizeCm: 45, personalization: true, giftBox: false }],
    ["EBAY-G", { sizeCm: 60, personalization: true }],
    ["EBAY-H", { material: "copper", shape: null, personalization: true }],
  ])("extracts the distinguishing specs of competitor %s", async (externalId, expected) => {
    expect(await extractor.extractSpecs(competitor(externalId))).toMatchObject(expected);
  });

  it("reads the gift box from variant attributes", async () => {
    const base = { title: "Necklace", description: "" };
    expect((await extractor.extractSpecs({ ...base, itemSpecifics: { giftBox: "yes" } })).giftBox).toBe(true);
    expect((await extractor.extractSpecs({ ...base, itemSpecifics: { giftBox: "no" } })).giftBox).toBe(false);
  });

  it("trusts item specifics over an identical title", async () => {
    const title = "Heart Pendant Necklace";
    const copper = await extractor.extractSpecs({ title, description: "", itemSpecifics: { Material: "Copper" } });
    const silver = await extractor.extractSpecs({ title, description: "", itemSpecifics: { Material: "925 Silver" } });
    expect(copper.material).toBe("copper");
    expect(silver.material).toBe("925 silver");
  });
});

describe("MockVisionVerifier", () => {
  const verifier = new MockVisionVerifier();
  const ref = (url: string) => ({ url, bytes: new Uint8Array(), contentType: "image/png" });
  const pairsFor = (externalId: string) =>
    competitor(externalId).imageUrls.slice(0, 4).map((url, index) => ({
      supplier: ref(necklaceProduct.imageUrls[index]),
      competitor: ref(url),
    }));

  it("returns the scripted verdicts for the scenario", async () => {
    expect(await verifier.verifySameProduct(pairsFor("EBAY-D"))).toMatchObject({ same: true, confidence: 0.95 });
    expect(await verifier.verifySameProduct(pairsFor("EBAY-H"))).toMatchObject({ same: true, confidence: 0.68 });
    expect(await verifier.verifySameProduct(pairsFor("EBAY-A"))).toMatchObject({ same: false });
  });

  it("judges unknown listings by identical photos", async () => {
    const supplier = ref(necklaceProduct.imageUrls[0]);
    const same = ref("https://mock.droppilot.local/images/other/1.png?content=necklace-1");
    const different = ref("https://mock.droppilot.local/images/other/2.png?content=unrelated");
    expect(await verifier.verifySameProduct([{ supplier, competitor: same }])).toMatchObject({ same: true });
    expect(await verifier.verifySameProduct([{ supplier, competitor: different }])).toMatchObject({ same: false });
    expect(await verifier.verifySameProduct([])).toMatchObject({ same: false, confidence: 0 });
  });
});

describe("mock data sources", () => {
  const asOf = () => new Date("2026-12-15T00:00:00Z");

  it("produces five years of 0–100 interest peaking in February for the necklace", async () => {
    const trend = await new MockTrendsSource(asOf).getInterestOverTime("photo projection necklace", "US");
    expect(trend.points).toHaveLength(60);
    expect(trend.points.at(-1)?.date).toBe("2026-12-01");
    expect(trend.points.every((point) => point.value >= 0 && point.value <= 100)).toBe(true);

    const lastYear = trend.points.slice(-12);
    const peak = lastYear.reduce((best, point) => (point.value > best.value ? point : best));
    expect(peak.date).toBe("2026-02-01");
    expect(trend.relatedRisingQueries.length).toBeGreaterThan(0);
  });

  it("returns rank history only for tracked ASINs", async () => {
    const source = new MockSalesRankSource(asOf);
    const history = await source.getSalesRankHistory("B0MOCKNKF1");
    expect(history).toHaveLength(90);
    expect(history?.at(-1)).toEqual({ date: "2026-12-15", rank: 21_000 });
    expect(await source.getSalesRankHistory("B000000000")).toBeNull();
  });
});

describe("MockEmbeddingsProvider", () => {
  it("gives identical images similarity 1 and different images low similarity", async () => {
    const provider = new MockEmbeddingsProvider();
    const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
    const image = (bytes: number[]) => ({ bytes: new Uint8Array(bytes), contentType: "image/png" });
    const [a, again, other] = await provider.embedImages([image([1, 2, 3]), image([1, 2, 3]), image([9, 9, 9])]);
    expect(a).toHaveLength(64);
    expect(dot(a, again)).toBeCloseTo(1, 10);
    expect(Math.abs(dot(a, other))).toBeLessThan(0.5);
  });
});

describe("MockListingCopyGenerator", () => {
  it("adds keywords without exceeding the title limit", async () => {
    const { title } = await new MockListingCopyGenerator().generateListingCopy({
      marketplace: "EBAY",
      sourceTitle: "Custom Photo Projection Necklace",
      sourceDescription: "A necklace.",
      specs: { material: "copper", shape: "heart", sizeCm: 45, color: "rose gold", personalization: true, giftBox: false, packQuantity: 1 },
      keywords: ["valentines day gift", "necklace", "personalized photo projection necklace", "a very long keyword that will not fit in the remaining space"],
      maxTitleLength: 80,
    });
    expect(title).toBe("Custom Photo Projection Necklace Valentines Day Gift");
    expect(title.length).toBeLessThanOrEqual(80);
  });
});
