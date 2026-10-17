import { NextResponse } from "next/server";
import { getNotifiers } from "@/server/alerts/notifiers";
import { sendNotice } from "@/server/alerts/service";
import { getEnv } from "@/server/env";
import { logger } from "@/server/logger";
import { createRealEbayAdapter } from "@/server/marketplaces";
import { EbayApiError } from "@/server/marketplaces/ebay/client";
import { challengeResponse, deletionNoticeSchema, eraseEbayBuyer, isSignedByEbay } from "@/server/privacy/ebay-account-deletion";

export const dynamic = "force-dynamic";

const DELETION_TOPIC = "MARKETPLACE_ACCOUNT_DELETION";
// eBay rotates its signing keys rarely; each is fetched once per process.
const publicKeys = new Map<string, string>();

async function getPublicKey(keyId: string): Promise<string | null> {
  const cached = publicKeys.get(keyId);
  if (cached) return cached;
  let key: string;
  try {
    key = await createRealEbayAdapter().getNotificationPublicKey(keyId);
  } catch (error) {
    // A key id eBay does not know cannot verify anything. Notices are signed with production keys,
    // so this is also what happens while EBAY_ENV is still sandbox.
    if (error instanceof EbayApiError && error.status === 404) return null;
    throw error;
  }
  publicKeys.set(keyId, key);
  return key;
}

function settings(): { endpoint: string; token: string } | null {
  const env = getEnv();
  if (env.MOCK_APIS || !env.EBAY_DELETION_ENDPOINT || !env.EBAY_VERIFICATION_TOKEN) return null;
  return { endpoint: env.EBAY_DELETION_ENDPOINT, token: env.EBAY_VERIFICATION_TOKEN };
}

// Public by design: eBay calls this address without a session. The GET proves we own it; the POST is trusted only with eBay's signature.

/** eBay's ownership check: it sends a challenge code and expects the matching hash back. */
export async function GET(request: Request): Promise<NextResponse> {
  const configured = settings();
  const challengeCode = new URL(request.url).searchParams.get("challenge_code");
  if (!configured || !challengeCode) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json({ challengeResponse: challengeResponse(challengeCode, configured.token, configured.endpoint) });
}

/** A member closed their eBay account: erase what we hold about them. */
export async function POST(request: Request): Promise<NextResponse> {
  if (!settings()) return new NextResponse("Not found", { status: 404 });
  const rawBody = await request.text();
  if (!(await isSignedByEbay(rawBody, request.headers.get("x-ebay-signature"), getPublicKey))) {
    logger.warn("account deletion notice rejected: signature did not verify");
    return new NextResponse("Invalid signature", { status: 412 });
  }

  const notice = deletionNoticeSchema.safeParse(JSON.parse(rawBody));
  // A signed message of another kind is acknowledged, so eBay does not keep retrying it.
  if (!notice.success || notice.data.metadata.topic !== DELETION_TOPIC) return new NextResponse(null, { status: 204 });

  const erased = await eraseEbayBuyer(notice.data.notification.data.username);
  logger.info({ notificationId: notice.data.notification.notificationId, erased }, "eBay account deletion handled");
  if (erased > 0) {
    await sendNotice(
      {
        title: "Buyer data erased at eBay's request",
        message: `A buyer closed their eBay account. Their name and address were removed from ${erased} order(s); the order amounts and items are kept.`,
      },
      getNotifiers(),
    );
  }
  return new NextResponse(null, { status: 204 });
}
