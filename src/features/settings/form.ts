import {
  BELOW_FLOOR_ACTIONS,
  REPRICER_STRATEGIES,
  type Settings,
  settingsSchema,
} from "@/server/settings/schema";

// How a setting is shown and edited. Stored values stay as rates and cents.
export type SettingsField = {
  /** Dot path into Settings; also the form field name. */
  path: string;
  label: string;
  hint?: string;
} & (
  | { kind: "percent" | "money" | "integer" | "number" | "boolean" }
  | { kind: "select"; options: readonly string[] }
);

export interface SettingsSection {
  title: string;
  description: string;
  fields: SettingsField[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    title: "Fees",
    description: "Marketplace and payment fees used to compute the price floor.",
    fields: [
      { path: "fees.ebay.feeRate", label: "eBay fee", kind: "percent" },
      { path: "fees.ebay.fixedFeeCents", label: "eBay fixed fee per order", kind: "money" },
      { path: "fees.amazon.feeRate", label: "Amazon referral fee", kind: "percent" },
      { path: "fees.amazon.fixedFeeCents", label: "Amazon fixed fee per order", kind: "money" },
      { path: "fees.paymentFeeRate", label: "Payment fee", kind: "percent", hint: "0 when the marketplace fee already includes payments" },
      { path: "fees.returnsBufferRate", label: "Returns / breakage buffer", kind: "percent" },
    ],
  },
  {
    title: "Pricing",
    description: "Minimum profit, buffers and markups.",
    fields: [
      { path: "pricing.minProfitCents", label: "Minimum profit per sale", kind: "money" },
      { path: "pricing.priceBufferRate", label: "Price buffer", kind: "percent", hint: "Absorbs small supplier price increases" },
      { path: "pricing.seasonalMarkupRate", label: "Seasonal markup", kind: "percent", hint: "Added as the event date approaches" },
      { path: "pricing.uniqueMarginTargetRate", label: "Margin target for unique products", kind: "percent" },
      { path: "pricing.maxMarkupRate", label: "Max markup when only / fastest seller", kind: "percent" },
    ],
  },
  {
    title: "Repricer",
    description: "How listings react to confirmed competitors.",
    fields: [
      { path: "repricer.defaultStrategy", label: "Default strategy", kind: "select", options: REPRICER_STRATEGIES },
      { path: "repricer.undercutMinCents", label: "Undercut, minimum", kind: "money" },
      { path: "repricer.undercutMaxCents", label: "Undercut, maximum", kind: "money" },
      { path: "repricer.belowFloorAction", label: "Competitor below our floor", kind: "select", options: BELOW_FLOOR_ACTIONS },
      { path: "repricer.checkIntervalMinutes", label: "Check interval (minutes)", kind: "integer" },
      { path: "repricer.topSellerIntervalMinutes", label: "Top seller interval (minutes)", kind: "integer" },
    ],
  },
  {
    title: "Matching",
    description: "Thresholds for deciding a competitor sells the exact same product.",
    fields: [
      { path: "matching.confirmThreshold", label: "Confirm at score", kind: "percent" },
      { path: "matching.reviewThreshold", label: "Needs review at score", kind: "percent" },
      { path: "matching.imageMatchThreshold", label: "Strong image match", kind: "percent" },
      { path: "matching.sizeToleranceRate", label: "Size tolerance", kind: "percent" },
      { path: "matching.weights.image", label: "Weight: image score", kind: "percent" },
      { path: "matching.weights.spec", label: "Weight: spec score", kind: "percent" },
      { path: "matching.weights.vision", label: "Weight: vision verdict", kind: "percent" },
    ],
  },
  {
    title: "Demand",
    description: "Score weights and the auto-listing threshold.",
    fields: [
      { path: "demand.threshold", label: "Demand threshold (0–100)", kind: "number" },
      { path: "demand.marketplaceInsightsEnabled", label: "eBay Marketplace Insights (sold data)", kind: "boolean", hint: "Enable only once eBay has approved access" },
      { path: "demand.weights.salesVelocity", label: "Weight: sales velocity", kind: "percent" },
      { path: "demand.weights.trendDirection", label: "Weight: trend direction", kind: "percent" },
      { path: "demand.weights.competition", label: "Weight: competition (inverse)", kind: "percent" },
      { path: "demand.weights.profitMargin", label: "Weight: profit margin", kind: "percent" },
      { path: "demand.weights.deliverySpeed", label: "Weight: delivery speed", kind: "percent" },
    ],
  },
  {
    title: "Discovery",
    description: "Finding new products automatically from the supplier's trending list (holiday discovery is set per holiday).",
    fields: [
      { path: "discovery.trendingProductsPerRun", label: "Trending products evaluated per day", kind: "integer", hint: "Each one is imported, matched and scored; 0 turns this off" },
      { path: "discovery.trendingAutoListTopN", label: "Trending products listed per day", kind: "integer", hint: "The best-scoring ones above the demand threshold" },
    ],
  },
  {
    title: "Listing",
    description: "Approval mode and account growth limits.",
    fields: [
      { path: "listing.manualApprove", label: "Manual approve mode", kind: "boolean", hint: "Auto-listing creates drafts for approval" },
      { path: "listing.maxActiveListings", label: "Max active listings", kind: "integer" },
      { path: "listing.listingGrowthPerWeek", label: "Limit growth per week", kind: "integer", hint: "Listings added to the max each week; 0 keeps it fixed" },
      { path: "listing.deliveryPromiseDays.ebay", label: "eBay delivery promise (days)", kind: "integer", hint: "Products slower than this (processing + delivery) are never listed" },
      { path: "listing.deliveryPromiseDays.amazon", label: "Amazon delivery promise (days)", kind: "integer" },
      { path: "listing.ebayUsWarehouseOnly", label: "eBay: US warehouse only", kind: "boolean", hint: "Lists only stock that ships from the supplier's US warehouse, matching the listing's item location" },
    ],
  },
  {
    title: "Orders",
    description: "Auto-fulfilment rules.",
    fields: [
      { path: "orders.maxAcceptableLossCents", label: "Max acceptable loss per order", kind: "money" },
      { path: "orders.pollIntervalMinutes", label: "Order poll interval (minutes)", kind: "integer" },
      { path: "orders.payFromSupplierBalance", label: "Pay supplier orders from balance", kind: "boolean", hint: "Off: orders are created unpaid at the supplier and you pay each one there (card or PayPal)" },
    ],
  },
  {
    title: "Account health",
    description: "Marketplace limits. Warnings fire before these are reached.",
    fields: [
      { path: "health.pauseNewListingsNearLimit", label: "Pause new listings near a limit", kind: "boolean" },
      { path: "health.amazon.maxOrderDefectRate", label: "Amazon order defect rate, max", kind: "percent" },
      { path: "health.amazon.maxLateShipmentRate", label: "Amazon late shipment rate, max", kind: "percent" },
      { path: "health.amazon.maxCancellationRate", label: "Amazon cancellation rate, max", kind: "percent" },
      { path: "health.amazon.minValidTrackingRate", label: "Amazon valid tracking rate, min", kind: "percent" },
      { path: "health.ebay.maxDefectRate", label: "eBay defect rate, max", kind: "percent" },
    ],
  },
];

