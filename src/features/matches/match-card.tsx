import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { type ProductSpecs, productSpecsSchema } from "@/server/matching/specs";
import { decideMatchAction } from "./actions";
import type { MatchWithEvidence } from "./queries";
import { visionVerdictSchema } from "./vision-verdict";

const SPEC_LABELS: Record<keyof ProductSpecs, string> = {
  material: "Material",
  shape: "Shape",
  sizeCm: "Size (cm)",
  color: "Colour",
  personalization: "Personalized",
  giftBox: "Gift box",
  packQuantity: "Pack quantity",
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function specValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "not stated";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function Thumbnails({ images, label }: { images: { id: string; localPath: string | null }[]; label: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-2">
        {images.map((image, index) =>
          image.localPath ? (
            <Image
              key={image.id}
              src={`/api/images/${image.localPath}`}
              alt={`${label} image ${index + 1}`}
              width={96}
              height={96}
              unoptimized
              className="size-24 rounded-lg border object-cover"
            />
          ) : (
            <div key={image.id} className="flex size-24 items-center justify-center rounded-lg border text-xs text-muted-foreground">
              unavailable
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export function MatchCard({ match }: { match: MatchWithEvidence }) {
  const listing = match.competitorListing;
  const supplierSpecs = productSpecsSchema.safeParse(match.variant.specs).data;
  const competitorSpecs = productSpecsSchema.safeParse(listing.extractedSpecs).data;
  const vision = visionVerdictSchema.safeParse(match.visionVerdict).data;
  const failures = new Set(match.hardRuleFailures);
  const supplierImageCount = match.variant.product.images.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{listing.marketplace === "EBAY" ? "eBay" : "Amazon"}</Badge>
          {listing.url ? (
            <a href={listing.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
              {listing.title}
            </a>
          ) : (
            listing.title
          )}
        </CardTitle>
        <CardDescription>
          {dollars(listing.priceCents)} + {dollars(listing.shippingCents)} shipping
          {listing.deliveryDays !== null && ` · ${listing.deliveryDays} days delivery`}
          {listing.soldCount !== null && ` · ${listing.soldCount} sold`}
          {listing.sellerRating !== null && ` · seller rating ${listing.sellerRating}`}
          {" · compared with "}
          {match.variant.product.title} ({match.variant.sku})
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge>Score {percent(match.finalScore)}</Badge>
          <Badge variant="secondary">
            Images {match.matchedImageCount}/{supplierImageCount}
          </Badge>
          <Badge variant="secondary">Specs {percent(match.specScore)}</Badge>
          <Badge variant="secondary">
            {vision ? `Vision: ${vision.same ? "same" : "different"} (${percent(vision.confidence)} sure)` : "Vision: not checked"}
          </Badge>
          {match.decidedBy === "USER" && <Badge variant="outline">Your decision</Badge>}
          {match.hardRuleFailures.map((field) => (
            <Badge key={field} variant="destructive">
              Different {SPEC_LABELS[field as keyof ProductSpecs] ?? field}
            </Badge>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Thumbnails images={match.variant.product.images} label="Supplier" />
          <Thumbnails images={listing.images} label="Competitor" />
        </div>

        {supplierSpecs && competitorSpecs && (
          <table className="w-full max-w-xl text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 font-medium">Spec</th>
                <th className="py-1 font-medium">Supplier</th>
                <th className="py-1 font-medium">Competitor</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(SPEC_LABELS) as (keyof ProductSpecs)[]).map((field) => (
                <tr key={field} className={failures.has(field) ? "text-destructive" : undefined}>
                  <td className="py-0.5 pr-4">{SPEC_LABELS[field]}</td>
                  <td className="py-0.5 pr-4">{specValue(supplierSpecs[field])}</td>
                  <td className="py-0.5">{specValue(competitorSpecs[field])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {vision && vision.differences.length > 0 && (
          <p className="text-sm text-muted-foreground">Vision notes: {vision.differences.join("; ")}</p>
        )}

        <form action={decideMatchAction} className="flex gap-2">
          <input type="hidden" name="matchId" value={match.id} />
          {match.status !== "CONFIRMED" && (
            <Button type="submit" name="decision" value="CONFIRMED" size="sm">
              Approve as same product
            </Button>
          )}
          {match.status !== "REJECTED" && (
            <Button type="submit" name="decision" value="REJECTED" size="sm" variant="outline">
              Reject
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
