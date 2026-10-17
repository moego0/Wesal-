import { z } from "zod";
import { Locale } from "@/generated/prisma/enums";
import { AUDIT_ACTION, writeAudit, type AuditWriter } from "@/server/audit";
import { hashPassword } from "@/server/auth/password";
import { requireSuperAdmin } from "@/server/auth/rbac";
import { prisma, systemPrisma } from "@/server/db";
import {
  isValidTimeZone,
  listPharmacyMemberships,
  parseInviteInput,
  invitePharmacyMemberTx,
  type AdminRefusalCode,
  type MembershipRow,
} from "@/server/queries/admin";

/**
 * The platform console's data layer: every pharmacy, and the account
 * provisioning that only the platform owner may perform.
 *
 * ## Why `systemPrisma` is used here
 *
 * Listing pharmacies spans tenants by definition — there is no pharmacy to
 * scope the list to. The tenant guard in `@/server/db` is deliberately built to
 * reject exactly that shape, so these reads use the unguarded client and every
 * one of them is stated explicitly. Writes go through the guarded client: the
 * models involved (`Pharmacy`, `User`, `PharmacyMembership`) are identity
 * rather than clinical data and are not in the guard's list, and the audit row
 * names its pharmacy directly. Worker sweeps and inbound routing already use
 * the unguarded client for the same reason.
 *
 * ## Why every export re-checks `isSuperAdmin`
 *
 * This module is not a `"use server"` file, so it is not reachable from the
 * browser — but its functions are imported by actions, scripts and tests, and
 * a future caller could forget the gate. `requireSuperAdmin` runs FIRST, before
 * any field is parsed and before any query, so a forgotten check in a caller
 * fails closed. The actions re-check as well, which costs one boolean.
 */

/** The platform owner, as derived from a validated session. */
export type PlatformActor = {
  userId: string;
  sessionId: string;
  isSuperAdmin: boolean;
};

export type PlatformSuccessCode = "PHARMACY_CREATED" | "ACCOUNT_CREATED" | "PHARMACY_OPENED";

export type PlatformResult<T = undefined> =
  | { ok: true; code: PlatformSuccessCode; data: T }
  | { ok: false; code: AdminRefusalCode; detail?: string };

export type PlatformPharmacyRow = {
  id: string;
  name: string;
  timeZone: string;
  defaultLocale: Locale;
  status: string;
  createdAt: Date;
  managers: number;
  doctors: number;
  /** Active memberships in total, including the two roles above. */
  staff: number;
  patients: number;
};

export type PlatformPharmacyDetail = {
  pharmacy: {
    id: string;
    name: string;
    timeZone: string;
    defaultLocale: Locale;
    quietHoursStart: string;
    quietHoursEnd: string;
    status: string;
    createdAt: Date;
  };
  staff: MembershipRow[];
  patients: number;
};

const idSchema = z.string().trim().min(1).max(64);
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Same shape as the settings profile form. Duplicated rather than imported
 * because `profileSchema` in `queries/admin` is private and carries a `reason`
 * field that a brand-new pharmacy has no prior state to explain.
 */
const pharmacySchema = z.object({
  name: z.string().trim().min(2).max(120),
  timeZone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimeZone)
    .default("Africa/Cairo"),
  defaultLocale: z.enum(Locale).default("AR_EG"),
  quietHoursStart: z.string().regex(HHMM).default("21:30"),
  quietHoursEnd: z.string().regex(HHMM).default("07:00"),
});

/** The only two roles the platform may create. */
const assignableRoleSchema = z.enum(["PHARMACY_ADMIN", "PHARMACIST"]);

/** The form field a refusal should be shown beside. */
const PHARMACY_FIELD: Record<string, string> = {
  name: "name",
  timeZone: "timeZone",
  defaultLocale: "defaultLocale",
  quietHoursStart: "quietHoursStart",
  quietHoursEnd: "quietHoursEnd",
};

const MANAGER_FIELD: Record<string, string> = {
  email: "managerEmail",
  fullName: "managerFullName",
  phoneE164: "managerPhoneE164",
  initialPassword: "managerPassword",
  role: "managerEmail",
};

/** A refusal from the shared invite core, surfaced after the transaction rolls back. */
class InviteRefused extends Error {
  constructor(readonly refusal: { code: AdminRefusalCode; detail?: string }) {
    super(refusal.code);
    this.name = "InviteRefused";
  }
}

