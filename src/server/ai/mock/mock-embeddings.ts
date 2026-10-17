import { createHash } from "node:crypto";
import type { EmbeddingsProvider } from "../types";

const DIMENSIONS = 64;

/**
 * Deterministic stand-in for CLIP: identical bytes give identical vectors
 * (similarity 1), different bytes give unrelated vectors (similarity near 0).
 */
export class MockEmbeddingsProvider implements EmbeddingsProvider {
  async embedImages(images: { bytes: Uint8Array; contentType: string }[]): Promise<number[][]> {
    return images.map(({ bytes }) => {
      const vector: number[] = [];
      for (let block = 0; vector.length < DIMENSIONS; block++) {
        const digest = createHash("sha256").update(bytes).update(String(block)).digest();
        for (let offset = 0; offset + 4 <= digest.length && vector.length < DIMENSIONS; offset += 4) {
          vector.push(digest.readInt32BE(offset));
        }
      }
      const norm = Math.hypot(...vector);
      return vector.map((value) => value / norm);
    });
  }
}
