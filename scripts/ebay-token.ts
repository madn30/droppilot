import { z } from "zod";
import { getEnv } from "../src/server/env";

// Helps with the one manual eBay step: turning your sign-in into EBAY_REFRESH_TOKEN.
//   npm run ebay:token -- url <RuName>                 prints the consent URL to open in a browser
//   npm run ebay:token -- exchange <RuName> <code>     exchanges the code from the redirect for a refresh token
// The RuName is the redirect name eBay shows next to your keyset under "User Tokens".

const SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
];

const tokenSchema = z.object({ refresh_token: z.string(), refresh_token_expires_in: z.number().optional() });

async function main(): Promise<void> {
  const [command, ruName, code] = process.argv.slice(2);
  const env = getEnv();
  if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
    throw new Error("Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env first.");
  }
  const sandbox = env.EBAY_ENV === "sandbox";

  if (command === "url" && ruName) {
    const url = new URL(`https://auth.${sandbox ? "sandbox." : ""}ebay.com/oauth2/authorize`);
    url.search = new URLSearchParams({
      client_id: env.EBAY_CLIENT_ID,
      response_type: "code",
      redirect_uri: ruName,
      scope: SCOPES.join(" "),
    }).toString();
    console.log(`Open this URL, sign in as the seller and accept (${env.EBAY_ENV}):\n\n${url.toString()}\n`);
    console.log("eBay then redirects to your redirect URL with ?code=... in the address bar. Copy that code value and run:");
    console.log(`  npm run ebay:token -- exchange ${ruName} '<code>'`);
    return;
  }

  if (command === "exchange" && ruName && code) {
    const response = await fetch(`https://api.${sandbox ? "sandbox." : ""}ebay.com/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      // The code is copied from a URL, so it arrives percent-encoded.
      body: new URLSearchParams({ grant_type: "authorization_code", code: decodeURIComponent(code), redirect_uri: ruName }).toString(),
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(`eBay rejected the code (HTTP ${response.status}): ${JSON.stringify(body)}`);
    const token = tokenSchema.parse(body);
    const days = token.refresh_token_expires_in ? Math.round(token.refresh_token_expires_in / 86_400) : null;
    // Quoted because eBay refresh tokens contain "#", which starts a comment in an unquoted .env value.
    console.log(`Put this in .env${days ? ` (valid for about ${days} days)` : ""}:\n\nEBAY_REFRESH_TOKEN="${token.refresh_token}"\n`);
    return;
  }

  console.error("Usage:\n  npm run ebay:token -- url <RuName>\n  npm run ebay:token -- exchange <RuName> <code>");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
