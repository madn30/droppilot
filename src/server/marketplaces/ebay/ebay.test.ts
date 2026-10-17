import { describe, expect, it } from "vitest";
import type { AspectFiller } from "../../ai/types";
import { RateLimiter } from "../../http/rate-limiter";
import type { ListingDraft, VariationListingDraft } from "../types";
import { EbayClient } from "./client";
import { EbayAdapter } from "./ebay-adapter";

// Request and response shapes follow eBay's OpenAPI specs for the Browse, Inventory, Account and Taxonomy APIs.

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  /** The query string exactly as sent. */
  search: string;
  body: unknown;
  authorization: string | null;
  headers: Headers;
}
type Reply = { status?: number; body?: unknown };
type Handler = (call: Call) => Reply;

const NOW = new Date("2027-01-10T00:00:00Z");

function setup(handlers: Record<string, Handler>, environment: "sandbox" | "production" = "sandbox", aspectFiller: AspectFiller | null = null) {
  const calls: Call[] = [];
  const hosts: string[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    hosts.push(url.host);
    const headers = new Headers(init?.headers);
    if (url.pathname === "/identity/v1/oauth2/token") {
      const form = new URLSearchParams(String(init?.body));
      tokenRequests.push(form);
      const kind = form.get("grant_type") === "refresh_token" ? "user" : "app";
      return new Response(JSON.stringify({ access_token: `${kind}-token-${tokenRequests.length}`, expires_in: 7200, token_type: "Bearer" }));
    }
    const call: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams),
      search: url.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: headers.get("authorization"),
      headers,
    };
    calls.push(call);
    const handler = handlers[`${call.method} ${call.path}`];
    if (!handler) throw new Error(`Unexpected eBay call: ${call.method} ${call.path}`);
    const reply = handler(call);
    const status = reply.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), { status });
  };
  const client = new EbayClient({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    environment,
    fetch: fetchImpl,
    rateLimiter: new RateLimiter(0),
    sleep: async () => undefined,
    now: () => NOW.getTime(),
  });
  return { calls, hosts, tokenRequests, adapter: new EbayAdapter(client, () => NOW, aspectFiller) };
}

const ITEM = {
  itemId: "v1|1234567890|0",
  title: "Personalized Photo Projection Necklace Heart Pendant",
  description: "<p>Custom photo necklace.</p><ul><li>Copper</li><li>45cm chain</li></ul>",
  price: { value: "26.99", currency: "USD" },
  itemWebUrl: "https://www.ebay.com/itm/1234567890",
  image: { imageUrl: "https://i.ebayimg.com/1.jpg" },
  additionalImages: [{ imageUrl: "https://i.ebayimg.com/2.jpg" }],
  seller: { feedbackPercentage: "98.9", feedbackScore: 1200 },
  shippingOptions: [{ shippingCost: { value: "1.50", currency: "USD" }, maxEstimatedDeliveryDate: "2027-01-16T08:00:00.000Z" }],
  estimatedAvailabilities: [{ estimatedSoldQuantity: 327 }],
  localizedAspects: [
    { type: "STRING", name: "Material", value: "Copper" },
    { type: "STRING", name: "Shape", value: "Heart" },
  ],
};

const SELLER_SETUP: Record<string, Handler> = {
  "GET /sell/account/v1/fulfillment_policy": () => ({
    body: {
      fulfillmentPolicies: [
        { fulfillmentPolicyId: "FP-5", handlingTime: { value: 5, unit: "DAY" } },
        { fulfillmentPolicyId: "FP-1", handlingTime: { value: 1, unit: "DAY" } },
        { fulfillmentPolicyId: "FP-3", handlingTime: { value: 3, unit: "DAY" } },
      ],
    },
  }),
  "GET /sell/account/v1/payment_policy": () => ({ body: { paymentPolicies: [{ paymentPolicyId: "PP-1" }] } }),
  "GET /sell/account/v1/return_policy": () => ({ body: { returnPolicies: [{ returnPolicyId: "RP-1" }] } }),
  "GET /sell/inventory/v1/location": () => ({ body: { locations: [{ merchantLocationKey: "main", merchantLocationStatus: "ENABLED" }] } }),
  "GET /commerce/taxonomy/v1/category_tree/0/get_category_suggestions": () => ({
    body: { categorySuggestions: [{ category: { categoryId: "164329", categoryName: "Necklaces & Pendants" } }] },
  }),
  "GET /commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category": () => ({ body: { aspects: [] } }),
};

const DRAFT: ListingDraft = {
  sku: "DP-CJNK001-RG",
  title: "Custom Photo Projection Necklace Valentines Day Gift",
  description: "A necklace.",
  priceCents: 2489,
  quantity: 5,
  imageUrls: ["https://cdn/1.jpg", "https://cdn/2.jpg"],
  detailImageUrls: ["https://cdn/size-chart.jpg"],
  itemSpecifics: { Material: "copper", Shape: "heart" },
  handlingDays: 2,
  deliveryDaysMax: 5,
};

