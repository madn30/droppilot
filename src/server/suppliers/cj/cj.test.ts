import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RateLimiter } from "../../http/rate-limiter";
import type { SupplierOrderInput } from "../types";
import { CjSupplierAdapter } from "./cj-adapter";
import { CjApiError, CjClient, type CjTokenStore } from "./client";
import type { CjTokens } from "./schemas";

// Responses below follow the examples in the CJ API v2 documentation.

const NOW = new Date("2026-10-02T00:00:00Z");

const TOKENS: CjTokens = {
  accessToken: "access-1",
  accessTokenExpiryDate: "2026-10-17T00:00:00+00:00",
  refreshToken: "refresh-1",
  refreshTokenExpiryDate: "2027-03-31T00:00:00+00:00",
};

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  token: string | null;
}

type Reply = { status?: number; code?: number; message?: string; data?: unknown } | { raw: string; status: number };
type Handler = (call: Call) => Reply;

function ok(data: unknown): Reply {
  return { data };
}

function fail(code: number, message: string, status = 200): Reply {
  return { code, message, status, data: null };
}

function memoryStore(initial: CjTokens | null = null): CjTokenStore & { saved: CjTokens[] } {
  let current = initial;
  const saved: CjTokens[] = [];
  return {
    saved,
    load: async () => current,
    save: async (tokens) => {
      current = tokens;
      saved.push(tokens);
    },
  };
}

function setup(handlers: Record<string, Handler>, store = memoryStore(TOKENS)) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api2.0/v1/", "");
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? "GET",
      path,
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      token: headers.get("CJ-Access-Token"),
    };
    calls.push(call);
    const handler = handlers[path];
    if (!handler) throw new Error(`Unexpected CJ call: ${path}`);
    const reply = handler(call);
    if ("raw" in reply) return new Response(reply.raw, { status: reply.status });
    return new Response(
      JSON.stringify({
        code: reply.code ?? 200,
        result: (reply.code ?? 200) === 200,
        message: reply.message ?? "Success",
        data: reply.data ?? null,
        requestId: "req-1",
      }),
      { status: reply.status ?? 200 },
    );
  };
  const client = new CjClient({
    apiKey: "key-1",
    tokenStore: store,
    fetch: fetchImpl,
    rateLimiter: new RateLimiter(0),
    sleep: async (ms) => void sleeps.push(ms),
    now: () => NOW,
  });
  return { calls, sleeps, store, client, adapter: new CjSupplierAdapter(client, { sandboxOrders: true }) };
}

const PRODUCT = {
  pid: "P1",
  productNameEn: "Custom Photo Projection Necklace",
  productSku: "CJNK001",
  bigImage: "https://cf.cjdropshipping.com/a.jpg",
  // As CJ sends it: the ordered list as a JSON string, and the same URLs again as an unordered set.
  productImage: JSON.stringify(Array.from({ length: 12 }, (_, index) => `https://cf.cjdropshipping.com/${index}.jpg`)),
  productImageSet: Array.from({ length: 12 }, (_, index) => `https://cf.cjdropshipping.com/${11 - index}.jpg`),
  categoryName: "Jewelry & Watches > Necklaces",
  description:
    '<p>Heart pendant &amp; chain</p><p>Material: copper<br/>Length: 40+5cm</p><p><img src="https://cf.cjdropshipping.com/d1.jpg"/><img src="https://cf.cjdropshipping.com/d2.jpg"/><img src="https://cf.cjdropshipping.com/d1.jpg"/></p>',
  productKeyEn: "Color-Size",
  sellPrice: 11.2,
  productType: "DIY_PRODUCT",
  productProEnSet: ["POD2.0", "COMMON"],
  customizationJson2: "[{\"areaName\":\"pendant\"}]",
  variants: [
    { vid: "V1", pid: "P1", variantSku: "CJNK001-RG", variantKey: "Rose Gold-45cm", variantImage: null, variantSellPrice: 11.2 },
    { vid: "V2", pid: "P1", variantSku: "CJNK001-S", variantKey: "Silver", variantImage: "https://cf.cjdropshipping.com/s.jpg", variantSellPrice: "11.85" },
  ],
};

