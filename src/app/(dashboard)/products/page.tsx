import Image from "next/image";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { groupListings } from "@/features/listings/grouping";
import { CreateListingButton } from "@/features/listings/listing-actions";
import { ListingCard } from "@/features/listings/listing-card";
import { type ListingWithVariant, listListingsForProducts } from "@/features/listings/queries";
import { MatchCard } from "@/features/matches/match-card";
import { type MatchWithEvidence, listMatchesForProducts } from "@/features/matches/queries";
import { OrderCard } from "@/features/orders/order-card";
import { type OrderWithPipeline, listOrdersForProducts } from "@/features/orders/queries";
import { type ProductWithDemand, listProducts } from "@/features/products/queries";
import { type Range, summarizeProduct } from "@/features/products/summary";
import { TrendChart } from "@/features/products/trend-chart";
import { requireAdmin } from "@/server/auth/session";
import { type Env, getEnv } from "@/server/env";
import type { Settings } from "@/server/settings/schema";
import { enabledMarketplaces, listingUrl } from "@/server/marketplaces";
import { getSettings } from "@/server/settings/service";
import { supplierProductUrl } from "@/server/suppliers";

export const dynamic = "force-dynamic";

const componentsSchema = z.object({
  salesVelocity: z.number(),
  trendDirection: z.number(),
  competition: z.number(),
  profitMargin: z.number(),
  deliverySpeed: z.number(),
});

const trendPointsSchema = z.array(z.object({ date: z.string(), value: z.number() }));
const relatedQueriesSchema = z.array(z.string());

const COMPONENT_LABELS: [keyof z.infer<typeof componentsSchema>, string][] = [
  ["salesVelocity", "Sales"],
  ["trendDirection", "Trend"],
  ["competition", "Competition"],
  ["profitMargin", "Margin"],
  ["deliverySpeed", "Delivery"],
];

const MARKETPLACES = [
  { marketplace: "EBAY", label: "eBay" },
  { marketplace: "AMAZON", label: "Amazon" },
] as const;

const MATCH_GROUPS = [
  { status: "REVIEW", label: "Needs review" },
  { status: "CONFIRMED", label: "Confirmed" },
  { status: "REJECTED", label: "Rejected" },
] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatRange(range: Range | null, format: (value: number) => string): string {
  if (!range) return "—";
  return range.min === range.max ? format(range.min) : `${format(range.min)}–${format(range.max)}`;
}