function firstIssue(error: z.ZodError): string {
  return String(error.issues[0]?.path[0] ?? "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every pharmacy, with the numbers the platform owner needs at a glance.
 *
 * Ordered oldest first, matching the order a super admin without a pinned
 * pharmacy falls back to in `validateSession` — so the pharmacy the shell
 * selects is the first one in this list.
 */
export async function listPlatformPharmacies(
  actor: PlatformActor,
): Promise<PlatformPharmacyRow[]> {
  requireSuperAdmin(actor);

  const rows = await systemPrisma.pharmacy.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      timeZone: true,
      defaultLocale: true,
      status: true,
      createdAt: true,
      memberships: { where: { active: true }, select: { role: true } },
      _count: { select: { patients: true } },
    },
  });

  return rows.map((row) => {
    const managers = row.memberships.filter((m) => m.role === "PHARMACY_ADMIN").length;
    const doctors = row.memberships.filter((m) => m.role === "PHARMACIST").length;

    return {
      id: row.id,
      name: row.name,
      timeZone: row.timeZone,
      defaultLocale: row.defaultLocale,
      status: row.status,
      createdAt: row.createdAt,
      managers,
      doctors,
      staff: row.memberships.length,
      patients: row._count.patients,
    };
  });
}

/** The pharmacies the shell switcher offers. */
export async function listSwitchablePharmacies(
  actor: PlatformActor,
): Promise<{ id: string; name: string }[]> {
  requireSuperAdmin(actor);

  return systemPrisma.pharmacy.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/** One pharmacy, its staff rows and its patient count. Null when it does not exist. */
export async function getPlatformPharmacy(
  actor: PlatformActor,
  pharmacyId: string,
): Promise<PlatformPharmacyDetail | null> {
  requireSuperAdmin(actor);

  const parsed = idSchema.safeParse(pharmacyId);
  if (!parsed.success) return null;

  const pharmacy = await systemPrisma.pharmacy.findUnique({
    where: { id: parsed.data },
    select: {
      id: true,
      name: true,
      timeZone: true,
      defaultLocale: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      status: true,
      createdAt: true,
    },
  });

  if (!pharmacy) return null;

  const [staff, patients] = await Promise.all([
    listPharmacyMemberships(pharmacy.id, actor.userId),
    prisma.patient.count({ where: { pharmacyId: pharmacy.id } }),
  ]);

  return { pharmacy, staff, patients };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a pharmacy and its first manager in one transaction.
 *
 * The manager is a `PHARMACY_ADMIN` — the product calls that person the
 * pharmacy manager, and the role keeps every pharmacy-scoped power. The global
 * identity is reused when the email already exists, exactly as the in-pharmacy
 * invite does; the membership is what makes them staff here.
 */
export async function createPharmacyWithManager(
  actor: PlatformActor,
  input: {
    name?: unknown;
    timeZone?: unknown;
    defaultLocale?: unknown;
    quietHoursStart?: unknown;
    quietHoursEnd?: unknown;
    managerFullName?: unknown;
    managerEmail?: unknown;
    managerPhoneE164?: unknown;
    managerPassword?: unknown;
  },
): Promise<PlatformResult<{ pharmacyId: string; name: string }>> {
  requireSuperAdmin(actor);

  const parsed = pharmacySchema.safeParse({
    name: input.name,
    timeZone: input.timeZone,
    defaultLocale: input.defaultLocale,
    quietHoursStart: input.quietHoursStart,
    quietHoursEnd: input.quietHoursEnd,
  });

  if (!parsed.success) {
    return { ok: false, code: "INVALID_INPUT", detail: PHARMACY_FIELD[firstIssue(parsed.error)] };
  }

  const invite = parseInviteInput({
    fullName: input.managerFullName,
    email: input.managerEmail,
    phoneE164: input.managerPhoneE164,
    initialPassword: input.managerPassword,
    role: "PHARMACY_ADMIN",
  });

  if (!invite.ok) {
    return {
      ok: false,
      code: invite.code,
      detail: MANAGER_FIELD[invite.detail ?? ""] ?? invite.detail,
    };
  }

  const passwordHash = invite.data.initialPassword
    ? await hashPassword(invite.data.initialPassword)
    : null;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const pharmacy = await tx.pharmacy.create({
        data: parsed.data,
        select: { id: true, name: true },
      });

      const member = await invitePharmacyMemberTx(
        tx,
        { pharmacyId: pharmacy.id, userId: actor.userId },
        invite.data,
        passwordHash,
      );

      if (!member.ok) throw new InviteRefused(member);

      await writeAudit(tx as unknown as AuditWriter, {
        pharmacyId: pharmacy.id,
        actorType: "USER",
        actorUserId: actor.userId,
        entityType: "Pharmacy",
        entityId: pharmacy.id,
        action: AUDIT_ACTION.PHARMACY_CREATED,
        after: {
          name: parsed.data.name,
          timeZone: parsed.data.timeZone,
          defaultLocale: parsed.data.defaultLocale,
        },
      });

      return pharmacy;
    });

    return { ok: true, code: "PHARMACY_CREATED", data: { pharmacyId: created.id, name: created.name } };
  } catch (error) {
    if (error instanceof InviteRefused) {
      return { ok: false, code: error.refusal.code, detail: error.refusal.detail };
    }
    throw error;
  }
}

