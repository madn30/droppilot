import { gunzipSync } from "node:zlib";
import { z } from "zod";
import type {
  AccountHealthMetrics,
  CompetitorCandidate,
  ListingDraft,
  ListingRef,
  ListingUpdate,
  MarketplaceAdapter,
  MarketplaceOrder,
  TrackingUpload,
} from "../types";
import { AMAZON_MARKETPLACE_ID, type SpApiClient } from "./client";

const MAX_IMAGES = 10;
const CATALOG_PAGE_SIZE = 20;
// The generic product type Amazon accepts for offer-only submissions and offer patches.
const OFFER_PRODUCT_TYPE = "PRODUCT";
const UNBRANDED = "Generic";
const MAX_BULLET_POINTS = 5;
// Amazon reports how long a seller takes to ship, not transit time; these are working assumptions for the rest.
const FBA_DELIVERY_DAYS = 2;
const ASSUMED_TRANSIT_DAYS = 5;
// getOrders rejects a CreatedAfter closer than two minutes to now.
const ORDERS_MIN_AGE_MS = 3 * 60 * 1000;
const HEALTH_REPORT_TYPE = "GET_V2_SELLER_PERFORMANCE_REPORT";
const REPORT_POLL_MS = 10_000;
const REPORT_MAX_POLLS = 18;

const moneySchema = z.object({ Amount: z.union([z.number(), z.string()]).optional(), CurrencyCode: z.string().optional() });

