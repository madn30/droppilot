import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ListingGroup } from "@/features/listings/grouping";
import { DraftActions } from "@/features/listings/listing-actions";
import type { ListingWithVariant } from "@/features/listings/queries";
import type { Env } from "@/server/env";
import { optionsOf } from "@/server/listing/variations";
import { listingUrl } from "@/server/marketplaces";
import { computeProfitCents } from "@/server/pricing/engine";
import type { Settings } from "@/server/settings/schema";
import { supplierProductUrl } from "@/server/suppliers";

function dollars(cents: number): string {
  return `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function ListingCard({ group, settings, env }: { group: ListingGroup<ListingWithVariant>; settings: Settings; env: Env }) {
  const { lead: listing, options } = group;
  const profitOf = (option: (typeof options)[number]) =>
    computeProfitCents(option.priceCents, option.variant, option.marketplace, settings);
  const isDraft = listing.status === "PENDING_APPROVAL" || listing.status === "DRAFT";
  const { product } = listing.variant;
  const marketplaceUrl = listingUrl(env, listing.marketplace, listing.externalId);
  const supplierUrl = supplierProductUrl(env, product.supplier.code, product.externalId);
  const hasOptions = options.length > 1;
  const prices = options.map((option) => option.priceCents);
  const priceRange =
    Math.min(...prices) === Math.max(...prices) ? dollars(prices[0]) : `${dollars(Math.min(...prices))}–${dollars(Math.max(...prices))}`;
  // Only what differs between the options is a choice the buyer makes.
  const choices = options.map((option) => optionsOf(option.variant.attributes));
  const choiceNames = Object.keys(choices[0]).filter((name) => new Set(choices.map((choice) => choice[name])).size > 1);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{listing.marketplace === "EBAY" ? "eBay" : "Amazon"}</Badge>
          {listing.title}
        </CardTitle>
        <CardDescription>
          {hasOptions ? `${options.length} options` : listing.sku} · {product.title}
          {listing.externalId && ` · marketplace ID ${listing.externalId}`}
          {(marketplaceUrl || supplierUrl) && (
            <span className="mt-1 flex flex-wrap gap-3">
              {marketplaceUrl && (
                <a href={marketplaceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  View on {listing.marketplace === "EBAY" ? "eBay" : "Amazon"}
                </a>
              )}
              {supplierUrl && (
                <a href={supplierUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  View on {product.supplier.name}
                </a>
              )}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge>{priceRange}</Badge>
          {!hasOptions && (
            <>
              <Badge variant="secondary">Floor {dollars(listing.floorCents)}</Badge>
              <Badge variant={profitOf(listing) < 0 ? "destructive" : "secondary"}>Profit {dollars(profitOf(listing))}</Badge>
              <Badge variant="secondary">Quantity {listing.quantity}</Badge>
              {listing.pauseReason && <Badge variant="destructive">{listing.pauseReason.toLowerCase().replaceAll("_", " ")}</Badge>}
            </>
          )}
          {listing.holiday && (
            <Badge variant="outline">
              {listing.holiday.name}
              {listing.cutoffDate && ` · cut-off ${formatDate(listing.cutoffDate)}`}
            </Badge>
          )}
          {options.some((option) => option.isTopSeller) && <Badge variant="outline">Top seller</Badge>}
        </div>
        {hasOptions && (
          <details className="rounded-lg border" open={isDraft}>
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
              Options the buyer picks: {choiceNames.join(", ") || "variant"} ({options.length})
            </summary>
            <div className="overflow-x-auto border-t">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Option</th>
                    <th className="px-3 py-2 font-medium">SKU</th>
                    <th className="px-3 py-2 font-medium">Price</th>
                    <th className="px-3 py-2 font-medium">Floor</th>
                    <th className="px-3 py-2 font-medium">Profit</th>
                    <th className="px-3 py-2 font-medium">Quantity</th>
                    <th className="px-3 py-2 font-medium">Warehouse</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {options.map((option, index) => (
                    <tr key={option.id} className="border-b last:border-b-0">
                      <td className="px-3 py-2">{choiceNames.map((name) => choices[index][name]).join(" / ") || option.sku}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{option.sku}</td>
                      <td className="px-3 py-2 tabular-nums">{dollars(option.priceCents)}</td>
                      <td className="px-3 py-2 tabular-nums">{dollars(option.floorCents)}</td>
                      <td className={`px-3 py-2 tabular-nums ${profitOf(option) < 0 ? "text-destructive" : ""}`}>{dollars(profitOf(option))}</td>
                      <td className="px-3 py-2 tabular-nums">{option.quantity}</td>
                      <td className="px-3 py-2">{option.variant.warehouse}</td>
                      <td className="px-3 py-2 text-xs">
                        {option.status.toLowerCase().replaceAll("_", " ")}
                        {option.pauseReason && ` (${option.pauseReason.toLowerCase().replaceAll("_", " ")})`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
        {isDraft && <p className="whitespace-pre-line text-sm text-muted-foreground">{listing.description}</p>}
        {isDraft && <DraftActions listingId={listing.id} />}
      </CardContent>
    </Card>
  );
}
