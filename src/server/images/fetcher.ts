import { getEnv } from "../env";
import { MockImageFetcher } from "./mock-image-fetcher";

export interface FetchedImage {
  bytes: Uint8Array;
  /** e.g. "image/jpeg" */
  contentType: string;
}

export interface ImageFetcher {
  fetch(url: string): Promise<FetchedImage>;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

/** Downloads product images from the supplier's (or a marketplace's) CDN. */
/** The media type from a Content-Type header, lower-cased, with the non-standard "image/jpg" some servers send read as JPEG. */
export function imageTypeOf(contentTypeHeader: string | null): string {
  const type = contentTypeHeader?.split(";")[0].trim().toLowerCase() ?? "";
  return type === "image/jpg" ? "image/jpeg" : type;
}

export class HttpImageFetcher implements ImageFetcher {
  async fetch(url: string): Promise<FetchedImage> {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Image download failed with HTTP ${response.status}: ${url}`);

    const contentType = imageTypeOf(response.headers.get("content-type"));
    if (!contentType.startsWith("image/")) throw new Error(`Not an image (${contentType || "no content type"}): ${url}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Image is larger than ${MAX_IMAGE_BYTES} bytes: ${url}`);
    return { bytes, contentType };
  }
}

export function getImageFetcher(): ImageFetcher {
  return getEnv().MOCK_APIS ? new MockImageFetcher() : new HttpImageFetcher();
}
