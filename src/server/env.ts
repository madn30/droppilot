import { z } from "zod";

const optionalKey = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

const dollars = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const amount = Number(value);
      if (!Number.isFinite(amount) || amount < 0) {
        ctx.addIssue({ code: "custom", message: "must be a non-negative dollar amount" });
        return z.NEVER;
      }
      return Math.round(amount * 100);
    });

// Keys live mode cannot run without.
const REQUIRED_LIVE_KEYS = [
  "CJ_API_KEY",
  "EBAY_CLIENT_ID",
  "EBAY_CLIENT_SECRET",
  "EBAY_REFRESH_TOKEN",
  "SERPAPI_KEY",
  "EMBEDDINGS_PROVIDER_KEY",
] as const;

// Amazon is optional in live mode: with none of these set, DropPilot runs on eBay alone.
// Keepa is optional too: without its key, Amazon sales ranks come from the SP-API catalog.
const AMAZON_KEYS = ["SPAPI_LWA_CLIENT_ID", "SPAPI_LWA_CLIENT_SECRET", "SPAPI_REFRESH_TOKEN", "SPAPI_SELLER_ID"] as const;

export const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),

    ADMIN_EMAIL: z.email(),
    ADMIN_PASSWORD_HASH: z.string().min(1),
    SESSION_SECRET: z.string().min(32),
    ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, "base64").length === 32, "must be 32 bytes, base64-encoded"),

    // Where downloaded product images are cached, relative to the working directory.
    IMAGE_CACHE_DIR: z.string().min(1).default("storage/images"),

    MOCK_APIS: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),

    CJ_API_KEY: optionalKey,
    // Sandbox orders are accepted by CJ but never charged or shipped. On until explicitly turned off.
    CJ_SANDBOX_ORDERS: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    EBAY_CLIENT_ID: optionalKey,
    EBAY_CLIENT_SECRET: optionalKey,
    EBAY_REFRESH_TOKEN: optionalKey,
    EBAY_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
    // eBay enables a production keyset only for an app that erases a buyer's data when their account is closed.
    // The public HTTPS address of /api/ebay/account-deletion, and the token registered with it at developer.ebay.com.
    EBAY_DELETION_ENDPOINT: z.url().startsWith("https://").optional().or(z.literal("").transform(() => undefined)),
    EBAY_VERIFICATION_TOKEN: z
      .string()
      .regex(/^[A-Za-z0-9_-]{32,80}$/, "32 to 80 letters, digits, underscores or hyphens")
      .optional()
      .or(z.literal("").transform(() => undefined)),
    SPAPI_LWA_CLIENT_ID: optionalKey,
    SPAPI_LWA_CLIENT_SECRET: optionalKey,
    SPAPI_REFRESH_TOKEN: optionalKey,
    SPAPI_REGION: z.enum(["na", "eu", "fe"]).default("na"),
    // The seller (merchant) ID from Seller Central; the Listings API addresses listings by it.
    SPAPI_SELLER_ID: optionalKey,
    KEEPA_API_KEY: optionalKey,
    SERPAPI_KEY: optionalKey,
    ANTHROPIC_API_KEY: optionalKey,
    // Who answers the AI questions (specs, photo checks, listing text):
    // "anthropic-api" uses ANTHROPIC_API_KEY (billed per call); "claude-cli" runs the locally installed,
    // signed-in `claude` command on its subscription.
    AI_PROVIDER: z.enum(["anthropic-api", "claude-cli"]).default("anthropic-api"),
    EMBEDDINGS_PROVIDER_KEY: optionalKey,
    TELEGRAM_WEBHOOK_URL: optionalKey,
    // Alert emails: an SMTP connection URL (smtps://user:pass@host:465) and the address to notify.
    SMTP_URL: optionalKey,
    ALERT_EMAIL_TO: optionalKey,

    // Dollars in the env file, integer cents once parsed.
    MIN_PROFIT: dollars("3.00"),
    MAX_ACCEPTABLE_LOSS: dollars("1.00"),
    DEMAND_THRESHOLD: z.coerce.number().min(0).max(100).default(60),
  })
  .superRefine((env, ctx) => {
    if (env.MOCK_APIS) return;
    for (const key of REQUIRED_LIVE_KEYS) {
      if (!env[key]) {
        ctx.addIssue({ code: "custom", path: [key], message: "required when MOCK_APIS=false" });
      }
    }
    if (env.AI_PROVIDER === "anthropic-api" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["ANTHROPIC_API_KEY"], message: "required when MOCK_APIS=false and AI_PROVIDER=anthropic-api" });
    }
    const amazonKeysSet = AMAZON_KEYS.filter((key) => env[key]);
    if (amazonKeysSet.length > 0) {
      // A half-configured Amazon would fail at the first call; say so at start-up instead.
      for (const key of AMAZON_KEYS) {
        if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "required when any other SPAPI_ key is set" });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Amazon is always available in mock mode; in live mode only when its keys are set. */
export function isAmazonEnabled(env: Env): boolean {
  return env.MOCK_APIS || AMAZON_KEYS.every((key) => Boolean(env[key]));
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

let cached: Env | undefined;

// Parsed lazily so `next build` and unit tests can import modules without a full env.
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