/**
 * Add a manager or doctor to an existing pharmacy.
 *
 * This is the ONLY account-creation path for a pharmacy the owner did not just
 * create, and it is closed to everybody except the platform owner. Managers can
 * still change roles and end access on the users screen — those are not
 * creation.
 */
export async function createPharmacyAccount(
  actor: PlatformActor,
  input: {
    pharmacyId?: unknown;
    fullName?: unknown;
    email?: unknown;
    role?: unknown;
    phoneE164?: unknown;
    initialPassword?: unknown;
  },
): Promise<PlatformResult> {
  requireSuperAdmin(actor);

  const pharmacyId = idSchema.safeParse(input.pharmacyId);
  if (!pharmacyId.success) {
    return { ok: false, code: "INVALID_INPUT", detail: "pharmacyId" };
  }

  const role = assignableRoleSchema.safeParse(input.role);
  if (!role.success) {
    return { ok: false, code: "INVALID_INPUT", detail: "role" };
  }

  const pharmacy = await systemPrisma.pharmacy.findUnique({
    where: { id: pharmacyId.data },
    select: { id: true },
  });

  if (!pharmacy) return { ok: false, code: "NOT_FOUND" };

  const invite = parseInviteInput({
    fullName: input.fullName,
    email: input.email,
    phoneE164: input.phoneE164,
    initialPassword: input.initialPassword,
    role: role.data,
  });

  if (!invite.ok) return invite;

  const passwordHash = invite.data.initialPassword
    ? await hashPassword(invite.data.initialPassword)
    : null;

  const result = await prisma.$transaction((tx) =>
    invitePharmacyMemberTx(
      tx,
      { pharmacyId: pharmacy.id, userId: actor.userId },
      invite.data,
      passwordHash,
    ),
  );

  if (!result.ok) return result;

  return { ok: true, code: "ACCOUNT_CREATED", data: undefined };
}

/**
 * Point the current session at another pharmacy.
 *
 * The session row is updated by primary key AND owner id, so a stale session id
 * from anywhere cannot be repointed. The audit row is written into the pharmacy
 * being opened — that is the log whose readers need to know the platform owner
 * was there.
 */
export async function switchActivePharmacy(
  actor: PlatformActor,
  input: { pharmacyId?: unknown },
): Promise<PlatformResult<{ pharmacyId: string; name: string }>> {
  requireSuperAdmin(actor);

  const pharmacyId = idSchema.safeParse(input.pharmacyId);
  if (!pharmacyId.success) {
    return { ok: false, code: "INVALID_INPUT", detail: "pharmacyId" };
  }

  const pharmacy = await systemPrisma.pharmacy.findUnique({
    where: { id: pharmacyId.data },
    select: { id: true, name: true },
  });

  if (!pharmacy) return { ok: false, code: "NOT_FOUND" };

  const updated = await systemPrisma.$transaction(async (tx) => {
    const session = await tx.session.updateMany({
      where: {
        id: actor.sessionId,
        userId: actor.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { activePharmacyId: pharmacy.id },
    });

    if (session.count === 0) return false;

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: pharmacy.id,
      actorType: "USER",
      actorUserId: actor.userId,
      entityType: "Pharmacy",
      entityId: pharmacy.id,
      action: AUDIT_ACTION.PHARMACY_ACCESSED,
    });

    return true;
  });

  if (!updated) return { ok: false, code: "NOT_FOUND" };

  return {
    ok: true,
    code: "PHARMACY_OPENED",
    data: { pharmacyId: pharmacy.id, name: pharmacy.name },
  };
}
