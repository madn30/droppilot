import { describe, expect, it } from "vitest";
import { defaultSettings } from "../settings/schema";
import {
  ComplianceError,
  allowedLiveListings,
  assertBlindShippingForAmazon,
  assertDeliveryWithinPromise,
  assertDropshipSupplier,
  assertListingLimit,
  assertNoTrademarks,
  assertAllowedWarehouse,
  findTrademarks,
} from "./guards";

const listing = defaultSettings({ MIN_PROFIT: 300, MAX_ACCEPTABLE_LOSS: 100, DEMAND_THRESHOLD: 60 }).listing;
const day = (date: string) => new Date(`${date}T00:00:00Z`);

describe("supplier rules", () => {
  it("allows dropshipping suppliers only", () => {
    expect(() => assertDropshipSupplier({ code: "cj", isDropshipSupplier: true })).not.toThrow();
    expect(() => assertDropshipSupplier({ code: "retail", isDropshipSupplier: false })).toThrow(ComplianceError);
  });

  it("requires blind shipping for Amazon but not for eBay", () => {
    const branded = { code: "branded", supportsBlindShipping: false };
    expect(() => assertBlindShippingForAmazon("AMAZON", branded)).toThrow(/blind/);
    expect(() => assertBlindShippingForAmazon("EBAY", branded)).not.toThrow();
    expect(() => assertBlindShippingForAmazon("AMAZON", { code: "cj", supportsBlindShipping: true })).not.toThrow();
  });
});

describe("warehouse rule", () => {
  const usOnly = { ...listing, ebayUsWarehouseOnly: true };
  const anyWarehouse = { ...listing, ebayUsWarehouseOnly: false };

  it("allows only United States stock on Amazon, whatever the eBay setting", () => {
    expect(() => assertAllowedWarehouse("AMAZON", { sku: "S1", warehouse: "US" }, anyWarehouse)).not.toThrow();
    expect(() => assertAllowedWarehouse("AMAZON", { sku: "S1", warehouse: "CN" }, anyWarehouse)).toThrow(/Amazon listings must ship from a United States warehouse/);
  });

  it("allows only United States stock on eBay while the setting is on", () => {
    expect(() => assertAllowedWarehouse("EBAY", { sku: "S1", warehouse: "US" }, usOnly)).not.toThrow();
    expect(() => assertAllowedWarehouse("EBAY", { sku: "S1", warehouse: "CN" }, usOnly)).toThrow(/eBay listings must ship from a United States warehouse/);
    expect(() => assertAllowedWarehouse("EBAY", { sku: "S1", warehouse: "CN" }, anyWarehouse)).not.toThrow();
  });
});

describe("delivery promise", () => {
  it("allows delivery within the marketplace promise", () => {
    expect(() => assertDeliveryWithinPromise("EBAY", { processingDays: 2, deliveryDaysMax: 5 }, listing)).not.toThrow();
    expect(() => assertDeliveryWithinPromise("EBAY", { processingDays: 2, deliveryDaysMax: 8 }, listing)).not.toThrow();
  });

  it("refuses products that would arrive later than promised", () => {
    expect(() => assertDeliveryWithinPromise("EBAY", { processingDays: 2, deliveryDaysMax: 14 }, listing)).toThrow(/16 days/);
    // Amazon's promise is tighter than eBay's.
    expect(() => assertDeliveryWithinPromise("AMAZON", { processingDays: 2, deliveryDaysMax: 8 }, listing)).toThrow(ComplianceError);
  });
});

describe("listing limit", () => {
  it("starts at 20 live listings", () => {
    expect(() => assertListingLimit(19, listing, null, day("2026-10-01"))).not.toThrow();
    expect(() => assertListingLimit(20, listing, null, day("2026-10-01"))).toThrow(/limit is currently 20/);
  });

  it("grows by the configured amount for every full week since the first listing", () => {
    const growing = { ...listing, listingGrowthPerWeek: 5 };
    expect(allowedLiveListings(growing, day("2026-10-01"), day("2026-10-07"))).toBe(20);
    expect(allowedLiveListings(growing, day("2026-10-01"), day("2026-10-08"))).toBe(25);
    expect(allowedLiveListings(growing, day("2026-10-01"), day("2026-10-29"))).toBe(40);
    expect(allowedLiveListings(growing, null, day("2026-10-29"))).toBe(20);
  });
});

describe("trademarks", () => {
  it("finds brand names as whole words, in any case", () => {
    expect(findTrademarks("Charm Bracelet fits PANDORA style")).toEqual(["pandora"]);
    expect(findTrademarks("Case for iPhone, Star Wars edition")).toEqual(["iphone", "star wars"]);
    expect(findTrademarks("RayBan style sunglasses")).toEqual(["ray-ban"]);
  });

  it("does not flag ordinary words that merely contain a brand", () => {
    expect(findTrademarks("Apple-shaped pendant with a frozen-look crystal for a coach")).toEqual([]);
    expect(findTrademarks("Pandoras box puzzle, legos-style bricks, unikey ring")).toEqual([]);
    expect(findTrademarks("Custom Photo Projection Necklace Valentines Day Gift")).toEqual([]);
  });

  it("rejects listing copy with a trademark in the title or the description", () => {
    expect(() => assertNoTrademarks({ title: "Heart Necklace", description: "Like the Tiffany one." })).toThrow(/tiffany/);
    expect(() => assertNoTrademarks({ title: "Heart Necklace", description: "Copper, rose gold." })).not.toThrow();
  });
});
