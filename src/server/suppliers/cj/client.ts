import type { z } from "zod";
import { RateLimiter } from "../../http/rate-limiter";
import { withRetry } from "../../http/retry";
import { type CjTokens, envelopeSchema, tokenSchema } from "./schemas";

const BASE_URL = "https://developers.cjdropshipping.com/api2.0/v1/";
// CJ allows one call per second; a little slack avoids edge-of-window rejections.
const MIN_INTERVAL_MS = 1100;
const TOKEN_EXPIRY_MARGIN_MS = 60 * 60 * 1000;

// CJ global error codes (Appendix 1 of the API docs).
export const CJ_CODE = {
  SUCCESS: 200,
  SYSTEM_BUSY: 1600000,
  INVALID_TOKEN: 1600001,
  TOO_MANY_REQUESTS: 1600200,
  PARAM_ERROR: 1600300,
  READ_TIMEOUT: 1600301,
  VARIANT_NOT_FOUND: 1602000,
  PRODUCT_NOT_FOUND: 1602001,
  PRODUCT_REMOVED: 1602002,
  VARIANT_REMOVED: 1602003,
  ORDER_EXISTS: 1603003,
  ORDER_NOT_FOUND: 1603100,
  INVENTORY_DEDUCTION_FAILED: 1603102,
  BALANCE_INSUFFICIENT: 1604000,
  LOGISTIC_NOT_FOUND: 1605000,
  LOGISTIC_INVALID: 1605001,
} as const;

const RETRYABLE_CODES = new Set<number>([CJ_CODE.SYSTEM_BUSY, CJ_CODE.TOO_MANY_REQUESTS, CJ_CODE.READ_TIMEOUT]);

/** CJ answered, but with a non-success code. */
export class CjApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly requestId: string | null,
  ) {
    super(`CJ API error ${code}: ${message}`);
    this.name = "CjApiError";
  }
}

/** The request never produced a usable CJ answer (network failure, 429, 5xx, non-JSON body). */
class CjTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "CjTransportError";
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof CjApiError) return RETRYABLE_CODES.has(error.code);
  if (error instanceof CjTransportError) return error.status === null || error.status === 429 || error.status >= 500;
  return false;
}

/** Where access tokens live between calls and across processes. */
export interface CjTokenStore {
  load(): Promise<CjTokens | null>;
  save(tokens: CjTokens): Promise<void>;
}

export interface CjRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface CjClientOptions {
  apiKey: string;
  tokenStore: CjTokenStore;
  fetch?: typeof fetch;
  rateLimiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** Authenticated, rate-limited, retrying access to the CJ Dropshipping API v2. */
export class CjClient {
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: RateLimiter;
  private readonly now: () => Date;
  private tokens: CjTokens | null = null;

  constructor(private readonly options: CjClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.rateLimiter = options.rateLimiter ?? new RateLimiter(MIN_INTERVAL_MS);
    this.now = options.now ?? (() => new Date());
  }

  async request<T>(request: CjRequest, schema: z.ZodType<T>): Promise<T> {
    try {
      return await this.send(request, schema, await this.accessToken());
    } catch (error) {
      // A token can be revoked before its expiry date; authenticate afresh once.
      if (!(error instanceof CjApiError) || error.code !== CJ_CODE.INVALID_TOKEN) throw error;
      this.tokens = await this.authenticate();
      return this.send(request, schema, this.tokens.accessToken);
    }
  }

  private isFresh(expiryDate: string): boolean {
    const expiresAt = new Date(expiryDate).getTime();
    return Number.isFinite(expiresAt) && expiresAt - this.now().getTime() > TOKEN_EXPIRY_MARGIN_MS;
  }

  private async accessToken(): Promise<string> {
    this.tokens ??= await this.options.tokenStore.load();
    if (this.tokens && this.isFresh(this.tokens.accessTokenExpiryDate)) return this.tokens.accessToken;

    this.tokens =
      this.tokens && this.isFresh(this.tokens.refreshTokenExpiryDate)
        ? await this.refresh(this.tokens.refreshToken)
        : await this.authenticate();
    return this.tokens.accessToken;
  }

  private async authenticate(): Promise<CjTokens> {
    const tokens = await this.send(
      { method: "POST", path: "authentication/getAccessToken", body: { apiKey: this.options.apiKey } },
      tokenSchema,
      null,
    );
    await this.options.tokenStore.save(tokens);
    return tokens;
  }

  private async refresh(refreshToken: string): Promise<CjTokens> {
    try {
      const tokens = await this.send(
        { method: "POST", path: "authentication/refreshAccessToken", body: { refreshToken } },
        tokenSchema,
        null,
      );
      await this.options.tokenStore.save(tokens);
      return tokens;
    } catch (error) {
      // A rejected refresh token is recoverable with the API key; anything else is not ours to hide.
      if (error instanceof CjApiError) return this.authenticate();
      throw error;
    }
  }

  private send<T>(request: CjRequest, schema: z.ZodType<T>, accessToken: string | null): Promise<T> {
    return withRetry(() => this.rateLimiter.schedule(() => this.sendOnce(request, schema, accessToken)), {
      retries: 4,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      shouldRetry: isRetryable,
      sleep: this.options.sleep,
    });
  }

  private async sendOnce<T>(request: CjRequest, schema: z.ZodType<T>, accessToken: string | null): Promise<T> {
    const url = new URL(request.path, BASE_URL);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    const headers: Record<string, string> = {};
    if (accessToken) headers["CJ-Access-Token"] = accessToken;
    if (request.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch (error) {
      throw new CjTransportError(`CJ request to ${request.path} failed: ${String(error)}`, null);
    }

    // CJ reports most failures as a JSON envelope, sometimes alongside a non-200 status.
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CjTransportError(`CJ returned HTTP ${response.status} with a non-JSON body for ${request.path}`, response.status);
    }
    const envelope = envelopeSchema.safeParse(json);
    if (!envelope.success) {
      throw new CjTransportError(`CJ returned HTTP ${response.status} with an unexpected body for ${request.path}`, response.status);
    }
    if (envelope.data.code !== CJ_CODE.SUCCESS) {
      throw new CjApiError(envelope.data.code, envelope.data.message ?? "no message", envelope.data.requestId ?? null);
    }
    return schema.parse(envelope.data.data);
  }
}
