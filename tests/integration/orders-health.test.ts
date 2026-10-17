import { rm } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { importSupplierProduct } from "@/server/catalog/import-product";
import { db } from "@/server/db";
import { captureAccountHealth } from "@/server/health/monitor";
import { createListing, publishListing } from "@/server/listing/service";
import type { MarketplaceOrder } from "@/server/marketplaces/types";
import { runMatchingForVariant } from "@/server/matching/run-matching";
import { NECKLACE_PRODUCT_ID, NECKLACE_VARIANT_ID } from "@/server/mocks/fixtures/necklace";
import { openAddress } from "@/server/orders/address";
import { markCancelled, markHandledManually, processOrder } from "@/server/orders/fulfil";
import { pollOrders } from "@/server/orders/ingest";
import { eraseEbayBuyer } from "@/server/privacy/ebay-account-deletion";
import { runCommand } from "@/server/telegram/commands";
import { updateTracking } from "@/server/orders/tracking";
import { type SupplierAdapter, SupplierError, type SupplierOrderInput } from "@/server/suppliers/types";
import { type MockPipeline, createMockPipeline, seedHolidays } from "./pipeline-helpers";

let pipeline: MockPipeline;
let variantId: string;
let listingId: string;

const ADDRESS = { name: "Jane Doe", line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US" };

function ebayOrder(overrides: Partial<MarketplaceOrder> = {}): MarketplaceOrder {
  return {
    externalId: "12-34567-89012",
    orderedAt: new Date("2027-02-03T15:00:00Z"),
    shipByDate: new Date("2027-02-05T23:59:59Z"),
    buyerName: "Jane Doe",
    shippingAddress: ADDRESS,
    totalCents: 2489,
    currency: "USD",
    lines: [{ externalLineId: "L-1", sku: "DP-CJNK001-RG", quantity: 1, priceCents: 2489 }],
    ...overrides,
  };
}

beforeEach(async () => {
  pipeline = await createMockPipeline("2027-01-10T09:00:00Z");
  await seedHolidays();
  await importSupplierProduct(NECKLACE_PRODUCT_ID, pipeline.deps.importer);
  variantId = (await db.productVariant.findFirstOrThrow()).id;
  await runMatchingForVariant(variantId, pipeline.deps.matching);
  const draft = await createListing(variantId, "EBAY", pipeline.deps.listing);
  listingId = (await publishListing(draft.id, pipeline.deps.listing)).id;
  pipeline.clock.now = new Date("2027-02-03T16:00:00Z");
  return async () => {
    await rm(pipeline.cacheDir, { recursive: true, force: true });
  };
});

afterAll(async () => {
  await db.$disconnect();
});

async function ingest(order: MarketplaceOrder = ebayOrder()): Promise<string> {
  pipeline.ebay.simulateOrder(order);
  const [orderId] = await pollOrders("EBAY", pipeline.orderDeps);
  // The new-order notice has its own test; the counts below are about problem alerts.
  pipeline.email.sent.splice(0);
  pipeline.telegram.sent.splice(0);
  return orderId;
}

describe("order ingestion", () => {
  it("stores a new order once, with its address encrypted", async () => {
    const orderId = await ingest();
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    expect(order).toMatchObject({ marketplace: "EBAY", externalId: "12-34567-89012", status: "NEW", totalCents: 2489, buyerName: "Jane Doe" });
    expect(order.items).toMatchObject([{ listingId, externalLineId: "L-1", quantity: 1, priceCents: 2489 }]);

    expect(JSON.stringify(order.shippingAddress)).not.toContain("Main St");
    expect(openAddress(order.shippingAddress)).toEqual(ADDRESS);

    // The next poll overlaps the previous one and must not duplicate the order.
    expect(await pollOrders("EBAY", pipeline.orderDeps)).toEqual([]);
    expect(await db.order.count()).toBe(1);
  });

  it("announces each new order once by email and Telegram, without the buyer's name or address", async () => {
    pipeline.ebay.simulateOrder(ebayOrder());
    await pollOrders("EBAY", pipeline.orderDeps);
    await pollOrders("EBAY", pipeline.orderDeps);
    expect(pipeline.telegram.sent).toEqual([
      {
        severity: "INFO",
        title: "New eBay order 12-34567-89012",
        message: [
          "1 × Custom Photo Projection Necklace (SKU DP-CJNK001-RG) at $24.89",
          "Total $24.89",
          "Ships to Austin, TX, US",
          "Ordered 2027-02-03 15:00 UTC · ship by 2027-02-05",
          "Next: the price is re-checked and the supplier order is placed.",
        ].join("\n"),
      },
    ]);
    expect(pipeline.email.sent).toHaveLength(1);
    expect(JSON.stringify(pipeline.telegram.sent)).not.toMatch(/Jane Doe|Main St|78701/);
  });

  it("erases a buyer's name and address when eBay reports their account closed, keeping the order itself", async () => {
    const orderId = await ingest(ebayOrder({ buyerUsername: "jane_buyer" }));
    const other = await ingest(ebayOrder({ externalId: "other-buyer", buyerUsername: "someone_else" }));

    expect(await eraseEbayBuyer("jane_buyer")).toBe(1);
    const erased = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(erased).toMatchObject({ buyerName: "Closed eBay account", buyerUsername: null, totalCents: 2489, externalId: "12-34567-89012" });
    expect(openAddress(erased.shippingAddress)).toEqual({ name: "", line1: "", city: "", state: "", postalCode: "", country: "" });
    expect((await db.order.findUniqueOrThrow({ where: { id: other } })).buyerName).toBe("Jane Doe");

    // A repeated notice finds nothing left to erase.
    expect(await eraseEbayBuyer("jane_buyer")).toBe(0);
  });

  it("ignores orders for items this system did not list", async () => {
    pipeline.ebay.simulateOrder(ebayOrder({ lines: [{ externalLineId: "L-9", sku: "SOMETHING-ELSE", quantity: 1, priceCents: 999 }] }));
    expect(await pollOrders("EBAY", pipeline.orderDeps)).toEqual([]);
    expect(await db.order.count()).toBe(0);
  });

  it("flags a listing as a top seller after five units in 30 days", async () => {
    await ingest(ebayOrder({ lines: [{ externalLineId: "L-1", sku: "DP-CJNK001-RG", quantity: 4, priceCents: 2489 }] }));
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).isTopSeller).toBe(false);
    await ingest(ebayOrder({ externalId: "second" }));
    expect((await db.listing.findUniqueOrThrow({ where: { id: listingId } })).isTopSeller).toBe(true);
  });
});

