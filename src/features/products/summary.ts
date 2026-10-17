import type { ProductVariant } from "@prisma/client";

export interface Range {
  min: number;
  max: number;
}

type SummaryVariant<TListing> = Pick<
  ProductVariant,
  "warehouse" | "stock" | "costCents" | "shippingCents" | "processingDays" | "deliveryDaysMax"
> & {
  demandSnapshots: { score: number }[];
  _count: { matches: number };
  listings: TListing[];
};

export interface ProductSummary<TListing> {
  variantCount: number;
  /** Variants shipped from a US warehouse. */
  usVariantCount: number;
  inStockCount: number;
  /** Supplier cost plus shipping, in cents. */
  landedCostCents: Range | null;
  /** Processing plus the longest delivery estimate, in days. */
  totalDays: Range | null;
  bestScore: number | null;
  /** Variants whose latest score reaches the threshold. */
  aboveThresholdCount: number;
  /** Most confirmed competitors any one variant has. */
  confirmedCompetitors: number;
  listings: TListing[];
}

function range(values: number[]): Range | null {
  return values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) };
}

/** One line of facts for a supplier product, rolled up from its variants (each carrying its latest demand snapshot). */
export function summarizeProduct<TListing>(variants: SummaryVariant<TListing>[], threshold: number): ProductSummary<TListing> {
  const scores = variants.flatMap((variant) => (variant.demandSnapshots[0] ? [variant.demandSnapshots[0].score] : []));
  return {
    variantCount: variants.length,
    usVariantCount: variants.filter((variant) => variant.warehouse === "US").length,
    inStockCount: variants.filter((variant) => variant.stock > 0).length,
    landedCostCents: range(variants.map((variant) => variant.costCents + variant.shippingCents)),
    totalDays: range(variants.map((variant) => variant.processingDays + variant.deliveryDaysMax)),
    bestScore: scores.length === 0 ? null : Math.max(...scores),
    aboveThresholdCount: scores.filter((score) => score >= threshold).length,
    confirmedCompetitors: Math.max(0, ...variants.map((variant) => variant._count.matches)),
    listings: variants.flatMap((variant) => variant.listings),
  };
}