describe("eBay OAuth", () => {
  it("uses an application token for Browse and a refreshed user token for selling, and caches both", async () => {
    const { adapter, calls, tokenRequests, hosts } = setup({
      "GET /buy/browse/v1/item_summary/search": () => ({ body: { itemSummaries: [] } }),
      "GET /sell/inventory/v1/offer": () => ({ body: { offers: [{ offerId: "O-1" }] } }),
      "POST /sell/inventory/v1/bulk_update_price_quantity": () => ({ body: { responses: [{ statusCode: 200 }] } }),
    });
    await adapter.searchByKeyword("necklace", 10);
    await adapter.searchByKeyword("necklace", 10);
    await adapter.updateListing({ externalId: "1", sku: "DP-1" }, { quantity: 0 });

    expect(tokenRequests.map((form) => form.get("grant_type"))).toEqual(["client_credentials", "refresh_token"]);
    expect(tokenRequests[1].get("refresh_token")).toBe("refresh-token");
    expect(tokenRequests[1].get("scope")).toContain("sell.inventory");
    expect(calls[0].authorization).toBe("Bearer app-token-1");
    expect(calls[2].authorization).toBe("Bearer user-token-2");
    expect(calls[0].headers.get("x-ebay-c-marketplace-id")).toBe("EBAY_US");
    expect(new Set(hosts)).toEqual(new Set(["api.sandbox.ebay.com"]));
  });

  it("talks to the production host when configured", async () => {
    const { adapter, hosts } = setup({ "GET /buy/browse/v1/item_summary/search": () => ({ body: {} }) }, "production");
    await adapter.searchByKeyword("necklace", 10);
    expect(new Set(hosts)).toEqual(new Set(["api.ebay.com"]));
  });

  it("gets a fresh token once when eBay says the token is invalid", async () => {
    let attempts = 0;
    const { adapter, tokenRequests } = setup({
      "GET /buy/browse/v1/item_summary/search": () =>
        ++attempts === 1 ? { status: 401, body: { errors: [{ errorId: 1001, message: "Invalid access token" }] } } : { body: {} },
    });
    expect(await adapter.searchByKeyword("necklace", 10)).toEqual([]);
    expect(tokenRequests).toHaveLength(2);
  });

  it("retries rate limits and surfaces eBay's error text otherwise", async () => {
    let attempts = 0;
    const limited = setup({ "GET /buy/browse/v1/item_summary/search": () => (++attempts < 3 ? { status: 429 } : { body: {} }) });
    expect(await limited.adapter.searchByKeyword("necklace", 10)).toEqual([]);
    expect(attempts).toBe(3);

    const failing = setup({
      "GET /buy/browse/v1/item_summary/search": () => ({ status: 400, body: { errors: [{ errorId: 12001, longMessage: "The call must have a valid 'q' parameter." }] } }),
    });
    await expect(failing.adapter.searchByKeyword("", 10)).rejects.toThrow(/valid 'q' parameter/);
  });
});

describe("eBay competitor search", () => {
  it("searches fixed-price new items and loads each item's details", async () => {
    const { adapter, calls } = setup({
      "GET /buy/browse/v1/item_summary/search": () => ({ body: { itemSummaries: [{ itemId: ITEM.itemId }, { itemId: "v1|gone|0" }, { itemId: "v1|gbp|0" }] } }),
      [`GET /buy/browse/v1/item/${ITEM.itemId}`]: () => ({ body: ITEM }),
      "GET /buy/browse/v1/item/v1|gone|0": () => ({ status: 404, body: { errors: [{ errorId: 11001, message: "Not found" }] } }),
      "GET /buy/browse/v1/item/v1|gbp|0": () => ({ body: { ...ITEM, itemId: "v1|gbp|0", price: { value: "20.00", currency: "GBP" } } }),
    });
    const candidates = await adapter.searchByKeyword("photo projection necklace", 25);

    expect(calls[0].query).toEqual({ q: "photo projection necklace", limit: "25", filter: "buyingOptions:{FIXED_PRICE},conditions:{NEW}" });
    expect(candidates).toEqual([
      {
        marketplace: "EBAY",
        externalId: "v1|1234567890|0",
        title: "Personalized Photo Projection Necklace Heart Pendant",
        description: "Custom photo necklace.\nCopper\n45cm chain",
        url: "https://www.ebay.com/itm/1234567890",
        priceCents: 2699,
        shippingCents: 150,
        currency: "USD",
        // Delivered by Jan 16, six and a bit days after "now".
        deliveryDays: 7,
        sellerRating: 98.9,
        soldCount: 327,
        imageUrls: ["https://i.ebayimg.com/1.jpg", "https://i.ebayimg.com/2.jpg"],
        itemSpecifics: { Material: "Copper", Shape: "Heart" },
        isVariation: false,
      },
    ]);
  });

  it("searches by image with the picture as base64", async () => {
    const { adapter, calls } = setup({
      "POST /buy/browse/v1/item_summary/search_by_image": () => ({ body: { itemSummaries: [{ itemId: ITEM.itemId }] } }),
      [`GET /buy/browse/v1/item/${ITEM.itemId}`]: () => ({ body: { ...ITEM, shippingOptions: undefined, seller: undefined, estimatedAvailabilities: undefined } }),
    });
    const [candidate] = await adapter.searchByImage(new Uint8Array([1, 2, 3]), 10);
    expect(calls[0].body).toEqual({ image: "AQID" });
    expect(calls[0].query.limit).toBe("10");
    expect(candidate).toMatchObject({ shippingCents: 0, deliveryDays: null, sellerRating: null, soldCount: null });
  });

  it("finds no image candidates once the image search call limit is used up, after retrying", async () => {
    const { adapter, calls } = setup({
      "POST /buy/browse/v1/item_summary/search_by_image": () => ({
        status: 429,
        body: { errors: [{ errorId: 2001, message: "The request limit has been reached for the resource." }] },
      }),
    });
    expect(await adapter.searchByImage(new Uint8Array([1, 2, 3]), 10)).toEqual([]);
    expect(calls).toHaveLength(4);
  });

  it("still fails an image search for other errors", async () => {
    const { adapter } = setup({
      "POST /buy/browse/v1/item_summary/search_by_image": () => ({ status: 400, body: { errors: [{ errorId: 12001, message: "Bad image" }] } }),
    });
    await expect(adapter.searchByImage(new Uint8Array([1, 2, 3]), 10)).rejects.toThrow(/HTTP 400/);
  });
});

