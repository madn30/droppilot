import type { SupplierShippingOption } from "../suppliers/types";

const EU_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

/** Lower is better: the destination's own warehouse, then US/EU warehouses, then everything else. */
function warehouseTier(option: SupplierShippingOption): number {
  if (option.warehouse === option.destinationCountry) return 0;
  if (option.warehouse === "US" || EU_COUNTRIES.has(option.warehouse)) return 1;
  return 2;
}

/**
 * Picks the shipping option a variant will be listed with. Only warehouses
 * that have stock count; among those, US/EU warehouses are preferred, then the
 * fastest delivery, then the cheapest.
 */
export function chooseShippingOption(
  options: SupplierShippingOption[],
  stockByWarehouse: Record<string, number>,
): SupplierShippingOption | null {
  const available = options.filter((option) => (stockByWarehouse[option.warehouse] ?? 0) > 0);
  available.sort(
    (a, b) =>
      warehouseTier(a) - warehouseTier(b) ||
      a.deliveryDaysMax - b.deliveryDaysMax ||
      a.costCents - b.costCents,
  );
  return available[0] ?? null;
}
