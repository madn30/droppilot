import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

// Token = base64url(JSON payload) + "." + HMAC-SHA256 signature.
export function createSessionToken(email: string, secret: string, now: Date = new Date()): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ email, expiresAt })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySessionToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): { email: string } | null {
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;

  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  // The signature is valid, so the payload is exactly what createSessionToken wrote.
  const { email, expiresAt } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    email: string;
    expiresAt: number;
  };
  if (expiresAt <= Math.floor(now.getTime() / 1000)) return null;
  return { email };
}