describe("eBay Marketplace Insights", () => {
  it("reads 90-day sold quantities with its own restricted-scope token", async () => {
    const { adapter, calls, tokenRequests } = setup({
      "GET /buy/marketplace_insights/v1_beta/item_sales/search": () => ({
        body: {
          itemSales: [
            { itemId: "v1|1234567890|0", title: "Necklace", totalSoldQuantity: 327, lastSoldPrice: { value: "26.99", currency: "USD" } },
            { itemId: "v1|222|0", title: "No count" },
          ],
        },
      }),
    });
    const sold = await adapter.getSoldQuantities("photo projection necklace");
    expect([...sold]).toEqual([["v1|1234567890|0", 327]]);
    expect(calls[0].query).toMatchObject({ q: "photo projection necklace", limit: "200" });
    expect(tokenRequests[0].get("scope")).toBe("https://api.ebay.com/oauth/api_scope/buy.marketplace.insights");
  });

  it("lists candidate ids from one search call, without loading each item", async () => {
    const { adapter, calls } = setup({
      "GET /buy/browse/v1/item_summary/search": () => ({ body: { itemSummaries: [{ itemId: "v1|1|0" }, { itemId: "v1|2|0" }] } }),
    });
    expect(await adapter.listCandidateIds("necklace", 50)).toEqual(["v1|1|0", "v1|2|0"]);
    expect(calls).toHaveLength(1);
  });
});

