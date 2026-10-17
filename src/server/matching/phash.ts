import sharp from "sharp";

const SIZE = 32;
const LOW_FREQUENCIES = 8;

// cos((2x + 1) · u · π / 2N) for the 8 lowest frequencies.
const COSINES = Array.from({ length: LOW_FREQUENCIES }, (_, u) =>
  Array.from({ length: SIZE }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE))),
);

/**
 * Perceptual hash (pHash): shrink to 32×32 grayscale, take the 8×8
 * lowest-frequency DCT coefficients and record which are above their median.
 * Resizing, recompression and small edits barely change the result.
 * Returns 64 bits as 16 hex characters.
 */
export async function computePHash(image: Uint8Array): Promise<string> {
  const pixels = await sharp(image).grayscale().resize(SIZE, SIZE, { fit: "fill" }).raw().toBuffer();

  const coefficients: number[] = [];
  for (let u = 0; u < LOW_FREQUENCIES; u++) {
    for (let v = 0; v < LOW_FREQUENCIES; v++) {
      let sum = 0;
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          sum += pixels[y * SIZE + x] * COSINES[u][y] * COSINES[v][x];
        }
      }
      coefficients.push(sum);
    }
  }

  // The first coefficient is the average brightness; it would skew the median.
  const sorted = coefficients.slice(1).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  let hex = "";
  for (let nibble = 0; nibble < 16; nibble++) {
    let value = 0;
    for (let bit = 0; bit < 4; bit++) {
      value = (value << 1) | (coefficients[nibble * 4 + bit] > median ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

const BIT_COUNTS = Array.from({ length: 16 }, (_, value) => value.toString(2).replaceAll("0", "").length);

/** 1 = identical hashes, about 0.5 = unrelated images. */
export function pHashSimilarity(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) throw new Error("pHash must be 16 hex characters");
  let distance = 0;
  for (let index = 0; index < 16; index++) {
    distance += BIT_COUNTS[Number.parseInt(a[index], 16) ^ Number.parseInt(b[index], 16)];
  }
  return 1 - distance / 64;
}
