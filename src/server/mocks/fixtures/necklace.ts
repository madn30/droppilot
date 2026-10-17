import type { VisionVerdict } from "../../ai/types";
import type { CompetitorCandidate } from "../../marketplaces/types";
import type { SupplierProduct, SupplierShippingOption, SupplierVariant } from "../../suppliers/types";

// The reference scenario: one CJ product and eight competitor listings (A–H),
// of which only D and F are the exact same product.

/**
 * Mock image URL. `content` names the picture itself: two URLs with the same
 * content are the same photo (a reused supplier image), whoever hosts it.
 */
export function mockImageUrl(owner: string, position: number, content: string): string {
  return `https://mock.droppilot.local/images/${owner}/${position}.png?content=${content}`;
}

const SUPPLIER_PHOTOS = ["necklace-1", "necklace-2", "necklace-3", "necklace-4", "necklace-5", "necklace-6"];

function images(owner: string, contents: string[]): string[] {
  return contents.map((content, index) => mockImageUrl(owner, index + 1, content));
}

export const NECKLACE_PRODUCT_ID = "CJ-NECKLACE-001";
export const NECKLACE_VARIANT_ID = "CJ-NECKLACE-001-RG";

export const necklaceProduct: SupplierProduct = {
  externalId: NECKLACE_PRODUCT_ID,
  title: "Custom Photo Projection Necklace",
  description:
    "Personalized photo projection necklace. Heart pendant with your custom photo hidden inside the stone. " +
    "Material: copper. Color: rose gold. Chain length: 40+5cm adjustable. Package: opp bag, 1 pc.",
  category: "Jewelry > Necklaces",
  isPersonalized: true,
  imageUrls: images("cj", SUPPLIER_PHOTOS),
  detailImageUrls: images("cj-detail", ["size-chart"]),
};

/** Occasion keywords under which the supplier's catalog search returns each product. */
export const mockSearchTags: Record<string, string[]> = {
  [NECKLACE_PRODUCT_ID]: ["valentines day gift", "gift for her", "gift for girlfriend", "mothers day gift", "gift for mom"],
};

/** Products on the supplier's trending list. */
export const mockTrendingProductIds = new Set([NECKLACE_PRODUCT_ID]);

export const necklaceVariants: SupplierVariant[] = [
  {
    externalId: NECKLACE_VARIANT_ID,
    productExternalId: NECKLACE_PRODUCT_ID,
    sku: "CJNK001-RG",
    attributes: { color: "rose gold", material: "copper", shape: "heart", size: "40+5cm", giftBox: "no" },
    costCents: 1120,
    currency: "USD",
    warehouses: ["US", "CN"],
    processingDays: 2,
    imageUrl: mockImageUrl("cj", 1, "necklace-1"),
  },
];

export const necklaceStock: Record<string, Record<string, number>> = {
  [NECKLACE_VARIANT_ID]: { US: 240, CN: 1800 },
};

export const necklaceShipping: Record<string, SupplierShippingOption[]> = {
  [NECKLACE_VARIANT_ID]: [
    {
      name: "CJPacket US Warehouse",
      warehouse: "US",
      destinationCountry: "US",
      costCents: 490,
      deliveryDaysMin: 3,
      deliveryDaysMax: 5,
    },
    {
      name: "CJPacket Ordinary",
      warehouse: "CN",
      destinationCountry: "US",
      costCents: 310,
      deliveryDaysMin: 8,
      deliveryDaysMax: 14,
    },
  ],
};

function ebayListing(
  id: string,
  listing: Omit<CompetitorCandidate, "marketplace" | "externalId" | "url" | "currency">,
): CompetitorCandidate {
  return {
    marketplace: "EBAY",
    externalId: `EBAY-${id}`,
    url: `https://www.ebay.com/itm/EBAY-${id}`,
    currency: "USD",
    ...listing,
  };
}