const ALL_FIELDS = SETTINGS_SECTIONS.flatMap((section) => section.fields);

function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current = target;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (typeof next === "object" && next !== null) {
      current = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      current[key] = created;
      current = created;
    }
  }
  current[keys[keys.length - 1]] = value;
}

// Trims binary floating point noise, e.g. 0.1325 * 100 → 13.25.
function tidy(value: number): number {
  return Number(value.toFixed(6));
}

/** Settings → the strings shown in the form (percent as %, money as dollars). */
export function toFormValues(settings: Settings): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of ALL_FIELDS) {
    const value = readPath(settings, field.path);
    if (typeof value === "number") {
      if (field.kind === "percent") values[field.path] = String(tidy(value * 100));
      else if (field.kind === "money") values[field.path] = (value / 100).toFixed(2);
      else values[field.path] = String(value);
    } else if (typeof value === "boolean") {
      values[field.path] = value ? "on" : "";
    } else if (typeof value === "string") {
      values[field.path] = value;
    }
  }
  return values;
}

function parseField(field: SettingsField, raw: string | undefined): unknown {
  if (field.kind === "boolean") return raw === "on";
  if (field.kind === "select") return raw;
  // Blank must fail validation rather than silently become 0.
  if (raw === undefined || raw.trim() === "") return undefined;
  const number = Number(raw);
  if (field.kind === "percent") return tidy(number / 100);
  if (field.kind === "money") return Math.round(number * 100);
  return number;
}

const RANGE_MESSAGES: Record<SettingsField["kind"], string> = {
  percent: "Enter a percentage between 0 and 100.",
  money: "Enter an amount of $0 or more.",
  integer: "Enter a whole number.",
  number: "Enter a number in range.",
  boolean: "Invalid value.",
  select: "Choose one of the options.",
};

export type ParsedSettingsForm =
  | { success: true; settings: Settings }
  | { success: false; errors: Record<string, string> };

/** Form strings → validated Settings, or one message per offending field path. */
export function parseSettingsForm(values: Record<string, string | undefined>): ParsedSettingsForm {
  const candidate: Record<string, unknown> = {};
  for (const field of ALL_FIELDS) {
    writePath(candidate, field.path, parseField(field, values[field.path]));
  }

  const result = settingsSchema.safeParse(candidate);
  if (result.success) return { success: true, settings: result.data };

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    const field = ALL_FIELDS.find((candidate) => candidate.path === path);
    // Cross-field rules carry their own wording; range errors are restated in the unit the form shows.
    errors[path] ??= issue.code === "custom" || !field ? issue.message : RANGE_MESSAGES[field.kind];
  }
  return { success: false, errors };
}

export interface SettingsFormState {
  saved: boolean;
  errors: Record<string, string>;
  /** Echo of a rejected submission, so the form keeps what was typed. */
  submitted?: Record<string, string>;
}
