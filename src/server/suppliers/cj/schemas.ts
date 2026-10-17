import { z } from "zod";

// Shapes of the CJ Dropshipping API v2 responses we read. CJ is loose about
// types (prices arrive as numbers or strings), so the schemas coerce and
// ignore every field we do not use.

const money = z.union([z.number(), z.string()]);
const optionalText = z.string().nullish();

export const envelopeSchema = z.object({
  code: z.number(),
  message: z.string().nullish(),
  data: z.unknown(),
  requestId: z.string().nullish(),
});

export const tokenSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiryDate: z.string(),
  refreshToken: z.string().min(1),
  refreshTokenExpiryDate: z.string(),
});
export type CjTokens = z.infer<typeof tokenSchema>;

export const productListSchema = z.object({
  content: z
    .array(
      z.object({
        productList: z.array(
          z.object({
            id: z.string(),
            nameEn: z.string(),
            bigImage: z.string(),
            sellPrice: money.nullish(),
            nowPrice: money.nullish(),
            threeCategoryName: optionalText,
          }),
        ),
      }),
    )
    .nullish(),
});

const variantSchema = z.object({
  vid: z.string(),
  pid: z.string(),
  variantSku: z.string(),
  variantNameEn: optionalText,
  variantKey: optionalText,
  variantImage: optionalText,
  variantSellPrice: money,
});

export const productSchema = z.object({
  pid: z.string(),
  productNameEn: z.string(),
  bigImage: optionalText,
  productImageSet: z.array(z.string()).nullish(),
  categoryName: optionalText,
  description: optionalText,
  productKeyEn: optionalText,
  // The ordered image list arrives as a JSON string; productImageSet holds the same URLs in no particular order.
  productImage: optionalText,
  productType: optionalText,
  productProEnSet: z.array(z.string()).nullish(),
  customizationJson1: optionalText,
  customizationJson2: optionalText,
  customizationJson3: optionalText,
  customizationJson4: optionalText,
  variants: z.array(variantSchema).nullish(),
});

const countryInventorySchema = z.object({
  countryCode: z.string(),
  totalInventory: z.number().nullish(),
});

export const variantWithInventorySchema = variantSchema.extend({
  inventories: z.array(countryInventorySchema).nullish(),
});

export const variantStockSchema = z.array(
  z.object({
    countryCode: z.string(),
    totalInventoryNum: z.number().nullish(),
    storageNum: z.number().nullish(),
  }),
);

export const productInventorySchema = z.object({
  variantInventories: z
    .array(z.object({ vid: z.string(), inventory: z.array(countryInventorySchema).nullish() }))
    .nullish(),
});

export const freightSchema = z.array(
  z.object({
    logisticName: z.string(),
    logisticPrice: money,
    logisticAging: optionalText,
  }),
);

export const createOrderSchema = z.object({
  orderId: z.string().min(1),
  productAmount: money.nullish(),
  postageAmount: money.nullish(),
  interceptOrderReasons: z.array(z.object({ code: z.number().nullish(), message: optionalText })).nullish(),
});

export const orderDetailSchema = z.object({
  orderId: z.string(),
  orderStatus: z.string(),
  productAmount: money.nullish(),
  postageAmount: money.nullish(),
  logisticName: optionalText,
  trackNumber: optionalText,
  createDate: optionalText,
  paymentDate: optionalText,
});

export const trackInfoSchema = z.array(
  z.object({
    trackingStatus: optionalText,
    deliveryTime: optionalText,
    lastMileCarrier: optionalText,
    trackingTo: optionalText,
  }),
);