export const necklaceCompetitors: CompetitorCandidate[] = [
  // A — plain round pendant, not personalized.
  ebayListing("A", {
    title: "Round Pendant Necklace Rose Gold Plated Chain for Women",
    description: "Simple round pendant necklace. Copper with rose gold plating. Chain 45cm.",
    priceCents: 499,
    shippingCents: 0,
    deliveryDays: 18,
    sellerRating: 97.1,
    soldCount: 812,
    imageUrls: images("ebay-A", ["round-1", "round-2", "round-3"]),
    itemSpecifics: { Material: "Copper", Shape: "Round", Color: "Rose Gold", Length: "45cm" },
  }),
  // B — same heart shape, but no photo inside.
  ebayListing("B", {
    title: "Heart Pendant Necklace Rose Gold Women Jewelry Gift",
    description: "Heart pendant necklace, copper, rose gold color. 45cm chain.",
    priceCents: 1593,
    shippingCents: 0,
    deliveryDays: 9,
    sellerRating: 98.4,
    soldCount: 143,
    imageUrls: images("ebay-B", ["plain-heart-1", "plain-heart-2", "plain-heart-3", "plain-heart-4"]),
    itemSpecifics: { Material: "Copper", Shape: "Heart", Color: "Rose Gold", Length: "45cm" },
  }),
  // C — sterling silver, different material.
  ebayListing("C", {
    title: "925 Sterling Silver Heart Pendant Necklace",
    description: "Solid 925 sterling silver heart pendant on a 45cm chain.",
    priceCents: 5861,
    shippingCents: 0,
    deliveryDays: 4,
    sellerRating: 99.6,
    soldCount: 58,
    imageUrls: images("ebay-C", ["silver-heart-1", "silver-heart-2", "silver-heart-3"]),
    itemSpecifics: { Material: "925 Silver", Shape: "Heart", Color: "Silver", Length: "45cm" },
  }),
  // D — the exact same product; reuses four of the six supplier photos.
  ebayListing("D", {
    title: "Personalized Photo Projection Necklace Heart Pendant Custom Picture Rose Gold",
    description:
      "Custom photo projection necklace. Send us your photo and we hide it inside the heart pendant. " +
      "Copper, rose gold. Chain length 45cm. Ships in opp bag.",
    priceCents: 2699,
    shippingCents: 0,
    deliveryDays: 7,
    sellerRating: 98.9,
    soldCount: 327,
    imageUrls: images("ebay-D", ["necklace-1", "necklace-2", "necklace-3", "necklace-4", "seller-d-1", "seller-d-2"]),
    itemSpecifics: { Material: "Copper", Shape: "Heart", Color: "Rose Gold", Length: "45cm", Personalized: "Yes" },
  }),
  // E — same necklace sold with a gift box: a different package, so a different market.
  ebayListing("E", {
    title: "Personalized Photo Projection Necklace Heart Pendant Custom Picture with Gift Box",
    description:
      "Custom photo projection heart necklace, copper, rose gold, 45cm chain. Comes with gift box, ready to give.",
    priceCents: 2995,
    shippingCents: 0,
    deliveryDays: 7,
    sellerRating: 99.1,
    soldCount: 211,
    imageUrls: images("ebay-E", ["necklace-1", "necklace-2", "necklace-3", "necklace-4", "necklace-5", "gift-box-1"]),
    itemSpecifics: { Material: "Copper", Shape: "Heart", Color: "Rose Gold", Length: "45cm", Personalized: "Yes" },
  }),
  // F — the exact same product on Amazon.
  {
    marketplace: "AMAZON",
    externalId: "B0MOCKNKF1",
    url: "https://www.amazon.com/dp/B0MOCKNKF1",
    currency: "USD",
    title: "Custom Photo Projection Necklace for Women, Personalized Heart Pendant with Picture Inside, Rose Gold",
    description:
      "Personalized projection necklace with your custom photo inside the heart pendant. Copper with rose gold plating, 45cm chain.",
    priceCents: 2499,
    shippingCents: 0,
    deliveryDays: 5,
    sellerRating: 4.4,
    soldCount: null,
    imageUrls: images("amazon-F", ["necklace-1", "necklace-2", "necklace-3", "necklace-5", "necklace-6", "seller-f-1"]),
    itemSpecifics: { Material: "Copper", "Item Shape": "Heart", Color: "Rose Gold", "Chain Length": "45cm" },
  },
  // G — same pendant on a 60cm chain: size is outside ±10%.
  ebayListing("G", {
    title: "Personalized Photo Projection Necklace Heart Pendant Custom Picture Long Chain",
    description: "Custom photo projection heart necklace, copper, rose gold. Long 60cm chain.",
    priceCents: 2250,
    shippingCents: 0,
    deliveryDays: 10,
    sellerRating: 98.0,
    soldCount: 96,
    imageUrls: images("ebay-G", ["necklace-1", "necklace-2", "necklace-3", "necklace-4", "long-chain-1"]),
    itemSpecifics: { Material: "Copper", Shape: "Heart", Color: "Rose Gold", Length: "60cm", Personalized: "Yes" },
  }),
  // H — probably the same product, but the listing never states the pendant shape.
  ebayListing("H", {
    title: "Custom Photo Projection Necklace Personalized Picture Pendant Rose Gold",
    description: "Projection necklace with your custom photo inside the pendant. Copper, rose gold, 45cm chain.",
    priceCents: 2749,
    shippingCents: 0,
    deliveryDays: 8,
    sellerRating: 97.8,
    soldCount: 64,
    imageUrls: images("ebay-H", ["necklace-1", "necklace-2", "necklace-3", "seller-h-1", "seller-h-2", "seller-h-3"]),
    itemSpecifics: { Material: "Copper", Color: "Rose Gold", Length: "45cm", Personalized: "Yes" },
  }),
];

/** What a vision model would say when comparing each competitor's photos to the supplier's. */
export const necklaceVisionVerdicts: Record<string, VisionVerdict> = {
  "ebay-A": { same: false, confidence: 0.97, differences: ["round pendant, no photo stone"] },
  "ebay-B": { same: false, confidence: 0.9, differences: ["no projection stone in the pendant"] },
  "ebay-C": { same: false, confidence: 0.95, differences: ["silver finish", "no projection stone"] },
  "ebay-D": { same: true, confidence: 0.95, differences: [] },
  "ebay-E": { same: true, confidence: 0.9, differences: ["sold with a gift box"] },
  "amazon-F": { same: true, confidence: 0.93, differences: [] },
  "ebay-G": { same: true, confidence: 0.82, differences: ["chain appears longer"] },
  "ebay-H": { same: true, confidence: 0.68, differences: ["pendant shape not clearly visible"] },
};
