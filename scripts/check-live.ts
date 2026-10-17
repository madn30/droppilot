import IORedis from "ioredis";
import { z } from "zod";
import { ANTHROPIC_MODEL, createAnthropicClient } from "../src/server/ai/anthropic/client";
import { askClaudeCli } from "../src/server/ai/claude-cli/runner";
import { JinaClipEmbeddings } from "../src/server/ai/jina/clip-embeddings";
import { EmailNotifier, TelegramNotifier } from "../src/server/alerts/notifiers";
import { KeepaSalesRankSource } from "../src/server/data-sources/keepa/sales-rank";
import { db } from "../src/server/db";
import { getEnv } from "../src/server/env";
import { MockImageFetcher } from "../src/server/images/mock-image-fetcher";
import { AmazonAdapter } from "../src/server/marketplaces/amazon/amazon-adapter";
import { SpApiClient } from "../src/server/marketplaces/amazon/client";
import { EbayClient } from "../src/server/marketplaces/ebay/client";
import { EbayAdapter } from "../src/server/marketplaces/ebay/ebay-adapter";
import { CjSupplierAdapter } from "../src/server/suppliers/cj/cj-adapter";
import { CjClient } from "../src/server/suppliers/cj/client";
import { databaseTokenStore } from "../src/server/suppliers/cj/token-store";

// Pre-flight check for going live: makes one small, read-only call to every
// service whose key is set, whatever MOCK_APIS says, and reports what is ready.
// Usage: npm run check:live            (add -- --notify to also send a test alert)

type Outcome = { status: "OK" | "FAIL" | "NOT SET"; detail: string };
const results: { name: string; required: boolean; outcome: Outcome }[] = [];

async function check(name: string, required: boolean, configured: boolean, run: () => Promise<string>): Promise<void> {
  let outcome: Outcome;
  if (!configured) {
    outcome = { status: "NOT SET", detail: required ? "key missing in .env" : "optional; not configured" };
  } else {
    try {
      outcome = { status: "OK", detail: await run() };
    } catch (error) {
      outcome = { status: "FAIL", detail: error instanceof Error ? error.message.split("\n")[0] : String(error) };
    }
  }
  results.push({ name, required, outcome });
}

const serpApiAccountSchema = z.object({ plan_searches_left: z.number().optional(), total_searches_left: z.number().optional() });