function marketplaceLabel(marketplace: "EBAY" | "AMAZON"): string {
  return marketplace === "EBAY" ? "eBay" : "Amazon";
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

function Section({ title, count, attention, children }: { title: string; count: number; attention: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <details className="rounded-lg border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        {title} ({count})
        {attention > 0 && (
          <>
            <span aria-hidden className="ml-2 inline-block size-2 rounded-full bg-destructive align-middle" />
            <span className="sr-only">{attention} need your attention</span>
          </>
        )}
      </summary>
      <div className="space-y-4 border-t p-3">{children}</div>
    </details>
  );
}

function ProductCard({
  product,
  threshold,
  marketplaces,
  env,
  settings,
  matches,
  listings,
  orders,
}: {
  product: ProductWithDemand;
  threshold: number;
  marketplaces: ("EBAY" | "AMAZON")[];
  env: Env;
  settings: Settings;
  matches: MatchWithEvidence[];
  listings: ListingWithVariant[];
  orders: OrderWithPipeline[];
}) {
  const listingGroups = groupListings(listings);
  const summary = summarizeProduct(product.variants, threshold);
  const supplierUrl = supplierProductUrl(env, product.supplier.code, product.externalId);
  const image = product.images[0];
  const trend = product.trendSnapshots[0];
  const points = trendPointsSchema.safeParse(trend?.series).data ?? [];
  const related = relatedQueriesSchema.safeParse(trend?.relatedQueries).data ?? [];

  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex gap-4">
          {image?.localPath ? (
            <Image
              src={`/api/images/${image.localPath}`}
              alt={product.title}
              width={80}
              height={80}
              unoptimized
              className="size-20 shrink-0 rounded-lg border object-cover"
            />
          ) : (
            <div className="flex size-20 shrink-0 items-center justify-center rounded-lg border text-xs text-muted-foreground">no image</div>
          )}

          <div className="min-w-0 flex-1 space-y-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{product.title}</span>
                <Badge variant={product.status === "ELIGIBLE" ? "default" : "secondary"}>{product.status.toLowerCase()}</Badge>
                {product.supplierTrending && <Badge variant="outline">trending at supplier</Badge>}
              </div>
              <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span>
                  {product.supplier.name} · {product.externalId}
                </span>
                {supplierUrl && (
                  <a href={supplierUrl} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
                    View on {product.supplier.name}
                  </a>
                )}
              </div>
            </div>

            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
              <Fact label="Variants">
                {summary.variantCount} · {summary.usVariantCount} in US
              </Fact>
              <Fact label="Cost + shipping">{formatRange(summary.landedCostCents, dollars)}</Fact>
              <Fact label="Ships in">{formatRange(summary.totalDays, (days) => `${days}`)} days</Fact>
              <Fact label="Best demand">
                {summary.bestScore === null ? (
                  <span className="text-muted-foreground">not scored</span>
                ) : (
                  <span className={summary.bestScore >= threshold ? "font-semibold" : undefined}>
                    {summary.bestScore.toFixed(1)} <span className="text-muted-foreground">/ {threshold}</span>
                  </span>
                )}
              </Fact>
              <Fact label="Competitors">{summary.confirmedCompetitors === 0 ? "none confirmed" : `${summary.confirmedCompetitors} confirmed`}</Fact>
              <Fact label="Search trend">{trend ? `${trend.direction}${trend.peakMonth ? `, peaks ${MONTHS[trend.peakMonth - 1]}` : ""}` : "—"}</Fact>
            </dl>

            {summary.listings.length > 0 && (
              <div className="flex flex-wrap gap-3 text-xs">
                {groupListings(summary.listings).map(({ lead: listing, options }) => {
                  const url = listingUrl(env, listing.marketplace, listing.externalId);
                  const text =
                    `${marketplaceLabel(listing.marketplace)}: ${listing.status.toLowerCase().replaceAll("_", " ")}` +
                    (options.length > 1 ? ` (${options.length} options)` : "");
                  return url ? (
                    <a key={listing.id} href={url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                      {text}
                    </a>
                  ) : (
                    <span key={listing.id}>{text}</span>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <Section title="Matches" count={matches.length} attention={matches.filter((match) => match.status === "REVIEW").length}>
          {MATCH_GROUPS.map(({ status, label }) => {
            const group = matches.filter((match) => match.status === status);
            return group.length === 0 ? null : (
              <div key={status} className="space-y-3">
                <h3 className="text-sm font-medium">
                  {label} ({group.length})
                </h3>
                {group.map((match) => (
                  <MatchCard key={match.id} match={match} />
                ))}
              </div>
            );
          })}
        </Section>

        <Section
          title="Listings"
          count={listingGroups.length}
          attention={listingGroups.filter(({ lead }) => ["PENDING_APPROVAL", "DRAFT", "ERROR"].includes(lead.status)).length}
        >
          {listingGroups.map((group) => (
            <ListingCard key={group.key} group={group} settings={settings} env={env} />
          ))}
        </Section>

        <Section
          title="Orders"
          count={orders.length}
          attention={orders.filter((order) => order.status === "NEEDS_DECISION" || order.status === "FAILED").length}
        >
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </Section>

        <details className="rounded-lg border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Variants ({summary.variantCount})</summary>
          <div className="overflow-x-auto border-t">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Variant</th>
                  <th className="px-3 py-2 font-medium">Warehouse</th>
                  <th className="px-3 py-2 font-medium">Stock</th>
                  <th className="px-3 py-2 font-medium">Cost + shipping</th>
                  <th className="px-3 py-2 font-medium">Delivery</th>
                  <th className="px-3 py-2 font-medium">Demand</th>
                  <th className="px-3 py-2 font-medium">Components</th>
                  <th className="px-3 py-2 font-medium">Listing</th>
                </tr>
              </thead>
              <tbody>
                {product.variants.map((variant) => {
                  const snapshot = variant.demandSnapshots[0];
                  const components = componentsSchema.safeParse(snapshot?.components).data;
                  return (
                    <tr key={variant.id} className="border-b last:border-b-0 align-top">
                      <td className="px-3 py-2">{variant.sku}</td>
                      <td className="px-3 py-2">{variant.warehouse}</td>
                      <td className="px-3 py-2 tabular-nums">{variant.stock}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {dollars(variant.costCents)} + {dollars(variant.shippingCents)}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {variant.processingDays} + {variant.deliveryDaysMin}–{variant.deliveryDaysMax} days
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {snapshot ? (
                          <span className={snapshot.score >= threshold ? "font-semibold" : "text-muted-foreground"}>{snapshot.score.toFixed(1)}</span>
                        ) : (
                          <span className="text-muted-foreground">not scored</span>
                        )}
                        {snapshot?.lowestCompetitorCents != null && (
                          <div className="text-xs text-muted-foreground">competitors from {dollars(snapshot.lowestCompetitorCents)}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground">
                        {components
                          ? COMPONENT_LABELS.map(([key, label]) => `${label} ${Math.round(components[key] * 100)}`).join(" · ")
                          : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <div className="space-y-1">
                          {MARKETPLACES.filter(({ marketplace }) => marketplaces.includes(marketplace)).map(({ marketplace, label }) => {
                            const listing = variant.listings.find((candidate) => candidate.marketplace === marketplace);
                            if (listing) {
                              return (
                                <div key={marketplace} className="text-xs">
                                  {label}: {listing.status.toLowerCase().replaceAll("_", " ")}
                                </div>
                              );
                            }
                            return product.status === "ELIGIBLE" ? (
                              <CreateListingButton key={marketplace} variantId={variant.id} marketplace={marketplace} />
                            ) : null;
                          })}
                          {product.status !== "ELIGIBLE" && variant.listings.length === 0 && (
                            <span className="text-xs text-muted-foreground">not eligible</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>

        {trend && (
          <details className="rounded-lg border">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Search interest: “{trend.keyword}”</summary>
            <div className="space-y-3 border-t p-3">
              <p className="text-sm text-muted-foreground">
                Google Trends, {trend.geo}, last five years, monthly. This is relative interest on a 0–100 index (100 is the peak
                month), not a number of searches or sales. Direction: {trend.direction}
                {trend.peakMonth ? `; peaks every ${MONTHS[trend.peakMonth - 1]}` : "; no seasonal peak"}.
              </p>
              <TrendChart points={points} label={`Google Trends interest for ${trend.keyword}, monthly, 0 to 100`} />
              {related.length > 0 && <p className="text-sm text-muted-foreground">Related rising searches: {related.join(", ")}</p>}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

export default async function ProductsPage() {
  await requireAdmin();
  const [products, settings] = await Promise.all([listProducts(), getSettings()]);
  const productIds = products.map((product) => product.id);
  const [matches, listings, orders] = await Promise.all([
    listMatchesForProducts(productIds),
    listListingsForProducts(productIds),
    listOrdersForProducts(productIds),
  ]);
  const threshold = settings.demand.threshold;
  const marketplaces = enabledMarketplaces();
  const env = getEnv();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Products</h1>
        <p className="text-sm text-muted-foreground">
          One card per supplier product. A demand score of {threshold} or more makes a variant eligible for auto-listing. Open
          “Variants” for each variant’s stock, cost and score. Matches, listings and orders of a product are under its card; a red
          dot marks what needs you.
        </p>
      </div>

      {products.length === 0 ? (
        <p className="text-sm text-muted-foreground">No products yet. The daily trending and seasonal jobs import them.</p>
      ) : (
        <div className="space-y-4">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              threshold={threshold}
              marketplaces={marketplaces}
              env={env}
              settings={settings}
              matches={matches.filter((match) => match.variant.productId === product.id)}
              listings={listings.filter((listing) => listing.variant.productId === product.id)}
              orders={orders.filter((order) => order.items.some((item) => item.listing.variant.productId === product.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
