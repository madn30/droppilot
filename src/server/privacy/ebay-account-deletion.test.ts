import { createHash, generateKeyPairSync, createSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { challengeResponse, deletionNoticeSchema, isSignedByEbay } from "./ebay-account-deletion";

describe("challengeResponse", () => {
  it("hashes the challenge code, the verification token and the endpoint, in that order", () => {
    const expected = createHash("sha256").update("a8628072-3d33-45ee-9004-bee86830a22d" + "token-token-token-token-token-token" + "https://shop.example/api/ebay/account-deletion").digest("hex");
    expect(challengeResponse("a8628072-3d33-45ee-9004-bee86830a22d", "token-token-token-token-token-token", "https://shop.example/api/ebay/account-deletion")).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("isSignedByEbay", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // eBay returns the key on one line, without line breaks.
  const ebayKey = publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "");
  const body = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { notificationId: "n-1", data: { username: "buyer_1" } } });
  const header = (message: string, kid = "key-1") =>
    Buffer.from(JSON.stringify({ alg: "ecdsa", kid, signature: createSign("sha1").update(message).sign(privateKey, "base64"), digest: "SHA1" })).toString("base64");
  const keys = async (keyId: string) => {
    if (keyId !== "key-1") throw new Error("unknown key");
    return ebayKey;
  };

  it("accepts a notice signed with eBay's key, also when the body arrives with other spacing", async () => {
    expect(await isSignedByEbay(body, header(body), keys)).toBe(true);
    expect(await isSignedByEbay(JSON.stringify(JSON.parse(body), null, 2), header(body), keys)).toBe(true);
  });

  it("rejects a changed body, a signature from another key, and a missing or malformed header", async () => {
    expect(await isSignedByEbay(body.replace("buyer_1", "buyer_2"), header(body), keys)).toBe(false);
    const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    const forged = Buffer.from(JSON.stringify({ kid: "key-1", signature: createSign("sha1").update(body).sign(other, "base64") })).toString("base64");
    expect(await isSignedByEbay(body, forged, keys)).toBe(false);
    expect(await isSignedByEbay(body, header(body), async () => null)).toBe(false);
    expect(await isSignedByEbay(body, null, keys)).toBe(false);
    expect(await isSignedByEbay(body, "not base64 json", keys)).toBe(false);
    expect(await isSignedByEbay("not json", header("not json"), keys)).toBe(false);
  });
});

describe("deletionNoticeSchema", () => {
  it("reads the username from eBay's notice and refuses one without it", () => {
    const notice = {
      metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION", schemaVersion: "1.0", deprecated: false },
      notification: { notificationId: "n-1", eventDate: "2026-10-03T10:00:00.000Z", publishAttemptCount: 1, data: { username: "buyer_1", userId: "ma8vp1jySJC", eiasToken: "nY+sHZ" } },
    };
    expect(deletionNoticeSchema.parse(notice).notification.data.username).toBe("buyer_1");
    expect(deletionNoticeSchema.safeParse({ ...notice, notification: { notificationId: "n-1", data: {} } }).success).toBe(false);
  });
});
