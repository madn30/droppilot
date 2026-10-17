import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockImageUrl } from "../mocks/fixtures/necklace";
import { cacheImage } from "./cache";
import { type ImageFetcher, imageTypeOf } from "./fetcher";
import { MockImageFetcher } from "./mock-image-fetcher";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("MockImageFetcher", () => {
  const fetcher = new MockImageFetcher();

  it("returns a valid 64×64 PNG", async () => {
    const { bytes, contentType } = await fetcher.fetch(mockImageUrl("cj", 1, "necklace-1"));
    expect(contentType).toBe("image/png");
    const png = Buffer.from(bytes);
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(64);
    const idatLength = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString("ascii")).toBe("IDAT");
    // 64 rows of one filter byte + 64 pixels.
    expect(inflateSync(png.subarray(41, 41 + idatLength))).toHaveLength(64 * 65);
  });

  it("gives the same photo identical bytes whoever hosts it, and different photos different bytes", async () => {
    const supplier = await fetcher.fetch(mockImageUrl("cj", 1, "necklace-1"));
    const reused = await fetcher.fetch(mockImageUrl("ebay-D", 3, "necklace-1"));
    const other = await fetcher.fetch(mockImageUrl("ebay-A", 1, "round-1"));
    expect(Buffer.from(reused.bytes).equals(Buffer.from(supplier.bytes))).toBe(true);
    expect(Buffer.from(other.bytes).equals(Buffer.from(supplier.bytes))).toBe(false);
  });

  it("rejects URLs that are not mock images", async () => {
    await expect(fetcher.fetch("https://example.com/a.png")).rejects.toThrow(/content parameter/);
  });
});

describe("cacheImage", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "droppilot-images-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function countingFetcher(contentType = "image/jpeg"): ImageFetcher & { calls: number } {
    return {
      calls: 0,
      async fetch() {
        this.calls++;
        return { bytes: new Uint8Array([1, 2, 3]), contentType };
      },
    };
  }

  it("writes the image once and reuses the file afterwards", async () => {
    const fetcher = countingFetcher();
    const first = await cacheImage("https://cdn.example.com/a.jpg", fetcher, dir);
    const second = await cacheImage("https://cdn.example.com/a.jpg", fetcher, dir);
    expect(first).toMatch(/^[0-9a-f]{32}\.jpg$/);
    expect(second).toBe(first);
    expect(fetcher.calls).toBe(1);
    expect([...(await readFile(path.join(dir, first)))]).toEqual([1, 2, 3]);
  });

  it("stores different URLs in different files", async () => {
    const fetcher = countingFetcher("image/webp");
    await cacheImage("https://cdn.example.com/a", fetcher, dir);
    await cacheImage("https://cdn.example.com/b", fetcher, dir);
    const files = await readdir(dir);
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.endsWith(".webp"))).toBe(true);
  });

  it("refuses content that is not a supported image type", async () => {
    await expect(cacheImage("https://cdn.example.com/a", countingFetcher("image/svg+xml"), dir)).rejects.toThrow(/Unsupported/);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("imageTypeOf", () => {
  it("reads the media type and treats image/jpg as JPEG", () => {
    expect(imageTypeOf("image/jpg")).toBe("image/jpeg");
    expect(imageTypeOf("Image/JPEG; charset=binary")).toBe("image/jpeg");
    expect(imageTypeOf("image/png")).toBe("image/png");
    expect(imageTypeOf(null)).toBe("");
  });
});
