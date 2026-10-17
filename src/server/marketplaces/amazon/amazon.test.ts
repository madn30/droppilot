import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../http/rate-limiter";
import type { ListingDraft } from "../types";
import { AmazonAdapter } from "./amazon-adapter";
import { SpApiClient } from "./client";

// Request and response shapes follow Amazon's published SP-API models
// (Catalog Items 2022-04-01, Product Pricing v0, Listings Items 2021-08-01, Orders v0, Tokens, Reports).

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  token: string | null;
}
type Reply = { status?: number; body?: unknown };
type Handler = (call: Call) => Reply;

const NOW = new Date("2027-02-03T16:00:00Z");
const MARKETPLACE = "ATVPDKIKX0DER";

function setup(handlers: Record<string, Handler>, reportDownload?: () => Response) {
  const calls: Call[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const sleeps: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === "api.amazon.com") {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ access_token: `access-${tokenRequests.length}`, expires_in: 3600, token_type: "bearer" }));
    }
    if (url.host === "reports.example.com") {
      if (!reportDownload) throw new Error("Unexpected report download");
      return reportDownload();
    }
    const call: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      token: new Headers(init?.headers).get("x-amz-access-token"),
    };
    calls.push(call);
    const handler = handlers[`${call.method} ${call.path}`];
    if (!handler) throw new Error(`Unexpected SP-API call: ${call.method} ${call.path}`);
    const reply = handler(call);
    const status = reply.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), { status });
  };
  const client = new SpApiClient({
    clientId: "lwa-id",
    clientSecret: "lwa-secret",
    refreshToken: "lwa-refresh",
    region: "na",
    fetch: fetchImpl,
    rateLimiter: new RateLimiter(0),
    sleep: async () => undefined,
    now: () => NOW.getTime(),
  });
  const adapter = new AmazonAdapter(client, { sellerId: "A1SELLER", fetch: fetchImpl, sleep: async (ms) => void sleeps.push(ms), now: () => NOW });
  return { calls, tokenRequests, sleeps, adapter };
}

const LISTING_PATH = "/listings/2021-08-01/items/A1SELLER/DP-CJNK001-RG";

const DRAFT: ListingDraft = {
  sku: "DP-CJNK001-RG",
  title: "Custom Photo Projection Necklace",
  description: "A necklace with your photo inside.\n- Material: copper\n- Color: rose gold",
  priceCents: 2489,
  quantity: 5,
  imageUrls: ["https://cdn/1.jpg", "https://cdn/2.jpg", "https://cdn/3.jpg"],
  detailImageUrls: [],
  itemSpecifics: { Material: "copper" },
  handlingDays: 2,
  deliveryDaysMax: 5,
};

describe("SP-API authentication", () => {
  it("exchanges the refresh token for an access token once and sends it on every call", async () => {
    const { adapter, calls, tokenRequests } = setup({ "GET /catalog/2022-04-01/items": () => ({ body: { numberOfResults: 0, items: [] } }) });
    await adapter.searchByKeyword("necklace", 10);
    await adapter.searchByKeyword("necklace", 10);
    expect(tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(tokenRequests[0])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "lwa-refresh",
      client_id: "lwa-id",
      client_secret: "lwa-secret",
    });
    expect(calls.map((call) => call.token)).toEqual(["access-1", "access-1"]);
  });

  it("gets a new token once when Amazon rejects the current one, and retries throttled calls", async () => {
    let attempts = 0;
    const { adapter, tokenRequests } = setup({
      "GET /catalog/2022-04-01/items": () => {
        attempts++;
        if (attempts === 1) return { status: 403, body: { errors: [{ code: "Unauthorized", message: "Access token expired" }] } };
        if (attempts === 2) return { status: 429, body: { errors: [{ code: "QuotaExceeded", message: "You exceeded your quota" }] } };
        return { body: { numberOfResults: 0, items: [] } };
      },
    });
    expect(await adapter.searchByKeyword("necklace", 10)).toEqual([]);
    expect(attempts).toBe(3);
    expect(tokenRequests).toHaveLength(2);
  });

  it("surfaces Amazon's error message", async () => {
    const { adapter } = setup({
      "GET /catalog/2022-04-01/items": () => ({ status: 400, body: { errors: [{ code: "InvalidInput", message: "keywords is required" }] } }),
    });
    await expect(adapter.searchByKeyword("", 10)).rejects.toThrow(/keywords is required/);
  });
});

