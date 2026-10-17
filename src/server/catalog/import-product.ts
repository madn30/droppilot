import type { Prisma } from "@prisma/client";
import { db } from "../db";
import { cacheImage } from "../images/cache";
import type { ImageFetcher } from "../images/fetcher";
import { logger } from "../logger";
import type { SupplierAdapter } from "../suppliers/types";
import { chooseShippingOption } from "./shipping-choice";

const MAX_IMAGES = 10;

export interface ImportDeps {
  supplier: SupplierAdapter;
  imageFetcher: ImageFetcher;
  imageCacheDir: string;
  /** Country the listings will ship to. */
  destinationCountry: string;
}

export interface ImportResult {
  productId: string;
  variantsImported: number;
  /** Variants with no stocked warehouse that ships to the destination. */
  variantsSkipped: string[];
  imagesCached: number;
  /** Image URLs that could not be downloaded; stored without a local copy. */
  imagesFailed: string[];
}

/**
 * Pulls one supplier product into the catalog: product, variants with cost,
 * shipping and delivery times, and a local copy of every image (max 10).
 * Safe to re-run: existing rows are updated in place.
 */
export async function importSupplierProduct(externalId: string, deps: ImportDeps): Promise<ImportResult> {
  const supplierRow = await db.supplier.findUnique({ where: { code: deps.supplier.code } });
  if (!supplierRow) throw new Error(`Supplier "${deps.supplier.code}" is not registered; run the seed`);
  // Compliance: only dropshipping suppliers may be sourced from, never retail stores.
  if (!supplierRow.isDropshipSupplier) {
    throw new Error(`Supplier "${supplierRow.code}" is not a dropshipping supplier; importing from it is not allowed`);
  }

  const product = await deps.supplier.getProduct(externalId);
  if (!product) throw new Error(`Supplier product ${externalId} was not found`);

  const variantsSkipped: string[] = [];
  const variantRows: Omit<Prisma.ProductVariantUncheckedCreateInput, "productId">[] = [];
  for (const variant of await deps.supplier.getVariants(externalId)) {
    const stock = await deps.supplier.getStockAndPrice(variant.externalId);
    const options = await deps.supplier.getShippingOptions(variant.externalId, deps.destinationCountry);
    const shipping = chooseShippingOption(options, stock.stockByWarehouse);
    if (!shipping) {
      variantsSkipped.push(variant.externalId);
      continue;
    }
    variantRows.push({
      externalId: variant.externalId,
      sku: variant.sku,
      attributes: variant.attributes,
      costCents: stock.costCents,
      shippingCents: shipping.costCents,
      currency: stock.currency,
      warehouse: shipping.warehouse,
      stock: stock.stockByWarehouse[shipping.warehouse] ?? 0,
      processingDays: variant.processingDays,
      deliveryDaysMin: shipping.deliveryDaysMin,
      deliveryDaysMax: shipping.deliveryDaysMax,
      lastSyncedAt: new Date(),
    });
  }

  const imagesFailed: string[] = [];
  const imageRows: { url: string; position: number; localPath: string | null }[] = [];
  for (const [position, url] of product.imageUrls.slice(0, MAX_IMAGES).entries()) {
    let localPath: string | null = null;
    try {
      localPath = await cacheImage(url, deps.imageFetcher, deps.imageCacheDir);
    } catch (error) {
      // One dead image link must not block the product; the row is kept so the gap stays visible.
      logger.warn({ url, err: error }, "product image could not be cached");
      imagesFailed.push(url);
    }
    imageRows.push({ url, position, localPath });
  }

  const productData = {
    title: product.title,
    description: product.description,
    category: product.category,
    isPersonalized: product.isPersonalized,
    galleryUrls: product.imageUrls,
    detailImageUrls: product.detailImageUrls,
  };

  const productId = await db.$transaction(async (tx) => {
    const saved = await tx.product.upsert({
      where: { supplierId_externalId: { supplierId: supplierRow.id, externalId } },
      create: { supplierId: supplierRow.id, externalId, ...productData },
      update: productData,
    });
    for (const row of variantRows) {
      await tx.productVariant.upsert({
        where: { productId_externalId: { productId: saved.id, externalId: row.externalId } },
        create: { productId: saved.id, ...row },
        update: row,
      });
    }
    const existingImages = await tx.productImage.findMany({ where: { productId: saved.id } });
    const existingUrlByPosition = new Map(existingImages.map((image) => [image.position, image.url]));
    for (const row of imageRows) {
      // A changed picture invalidates the fingerprints computed for the old one.
      const pictureChanged = existingUrlByPosition.get(row.position) !== row.url;
      await tx.productImage.upsert({
        where: { productId_position: { productId: saved.id, position: row.position } },
        create: { productId: saved.id, ...row },
        update: pictureChanged ? { ...row, pHash: null, embedding: [] } : row,
      });
    }
    await tx.productImage.deleteMany({ where: { productId: saved.id, position: { gte: imageRows.length } } });
    return saved.id;
  });

  return {
    productId,
    variantsImported: variantRows.length,
    variantsSkipped,
    imagesCached: imageRows.length - imagesFailed.length,
    imagesFailed,
  };
}
