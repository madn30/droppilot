import type { ProductSpecs } from "./specs";

export type SpecField = keyof ProductSpecs;

export interface SpecComparison {
  /** Share of the supplier's known specs that the competitor states and matches. */
  specScore: number;
  /**
   * Hard-rule fields that differ: any entry means it is not the same product.
   * A spec field, or "option: <name>" for a variation option with another value.
   */
  hardRuleFailures: string[];
  /** Fields the supplier states but the competitor listing does not. */
  unknownFields: SpecField[];
}

// A mismatch on any of these means a different product. Colour only affects the score:
// one marketplace listing often covers several colours.
const HARD_RULE_FIELDS: ReadonlySet<SpecField> = new Set([
  "material",
  "shape",
  "sizeCm",
  "personalization",
  "giftBox",
  "packQuantity",
]);

const FIELDS: SpecField[] = ["material", "shape", "sizeCm", "color", "personalization", "giftBox", "packQuantity"];

function sameValue(field: SpecField, supplier: string | number | boolean, competitor: string | number | boolean, sizeTolerance: number): boolean {
  if (field === "sizeCm" && typeof supplier === "number" && typeof competitor === "number") {
    return Math.abs(competitor - supplier) <= supplier * sizeTolerance;
  }
  if (typeof supplier === "string" && typeof competitor === "string") {
    return supplier.trim().toLowerCase() === competitor.trim().toLowerCase();
  }
  return supplier === competitor;
}

/**
 * Compares a competitor listing's specs with the supplier variant's.
 * Fields the supplier does not state cannot be compared and are left out.
 */
export function compareSpecs(supplier: ProductSpecs, competitor: ProductSpecs, sizeTolerance: number): SpecComparison {
  const hardRuleFailures: string[] = [];
  const unknownFields: SpecField[] = [];
  let comparable = 0;
  let matching = 0;

  for (const field of FIELDS) {
    const supplierValue = supplier[field];
    if (supplierValue === null) continue;
    comparable++;

    const competitorValue = competitor[field];
    if (competitorValue === null) {
      unknownFields.push(field);
    } else if (sameValue(field, supplierValue, competitorValue, sizeTolerance)) {
      matching++;
    } else if (HARD_RULE_FIELDS.has(field)) {
      hardRuleFailures.push(field);
    }
  }

  return { specScore: comparable === 0 ? 0 : matching / comparable, hardRuleFailures, unknownFields };
}

function normalizeOption(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Options on which a competitor item states another choice than the supplier variant, as hard-rule
 * failures. A marketplace listing with variations is one item per choice, each with its own price:
 * the "USB cable only" choice of a lamp listing is not the lamp. Sellers of the same supplier product
 * keep the supplier's option names, so only names both sides state are compared.
 */
export function optionMismatches(supplierOptions: Record<string, string>, competitorSpecifics: Record<string, string>): string[] {
  const competitor = new Map(Object.entries(competitorSpecifics).map(([name, value]) => [normalizeOption(name), normalizeOption(value)]));
  return Object.entries(supplierOptions).flatMap(([name, value]) => {
    const stated = competitor.get(normalizeOption(name));
    return stated !== undefined && stated !== normalizeOption(value) ? [`option: ${name}`] : [];
  });
}
