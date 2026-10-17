import { describe, expect, it } from "vitest";
import { isAmazonEnabled, parseEnv } from "./env";

const base = {
  DATABASE_URL: "postgresql://u:p@localhost:5433/db",
  REDIS_URL: "redis://localhost:6379",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD_HASH: "scrypt:salt:hash",
  SESSION_SECRET: "x".repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
};

describe("parseEnv", () => {
  it("applies defaults and converts dollars to cents", () => {
    const env = parseEnv(base);
    expect(env.MOCK_APIS).toBe(true);
    expect(env.EBAY_ENV).toBe("sandbox");
    expect(env.MIN_PROFIT).toBe(300);
    expect(env.MAX_ACCEPTABLE_LOSS).toBe(100);
    expect(env.DEMAND_THRESHOLD).toBe(60);
  });

  it("treats empty API keys as missing", () => {
    expect(parseEnv({ ...base, CJ_API_KEY: "" }).CJ_API_KEY).toBeUndefined();
  });

  it("requires real API keys when MOCK_APIS=false", () => {
    expect(() => parseEnv({ ...base, MOCK_APIS: "false" })).toThrow(/CJ_API_KEY/);
  });

  const live = {
    ...base,
    MOCK_APIS: "false",
    CJ_API_KEY: "k",
    EBAY_CLIENT_ID: "k",
    EBAY_CLIENT_SECRET: "k",
    EBAY_REFRESH_TOKEN: "k",
    SERPAPI_KEY: "k",
    ANTHROPIC_API_KEY: "k",
    EMBEDDINGS_PROVIDER_KEY: "k",
  };
  const amazon = { SPAPI_LWA_CLIENT_ID: "k", SPAPI_LWA_CLIENT_SECRET: "k", SPAPI_REFRESH_TOKEN: "k", SPAPI_SELLER_ID: "k", KEEPA_API_KEY: "k" };

  it("runs live on eBay alone when no Amazon key is set", () => {
    const env = parseEnv(live);
    expect(env.MOCK_APIS).toBe(false);
    expect(isAmazonEnabled(env)).toBe(false);
  });

  it("enables Amazon when all of its keys are set", () => {
    expect(isAmazonEnabled(parseEnv({ ...live, ...amazon }))).toBe(true);
    expect(isAmazonEnabled(parseEnv(base))).toBe(true);
  });

  it("needs the Anthropic key only when the API is the AI provider", () => {
    expect(() => parseEnv({ ...live, ANTHROPIC_API_KEY: "" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(parseEnv({ ...live, ANTHROPIC_API_KEY: "", AI_PROVIDER: "claude-cli" }).AI_PROVIDER).toBe("claude-cli");
    expect(parseEnv(base).AI_PROVIDER).toBe("anthropic-api");
  });

  it("rejects a half-configured Amazon, and does not need Keepa for Amazon", () => {
    expect(() => parseEnv({ ...live, SPAPI_SELLER_ID: "k" })).toThrow(/SPAPI_REFRESH_TOKEN/);
    expect(isAmazonEnabled(parseEnv({ ...live, ...amazon, KEEPA_API_KEY: "" }))).toBe(true);
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(() => parseEnv({ ...base, ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/ENCRYPTION_KEY/);
  });
});
