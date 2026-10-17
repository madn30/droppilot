import { z } from "zod";
import { RateLimiter } from "../../http/rate-limiter";
import { withRetry } from "../../http/retry";

const HOSTS = { production: "https://api.ebay.com", sandbox: "https://api.sandbox.ebay.com" } as const;
export const EBAY_MARKETPLACE_ID = "EBAY_US";

// Scopes of the seller's user token (granted when the refresh token was created).
const USER_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
].join(" ");
// Browse and Taxonomy use an application token.
const APP_SCOPE = "https://api.ebay.com/oauth/api_scope";
// Marketplace Insights is a restricted API: its scope is only granted to approved applications,
// so it gets its own token and never affects the ordinary application token.
const INSIGHTS_SCOPE = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const MIN_INTERVAL_MS = 200;

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number() });
const errorBodySchema = z.object({
  errors: z
    .array(
      z.object({
        errorId: z.number().optional(),
        message: z.string().optional(),
        longMessage: z.string().optional(),
        parameters: z.array(z.object({ name: z.string().optional(), value: z.string().optional() })).optional(),
      }),
    )
    .optional(),
  error_description: z.string().optional(),
});

export class EbayApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly errorIds: number[],
    message: string,
  ) {
    super(message);
    this.name = "EbayApiError";
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof EbayApiError && (error.status === null || error.status === 429 || error.status >= 500);
}

export type EbayTokenKind = "user" | "app" | "insights";

export interface EbayRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  token: EbayTokenKind;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface EbayClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  environment: keyof typeof HOSTS;
  fetch?: typeof fetch;
  rateLimiter?: RateLimiter;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** OAuth-authenticated, rate-limited, retrying access to eBay's REST APIs. */
export class EbayClient {
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimiter: RateLimiter;
  private readonly now: () => number;
  private readonly host: string;
  private readonly tokens = new Map<EbayTokenKind, { accessToken: string; expiresAt: number }>();

  constructor(private readonly options: EbayClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.rateLimiter = options.rateLimiter ?? new RateLimiter(MIN_INTERVAL_MS);
    this.now = options.now ?? (() => Date.now());
    this.host = HOSTS[options.environment];
  }

  /** Sends a request and parses the JSON reply. For calls that answer 204 No Content, pass `z.undefined()`. */
  async request<T>(request: EbayRequest, schema: z.ZodType<T>): Promise<T> {
    try {
      return await this.send(request, schema);
    } catch (error) {
      // An access token can be revoked before it expires; fetch a new one once.
      if (!(error instanceof EbayApiError) || error.status !== 401) throw error;
      this.tokens.delete(request.token);
      return this.send(request, schema);
    }
  }

  private send<T>(request: EbayRequest, schema: z.ZodType<T>): Promise<T> {
    return withRetry(
      async () => {
        const accessToken = await this.accessToken(request.token);
        return this.rateLimiter.schedule(() => this.sendOnce(request, schema, accessToken));
      },
      { retries: 3, baseDelayMs: 1000, maxDelayMs: 30_000, shouldRetry: isRetryable, sleep: this.options.sleep },
    );
  }

  private async accessToken(kind: EbayTokenKind): Promise<string> {
    const cached = this.tokens.get(kind);
    if (cached && cached.expiresAt - this.now() > TOKEN_EXPIRY_MARGIN_MS) return cached.accessToken;

    const form: Record<string, string> =
      kind === "user"
        ? { grant_type: "refresh_token", refresh_token: this.options.refreshToken, scope: USER_SCOPES }
        : { grant_type: "client_credentials", scope: kind === "insights" ? INSIGHTS_SCOPE : APP_SCOPE };
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64");
    const response = await this.fetchRaw(`${this.host}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    const json = await this.readJson(response, "identity/v1/oauth2/token");
    if (!response.ok) throw this.toError(response.status, json, "OAuth token request");
    const token = tokenSchema.parse(json);
    this.tokens.set(kind, { accessToken: token.access_token, expiresAt: this.now() + token.expires_in * 1000 });
    return token.access_token;
  }

  private async sendOnce<T>(request: EbayRequest, schema: z.ZodType<T>, accessToken: string): Promise<T> {
    const url = new URL(`${this.host}${request.path}`);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    // searchParams encodes a space as "+", which eBay reads literally (a SKU like "White Opp" is then not found).
    url.search = url.search.replaceAll("+", "%20");
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      // Node's fetch sends "Accept-Language: *" by default, which the Inventory API rejects.
      "Accept-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": EBAY_MARKETPLACE_ID,
    };
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Language"] = "en-US";
    }
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
      throw new EbayApiError(null, [], `eBay request failed: ${String(error)}`);
    }
  }

  private async readJson(response: Response, path: string): Promise<unknown> {
    const text = await response.text();
    if (text === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new EbayApiError(response.status, [], `eBay returned HTTP ${response.status} with a non-JSON body for ${path}`);
    }
  }

  private toError(status: number, json: unknown, context: string): EbayApiError {
    const body = errorBodySchema.safeParse(json).data;
    const errors = body?.errors ?? [];
    const detail =
      errors
        .map((error) => {
          // For a policy refusal the message is generic; eBay puts the actual reason, as HTML, in the first parameter.
          const reason = error.parameters?.[0]?.value?.replace(/<[^>]+>/g, "").replace(/\{[^}]*\}/g, "").trim();
          return [error.longMessage ?? error.message, reason && reason.length > 20 ? reason : undefined].filter(Boolean).join(" Reason: ");
        })
        .filter(Boolean)
        .join("; ") || body?.error_description || "no details";
    return new EbayApiError(status, errors.flatMap((error) => (error.errorId === undefined ? [] : [error.errorId])), `eBay ${context} failed with HTTP ${status}: ${detail}`);
  }
}