describe("order fulfilment", () => {
  it("auto-orders a profitable order with the customer's address and blind shipping, and saves the supplier order id", async () => {
    const orderId = await ingest();
    const result = await processOrder(orderId, pipeline.orderDeps);
    // 24.89 × 0.8075 − 0.30 − 11.20 − 4.90 = 3.70
    expect(result).toMatchObject({ outcome: "ORDERED", expectedProfitCents: 370 });
    expect(result.supplierOrderId).toMatch(/^MOCK-CJ-/);

    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("ORDERED");
    expect(await db.supplierOrder.findMany()).toMatchObject([
      { status: "PLACED", externalId: result.supplierOrderId, costCents: 1120, shippingCents: 490, expectedProfitCents: 370, blindShipping: true },
    ]);
    expect(pipeline.telegram.sent).toMatchObject([{ severity: "INFO", title: "Supplier order placed for eBay order 12-34567-89012" }]);
    const placed = pipeline.telegram.sent[0].message;
    expect(placed).toContain(`CJ Dropshipping order ${result.supplierOrderId}: 1 item(s) from the US warehouse`);
    expect(placed).toContain("$11.20 + $4.90 shipping");
    expect(placed).toContain("Order total $24.89 · supplier total $16.10 · expected profit $3.70");
    expect(placed).not.toMatch(/Jane Doe|Main St/);
    // One unit left the supplier's US warehouse.
    expect((await pipeline.supplier.getStockAndPrice(NECKLACE_VARIANT_ID)).stockByWarehouse.US).toBe(239);
    expect(await db.alert.count()).toBe(0);
  });

  it("never places a second supplier order for the same order", async () => {
    const orderId = await ingest();
    await processOrder(orderId, pipeline.orderDeps);
    expect(await processOrder(orderId, pipeline.orderDeps)).toMatchObject({ outcome: "SKIPPED" });
    expect(await db.supplierOrder.count()).toBe(1);
    expect((await pipeline.supplier.getStockAndPrice(NECKLACE_VARIANT_ID)).stockByWarehouse.US).toBe(239);
  });

  it("still orders when a supplier price rise causes a loss within the $1 limit", async () => {
    const orderId = await ingest();
    // Cost +$4.50 → profit 3.70 − 4.50 = −0.80.
    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1570);
    expect(await processOrder(orderId, pipeline.orderDeps)).toMatchObject({ outcome: "ORDERED", expectedProfitCents: -80 });
  });

  it("creates the supplier order unpaid when balance payment is off, and reminds the admin to pay until the supplier ships", async () => {
    const orderId = await ingest();
    const manual = structuredClone(pipeline.settings);
    manual.orders.payFromSupplierBalance = false;
    const deps = { ...pipeline.orderDeps, settings: manual };

    expect(await processOrder(orderId, deps)).toMatchObject({ outcome: "ORDERED", expectedProfitCents: 370 });
    const alert = await db.alert.findFirstOrThrow();
    expect(alert).toMatchObject({ severity: "WARNING", type: "order.payment_needed", orderId, resolvedAt: null });
    expect(alert.message).toMatch(/^Pay the supplier: \$16\.10 for eBay order 12-34567-89012\n/);
    expect(alert.message).toContain("created at CJ Dropshipping unpaid");
    expect(alert.message).toContain("Ship by 2027-02-05");
    // The reminder replaces the "supplier order placed" notice.
    expect(pipeline.telegram.sent.map((message) => message.title)).toEqual(["Pay the supplier: $16.10 for eBay order 12-34567-89012"]);

    // The supplier reports the parcel moving: the reminder closes.
    await updateTracking(deps);
    expect((await db.alert.findFirstOrThrow()).resolvedAt).not.toBeNull();
  });

  it("takes order decisions from the chat: paid, fulfil anyway, handled, cancelled", async () => {
    const commandDeps = { listing: async () => pipeline.deps.listing, orders: async () => pipeline.orderDeps };
    const manual = structuredClone(pipeline.settings);
    manual.orders.payFromSupplierBalance = false;

    const unpaid = await ingest();
    await processOrder(unpaid, { ...pipeline.orderDeps, settings: manual });
    expect((await runCommand("orders", commandDeps)).text).toContain(`paid ${unpaid}`);
    expect((await runCommand(`paid ${unpaid}`, commandDeps)).text).toBe("Order 12-34567-89012: payment noted; the reminder is closed.");
    expect(await db.alert.count({ where: { resolvedAt: null } })).toBe(0);

    const losing = await ingest(ebayOrder({ externalId: "losing" }));
    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1620);
    await processOrder(losing, pipeline.orderDeps);
    expect((await runCommand("orders", commandDeps)).text).toContain(`fulfil ${losing}`);
    expect((await runCommand(`fulfil ${losing}`, commandDeps)).text).toMatch(/^Supplier order placed for eBay order losing: MOCK-CJ-/);
    expect((await db.order.findUniqueOrThrow({ where: { id: losing } })).status).toBe("ORDERED");

    const other = await ingest(ebayOrder({ externalId: "other" }));
    await processOrder(other, pipeline.orderDeps);
    expect((await runCommand(`cancelled ${other}`, commandDeps)).text).toContain("nothing was cancelled on the marketplace");
    expect((await db.order.findUniqueOrThrow({ where: { id: other } })).status).toBe("CANCELLED");
    expect((await runCommand("orders", commandDeps)).text).toBe("No orders need you right now.");
  });

  it("does not order when the loss is bigger, and alerts on the dashboard, by email and by Telegram", async () => {
    const orderId = await ingest();
    // Cost +$5 → profit 3.70 − 5.00 = −1.30.
    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1620);
    expect(await processOrder(orderId, pipeline.orderDeps)).toMatchObject({ outcome: "NEEDS_DECISION", expectedProfitCents: -130 });

    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("NEEDS_DECISION");
    expect(await db.supplierOrder.count()).toBe(0);
    const alert = await db.alert.findFirstOrThrow();
    expect(alert).toMatchObject({ severity: "CRITICAL", type: "order.price_jump", orderId, resolvedAt: null });
    expect(alert.message).toMatch(/lose \$1\.30/);
    expect(alert.message).toMatch(/fulfil anyway.*another supplier.*cancel/);
    expect(pipeline.email.sent).toHaveLength(1);
    expect(pipeline.telegram.sent).toHaveLength(1);

    // Processing it again without a decision neither orders nor alerts twice.
    expect(await processOrder(orderId, pipeline.orderDeps)).toMatchObject({ outcome: "SKIPPED" });
    expect(await db.alert.count()).toBe(1);
    expect(pipeline.email.sent).toHaveLength(1);
  });

  it("fulfils anyway when the admin decides to, and closes the alert", async () => {
    const orderId = await ingest();
    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1620);
    await processOrder(orderId, pipeline.orderDeps);

    expect(await processOrder(orderId, pipeline.orderDeps, { force: true })).toMatchObject({ outcome: "ORDERED", expectedProfitCents: -130 });
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("ORDERED");
    expect((await db.alert.findFirstOrThrow()).resolvedAt).not.toBeNull();
  });

  it("lets the admin fulfil elsewhere or record a cancellation, without ever cancelling on the marketplace", async () => {
    const first = await ingest();
    const second = await ingest(ebayOrder({ externalId: "second" }));
    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1620);
    await processOrder(first, pipeline.orderDeps);
    await processOrder(second, pipeline.orderDeps);

    await markHandledManually(first, pipeline.clock.now);
    await markCancelled(second, pipeline.clock.now);
    expect((await db.order.findUniqueOrThrow({ where: { id: first } })).status).toBe("ORDERED");
    expect((await db.order.findUniqueOrThrow({ where: { id: second } })).status).toBe("CANCELLED");
    expect(await db.alert.count({ where: { resolvedAt: null } })).toBe(0);
    expect(await db.supplierOrder.count()).toBe(0);
  });

  it("marks the order failed and alerts when the supplier is out of stock; a retry succeeds once stock is back", async () => {
    const orderId = await ingest();
    pipeline.supplier.setStock(NECKLACE_VARIANT_ID, "US", 0);
    pipeline.supplier.setStock(NECKLACE_VARIANT_ID, "CN", 0);

    expect(await processOrder(orderId, pipeline.orderDeps)).toMatchObject({ outcome: "FAILED" });
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("FAILED");
    const alert = await db.alert.findFirstOrThrow();
    expect(alert.type).toBe("order.out_of_stock");
    expect(alert.message).toMatch(/NOT been cancelled/);
    expect(pipeline.telegram.sent).toHaveLength(1);

    pipeline.supplier.setStock(NECKLACE_VARIANT_ID, "US", 10);
    expect(await processOrder(orderId, pipeline.orderDeps, { force: false })).toMatchObject({ outcome: "ORDERED" });
    expect((await db.alert.findFirstOrThrow()).resolvedAt).not.toBeNull();
  });

  it("marks the order failed and alerts when the supplier rejects the address", async () => {
    const orderId = await ingest(ebayOrder({ shippingAddress: { ...ADDRESS, postalCode: "" } }));
    expect(await processOrder(orderId, pipeline.orderDeps)).toMatchObject({ outcome: "FAILED" });
    expect((await db.alert.findFirstOrThrow()).type).toBe("order.address_error");
    expect(await db.supplierOrder.findFirstOrThrow()).toMatchObject({ status: "FAILED" });
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("FAILED");
  });

  it("keeps the alert on the dashboard even when a notification channel is down", async () => {
    const orderId = await ingest();
    pipeline.supplier.setCost(NECKLACE_VARIANT_ID, 1620);
    const broken = { channel: "email", send: () => Promise.reject(new Error("SMTP down")) };
    await processOrder(orderId, { ...pipeline.orderDeps, notifiers: [broken, pipeline.telegram] });
    expect(await db.alert.count()).toBe(1);
    expect(pipeline.telegram.sent).toHaveLength(1);
  });
});

