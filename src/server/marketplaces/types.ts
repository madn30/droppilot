import type { Marketplace } from "@prisma/client";

export interface CompetitorCandidate {
  marketplace: Marketplace;
  /** eBay item ID or Amazon ASIN. */
  externalId: string;
  title: string;
  description: string;
  url: string;
  priceCents: number;
  shippingCents: number;
  currency: string;
  deliveryDays: number | null;
  sellerRating: number | null;
  soldCount: number | null;
  imageUrls: string[];
  itemSpecifics: Record<string, string>;
  /** True when this is one choice (colour, size, …) of a listing with variations: its specifics and price are that choice's. */
  isVariation?: boolean;
}

export interface ListingDraft {
  sku: string;
  title: string;
  description: string;
  priceCents: number;
  quantity: number;
  imageUrls: string[];
  /** Pictures for the description (feature and size charts), where the marketplace allows them. */
  detailImageUrls: string[];
  itemSpecifics: Record<string, string>;
  handlingDays: number;
  deliveryDaysMax: number;
  /** The marketplace's catalog id (Amazon ASIN) of a confirmed identical product, to list against instead of creating a new one. */
  existingProductId?: string;
}

/** One buyer-selectable option of a listing with variations. */
export interface VariationDraft {
  sku: string;
  /** What the buyer picks, e.g. { Color: "White" }. Every variation has the same names. */
  options: Record<string, string>;
  priceCents: number;
  quantity: number;
}

/** A listing whose buyers choose between variations (colour, size, …), each with its own SKU, price and stock. */
export interface VariationListingDraft {
  /** Our key for the group of variations; stable across re-publishing. */
  groupKey: string;
  title: string;
  description: string;
  imageUrls: string[];
  /** Pictures for the description (feature and size charts), where the marketplace allows them. */
  detailImageUrls: string[];
  /** Specifics every variation shares; the option names are not among them. */
  itemSpecifics: Record<string, string>;
  handlingDays: number;
  deliveryDaysMax: number;
  variations: VariationDraft[];
}

/** Identifies a published listing: the marketplace's own id plus our SKU (eBay addresses offers by SKU). */
export interface ListingRef {
  externalId: string;
  sku: string;
  /** Set when the SKU is one variation of a listing; title changes and ending then apply to the whole listing. */
  groupKey?: string | null;
}

export interface ListingUpdate {
  priceCents?: number;
  quantity?: number;
  title?: string;
  description?: string;
}

export interface MarketplaceAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
}

export interface MarketplaceOrder {
  externalId: string;
  orderedAt: Date;
  shipByDate: Date | null;
  buyerName: string;
  /** The buyer's account name on the marketplace, where it gives one. */
  buyerUsername?: string;
  shippingAddress: MarketplaceAddress;
  totalCents: number;
  currency: string;
  lines: { externalLineId: string; sku: string; quantity: number; priceCents: number }[];
}

/** Rates as fractions (0.01 = 1%). null = the marketplace does not report this metric. */
export interface AccountHealthMetrics {
  lateShipmentRate: number | null;
  cancellationRate: number | null;
  validTrackingRate: number | null;
  defectRate: number | null;
  returnRate: number | null;
}

export interface TrackingUpload {
  trackingNumber: string;
  carrier: string;
  /** The order lines in the parcel. */
  lines: { externalLineId: string; quantity: number }[];
}

export interface MarketplaceAdapter {
  readonly marketplace: Marketplace;
  searchByKeyword(keyword: string, limit: number): Promise<CompetitorCandidate[]>;
  /** eBay Browse only; Amazon has no official image search. */
  searchByImage?(image: Uint8Array, limit: number): Promise<CompetitorCandidate[]>;
  /**
   * Units sold in the last 90 days per listing id, for listings matching the keyword.
   * eBay only, and only with Marketplace Insights access.
   */
  getSoldQuantities?(keyword: string): Promise<Map<string, number>>;
  /** Ids of the listings a keyword search returns, without their details: a cheap way to notice new competitors. */
  listCandidateIds(keyword: string, limit: number): Promise<string[]>;
  publishListing(draft: ListingDraft): Promise<{ externalId: string }>;
  /** One listing with buyer-selectable variations. Marketplaces without it get one listing per variant. */
  publishVariations?(draft: VariationListingDraft): Promise<{ externalId: string }>;
  updateListing(listing: ListingRef, update: ListingUpdate): Promise<void>;
  endListing(listing: ListingRef): Promise<void>;
  getOrders(since: Date): Promise<MarketplaceOrder[]>;
  uploadTracking(orderExternalId: string, tracking: TrackingUpload): Promise<void>;
  getAccountHealth(): Promise<AccountHealthMetrics>;
}
