import { pHashSimilarity } from "./phash";

export interface ImageFingerprint {
  pHash: string;
  /** Unit-length CLIP embedding. */
  embedding: number[];
}

export interface ImageMatch {
  supplierIndex: number;
  competitorIndex: number;
  similarity: number;
}

export interface ImageScore {
  /** Share of supplier images that have a strong match among the competitor's images. */
  imageScore: number;
  matchedImageCount: number;
  /** Best competitor image for every supplier image, strongest first. */
  bestMatches: ImageMatch[];
}

// At or above this pHash similarity two files are the same photo (resized or recompressed).
const PHASH_NEAR_DUPLICATE = 0.9;

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index++) dot += a[index] * b[index];
  return Math.max(0, Math.min(1, dot));
}

/**
 * pHash is the cheap first pass: a near-duplicate hash settles the pair.
 * Otherwise the CLIP embeddings decide, which also recognises the same
 * product photographed differently.
 */
export function pairSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  const hashSimilarity = pHashSimilarity(a.pHash, b.pHash);
  if (hashSimilarity >= PHASH_NEAR_DUPLICATE) return hashSimilarity;
  return cosine(a.embedding, b.embedding);
}

/** Compares every supplier image with every competitor image and keeps each supplier image's best match. */
export function scoreImages(
  supplier: ImageFingerprint[],
  competitor: ImageFingerprint[],
  strongMatchThreshold: number,
): ImageScore {
  if (supplier.length === 0 || competitor.length === 0) {
    return { imageScore: 0, matchedImageCount: 0, bestMatches: [] };
  }

  const bestMatches = supplier.map((supplierImage, supplierIndex) => {
    let best: ImageMatch = { supplierIndex, competitorIndex: 0, similarity: -1 };
    competitor.forEach((competitorImage, competitorIndex) => {
      const similarity = pairSimilarity(supplierImage, competitorImage);
      if (similarity > best.similarity) best = { supplierIndex, competitorIndex, similarity };
    });
    return best;
  });

  const matchedImageCount = bestMatches.filter((match) => match.similarity > strongMatchThreshold).length;
  return {
    imageScore: matchedImageCount / supplier.length,
    matchedImageCount,
    bestMatches: bestMatches.sort((a, b) => b.similarity - a.similarity),
  };
}
