import type { Marketplace } from "@prisma/client";
import type { ProductSpecs } from "../matching/specs";

export interface SpecExtractionInput {
  title: string;
  description: string;
  itemSpecifics: Record<string, string>;
}

export interface SpecExtractor {
  extractSpecs(input: SpecExtractionInput): Promise<ProductSpecs>;
}

export interface ImageRef {
  url: string;
  bytes: Uint8Array;
  /** e.g. "image/jpeg" */
  contentType: string;
}

export interface ImagePair {
  supplier: ImageRef;
  competitor: ImageRef;
}

export interface VisionVerdict {
  same: boolean;
  confidence: number;
  differences: string[];
}

export interface VisionVerifier {
  /** "Is this the exact same physical product?" over the top image pairs (max 4). */
  verifySameProduct(pairs: ImagePair[]): Promise<VisionVerdict>;
}

export interface ListingCopyInput {
  marketplace: Marketplace;
  sourceTitle: string;
  sourceDescription: string;
  specs: ProductSpecs;
  keywords: string[];
  maxTitleLength: number;
}

export interface ListingCopyGenerator {
  generateListingCopy(input: ListingCopyInput): Promise<{ title: string; description: string }>;
}

export interface EmbeddingsProvider {
  /** One unit-length vector per image, in input order; cosine similarity is the dot product. */
  embedImages(images: { bytes: Uint8Array; contentType: string }[]): Promise<number[][]>;
}

/** An item specific a marketplace category requires. */
export interface RequiredAspect {
  name: string;
  /** The marketplace's values for it; with freeText false the answer must be one of them. */
  allowedValues: string[];
  freeText: boolean;
}

export interface AspectFillInput {
  title: string;
  description: string;
  aspects: RequiredAspect[];
}

export interface AspectFiller {
  /** A value per aspect the listing supports; aspects it cannot answer truthfully are left out. */
  fillAspects(input: AspectFillInput): Promise<Record<string, string>>;
}
