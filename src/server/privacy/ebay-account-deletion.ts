import { createHash, createVerify } from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { sealAddress } from "../orders/address";

// eBay's "marketplace account deletion" process: when a member closes their account, eBay tells every
// application, and an application that stores the member's data must erase it. A production keyset
// stays disabled until the application proves it listens, by answering a challenge on this endpoint.

/** What the buyer's name becomes once their data is erased. */
const ERASED_BUYER = "Closed eBay account";

/**
 * The answer to eBay's verification challenge: the SHA-256 of the challenge code, our verification
 * token and the endpoint URL, in that order, as hex.
 */
export function challengeResponse(challengeCode: string, verificationToken: string, endpoint: string): string {
  return createHash("sha256").update(challengeCode).update(verificationToken).update(endpoint).digest("hex");
}

const signatureHeaderSchema = z.object({ kid: z.string().min(1), signature: z.string().min(1) });

export const deletionNoticeSchema = z.object({
  metadata: z.object({ topic: z.string() }),
  notification: z.object({
    notificationId: z.string(),
    data: z.object({ username: z.string().min(1), userId: z.string().optional() }),
  }),
});
export type DeletionNotice = z.infer<typeof deletionNoticeSchema>;

/** eBay sends its public key as one line; Node wants PEM with line breaks around the body. */
function toPem(key: string): string {
  const body = key.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace(/\s+/g, "");
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Whether the notice really comes from eBay: the x-ebay-signature header names one of eBay's keys
 * and carries an ECDSA signature of the message. Anything that fails to verify must be ignored,
 * otherwise anyone could have a buyer's data erased.
 */
export async function isSignedByEbay(
  rawBody: string,
  signatureHeader: string | null,
  /** Resolves to null when eBay does not know the key id. */
  getPublicKey: (keyId: string) => Promise<string | null>,
): Promise<boolean> {
  if (!signatureHeader) return false;
  let header;
  try {
    header = signatureHeaderSchema.parse(JSON.parse(Buffer.from(signatureHeader, "base64").toString("utf8")));
  } catch {
    // Not base64 JSON with a key id and a signature: not from eBay.
    return false;
  }
  const key = await getPublicKey(header.kid);
  if (!key) return false;
  const publicKey = toPem(key);
  // eBay signs the message as compact JSON; a body that arrives formatted differently is normalised first.
  const candidates = [rawBody];
  try {
    candidates.push(JSON.stringify(JSON.parse(rawBody)));
  } catch {
    return false;
  }
  return candidates.some((message) => {
    try {
      return createVerify("sha1").update(message).verify(publicKey, header.signature, "base64");
    } catch {
      // A malformed key or signature cannot verify.
      return false;
    }
  });
}

/**
 * Erases what we hold about a closed eBay account: on every order of that buyer, the name is replaced
 * and the address emptied. The order itself (items, amounts, dates) is kept for the accounts.
 * Returns how many orders were changed; running it again changes nothing.
 */
export async function eraseEbayBuyer(username: string): Promise<number> {
  const erased = await db.order.updateMany({
    where: { marketplace: "EBAY", buyerUsername: username },
    data: {
      buyerName: ERASED_BUYER,
      buyerUsername: null,
      shippingAddress: sealAddress({ name: "", line1: "", city: "", state: "", postalCode: "", country: "" }),
    },
  });
  return erased.count;
}