const ORDER_INPUT: SupplierOrderInput = {
  idempotencyKey: "dp-order-1",
  items: [{ variantExternalId: "V1", quantity: 1 }],
  shippingAddress: { name: "Jane Doe", line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: "5125550100" },
  shippingOptionName: "USPS+",
  warehouse: "US",
  blindShipping: true,
  payFromBalance: true,
};

describe("CjClient", () => {
  it("sends the stored access token and parses the data", async () => {
    const { adapter, calls } = setup({ "product/query": () => ok(PRODUCT) });
    await adapter.getProduct("P1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path: "product/query", query: { pid: "P1" }, token: "access-1" });
  });

  it("logs in with the API key when no token is stored, and saves the token", async () => {
    const store = memoryStore(null);
    const { adapter, calls } = setup(
      { "authentication/getAccessToken": () => ok(TOKENS), "product/query": () => ok(PRODUCT) },
      store,
    );
    await adapter.getProduct("P1");
    await adapter.getProduct("P1");
    expect(calls.map((call) => call.path)).toEqual(["authentication/getAccessToken", "product/query", "product/query"]);
    expect(calls[0]).toMatchObject({ body: { apiKey: "key-1" }, token: null });
    expect(store.saved).toEqual([TOKENS]);
  });

  it("refreshes an expired access token with the refresh token", async () => {
    const expired = { ...TOKENS, accessTokenExpiryDate: "2026-10-01T00:00:00+00:00" };
    const refreshed = { ...TOKENS, accessToken: "access-2" };
    const { adapter, calls } = setup(
      { "authentication/refreshAccessToken": () => ok(refreshed), "product/query": () => ok(PRODUCT) },
      memoryStore(expired),
    );
    await adapter.getProduct("P1");
    expect(calls[0]).toMatchObject({ path: "authentication/refreshAccessToken", body: { refreshToken: "refresh-1" } });
    expect(calls[1].token).toBe("access-2");
  });

  it("logs in again when CJ says the token is invalid", async () => {
    const fresh = { ...TOKENS, accessToken: "access-2" };
    const { adapter, calls } = setup({
      "authentication/getAccessToken": () => ok(fresh),
      "product/query": (call) => (call.token === "access-1" ? fail(1600001, "Invalid API key or access token") : ok(PRODUCT)),
    });
    expect((await adapter.getProduct("P1"))?.externalId).toBe("P1");
    expect(calls.map((call) => call.token)).toEqual(["access-1", null, "access-2"]);
  });

  it("backs off and retries when rate limited, then succeeds", async () => {
    let attempts = 0;
    const { adapter, sleeps } = setup({
      "product/query": () => (++attempts < 3 ? fail(1600200, "Too much request", 429) : ok(PRODUCT)),
    });
    expect((await adapter.getProduct("P1"))?.title).toBe("Custom Photo Projection Necklace");
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] / 2);
  });

  it("retries server errors with a non-JSON body", async () => {
    let attempts = 0;
    const { adapter } = setup({
      "product/query": () => (++attempts < 2 ? { raw: "<html>Bad Gateway</html>", status: 502 } : ok(PRODUCT)),
    });
    expect(await adapter.getProduct("P1")).not.toBeNull();
    expect(attempts).toBe(2);
  });

  it("does not retry errors that will not go away", async () => {
    let attempts = 0;
    const { client } = setup({
      "product/query": () => {
        attempts++;
        return fail(1600201, "Quota has been used up");
      },
    });
    await expect(
      client.request({ method: "GET", path: "product/query" }, z.unknown()),
    ).rejects.toBeInstanceOf(CjApiError);
    expect(attempts).toBe(1);
  });
});

