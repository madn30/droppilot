import { describe, expect, it } from "vitest";
import type { SupplierShippingOption } from "../suppliers/types";
import { chooseShippingOption } from "./shipping-choice";

function option(name: string, warehouse: string, costCents: number, deliveryDaysMax: number): SupplierShippingOption {
  return { name, warehouse, destinationCountry: "US", costCents, deliveryDaysMin: 1, deliveryDaysMax };
}

describe("chooseShippingOption", () => {
  const cn = option("CJPacket Ordinary", "CN", 310, 14);
  const us = option("USPS+", "US", 490, 5);
  const de = option("DHL", "DE", 900, 9);

  it("prefers the destination's own warehouse even when it costs more", () => {
    expect(chooseShippingOption([cn, de, us], { CN: 100, DE: 5, US: 5 })).toBe(us);
  });

  it("prefers an EU warehouse over China when the US has no stock", () => {
    expect(chooseShippingOption([cn, de, us], { CN: 100, DE: 5, US: 0 })).toBe(de);
  });

  it("falls back to China when nothing else is stocked", () => {
    expect(chooseShippingOption([cn, de, us], { CN: 100 })).toBe(cn);
  });

  it("picks the fastest, then the cheapest, within the same warehouse", () => {
    const slow = option("Ground", "US", 300, 7);
    const fastPricey = option("Priority", "US", 800, 3);
    const fastCheap = option("First Class", "US", 450, 3);
    expect(chooseShippingOption([slow, fastPricey, fastCheap], { US: 1 })).toBe(fastCheap);
  });

  it("returns null when no stocked warehouse can ship to the destination", () => {
    expect(chooseShippingOption([us], { US: 0, CN: 50 })).toBeNull();
    expect(chooseShippingOption([], { US: 10 })).toBeNull();
  });
});
