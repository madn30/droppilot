import { z } from "zod";
import { RateLimiter } from "../../http/rate-limiter";
import { withRetry } from "../../http/retry";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const HOSTS = {
  na: "https://sellingpartnerapi-na.amazon.com",
  eu: "https://sellingpartnerapi-eu.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
} as const;
export const AMAZON_MARKETPLACE_ID = "ATVPDKIKX0DER"; // amazon.com (US)

const TOKEN_EXPIRY_MARGIN_MS = 60_000;
// SP-API limits differ per operation; these keep each group under its sustained rate.
const INTERVALS_MS = { default: 550, pricing: 2100 } as const;
export type SpApiRateGroup = keyof typeof INTERVALS_MS;

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number() });
const errorBodySchema = z.object({
  errors: z.array(z.object({ code: z.string().optional(), message: z.string().optional() })).optional(),
  error_description: z.string().optional(),
});

class SpApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly codes: string[],
    message: string,
  ) {
    super(message);
    this.name = "SpApiError";
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof SpApiError && (error.status === null || error.status === 429 || error.status >= 500);
}

export interface SpApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
  rateGroup?: SpApiRateGroup;
  /** A restricted data token, required instead of the access token for calls that return buyer PII. */
  restrictedDataToken?: string;
}

export interface SpApiClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  region: keyof typeof HOSTS;
  fetch?: typeof fetch;
  /** Overrides the per-group limiters (tests pass one with no delay). */
  rateLimiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Login-with-Amazon authenticated, rate-limited, retrying access to the Selling Partner API. */
export class SpApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly host: string;
  private readonly limiters: Record<SpApiRateGroup, RateLimiter>;
  private token: { accessToken: string; expiresAt: number } | null = null;

  constructor(private readonly options: SpApiClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.host = HOSTS[options.region];
    this.limiters = {
      default: options.rateLimiter ?? new RateLimiter(INTERVALS_MS.default),
      pricing: options.rateLimiter ?? new RateLimiter(INTERVALS_MS.pricing),
    };
  }

  /** Sends a request and parses the JSON reply; calls that answer 204 No Content parse `undefined`. */
  async request<T>(request: SpApiRequest, schema: z.ZodType<T>): Promise<T> {
    try {
      return await this.send(request, schema);
    } catch (error) {
      // An access token can be revoked before it expires; fetch a new one once.
      if (!(error instanceof SpApiError) || error.status !== 403 || !error.codes.includes("Unauthorized") || request.restrictedDataToken) throw error;
      this.token = null;
      return this.send(request, schema);
    }
  }

  private send<T>(request: SpApiRequest, schema: z.ZodType<T>): Promise<T> {
    return withRetry(
      async () => {
        const token = request.restrictedDataToken ?? (await this.accessToken());
        return this.limiters[request.rateGroup ?? "default"].schedule(() => this.sendOnce(request, schema, token));
      },
      { retries: 4, baseDelayMs: 2000, maxDelayMs: 60_000, shouldRetry: isRetryable, sleep: this.options.sleep },
    );
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now() > TOKEN_EXPIRY_MARGIN_MS) return this.token.accessToken;
    const response = await this.fetchRaw(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.options.refreshToken,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }).toString(),
    });
    const json = await this.readJson(response, "LWA token");
    if (!response.ok) throw this.toError(response.status, json, "LWA token request");
    const token = tokenSchema.parse(json);
    this.token = { accessToken: token.access_token, expiresAt: this.now() + token.expires_in * 1000 };
    return token.access_token;
  }

  private async sendOnce<T>(request: SpApiRequest, schema: z.ZodType<T>, token: string): Promise<T> {
    const url = new URL(`${this.host}${request.path}`);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, Array.isArray(value) ? value.join(",") : String(value));
    }
    const headers: Record<string, string> = { "x-amz-access-token": token, Accept: "application/json" };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetchRaw(url.toString(), {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });

    if (response.status === 204) return schema.parse(undefined);
    const json = await this.readJson(response, request.path);
    if (!response.ok) throw this.toError(response.status, json, `${request.method} ${request.path}`);
    return schema.parse(json);
  }

  private async fetchRaw(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      throw new SpApiError(null, [], `Amazon request failed: ${String(error)}`);
    }
  }

  private async readJson(response: Response, context: string): Promise<unknown> {
    const text = await response.text();
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new SpApiError(response.status, [], `Amazon returned HTTP ${response.status} with a non-JSON body for ${context}`);
    }
  }

  private toError(status: number, json: unknown, context: string): SpApiError {
    const body = errorBodySchema.safeParse(json).data;
    const errors = body?.errors ?? [];
    const detail = errors.map((error) => error.message).filter(Boolean).join("; ") || body?.error_description || "no details";
    return new SpApiError(status, errors.flatMap((error) => (error.code ? [error.code] : [])), `Amazon ${context} failed with HTTP ${status}: ${detail}`);
  }
}