describe("CjSupplierAdapter", () => {
  it("searches products and takes the lowest price of a range", async () => {
    const { adapter, calls } = setup({
      "product/listV2": () =>
        ok({
          pageNumber: 1,
          content: [
            {
              productList: [
                { id: "P1", nameEn: "Necklace", bigImage: "https://img/1.png", sellPrice: "11.85", nowPrice: "9.50-12.00", threeCategoryName: "Necklaces" },
                { id: "P2", nameEn: "Ring", bigImage: "https://img/2.png", sellPrice: "3.20", nowPrice: null },
                { id: "P3", nameEn: "No price", bigImage: "https://img/3.png", sellPrice: null, nowPrice: null },
              ],
            },
          ],
        }),
    });
    const results = await adapter.searchProducts({ keyword: "photo necklace", page: 2, pageSize: 50 });
    expect(calls[0].query).toEqual({ keyWord: "photo necklace", page: "2", size: "50" });
    expect(results).toEqual([
      { externalId: "P1", title: "Necklace", category: "Necklaces", mainImageUrl: "https://img/1.png", fromCostCents: 950 },
      { externalId: "P2", title: "Ring", category: null, mainImageUrl: "https://img/2.png", fromCostCents: 320 },
    ]);
  });

  it("asks for CJ's trending list when searching trending products", async () => {
    const { adapter, calls } = setup({ "product/listV2": () => ok({ content: [] }) });
    expect(await adapter.searchProducts({ keyword: "necklace", trending: true })).toEqual([]);
    expect(calls[0].query).toMatchObject({ keyWord: "necklace", productFlag: "0" });
  });

  it("maps a product: plain-text description, personalization flag, every photo and the description's pictures", async () => {
    const { adapter } = setup({ "product/query": () => ok(PRODUCT) });
    expect(await adapter.getProduct("P1")).toEqual({
      externalId: "P1",
      title: "Custom Photo Projection Necklace",
      description: "Heart pendant & chain\nMaterial: copper\nLength: 40+5cm",
      category: "Jewelry & Watches > Necklaces",
      isPersonalized: true,
      // The main image leads, then the supplier's own order (not the shuffled set).
      imageUrls: ["https://cf.cjdropshipping.com/a.jpg", ...Array.from({ length: 12 }, (_, index) => `https://cf.cjdropshipping.com/${index}.jpg`)],
      detailImageUrls: ["https://cf.cjdropshipping.com/d1.jpg", "https://cf.cjdropshipping.com/d2.jpg"],
    });
  });

  it("treats a product as personalized only when CJ marks it as made to order", async () => {
    const plain = { ...PRODUCT, productType: "ORDINARY_PRODUCT", productProEnSet: ["COMMON"], customizationJson2: null };
    const { adapter } = setup({ "product/query": () => ok(plain) });
    expect((await adapter.getProduct("P1"))?.isPersonalized).toBe(false);

    const podOnly = { ...plain, productProEnSet: ["POD2.0"] };
    const pod = setup({ "product/query": () => ok(podOnly) });
    expect((await pod.adapter.getProduct("P1"))?.isPersonalized).toBe(true);
  });

  it("returns null for a product CJ does not know", async () => {
    const { adapter } = setup({ "product/query": () => fail(1602001, "Product not found") });
    expect(await adapter.getProduct("nope")).toBeNull();
  });

  it("maps variants with their attributes and the warehouses that have stock", async () => {
    const { adapter } = setup({
      "product/query": () => ok(PRODUCT),
      "product/stock/getInventoryByPid": () =>
        ok({
          variantInventories: [
            { vid: "V1", inventory: [{ countryCode: "CN", totalInventory: 900 }, { countryCode: "US", totalInventory: 40 }, { countryCode: "DE", totalInventory: 0 }] },
          ],
        }),
    });
    expect(await adapter.getVariants("P1")).toEqual([
      {
        externalId: "V1",
        productExternalId: "P1",
        sku: "CJNK001-RG",
        attributes: { color: "Rose Gold", size: "45cm" },
        costCents: 1120,
        currency: "USD",
        warehouses: ["CN", "US"],
        processingDays: 7,
        imageUrl: null,
      },
      {
        externalId: "V2",
        productExternalId: "P1",
        sku: "CJNK001-S",
        // One value for two option names: kept whole rather than mislabelled.
        attributes: { option: "Silver" },
        costCents: 1185,
        currency: "USD",
        warehouses: [],
        processingDays: 7,
        imageUrl: "https://cf.cjdropshipping.com/s.jpg",
      },
    ]);
  });

  const STOCK = [
    { vid: "V1", areaEn: "China Warehouse", countryCode: "CN", storageNum: 900, totalInventoryNum: 900 },
    { vid: "V1", areaEn: "US Warehouse", countryCode: "US", storageNum: 40, totalInventoryNum: 40 },
  ];

  it("reads the price from the variant and the stock from the stock endpoint", async () => {
    const { adapter, calls } = setup({
      // The live variant endpoint returns `inventories: null`.
      "product/variant/queryByVid": () => ok({ ...PRODUCT.variants[0], inventories: null }),
      "product/stock/queryByVid": () => ok(STOCK),
    });
    expect(await adapter.getStockAndPrice("V1")).toEqual({
      variantExternalId: "V1",
      costCents: 1120,
      currency: "USD",
      stockByWarehouse: { CN: 900, US: 40 },
    });
    expect(calls.map((call) => call.path)).toEqual(["product/variant/queryByVid", "product/stock/queryByVid"]);
  });

  it("searches only products stocked in the requested country", async () => {
    const { adapter, calls } = setup({ "product/listV2": () => ok({ content: [] }) });
    await adapter.searchProducts({ keyword: "necklace", stockedIn: "US" });
    expect(calls[0].query).toMatchObject({ keyWord: "necklace", countryCode: "US" });
  });

  it("quotes shipping from every stocked warehouse and drops quotes without a delivery estimate", async () => {
    const { adapter, calls } = setup({
      "product/variant/queryByVid": () => ok({ ...PRODUCT.variants[0], inventories: null }),
      "product/stock/queryByVid": () => ok([...STOCK, { vid: "V1", countryCode: "DE", storageNum: 0, totalInventoryNum: 0 }]),
      "logistic/freightCalculate": (call) => {
        const body = call.body as { startCountryCode: string };
        return ok(
          body.startCountryCode === "US"
            ? [{ logisticName: "USPS+", logisticPrice: 4.9, logisticAging: "3-5" }]
            : [
                { logisticName: "CJPacket Ordinary", logisticPrice: "3.10", logisticAging: "8-14" },
                { logisticName: "Mystery Post", logisticPrice: 1.0, logisticAging: "" },
              ],
        );
      },
    });
    const options = await adapter.getShippingOptions("V1", "US");
    expect(options).toEqual([
      { name: "CJPacket Ordinary", warehouse: "CN", destinationCountry: "US", costCents: 310, deliveryDaysMin: 8, deliveryDaysMax: 14 },
      { name: "USPS+", warehouse: "US", destinationCountry: "US", costCents: 490, deliveryDaysMin: 3, deliveryDaysMax: 5 },
    ]);
    const freightCalls = calls.filter((call) => call.path === "logistic/freightCalculate");
    expect(freightCalls.map((call) => call.body)).toEqual([
      { startCountryCode: "CN", endCountryCode: "US", products: [{ vid: "V1", quantity: 1 }] },
      { startCountryCode: "US", endCountryCode: "US", products: [{ vid: "V1", quantity: 1 }] },
    ]);
  });

  it("creates the order unpaid when it is to be paid by hand", async () => {
    const { adapter, calls } = setup({
      "shopping/order/createOrderV2": () => ok({ orderId: "CJ-1", productAmount: "11.20", postageAmount: 4.9, interceptOrderReasons: [] }),
    });
    await adapter.placeOrder({ ...ORDER_INPUT, payFromBalance: false });
    expect(calls[0].body).toMatchObject({ orderNumber: "dp-order-1", payType: 3 });
  });

  it("places a balance-paid sandbox order with a blind-shipping remark", async () => {
    const { adapter, calls } = setup({
      "shopping/order/createOrderV2": () => ok({ orderId: "CJ-1", productAmount: "11.20", postageAmount: 4.9, interceptOrderReasons: [] }),
    });
    expect(await adapter.placeOrder(ORDER_INPUT)).toEqual({ supplierOrderId: "CJ-1", costCents: 1120, shippingCents: 490 });
    expect(calls[0].body).toMatchObject({
      orderNumber: "dp-order-1",
      shippingCustomerName: "Jane Doe",
      shippingAddress: "1 Main St",
      shippingCity: "Austin",
      shippingProvince: "TX",
      shippingZip: "78701",
      shippingCountryCode: "US",
      shippingCountry: "United States",
      logisticName: "USPS+",
      fromCountryCode: "US",
      payType: 2,
      isSandbox: 1,
      products: [{ vid: "V1", quantity: 1 }],
    });
    expect((calls[0].body as { remark: string }).remark).toMatch(/no invoice/i);
  });

  it("returns the original order when CJ reports a duplicate order number", async () => {
    const { adapter, calls } = setup({
      "shopping/order/createOrderV2": () => fail(1603003, "Order exist, please do not duplicate create"),
      "shopping/order/getOrderDetail": () => ok({ orderId: "CJ-1", orderStatus: "UNSHIPPED", productAmount: 11.2, postageAmount: 4.9 }),
    });
    expect(await adapter.placeOrder(ORDER_INPUT)).toEqual({ supplierOrderId: "CJ-1", costCents: 1120, shippingCents: 490 });
    expect(calls[1].query).toEqual({ orderId: "dp-order-1" });
  });

  it.each([
    [1603102, "Inventory deduction fail", "OUT_OF_STOCK"],
    [1602003, "Variant has been removed from shelves", "OUT_OF_STOCK"],
    [1600300, "Param error", "ADDRESS_INVALID"],
    [1604000, "Balance is insufficient", "INSUFFICIENT_BALANCE"],
    [1605001, "Logistic invalid", "SHIPPING_UNAVAILABLE"],
    [1603000, "Order create fail", "UNKNOWN"],
  ])("maps CJ order error %d (%s) to %s", async (code, message, expected) => {
    const { adapter } = setup({ "shopping/order/createOrderV2": () => fail(code, message) });
    await expect(adapter.placeOrder(ORDER_INPUT)).rejects.toMatchObject({ name: "SupplierError", code: expected });
  });

  it("reports an order CJ is holding instead of treating it as placed", async () => {
    const { adapter } = setup({
      "shopping/order/createOrderV2": () =>
        ok({ orderId: "CJ-2", productAmount: 11.2, postageAmount: 4.9, interceptOrderReasons: [{ code: 1001, message: "Address needs review" }] }),
    });
    await expect(adapter.placeOrder(ORDER_INPUT)).rejects.toMatchObject({
      code: "ORDER_HELD",
      message: expect.stringContaining("CJ-2"),
    });
  });

  it("reports a pending order without tracking", async () => {
    const { adapter, calls } = setup({
      "shopping/order/getOrderDetail": () =>
        ok({ orderId: "CJ-1", orderStatus: "UNSHIPPED", logisticName: "USPS+", trackNumber: null, createDate: "2027-02-03 12:00:00", paymentDate: "2027-02-03 12:00:05" }),
    });
    expect(await adapter.getTracking("CJ-1")).toEqual({
      supplierOrderId: "CJ-1",
      status: "PENDING",
      trackingNumber: null,
      carrier: "USPS+",
      events: [
        { status: "CREATED", description: "Order created at CJ", location: null, occurredAt: new Date("2027-02-03T12:00:00Z") },
        { status: "PAID", description: "Order paid", location: null, occurredAt: new Date("2027-02-03T12:00:05Z") },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it("reports a shipped order with its tracking number", async () => {
    const { adapter } = setup({
      "shopping/order/getOrderDetail": () => ok({ orderId: "CJ-1", orderStatus: "SHIPPED", logisticName: "USPS+", trackNumber: "9400111" }),
    });
    expect(await adapter.getTracking("CJ-1")).toMatchObject({ status: "SHIPPED", trackingNumber: "9400111", carrier: "USPS+" });
  });

  it("adds the delivery event once the parcel is delivered", async () => {
    const { adapter } = setup({
      "shopping/order/getOrderDetail": () => ok({ orderId: "CJ-1", orderStatus: "DELIVERED", logisticName: "USPS+", trackNumber: "9400111" }),
      "logistic/trackInfo": () => ok([{ trackingStatus: "Delivered", deliveryTime: "2027-02-08 15:30:00", trackingTo: "US" }]),
    });
    const tracking = await adapter.getTracking("CJ-1");
    expect(tracking.status).toBe("DELIVERED");
    expect(tracking.events).toEqual([
      { status: "DELIVERED", description: "Delivered", location: "US", occurredAt: new Date("2027-02-08T15:30:00Z") },
    ]);
  });

  it("raises NOT_FOUND for an unknown order", async () => {
    const { adapter } = setup({ "shopping/order/getOrderDetail": () => fail(1603100, "Order not found") });
    await expect(adapter.getTracking("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
