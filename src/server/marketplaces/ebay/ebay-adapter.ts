import { z } from "zod";
import type { AspectFiller, RequiredAspect } from "../../ai/types";
import { logger } from "../../logger";
import type {
  AccountHealthMetrics,
  CompetitorCandidate,
  ListingDraft,
  ListingRef,
  ListingUpdate,
  MarketplaceAdapter,
  MarketplaceOrder,
  TrackingUpload,
  VariationListingDraft,
} from "../types";
import { EBAY_MARKETPLACE_ID, EbayApiError, type EbayClient } from "./client";
import { renderDescriptionHtml } from "./description";

const DAY_MS = 24 * 60 * 60 * 1000;
// eBay's US category tree.
const CATEGORY_TREE_ID = "0";
const MAX_IMAGES = 10;
// eBay shows up to 24 photos on a listing.
const MAX_LISTING_IMAGES = 24;
// Found by testing in the sandbox: when the description is longer than 4,000 characters and the photo URLs add up
// to more than about 1,280 characters (1,256 passes, 1,312 fails), eBay answers "Core Inventory Service internal error".
// The number of photos and the pictures inside the description do not matter.
const LONG_DESCRIPTION_CHARS = 4000;
const MAX_PHOTO_URL_CHARS = 1250;

/** The photos a listing can carry next to its description, within eBay's limits. */
function fitPhotos(imageUrls: string[], descriptionLength: number): string[] {
  const photos = imageUrls.slice(0, MAX_LISTING_IMAGES);
  if (descriptionLength <= LONG_DESCRIPTION_CHARS) return photos;
  const fitting: string[] = [];
  let urlChars = 0;
  for (const url of photos) {
    urlChars += url.length;
    if (urlChars > MAX_PHOTO_URL_CHARS) break;
    fitting.push(url);
  }
  return fitting;
}
const NO_MPN = "Does Not Apply";

const amountSchema = z.object({ value: z.string(), currency: z.string() });

const searchSchema = z.object({ itemSummaries: z.array(z.object({ itemId: z.string() })).optional() });

const itemSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  shortDescription: z.string().optional(),
  description: z.string().optional(),
  price: amountSchema.optional(),
  itemWebUrl: z.string().optional(),
  image: z.object({ imageUrl: z.string() }).optional(),
  additionalImages: z.array(z.object({ imageUrl: z.string() })).optional(),
  seller: z.object({ feedbackPercentage: z.string().optional() }).optional(),
  shippingOptions: z
    .array(z.object({ shippingCost: amountSchema.optional(), maxEstimatedDeliveryDate: z.string().optional() }))
    .optional(),
  estimatedAvailabilities: z.array(z.object({ estimatedSoldQuantity: z.number().optional() })).optional(),
  localizedAspects: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
});

const fulfillmentPoliciesSchema = z.object({
  fulfillmentPolicies: z
    .array(z.object({ fulfillmentPolicyId: z.string(), handlingTime: z.object({ value: z.number(), unit: z.string() }).optional() }))
    .optional(),
});
const paymentPoliciesSchema = z.object({ paymentPolicies: z.array(z.object({ paymentPolicyId: z.string() })).optional() });
const returnPoliciesSchema = z.object({ returnPolicies: z.array(z.object({ returnPolicyId: z.string() })).optional() });
const locationsSchema = z.object({
  locations: z.array(z.object({ merchantLocationKey: z.string(), merchantLocationStatus: z.string().optional() })).optional(),
});
const categorySuggestionsSchema = z.object({
  categorySuggestions: z.array(z.object({ category: z.object({ categoryId: z.string() }) })).optional(),
});
const itemAspectsSchema = z.object({
  aspects: z
    .array(
      z.object({
        localizedAspectName: z.string(),
        aspectConstraint: z.object({ aspectRequired: z.boolean().optional(), aspectMode: z.string().optional() }).optional(),
        aspectValues: z.array(z.object({ localizedValue: z.string() })).optional(),
      }),
    )
    .optional(),
});
const offersSchema = z.object({
  offers: z
    .array(z.object({ offerId: z.string(), status: z.string().optional(), listing: z.object({ listingId: z.string().optional() }).optional() }))
    .optional(),
});
const offerCreatedSchema = z.object({ offerId: z.string() });
const publishedSchema = z.object({ listingId: z.string() });
const inventoryItemSchema = z.looseObject({ product: z.looseObject({}).optional() });
const bulkUpdateSchema = z.object({
  responses: z
    .array(z.object({ statusCode: z.number().optional(), errors: z.array(z.object({ message: z.string().optional() })).optional() }))
    .optional(),
});
const noContent = z.unknown();

