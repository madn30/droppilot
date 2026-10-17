import type { Marketplace } from "@prisma/client";
import { type Notifier, getNotifiers } from "../alerts/notifiers";
import { getMarketplaceAdapter } from "../marketplaces";
import type { MarketplaceAdapter } from "../marketplaces/types";
import type { Settings } from "../settings/schema";
import { getSettings } from "../settings/service";
import { getSupplierAdapter } from "../suppliers";
import type { SupplierAdapter } from "../suppliers/types";

export interface OrderDeps {
  supplier: SupplierAdapter;
  getMarketplace: (marketplace: Marketplace) => MarketplaceAdapter;
  notifiers: Notifier[];
  settings: Settings;
  now?: () => Date;
}

/** The real (or mock, under MOCK_APIS) collaborators for order automation and account health. */
export async function buildOrderDeps(): Promise<OrderDeps> {
  return {
    supplier: getSupplierAdapter(),
    getMarketplace: getMarketplaceAdapter,
    notifiers: getNotifiers(),
    settings: await getSettings(),
  };
}
