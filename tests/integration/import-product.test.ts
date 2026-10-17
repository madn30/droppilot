import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type ImportDeps, importSupplierProduct } from "@/server/catalog/import-product";
import { db } from "@/server/db";
import type { ImageFetcher } from "@/server/images/fetcher";
import { MockImageFetcher } from "@/server/images/mock-image-fetcher";
import { NECKLACE_PRODUCT_ID, NECKLACE_VARIANT_ID } from "@/server/mocks/fixtures/necklace";
import { MockSupplierAdapter } from "@/server/suppliers/mock/mock-supplier";
import { resetDatabase } from "./reset-db";

let cacheDir: string;
let supplier: MockSupplierAdapter;
let deps: ImportDeps;

beforeEach(async () => {
  await resetDatabase();
  await db.supplier.create({ data: { code: "cj", name: "CJ Dropshipping", supportsBlindShipping: true } });
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "droppilot-import-"));
  supplier = new MockSupplierAdapter();
  deps = { supplier, imageFetcher: new MockImageFetcher(), imageCacheDir: cacheDir, destinationCountry: "US" };
  return async () => {
    await rm(cacheDir, { recursive: true, force: true });
  };
});

afterAll(async () => {
  await db.$disconnect();
});

describe("importSupplierProduct", () => {
  it("imports the necklace with cost, US shipping, delivery times and all six images", async () => {
    const result = await importSupplierProduct(NECKLACE_PRODUCT_ID, deps);
    expect(result).toMatchObject({ variantsImported: 1, variantsSkipped: [], imagesCached: 6, imagesFailed: [] });

    const product = await db.product.findUniqueOrThrow({
      where: { id: result.productId },
      include: { variants: true, images: { orderBy: { position: "asc" } } },
    });
    expect(product).toMatchObject({ title: "Custom Photo Projection Necklace", isPersonalized: true, status: "DISCOVERED" });
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]).toMatchObject({
      externalId: NECKLACE_VARIANT_ID,
      costCents: 1120,
      shippingCents: 490,
      warehouse: "US",
      stock: 240,
      processingDays: 2,
      deliveryDaysMin: 3,
      deliveryDaysMax: 5,
    });

    expect(product.images.map((image) => image.position)).toEqual([0, 1, 2, 3, 4, 5]);
    const files = await readdir(cacheDir);
    expect(files).toHaveLength(6);
    for (const image of product.images) {
      expect(image.localPath).not.toBeNull();
      const bytes = await readFile(path.join(cacheDir, image.localPath ?? ""));
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    }
  });

  it("updates in place on re-import and picks up a supplier price change", async () => {
    const first = await importSupplierProduct(NECKLACE_PRODUCT_ID, deps);
    supplier.setCost(NECKLACE_VARIANT_ID, 1220);
    const second = await importSupplierProduct(NECKLACE_PRODUCT_ID, deps);

    expect(second.productId).toBe(first.productId);
    expect(await db.product.count()).toBe(1);
    expect(await db.productImage.count()).toBe(6);
    const variants = await db.productVariant.findMany();
    expect(variants).toHaveLength(1);
    expect(variants[0].costCents).toBe(1220);
  });

  it("keeps image fingerprints for unchanged pictures and resets them when a picture changes", async () => {
    const { productId } = await importSupplierProduct(NECKLACE_PRODUCT_ID, deps);
    await db.productImage.update({
      where: { productId_position: { productId, position: 0 } },
      data: { url: "https://old.example.com/replaced.png", pHash: "stale" },
    });
    await db.productImage.update({
      where: { productId_position: { productId, position: 1 } },
      data: { pHash: "kept" },
    });

    await importSupplierProduct(NECKLACE_PRODUCT_ID, deps);

    const images = await db.productImage.findMany({ where: { productId }, orderBy: { position: "asc" } });
    expect(images[0].url).toContain("content=necklace-1");
    expect(images[0].pHash).toBeNull();
    expect(images[1].pHash).toBe("kept");
  });

  it("falls back to the China warehouse when the US one is out of stock", async () => {
    supplier.setStock(NECKLACE_VARIANT_ID, "US", 0);
    await importSupplierProduct(NECKLACE_PRODUCT_ID, deps);
    expect(await db.productVariant.findFirstOrThrow()).toMatchObject({
      warehouse: "CN",
      shippingCents: 310,
      stock: 1800,
      deliveryDaysMin: 8,
      deliveryDaysMax: 14,
    });
  });

  it("skips a variant that no stocked warehouse can ship", async () => {
    supplier.setStock(NECKLACE_VARIANT_ID, "US", 0);
    supplier.setStock(NECKLACE_VARIANT_ID, "CN", 0);
    const result = await importSupplierProduct(NECKLACE_PRODUCT_ID, deps);
    expect(result).toMatchObject({ variantsImported: 0, variantsSkipped: [NECKLACE_VARIANT_ID] });
    expect(await db.productVariant.count()).toBe(0);
  });

  it("keeps the product when one image cannot be downloaded, and records the gap", async () => {
    const real = new MockImageFetcher();
    const flaky: ImageFetcher = {
      fetch: (url) => (url.includes("necklace-3") ? Promise.reject(new Error("HTTP 404")) : real.fetch(url)),
    };
    const result = await importSupplierProduct(NECKLACE_PRODUCT_ID, { ...deps, imageFetcher: flaky });
    expect(result.imagesCached).toBe(5);
    expect(result.imagesFailed).toHaveLength(1);
    const images = await db.productImage.findMany({ orderBy: { position: "asc" } });
    expect(images.map((image) => image.localPath === null)).toEqual([false, false, true, false, false, false]);
  });

  it("refuses to import from a supplier that is not a dropshipping supplier", async () => {
    await db.supplier.update({ where: { code: "cj" }, data: { isDropshipSupplier: false } });
    await expect(importSupplierProduct(NECKLACE_PRODUCT_ID, deps)).rejects.toThrow(/not a dropshipping supplier/);
    expect(await db.product.count()).toBe(0);
  });

  it("fails clearly for an unknown product", async () => {
    await expect(importSupplierProduct("missing", deps)).rejects.toThrow(/was not found/);
  });
});
