import { importSupplierProduct } from "../src/server/catalog/import-product";
import { shipsFromAllowedWarehouse } from "../src/server/compliance/guards";
import { db } from "../src/server/db";
import { buildDemandDeps } from "../src/server/demand/deps";
import { scoreDemandForVariant } from "../src/server/demand/run-demand";
import { getEnv } from "../src/server/env";
import { getImageFetcher } from "../src/server/images/fetcher";
import { buildMatchingDeps } from "../src/server/matching/deps";
import { runMatchingForVariant } from "../src/server/matching/run-matching";
import { getSupplierAdapter } from "../src/server/suppliers";

// Imports one supplier product, then runs matching and demand scoring for each of its variants.
// Usage: npm run match -- <supplier product id>   (mock mode: CJ-NECKLACE-001)
async function main(): Promise<void> {
  const externalId = process.argv[2];
  if (!externalId) {
    console.error("Usage: npm run match -- <supplier product id>");
    process.exitCode = 1;
    return;
  }

  const imported = await importSupplierProduct(externalId, {
    supplier: getSupplierAdapter(),
    imageFetcher: getImageFetcher(),
    imageCacheDir: getEnv().IMAGE_CACHE_DIR,
    destinationCountry: "US",
  });
  console.log("Imported:", imported);

  const deps = await buildMatchingDeps();
  const demandDeps = await buildDemandDeps();
  const variants = await db.productVariant.findMany({ where: { productId: imported.productId } });
  // As in discovery: variants that may not be listed on eBay (wrong warehouse) are not evaluated.
  for (const variant of variants.filter((candidate) => shipsFromAllowedWarehouse("EBAY", candidate, demandDeps.settings.listing))) {
    console.log(`Matched ${variant.sku}:`, await runMatchingForVariant(variant.id, deps));
    console.log(`Demand for ${variant.sku}:`, await scoreDemandForVariant(variant.id, demandDeps));
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
