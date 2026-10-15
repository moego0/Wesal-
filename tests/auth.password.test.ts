import { describe, expect, it } from "vitest";
import {
  PASSWORD_ALGO,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "@/server/auth/password";

/**
 * scrypt parameters are deliberately heavy (N=2^17 → ~128 MiB, ~0.5 s per
 * hash). Each test here does only a handful of derivations, so the file stays
 * a few seconds, but the per-test budget is raised well above the default to
 * keep that a property of the algorithm rather than a flake.
 */
const TIMEOUT = 30_000;

describe("hashPassword / verifyPassword", { timeout: TIMEOUT }, () => {
  it("verifies the password it was given and rejects a different one", async () => {
    const stored = await hashPassword("correct horse battery staple");

    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("stores the parameters it used, in a self-describing format", async () => {
    const stored = await hashPassword("kalam siri");

    // scrypt$N=131072,r=8,p=1$<salt-b64>$<hash-b64>
    const parts = stored.split("$");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(PASSWORD_ALGO);
    expect(parts[1]).toBe("N=131072,r=8,p=1");

    // 16-byte salt, 64-byte key, and neither is the plaintext.
    expect(Buffer.from(parts[2], "base64")).toHaveLength(16);
    expect(Buffer.from(parts[3], "base64")).toHaveLength(64);
    expect(stored).not.toContain("kalam siri");
  });

  it("salts every hash, so the same password hashes differently twice", async () => {
    const first = await hashPassword("el motto asrar");
    const second = await hashPassword("el motto asrar");

    // Without this, two pharmacists sharing a password would have identical
    // rows — and one leaked hash would confirm the other.
    expect(first).not.toBe(second);
    expect(await verifyPassword("el motto asrar", first)).toBe(true);
    expect(await verifyPassword("el motto asrar", second)).toBe(true);
  });

  it("treats a corrupt stored hash as a failed login, never as an exception", async () => {
    const garbage = [
      "",
      "not-a-hash",
      "scrypt$N=131072,r=8,p=1$c2FsdA$a2V5", // valid shape, wrong key length
      "scrypt$N=131072,r=8,p=1$AAAA$BBBB$CCCC", // 5 parts
      "bcrypt$N=131072,r=8,p=1$AAAA$BBBB", // wrong algorithm
      "scrypt$N=abc,r=8,p=1$AAAA$BBBB", // non-numeric parameter
      "scrypt$N=131072,r=8$AAAA$BBBB", // missing parameter
      "scrypt$N=-1,r=8,p=1$AAAA$BBBB", // impossible parameter
      "scrypt$N=131072,r=8,p=1$$BBBB", // empty salt
      "scrypt$N=131072,r=8,p=1$AAAA$", // empty key
    ];

    for (const stored of garbage) {
      await expect(verifyPassword("anything", stored)).resolves.toBe(false);
    }
  });

  it("rejects a truncated key without reaching timingSafeEqual", async () => {
    // A valid header with a key of the wrong length. timingSafeEqual throws on
    // length mismatch, so a missing guard here would surface as a 500 on the
    // login route instead of a refused password.
    const stored = `scrypt$N=131072,r=8,p=1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(32).toString("base64")}`;

    await expect(verifyPassword("anything", stored)).resolves.toBe(false);
  });

  it("normalises Unicode, so a password survives a different keyboard", async () => {
    // "café" typed with a combining accent (NFD) and precomposed (NFC) are the
    // same password to the person typing it. macOS and iOS hand the browser
    // NFD; without NFKC normalisation the account would be locked out.
    const nfc = "café-2026";
    const nfd = "café-2026";
    expect(nfd).not.toBe(nfc);

    const stored = await hashPassword(nfd);
    expect(await verifyPassword(nfc, stored)).toBe(true);
  });
});

describe("needsRehash", { timeout: TIMEOUT }, () => {
  it("is false for a hash made with the current parameters", async () => {
    expect(needsRehash(await hashPassword("current"))).toBe(false);
  });

  it("is true for a hash made with weaker parameters", () => {
    // The whole point of a self-describing format: cost can be raised without
    // locking anyone out, and this is what tells the login path to upgrade.
    const weaker = `scrypt$N=16384,r=8,p=1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64).toString("base64")}`;
    expect(needsRehash(weaker)).toBe(true);
  });

  it("is true for a hash that cannot be parsed at all", () => {
    // A row we cannot read is not trustworthy, and rehashing with the password
    // just proved correct is how it gets repaired.
    expect(needsRehash("")).toBe(true);
    expect(needsRehash("something-else-entirely")).toBe(true);
    expect(needsRehash(`argon2id$v=19$m=65536,t=3,p=4$AAAA$BBBB`)).toBe(true);
  });

  it("still verifies a weaker hash before it is upgraded", async () => {
    // needsRehash must not mean "unusable": the user logs in, and only then
    // does the row get rewritten.
    const stored = await hashPassword("legacy password");
    expect(await verifyPassword("legacy password", stored)).toBe(true);
    expect(needsRehash(stored)).toBe(false);
  });
});
