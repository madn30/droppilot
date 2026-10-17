import { decrypt, encrypt } from "../../crypto";
import { db } from "../../db";
import type { CjTokenStore } from "./client";
import { type CjTokens, tokenSchema } from "./schemas";

const PROVIDER = "cj";

/** Keeps CJ tokens encrypted in ApiCredential, so the app and the worker share one login. */
export const databaseTokenStore: CjTokenStore = {
  async load(): Promise<CjTokens | null> {
    const row = await db.apiCredential.findUnique({ where: { provider: PROVIDER } });
    if (!row) return null;
    return tokenSchema.parse(JSON.parse(decrypt(row)));
  },

  async save(tokens: CjTokens): Promise<void> {
    const encrypted = encrypt(JSON.stringify(tokens));
    const expiresAt = new Date(tokens.accessTokenExpiryDate);
    const data = { ...encrypted, expiresAt: Number.isNaN(expiresAt.getTime()) ? null : expiresAt };
    await db.apiCredential.upsert({
      where: { provider: PROVIDER },
      create: { provider: PROVIDER, ...data },
      update: data,
    });
  },
};