describe("eBay listing", () => {
  it("creates the inventory item and offer, then publishes, with the tightest policy that covers the handling time", async () => {
    const { adapter, calls } = setup({
      ...SELLER_SETUP,
      "PUT /sell/inventory/v1/inventory_item/DP-CJNK001-RG": () => ({ status: 204 }),
      "GET /sell/inventory/v1/offer": () => ({ status: 404, body: { errors: [{ errorId: 25713, message: "This Offer is not available." }] } }),
      "POST /sell/inventory/v1/offer": () => ({ status: 201, body: { offerId: "O-1" } }),
      "POST /sell/inventory/v1/offer/O-1/publish": () => ({ body: { listingId: "110555000111" } }),
    });
    expect(await adapter.publishListing(DRAFT)).toEqual({ externalId: "110555000111" });

    const item = calls.find((call) => call.method === "PUT");
    expect(item?.body).toEqual({
      availability: { shipToLocationAvailability: { quantity: 5 } },
      condition: "NEW",
      product: {
        title: DRAFT.title,
        description: "A necklace.",
        aspects: { Material: ["copper"], Shape: ["heart"] },
        imageUrls: ["https://cdn/1.jpg", "https://cdn/2.jpg"],
      },
    });
    expect(item?.headers.get("content-language")).toBe("en-US");
    expect(item?.headers.get("accept-language")).toBe("en-US");

    const offer = calls.find((call) => call.method === "POST" && call.path === "/sell/inventory/v1/offer");
    expect(offer?.body).toEqual({
      sku: "DP-CJNK001-RG",
      marketplaceId: "EBAY_US",
      format: "FIXED_PRICE",
      availableQuantity: 5,
      categoryId: "164329",
      // Our text as HTML, followed by the supplier's detail pictures.
      listingDescription: expect.stringMatching(/>A necklace\.<\/p>.*<img src="https:\/\/cdn\/size-chart\.jpg" alt="Custom Photo Projection Necklace Valentines Day Gift".*within 2 business days/),
      // Handling time is 2 days: the 3-day policy, not the 1-day one (unrealistic) or the 5-day one (looser than needed).
      listingPolicies: { fulfillmentPolicyId: "FP-3", paymentPolicyId: "PP-1", returnPolicyId: "RP-1" },
      merchantLocationKey: "main",
      pricingSummary: { price: { value: "24.89", currency: "USD" } },
    });
  });

  it("does not publish twice: an already published offer is returned as is", async () => {
    const { adapter, calls } = setup({
      ...SELLER_SETUP,
      "PUT /sell/inventory/v1/inventory_item/DP-CJNK001-RG": () => ({ status: 204 }),
      "GET /sell/inventory/v1/offer": () => ({ body: { offers: [{ offerId: "O-1", status: "PUBLISHED", listing: { listingId: "110555000111" } }] } }),
    });
    expect(await adapter.publishListing(DRAFT)).toEqual({ externalId: "110555000111" });
    expect(calls.some((call) => call.path.endsWith("/publish"))).toBe(false);
  });

  describe("required item specifics", () => {
    const LAMP_ASPECTS = {
      aspects: [
        { localizedAspectName: "Brand", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" }, aspectValues: [{ localizedValue: "Unbranded" }, { localizedValue: "3M" }] },
        {
          localizedAspectName: "Type",
          aspectConstraint: { aspectRequired: true, aspectMode: "SELECTION_ONLY" },
          aspectValues: [{ localizedValue: "Lamp" }, { localizedValue: "Reading Lamp" }, { localizedValue: "Table Lamp" }],
        },
        { localizedAspectName: "Material", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" }, aspectValues: [] },
        { localizedAspectName: "MPN", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" }, aspectValues: [] },
        { localizedAspectName: "Color", aspectConstraint: { aspectRequired: false, aspectMode: "FREE_TEXT" }, aspectValues: [{ localizedValue: "White" }] },
      ],
    };
    const lampDraft = (title: string): ListingDraft => ({ ...DRAFT, title, description: "Touch dimmable.", itemSpecifics: { Material: "ABS" } });
    const handlers = {
      ...SELLER_SETUP,
      "GET /commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category": () => ({ body: LAMP_ASPECTS }),
      "PUT /sell/inventory/v1/inventory_item/DP-CJNK001-RG": () => ({ status: 204 }),
      "GET /sell/inventory/v1/offer": () => ({ status: 404, body: {} }),
      "POST /sell/inventory/v1/offer": () => ({ status: 201, body: { offerId: "O-1" } }),
      "POST /sell/inventory/v1/offer/O-1/publish": () => ({ body: { listingId: "110555000111" } }),
    };
    const sentAspects = (calls: { method: string; path: string; body: unknown }[]) =>
      (calls.find((call) => call.method === "PUT" && call.path.startsWith("/sell/inventory/v1/inventory_item/"))?.body as { product: { aspects: unknown } })
        .product.aspects;

    it("sends Unbranded as the brand, no part number, and the longest allowed value the title names, keeping the draft's own specifics", async () => {
      const { adapter, calls } = setup(handlers);
      await adapter.publishListing(lampDraft("Foldable LED Reading Lamp, White"));
      expect(sentAspects(calls)).toEqual({ Material: ["ABS"], Brand: ["Unbranded"], Type: ["Reading Lamp"], MPN: ["Does Not Apply"] });
    });

    it("asks the AI only for what the text does not answer", async () => {
      const asked: string[][] = [];
      const filler: AspectFiller = {
        fillAspects: async (input) => {
          asked.push(input.aspects.map((aspect) => aspect.name));
          return { Type: "Reading Lamp" };
        },
      };
      const { adapter, calls } = setup(handlers, "sandbox", filler);
      await adapter.publishListing(lampDraft("Foldable LED Night Light Lantern"));
      expect(asked).toEqual([["Type"]]);
      expect(sentAspects(calls)).toMatchObject({ Brand: ["Unbranded"], Type: ["Reading Lamp"] });
    });

    it("refuses to publish, naming the item specifics nobody could answer", async () => {
      const { adapter, calls } = setup(handlers, "sandbox", { fillAspects: async () => ({}) });
      await expect(adapter.publishListing(lampDraft("Foldable LED Night Light Lantern"))).rejects.toThrow(
        "eBay category 164329 requires item specifics this listing has no value for: Type",
      );
      expect(calls.some((call) => call.method === "PUT")).toBe(false);
    });

    it("does not take a value that only appears inside another word", async () => {
      const { adapter } = setup(handlers);
      // "Lamp" must not match "Lampshade".
      await expect(adapter.publishListing(lampDraft("Fabric Lampshade Cover"))).rejects.toThrow(/no value for: Type/);
    });
  });

  describe("with variations", () => {
    const VARIATIONS: VariationListingDraft = {
      groupKey: "DP-P1",
      title: "Foldable LED Reading Lamp",
      description: "Touch dimmable.",
      imageUrls: ["https://cdn/1.jpg"],
      detailImageUrls: [],
      itemSpecifics: { Material: "ABS" },
      handlingDays: 3,
      deliveryDaysMax: 7,
      variations: [
        { sku: "DP-L-White", options: { Color: "White" }, priceCents: 2789, quantity: 5 },
        { sku: "DP-L-Grey", options: { Color: "Grey" }, priceCents: 2989, quantity: 2 },
      ],
    };
    const handlers = {
      ...SELLER_SETUP,
      "GET /commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category": () => ({
        body: {
          aspects: [
            { localizedAspectName: "Brand", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" }, aspectValues: [] },
            { localizedAspectName: "Color", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" }, aspectValues: [] },
          ],
        },
      }),
      "PUT /sell/inventory/v1/inventory_item/DP-L-White": () => ({ status: 204 }),
      "PUT /sell/inventory/v1/inventory_item/DP-L-Grey": () => ({ status: 204 }),
      "PUT /sell/inventory/v1/inventory_item_group/DP-P1": () => ({ status: 204 }),
      "GET /sell/inventory/v1/offer": () => ({ status: 404, body: {} }),
      "POST /sell/inventory/v1/offer": (call: { body: unknown }) => ({ status: 201, body: { offerId: `O-${(call.body as { sku: string }).sku}` } }),
      "POST /sell/inventory/v1/offer/publish_by_inventory_item_group": () => ({ body: { listingId: "110590958190" } }),
    };

    it("creates one item and one offer per variation, groups them, and publishes the group as one listing", async () => {
      const { adapter, calls } = setup(handlers);
      expect(await adapter.publishVariations(VARIATIONS)).toEqual({ externalId: "110590958190" });

      const bodyOf = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path).map((call) => call.body);
      // Color is required by the category but is the buyer's choice, so it is neither asked for nor fixed on the listing.
      expect(bodyOf("PUT", "/sell/inventory/v1/inventory_item/DP-L-Grey")).toMatchObject([
        { availability: { shipToLocationAvailability: { quantity: 2 } }, product: { aspects: { Material: ["ABS"], Brand: ["Unbranded"], Color: ["Grey"] } } },
      ]);
      expect(bodyOf("PUT", "/sell/inventory/v1/inventory_item_group/DP-P1")).toEqual([
        {
          title: "Foldable LED Reading Lamp",
          description: expect.stringContaining(">Touch dimmable.</p>"),
          imageUrls: ["https://cdn/1.jpg"],
          aspects: { Material: ["ABS"], Brand: ["Unbranded"] },
          variantSKUs: ["DP-L-White", "DP-L-Grey"],
          variesBy: { specifications: [{ name: "Color", values: ["White", "Grey"] }] },
        },
      ]);
      expect(bodyOf("POST", "/sell/inventory/v1/offer")).toMatchObject([
        { sku: "DP-L-White", availableQuantity: 5, pricingSummary: { price: { value: "27.89", currency: "USD" } }, listingPolicies: { fulfillmentPolicyId: "FP-3" } },
        { sku: "DP-L-Grey", availableQuantity: 2, pricingSummary: { price: { value: "29.89", currency: "USD" } }, listingPolicies: { fulfillmentPolicyId: "FP-3" } },
      ]);
      expect(bodyOf("POST", "/sell/inventory/v1/offer/publish_by_inventory_item_group")).toEqual([
        { inventoryItemGroupKey: "DP-P1", marketplaceId: "EBAY_US" },
      ]);
      // The group must exist before its offers are published, and the items before the group.
      const order = calls.map((call) => `${call.method} ${call.path}`);
      expect(order.indexOf("PUT /sell/inventory/v1/inventory_item_group/DP-P1")).toBeGreaterThan(order.indexOf("PUT /sell/inventory/v1/inventory_item/DP-L-Grey"));
      expect(order.indexOf("POST /sell/inventory/v1/offer")).toBeGreaterThan(order.indexOf("PUT /sell/inventory/v1/inventory_item_group/DP-P1"));
    });

    it("sends at most 24 photos, and fewer when a long description leaves less room for their URLs", async () => {
      const urls = (name: string, count: number) => Array.from({ length: count }, (_, index) => `https://cdn.example/${name}-${String(index).padStart(2, "0")}.jpg`);
      const groupOf = async (draft: VariationListingDraft) => {
        const { adapter, calls } = setup(handlers);
        await adapter.publishVariations(draft);
        return calls.find((call) => call.path === "/sell/inventory/v1/inventory_item_group/DP-P1")?.body as { imageUrls: string[]; description: string };
      };

      // Each URL is 32 characters. Our template alone is under 4,000 characters, so all 24 photos go.
      const short = await groupOf({ ...VARIATIONS, imageUrls: urls("photo", 49), detailImageUrls: [] });
      expect(short.description.length).toBeLessThanOrEqual(4000);
      expect(short.imageUrls).toHaveLength(24);

      // With the detail pictures the description passes 4,000 characters: photos stop before their URLs exceed 1,250 characters.
      const long = await groupOf({ ...VARIATIONS, imageUrls: urls("photo", 49).map((url) => `${url}?size=${"x".repeat(40)}`), detailImageUrls: urls("detail", 14) });
      expect(long.description.length).toBeGreaterThan(4000);
      expect(long.description.match(/<img /g)).toHaveLength(14);
      // 78 characters per URL: 16 fit, a 17th would make 1,326.
      expect(long.imageUrls).toHaveLength(16);
      expect(long.imageUrls.join("").length).toBeLessThanOrEqual(1250);
    });

    it("refuses a listing with fewer than two variations", async () => {
      const { adapter } = setup(handlers);
      await expect(adapter.publishVariations({ ...VARIATIONS, variations: VARIATIONS.variations.slice(0, 1) })).rejects.toThrow(/at least two variations/);
    });

    it("ends the whole listing through its group, and changes its title on the group", async () => {
      const stored = { title: "Old", description: "Touch dimmable.", variantSKUs: ["DP-L-White", "DP-L-Grey"] };
      const { adapter, calls } = setup({
        "POST /sell/inventory/v1/offer/withdraw_by_inventory_item_group": () => ({ body: { listingId: "110590958190" } }),
        "GET /sell/inventory/v1/inventory_item_group/DP-P1": () => ({ body: stored }),
        "PUT /sell/inventory/v1/inventory_item_group/DP-P1": () => ({ status: 204 }),
      });
      const ref = { externalId: "110590958190", sku: "DP-L-White", groupKey: "DP-P1" };
      await adapter.updateListing(ref, { title: "New Title" });
      await adapter.endListing(ref);
      expect(calls.map((call) => [call.method, call.path, call.body])).toEqual([
        ["GET", "/sell/inventory/v1/inventory_item_group/DP-P1", undefined],
        ["PUT", "/sell/inventory/v1/inventory_item_group/DP-P1", { ...stored, title: "New Title" }],
        ["POST", "/sell/inventory/v1/offer/withdraw_by_inventory_item_group", { inventoryItemGroupKey: "DP-P1", marketplaceId: "EBAY_US" }],
      ]);
    });
  });

  it("reports eBay's own reason for a policy refusal, not only the generic message", async () => {
    const { adapter } = setup({
      ...SELLER_SETUP,
      "PUT /sell/inventory/v1/inventory_item/DP-CJNK001-RG": () => ({ status: 204 }),
      "GET /sell/inventory/v1/offer": () => ({ status: 404, body: {} }),
      "POST /sell/inventory/v1/offer": () => ({ status: 201, body: { offerId: "O-1" } }),
      "POST /sell/inventory/v1/offer/O-1/publish": () => ({
        status: 400,
        body: {
          errors: [
            {
              errorId: 25019,
              message: "Cannot revise listing. The listing or seller may be in violation of eBay policy.",
              parameters: [
                { name: "0", value: "It appears you’re listing a forward-deployed item in a country different from your registered address. See our <a href=https://export.ebay.com/x>Overseas Warehouse Block Policy</a>.<font size=1>{e300617-1x}</font>" },
                { name: "2", value: "SRM_HIS_WH_Location_Mismatch_Inventory_Block" },
              ],
            },
          ],
        },
      }),
    });
    await expect(adapter.publishListing(DRAFT)).rejects.toThrow(
      "violation of eBay policy. Reason: It appears you’re listing a forward-deployed item in a country different from your registered address. See our Overseas Warehouse Block Policy.",
    );
  });

  it("looks up the offer of a SKU with a space using %20, not +", async () => {
    const { adapter, calls } = setup({
      "GET /sell/inventory/v1/offer": () => ({ body: { offers: [{ offerId: "O-1" }] } }),
      "POST /sell/inventory/v1/bulk_update_price_quantity": () => ({ body: { responses: [{ statusCode: 200 }] } }),
    });
    await adapter.updateListing({ externalId: "110555000111", sku: "DP-CJ1-White Opp" }, { priceCents: 1189 });
    const lookup = calls.find((call) => call.method === "GET" && call.path === "/sell/inventory/v1/offer");
    expect(lookup?.search).toContain("sku=DP-CJ1-White%20Opp");
  });

  it("updates and publishes an offer that exists but was never published", async () => {
    const { adapter, calls } = setup({
      ...SELLER_SETUP,
      "PUT /sell/inventory/v1/inventory_item/DP-CJNK001-RG": () => ({ status: 204 }),
      "GET /sell/inventory/v1/offer": () => ({ body: { offers: [{ offerId: "O-7", status: "UNPUBLISHED" }] } }),
      "PUT /sell/inventory/v1/offer/O-7": () => ({ status: 204 }),
      "POST /sell/inventory/v1/offer/O-7/publish": () => ({ body: { listingId: "110555000222" } }),
    });
    expect(await adapter.publishListing(DRAFT)).toEqual({ externalId: "110555000222" });
    expect(calls.filter((call) => call.method === "POST" && call.path === "/sell/inventory/v1/offer")).toHaveLength(0);
  });

  it("refuses to list when no policy allows a realistic handling time", async () => {
    const { adapter, calls } = setup(SELLER_SETUP);
    await expect(adapter.publishListing({ ...DRAFT, handlingDays: 7 })).rejects.toThrow(/handling time of at least 7 days/);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("explains what the account is missing", async () => {
    const { adapter } = setup({
      ...SELLER_SETUP,
      "GET /sell/account/v1/return_policy": () => ({ body: { total: 0 } }),
      "GET /sell/inventory/v1/location": () => ({ body: { locations: [] } }),
    });
    await expect(adapter.publishListing(DRAFT)).rejects.toThrow(/needs: a return policy, an inventory location/);
  });

  it("updates price and quantity through the SKU's offer", async () => {
    const { adapter, calls } = setup({
      "GET /sell/inventory/v1/offer": () => ({ body: { offers: [{ offerId: "O-1", status: "PUBLISHED" }] } }),
      "POST /sell/inventory/v1/bulk_update_price_quantity": () => ({ body: { responses: [{ statusCode: 200, sku: "DP-1", offerId: "O-1" }] } }),
    });
    await adapter.updateListing({ externalId: "110555000111", sku: "DP-1" }, { priceCents: 2599, quantity: 3 });
    expect(calls[1].body).toEqual({
      requests: [
        {
          sku: "DP-1",
          shipToLocationAvailability: { quantity: 3 },
          offers: [{ offerId: "O-1", availableQuantity: 3, price: { value: "25.99", currency: "USD" } }],
        },
      ],
    });

    await adapter.updateListing({ externalId: "110555000111", sku: "DP-1" }, { priceCents: 2489 });
    expect(calls[3].body).toEqual({ requests: [{ sku: "DP-1", offers: [{ offerId: "O-1", price: { value: "24.89", currency: "USD" } }] }] });
  });

  it("fails when eBay rejects an individual update inside a 200 response", async () => {
    const { adapter } = setup({
      "GET /sell/inventory/v1/offer": () => ({ body: { offers: [{ offerId: "O-1" }] } }),
      "POST /sell/inventory/v1/bulk_update_price_quantity": () => ({
        body: { responses: [{ statusCode: 400, errors: [{ errorId: 25002, message: "Price is below the minimum." }] }] },
      }),
    });
    await expect(adapter.updateListing({ externalId: "1", sku: "DP-1" }, { priceCents: 1 })).rejects.toThrow(/below the minimum/);
  });

  it("changes the title by rewriting the inventory item, keeping everything else", async () => {
    const stored = { availability: { shipToLocationAvailability: { quantity: 5 } }, condition: "NEW", product: { title: "Old Title", description: "A necklace.", imageUrls: ["https://cdn/1.jpg"] } };
    const { adapter, calls } = setup({
      "GET /sell/inventory/v1/inventory_item/DP-1": () => ({ body: stored }),
      "PUT /sell/inventory/v1/inventory_item/DP-1": () => ({ status: 204 }),
    });
    await adapter.updateListing({ externalId: "1", sku: "DP-1" }, { title: "Custom Photo Projection Necklace Mothers Day Gift" });
    expect(calls[1].body).toEqual({ ...stored, product: { ...stored.product, title: "Custom Photo Projection Necklace Mothers Day Gift" } });
    expect(calls).toHaveLength(2);
  });

  it("ends a listing by withdrawing its offer", async () => {
    const { adapter, calls } = setup({
      "GET /sell/inventory/v1/offer": () => ({ body: { offers: [{ offerId: "O-1" }] } }),
      "POST /sell/inventory/v1/offer/O-1/withdraw": () => ({ body: { listingId: "110555000111" } }),
    });
    await adapter.endListing({ externalId: "110555000111", sku: "DP-1" });
    expect(calls.at(-1)?.path).toBe("/sell/inventory/v1/offer/O-1/withdraw");
  });
});

describe("eBay orders", () => {
  const ORDER = {
    orderId: "12-34567-89012",
    creationDate: "2027-02-03T15:04:05.000Z",
    orderPaymentStatus: "PAID",
    orderFulfillmentStatus: "NOT_STARTED",
    buyer: { username: "buyer_jane" },
    pricingSummary: { total: { value: "49.78", currency: "USD" } },
    fulfillmentStartInstructions: [
      {
        shippingStep: {
          shipTo: {
            fullName: "Jane Doe",
            primaryPhone: { phoneNumber: "5125550100" },
            contactAddress: { addressLine1: "1 Main St", addressLine2: "Apt 4", city: "Austin", stateOrProvince: "TX", postalCode: "78701", countryCode: "US" },
          },
        },
      },
    ],
    lineItems: [
      {
        lineItemId: "10000000001",
        sku: "DP-CJNK001-RG",
        quantity: 2,
        lineItemCost: { value: "49.78", currency: "USD" },
        lineItemFulfillmentInstructions: { shipByDate: "2027-02-05T07:59:59.000Z" },
      },
      { lineItemId: "10000000002", quantity: 1, lineItemCost: { value: "5.00", currency: "USD" } },
    ],
  };

  it("reads paid orders created since the given time, with unit prices and the ship-to address", async () => {
    const { adapter, calls } = setup({
      "GET /sell/fulfillment/v1/order": () => ({ body: { orders: [ORDER, { ...ORDER, orderId: "unpaid", orderPaymentStatus: "PENDING" }] } }),
    });
    const orders = await adapter.getOrders(new Date("2027-02-01T00:00:00Z"));

    expect(calls[0].query).toEqual({ filter: "creationdate:[2027-02-01T00:00:00.000Z..]", limit: "200", offset: "0" });
    expect(orders).toEqual([
      {
        externalId: "12-34567-89012",
        orderedAt: new Date("2027-02-03T15:04:05.000Z"),
        shipByDate: new Date("2027-02-05T07:59:59.000Z"),
        buyerName: "Jane Doe",
        buyerUsername: "buyer_jane",
        shippingAddress: { name: "Jane Doe", line1: "1 Main St", line2: "Apt 4", city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: "5125550100" },
        totalCents: 4978,
        currency: "USD",
        // The line without a SKU was not listed by this system and is left out.
        lines: [{ externalLineId: "10000000001", sku: "DP-CJNK001-RG", quantity: 2, priceCents: 2489 }],
      },
    ]);
  });

  it("pages through large result sets", async () => {
    const page = (count: number) => ({ body: { orders: Array.from({ length: count }, (_, index) => ({ ...ORDER, orderId: `O-${index}` })) } });
    const { adapter, calls } = setup({ "GET /sell/fulfillment/v1/order": (call) => (call.query.offset === "0" ? page(200) : page(3)) });
    expect(await adapter.getOrders(new Date("2027-02-01T00:00:00Z"))).toHaveLength(203);
    expect(calls.map((call) => call.query.offset)).toEqual(["0", "200"]);
  });

  it("uploads tracking as a shipping fulfillment for the order's lines", async () => {
    const { adapter, calls } = setup({ "POST /sell/fulfillment/v1/order/12-34567-89012/shipping_fulfillment": () => ({ status: 201 }) });
    await adapter.uploadTracking("12-34567-89012", {
      trackingNumber: "9400 1112-0255",
      carrier: "USPS",
      lines: [{ externalLineId: "10000000001", quantity: 2 }],
    });
    expect(calls[0].body).toEqual({
      lineItems: [{ lineItemId: "10000000001", quantity: 2 }],
      shippedDate: "2027-01-10T00:00:00.000Z",
      shippingCarrierCode: "USPS",
      trackingNumber: "940011120255",
    });
  });
});

describe("eBay account health", () => {
  it("reads the current US seller standards as fractions", async () => {
    const { adapter } = setup({
      "GET /sell/analytics/v1/seller_standards_profile": () => ({
        body: {
          standardsProfiles: [
            { program: "PROGRAM_GLOBAL", cycle: { cycleType: "CURRENT" }, metrics: [{ metricKey: "DEFECTIVE_TRANSACTION_RATE", value: "9.99" }] },
            {
              program: "PROGRAM_US",
              cycle: { cycleType: "CURRENT" },
              standardsLevel: "ABOVE_STANDARD",
              metrics: [
                { metricKey: "DEFECTIVE_TRANSACTION_RATE", value: { value: 0.5, numerator: 2, denominator: 400 } },
                { metricKey: "SHIPPING_MISS_RATE", value: "1.25" },
                // Criteria metrics carry a boolean; seen in the sandbox response.
                { metricKey: "POWER_SELLER", value: true },
              ],
            },
          ],
        },
      }),
    });
    expect(await adapter.getAccountHealth()).toEqual({
      defectRate: 0.005,
      lateShipmentRate: 0.0125,
      validTrackingRate: null,
      cancellationRate: null,
      returnRate: null,
    });
  });

  it("reports nothing rather than zero when eBay returns no profile", async () => {
    const { adapter } = setup({ "GET /sell/analytics/v1/seller_standards_profile": () => ({ body: {} }) });
    expect(await adapter.getAccountHealth()).toEqual({
      defectRate: null,
      lateShipmentRate: null,
      validTrackingRate: null,
      cancellationRate: null,
      returnRate: null,
    });
  });
});