describe("Amazon orders", () => {
  it("run through the same pipeline: blind supplier order, Amazon fees, tracking confirmed on Amazon", async () => {
    const draft = await createListing(variantId, "AMAZON", pipeline.deps.listing);
    await publishListing(draft.id, pipeline.deps.listing);
    pipeline.amazon.simulateOrder({ ...ebayOrder(), externalId: "111-2223334-4445556" });

    const [orderId] = await pollOrders("AMAZON", pipeline.orderDeps);
    // 24.89 × (1 − 0.15 − 0.06) − 11.20 − 4.90 = 3.56
    expect(await processOrder(orderId, pipeline.orderDeps)).toMatchObject({ outcome: "ORDERED", expectedProfitCents: 356 });
    expect(await db.supplierOrder.findFirstOrThrow()).toMatchObject({ blindShipping: true, status: "PLACED" });

    expect(await updateTracking(pipeline.orderDeps)).toMatchObject({ uploaded: [orderId] });
    expect(pipeline.amazon.getUploadedTracking("111-2223334-4445556")?.trackingNumber).toMatch(/^MOCKTRK/);
    expect(pipeline.ebay.getUploadedTracking("111-2223334-4445556")).toBeUndefined();
  });
});

describe("orders that ship from more than one warehouse", () => {
  const SECOND_VARIANT = "CJ-CHAIN-001";

  /** The mock supplier plus a second product that is stocked only in China. */
  function supplierWithSecondProduct(options: { secondInStock: boolean }): { supplier: SupplierAdapter; placed: SupplierOrderInput[] } {
    const placed: SupplierOrderInput[] = [];
    const inner = pipeline.supplier;
    const supplier: SupplierAdapter = {
      code: inner.code,
      searchProducts: (query) => inner.searchProducts(query),
      getProduct: (id) => inner.getProduct(id),
      getVariants: (id) => inner.getVariants(id),
      getStockAndPrice: async (id) =>
        id === SECOND_VARIANT
          ? { variantExternalId: id, costCents: 300, currency: "USD", stockByWarehouse: { CN: options.secondInStock ? 50 : 0 } }
          : inner.getStockAndPrice(id),
      getShippingOptions: async (id, country) =>
        id === SECOND_VARIANT
          ? [{ name: "CJPacket Ordinary", warehouse: "CN", destinationCountry: country, costCents: 200, deliveryDaysMin: 8, deliveryDaysMax: 14 }]
          : inner.getShippingOptions(id, country),
      placeOrder: async (input) => {
        placed.push(input);
        if (input.items[0].variantExternalId !== SECOND_VARIANT) return inner.placeOrder(input);
        if (!options.secondInStock) throw new SupplierError("OUT_OF_STOCK", "CJ-CHAIN-001 is out of stock in CN");
        return { supplierOrderId: `MOCK-CJ-${input.idempotencyKey}`, costCents: 300, shippingCents: 200 };
      },
      getTracking: (id) => inner.getTracking(id),
    };
    return { supplier, placed };
  }

  async function orderWithTwoProducts(): Promise<string> {
    const necklace = await db.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    const chain = await db.productVariant.create({
      data: {
        productId: necklace.productId,
        externalId: SECOND_VARIANT,
        sku: "CJCH001",
        attributes: {},
        costCents: 300,
        shippingCents: 200,
        warehouse: "CN",
        stock: 50,
        processingDays: 2,
        deliveryDaysMin: 8,
        deliveryDaysMax: 14,
      },
    });
    await db.listing.create({
      data: { variantId: chain.id, marketplace: "EBAY", externalId: "MOCK-EBAY-DP-CJCH001", sku: "DP-CJCH001", title: "Extension Chain", description: "", priceCents: 899, floorCents: 800, status: "ACTIVE" },
    });
    return ingest(
      ebayOrder({
        totalCents: 3388,
        lines: [
          { externalLineId: "L-1", sku: "DP-CJNK001-RG", quantity: 1, priceCents: 2489 },
          { externalLineId: "L-2", sku: "DP-CJCH001", quantity: 1, priceCents: 899 },
        ],
      }),
    );
  }

  it("places one supplier order per warehouse and marks the order shipped once every parcel has tracking", async () => {
    const orderId = await orderWithTwoProducts();
    const { supplier, placed } = supplierWithSecondProduct({ secondInStock: true });
    const deps = { ...pipeline.orderDeps, supplier };

    // Necklace: 24.89 × 0.8075 − 0.30 − 16.10 = 3.70. Chain: 8.99 × 0.8075 − 5.00 = 2.26 (the fixed fee is charged once).
    expect(await processOrder(orderId, deps)).toMatchObject({ outcome: "ORDERED", expectedProfitCents: 596 });
    expect(placed.map((input) => [input.warehouse, input.items.map((item) => item.variantExternalId)])).toEqual([
      ["CN", [SECOND_VARIANT]],
      ["US", [NECKLACE_VARIANT_ID]],
    ]);
    expect(new Set(placed.map((input) => input.idempotencyKey)).size).toBe(2);

    const supplierOrders = await db.supplierOrder.findMany({ orderBy: { idempotencyKey: "asc" } });
    expect(supplierOrders).toHaveLength(2);
    expect(supplierOrders.every((supplierOrder) => supplierOrder.status === "PLACED" && supplierOrder.lineIds.length === 1)).toBe(true);

    pipeline.clock.now = new Date("2027-02-04T10:00:00Z");
    expect(await updateTracking(deps)).toMatchObject({ checked: 2, uploaded: [orderId] });
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("SHIPPED");
    // The last upload carries only that parcel's line.
    expect(pipeline.ebay.getUploadedTracking("12-34567-89012")?.lines).toHaveLength(1);
  });

  it("keeps the parcel that was ordered when another fails, and a retry orders only the rest", async () => {
    const orderId = await orderWithTwoProducts();
    // Stock for the chain looks fine when checked, but the supplier refuses the order itself.
    const failing = supplierWithSecondProduct({ secondInStock: true });
    const refusing: SupplierAdapter = {
      ...failing.supplier,
      placeOrder: async (input) => {
        if (input.items[0].variantExternalId === NECKLACE_VARIANT_ID) throw new SupplierError("OUT_OF_STOCK", "necklace just sold out");
        return failing.supplier.placeOrder(input);
      },
    };
    expect(await processOrder(orderId, { ...pipeline.orderDeps, supplier: refusing })).toMatchObject({ outcome: "FAILED" });
    expect((await db.alert.findFirstOrThrow()).message).toMatch(/1 of 2 parcels were already ordered/);
    expect((await db.supplierOrder.findMany()).map((supplierOrder) => supplierOrder.status).sort()).toEqual(["FAILED", "PLACED"]);

    const retry = supplierWithSecondProduct({ secondInStock: true });
    expect(await processOrder(orderId, { ...pipeline.orderDeps, supplier: retry.supplier }, { force: false })).toMatchObject({ outcome: "ORDERED" });
    // Only the necklace is ordered this time.
    expect(retry.placed.map((input) => input.items[0].variantExternalId)).toEqual([NECKLACE_VARIANT_ID]);
    expect((await db.supplierOrder.findMany()).every((supplierOrder) => supplierOrder.status === "PLACED")).toBe(true);
  });
});

