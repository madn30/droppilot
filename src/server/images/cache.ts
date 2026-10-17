import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageFetcher } from "./fetcher";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/**
 * Downloads an image into the cache directory unless it is already there.
 * Returns the file name (relative to the cache directory), which is derived
 * from the URL so repeated imports reuse the same file.
 */
export async function cacheImage(url: string, fetcher: ImageFetcher, cacheDir: string): Promise<string> {
  const name = createHash("sha256").update(url).digest("hex").slice(0, 32);
  await mkdir(cacheDir, { recursive: true });

  const existing = (await readdir(cacheDir)).find((file) => file.startsWith(`${name}.`));
  if (existing) return existing;

  const image = await fetcher.fetch(url);
  const extension = EXTENSIONS[image.contentType];
  if (!extension) throw new Error(`Unsupported image type ${image.contentType}: ${url}`);
  const fileName = `${name}.${extension}`;
  await writeFile(path.join(cacheDir, fileName), image.bytes);
  return fileName;
}