const catalogSearchSchema = z.object({
  items: z.array(
    z.object({
      asin: z.string(),
      summaries: z.array(z.object({ marketplaceId: z.string(), itemName: z.string().optional() })).optional(),
      images: z
        .array(z.object({ marketplaceId: z.string(), images: z.array(z.object({ variant: z.string(), link: z.string() })) }))
        .optional(),
      attributes: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

const offersSchema = z.object({
  payload: z
    .object({
      Offers: z
        .array(
          z.object({
            ListingPrice: moneySchema,
            Shipping: moneySchema.optional(),
            IsFulfilledByAmazon: z.boolean().optional(),
            ShippingTime: z.object({ maximumHours: z.number().optional() }).optional(),
            SellerFeedbackRating: z.object({ SellerPositiveFeedbackRating: z.number().optional() }).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const rankEntrySchema = z.object({ rank: z.number() });
const salesRanksSchema = z.object({
  salesRanks: z
    .array(
      z.object({
        marketplaceId: z.string(),
        displayGroupRanks: z.array(rankEntrySchema).optional(),
        classificationRanks: z.array(rankEntrySchema).optional(),
      }),
    )
    .optional(),
});

const productTypesSchema = z.object({ productTypes: z.array(z.object({ name: z.string() })) });

const submissionSchema = z.object({
  status: z.string(),
  issues: z.array(z.object({ message: z.string(), severity: z.string().optional() })).optional(),
  identifiers: z.array(z.object({ asin: z.string().optional() })).optional(),
});

const listingItemSchema = z.object({ attributes: z.record(z.string(), z.unknown()).optional() });

const restrictedTokenSchema = z.object({ restrictedDataToken: z.string().min(1) });

const addressSchema = z.object({
  Name: z.string().optional(),
  AddressLine1: z.string().optional(),
  AddressLine2: z.string().optional(),
  City: z.string().optional(),
  StateOrRegion: z.string().optional(),
  PostalCode: z.string().optional(),
  CountryCode: z.string().optional(),
  Phone: z.string().optional(),
});

const ordersSchema = z.object({
  payload: z.object({
    Orders: z.array(
      z.object({
        AmazonOrderId: z.string(),
        PurchaseDate: z.string(),
        LatestShipDate: z.string().optional(),
        OrderTotal: moneySchema.optional(),
        ShippingAddress: addressSchema.optional(),
      }),
    ),
    NextToken: z.string().optional(),
  }),
});

const orderItemsSchema = z.object({
  payload: z.object({
    OrderItems: z.array(
      z.object({
        OrderItemId: z.string(),
        SellerSKU: z.string().optional(),
        QuantityOrdered: z.number().int(),
        ItemPrice: moneySchema.optional(),
      }),
    ),
  }),
});

const reportCreatedSchema = z.object({ reportId: z.string() });
const reportSchema = z.object({ processingStatus: z.string(), reportDocumentId: z.string().optional() });
const reportDocumentSchema = z.object({ url: z.string(), compressionAlgorithm: z.string().optional() });

const rateSchema = z.object({ rate: z.union([z.number(), z.string()]).optional() }).optional();
const performanceReportSchema = z.object({
  performanceMetrics: z
    .array(
      z.object({
        marketplaceId: z.string().optional(),
        lateShipmentRate: rateSchema,
        preFulfillmentCancellationRate: rateSchema,
        validTrackingRate: rateSchema,
        orderDefectRate: z.object({ mfn: rateSchema }).optional(),
      }),
    )
    .optional(),
});

const noContent = z.unknown();

function cents(amount: { Amount?: number | string } | undefined): number | null {
  if (amount?.Amount === undefined) return null;
  const value = Number(amount.Amount);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function rateValue(metric: { rate?: number | string } | undefined): number | null {
  if (metric?.rate === undefined || metric.rate === "") return null;
  const value = Number(metric.rate);
  return Number.isFinite(value) ? value : null;
}

/** Catalog attributes are lists of {value, marketplace_id, …}; this takes each attribute's first plain value. */
function firstValues(attributes: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, entries] of Object.entries(attributes)) {
    if (!Array.isArray(entries)) continue;
    const first: unknown = entries[0];
    if (typeof first !== "object" || first === null || !("value" in first)) continue;
    if (typeof first.value === "string" || typeof first.value === "number" || typeof first.value === "boolean") {
      flat[name] = String(first.value);
    }
  }
  return flat;
}

function allValues(attributes: Record<string, unknown>, name: string): string[] {
  const entries = attributes[name];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) =>
    typeof entry === "object" && entry !== null && "value" in entry && typeof entry.value === "string" ? [entry.value] : [],
  );
}

export interface AmazonAdapterOptions {
  sellerId: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** Amazon through the Selling Partner API: Catalog and Pricing for competitor search, Listings Items for our listings, Orders and Reports. */
export class AmazonAdapter implements MarketplaceAdapter {
  readonly marketplace = "AMAZON";
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    private readonly client: SpApiClient,
    private readonly options: AmazonAdapterOptions,
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
  }

  /** Catalog keyword search; the price and seller come from each item's cheapest new offer. */
  async searchByKeyword(keyword: string, limit: number): Promise<CompetitorCandidate[]> {
    const result = await this.client.request(
      {
        method: "GET",
        path: "/catalog/2022-04-01/items",
        query: {
          keywords: keyword,
          marketplaceIds: AMAZON_MARKETPLACE_ID,
          includedData: ["summaries", "images", "attributes"],
          pageSize: Math.min(limit, CATALOG_PAGE_SIZE),
        },
      },
      catalogSearchSchema,
    );

    const candidates: CompetitorCandidate[] = [];
    for (const item of result.items) {
      const offers = await this.client.request(
        {
          method: "GET",
          path: `/products/pricing/v0/items/${encodeURIComponent(item.asin)}/offers`,
          query: { MarketplaceId: AMAZON_MARKETPLACE_ID, ItemCondition: "New" },
          rateGroup: "pricing",
        },
        offersSchema,
      );
      const priced = (offers.payload?.Offers ?? []).flatMap((offer) => {
        const priceCents = cents(offer.ListingPrice);
        if (priceCents === null || (offer.ListingPrice.CurrencyCode ?? "USD") !== "USD") return [];
        return [{ offer, priceCents, shippingCents: cents(offer.Shipping) ?? 0 }];
      });
      // An item nobody currently offers new is not a competitor.
      if (priced.length === 0) continue;
      const cheapest = priced.reduce((best, entry) =>
        entry.priceCents + entry.shippingCents < best.priceCents + best.shippingCents ? entry : best,
      );

      const attributes = item.attributes ?? {};
      const images = item.images?.find((entry) => entry.marketplaceId === AMAZON_MARKETPLACE_ID)?.images ?? [];
      const handlingHours = cheapest.offer.ShippingTime?.maximumHours;
      candidates.push({
        marketplace: "AMAZON",
        externalId: item.asin,
        title: item.summaries?.find((summary) => summary.marketplaceId === AMAZON_MARKETPLACE_ID)?.itemName ?? "",
        description: [...allValues(attributes, "bullet_point"), ...allValues(attributes, "product_description")].join("\n"),
        url: `https://www.amazon.com/dp/${item.asin}`,
        priceCents: cheapest.priceCents,
        shippingCents: cheapest.shippingCents,
        currency: "USD",
        deliveryDays: cheapest.offer.IsFulfilledByAmazon
          ? FBA_DELIVERY_DAYS
          : handlingHours === undefined
            ? null
            : Math.ceil(handlingHours / 24) + ASSUMED_TRANSIT_DAYS,
        sellerRating: cheapest.offer.SellerFeedbackRating?.SellerPositiveFeedbackRating ?? null,
        soldCount: null,
        // The main image first, then the rest in catalog order.
        imageUrls: [...images.filter((image) => image.variant === "MAIN"), ...images.filter((image) => image.variant !== "MAIN")]
          .map((image) => image.link)
          .filter((link, index, links) => links.indexOf(link) === index)
          .slice(0, MAX_IMAGES),
        itemSpecifics: firstValues(attributes),
      });
    }
    return candidates.filter((candidate) => candidate.title !== "");
  }

  async listCandidateIds(keyword: string, limit: number): Promise<string[]> {
    const result = await this.client.request(
      {
        method: "GET",
        path: "/catalog/2022-04-01/items",
        query: { keywords: keyword, marketplaceIds: AMAZON_MARKETPLACE_ID, includedData: ["summaries"], pageSize: Math.min(limit, CATALOG_PAGE_SIZE) },
      },
      catalogSearchSchema,
    );
    return result.items.map((item) => item.asin);
  }

  /** The item's current best-sellers rank in its main category, or null when Amazon reports none. */
  async getSalesRank(asin: string): Promise<number | null> {
    const item = await this.client.request(
      {
        method: "GET",
        path: `/catalog/2022-04-01/items/${encodeURIComponent(asin)}`,
        query: { marketplaceIds: AMAZON_MARKETPLACE_ID, includedData: "salesRanks" },
      },
      salesRanksSchema,
    );
    const ranks = item.salesRanks?.find((entry) => entry.marketplaceId === AMAZON_MARKETPLACE_ID);
    // The display-group rank is the headline "Best Sellers Rank"; sub-category ranks are a fallback.
    const mainRank = ranks?.displayGroupRanks?.[0]?.rank;
    if (mainRank !== undefined) return mainRank;
    // Sub-category ranks run much lower than the main one, so the weakest of them is the cautious stand-in.
    const subRanks = (ranks?.classificationRanks ?? []).map((entry) => entry.rank);
    return subRanks.length > 0 ? Math.max(...subRanks) : null;
  }

  async publishListing(draft: ListingDraft): Promise<{ externalId: string }> {
    const marketplace_id = AMAZON_MARKETPLACE_ID;
    const offer = {
      condition_type: [{ value: "new_new", marketplace_id }],
      purchasable_offer: [{ currency: "USD", marketplace_id, our_price: [{ schedule: [{ value_with_tax: draft.priceCents / 100 }] }] }],
      // Realistic handling time: the supplier's processing days.
      fulfillment_availability: [
        { fulfillment_channel_code: "DEFAULT", quantity: draft.quantity, lead_time_to_ship_max_days: draft.handlingDays },
      ],
    };

    let body: { productType: string; requirements: string; attributes: Record<string, unknown> };
    if (draft.existingProductId) {
      // The exact product already has an ASIN: add our offer to it rather than creating a duplicate.
      body = {
        productType: OFFER_PRODUCT_TYPE,
        requirements: "LISTING_OFFER_ONLY",
        attributes: { ...offer, merchant_suggested_asin: [{ value: draft.existingProductId, marketplace_id }] },
      };
    } else {
      const types = await this.client.request(
        { method: "GET", path: "/definitions/2020-09-01/productTypes", query: { itemName: draft.title, marketplaceIds: marketplace_id } },
        productTypesSchema,
      );
      const productType = types.productTypes[0]?.name;
      if (!productType) throw new Error(`Amazon suggested no product type for "${draft.title}"`);

      const lines = draft.description.split("\n").map((line) => line.trim());
      const bullets = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
      const [mainImage, ...otherImages] = draft.imageUrls.slice(0, MAX_IMAGES - 1);
      body = {
        productType,
        requirements: "LISTING",
        attributes: {
          ...offer,
          item_name: [{ value: draft.title, language_tag: "en_US", marketplace_id }],
          // Unbranded goods are listed under Amazon's generic brand, with a product-ID (GTIN) exemption.
          brand: [{ value: UNBRANDED, language_tag: "en_US", marketplace_id }],
          supplier_declared_has_product_identifier_exemption: [{ value: true, marketplace_id }],
          product_description: [{ value: draft.description, language_tag: "en_US", marketplace_id }],
          bullet_point: bullets.slice(0, MAX_BULLET_POINTS).map((value) => ({ value, language_tag: "en_US", marketplace_id })),
          ...(mainImage ? { main_product_image_locator: [{ media_location: mainImage, marketplace_id }] } : {}),
          ...Object.fromEntries(
            otherImages.map((url, index) => [`other_product_image_locator_${index + 1}`, [{ media_location: url, marketplace_id }]]),
          ),
        },
      };
    }

    const submission = await this.client.request(
      { method: "PUT", path: this.listingPath(draft.sku), query: { marketplaceIds: marketplace_id }, body },
      submissionSchema,
    );
    this.assertAccepted(submission, draft.sku);
    return { externalId: draft.existingProductId ?? submission.identifiers?.[0]?.asin ?? draft.sku };
  }

  async updateListing(listing: ListingRef, update: ListingUpdate): Promise<void> {
    const marketplace_id = AMAZON_MARKETPLACE_ID;
    const patches: { op: "replace"; path: string; value: unknown[] }[] = [];

    if (update.priceCents !== undefined) {
      patches.push({
        op: "replace",
        path: "/attributes/purchasable_offer",
        value: [{ currency: "USD", marketplace_id, our_price: [{ schedule: [{ value_with_tax: update.priceCents / 100 }] }] }],
      });
    }
    if (update.quantity !== undefined) {
      // The attribute is replaced as a whole, so the current handling time is read and kept.
      const current = await this.client.request(
        { method: "GET", path: this.listingPath(listing.sku), query: { marketplaceIds: marketplace_id, includedData: "attributes" } },
        listingItemSchema,
      );
      const stored: unknown = Array.isArray(current.attributes?.fulfillment_availability)
        ? current.attributes.fulfillment_availability[0]
        : undefined;
      patches.push({
        op: "replace",
        path: "/attributes/fulfillment_availability",
        value: [{ fulfillment_channel_code: "DEFAULT", ...(typeof stored === "object" && stored !== null ? stored : {}), quantity: update.quantity }],
      });
    }
    if (update.title !== undefined) {
      patches.push({ op: "replace", path: "/attributes/item_name", value: [{ value: update.title, language_tag: "en_US", marketplace_id }] });
    }
    if (update.description !== undefined) {
      patches.push({
        op: "replace",
        path: "/attributes/product_description",
        value: [{ value: update.description, language_tag: "en_US", marketplace_id }],
      });
    }
    if (patches.length === 0) return;

    const submission = await this.client.request(
      {
        method: "PATCH",
        path: this.listingPath(listing.sku),
        query: { marketplaceIds: marketplace_id },
        body: { productType: OFFER_PRODUCT_TYPE, patches },
      },
      submissionSchema,
    );
    this.assertAccepted(submission, listing.sku);
  }

  async endListing(listing: ListingRef): Promise<void> {
    const submission = await this.client.request(
      { method: "DELETE", path: this.listingPath(listing.sku), query: { marketplaceIds: AMAZON_MARKETPLACE_ID } },
      submissionSchema,
    );
    this.assertAccepted(submission, listing.sku);
  }

  /** Unshipped seller-fulfilled orders. Buyer addresses are restricted data and need their own short-lived token. */
  async getOrders(since: Date): Promise<MarketplaceOrder[]> {
    const { restrictedDataToken } = await this.client.request(
      {
        method: "POST",
        path: "/tokens/2021-03-01/restrictedDataToken",
        body: { restrictedResources: [{ method: "GET", path: "/orders/v0/orders", dataElements: ["shippingAddress", "buyerInfo"] }] },
      },
      restrictedTokenSchema,
    );
    const createdAfter = new Date(Math.min(since.getTime(), this.now().getTime() - ORDERS_MIN_AGE_MS));

    const orders: MarketplaceOrder[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.request(
        {
          method: "GET",
          path: "/orders/v0/orders",
          restrictedDataToken,
          query: nextToken
            ? { MarketplaceIds: AMAZON_MARKETPLACE_ID, NextToken: nextToken }
            : {
                MarketplaceIds: AMAZON_MARKETPLACE_ID,
                CreatedAfter: createdAfter.toISOString(),
                OrderStatuses: ["Unshipped", "PartiallyShipped"],
                FulfillmentChannels: "MFN",
              },
        },
        ordersSchema,
      );
      for (const order of page.payload.Orders) {
        const items = await this.client.request(
          { method: "GET", path: `/orders/v0/orders/${encodeURIComponent(order.AmazonOrderId)}/orderItems` },
          orderItemsSchema,
        );
        const address = order.ShippingAddress;
        orders.push({
          externalId: order.AmazonOrderId,
          orderedAt: new Date(order.PurchaseDate),
          shipByDate: order.LatestShipDate ? new Date(order.LatestShipDate) : null,
          buyerName: address?.Name ?? "",
          shippingAddress: {
            name: address?.Name ?? "",
            line1: address?.AddressLine1 ?? "",
            line2: address?.AddressLine2 || undefined,
            city: address?.City ?? "",
            state: address?.StateOrRegion ?? "",
            postalCode: address?.PostalCode ?? "",
            country: address?.CountryCode ?? "",
            phone: address?.Phone || undefined,
          },
          totalCents: cents(order.OrderTotal) ?? 0,
          currency: order.OrderTotal?.CurrencyCode ?? "USD",
          lines: items.payload.OrderItems.flatMap((item) => {
            const itemCents = cents(item.ItemPrice);
            if (!item.SellerSKU || itemCents === null || item.QuantityOrdered <= 0) return [];
            return [
              {
                externalLineId: item.OrderItemId,
                sku: item.SellerSKU,
                quantity: item.QuantityOrdered,
                // ItemPrice covers the whole line.
                priceCents: Math.round(itemCents / item.QuantityOrdered),
              },
            ];
          }),
        });
      }
      nextToken = page.payload.NextToken;
    } while (nextToken);
    return orders;
  }

  async uploadTracking(orderExternalId: string, tracking: TrackingUpload): Promise<void> {
    await this.client.request(
      {
        method: "POST",
        path: `/orders/v0/orders/${encodeURIComponent(orderExternalId)}/shipmentConfirmation`,
        body: {
          marketplaceId: AMAZON_MARKETPLACE_ID,
          packageDetail: {
            packageReferenceId: "1",
            carrierCode: tracking.carrier,
            trackingNumber: tracking.trackingNumber,
            shipDate: this.now().toISOString(),
            orderItems: tracking.lines.map((line) => ({ orderItemId: line.externalLineId, quantity: line.quantity })),
          },
        },
      },
      noContent,
    );
  }

  /** Amazon publishes account health as a report: request it, wait for it, download it. */
  async getAccountHealth(): Promise<AccountHealthMetrics> {
    const { reportId } = await this.client.request(
      { method: "POST", path: "/reports/2021-06-30/reports", body: { reportType: HEALTH_REPORT_TYPE, marketplaceIds: [AMAZON_MARKETPLACE_ID] } },
      reportCreatedSchema,
    );

    let documentId: string | undefined;
    for (let poll = 0; poll < REPORT_MAX_POLLS && !documentId; poll++) {
      if (poll > 0) await this.sleep(REPORT_POLL_MS);
      const report = await this.client.request({ method: "GET", path: `/reports/2021-06-30/reports/${reportId}` }, reportSchema);
      if (report.processingStatus === "CANCELLED" || report.processingStatus === "FATAL") {
        throw new Error(`Amazon seller performance report ${reportId} ended as ${report.processingStatus}`);
      }
      if (report.processingStatus === "DONE") documentId = report.reportDocumentId;
    }
    if (!documentId) throw new Error(`Amazon seller performance report ${reportId} was not ready in time`);

    const document = await this.client.request(
      { method: "GET", path: `/reports/2021-06-30/documents/${encodeURIComponent(documentId)}` },
      reportDocumentSchema,
    );
    // The document itself lives at a pre-signed URL, outside the API.
    const response = await this.fetchImpl(document.url);
    if (!response.ok) throw new Error(`Downloading the Amazon seller performance report failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = (document.compressionAlgorithm === "GZIP" ? gunzipSync(bytes) : bytes).toString("utf8");
    const report = performanceReportSchema.parse(JSON.parse(text));

    const metrics =
      report.performanceMetrics?.find((entry) => entry.marketplaceId === AMAZON_MARKETPLACE_ID) ?? report.performanceMetrics?.[0];
    return {
      defectRate: rateValue(metrics?.orderDefectRate?.mfn),
      lateShipmentRate: rateValue(metrics?.lateShipmentRate),
      cancellationRate: rateValue(metrics?.preFulfillmentCancellationRate),
      validTrackingRate: rateValue(metrics?.validTrackingRate),
      returnRate: null,
    };
  }

  private listingPath(sku: string): string {
    return `/listings/2021-08-01/items/${encodeURIComponent(this.options.sellerId)}/${encodeURIComponent(sku)}`;
  }

  /** A submission Amazon did not accept changed nothing; its issues say why. */
  private assertAccepted(submission: z.infer<typeof submissionSchema>, sku: string): void {
    if (submission.status === "ACCEPTED" || submission.status === "VALID") return;
    const issues = (submission.issues ?? []).filter((issue) => issue.severity !== "WARNING" && issue.severity !== "INFO");
    const detail = (issues.length > 0 ? issues : (submission.issues ?? [])).map((issue) => issue.message).join("; ");
    throw new Error(`Amazon did not accept the listing submission for ${sku} (${submission.status}): ${detail || "no details"}`);
  }
}