describe("tracking", () => {
  it("uploads the supplier's tracking number to the marketplace and marks the order shipped", async () => {
    const orderId = await ingest();
    await processOrder(orderId, pipeline.orderDeps);

    pipeline.clock.now = new Date("2027-02-04T10:00:00Z");
    const result = await updateTracking(pipeline.orderDeps);
    expect(result).toMatchObject({ checked: 1, uploaded: [orderId], delivered: [] });

    const uploaded = pipeline.ebay.getUploadedTracking("12-34567-89012");
    expect(uploaded).toMatchObject({ carrier: "USPS", lines: [{ externalLineId: "L-1", quantity: 1 }] });
    expect(uploaded?.trackingNumber).toMatch(/^MOCKTRK/);

    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("SHIPPED");
    const supplierOrder = await db.supplierOrder.findFirstOrThrow({ include: { trackingEvents: true } });
    expect(supplierOrder).toMatchObject({ status: "SHIPPED", trackingNumber: uploaded?.trackingNumber, carrier: "USPS" });
    expect(supplierOrder.trackingUploadedAt).toEqual(pipeline.clock.now);
    expect(supplierOrder.trackingEvents).toHaveLength(1);

    expect(pipeline.telegram.sent.at(-1)).toEqual({
      severity: "INFO",
      title: "Tracking uploaded for eBay order 12-34567-89012",
      message: `USPS ${uploaded?.trackingNumber}\nSupplier order ${supplierOrder.externalId}, 1 item(s)\neBay now shows the order as shipped.`,
    });
    const sentSoFar = pipeline.telegram.sent.length;

    // A second run uploads nothing again and stores no duplicate events.
    expect(await updateTracking(pipeline.orderDeps)).toMatchObject({ uploaded: [] });
    expect(await db.trackingEvent.count()).toBe(1);
    expect(pipeline.telegram.sent).toHaveLength(sentSoFar);
  });
});

