import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto";

describe("crypto", () => {
  it("round-trips a secret", () => {
    const payload = encrypt("refresh-token-123");
    expect(payload.ciphertext).not.toContain("refresh-token-123");
    expect(decrypt(payload)).toBe("refresh-token-123");
  });

  it("uses a fresh IV per encryption", () => {
    expect(encrypt("same").iv).not.toBe(encrypt("same").iv);
  });

  it("rejects tampered ciphertext", () => {
    const payload = encrypt("refresh-token-123");
    const tampered = Buffer.from(payload.ciphertext, "base64");
    tampered[0] ^= 1;
    expect(() => decrypt({ ...payload, ciphertext: tampered.toString("base64") })).toThrow();
  });
});
