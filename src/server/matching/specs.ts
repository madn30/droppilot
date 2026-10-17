import { z } from "zod";

// The attributes that decide whether two listings are the exact same product.
// null = the listing does not say.
export const productSpecsSchema = z.object({
  material: z.string().nullable(),
  shape: z.string().nullable(),
  sizeCm: z.number().positive().nullable(),
  color: z.string().nullable(),
  personalization: z.boolean().nullable(),
  giftBox: z.boolean().nullable(),
  packQuantity: z.number().int().positive().nullable(),
});

export type ProductSpecs = z.infer<typeof productSpecsSchema>;