const ORDER_PAGE_SIZE = 200;
const INSIGHTS_PAGE_SIZE = 200;

const itemSalesSchema = z.object({
  itemSales: z.array(z.object({ itemId: z.string(), totalSoldQuantity: z.number().optional() })).optional(),
});

const ordersSchema = z.object({
  orders: z
    .array(
      z.object({
        orderId: z.string(),
        creationDate: z.string(),
        orderPaymentStatus: z.string().optional(),
        buyer: z.object({ username: z.string().optional() }).optional(),
        pricingSummary: z.object({ total: amountSchema.optional() }).optional(),
        fulfillmentStartInstructions: z
          .array(
            z.object({
              shippingStep: z
                .object({
                  shipTo: z
                    .object({
                      fullName: z.string().optional(),
                      primaryPhone: z.object({ phoneNumber: z.string().optional() }).optional(),
                      contactAddress: z
                        .object({
                          addressLine1: z.string().optional(),
                          addressLine2: z.string().optional(),
                          city: z.string().optional(),
                          stateOrProvince: z.string().optional(),
                          postalCode: z.string().optional(),
                          countryCode: z.string().optional(),
                        })
                        .optional(),
                    })
                    .optional(),
                })
                .optional(),
            }),
          )
          .optional(),
        lineItems: z.array(
          z.object({
            lineItemId: z.string(),
            sku: z.string().optional(),
            quantity: z.number().int().positive(),
            lineItemCost: amountSchema.optional(),
            lineItemFulfillmentInstructions: z.object({ shipByDate: z.string().optional() }).optional(),
          }),
        ),
      }),
    )
    .optional(),
});

// A metric's value arrives as a bare number/string, an object carrying the number, or a boolean (criteria such as POWER_SELLER).
const metricValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({ value: z.union([z.string(), z.number()]).optional() }),
]);
const standardsSchema = z.object({
  standardsProfiles: z
    .array(
      z.object({
        program: z.string().optional(),
        cycle: z.object({ cycleType: z.string().optional() }).optional(),
        metrics: z.array(z.object({ metricKey: z.string().optional(), value: metricValueSchema.optional() })).optional(),
      }),
    )
    .optional(),
});

