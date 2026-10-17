import { z } from "zod";
import { withRetry } from "../../http/retry";
import type { EmbeddingsProvider } from "../types";

const ENDPOINT = "https://api.jina.ai/v1/embeddings";
const MODEL = "jina-clip-v2";
const BATCH_SIZE = 16;
// Jina limits tokens per minute (100,000 on the free plan, about 25 images). A request over the limit is
// refused until the minute has passed, so the wait must cover the whole window.
const RATE_LIMIT_WINDOW_MS = 61_000;
const MAX_RATE_LIMIT_WAITS = 10;

const responseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

class JinaHttpError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "JinaHttpError";
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof JinaHttpError && (error.status === null || error.status >= 500);
}

export interface JinaClipOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** CLIP image embeddings from the Jina AI API (jina-clip-v2), L2-normalized. */
export class JinaClipEmbeddings implements EmbeddingsProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: JinaClipOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async embedImages(images: { bytes: Uint8Array; contentType: string }[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < images.length; start += BATCH_SIZE) {
      const batch = images.slice(start, start + BATCH_SIZE);
      vectors.push(
        ...(await withRetry(() => this.embedWithinRateLimit(batch), {
          retries: 4,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
          shouldRetry: isRetryable,
          sleep: this.options.sleep,
        })),
      );
    }
    return vectors;
  }

  /** Embeds a batch, waiting out the per-minute rate limit when Jina refuses it with HTTP 429. */
  private async embedWithinRateLimit(batch: { bytes: Uint8Array }[]): Promise<number[][]> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let waits = 0; ; waits++) {
      try {
        return await this.embedBatch(batch);
      } catch (error) {
        if (!(error instanceof JinaHttpError) || error.status !== 429 || waits >= MAX_RATE_LIMIT_WAITS) throw error;
        await sleep(RATE_LIMIT_WINDOW_MS);
      }
    }
  }

  private async embedBatch(batch: { bytes: Uint8Array }[]): Promise<number[][]> {
    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          normalized: true,
          embedding_type: "float",
          input: batch.map((image) => ({ image: Buffer.from(image.bytes).toString("base64") })),
        }),
      });
    } catch (error) {
      throw new JinaHttpError(null, `Jina embeddings request failed: ${String(error)}`);
    }
    if (!response.ok) {
      throw new JinaHttpError(response.status, `Jina embeddings returned HTTP ${response.status}: ${await response.text()}`);
    }

    const { data } = responseSchema.parse(await response.json());
    if (data.length !== batch.length) {
      throw new Error(`Jina returned ${data.length} embeddings for ${batch.length} images`);
    }
    return [...data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}
