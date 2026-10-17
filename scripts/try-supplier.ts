import { ClaudeCliSpecExtractor } from "../src/server/ai/claude-cli/providers";
import { AnthropicSpecExtractor } from "../src/server/ai/anthropic/spec-extractor";
import { createAnthropicClient } from "../src/server/ai/anthropic/client";
import { JinaClipEmbeddings } from "../src/server/ai/jina/clip-embeddings";
import { chooseShippingOption } from "../src/server/catalog/shipping-choice";
import { SerpApiTrendsSource } from "../src/server/data-sources/serpapi/google-trends";
import { db } from "../src/server/db";
import { analyzeTrend, trendKeyword } from "../src/server/demand/trend-analysis";
import { getEnv } from "../src/server/env";
import { HttpImageFetcher } from "../src/server/images/fetcher";
import { computePHash } from "../src/server/matching/phash";
import { computeFloorCents, roundUpToPriceEnding } from "../src/server/pricing/engine";
import { getSettings } from "../src/server/settings/service";
import { CjSupplierAdapter } from "../src/server/suppliers/cj/cj-adapter";
import { CjClient } from "../src/server/suppliers/cj/client";
import { databaseTokenStore } from "../src/server/suppliers/cj/token-store";

// Runs the supplier half of the pipeline against the real services, whatever MOCK_APIS says,
// and prints what it finds. Nothing is listed, ordered or written to the catalog.
// Usage: npm run try:supplier -- "<keyword>" [--trends] [--any-warehouse]
//   --trends         also query Google Trends (2 SerpApi searches)
//   --any-warehouse  search all products, not only those stocked in the US

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const keyword = args.find((arg) => !arg.startsWith("--"));
  if (!keyword) throw new Error('Usage: npm run try:supplier -- "<keyword>" [--trends]');
  const env = getEnv();
  if (!env.CJ_API_KEY) throw new Error("CJ_API_KEY is not set");

  const cj = new CjSupplierAdapter(new CjClient({ apiKey: env.CJ_API_KEY, tokenStore: databaseTokenStore }), { sandboxOrders: true });

  console.log(`\n1. CJ search for "${keyword}"`);
  const stockedIn = args.includes("--any-warehouse") ? undefined : "US";
  console.log(`   (${stockedIn ? "US-stocked products only; add --any-warehouse to search everything" : "any warehouse"})`);
  const found = await cj.searchProducts({ keyword, pageSize: 5, stockedIn });
  for (const summary of found) console.log(`   ${summary.externalId}  from ${dollars(summary.fromCostCents)}  ${summary.title.slice(0, 70)}`);
  if (found.length === 0) return;

  const product = await cj.getProduct(found[0].externalId);
  if (!product) throw new Error("CJ returned the product in search but not by id");
  console.log(`\n2. Product ${product.externalId}`);
  console.log(`   title: ${product.title}`);
  console.log(`   category: ${product.category ?? "none"} · personalized: ${product.isPersonalized} · images: ${product.imageUrls.length}`);
  console.log(`   description: ${product.description.slice(0, 200).replace(/\n/g, " / ")}${product.description.length > 200 ? "…" : ""}`);

  const variants = await cj.getVariants(product.externalId);
  console.log(`\n3. Variants: ${variants.length}`);
  for (const variant of variants.slice(0, 5)) {
    console.log(`   ${variant.sku}  ${dollars(variant.costCents)}  ${JSON.stringify(variant.attributes)}  stocked in: ${variant.warehouses.join(", ") || "nowhere"}`);
  }

  const variant = variants.find((candidate) => candidate.warehouses.includes("US")) ?? variants[0];
  if (variant) {
    const stock = await cj.getStockAndPrice(variant.externalId);
    const options = await cj.getShippingOptions(variant.externalId, "US");
    const chosen = chooseShippingOption(options, stock.stockByWarehouse);
    console.log(`\n4. ${variant.sku}: cost ${dollars(stock.costCents)}, stock ${JSON.stringify(stock.stockByWarehouse)}`);
    // The chosen option first, then the rest.
    for (const option of [...options].sort((a, b) => Number(b === chosen) - Number(a === chosen)).slice(0, 8)) {
      console.log(`   ${option.warehouse} → US  ${option.name}: ${dollars(option.costCents)}, ${option.deliveryDaysMin}-${option.deliveryDaysMax} days${option === chosen ? "   ← chosen" : ""}`);
    }
    if (chosen) {
      const settings = await getSettings();
      const floor = computeFloorCents({ costCents: stock.costCents, shippingCents: chosen.costCents }, "EBAY", settings);
      console.log(`   eBay price floor: ${dollars(floor)} → lowest listing price ${dollars(roundUpToPriceEnding(floor))}`);
    } else {
      console.log("   no stocked warehouse ships to the US");
    }
  }

  console.log("\n5. Images");
  const fetcher = new HttpImageFetcher();
  const images = [];
  for (const url of product.imageUrls.slice(0, 3)) {
    const image = await fetcher.fetch(url);
    images.push(image);
    console.log(`   ${image.contentType}  ${Math.round(image.bytes.length / 1024)} KB  pHash ${await computePHash(image.bytes)}`);
  }
  if (env.EMBEDDINGS_PROVIDER_KEY && images.length > 0) {
    const vectors = await new JinaClipEmbeddings({ apiKey: env.EMBEDDINGS_PROVIDER_KEY }).embedImages(images);
    console.log(`   embeddings: ${vectors.length} × ${vectors[0].length} dimensions`);
  }

  console.log("\n6. Specs extracted by Claude");
  const extractor =
    env.AI_PROVIDER === "claude-cli" ? new ClaudeCliSpecExtractor() : new AnthropicSpecExtractor(createAnthropicClient(env.ANTHROPIC_API_KEY ?? ""));
  console.log(`   ${JSON.stringify(await extractor.extractSpecs({ title: product.title, description: product.description, itemSpecifics: variant?.attributes ?? {} }))}`);

  const trendWord = trendKeyword(product.title);
  console.log(`\n7. Google Trends keyword: "${trendWord}"`);
  if (args.includes("--trends") && env.SERPAPI_KEY) {
    const trend = await new SerpApiTrendsSource({ apiKey: env.SERPAPI_KEY }).getInterestOverTime(trendWord, "US");
    const analysis = analyzeTrend(trend.points);
    console.log(`   ${trend.points.length} monthly points · direction ${analysis.direction} (${Math.round(analysis.changeRate * 100)}%) · peak month ${analysis.peakMonth ?? "none"}`);
    console.log(`   rising queries: ${trend.relatedRisingQueries.slice(0, 5).join("; ") || "none"}`);
  } else {
    console.log("   (not queried; add --trends to use 2 SerpApi searches)");
  }
}

main()
  .catch((error: unknown) => {
    console.error("\nFAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