/** Whether the text contains the phrase as whole words, ignoring case. */
function mentions(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

function cents(amount: { value: string } | undefined): number | null {
  if (!amount) return null;
  const value = Number(amount.value);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

function dollars(amountCents: number): { value: string; currency: string } {
  return { value: (amountCents / 100).toFixed(2), currency: "USD" };
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

interface SellerSetup {
  fulfillmentPolicies: { fulfillmentPolicyId: string; handlingDays: number }[];
  paymentPolicyId: string;
  returnPolicyId: string;
  merchantLocationKey: string;
}

/** eBay through its official APIs: Browse for competitor search, Sell Inventory and Account for our listings. */
export class EbayAdapter implements MarketplaceAdapter {
  readonly marketplace = "EBAY";
  private setup: Promise<SellerSetup> | null = null;

  constructor(
    private readonly client: EbayClient,
    private readonly now: () => Date = () => new Date(),
    /** Fills required item specifics the listing text does not answer directly; without it those listings fail. */
    private readonly aspectFiller: AspectFiller | null = null,
  ) {}

  async searchByKeyword(keyword: string, limit: number): Promise<CompetitorCandidate[]> {
    const result = await this.client.request(
      {
        method: "GET",
        path: "/buy/browse/v1/item_summary/search",
        token: "app",
        query: { q: keyword, limit, filter: "buyingOptions:{FIXED_PRICE},conditions:{NEW}" },
      },
      searchSchema,
    );
    return this.loadCandidates(result.itemSummaries ?? []);
  }

  async searchByImage(image: Uint8Array, limit: number): Promise<CompetitorCandidate[]> {
    let result: z.infer<typeof searchSchema>;
    try {
      result = await this.client.request(
        {
          method: "POST",
          path: "/buy/browse/v1/item_summary/search_by_image",
          token: "app",
          query: { limit, filter: "buyingOptions:{FIXED_PRICE},conditions:{NEW}" },
          body: { image: Buffer.from(image).toString("base64") },
        },
        searchSchema,
      );
    } catch (error) {
      // Still 429 after the client's retries means the call limit is used up for the day;
      // the keyword search still finds candidates, so matching carries on without image results.
      if (!(error instanceof EbayApiError) || error.status !== 429) throw error;
      logger.warn({ err: error }, "eBay image search call limit reached; using keyword search only");
      return [];
    }
    return this.loadCandidates(result.itemSummaries ?? []);
  }

  async listCandidateIds(keyword: string, limit: number): Promise<string[]> {
    const result = await this.client.request(
      {
        method: "GET",
        path: "/buy/browse/v1/item_summary/search",
        token: "app",
        query: { q: keyword, limit, filter: "buyingOptions:{FIXED_PRICE},conditions:{NEW}" },
      },
      searchSchema,
    );
    return (result.itemSummaries ?? []).map((summary) => summary.itemId);
  }

  /** Sold quantities over the last 90 days from the Marketplace Insights API (restricted access). */
  async getSoldQuantities(keyword: string): Promise<Map<string, number>> {
    const result = await this.client.request(
      {
        method: "GET",
        path: "/buy/marketplace_insights/v1_beta/item_sales/search",
        token: "insights",
        query: { q: keyword, limit: INSIGHTS_PAGE_SIZE, filter: "buyingOptions:{FIXED_PRICE},conditions:{NEW}" },
      },
      itemSalesSchema,
    );
    return new Map(
      (result.itemSales ?? []).flatMap((sale) => (sale.totalSoldQuantity === undefined ? [] : [[sale.itemId, sale.totalSoldQuantity] as const])),
    );
  }

  /** Search results are summaries; item specifics and the description need one item call each. */
  private async loadCandidates(summaries: { itemId: string }[]): Promise<CompetitorCandidate[]> {
    const candidates: CompetitorCandidate[] = [];
    for (const { itemId } of summaries) {
      let item: z.infer<typeof itemSchema>;
      try {
        item = await this.client.request(
          { method: "GET", path: `/buy/browse/v1/item/${encodeURIComponent(itemId)}`, token: "app" },
          itemSchema,
        );
      } catch (error) {
        // A listing that ended between the search and this call is simply no longer a competitor.
        if (error instanceof EbayApiError && error.status === 404) continue;
        throw error;
      }
      const priceCents = cents(item.price);
      if (priceCents === null || item.price?.currency !== "USD") continue;

      const shipping = item.shippingOptions?.[0];
      const deliveryBy = shipping?.maxEstimatedDeliveryDate ? new Date(shipping.maxEstimatedDeliveryDate) : null;
      const rating = Number(item.seller?.feedbackPercentage);
      candidates.push({
        marketplace: "EBAY",
        externalId: item.itemId,
        title: item.title,
        description: htmlToText(item.description ?? item.shortDescription ?? ""),
        url: item.itemWebUrl ?? `https://www.ebay.com/itm/${encodeURIComponent(item.itemId)}`,
        priceCents,
        shippingCents: cents(shipping?.shippingCost) ?? 0,
        currency: "USD",
        deliveryDays:
          deliveryBy && !Number.isNaN(deliveryBy.getTime())
            ? Math.max(0, Math.ceil((deliveryBy.getTime() - this.now().getTime()) / DAY_MS))
            : null,
        sellerRating: Number.isFinite(rating) && item.seller?.feedbackPercentage ? rating : null,
        soldCount: item.estimatedAvailabilities?.[0]?.estimatedSoldQuantity ?? null,
        imageUrls: [item.image?.imageUrl, ...(item.additionalImages ?? []).map((image) => image.imageUrl)]
          .filter((url): url is string => Boolean(url))
          .slice(0, MAX_IMAGES),
        itemSpecifics: Object.fromEntries((item.localizedAspects ?? []).map((aspect) => [aspect.name, aspect.value])),
        // Browse ids are "v1|<listing>|<variation>", with variation 0 for a listing without variations.
        isVariation: !item.itemId.endsWith("|0"),
      });
    }
    return candidates;
  }

  async publishListing(full: ListingDraft): Promise<{ externalId: string }> {
    const descriptionHtml = renderDescriptionHtml(full.description, full.title, full.detailImageUrls, full);
    const draft = { ...full, imageUrls: fitPhotos(full.imageUrls, descriptionHtml.length) };
    const { categoryId, offerTerms } = await this.listingTerms(draft, descriptionHtml);
    const itemSpecifics = await this.completeRequiredAspects(categoryId, draft);
    await this.putInventoryItem(draft.sku, draft, itemSpecifics, draft.quantity);

    // Publishing twice must not create a second listing: reuse the SKU's offer when it exists.
    const offer = await this.upsertOffer(draft.sku, { ...offerTerms, availableQuantity: draft.quantity, pricingSummary: { price: dollars(draft.priceCents) } });
    if (offer.listingId) return { externalId: offer.listingId };
    const published = await this.client.request(
      { method: "POST", path: `/sell/inventory/v1/offer/${offer.offerId}/publish`, token: "user" },
      publishedSchema,
    );
    return { externalId: published.listingId };
  }

  async publishVariations(full: VariationListingDraft): Promise<{ externalId: string }> {
    const descriptionHtml = renderDescriptionHtml(full.description, full.title, full.detailImageUrls, full);
    const draft = { ...full, imageUrls: fitPhotos(full.imageUrls, descriptionHtml.length) };
    const optionNames = Object.keys(draft.variations[0]?.options ?? {});
    if (draft.variations.length < 2 || optionNames.length === 0) {
      throw new Error(`Listing ${draft.groupKey} needs at least two variations with options`);
    }
    const { categoryId, offerTerms } = await this.listingTerms(draft, descriptionHtml);
    const itemSpecifics = await this.completeRequiredAspects(categoryId, draft, optionNames);
    const asAspects = (specifics: Record<string, string>) => Object.fromEntries(Object.entries(specifics).map(([name, value]) => [name, [value]]));

    for (const variation of draft.variations) {
      await this.putInventoryItem(variation.sku, draft, { ...itemSpecifics, ...variation.options }, variation.quantity);
    }
    await this.client.request(
      {
        method: "PUT",
        path: `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(draft.groupKey)}`,
        token: "user",
        body: {
          title: draft.title,
          description: descriptionHtml,
          imageUrls: draft.imageUrls,
          aspects: asAspects(itemSpecifics),
          variantSKUs: draft.variations.map((variation) => variation.sku),
          variesBy: {
            specifications: optionNames.map((name) => ({
              name,
              values: [...new Set(draft.variations.map((variation) => variation.options[name]))],
            })),
          },
        },
      },
      noContent,
    );
    for (const variation of draft.variations) {
      await this.upsertOffer(variation.sku, {
        ...offerTerms,
        availableQuantity: variation.quantity,
        pricingSummary: { price: dollars(variation.priceCents) },
      });
    }
    const published = await this.client.request(
      {
        method: "POST",
        path: "/sell/inventory/v1/offer/publish_by_inventory_item_group",
        token: "user",
        body: { inventoryItemGroupKey: draft.groupKey, marketplaceId: EBAY_MARKETPLACE_ID },
      },
      publishedSchema,
    );
    return { externalId: published.listingId };
  }

  /** The category and the offer fields every SKU of a listing shares: policies, location and description. */
  private async listingTerms(draft: { title: string; handlingDays: number }, descriptionHtml: string) {
    const setup = await this.sellerSetup();
    // Realistic handling time: the listing must use a policy that allows at least the supplier's processing days.
    const policy = setup.fulfillmentPolicies.find((candidate) => candidate.handlingDays >= draft.handlingDays);
    if (!policy) {
      throw new Error(
        `No eBay fulfillment policy has a handling time of at least ${draft.handlingDays} days. Create one in eBay's business policies before listing "${draft.title}".`,
      );
    }

    const suggestions = await this.client.request(
      {
        method: "GET",
        path: `/commerce/taxonomy/v1/category_tree/${CATEGORY_TREE_ID}/get_category_suggestions`,
        token: "app",
        query: { q: draft.title },
      },
      categorySuggestionsSchema,
    );
    const categoryId = suggestions.categorySuggestions?.[0]?.category.categoryId;
    if (!categoryId) throw new Error(`eBay suggested no category for "${draft.title}"`);
    return {
      categoryId,
      offerTerms: {
        categoryId,
        listingDescription: descriptionHtml,
        listingPolicies: {
          fulfillmentPolicyId: policy.fulfillmentPolicyId,
          paymentPolicyId: setup.paymentPolicyId,
          returnPolicyId: setup.returnPolicyId,
        },
        merchantLocationKey: setup.merchantLocationKey,
      },
    };
  }

  private async putInventoryItem(
    sku: string,
    draft: { title: string; description: string; imageUrls: string[] },
    itemSpecifics: Record<string, string>,
    quantity: number,
  ): Promise<void> {
    await this.client.request(
      {
        method: "PUT",
        path: `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
        token: "user",
        body: {
          availability: { shipToLocationAvailability: { quantity } },
          condition: "NEW",
          product: {
            title: draft.title,
            description: draft.description,
            aspects: Object.fromEntries(Object.entries(itemSpecifics).map(([name, value]) => [name, [value]])),
            imageUrls: draft.imageUrls,
          },
        },
      },
      noContent,
    );
  }

  /** Creates the SKU's offer or brings its existing one up to date. `listingId` is set when that offer is already live. */
  private async upsertOffer(sku: string, details: Record<string, unknown>): Promise<{ offerId: string; listingId: string | null }> {
    const existing = await this.findOffer(sku);
    if (existing?.status === "PUBLISHED" && existing.listing?.listingId) {
      return { offerId: existing.offerId, listingId: existing.listing.listingId };
    }
    if (existing) {
      await this.client.request({ method: "PUT", path: `/sell/inventory/v1/offer/${existing.offerId}`, token: "user", body: details }, noContent);
      return { offerId: existing.offerId, listingId: null };
    }
    const created = await this.client.request(
      {
        method: "POST",
        path: "/sell/inventory/v1/offer",
        token: "user",
        body: { sku, marketplaceId: EBAY_MARKETPLACE_ID, format: "FIXED_PRICE", ...details },
      },
      offerCreatedSchema,
    );
    return { offerId: created.offerId, listingId: null };
  }

  async updateListing(listing: ListingRef, update: ListingUpdate): Promise<void> {
    if (update.title !== undefined || update.description !== undefined) {
      const text = {
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.description !== undefined ? { description: update.description } : {}),
      };
      // eBay replaces the record as a whole, so read it, change the text and write it back.
      if (listing.groupKey) {
        // A listing with variations takes its title and description from the group.
        const path = `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(listing.groupKey)}`;
        const group = await this.client.request({ method: "GET", path, token: "user" }, z.record(z.string(), z.unknown()));
        await this.client.request({ method: "PUT", path, token: "user", body: { ...group, ...text } }, noContent);
      } else {
        const path = `/sell/inventory/v1/inventory_item/${encodeURIComponent(listing.sku)}`;
        const item = await this.client.request({ method: "GET", path, token: "user" }, inventoryItemSchema);
        await this.client.request({ method: "PUT", path, token: "user", body: { ...item, product: { ...item.product, ...text } } }, noContent);
      }
    }

    if (update.priceCents !== undefined || update.quantity !== undefined) {
      const offer = await this.requireOffer(listing.sku);
      const result = await this.client.request(
        {
          method: "POST",
          path: "/sell/inventory/v1/bulk_update_price_quantity",
          token: "user",
          body: {
            requests: [
              {
                sku: listing.sku,
                ...(update.quantity !== undefined ? { shipToLocationAvailability: { quantity: update.quantity } } : {}),
                offers: [
                  {
                    offerId: offer.offerId,
                    ...(update.quantity !== undefined ? { availableQuantity: update.quantity } : {}),
                    ...(update.priceCents !== undefined ? { price: dollars(update.priceCents) } : {}),
                  },
                ],
              },
            ],
          },
        },
        bulkUpdateSchema,
      );
      // The call answers 200 even when an individual update failed; each response carries its own status.
      const failed = (result.responses ?? []).filter((response) => response.statusCode !== undefined && response.statusCode >= 300);
      if (failed.length > 0) {
        const detail = failed.flatMap((response) => (response.errors ?? []).map((error) => error.message)).filter(Boolean).join("; ");
        throw new Error(`eBay rejected the price/quantity update for ${listing.sku}: ${detail || "no details"}`);
      }
    }
  }

  async endListing(listing: ListingRef): Promise<void> {
    if (listing.groupKey) {
      // Ends the whole listing with all its variations; eBay answers 200 with a warning when it is already ended.
      await this.client.request(
        {
          method: "POST",
          path: "/sell/inventory/v1/offer/withdraw_by_inventory_item_group",
          token: "user",
          body: { inventoryItemGroupKey: listing.groupKey, marketplaceId: EBAY_MARKETPLACE_ID },
        },
        z.unknown(),
      );
      return;
    }
    const offer = await this.requireOffer(listing.sku);
    await this.client.request({ method: "POST", path: `/sell/inventory/v1/offer/${offer.offerId}/withdraw`, token: "user" }, noContent);
  }

  async getOrders(since: Date): Promise<MarketplaceOrder[]> {
    const orders: MarketplaceOrder[] = [];
    for (let offset = 0; ; offset += ORDER_PAGE_SIZE) {
      const page = await this.client.request(
        {
          method: "GET",
          path: "/sell/fulfillment/v1/order",
          token: "user",
          query: { filter: `creationdate:[${since.toISOString()}..]`, limit: ORDER_PAGE_SIZE, offset },
        },
        ordersSchema,
      );
      for (const order of page.orders ?? []) {
        // Unpaid orders must not be fulfilled; they are picked up by a later poll once paid.
        if (order.orderPaymentStatus !== "PAID") continue;
        const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
        const address = shipTo?.contactAddress;
        const shipByDates = order.lineItems.flatMap((line) =>
          line.lineItemFulfillmentInstructions?.shipByDate ? [new Date(line.lineItemFulfillmentInstructions.shipByDate)] : [],
        );
        orders.push({
          externalId: order.orderId,
          orderedAt: new Date(order.creationDate),
          shipByDate: shipByDates.length > 0 ? new Date(Math.min(...shipByDates.map((date) => date.getTime()))) : null,
          buyerName: shipTo?.fullName ?? order.buyer?.username ?? "",
          buyerUsername: order.buyer?.username,
          shippingAddress: {
            name: shipTo?.fullName ?? "",
            line1: address?.addressLine1 ?? "",
            line2: address?.addressLine2 || undefined,
            city: address?.city ?? "",
            state: address?.stateOrProvince ?? "",
            postalCode: address?.postalCode ?? "",
            country: address?.countryCode ?? "",
            phone: shipTo?.primaryPhone?.phoneNumber || undefined,
          },
          totalCents: cents(order.pricingSummary?.total) ?? 0,
          currency: order.pricingSummary?.total?.currency ?? "USD",
          lines: order.lineItems.flatMap((line) => {
            const lineCents = cents(line.lineItemCost);
            // A line without a SKU was not listed by this system.
            if (!line.sku || lineCents === null) return [];
            return [{ externalLineId: line.lineItemId, sku: line.sku, quantity: line.quantity, priceCents: Math.round(lineCents / line.quantity) }];
          }),
        });
      }
      if ((page.orders ?? []).length < ORDER_PAGE_SIZE) return orders;
    }
  }

  async uploadTracking(orderExternalId: string, tracking: TrackingUpload): Promise<void> {
    await this.client.request(
      {
        method: "POST",
        path: `/sell/fulfillment/v1/order/${encodeURIComponent(orderExternalId)}/shipping_fulfillment`,
        token: "user",
        body: {
          lineItems: tracking.lines.map((line) => ({ lineItemId: line.externalLineId, quantity: line.quantity })),
          shippedDate: this.now().toISOString(),
          // eBay accepts only letters and digits in carrier codes and tracking numbers.
          shippingCarrierCode: tracking.carrier.replace(/[^A-Za-z0-9]/g, ""),
          trackingNumber: tracking.trackingNumber.replace(/[^A-Za-z0-9]/g, ""),
        },
      },
      noContent,
    );
  }

  /** eBay reports seller standards as percentages; cancellations and returns are not part of that profile. */
  async getAccountHealth(): Promise<AccountHealthMetrics> {
    const result = await this.client.request(
      { method: "GET", path: "/sell/analytics/v1/seller_standards_profile", token: "user" },
      standardsSchema,
    );
    const profiles = result.standardsProfiles ?? [];
    const profile =
      profiles.find((candidate) => candidate.program === "PROGRAM_US" && candidate.cycle?.cycleType === "CURRENT") ??
      profiles.find((candidate) => candidate.program === "PROGRAM_US") ??
      profiles[0];
    const rate = (metricKey: string): number | null => {
      const raw = profile?.metrics?.find((metric) => metric.metricKey === metricKey)?.value;
      if (typeof raw === "boolean") return null;
      const value = typeof raw === "object" && raw !== null ? raw.value : raw;
      const percent = Number(value);
      return value === undefined || value === null || value === "" || !Number.isFinite(percent) ? null : percent / 100;
    };
    return {
      defectRate: rate("DEFECTIVE_TRANSACTION_RATE"),
      lateShipmentRate: rate("SHIPPING_MISS_RATE"),
      validTrackingRate: rate("VALID_TRACKING_UPLOADED_WITHIN_HANDLING_RATE"),
      cancellationRate: null,
      returnRate: null,
    };
  }

  /**
   * The draft's item specifics plus every one the category requires: Brand is "Unbranded" and MPN "Does Not Apply" (we never sell a brand),
   * an allowed value the listing text names is taken as is, and the AI answers the rest.
   */
  private async completeRequiredAspects(
    categoryId: string,
    draft: Pick<ListingDraft, "title" | "description" | "itemSpecifics">,
    /** Names answered elsewhere: the options of a listing with variations. */
    answered: string[] = [],
  ): Promise<Record<string, string>> {
    const result = await this.client.request(
      {
        method: "GET",
        path: `/commerce/taxonomy/v1/category_tree/${CATEGORY_TREE_ID}/get_item_aspects_for_category`,
        token: "app",
        query: { category_id: categoryId },
      },
      itemAspectsSchema,
    );
    const given = new Set([...Object.keys(draft.itemSpecifics), ...answered].map((name) => name.toLowerCase()));
    const missing: RequiredAspect[] = (result.aspects ?? [])
      .filter((aspect) => aspect.aspectConstraint?.aspectRequired && !given.has(aspect.localizedAspectName.toLowerCase()))
      .map((aspect) => ({
        name: aspect.localizedAspectName,
        allowedValues: (aspect.aspectValues ?? []).map((value) => value.localizedValue),
        freeText: aspect.aspectConstraint?.aspectMode !== "SELECTION_ONLY",
      }));

    const filled: Record<string, string> = { ...draft.itemSpecifics };
    const text = `${draft.title}\n${draft.description}`;
    const unanswered: RequiredAspect[] = [];
    for (const aspect of missing) {
      if (aspect.name.toLowerCase() === "brand" && (aspect.freeText || aspect.allowedValues.includes("Unbranded"))) {
        filled[aspect.name] = "Unbranded";
        continue;
      }
      // An unbranded product has no manufacturer part number; this is eBay's own value for that.
      if (aspect.name.toLowerCase() === "mpn" && (aspect.freeText || aspect.allowedValues.includes(NO_MPN))) {
        filled[aspect.name] = NO_MPN;
        continue;
      }
      const named = aspect.allowedValues.filter((value) => mentions(text, value)).sort((a, b) => b.length - a.length)[0];
      if (named) filled[aspect.name] = named;
      else unanswered.push(aspect);
    }

    if (unanswered.length > 0 && this.aspectFiller) {
      Object.assign(filled, await this.aspectFiller.fillAspects({ title: draft.title, description: draft.description, aspects: unanswered }));
    }
    const stillMissing = unanswered.filter((aspect) => !filled[aspect.name]).map((aspect) => aspect.name);
    if (stillMissing.length > 0) {
      throw new Error(`eBay category ${categoryId} requires item specifics this listing has no value for: ${stillMissing.join(", ")}`);
    }
    return filled;
  }

  private async findOffer(sku: string) {
    try {
      const result = await this.client.request(
        { method: "GET", path: "/sell/inventory/v1/offer", token: "user", query: { sku, marketplace_id: EBAY_MARKETPLACE_ID } },
        offersSchema,
      );
      return result.offers?.[0] ?? null;
    } catch (error) {
      // eBay answers 404 when the SKU has no offer yet.
      if (error instanceof EbayApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async requireOffer(sku: string) {
    const offer = await this.findOffer(sku);
    if (!offer) throw new Error(`eBay has no offer for SKU ${sku}`);
    return offer;
  }

  /** The public key eBay signs its notifications with, as PEM text. */
  async getNotificationPublicKey(keyId: string): Promise<string> {
    const result = await this.client.request(
      { method: "GET", path: `/commerce/notification/v1/public_key/${encodeURIComponent(keyId)}`, token: "app" },
      z.object({ key: z.string() }),
    );
    return result.key;
  }

  /** Fails with a list of what is missing when the seller account cannot list yet. */
  async checkSellerSetup(): Promise<{ fulfillmentPolicyHandlingDays: number[] }> {
    const setup = await this.sellerSetup();
    return { fulfillmentPolicyHandlingDays: setup.fulfillmentPolicies.map((policy) => policy.handlingDays) };
  }

  /** Business policies and the inventory location rarely change; they are read once per process. */
  private sellerSetup(): Promise<SellerSetup> {
    this.setup ??= this.loadSellerSetup().catch((error: unknown) => {
      this.setup = null;
      throw error;
    });
    return this.setup;
  }

  private async loadSellerSetup(): Promise<SellerSetup> {
    const query = { marketplace_id: EBAY_MARKETPLACE_ID };
    const fulfillment = await this.client.request({ method: "GET", path: "/sell/account/v1/fulfillment_policy", token: "user", query }, fulfillmentPoliciesSchema);
    const payment = await this.client.request({ method: "GET", path: "/sell/account/v1/payment_policy", token: "user", query }, paymentPoliciesSchema);
    const returns = await this.client.request({ method: "GET", path: "/sell/account/v1/return_policy", token: "user", query }, returnPoliciesSchema);
    const locations = await this.client.request({ method: "GET", path: "/sell/inventory/v1/location", token: "user" }, locationsSchema);

    const paymentPolicyId = payment.paymentPolicies?.[0]?.paymentPolicyId;
    const returnPolicyId = returns.returnPolicies?.[0]?.returnPolicyId;
    const location = (locations.locations ?? []).find((candidate) => candidate.merchantLocationStatus !== "DISABLED");
    const fulfillmentPolicies = (fulfillment.fulfillmentPolicies ?? [])
      .flatMap((policy) =>
        policy.handlingTime?.unit === "DAY" ? [{ fulfillmentPolicyId: policy.fulfillmentPolicyId, handlingDays: policy.handlingTime.value }] : [],
      )
      .sort((a, b) => a.handlingDays - b.handlingDays);

    const missing = [
      fulfillmentPolicies.length === 0 && "a fulfillment policy with a handling time in days",
      !paymentPolicyId && "a payment policy",
      !returnPolicyId && "a return policy",
      !location && "an inventory location",
    ].filter((item): item is string => Boolean(item));
    if (missing.length > 0 || !paymentPolicyId || !returnPolicyId || !location) {
      throw new Error(`The eBay account is not ready for listing. It needs: ${missing.join(", ")}.`);
    }
    return { fulfillmentPolicies, paymentPolicyId, returnPolicyId, merchantLocationKey: location.merchantLocationKey };
  }
}
