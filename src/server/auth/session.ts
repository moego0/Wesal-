import { createHash, randomBytes } from "node:crypto";
import type { Locale, PharmacyRole } from "@/generated/prisma/enums";
import { systemPrisma, type RawClient } from "@/server/db";

/**
 * Opaque server-side sessions.
 *
 * Not JWTs, on purpose: a pharmacy admin revoking a colleague's access, or a
 * role change taking effect, has to happen now — not whenever a signed token
 * happens to expire. Every request resolves the session against this table.
 *
 * The cookie carries a random token; the database stores only its SHA-256.
 * A leaked database dump therefore contains no usable sessions.
 */

export const SESSION_COOKIE_NAME = "wasal_session";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function generateSessionToken(): string {
  // 32 bytes = 256 bits of entropy. base64url keeps it cookie-safe without
  // percent-encoding.
  return randomBytes(32).toString("base64url");
}

/**
 * Plain SHA-256, not a password KDF: the input is a 256-bit random value with
 * no guessable structure, so there is nothing for a slow hash to protect.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type SessionCreateInput = {
  userId: string;
  /**
   * Null when the user belongs to more than one pharmacy and has not chosen
   * one yet; `validateSession` then falls back to their first active
   * membership.
   */
  activePharmacyId?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  ttlMs?: number;
};

/**
 * Which pharmacy a freshly signed-in session starts scoped to.
 *
 * One membership is unambiguous, so it is recorded and every later request is
 * pinned to it. More than one is a choice this app cannot make for the user,
 * so the session stores null and `validateSession` resolves the first active
 * membership on each request.
 *
 * TODO(tenancy): when more than one membership exists we deliberately leave
 * `activePharmacyId` null. The pharmacy chooser that replaces this fallback is
 * not built yet.
 */
export function activePharmacyIdForLogin(
  memberships: readonly { pharmacyId: string }[],
): string | null {
  return memberships.length === 1 ? memberships[0].pharmacyId : null;
}

/**
 * What these functions write through: either client, or a transaction handle,
 * so a session can be created in the same transaction as the audit row for
 * the login.
 *
 * `Pick<PrismaClient, "session">` rather than a hand-rolled
 * `{ session: { create(args: { data: Record<string, unknown> }) } }`: Prisma's
 * `create` is generic over its args, so a `Record<string, unknown>` parameter
 * is wider than what it accepts and would not typecheck without a cast.
 */
export type SessionWriter = Pick<RawClient, "session">;

export type CreatedSession = {
  /** The raw token. Returned once, for the cookie — never stored. */
  token: string;
  sessionId: string;
  expiresAt: Date;
};

export async function createSession(
  input: SessionCreateInput,
  writer: SessionWriter = systemPrisma,
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? SESSION_TTL_MS));

  const session = await writer.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId: input.userId,
      activePharmacyId: input.activePharmacyId ?? null,
      expiresAt,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
    },
  });

  return { token, sessionId: session.id, expiresAt };
}

/**
 * Soft revoke, so the reason a session ended stays auditable. Returns false
 * when the token matches nothing (or is already revoked), which callers treat
 * as "already signed out" rather than an error.
 */
export async function revokeSession(
  token: string,
  writer: SessionWriter = systemPrisma,
): Promise<boolean> {
  const row = await systemPrisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: { id: true, revokedAt: true },
  });

  if (!row || row.revokedAt !== null) return false;

  await writer.session.update({
    where: { id: row.id },
    data: { revokedAt: new Date() },
  });

  return true;
}

export type SessionContext = {
  sessionId: string;
  expiresAt: Date;
  userId: string;
  email: string;
  fullName: string;
  locale: Locale;
  /** The pharmacy this request is scoped to. Never null — see below. */
  pharmacyId: string;
  pharmacyName: string;
  pharmacyTimeZone: string;
  role: PharmacyRole;
};

/**
 * Resolve a raw cookie token to the session it identifies, or null.
 *
 * Uses `systemPrisma` deliberately: the token identifies the user, so there is
 * no pharmacy to filter by yet — the pharmacy is what this call resolves. The
 * tenant guard would reject a `findMany` here for exactly that reason.
 *
 * Null means "treat as signed out": no such session, expired, revoked, user
 * not ACTIVE, or no active membership left. The caller redirects to login;
 * none of these cases should be distinguishable to the client.
 */
export async function validateSession(token: string): Promise<SessionContext | null> {
  const row = await systemPrisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: {
      user: {
        include: {
          memberships: {
            where: { active: true },
            include: { pharmacy: true },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });

  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (row.user.status !== "ACTIVE") return null;

  const memberships = row.user.memberships;

  // TODO(tenancy): when a user has more than one membership, `activePharmacyId`
  // is set to null at login and there is no UI to choose. Until that chooser
  // exists, the first active membership (oldest, by createdAt) stands in for
  // the choice. The ordering is stable, so a user does not silently hop
  // between pharmacies between requests.
  const membership =
    memberships.find((m) => m.pharmacyId === row.activePharmacyId) ?? memberships[0];

  if (!membership) return null;

  return {
    sessionId: row.id,
    expiresAt: row.expiresAt,
    userId: row.user.id,
    email: row.user.email,
    fullName: row.user.fullName,
    locale: row.user.locale,
    pharmacyId: membership.pharmacyId,
    pharmacyName: membership.pharmacy.name,
    pharmacyTimeZone: membership.pharmacy.timeZone,
    role: membership.role,
  };
}
