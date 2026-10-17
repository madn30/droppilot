import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { decrypt, encrypt } from "../crypto";

const addressSchema = z.object({
  name: z.string(),
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  country: z.string(),
  phone: z.string().optional(),
});
export type ShippingAddress = z.infer<typeof addressSchema>;

const sealedSchema = z.object({ ciphertext: z.string(), iv: z.string(), authTag: z.string() });

/** Buyer addresses are personal data: stored encrypted, opened only to place the supplier order. */
export function sealAddress(address: ShippingAddress): Prisma.InputJsonValue {
  return { ...encrypt(JSON.stringify(addressSchema.parse(address))) };
}

export function openAddress(sealed: unknown): ShippingAddress {
  return addressSchema.parse(JSON.parse(decrypt(sealedSchema.parse(sealed))));
}
