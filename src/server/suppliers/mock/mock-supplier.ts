import {
  mockSearchTags,
  mockTrendingProductIds,
  necklaceProduct,
  necklaceShipping,
  necklaceStock,
  necklaceVariants,
} from "../../mocks/fixtures/necklace";
import {
  type SupplierAdapter,
  SupplierError,
  type SupplierOrderInput,
  type SupplierOrderResult,
  type SupplierProduct,
  type SupplierProductSummary,
  type SupplierSearchQuery,
  type SupplierShippingOption,
  type SupplierStockAndPrice,
  type SupplierTracking,
  type SupplierVariant,
} from "../types";

interface PlacedOrder {
  result: SupplierOrderResult;
  placedAt: Date;
}

/**
 * In-memory stand-in for CJ Dropshipping. State lives in the process, so tests
 * and the mock pipeline can simulate supplier price and stock changes.
 */
export class MockSupplierAdapter implements SupplierAdapter {
  readonly code = "cj";

  private readonly products: SupplierProduct[] = [necklaceProduct];
  private readonly variants: SupplierVariant[] = structuredClone(necklaceVariants);
  private readonly stock: Record<string, Record<string, number>> = structuredClone(necklaceStock);
  private readonly shipping: Record<string, SupplierShippingOption[]> = necklaceShipping;
  private readonly ordersByKey = new Map<string, PlacedOrder>();

  async searchProducts(query: SupplierSearchQuery): Promise<SupplierProductSummary[]> {
    const keyword = (query.keyword ?? "").toLowerCase().trim();
    const words = keyword.split(/\s+/).filter(Boolean);
    const pageSize = query.pageSize ?? 20;
    const start = ((query.page ?? 1) - 1) * pageSize;
    return this.products
      .filter((product) => {
        if (query.trending && !mockTrendingProductIds.has(product.externalId)) return false;
        if (query.stockedIn && !this.hasStockIn(product.externalId, query.stockedIn)) return false;
        // Occasion searches ("valentines day gift") match by tag, as a real catalog search would.
        if (mockSearchTags[product.externalId]?.includes(keyword)) return true;
        const haystack = `${product.title} ${product.description}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .slice(start, start + pageSize)
      .map((product) => ({
        externalId: product.externalId,
        title: product.title,
        category: product.category,
        mainImageUrl: product.imageUrls[0],
        fromCostCents: Math.min(
          ...this.variants.filter((v) => v.productExternalId === product.externalId).map((v) => v.costCents),
        ),
      }));
  }

  async getProduct(externalId: string): Promise<SupplierProduct | null> {
    return this.products.find((product) => product.externalId === externalId) ?? null;
  }

  async getVariants(productExternalId: string): Promise<SupplierVariant[]> {
    return this.variants.filter((variant) => variant.productExternalId === productExternalId);
  }

  async getStockAndPrice(variantExternalId: string): Promise<SupplierStockAndPrice> {
    const variant = this.requireVariant(variantExternalId);
    return {
      variantExternalId,
      costCents: variant.costCents,
      currency: variant.currency,
      stockByWarehouse: { ...this.stock[variantExternalId] },
    };
  }

  async getShippingOptions(variantExternalId: string, country: string): Promise<SupplierShippingOption[]> {
    this.requireVariant(variantExternalId);
    return (this.shipping[variantExternalId] ?? []).filter((option) => option.destinationCountry === country);
  }

  async placeOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    const existing = this.ordersByKey.get(input.idempotencyKey);
    if (existing) return existing.result;

    if (!input.shippingAddress.postalCode || !input.shippingAddress.line1) {
      throw new SupplierError("ADDRESS_INVALID", "Shipping address is missing a street or postal code");
    }

    let costCents = 0;
    let shippingCents = 0;
    const reservations: { variantExternalId: string; warehouse: string; quantity: number }[] = [];
    for (const item of input.items) {
      const variant = this.requireVariant(item.variantExternalId);
      const option = (this.shipping[item.variantExternalId] ?? []).find(
        (candidate) =>
          candidate.name === input.shippingOptionName &&
          candidate.warehouse === input.warehouse &&
          candidate.destinationCountry === input.shippingAddress.country,
      );
      if (!option) {
        throw new SupplierError(
          "SHIPPING_UNAVAILABLE",
          `Shipping option "${input.shippingOptionName}" is not available for ${item.variantExternalId}`,
        );
      }
      const available = this.stock[item.variantExternalId]?.[option.warehouse] ?? 0;
      if (available < item.quantity) {
        throw new SupplierError("OUT_OF_STOCK", `${item.variantExternalId} is out of stock in ${option.warehouse}`);
      }
      costCents += variant.costCents * item.quantity;
      shippingCents += option.costCents;
      reservations.push({ variantExternalId: item.variantExternalId, warehouse: option.warehouse, quantity: item.quantity });
    }

    // Only touch stock once every line has been validated.
    for (const reservation of reservations) {
      this.stock[reservation.variantExternalId][reservation.warehouse] -= reservation.quantity;
    }

    const result: SupplierOrderResult = {
      // Derived from the idempotency key so ids stay unique across processes and restarts.
      supplierOrderId: `MOCK-CJ-${input.idempotencyKey}`,
      costCents,
      shippingCents,
    };
    this.ordersByKey.set(input.idempotencyKey, { result, placedAt: new Date() });
    return result;
  }

  async getTracking(supplierOrderId: string): Promise<SupplierTracking> {
    const order = [...this.ordersByKey.values()].find((placed) => placed.result.supplierOrderId === supplierOrderId);
    // The app and the worker each hold their own mock: an order placed by the other process is still a mock order.
    if (!order && !supplierOrderId.startsWith("MOCK-CJ-")) {
      throw new SupplierError("NOT_FOUND", `Unknown supplier order ${supplierOrderId}`);
    }
    // The mock supplier ships instantly so the order pipeline can run end to end.
    return {
      supplierOrderId,
      status: "SHIPPED",
      trackingNumber: `MOCKTRK${supplierOrderId.replace(/[^A-Za-z0-9]/g, "").slice(-12).toUpperCase()}`,
      carrier: "USPS",
      events: order
        ? [{ status: "SHIPPED", description: "Parcel handed to carrier", location: "US warehouse", occurredAt: order.placedAt }]
        : [],
    };
  }

  /** Simulation hook: supplier changes its price. */
  setCost(variantExternalId: string, costCents: number): void {
    this.requireVariant(variantExternalId).costCents = costCents;
  }

  /** Simulation hook: supplier stock changes in one warehouse. */
  setStock(variantExternalId: string, warehouse: string, quantity: number): void {
    this.requireVariant(variantExternalId);
    this.stock[variantExternalId] = { ...this.stock[variantExternalId], [warehouse]: quantity };
  }

  private hasStockIn(productExternalId: string, country: string): boolean {
    return this.variants.some(
      (variant) => variant.productExternalId === productExternalId && (this.stock[variant.externalId]?.[country] ?? 0) > 0,
    );
  }

  private requireVariant(variantExternalId: string): SupplierVariant {
    const variant = this.variants.find((candidate) => candidate.externalId === variantExternalId);
    if (!variant) throw new SupplierError("NOT_FOUND", `Unknown variant ${variantExternalId}`);
    return variant;
  }
}
