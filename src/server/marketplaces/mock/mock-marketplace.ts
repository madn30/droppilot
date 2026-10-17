import type { Marketplace } from "@prisma/client";
import { necklaceCompetitors } from "../../mocks/fixtures/necklace";
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

interface MockListing extends ListingDraft {
  externalId: string;
  ended: boolean;
}

// Words too common to tell one product from another in a keyword search.
const STOP_WORDS = new Set(["for", "with", "and", "the", "a", "of", "women", "gift"]);

/**
 * In-memory stand-in for one marketplace. Competitor search is served from
 * fixtures; listings, orders and tracking live in the process so the pipeline
 * can be driven end to end.
 */
class MockMarketplaceAdapter implements MarketplaceAdapter {
  private readonly listings = new Map<string, MockListing>();
  /** The variations of listings published with options, by SKU; they share their listing's externalId. */
  private readonly variations = new Map<string, MockListing & { options: Record<string, string>; groupKey: string }>();
  private readonly orders: MarketplaceOrder[] = [];
  /** Inspection hook: how many listing updates the marketplace has received. */
  updateCalls = 0;
  private readonly tracking = new Map<string, TrackingUpload>();
  private health: AccountHealthMetrics = { lateShipmentRate: 0.004, cancellationRate: 0.002, validTrackingRate: 0.995, defectRate: 0.001, returnRate: 0.012 };

  constructor(
    readonly marketplace: Marketplace,
    private readonly competitors: CompetitorCandidate[],
  ) {}

  async searchByKeyword(keyword: string, limit: number): Promise<CompetitorCandidate[]> {
    const words = keyword
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word && !STOP_WORDS.has(word));
    return this.competitors
      .filter((listing) => {
        const title = listing.title.toLowerCase();
        return words.some((word) => title.includes(word));
      })
      .slice(0, limit);
  }

  async listCandidateIds(keyword: string, limit: number): Promise<string[]> {
    return (await this.searchByKeyword(keyword, limit)).map((listing) => listing.externalId);
  }

  async publishListing(draft: ListingDraft): Promise<{ externalId: string }> {
    const existing = [...this.listings.values()].find((listing) => listing.sku === draft.sku && !listing.ended);
    if (existing) {
      Object.assign(existing, draft);
      return { externalId: existing.externalId };
    }
    // Derived from the SKU so ids stay unique across processes and restarts.
    const externalId = `MOCK-${this.marketplace}-${draft.sku}`;
    this.listings.set(externalId, { ...draft, externalId, ended: false });
    return { externalId };
  }

  async updateListing(listing: ListingRef, update: ListingUpdate): Promise<void> {
    Object.assign(this.requireListing(listing), update);
    this.updateCalls++;
  }

  async endListing(listing: ListingRef): Promise<void> {
    if (listing.groupKey) {
      for (const variation of this.variations.values()) if (variation.groupKey === listing.groupKey) variation.ended = true;
      return;
    }
    this.requireListing(listing).ended = true;
  }

  async getOrders(since: Date): Promise<MarketplaceOrder[]> {
    return this.orders.filter((order) => order.orderedAt >= since);
  }

  async uploadTracking(orderExternalId: string, tracking: TrackingUpload): Promise<void> {
    if (!this.orders.some((order) => order.externalId === orderExternalId)) {
      // An order created in another process (see requireListing) is accepted as well.
      if (!orderExternalId.startsWith("MOCK-")) throw new Error(`Unknown ${this.marketplace} order ${orderExternalId}`);
    }
    this.tracking.set(orderExternalId, tracking);
  }

  async getAccountHealth(): Promise<AccountHealthMetrics> {
    return { ...this.health };
  }

  protected storeVariations(draft: VariationListingDraft): { externalId: string } {
    const externalId = `MOCK-${this.marketplace}-${draft.groupKey}`;
    for (const variation of draft.variations) {
      this.variations.set(variation.sku, {
        sku: variation.sku,
        title: draft.title,
        description: draft.description,
        priceCents: variation.priceCents,
        quantity: variation.quantity,
        imageUrls: draft.imageUrls,
        detailImageUrls: draft.detailImageUrls,
        itemSpecifics: draft.itemSpecifics,
        handlingDays: draft.handlingDays,
        deliveryDaysMax: draft.deliveryDaysMax,
        options: variation.options,
        groupKey: draft.groupKey,
        externalId,
        ended: false,
      });
    }
    return { externalId };
  }

  /** Simulation hook: the marketplace reports different account health. */
  setAccountHealth(health: Partial<AccountHealthMetrics>): void {
    this.health = { ...this.health, ...health };
  }

  /** Simulation hook: a buyer places an order. */
  simulateOrder(order: MarketplaceOrder): void {
    this.orders.push(order);
  }

  /** Inspection hook: the listing as the marketplace currently shows it. */
  getListing(externalId: string): Readonly<MockListing> | undefined {
    return this.listings.get(externalId);
  }

  /** Inspection hook: one variation of a listing with options, as the marketplace currently shows it. */
  getVariation(sku: string): Readonly<MockListing & { options: Record<string, string>; groupKey: string }> | undefined {
    return this.variations.get(sku);
  }

  /** Inspection hook: tracking uploaded for an order. */
  getUploadedTracking(orderExternalId: string): TrackingUpload | undefined {
    return this.tracking.get(orderExternalId);
  }

  private requireListing(ref: ListingRef): MockListing {
    const known = this.variations.get(ref.sku) ?? this.listings.get(ref.externalId);
    if (known) return known;
    // The app and the worker each hold their own mock: a listing published by the other process is adopted on first use.
    if (!ref.externalId.startsWith(`MOCK-${this.marketplace}-`)) {
      throw new Error(`Unknown ${this.marketplace} listing ${ref.externalId}`);
    }
    const adopted: MockListing = {
      externalId: ref.externalId,
      sku: ref.sku,
      title: "",
      description: "",
      priceCents: 0,
      quantity: 0,
      imageUrls: [],
      detailImageUrls: [],
      itemSpecifics: {},
      handlingDays: 0,
      deliveryDaysMax: 0,
      ended: false,
    };
    this.listings.set(ref.externalId, adopted);
    return adopted;
  }
}

export class MockEbayAdapter extends MockMarketplaceAdapter {
  constructor() {
    super("EBAY", necklaceCompetitors.filter((listing) => listing.marketplace === "EBAY"));
  }

  async publishVariations(draft: VariationListingDraft): Promise<{ externalId: string }> {
    return this.storeVariations(draft);
  }

  async getSoldQuantities(keyword: string): Promise<Map<string, number>> {
    const listings = await this.searchByKeyword(keyword, 200);
    return new Map(listings.flatMap((listing) => (listing.soldCount === null ? [] : [[listing.externalId, listing.soldCount] as const])));
  }

  // The mock cannot see into the image, so it returns the visually similar
  // listings a real image search would surface: every fixture competitor.
  async searchByImage(_image: Uint8Array, limit: number): Promise<CompetitorCandidate[]> {
    return necklaceCompetitors.filter((listing) => listing.marketplace === "EBAY").slice(0, limit);
  }
}

export class MockAmazonAdapter extends MockMarketplaceAdapter {
  constructor() {
    super("AMAZON", necklaceCompetitors.filter((listing) => listing.marketplace === "AMAZON"));
  }
}
