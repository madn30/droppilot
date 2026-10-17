import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { FetchedImage, ImageFetcher } from "./fetcher";

const SIZE = 64;
const BLOCKS = 8;

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** Encodes an 8-bit grayscale image as a PNG. */
function encodeGrayscalePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // colour type: grayscale
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    // Each row starts with filter type 0 (none).
    rows.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Serves the mock image URLs (…/images/<owner>/<n>.png?content=<photo>) as
 * real PNGs. The picture is a blocky pattern derived from `content` alone, so
 * the same photo hosted by two sellers is pixel-identical and different photos
 * look nothing alike.
 */
export class MockImageFetcher implements ImageFetcher {
  async fetch(url: string): Promise<FetchedImage> {
    const content = new URL(url).searchParams.get("content");
    if (!content) throw new Error(`Mock image URL has no content parameter: ${url}`);

    const shades = createHash("sha512").update(content).digest();
    const pixels = new Uint8Array(SIZE * SIZE);
    const blockSize = SIZE / BLOCKS;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        pixels[y * SIZE + x] = shades[Math.floor(y / blockSize) * BLOCKS + Math.floor(x / blockSize)];
      }
    }
    return { bytes: encodeGrayscalePng(pixels, SIZE, SIZE), contentType: "image/png" };
  }
}