describe("Amazon competitor search", () => {
  const item = {
    asin: "B0NECKLACE",
    summaries: [{ marketplaceId: MARKETPLACE, itemName: "Custom Photo Projection Necklace for Women", brand: "SomeSeller" }],
    images: [
      {
        marketplaceId: MARKETPLACE,
        images: [
          { variant: "PT01", link: "https://m.media-amazon.com/2.jpg", height: 500, width: 500 },
          { variant: "MAIN", link: "https://m.media-amazon.com/1.jpg", height: 500, width: 500 },
        ],
      },
    ],
    attributes: {
      material: [{ value: "Copper", marketplace_id: MARKETPLACE }],
      item_shape: [{ value: "Heart", marketplace_id: MARKETPLACE }],
      bullet_point: [{ value: "Your photo inside the pendant" }, { value: "45cm chain" }],
      item_dimensions: [{ length: { value: 45, unit: "centimeters" } }],
    },
  };

  it("takes each catalog item's cheapest new offer by total price", async () => {
    const { adapter, calls } = setup({
      "GET /catalog/2022-04-01/items": () => ({ body: { numberOfResults: 2, items: [item, { asin: "B0NOOFFERS", summaries: [{ marketplaceId: MARKETPLACE, itemName: "Unavailable" }] }] } }),
      "GET /products/pricing/v0/items/B0NECKLACE/offers": () => ({
        body: {
          payload: {
            Offers: [
              { ListingPrice: { Amount: 22.99, CurrencyCode: "USD" }, Shipping: { Amount: 4.99, CurrencyCode: "USD" }, IsFulfilledByAmazon: false, ShippingTime: { maximumHours: 48 }, SellerFeedbackRating: { SellerPositiveFeedbackRating: 91, FeedbackCount: 40 } },
              { ListingPrice: { Amount: 24.99, CurrencyCode: "USD" }, Shipping: { Amount: 0, CurrencyCode: "USD" }, IsFulfilledByAmazon: true, ShippingTime: { maximumHours: 0 }, SellerFeedbackRating: { SellerPositiveFeedbackRating: 97, FeedbackCount: 1200 } },
            ],
          },
        },
      }),
      "GET /products/pricing/v0/items/B0NOOFFERS/offers": () => ({ body: { payload: { Offers: [] } } }),
    });
    const candidates = await adapter.searchByKeyword("photo projection necklace", 50);

    expect(calls[0].query).toEqual({
      keywords: "photo projection necklace",
      marketplaceIds: MARKETPLACE,
      includedData: "summaries,images,attributes",
      pageSize: "20",
    });
    expect(calls[1].query).toEqual({ MarketplaceId: MARKETPLACE, ItemCondition: "New" });
    expect(candidates).toEqual([
      {
        marketplace: "AMAZON",
        externalId: "B0NECKLACE",
        title: "Custom Photo Projection Necklace for Women",
        description: "Your photo inside the pendant\n45cm chain",
        url: "https://www.amazon.com/dp/B0NECKLACE",
        // $24.99 delivered beats $22.99 + $4.99.
        priceCents: 2499,
        shippingCents: 0,
        currency: "USD",
        deliveryDays: 2,
        sellerRating: 97,
        soldCount: null,
        imageUrls: ["https://m.media-amazon.com/1.jpg", "https://m.media-amazon.com/2.jpg"],
        itemSpecifics: { material: "Copper", item_shape: "Heart", bullet_point: "Your photo inside the pendant" },
      },
    ]);
  });

  it("estimates delivery for seller-fulfilled offers from their handling time", async () => {
    const { adapter } = setup({
      "GET /catalog/2022-04-01/items": () => ({ body: { numberOfResults: 1, items: [item] } }),
      "GET /products/pricing/v0/items/B0NECKLACE/offers": () => ({
        body: { payload: { Offers: [{ ListingPrice: { Amount: 22.99, CurrencyCode: "USD" }, IsFulfilledByAmazon: false, ShippingTime: { maximumHours: 48 } }] } },
      }),
    });
    const [candidate] = await adapter.searchByKeyword("necklace", 10);
    // Two handling days plus an assumed five in transit.
    expect(candidate).toMatchObject({ priceCents: 2299, shippingCents: 0, deliveryDays: 7, sellerRating: null });
  });
});

describe("Amazon candidate ids", () => {
  it("lists ASINs from one catalog call", async () => {
    const { adapter, calls } = setup({
      "GET /catalog/2022-04-01/items": () => ({ body: { numberOfResults: 2, items: [{ asin: "B0A" }, { asin: "B0B" }] } }),
    });
    expect(await adapter.listCandidateIds("necklace", 50)).toEqual(["B0A", "B0B"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].query.includedData).toBe("summaries");
  });
});

