export interface SupplierProductSummary {
  externalId: string;
  title: string;
  category: string | null;
  mainImageUrl: string;
  fromCostCents: number;
}

export interface SupplierSearchQuery {
  /** Omit to browse (for example the trending list) without a search term. */
  keyword?: string;
  page?: number;
  pageSize?: number;
  trending?: boolean;
  /** Only products with stock in a warehouse in this country (e.g. "US"). */
  stockedIn?: string;
}

export interface SupplierProduct {
  externalId: string;
  title: string;
  description: string;
  category: string | null;
  isPersonalized: boolean;
  /** Every product photo, main image first. Only the first ones are cached for matching; listings use them all. */
  imageUrls: string[];
  /** Pictures inside the supplier's description (feature and size charts), in order. */
  detailImageUrls: string[];
}

export interface SupplierVariant {
  externalId: string;
  productExternalId: string;
  sku: string;
  attributes: Record<string, string>;
  costCents: number;
  currency: string;
  /** Warehouse country codes that stock this variant, e.g. ["US", "CN"]. */
  warehouses: string[];
  /** Days before the supplier hands the parcel to the carrier; longer for personalized items. */
  processingDays: number;
  imageUrl: string | null;
}

export interface SupplierStockAndPrice {
  variantExternalId: string;
  costCents: number;
  currency: string;
  stockByWarehouse: Record<string, number>;
}

export interface SupplierShippingOption {
  name: string;
  warehouse: string;
  destinationCountry: string;
  costCents: number;
  deliveryDaysMin: number;
  deliveryDaysMax: number;
}

export interface SupplierAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
}

export interface SupplierOrderInput {
  /** Retrying with the same key must return the original order, never a second one. */
  idempotencyKey: string;
  items: { variantExternalId: string; quantity: number }[];
  shippingAddress: SupplierAddress;
  /** Name and origin warehouse of the option chosen from getShippingOptions. */
  shippingOptionName: string;
  warehouse: string;
  /** No supplier branding, invoice or price in the parcel. Required for Amazon orders. */
  blindShipping: boolean;
  /** True: the supplier takes the money from the account balance and starts fulfilment. False: the order is created unpaid and waits for a manual payment at the supplier. */
  payFromBalance: boolean;
}

export interface SupplierOrderResult {
  supplierOrderId: string;
  costCents: number;
  shippingCents: number;
}

export type SupplierTrackingStatus = "PENDING" | "SHIPPED" | "DELIVERED" | "CANCELLED";

export interface SupplierTracking {
  supplierOrderId: string;
  status: SupplierTrackingStatus;
  trackingNumber: string | null;
  carrier: string | null;
  events: { status: string; description: string; location: string | null; occurredAt: Date }[];
}

export type SupplierErrorCode =
  | "NOT_FOUND"
  | "OUT_OF_STOCK"
  | "ADDRESS_INVALID"
  | "SHIPPING_UNAVAILABLE"
  | "INSUFFICIENT_BALANCE"
  /** The supplier accepted the order but is holding it for manual review. */
  | "ORDER_HELD"
  | "UNKNOWN";

export class SupplierError extends Error {
  constructor(
    readonly code: SupplierErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SupplierError";
  }
}

export interface SupplierAdapter {
  /** Matches Supplier.code in the database. */
  readonly code: string;
  /** `trending: true` limits the search to the supplier's trending products. */
  searchProducts(query: SupplierSearchQuery): Promise<SupplierProductSummary[]>;
  getProduct(externalId: string): Promise<SupplierProduct | null>;
  getVariants(productExternalId: string): Promise<SupplierVariant[]>;
  getStockAndPrice(variantExternalId: string): Promise<SupplierStockAndPrice>;
  getShippingOptions(variantExternalId: string, country: string): Promise<SupplierShippingOption[]>;
  placeOrder(input: SupplierOrderInput): Promise<SupplierOrderResult>;
  getTracking(supplierOrderId: string): Promise<SupplierTracking>;
}