describe("account health", () => {
  it("records healthy metrics without alerting or pausing", async () => {
    const health = await captureAccountHealth("EBAY", pipeline.orderDeps);
    expect(health).toMatchObject({ marketplace: "EBAY", defectRate: 0.001, newListingsPaused: false });
    expect(await db.alert.count()).toBe(0);
  });

  it("warns before the eBay defect limit, pauses new listings, and recovers", async () => {
    // Limit 2%; 1.7% is past 80% of it.
    pipeline.ebay.setAccountHealth({ defectRate: 0.017 });
    expect(await captureAccountHealth("EBAY", pipeline.orderDeps)).toMatchObject({ newListingsPaused: true });
    const alert = await db.alert.findFirstOrThrow();
    expect(alert).toMatchObject({ severity: "WARNING", type: "health.EBAY.defectRate" });
    expect(alert.message).toMatch(/1\.70%[\s\S]*below 2\.00%/);
    expect(pipeline.email.sent).toHaveLength(1);

    // New listings are refused while paused; existing ones are untouched.
    await db.listing.update({ where: { id: listingId }, data: { status: "PENDING_APPROVAL", externalId: null } });
    await expect(publishListing(listingId, pipeline.deps.listing)).rejects.toMatchObject({ rule: "ACCOUNT_HEALTH" });

    // The same reading the next day does not alert again.
    await captureAccountHealth("EBAY", pipeline.orderDeps);
    expect(await db.alert.count()).toBe(1);

    pipeline.ebay.setAccountHealth({ defectRate: 0.004 });
    expect(await captureAccountHealth("EBAY", pipeline.orderDeps)).toMatchObject({ newListingsPaused: false });
    expect((await db.alert.findFirstOrThrow()).resolvedAt).not.toBeNull();
    await expect(publishListing(listingId, pipeline.deps.listing)).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("raises a critical alert past the limit", async () => {
    pipeline.ebay.setAccountHealth({ defectRate: 0.025 });
    await captureAccountHealth("EBAY", pipeline.orderDeps);
    expect(await db.alert.findFirstOrThrow()).toMatchObject({ severity: "CRITICAL" });
  });

  it("checks Amazon's four limits, including the valid tracking minimum", async () => {
    pipeline.amazon.setAccountHealth({ defectRate: 0.002, lateShipmentRate: 0.035, cancellationRate: 0.01, validTrackingRate: 0.955 });
    expect(await captureAccountHealth("AMAZON", pipeline.orderDeps)).toMatchObject({ newListingsPaused: true });
    const types = (await db.alert.findMany({ orderBy: { type: "asc" } })).map((alert) => alert.type);
    // Late 3.5% is past 80% of 4%; tracking 95.5% is within the last fifth above 95%. Defects and cancellations are fine.
    expect(types).toEqual(["health.AMAZON.lateShipmentRate", "health.AMAZON.validTrackingRate"]);
  });

  it("does not pause listings when that setting is off", async () => {
    pipeline.ebay.setAccountHealth({ defectRate: 0.017 });
    const settings = structuredClone(pipeline.settings);
    settings.health.pauseNewListingsNearLimit = false;
    expect(await captureAccountHealth("EBAY", { ...pipeline.orderDeps, settings })).toMatchObject({ newListingsPaused: false });
    expect(await db.alert.count()).toBe(1);
  });

  it("fills metrics the marketplace does not report from our own order records", async () => {
    pipeline.ebay.setAccountHealth({ lateShipmentRate: null, cancellationRate: null, validTrackingRate: null });
    const shippedLate = await ingest();
    await processOrder(shippedLate, pipeline.orderDeps);
    // Tracking is uploaded two days after the ship-by date.
    pipeline.clock.now = new Date("2027-02-07T10:00:00Z");
    await updateTracking(pipeline.orderDeps);
    const cancelled = await ingest(ebayOrder({ externalId: "second", orderedAt: new Date("2027-02-06T10:00:00Z"), shipByDate: new Date("2027-02-09T00:00:00Z") }));
    await markCancelled(cancelled, pipeline.clock.now);

    const health = await captureAccountHealth("EBAY", pipeline.orderDeps);
    expect(health).toMatchObject({ lateShipmentRate: 1, cancellationRate: 0.5, validTrackingRate: 1, returnRate: 0.012 });
  });
});
