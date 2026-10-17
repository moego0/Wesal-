"use server";

import { hasLocale } from "next-intl";
import { redirect } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { requireSessionUser } from "@/server/auth/current-user";
import {
  ASSIGNABLE_ROLES,
  PermissionDeniedError,
  requirePermission,
} from "@/server/auth/rbac";
import type { SessionContext } from "@/server/auth/session";
import {
  applyMembershipActive,
  applyMembershipRole,
  invitePharmacyMember,
} from "@/server/queries/admin";

/**
 * Writes for the pharmacy users screen: invite, change role, deactivate.
 *
 * Each is a public endpoint and each one authenticates, authorizes and scopes
 * before it reads a field. What the screen's server-enforced guard rails
 * actually are, and why they cannot live in the UI:
 *
 *   - **An admin cannot change their own role or deactivate themselves.** Both
 *     are checked in `applyMembershipRole` / `applyMembershipActive` against the
 *     SESSION's user id, not against a hidden field — a hidden field is a
 *     suggestion. Disabling the select in the row for yourself would protect
 *     nobody, because the select is not what enforces it.
 *   - **The last active `PHARMACY_ADMIN` cannot be demoted or deactivated.**
 *     That check is inside the transaction, holding a lock; see the comment on
 *     `lockPharmacy` in `@/server/queries/admin` for why a read-then-write check
 *     is not equivalent and no database constraint could catch it.
 *   - **A membership from another pharmacy cannot be touched.** Every lookup is
 *     `findFirst({ where: { id, pharmacyId } })` with the id from the form and
 *     the pharmacy from the session, so another tenant's row returns `NOT_FOUND`
 *     — indistinguishable from one that does not exist.
 *
 * These actions redirect rather than return state, for the reason set out at
 * length in `@/server/settings/actions.ts`: the screen is all Server Components,
 * and a bare `<form action={…}>` calls the action with one argument, so a
 * `useActionState`-style `(prev, formData)` signature would silently receive
 * `undefined` as its `FormData` and fail every submission.
 */

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The locale a redirect comes back to — carried in the form because an action
 * cannot read the URL it was posted from, and validated because it ends up in a
 * redirect target.
 */
function safeLocale(value: FormDataEntryValue | null): AppLocale {
  return hasLocale(routing.locales, value) ? value : routing.defaultLocale;
}

/**
 * Session, then permission, before any field is read.
 *
 * Bounced to the dashboard on refusal rather than back to `/settings/users`,
 * which will not render for a caller without `user:manage` — see the same helper
 * in the settings actions.
 */
async function usersManager(
  formData: FormData,
): Promise<{ locale: AppLocale; user: SessionContext }> {
  const locale = safeLocale(formData.get("locale"));
  const user = await requireSessionUser(locale);

  try {
    requirePermission(user, "user:manage");
  } catch (error) {
    if (error instanceof PermissionDeniedError) redirect({ href: "/", locale });
    throw error;
  }

  return { locale, user };
}

const USERS = "/settings/users";

/** The two accounts a pharmacy is made of. See `ASSIGNABLE_ROLES`. */
const ASSIGNABLE = new Set<string>(ASSIGNABLE_ROLES);

/**
 * Add a colleague.
 *
 * Account creation is the platform owner's power. A pharmacy manager can list
 * staff, change roles and end access, but this endpoint refuses every caller
 * except the super admin — hiding the form would protect nothing, because the
 * POST can be written by hand.
 *
 * The password field is optional and blank is the normal case: with no mail
 * delivery and no password-reset flow in this product, an invitation cannot
 * actually reach anyone, and inventing a password here would produce an account
 * with credentials nobody holds. Left blank, the account is created `INVITED`
 * with no password hash, which means it cannot sign in — see
 * `invitePharmacyMember`, which also attaches to an existing `User` rather than
 * refusing when the address is already known to another pharmacy.
 */
export async function inviteMember(formData: FormData): Promise<void> {
  const { locale, user } = await usersManager(formData);

  if (!user.isSuperAdmin) {
    redirect({ href: { pathname: USERS, query: { error: "FORBIDDEN" } }, locale });
  }

  // The select offers manager and doctor only, and the core's schema is broader
  // because role CHANGES legitimately use all four. A hand-written POST must not
  // be able to mint an assistant through this form.
  const role = field(formData, "role");
  if (role !== undefined && !ASSIGNABLE.has(role)) {
    redirect({
      href: { pathname: USERS, query: { error: "INVALID_INPUT", field: "role" } },
      locale,
    });
  }

  const result = await invitePharmacyMember(
    { pharmacyId: user.pharmacyId, userId: user.userId },
    {
      email: field(formData, "email"),
      fullName: field(formData, "fullName"),
      role,
      phoneE164: field(formData, "phoneE164"),
      initialPassword: field(formData, "initialPassword"),
    },
  );

  if (!result.ok) {
    redirect({
      href: {
        pathname: USERS,
        query: { error: result.code, field: result.detail ?? "" },
      },
      locale,
    });
  }

  redirect({ href: { pathname: USERS, query: { ok: result.code } }, locale });
}

/**
 * Change someone's role.
 *
 * Refusals carry the membership id back so the page can point at the row that
 * was rejected instead of showing a notice detached from anything.
 */
export async function changeMemberRole(formData: FormData): Promise<void> {
  const { locale, user } = await usersManager(formData);
  const membershipId = field(formData, "membershipId");

  const result = await applyMembershipRole(
    { pharmacyId: user.pharmacyId, userId: user.userId },
    {
      membershipId,
      role: field(formData, "role"),
      reason: field(formData, "reason"),
    },
  );

  redirect({
    href: {
      pathname: USERS,
      query: result.ok
        ? { ok: result.code, member: membershipId ?? "" }
        : { error: result.code, member: membershipId ?? "", field: result.detail ?? "" },
    },
    locale,
  });
}

/**
 * Activate or deactivate a colleague.
 *
 * The form sends `active=false` to deactivate and `active=true` to restore, and
 * the value is read as a boolean rather than as "the button that was pressed":
 * `formData.get("intent")` would be one more thing a client could lie about,
 * whereas the resulting state is what the action actually writes and audits.
 */
export async function setMemberActive(formData: FormData): Promise<void> {
  const { locale, user } = await usersManager(formData);
  const membershipId = field(formData, "membershipId");

  const result = await applyMembershipActive(
    { pharmacyId: user.pharmacyId, userId: user.userId },
    {
      membershipId,
      active: field(formData, "active") === "true",
      reason: field(formData, "reason"),
    },
  );

  redirect({
    href: {
      pathname: USERS,
      query: result.ok
        ? { ok: result.code, member: membershipId ?? "" }
        : { error: result.code, member: membershipId ?? "", field: result.detail ?? "" },
    },
    locale,
  });
}