describe("Amazon sales rank", () => {
  it("reads the main best-sellers rank from the catalog", async () => {
    const { adapter, calls } = setup({
      "GET /catalog/2022-04-01/items/B0NECKLACE": () => ({
        body: {
          asin: "B0NECKLACE",
          salesRanks: [
            {
              marketplaceId: MARKETPLACE,
              classificationRanks: [{ classificationId: "7192394011", title: "Women's Pendant Necklaces", rank: 412 }],
              displayGroupRanks: [{ websiteDisplayGroup: "fashion_display_on_website", title: "Clothing, Shoes & Jewelry", rank: 21000 }],
            },
          ],
        },
      }),
    });
    expect(await adapter.getSalesRank("B0NECKLACE")).toBe(21000);
    expect(calls[0].query).toEqual({ marketplaceIds: MARKETPLACE, includedData: "salesRanks" });
  });

  it("returns null when Amazon reports no rank", async () => {
    const { adapter } = setup({ "GET /catalog/2022-04-01/items/B0NORANK": () => ({ body: { asin: "B0NORANK", salesRanks: [] } }) });
    expect(await adapter.getSalesRank("B0NORANK")).toBeNull();
  });
});

describe("Amazon listing", () => {
  it("adds an offer to the existing ASIN when the exact product is already in the catalog", async () => {
    const { adapter, calls } = setup({ [`PUT ${LISTING_PATH}`]: () => ({ body: { sku: DRAFT.sku, status: "ACCEPTED", submissionId: "S-1", issues: [] } }) });
    expect(await adapter.publishListing({ ...DRAFT, existingProductId: "B0MOCKNKF1" })).toEqual({ externalId: "B0MOCKNKF1" });

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toEqual({ marketplaceIds: MARKETPLACE });
    expect(calls[0].body).toEqual({
      productType: "PRODUCT",
      requirements: "LISTING_OFFER_ONLY",
      attributes: {
        merchant_suggested_asin: [{ value: "B0MOCKNKF1", marketplace_id: MARKETPLACE }],
        condition_type: [{ value: "new_new", marketplace_id: MARKETPLACE }],
        purchasable_offer: [{ currency: "USD", marketplace_id: MARKETPLACE, our_price: [{ schedule: [{ value_with_tax: 24.89 }] }] }],
        fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 5, lead_time_to_ship_max_days: 2 }],
      },
    });
  });

  it("creates a new unbranded listing with the suggested product type when there is no ASIN to join", async () => {
    const { adapter, calls } = setup({
      "GET /definitions/2020-09-01/productTypes": () => ({ body: { productTypes: [{ name: "NECKLACE", displayName: "Necklace", marketplaceIds: [MARKETPLACE] }], productTypeVersion: "LATEST" } }),
      [`PUT ${LISTING_PATH}`]: () => ({ body: { sku: DRAFT.sku, status: "ACCEPTED", submissionId: "S-2", identifiers: [{ marketplaceId: MARKETPLACE, asin: "B0NEWASIN" }] } }),
    });
    expect(await adapter.publishListing(DRAFT)).toEqual({ externalId: "B0NEWASIN" });

    expect(calls[0].query).toEqual({ itemName: DRAFT.title, marketplaceIds: MARKETPLACE });
    const body = calls[1].body as { productType: string; requirements: string; attributes: Record<string, unknown> };
    expect(body.productType).toBe("NECKLACE");
    expect(body.requirements).toBe("LISTING");
    expect(body.attributes).toMatchObject({
      item_name: [{ value: DRAFT.title, language_tag: "en_US", marketplace_id: MARKETPLACE }],
      brand: [{ value: "Generic", language_tag: "en_US", marketplace_id: MARKETPLACE }],
      supplier_declared_has_product_identifier_exemption: [{ value: true, marketplace_id: MARKETPLACE }],
      bullet_point: [
        { value: "Material: copper", language_tag: "en_US", marketplace_id: MARKETPLACE },
        { value: "Color: rose gold", language_tag: "en_US", marketplace_id: MARKETPLACE },
      ],
      main_product_image_locator: [{ media_location: "https://cdn/1.jpg", marketplace_id: MARKETPLACE }],
      other_product_image_locator_1: [{ media_location: "https://cdn/2.jpg", marketplace_id: MARKETPLACE }],
      other_product_image_locator_2: [{ media_location: "https://cdn/3.jpg", marketplace_id: MARKETPLACE }],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 5, lead_time_to_ship_max_days: 2 }],
    });
  });

  it("fails with Amazon's issues when the submission is invalid", async () => {
    const { adapter } = setup({
      "GET /definitions/2020-09-01/productTypes": () => ({ body: { productTypes: [{ name: "NECKLACE" }] } }),
      [`PUT ${LISTING_PATH}`]: () => ({
        body: {
          sku: DRAFT.sku,
          status: "INVALID",
          submissionId: "S-3",
          issues: [
            { code: "90220", message: "'Country of Origin' is required but not supplied.", severity: "ERROR", categories: ["MISSING_ATTRIBUTE"] },
            { code: "1", message: "Consider adding more images.", severity: "WARNING", categories: [] },
          ],
        },
      }),
    });
    await expect(adapter.publishListing(DRAFT)).rejects.toThrow(/INVALID\): 'Country of Origin' is required but not supplied\.$/);
  });

  it("patches the price, and the quantity while keeping the handling time", async () => {
    const { adapter, calls } = setup({
      [`GET ${LISTING_PATH}`]: () => ({
        body: { sku: DRAFT.sku, attributes: { fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 5, lead_time_to_ship_max_days: 2 }] } },
      }),
      [`PATCH ${LISTING_PATH}`]: () => ({ body: { sku: DRAFT.sku, status: "ACCEPTED", submissionId: "S-4" } }),
    });
    await adapter.updateListing({ externalId: "B0MOCKNKF1", sku: DRAFT.sku }, { priceCents: 2599, quantity: 0 });

    expect(calls[0].query).toEqual({ marketplaceIds: MARKETPLACE, includedData: "attributes" });
    expect(calls[1].body).toEqual({
      productType: "PRODUCT",
      patches: [
        {
          op: "replace",
          path: "/attributes/purchasable_offer",
          value: [{ currency: "USD", marketplace_id: MARKETPLACE, our_price: [{ schedule: [{ value_with_tax: 25.99 }] }] }],
        },
        {
          op: "replace",
          path: "/attributes/fulfillment_availability",
          value: [{ fulfillment_channel_code: "DEFAULT", quantity: 0, lead_time_to_ship_max_days: 2 }],
        },
      ],
    });
  });

  it("ends a listing by deleting the SKU", async () => {
    const { adapter, calls } = setup({ [`DELETE ${LISTING_PATH}`]: () => ({ body: { sku: DRAFT.sku, status: "ACCEPTED", submissionId: "S-5" } }) });
    await adapter.endListing({ externalId: "B0MOCKNKF1", sku: DRAFT.sku });
    expect(calls[0].method).toBe("DELETE");
  });
});