async function main(): Promise<void> {
  const env = getEnv();
  const sendTestAlert = process.argv.includes("--notify");

  await check("PostgreSQL", true, true, async () => {
    await db.$queryRaw`SELECT 1`;
    return "connected";
  });
  await check("Redis", true, true, async () => {
    const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
    try {
      await redis.connect();
      return await redis.ping();
    } finally {
      redis.disconnect();
    }
  });

  await check("CJ Dropshipping", true, Boolean(env.CJ_API_KEY), async () => {
    const adapter = new CjSupplierAdapter(new CjClient({ apiKey: env.CJ_API_KEY ?? "", tokenStore: databaseTokenStore }), {
      sandboxOrders: env.CJ_SANDBOX_ORDERS,
    });
    const found = await adapter.searchProducts({ keyword: "necklace", pageSize: 1 });
    return `logged in; product search returned ${found.length} result(s); sandbox orders ${env.CJ_SANDBOX_ORDERS ? "ON" : "OFF (real orders)"}`;
  });

  const ebayConfigured = Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET && env.EBAY_REFRESH_TOKEN);
  const ebay = new EbayAdapter(
    new EbayClient({
      clientId: env.EBAY_CLIENT_ID ?? "",
      clientSecret: env.EBAY_CLIENT_SECRET ?? "",
      refreshToken: env.EBAY_REFRESH_TOKEN ?? "",
      environment: env.EBAY_ENV,
    }),
  );
  await check(`eBay search (${env.EBAY_ENV})`, true, ebayConfigured, async () => {
    const ids = await ebay.listCandidateIds("necklace", 1);
    return `application token works; search returned ${ids.length} result(s)`;
  });
  await check(`eBay seller account (${env.EBAY_ENV})`, true, ebayConfigured, async () => {
    const setup = await ebay.checkSellerSetup();
    return `refresh token works; policies and location found; handling times available: ${setup.fulfillmentPolicyHandlingDays.join(", ")} day(s)`;
  });

  const amazonConfigured = Boolean(env.SPAPI_LWA_CLIENT_ID && env.SPAPI_LWA_CLIENT_SECRET && env.SPAPI_REFRESH_TOKEN && env.SPAPI_SELLER_ID);
  await check("Amazon SP-API", false, amazonConfigured, async () => {
    const amazon = new AmazonAdapter(
      new SpApiClient({
        clientId: env.SPAPI_LWA_CLIENT_ID ?? "",
        clientSecret: env.SPAPI_LWA_CLIENT_SECRET ?? "",
        refreshToken: env.SPAPI_REFRESH_TOKEN ?? "",
        region: env.SPAPI_REGION,
      }),
      { sellerId: env.SPAPI_SELLER_ID ?? "" },
    );
    const asins = await amazon.listCandidateIds("necklace", 1);
    return `token works; catalog search returned ${asins.length} result(s)`;
  });
  await check("Keepa", false, Boolean(env.KEEPA_API_KEY), async () => {
    // One token: the rank history of a long-lived ASIN.
    const history = await new KeepaSalesRankSource({ apiKey: env.KEEPA_API_KEY ?? "" }).getSalesRankHistory("B00005N5PF");
    return history ? `key works; ${history.length} rank points returned` : "key works; no rank data for the test ASIN";
  });

  await check("SerpApi (Google Trends)", true, Boolean(env.SERPAPI_KEY), async () => {
    // The account endpoint is free and does not use a search.
    const response = await fetch(`https://serpapi.com/account.json?api_key=${encodeURIComponent(env.SERPAPI_KEY ?? "")}`);
    if (!response.ok) throw new Error(`SerpApi returned HTTP ${response.status}`);
    const account = serpApiAccountSchema.parse(await response.json());
    return `key works; ${account.total_searches_left ?? account.plan_searches_left ?? "unknown"} searches left`;
  });

  if (env.AI_PROVIDER === "claude-cli") {
    await check("Claude CLI (AI provider)", true, true, async () => {
      // One tiny question through the same path the app uses.
      const answer = await askClaudeCli({
        task: "test answer",
        system: "You answer test questions.",
        prompt: "Reply with ready set to true.",
        schema: z.object({ ready: z.boolean() }),
        effort: "low",
      });
      return `local claude command works on your subscription (ready: ${String(answer.ready)})`;
    });
  } else {
    await check("Anthropic API (AI provider)", true, Boolean(env.ANTHROPIC_API_KEY), async () => {
      const model = await createAnthropicClient(env.ANTHROPIC_API_KEY ?? "").models.retrieve(ANTHROPIC_MODEL);
      return `key works; model ${model.id} is available`;
    });
  }

  await check("Jina AI (image embeddings)", true, Boolean(env.EMBEDDINGS_PROVIDER_KEY), async () => {
    const image = await new MockImageFetcher().fetch("https://mock.droppilot.local/images/check/1.png?content=check");
    const [vector] = await new JinaClipEmbeddings({ apiKey: env.EMBEDDINGS_PROVIDER_KEY ?? "" }).embedImages([image]);
    return `key works; embedding has ${vector.length} dimensions`;
  });

  const testAlert = { severity: "INFO" as const, title: "Test alert", message: "This is a test from npm run check:live." };
  await check("Telegram alerts", false, Boolean(env.TELEGRAM_WEBHOOK_URL), async () => {
    if (!sendTestAlert) return "configured (run with -- --notify to send a test message)";
    await new TelegramNotifier(env.TELEGRAM_WEBHOOK_URL ?? "").send(testAlert);
    return "test message sent";
  });
  await check("Email alerts", false, Boolean(env.SMTP_URL && env.ALERT_EMAIL_TO), async () => {
    if (!sendTestAlert) return "configured (run with -- --notify to send a test message)";
    await new EmailNotifier(env.SMTP_URL ?? "", env.ALERT_EMAIL_TO ?? "").send(testAlert);
    return "test message sent";
  });

  const [mockListings, mockOrders] = await Promise.all([
    db.listing.count({ where: { externalId: { startsWith: "MOCK-" } } }),
    db.order.count({ where: { externalId: { startsWith: "MOCK-" } } }),
  ]);

  console.log(`\nMOCK_APIS is ${env.MOCK_APIS ? "true (mock mode)" : "false (live mode)"}\n`);
  for (const { name, required, outcome } of results) {
    console.log(`${outcome.status.padEnd(8)} ${name}${required ? "" : " (optional)"}: ${outcome.detail}`);
  }

  const blocking = results.filter(({ required, outcome }) => required && outcome.status !== "OK");
  const failedOptional = results.filter(({ required, outcome }) => !required && outcome.status === "FAIL");
  console.log("");
  if (mockListings + mockOrders > 0) {
    console.log(`The database holds mock data (${mockListings} listing(s), ${mockOrders} order(s)). Reset it before going live: npx prisma migrate reset`);
  }
  if (blocking.length === 0 && failedOptional.length === 0) {
    console.log(env.MOCK_APIS ? "Everything required is ready. Set MOCK_APIS=false to go live." : "Everything required is ready.");
  } else {
    if (blocking.length > 0) console.log(`Not ready: ${blocking.map(({ name }) => name).join(", ")}.`);
    if (failedOptional.length > 0) console.log(`Configured but failing: ${failedOptional.map(({ name }) => name).join(", ")}.`);
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
