import { describe, expect, it } from "vitest";
import { getSpecExtractor } from "./ai";
import { getTrendsSource } from "./data-sources";
import { getMarketplaceAdapter, listingUrl } from "./marketplaces";
import { getSupplierAdapter, supplierProductUrl } from "./suppliers";

// vitest.config.ts sets MOCK_APIS=true.
describe("adapter factories in mock mode", () => {
  it("return mock adapters without any API keys", () => {
    expect(getSupplierAdapter().code).toBe("cj");
    expect(getMarketplaceAdapter("EBAY").marketplace).toBe("EBAY");
    expect(getMarketplaceAdapter("AMAZON").marketplace).toBe("AMAZON");
    expect(getTrendsSource()).toBeDefined();
    expect(getSpecExtractor()).toBeDefined();
  });

  it("reuse the stateful mocks within a process", () => {
    expect(getSupplierAdapter()).toBe(getSupplierAdapter());
    expect(getMarketplaceAdapter("EBAY")).toBe(getMarketplaceAdapter("EBAY"));
  });
});

describe("links shown in the dashboard", () => {
  const live = { MOCK_APIS: false, EBAY_ENV: "sandbox" } as const;

  it("link a CJ product to its page on CJ, but not in mock mode", () => {
    expect(supplierProductUrl(live, "cj", "9FA9912D-F0AF")).toBe("https://cjdropshipping.com/product/-p-9FA9912D-F0AF.html");
    expect(supplierProductUrl({ MOCK_APIS: true }, "cj", "CJ-NECKLACE-001")).toBeNull();
  });

  it("link a published eBay listing to the sandbox or the live site", () => {
    expect(listingUrl(live, "EBAY", "110590957883")).toBe("https://sandbox.ebay.com/itm/110590957883");
    expect(listingUrl({ ...live, EBAY_ENV: "production" }, "EBAY", "110590957883")).toBe("https://www.ebay.com/itm/110590957883");
  });

  it("give no link for drafts, mock listings or Amazon", () => {
    expect(listingUrl(live, "EBAY", null)).toBeNull();
    expect(listingUrl({ ...live, MOCK_APIS: true }, "EBAY", "MOCK-EBAY-DP-1")).toBeNull();
    expect(listingUrl(live, "AMAZON", "B0TEST")).toBeNull();
  });
});
