import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { UserStatus } from "@/generated/prisma/enums";
import {
  SESSION_TTL_MS,
  activePharmacyIdForLogin,
  createSession,
  hashSessionToken,
  revokeSession,
  validateSession,
} from "@/server/auth/session";
import { systemPrisma } from "@/server/db";

/**
 * Sessions against the real database.
 *
 * They are the one auth primitive that cannot be tested in isolation: the
 * contract is "this token identifies exactly this user, at exactly this
 * pharmacy", and the row plus its membership join is what proves it. The
 * fixture users are addressed by a per-run id so a parallel or aborted run
 * cannot collide with them, and `afterAll` removes everything it made.
 */

const RUN = randomUUID().slice(0, 8);

const userIds: string[] = [];
const pharmacyIds: string[] = [];

async function makePharmacy(label: string) {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Test Pharmacy ${label} (${RUN})` },
  });
  pharmacyIds.push(pharmacy.id);
  return pharmacy;
}

async function makeUser(
  label: string,
  status: UserStatus = "ACTIVE",
  isSuperAdmin = false,
) {
  const user = await systemPrisma.user.create({
    data: {
      email: `test-${label}-${RUN}@wasal.test`,
      fullName: `Test User ${label} (${RUN})`,
      status,
      isSuperAdmin,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeMembership(
  userId: string,
  pharmacyId: string,
  role: "PHARMACY_ADMIN" | "PHARMACIST" | "ASSISTANT" | "VIEWER",
  options: { active?: boolean; createdAt?: Date } = {},
) {
  return systemPrisma.pharmacyMembership.create({
    data: {
      userId,
      pharmacyId,
      role,
      active: options.active ?? true,
      // Pinned explicitly where ordering decides the outcome: `createdAt` is
      // otherwise `now()`, and two rows created in the same millisecond would
      // make the fallback non-deterministic.
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
}

afterAll(async () => {
  if (userIds.length > 0) {
    // Sessions and memberships cascade from the user; deleted explicitly anyway
    // so a failure here cannot leave a live session behind.
    await systemPrisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await systemPrisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (pharmacyIds.length > 0) {
    await systemPrisma.pharmacy.deleteMany({ where: { id: { in: pharmacyIds } } });
  }
});

describe("createSession / validateSession", () => {
  it("resolves a session back to its user, pharmacy and role", async () => {
    const pharmacy = await makePharmacy("single");
    const user = await makeUser("pharmacist");
    await makeMembership(user.id, pharmacy.id, "PHARMACIST");

    const created = await createSession({
      userId: user.id,
      activePharmacyId: pharmacy.id,
      userAgent: "vitest",
      ipAddress: "10.0.0.1",
    });

    const session = await validateSession(created.token);
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe(created.sessionId);
    expect(session!.userId).toBe(user.id);
    expect(session!.email).toBe(user.email);
    expect(session!.fullName).toBe(user.fullName);
    expect(session!.role).toBe("PHARMACIST");
    expect(session!.pharmacyId).toBe(pharmacy.id);
    expect(session!.pharmacyName).toBe(pharmacy.name);
    // The timezone travels with the session: reminder copy is written in the
    // pharmacy's local time, not the server's.
    expect(session!.pharmacyTimeZone).toBe("Africa/Cairo");
  });

  it("expires 30 days out by default", async () => {
    const pharmacy = await makePharmacy("ttl");
    const user = await makeUser("ttl");
    await makeMembership(user.id, pharmacy.id, "PHARMACY_ADMIN");

    const before = Date.now();
    const created = await createSession({ userId: user.id, activePharmacyId: pharmacy.id });
    const after = Date.now();

    expect(created.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(after + SESSION_TTL_MS);
  });

  it("persists only the token's SHA-256, never the token itself", async () => {
    const pharmacy = await makePharmacy("hash");
    const user = await makeUser("hash");
    await makeMembership(user.id, pharmacy.id, "PHARMACIST");

    const created = await createSession({ userId: user.id, activePharmacyId: pharmacy.id });

    const row = await systemPrisma.session.findUnique({ where: { id: created.sessionId } });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toBe(hashSessionToken(created.token));
    expect(row!.tokenHash).not.toBe(created.token);
    // The blunt version of the same claim: nothing in the row echoes the cookie.
    expect(JSON.stringify(row)).not.toContain(created.token);
  });

  it("treats an unknown token as signed out", async () => {
    await expect(validateSession("not-a-real-token")).resolves.toBeNull();
    await expect(validateSession(randomUUID())).resolves.toBeNull();
  });

  it("rejects an expired session", async () => {
    const pharmacy = await makePharmacy("expired");
    const user = await makeUser("expired");
    await makeMembership(user.id, pharmacy.id, "PHARMACIST");

    // ttlMs is not exposed through any UI; used here to age the row without
    // waiting — and it is the same knob a "remember me for 8 hours" would use.
    const created = await createSession({
      userId: user.id,
      activePharmacyId: pharmacy.id,
      ttlMs: -1000,
    });

    await expect(validateSession(created.token)).resolves.toBeNull();
  });

  it("rejects a revoked session, and reports whether a revoke did anything", async () => {
    const pharmacy = await makePharmacy("revoked");
    const user = await makeUser("revoked");
    await makeMembership(user.id, pharmacy.id, "PHARMACIST");

    const created = await createSession({ userId: user.id, activePharmacyId: pharmacy.id });
    expect(await validateSession(created.token)).not.toBeNull();

    expect(await revokeSession(created.token)).toBe(true);
    await expect(validateSession(created.token)).resolves.toBeNull();

    // Already revoked: a second sign-out is not an error, but it is also not a
    // change worth claiming.
    expect(await revokeSession(created.token)).toBe(false);
    expect(await revokeSession("not-a-real-token")).toBe(false);

    // Soft revoke: the row and its timestamp survive, which is what makes
    // "when did this session end" answerable after the fact.
    const row = await systemPrisma.session.findUnique({ where: { id: created.sessionId } });
    expect(row!.revokedAt).toBeInstanceOf(Date);
  });

  it("does not admit a user who is not ACTIVE", async () => {
    const pharmacy = await makePharmacy("suspended");
    const user = await makeUser("suspended", "SUSPENDED");
    await makeMembership(user.id, pharmacy.id, "PHARMACIST");

    const created = await createSession({ userId: user.id, activePharmacyId: pharmacy.id });
    await expect(validateSession(created.token)).resolves.toBeNull();
  });

  it("does not admit a user whose only membership was deactivated", async () => {
    const pharmacy = await makePharmacy("no-membership");
    const user = await makeUser("no-membership");
    await makeMembership(user.id, pharmacy.id, "PHARMACIST", { active: false });

    const created = await createSession({ userId: user.id, activePharmacyId: pharmacy.id });
    await expect(validateSession(created.token)).resolves.toBeNull();
  });

  it("honours the pharmacy a session was pinned to", async () => {
    const first = await makePharmacy("pinned-first");
    const second = await makePharmacy("pinned-second");
    const user = await makeUser("pinned");
    await makeMembership(user.id, first.id, "ASSISTANT", {
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await makeMembership(user.id, second.id, "PHARMACIST", {
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    const created = await createSession({ userId: user.id, activePharmacyId: second.id });
    const session = await validateSession(created.token);

    // The role is the role at THAT pharmacy — the same person can assist at one
    // branch and dispense at another.
    expect(session!.pharmacyId).toBe(second.id);
    expect(session!.role).toBe("PHARMACIST");
  });

  it("falls back to the first active membership when the session names none", async () => {
    const older = await makePharmacy("fallback-older");
    const newer = await makePharmacy("fallback-newer");
    const user = await makeUser("fallback");
    await makeMembership(user.id, older.id, "PHARMACIST", {
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await makeMembership(user.id, newer.id, "VIEWER", {
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });

    // What login stores for a user with two memberships: null.
    const created = await createSession({ userId: user.id, activePharmacyId: null });
    const session = await validateSession(created.token);

    // The OLDEST membership, because ordering is by createdAt — stable across
    // requests, so a user does not silently hop pharmacies mid-shift.
    expect(session!.pharmacyId).toBe(older.id);
    expect(session!.role).toBe("PHARMACIST");
  });
});

describe("the platform owner's session", () => {
  it("carries the flag through an ordinary membership", async () => {
    /*
     * Catches: a context built field by field that forgets `isSuperAdmin`. The
     * flag is what `hasPermission` short-circuits on and what every platform
     * action checks, so losing it in the session silently demotes the owner on
     * every request while their database row still says otherwise.
     */
    const pharmacy = await makePharmacy("owner-member");
    const user = await makeUser("owner-member", "ACTIVE", true);
    await makeMembership(user.id, pharmacy.id, "PHARMACIST");

    const created = await createSession({
      userId: user.id,
      activePharmacyId: pharmacy.id,
    });
    const session = await validateSession(created.token);

    expect(session?.isSuperAdmin).toBe(true);
    // The membership role is preserved, not replaced: the flag is orthogonal.
    expect(session?.role).toBe("PHARMACIST");
    expect(session?.pharmacyId).toBe(pharmacy.id);
  });

  it("opens a pharmacy the owner holds no membership in", async () => {
    /*
     * Catches: resolving the pinned pharmacy through the membership join only —
     * which is what makes "open another tenant" from the platform console
     * impossible. The synthesized PHARMACY_ADMIN role is display-only; the flag
     * is what grants the access, and `hasPermission` ignores the role.
     */
    const memberOf = await makePharmacy("owner-elsewhere");
    const opened = await makePharmacy("owner-opened");
    const user = await makeUser("owner-opened", "ACTIVE", true);
    await makeMembership(user.id, memberOf.id, "PHARMACIST");

    const created = await createSession({ userId: user.id, activePharmacyId: opened.id });
    const session = await validateSession(created.token);

    expect(session).not.toBeNull();
    expect(session!.pharmacyId).toBe(opened.id);
    expect(session!.pharmacyName).toBe(opened.name);
    expect(session!.role).toBe("PHARMACY_ADMIN");
    expect(session!.isSuperAdmin).toBe(true);
  });

  it("does not extend that to an account without the flag", async () => {
    /*
     * Catches: making the direct-read branch unconditional. A non-owner pinned
     * to a pharmacy they do not belong to must fall back to their own membership
     * — otherwise a hand-built session row would open any tenant.
     */
    const memberOf = await makePharmacy("nonowner-member");
    const stranger = await makePharmacy("nonowner-stranger");
    const user = await makeUser("nonowner");
    await makeMembership(user.id, memberOf.id, "PHARMACIST");

    const created = await createSession({ userId: user.id, activePharmacyId: stranger.id });
    const session = await validateSession(created.token);

    expect(session).not.toBeNull();
    expect(session!.pharmacyId).toBe(memberOf.id);
    expect(session!.isSuperAdmin).toBe(false);
  });

  it("falls back to the oldest active pharmacy when the owner has no membership", async () => {
    /*
     * Catches: returning null for a membership-less account. On a fresh
     * deployment the owner exists before the first pharmacy; locking them out
     * would make that state unrecoverable from the UI.
     */
    const user = await makeUser("owner-nomembership", "ACTIVE", true);

    const oldest = await systemPrisma.pharmacy.findFirst({
      where: { status: "ACTIVE" },
      // Mirror `validateSession`'s ordering exactly, so this compares the same
      // row rather than the same intention.
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, timeZone: true },
    });

    const created = await createSession({ userId: user.id, activePharmacyId: null });
    const session = await validateSession(created.token);

    expect(session).not.toBeNull();
    expect(session!.isSuperAdmin).toBe(true);
    expect(session!.role).toBe("PHARMACY_ADMIN");
    expect(session!.pharmacyId).toBe(oldest?.id ?? "");
    expect(session!.pharmacyName).toBe(oldest?.name ?? "");
    expect(session!.pharmacyTimeZone).toBe(oldest?.timeZone ?? "Africa/Cairo");
  });

  it("still refuses a suspended owner", async () => {
    /*
     * Catches: placing the flag check before the account-status check. A
     * suspended account is suspended at every pharmacy, owner or not.
     */
    const pharmacy = await makePharmacy("owner-suspended");
    const user = await makeUser("owner-suspended", "SUSPENDED", true);
    await makeMembership(user.id, pharmacy.id, "PHARMACY_ADMIN");

    const created = await createSession({
      userId: user.id,
      activePharmacyId: pharmacy.id,
    });
    await expect(validateSession(created.token)).resolves.toBeNull();
  });
});

describe("activePharmacyIdForLogin", () => {
  it("pins a single membership", () => {
    expect(activePharmacyIdForLogin([{ pharmacyId: "pharm_1" }])).toBe("pharm_1");
  });

  it("leaves the choice open when there is more than one", () => {
    // TODO(tenancy) in session.ts: the pharmacy chooser does not exist yet, so
    // the session records no pharmacy and validateSession falls back.
    expect(
      activePharmacyIdForLogin([{ pharmacyId: "pharm_1" }, { pharmacyId: "pharm_2" }]),
    ).toBeNull();
  });

  it("is null without any membership", () => {
    expect(activePharmacyIdForLogin([])).toBeNull();
  });
});
