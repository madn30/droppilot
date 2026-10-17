import { type Env, getEnv } from "../env";
import { CjSupplierAdapter } from "./cj/cj-adapter";
import { CjClient } from "./cj/client";
import { databaseTokenStore } from "./cj/token-store";
import { MockSupplierAdapter } from "./mock/mock-supplier";
import type { SupplierAdapter } from "./types";

let supplier: SupplierAdapter | undefined;

// One instance per process: the mock is stateful and the CJ client holds the rate limiter.
export function getSupplierAdapter(): SupplierAdapter {
  if (supplier) return supplier;
  const env = getEnv();
  if (env.MOCK_APIS) {
    supplier = new MockSupplierAdapter();
  } else {
    if (!env.CJ_API_KEY) throw new Error("CJ_API_KEY is required when MOCK_APIS=false");
    supplier = new CjSupplierAdapter(new CjClient({ apiKey: env.CJ_API_KEY, tokenStore: databaseTokenStore }), {
      sandboxOrders: env.CJ_SANDBOX_ORDERS,
    });
  }
  return supplier;
}

/** The supplier's own page for a product; null in mock mode, where product ids are made up. */
export function supplierProductUrl(env: Pick<Env, "MOCK_APIS">, supplierCode: string, externalId: string): string | null {
  if (env.MOCK_APIS || supplierCode !== "cj") return null;
  // CJ redirects this short form to the product's full page.
  return `https://cjdropshipping.com/product/-p-${encodeURIComponent(externalId)}.html`;
}
