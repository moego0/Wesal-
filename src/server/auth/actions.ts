"use server";

import { randomBytes } from "node:crypto";
import { hasLocale } from "next-intl";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { AUDIT_ACTION, writeAudit, type AuditWriter } from "@/server/audit";
import { systemPrisma } from "@/server/db";
import { clearSessionCookie, getSessionToken, setSessionCookie } from "./current-user";
import { PASSWORD_ALGO, hashPassword, needsRehash, verifyPassword } from "./password";
import {
  activePharmacyIdForLogin,
  createSession,
  revokeSession,
  validateSession,
} from "./session";

/**
 * Login and logout.
 *
 * Both are Server Actions rather than route handlers so the form works without
 * JavaScript and so the cookie is set in the same request that established the
 * session.
 */

export type LoginState = { error: "INVALID_CREDENTIALS" | null };

const INVALID: LoginState = { error: "INVALID_CREDENTIALS" };

/**
 * Verifying against a throwaway hash when the email is unknown keeps the
 * response time flat: without it, a fast "no such account" and a slow "wrong
 * password" turn the login form into an account-enumeration oracle. Cheap
 * insurance — one scrypt run, only on the failure path.
 */
let dummyHash: string | null = null;

async function burnVerificationTime(password: string): Promise<void> {
  dummyHash ??= await hashPassword(randomBytes(32).toString("hex"));
  await verifyPassword(password, dummyHash);
}

/** The locale arrives from a form field, so it is validated, never trusted. */
function safeLocale(value: FormDataEntryValue | null): AppLocale {
  return hasLocale(routing.locales, value) ? value : routing.defaultLocale;
}

async function requestContext(): Promise<{ ipAddress: string | null; userAgent: string | null }> {
  const headersList = await headers();

  return {
    ipAddress: headersList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: headersList.get("user-agent")?.slice(0, 500) ?? null,
  };
}

export async function loginAction(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  // TODO(security): no rate limiting yet. Login is the one endpoint where an
  // unauthenticated caller can make the server do 128 MiB of scrypt work per
  // request, so this needs a per-IP and per-account limiter before launch.
  const locale = safeLocale(formData.get("locale"));
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (email === "" || password === "") return INVALID;

  const { ipAddress, userAgent } = await requestContext();

  // Users are a global identity, so there is no pharmacy to scope this by —
  // the same reason session lookup uses the unguarded client.
  const user = await systemPrisma.user.findUnique({ where: { email } });

  if (!user?.passwordHash) {
    await burnVerificationTime(password);
    // No pharmacy can be attributed to an unknown address, and `AuditEvent`
    // requires one. A row filed under an arbitrary pharmacy would be worse
    // than no row: it would put one tenant's login attempts in another
    // tenant's permanent audit log.
    return INVALID;
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    await auditLoginFailure(user.id);
    return INVALID;
  }

  if (user.status !== "ACTIVE") {
    await auditLoginFailure(user.id);
    return INVALID;
  }

  const memberships = await systemPrisma.pharmacyMembership.findMany({
    where: { userId: user.id, active: true },
    orderBy: { createdAt: "asc" },
  });

  if (memberships.length === 0 && !user.isSuperAdmin) {
    await burnVerificationTime(password);
    return INVALID;
  }

  // See `activePharmacyIdForLogin`: one membership pins the session, more than
  // one leaves it null and lets `validateSession` fall back. The platform owner
  // is allowed to have no membership at all; the oldest pharmacy then supplies
  // the initial scope, and the shell switcher repoints it from there.
  const activePharmacyId = activePharmacyIdForLogin(memberships);
  const auditPharmacyId =
    memberships[0]?.pharmacyId ??
    (user.isSuperAdmin
      ? ((
          await systemPrisma.pharmacy.findFirst({
            // Same scope `validateSession` falls back to, so the sign-in is
            // filed in the pharmacy the session actually opens.
            where: { status: "ACTIVE" },
            orderBy: { createdAt: "asc" },
            select: { id: true },
          })
        )?.id ?? null)
      : null);
  const rehash = needsRehash(user.passwordHash);

  // Runs on the unguarded client: a login has no pharmacy context yet, every
  // write here is addressed by primary key, and the Session/User rows are not
  // tenant-scoped. The audit row states its pharmacy explicitly.
  const session = await systemPrisma.$transaction(async (tx) => {
    const created = await createSession(
      { userId: user.id, activePharmacyId, userAgent, ipAddress },
      tx,
    );

    if (rehash) {
      // Raised scrypt parameters, or a row we could not parse. The plaintext
      // is in hand and already verified, so this is the moment to upgrade it.
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await hashPassword(password),
          passwordAlgo: PASSWORD_ALGO,
        },
      });
    }

    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // A super admin on a deployment with no pharmacy yet has nowhere to file
    // this row: `AuditEvent.pharmacyId` is required, and inventing a tenant
    // would put their sign-in in another pharmacy's permanent log.
    if (auditPharmacyId) {
      // The cast is forced by `AuditWriter` in src/server/audit.ts being a
      // structural stand-in for any writer; see `writeSystemAudit` there.
      await writeAudit(tx as unknown as AuditWriter, {
        pharmacyId: auditPharmacyId,
        actorType: "USER",
        actorUserId: user.id,
        entityType: "Session",
        entityId: created.sessionId,
        action: AUDIT_ACTION.LOGIN_SUCCEEDED,
        ipAddress: ipAddress ?? undefined,
      });
    }

    return created;
  });

  await setSessionCookie(session.token, session.expiresAt);

  // The platform owner lands on the console; everyone else on the dashboard.
  redirect(user.isSuperAdmin ? `/${locale}/platform` : `/${locale}`);
}

/**
 * A failed attempt is only recorded against a pharmacy the user actually
 * belongs to; see `loginAction` for why there is otherwise no row.
 */
async function auditLoginFailure(userId: string): Promise<void> {
  const membership = await systemPrisma.pharmacyMembership.findFirst({
    where: { userId, active: true },
    orderBy: { createdAt: "asc" },
  });

  if (!membership) return;

  await writeAudit(systemPrisma as unknown as AuditWriter, {
    pharmacyId: membership.pharmacyId,
    actorType: "USER",
    actorUserId: userId,
    entityType: "User",
    entityId: userId,
    action: AUDIT_ACTION.LOGIN_FAILED,
  });
}

export async function logoutAction(formData: FormData): Promise<void> {
  const locale = safeLocale(formData.get("locale"));
  const token = await getSessionToken();

  if (token) {
    // Resolve before revoking, so the audit row can name the pharmacy the
    // session was scoped to.
    const session = await validateSession(token);

    await systemPrisma.$transaction(async (tx) => {
      await revokeSession(token, tx);

      if (session) {
        await writeAudit(tx as unknown as AuditWriter, {
          pharmacyId: session.pharmacyId,
          actorType: "USER",
          actorUserId: session.userId,
          entityType: "Session",
          entityId: session.sessionId,
          action: AUDIT_ACTION.LOGOUT,
        });
      }
    });
  }

  await clearSessionCookie();
  redirect(`/${locale}/login`);
}