describe("Amazon orders", () => {
  const order = {
    AmazonOrderId: "111-2223334-4445556",
    PurchaseDate: "2027-02-03T15:00:00Z",
    LastUpdateDate: "2027-02-03T15:05:00Z",
    OrderStatus: "Unshipped",
    LatestShipDate: "2027-02-05T07:59:59Z",
    OrderTotal: { CurrencyCode: "USD", Amount: "49.78" },
    ShippingAddress: { Name: "Jane Doe", AddressLine1: "1 Main St", City: "Austin", StateOrRegion: "TX", PostalCode: "78701", CountryCode: "US", Phone: "5125550100" },
  };

  it("reads unshipped seller-fulfilled orders with a restricted data token for the address", async () => {
    const { adapter, calls } = setup({
      "POST /tokens/2021-03-01/restrictedDataToken": () => ({ body: { restrictedDataToken: "RDT-1", expiresIn: 3600 } }),
      "GET /orders/v0/orders": (call) =>
        call.query.NextToken ? { body: { payload: { Orders: [] } } } : { body: { payload: { Orders: [order], NextToken: "page-2" } } },
      "GET /orders/v0/orders/111-2223334-4445556/orderItems": () => ({
        body: {
          payload: {
            AmazonOrderId: order.AmazonOrderId,
            OrderItems: [
              { ASIN: "B0MOCKNKF1", OrderItemId: "70001", SellerSKU: "DP-CJNK001-RG", QuantityOrdered: 2, ItemPrice: { CurrencyCode: "USD", Amount: "49.78" } },
              { ASIN: "B0CANCELLED", OrderItemId: "70002", SellerSKU: "DP-OTHER", QuantityOrdered: 0 },
            ],
          },
        },
      }),
    });
    const orders = await adapter.getOrders(new Date("2027-02-01T00:00:00Z"));

    expect(calls[0].body).toEqual({
      restrictedResources: [{ method: "GET", path: "/orders/v0/orders", dataElements: ["shippingAddress", "buyerInfo"] }],
    });
    expect(calls[1].token).toBe("RDT-1");
    expect(calls[1].query).toEqual({
      MarketplaceIds: MARKETPLACE,
      CreatedAfter: "2027-02-01T00:00:00.000Z",
      OrderStatuses: "Unshipped,PartiallyShipped",
      FulfillmentChannels: "MFN",
    });
    // Order items carry no buyer data and use the ordinary access token.
    expect(calls[2].token).toBe("access-1");
    expect(calls[3].query).toEqual({ MarketplaceIds: MARKETPLACE, NextToken: "page-2" });

    expect(orders).toEqual([
      {
        externalId: "111-2223334-4445556",
        orderedAt: new Date("2027-02-03T15:00:00Z"),
        shipByDate: new Date("2027-02-05T07:59:59Z"),
        buyerName: "Jane Doe",
        shippingAddress: { name: "Jane Doe", line1: "1 Main St", line2: undefined, city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: "5125550100" },
        totalCents: 4978,
        currency: "USD",
        lines: [{ externalLineId: "70001", sku: "DP-CJNK001-RG", quantity: 2, priceCents: 2489 }],
      },
    ]);
  });

  it("never asks for orders newer than Amazon allows", async () => {
    const { adapter, calls } = setup({
      "POST /tokens/2021-03-01/restrictedDataToken": () => ({ body: { restrictedDataToken: "RDT-1" } }),
      "GET /orders/v0/orders": () => ({ body: { payload: { Orders: [] } } }),
    });
    await adapter.getOrders(NOW);
    expect(calls[1].query.CreatedAfter).toBe("2027-02-03T15:57:00.000Z");
  });

  it("confirms shipment with the carrier, tracking number and order items", async () => {
    const { adapter, calls } = setup({ "POST /orders/v0/orders/111-2223334-4445556/shipmentConfirmation": () => ({ status: 204 }) });
    await adapter.uploadTracking("111-2223334-4445556", { trackingNumber: "9400111202555", carrier: "USPS", lines: [{ externalLineId: "70001", quantity: 2 }] });
    expect(calls[0].body).toEqual({
      marketplaceId: MARKETPLACE,
      packageDetail: {
        packageReferenceId: "1",
        carrierCode: "USPS",
        trackingNumber: "9400111202555",
        shipDate: "2027-02-03T16:00:00.000Z",
        orderItems: [{ orderItemId: "70001", quantity: 2 }],
      },
    });
  });
});

