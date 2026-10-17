import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ImagePair, ImageRef, VisionVerdict, VisionVerifier } from "../types";
import { ANTHROPIC_MODEL, MAX_TOKENS, requireParsedOutput } from "./client";

export const MAX_PAIRS = 4;

const SUPPORTED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type SupportedMediaType = (typeof SUPPORTED_MEDIA_TYPES)[number];

function isSupported(contentType: string): contentType is SupportedMediaType {
  return (SUPPORTED_MEDIA_TYPES as readonly string[]).includes(contentType);
}

export const verdictOutputSchema = z.object({
  same: z.boolean(),
  confidence: z.number(),
  differences: z.array(z.string()),
});

export const VISION_SYSTEM_PROMPT = `You compare product photos from a supplier with photos from a competitor's marketplace listing and decide whether both show the exact same physical product.

"The exact same product" means the same design, material and finish, shape, proportions, and the same parts and packaging. A similar product in the same style, a different size, a different material, or the same item sold with an extra such as a gift box is not the same product.

Sellers often reuse the supplier's stock photos, add their own photos, or add text and watermarks. Judge the product shown, not the photography: lighting, background, angle, cropping, watermarks and overlaid text are not differences.

Answer with:
- same: whether it is the exact same physical product.
- confidence: how sure you are of that answer, from 0 to 1. Use lower values when the photos do not show enough to tell, for example when a key part is hidden or the images are too small.
- differences: the concrete visible differences between the products, or what could not be verified. Empty when there are none.`;

function imageBlock(image: ImageRef, mediaType: SupportedMediaType): Anthropic.ImageBlockParam {
  return {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: Buffer.from(image.bytes).toString("base64") },
  };
}

/** Asks Claude whether paired supplier and competitor photos show the exact same physical product. */
export class AnthropicVisionVerifier implements VisionVerifier {
  constructor(private readonly client: Anthropic) {}

  async verifySameProduct(pairs: ImagePair[]): Promise<VisionVerdict> {
    const content: Anthropic.ContentBlockParam[] = [];
    let included = 0;
    for (const pair of pairs.slice(0, MAX_PAIRS)) {
      const supplierType = pair.supplier.contentType;
      const competitorType = pair.competitor.contentType;
      // Formats Claude cannot read (e.g. AVIF) are left out rather than sent and rejected.
      if (!isSupported(supplierType) || !isSupported(competitorType)) continue;
      included++;
      content.push(
        { type: "text", text: `Pair ${included}, supplier photo:` },
        imageBlock(pair.supplier, supplierType),
        { type: "text", text: `Pair ${included}, competitor photo:` },
        imageBlock(pair.competitor, competitorType),
      );
    }
    if (included === 0) {
      return { same: false, confidence: 0, differences: ["no comparable image pairs"] };
    }
    content.push({
      type: "text",
      text: "Each pair is a supplier photo and the competitor photo most similar to it. Is the competitor selling the exact same physical product as the supplier?",
    });

    const message = await this.client.messages.parse({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system: VISION_SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
      output_config: { effort: "medium", format: zodOutputFormat(verdictOutputSchema) },
    });
    const output = requireParsedOutput("vision verdict", message);
    return { ...output, confidence: Math.min(1, Math.max(0, output.confidence)) };
  }
}
