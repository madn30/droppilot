import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ASPECT_SYSTEM_PROMPT, acceptAspectValues, aspectsOutputSchema, formatAspectRequest } from "../anthropic/aspect-filler";
import { COPY_SYSTEM_PROMPT, copyOutputSchema, fitTitle, formatRequest } from "../anthropic/listing-copy";
import { SPEC_SYSTEM_PROMPT, formatListing, normalizeSpecs, specsOutputSchema } from "../anthropic/spec-extractor";
import { MAX_PAIRS, VISION_SYSTEM_PROMPT, verdictOutputSchema } from "../anthropic/vision-verifier";
import type { ProductSpecs } from "../../matching/specs";
import type {
  AspectFillInput,
  AspectFiller,
  ImagePair,
  ListingCopyGenerator,
  ListingCopyInput,
  SpecExtractionInput,
  SpecExtractor,
  VisionVerdict,
  VisionVerifier,
} from "../types";
import { type ClaudeExec, askClaudeCli } from "./runner";

// The same jobs as the Anthropic API implementations, with the same prompts,
// run through the local Claude CLI instead.

const IMAGE_EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

export class ClaudeCliSpecExtractor implements SpecExtractor {
  constructor(private readonly exec?: ClaudeExec) {}

  async extractSpecs(input: SpecExtractionInput): Promise<ProductSpecs> {
    const output = await askClaudeCli(
      { task: "product specs", system: SPEC_SYSTEM_PROMPT, prompt: formatListing(input), schema: specsOutputSchema, effort: "low" },
      this.exec,
    );
    return normalizeSpecs(output);
  }
}

export class ClaudeCliVisionVerifier implements VisionVerifier {
  constructor(private readonly exec?: ClaudeExec) {}

  async verifySameProduct(pairs: ImagePair[]): Promise<VisionVerdict> {
    // The CLI looks at images by reading files, so the pairs are written to a private folder it is confined to.
    const dir = await mkdtemp(path.join(os.tmpdir(), "droppilot-vision-"));
    try {
      const lines: string[] = [];
      let included = 0;
      for (const pair of pairs.slice(0, MAX_PAIRS)) {
        const supplierExtension = IMAGE_EXTENSIONS[pair.supplier.contentType];
        const competitorExtension = IMAGE_EXTENSIONS[pair.competitor.contentType];
        // Formats Claude cannot read (e.g. AVIF) are left out.
        if (!supplierExtension || !competitorExtension) continue;
        included++;
        const supplierFile = `pair-${included}-supplier.${supplierExtension}`;
        const competitorFile = `pair-${included}-competitor.${competitorExtension}`;
        await writeFile(path.join(dir, supplierFile), pair.supplier.bytes);
        await writeFile(path.join(dir, competitorFile), pair.competitor.bytes);
        lines.push(`Pair ${included}, supplier photo: ./${supplierFile}`, `Pair ${included}, competitor photo: ./${competitorFile}`);
      }
      if (included === 0) return { same: false, confidence: 0, differences: ["no comparable image pairs"] };

      const output = await askClaudeCli(
        {
          task: "vision verdict",
          system: VISION_SYSTEM_PROMPT,
          prompt: [
            ...lines,
            "",
            "Open every image file listed above with the Read tool before answering.",
            "Each pair is a supplier photo and the competitor photo most similar to it. Is the competitor selling the exact same physical product as the supplier?",
          ].join("\n"),
          schema: verdictOutputSchema,
          effort: "medium",
          readableDir: dir,
        },
        this.exec,
      );
      return { ...output, confidence: Math.min(1, Math.max(0, output.confidence)) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export class ClaudeCliListingCopyGenerator implements ListingCopyGenerator {
  constructor(private readonly exec?: ClaudeExec) {}

  async generateListingCopy(input: ListingCopyInput): Promise<{ title: string; description: string }> {
    const output = await askClaudeCli(
      { task: "listing copy", system: COPY_SYSTEM_PROMPT, prompt: formatRequest(input), schema: copyOutputSchema, effort: "medium" },
      this.exec,
    );
    const title = fitTitle(output.title, input.maxTitleLength);
    if (!title || !output.description.trim()) throw new Error("Claude returned an empty listing title or description");
    return { title, description: output.description.trim() };
  }
}

export class ClaudeCliAspectFiller implements AspectFiller {
  constructor(private readonly exec?: ClaudeExec) {}

  async fillAspects(input: AspectFillInput): Promise<Record<string, string>> {
    const output = await askClaudeCli(
      { task: "item specifics", system: ASPECT_SYSTEM_PROMPT, prompt: formatAspectRequest(input), schema: aspectsOutputSchema, effort: "low" },
      this.exec,
    );
    return acceptAspectValues(input, output);
  }
}
