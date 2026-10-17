import { getListingCopyGenerator } from "../ai";
import { getNotifiers } from "../alerts/notifiers";
import { getMarketplaceAdapter } from "../marketplaces";
import { getSettings } from "../settings/service";
import { getSupplierAdapter } from "../suppliers";
import type { SyncDeps } from "../sync/run";
import type { ListingDeps } from "./service";

/** The real (or mock, under MOCK_APIS) collaborators for creating and publishing listings. */
export async function buildListingDeps(): Promise<ListingDeps> {
  return { copyGenerator: getListingCopyGenerator(), getMarketplace: getMarketplaceAdapter, notifiers: getNotifiers(), settings: await getSettings() };
}

/** The same for supplier sync and repricing. */
export async function buildSyncDeps(): Promise<SyncDeps> {
  return { supplier: getSupplierAdapter(), getMarketplace: getMarketplaceAdapter, notifiers: getNotifiers(), settings: await getSettings() };
}
