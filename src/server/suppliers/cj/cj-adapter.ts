import { z } from "zod";
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
  type SupplierTrackingStatus,
  type SupplierVariant,
} from "../types";
import { CJ_CODE, CjApiError, type CjClient } from "./client";
import {
  createOrderSchema,
  freightSchema,
  orderDetailSchema,
  productInventorySchema,
  productListSchema,
  productSchema,
  trackInfoSchema,
  variantStockSchema,
  variantWithInventorySchema,
} from "./schemas";

// CJ's API does not expose per-product processing time, so these are working
// assumptions: stocked items leave the warehouse within a few days, and
// personalized items are made to order first.
const PROCESSING_DAYS = { standard: 3, personalized: 7 };

const imageListSchema = z.array(z.string());

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

/** "11.85", 11.85 or a range like "1.20-3.50" (lowest price) → cents. */
function toCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const first = typeof value === "number" ? value : Number(value.split("-")[0]);
  return Number.isFinite(first) ? Math.round(first * 100) : null;
}

function requireCents(value: string | number | null | undefined, what: string): number {
  const cents = toCents(value);
  if (cents === null) throw new SupplierError("UNKNOWN", `CJ returned no usable ${what}`);
  return cents;
}

/** "2-5" → {min: 2, max: 5}; "7" → {min: 7, max: 7}; anything else → null. */
function parseDeliveryDays(aging: string | null | undefined): { min: number; max: number } | null {
  const match = aging?.match(/^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/);
  if (!match) return null;
  const min = Number(match[1]);
  return { min, max: match[2] === undefined ? min : Number(match[2]) };
}

/** The pictures a CJ description embeds, in order, without repeats. */
function descriptionImages(html: string): string[] {
  const urls = [...html.matchAll(/<img[^>]+src=["'](https:\/\/[^"']+)["']/gi)].map((match) => match[1]);
  return urls.filter((url, index) => urls.indexOf(url) === index);
}

/** CJ descriptions are HTML; listings and spec extraction want plain text. */
function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Pairs option names ("Color-Size") with a variant's values ("Black-XXL"). */
function variantAttributes(optionNames: string | null | undefined, variantKey: string | null | undefined): Record<string, string> {
  if (!variantKey) return {};
  const names = optionNames?.split("-") ?? [];
  const values = variantKey.split("-");
  // A value that itself contains "-" makes the split ambiguous; keep it whole rather than mislabel it.
  if (names.length !== values.length) return { option: variantKey };
  return Object.fromEntries(names.map((name, index) => [name.trim().toLowerCase(), values[index].trim()]));
}

type CjProduct = z.infer<typeof productSchema>;

/**
 * CJ marks made-to-order products in several ways: the DIY product type, a POD
 * ("print on demand") logistics attribute, or a customization template.
 */
function isPersonalized(product: CjProduct): boolean {
  return (
    product.productType === "DIY_PRODUCT" ||
    (product.productProEnSet ?? []).some((attribute) => attribute.toUpperCase().startsWith("POD")) ||
    [product.customizationJson1, product.customizationJson2, product.customizationJson3, product.customizationJson4].some(Boolean)
  );
}

/** Image URLs in the supplier's own order, main image first. */
function orderedImages(product: CjProduct): string[] {
  let ordered: string[] = [];
  if (product.productImage) {
    try {
      const parsed = imageListSchema.safeParse(JSON.parse(product.productImage));
      if (parsed.success) ordered = parsed.data;
    } catch {
      // Older products carry a single plain URL here instead of a JSON list.
      ordered = [product.productImage];
    }
  }
  if (ordered.length === 0) ordered = product.productImageSet ?? [];
  const all = product.bigImage ? [product.bigImage, ...ordered] : ordered;
  return all.filter((url, index) => url.startsWith("http") && all.indexOf(url) === index);
}

