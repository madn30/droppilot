import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";
import { LoginThrottle } from "./throttle";
import { SESSION_TTL_SECONDS, createSessionToken, verifySessionToken } from "./token";

const SECRET = "test-session-secret-test-session-secret";

describe("password", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const hash = hashPassword("correct horse");
    expect(verifyPassword("correct horse", hash)).toBe(true);
    expect(verifyPassword("wrong horse", hash)).toBe(false);
  });

  it("rejects malformed hashes", () => {
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "bcrypt:aa:bb")).toBe(false);
    expect(verifyPassword("anything", "scrypt:aa:bb")).toBe(false);
  });
});

describe("session token", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("round-trips the email", () => {
    const token = createSessionToken("admin@example.com", SECRET, now);
    expect(verifySessionToken(token, SECRET, now)).toEqual({ email: "admin@example.com" });
  });

  it("rejects a token signed with another secret", () => {
    const token = createSessionToken("admin@example.com", "another-secret", now);
    expect(verifySessionToken(token, SECRET, now)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const [, signature] = createSessionToken("admin@example.com", SECRET, now).split(".");
    const forged = Buffer.from(
      JSON.stringify({ email: "evil@example.com", expiresAt: 9999999999 }),
    ).toString("base64url");
    expect(verifySessionToken(`${forged}.${signature}`, SECRET, now)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createSessionToken("admin@example.com", SECRET, now);
    const later = new Date(now.getTime() + (SESSION_TTL_SECONDS + 1) * 1000);
    expect(verifySessionToken(token, SECRET, later)).toBeNull();
  });

  it("rejects garbage", () => {
    expect(verifySessionToken("", SECRET, now)).toBeNull();
    expect(verifySessionToken("a.b.c", SECRET, now)).toBeNull();
  });
});

describe("login throttle", () => {
  const minute = 60_000;

  it("blocks after five failures within 15 minutes and recovers as they age out", () => {
    const throttle = new LoginThrottle();
    for (let attempt = 0; attempt < 4; attempt++) throttle.recordFailure(attempt * minute);
    expect(throttle.isBlocked(4 * minute)).toBe(false);
    throttle.recordFailure(4 * minute);
    expect(throttle.isBlocked(5 * minute)).toBe(true);
    // The first failure (minute 0) is older than 15 minutes at minute 15.
    expect(throttle.isBlocked(15 * minute)).toBe(false);
  });

  it("clears after a successful login", () => {
    const throttle = new LoginThrottle();
    for (let attempt = 0; attempt < 5; attempt++) throttle.recordFailure(0);
    throttle.reset();
    expect(throttle.isBlocked(minute)).toBe(false);
  });
});