describe("Amazon account health", () => {
  const report = {
    performanceMetrics: [
      {
        marketplaceId: MARKETPLACE,
        lateShipmentRate: { status: "GOOD", targetValue: 0.04, rate: 0.012 },
        preFulfillmentCancellationRate: { rate: 0.005 },
        validTrackingRate: { rate: 0.98 },
        orderDefectRate: { afn: { rate: 0 }, mfn: { rate: 0.003 } },
      },
    ],
  };
  const reportHandlers = (statuses: string[]): Record<string, Handler> => ({
    "POST /reports/2021-06-30/reports": () => ({ status: 202, body: { reportId: "R-1" } }),
    "GET /reports/2021-06-30/reports/R-1": () => {
      const status = statuses.shift() ?? "DONE";
      return { body: { reportId: "R-1", reportType: "GET_V2_SELLER_PERFORMANCE_REPORT", createdTime: NOW.toISOString(), processingStatus: status, reportDocumentId: status === "DONE" ? "DOC-1" : undefined } };
    },
    "GET /reports/2021-06-30/documents/DOC-1": () => ({ body: { reportDocumentId: "DOC-1", url: "https://reports.example.com/doc", compressionAlgorithm: "GZIP" } }),
  });

  it("requests the seller performance report, waits for it and reads the rates", async () => {
    const { adapter, calls, sleeps } = setup(reportHandlers(["IN_QUEUE", "IN_PROGRESS"]), () => new Response(gzipSync(JSON.stringify(report))));
    expect(await adapter.getAccountHealth()).toEqual({
      defectRate: 0.003,
      lateShipmentRate: 0.012,
      cancellationRate: 0.005,
      validTrackingRate: 0.98,
      returnRate: null,
    });
    expect(calls[0].body).toEqual({ reportType: "GET_V2_SELLER_PERFORMANCE_REPORT", marketplaceIds: [MARKETPLACE] });
    expect(sleeps).toEqual([10_000, 10_000]);
  });

  it("fails when Amazon cannot produce the report", async () => {
    const { adapter } = setup(reportHandlers(["FATAL"]));
    await expect(adapter.getAccountHealth()).rejects.toThrow(/ended as FATAL/);
  });
});