/** CJ timestamps without an offset ("2021-08-23 11:31:45") are UTC. */
function parseCjDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const hasOffset = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
  const date = new Date(hasOffset ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function trackingStatus(orderStatus: string): SupplierTrackingStatus {
  switch (orderStatus.toUpperCase()) {
    case "SHIPPED":
      return "SHIPPED";
    case "DELIVERED":
      return "DELIVERED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "PENDING";
  }
}

/** Translates CJ error codes into the supplier-neutral errors the pipeline acts on. */
function toSupplierError(error: unknown, context: string): unknown {
  if (!(error instanceof CjApiError)) return error;
  const message = `${context}: ${error.message}`;
  switch (error.code) {
    case CJ_CODE.VARIANT_NOT_FOUND:
    case CJ_CODE.PRODUCT_NOT_FOUND:
    case CJ_CODE.ORDER_NOT_FOUND:
      return new SupplierError("NOT_FOUND", message);
    case CJ_CODE.PRODUCT_REMOVED:
    case CJ_CODE.VARIANT_REMOVED:
    case CJ_CODE.INVENTORY_DEDUCTION_FAILED:
      return new SupplierError("OUT_OF_STOCK", message);
    case CJ_CODE.BALANCE_INSUFFICIENT:
      return new SupplierError("INSUFFICIENT_BALANCE", message);
    case CJ_CODE.LOGISTIC_NOT_FOUND:
    case CJ_CODE.LOGISTIC_INVALID:
      return new SupplierError("SHIPPING_UNAVAILABLE", message);
    default:
      return new SupplierError("UNKNOWN", message);
  }
}

export interface CjAdapterOptions {
  /** Sandbox orders are accepted by CJ but never charged, shipped or fulfilled. */
  sandboxOrders: boolean;
}

/** CJ Dropshipping API v2 behind the supplier-neutral adapter interface. */
export class CjSupplierAdapter implements SupplierAdapter {
  readonly code = "cj";

  constructor(
    private readonly client: CjClient,
    private readonly options: CjAdapterOptions,
  ) {}

  async searchProducts(query: SupplierSearchQuery): Promise<SupplierProductSummary[]> {
    const data = await this.call("Product search", () =>
      this.client.request(
        {
          method: "GET",
          path: "product/listV2",
          query: {
            keyWord: query.keyword,
            page: query.page ?? 1,
            size: query.pageSize ?? 20,
            // productFlag 0 = CJ's "trending products" list.
            productFlag: query.trending ? 0 : undefined,
            countryCode: query.stockedIn,
          },
        },
        productListSchema,
      ),
    );
    return (data.content ?? [])
      .flatMap((group) => group.productList)
      .flatMap((product) => {
        const fromCostCents = toCents(product.nowPrice) ?? toCents(product.sellPrice);
        if (fromCostCents === null) return [];
        return [
          {
            externalId: product.id,
            title: product.nameEn,
            category: product.threeCategoryName ?? null,
            mainImageUrl: product.bigImage,
            fromCostCents,
          },
        ];
      });
  }

  async getProduct(externalId: string): Promise<SupplierProduct | null> {
    const product = await this.queryProduct(externalId);
    if (!product) return null;
    const images = orderedImages(product);
    return {
      externalId: product.pid,
      title: product.productNameEn,
      description: htmlToText(product.description ?? ""),
      detailImageUrls: descriptionImages(product.description ?? ""),
      category: product.categoryName ?? null,
      isPersonalized: isPersonalized(product),
      imageUrls: images,
    };
  }

  async getVariants(productExternalId: string): Promise<SupplierVariant[]> {
    const product = await this.queryProduct(productExternalId);
    if (!product) return [];
    const inventory = await this.call("Inventory query", () =>
      this.client.request(
        { method: "GET", path: "product/stock/getInventoryByPid", query: { pid: productExternalId } },
        productInventorySchema,
      ),
    );
    const warehousesByVariant = new Map(
      (inventory.variantInventories ?? []).map((entry) => [
        entry.vid,
        (entry.inventory ?? []).filter((stock) => (stock.totalInventory ?? 0) > 0).map((stock) => stock.countryCode),
      ]),
    );
    const processingDays = isPersonalized(product) ? PROCESSING_DAYS.personalized : PROCESSING_DAYS.standard;

    return (product.variants ?? []).map((variant) => ({
      externalId: variant.vid,
      productExternalId: product.pid,
      sku: variant.variantSku,
      attributes: variantAttributes(product.productKeyEn, variant.variantKey),
      costCents: requireCents(variant.variantSellPrice, `price for variant ${variant.vid}`),
      currency: "USD",
      warehouses: warehousesByVariant.get(variant.vid) ?? [],
      processingDays,
      imageUrl: variant.variantImage ?? null,
    }));
  }

  async getStockAndPrice(variantExternalId: string): Promise<SupplierStockAndPrice> {
    const variant = await this.call(`Variant ${variantExternalId}`, () =>
      this.client.request(
        { method: "GET", path: "product/variant/queryByVid", query: { vid: variantExternalId } },
        variantWithInventorySchema,
      ),
    );
    // The variant call usually comes back without inventories; the stock endpoint is the reliable source.
    const stock = await this.call(`Stock ${variantExternalId}`, () =>
      this.client.request(
        { method: "GET", path: "product/stock/queryByVid", query: { vid: variantExternalId } },
        variantStockSchema,
      ),
    );
    return {
      variantExternalId,
      costCents: requireCents(variant.variantSellPrice, `price for variant ${variantExternalId}`),
      currency: "USD",
      stockByWarehouse: Object.fromEntries(stock.map((entry) => [entry.countryCode, entry.totalInventoryNum ?? entry.storageNum ?? 0])),
    };
  }

  async getShippingOptions(variantExternalId: string, country: string): Promise<SupplierShippingOption[]> {
    const { stockByWarehouse } = await this.getStockAndPrice(variantExternalId);
    const warehouses = Object.entries(stockByWarehouse)
      .filter(([, quantity]) => quantity > 0)
      .map(([warehouse]) => warehouse);

    const options: SupplierShippingOption[] = [];
    for (const warehouse of warehouses) {
      const quotes = await this.call(`Freight ${warehouse}→${country}`, () =>
        this.client.request(
          {
            method: "POST",
            path: "logistic/freightCalculate",
            body: { startCountryCode: warehouse, endCountryCode: country, products: [{ vid: variantExternalId, quantity: 1 }] },
          },
          freightSchema,
        ),
      );
      for (const quote of quotes) {
        const days = parseDeliveryDays(quote.logisticAging);
        const costCents = toCents(quote.logisticPrice);
        // Without a delivery estimate we cannot check the marketplace promise, so the option is unusable.
        if (!days || costCents === null) continue;
        options.push({
          name: quote.logisticName,
          warehouse,
          destinationCountry: country,
          costCents,
          deliveryDaysMin: days.min,
          deliveryDaysMax: days.max,
        });
      }
    }
    return options;
  }

  async placeOrder(input: SupplierOrderInput): Promise<SupplierOrderResult> {
    const address = input.shippingAddress;
    const body = {
      orderNumber: input.idempotencyKey,
      shippingCustomerName: address.name,
      shippingAddress: address.line1,
      shippingAddress2: address.line2 ?? "",
      shippingCity: address.city,
      shippingProvince: address.state,
      shippingZip: address.postalCode,
      shippingCountryCode: address.country,
      shippingCountry: REGION_NAMES.of(address.country) ?? address.country,
      shippingPhone: address.phone ?? "",
      logisticName: input.shippingOptionName,
      fromCountryCode: input.warehouse,
      // 2 = pay from the CJ balance, so the order goes straight to fulfilment.
      // 3 = create the order only; it waits at CJ until it is paid there (card or PayPal).
      payType: input.payFromBalance ? 2 : 3,
      isSandbox: this.options.sandboxOrders ? 1 : 0,
      remark: input.blindShipping
        ? "Blind dropshipping order: no invoice, price, receipt or supplier branding in the parcel."
        : "",
      products: input.items.map((item) => ({ vid: item.variantExternalId, quantity: item.quantity })),
    };

    let created;
    try {
      created = await this.client.request(
        { method: "POST", path: "shopping/order/createOrderV2", body },
        createOrderSchema,
      );
    } catch (error) {
      if (error instanceof CjApiError && error.code === CJ_CODE.ORDER_EXISTS) {
        // A retry of an order CJ already has: return the original instead of failing.
        return this.existingOrder(input.idempotencyKey);
      }
      if (error instanceof CjApiError && error.code === CJ_CODE.PARAM_ERROR) {
        throw new SupplierError("ADDRESS_INVALID", `CJ rejected the order details: ${error.message}`);
      }
      throw toSupplierError(error, "Order creation");
    }

    const held = created.interceptOrderReasons?.filter((reason) => reason.message) ?? [];
    if (held.length > 0) {
      throw new SupplierError(
        "ORDER_HELD",
        `CJ order ${created.orderId} is held: ${held.map((reason) => reason.message).join("; ")}`,
      );
    }

    const costCents = toCents(created.productAmount);
    const shippingCents = toCents(created.postageAmount);
    if (costCents === null || shippingCents === null) return this.existingOrder(created.orderId);
    return { supplierOrderId: created.orderId, costCents, shippingCents };
  }

  async getTracking(supplierOrderId: string): Promise<SupplierTracking> {
    const order = await this.orderDetail(supplierOrderId);
    const status = trackingStatus(order.orderStatus);
    const events: SupplierTracking["events"] = [];

    const createdAt = parseCjDate(order.createDate);
    if (createdAt) events.push({ status: "CREATED", description: "Order created at CJ", location: null, occurredAt: createdAt });
    const paidAt = parseCjDate(order.paymentDate);
    if (paidAt) events.push({ status: "PAID", description: "Order paid", location: null, occurredAt: paidAt });

    if (order.trackNumber && status === "DELIVERED") {
      const [track] = await this.call(`Tracking ${order.trackNumber}`, () =>
        this.client.request(
          { method: "GET", path: "logistic/trackInfo", query: { trackNumber: order.trackNumber ?? undefined } },
          trackInfoSchema,
        ),
      );
      const deliveredAt = parseCjDate(track?.deliveryTime);
      if (deliveredAt) {
        events.push({
          status: "DELIVERED",
          description: track?.trackingStatus ?? "Delivered",
          location: track?.trackingTo ?? null,
          occurredAt: deliveredAt,
        });
      }
    }

    return {
      supplierOrderId: order.orderId,
      status,
      trackingNumber: order.trackNumber ?? null,
      carrier: order.logisticName ?? null,
      events,
    };
  }

  private async queryProduct(pid: string) {
    try {
      return await this.client.request({ method: "GET", path: "product/query", query: { pid } }, productSchema);
    } catch (error) {
      if (error instanceof CjApiError && error.code === CJ_CODE.PRODUCT_NOT_FOUND) return null;
      throw toSupplierError(error, `Product ${pid}`);
    }
  }

  /** getOrderDetail accepts either CJ's order id or our own order number. */
  private orderDetail(orderIdOrNumber: string) {
    return this.call(`Order ${orderIdOrNumber}`, () =>
      this.client.request(
        { method: "GET", path: "shopping/order/getOrderDetail", query: { orderId: orderIdOrNumber } },
        orderDetailSchema,
      ),
    );
  }

  private async existingOrder(orderIdOrNumber: string): Promise<SupplierOrderResult> {
    const order = await this.orderDetail(orderIdOrNumber);
    return {
      supplierOrderId: order.orderId,
      costCents: requireCents(order.productAmount, `product amount for order ${order.orderId}`),
      shippingCents: requireCents(order.postageAmount, `postage amount for order ${order.orderId}`),
    };
  }

  private async call<T>(context: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw toSupplierError(error, context);
    }
  }
}
