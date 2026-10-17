import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "@/server/auth/session";
import { SuperAdminRequiredError } from "@/server/auth/rbac";
import { systemPrisma } from "@/server/db";
import {
  createPharmacyAccount,
  createPharmacyWithManager,
  getPlatformPharmacy,
  listPlatformPharmacies,
  listSwitchablePharmacies,
  switchActivePharmacy,
  type PlatformActor,
} from "@/server/platform/admin";

/**
 * The platform console's data layer, against the real database.
 *
 * Two guarantees are asserted here, and both are the kind a screen cannot
 * provide:
 *
 *   1. **Only the platform owner may call any of it.** `requireSuperAdmin` runs
 *      before parsing and before any query, so an actor without the flag gets a
 *      thrown error rather than a partial result. This is exercised through
 *      every export because a future one that forgets the gate should fail this
 *      suite rather than production.
 *   2. **The writes are complete or absent.** A pharmacy is created together
 *      with its manager and its audit row; a switch repoints only the calling
 *      session and records itself in the pharmacy being opened.
 *
 * Fixtures use a per-run suffix, and `afterAll` clears the audit rows with the
 * append-only trigger briefly off — the same cleanup shape the other database
 * tests use.
 */

const RUN = randomUUID().slice(0, 8);
const MANAGER_PASSWORD = "test-password-123";

const userIds: string[] = [];
const pharmacyIds: string[] = [];
const sessionIds: string[] = [];

async function makeUser(label: string, isSuperAdmin = false) {
  const user = await systemPrisma.user.create({
    data: {
      email: `platform-${label}-${RUN}@wasal.test`,
      fullName: `Platform Test ${label} (${RUN})`,
      status: "ACTIVE",
      isSuperAdmin,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makePharmacy(label: string) {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Platform Test ${label} (${RUN})`, timeZone: "Africa/Cairo" },
  });
  pharmacyIds.push(pharmacy.id);
  return pharmacy;
}

let owner: Awaited<ReturnType<typeof makeUser>>;
let notOwner: Awaited<ReturnType<typeof makeUser>>;
let ownerActor: PlatformActor;
let outsiderActor: PlatformActor;

beforeAll(async () => {
  [owner, notOwner] = await Promise.all([makeUser("owner", true), makeUser("other")]);

  const ownerSession = await createSession({ userId: owner.id, activePharmacyId: null });
  sessionIds.push(ownerSession.sessionId);

  ownerActor = { userId: owner.id, sessionId: ownerSession.sessionId, isSuperAdmin: true };

  // A PHARMACY_ADMIN in every respect except the flag. Every export must still
  // refuse them: the platform powers are not a permission, so no role reaches
  // them.
  outsiderActor = { userId: notOwner.id, sessionId: "not-a-session", isSuperAdmin: false };
});

afterAll(async () => {
  if (pharmacyIds.length > 0) {
    await withAuditTriggerDisabled(() =>
      systemPrisma.auditEvent.deleteMany({ where: { pharmacyId: { in: pharmacyIds } } }),
    );
  }
  if (sessionIds.length > 0) {
    await systemPrisma.session.deleteMany({ where: { id: { in: sessionIds } } });
  }
  // Users created by the platform itself (managers and doctors) are found by the
  // run suffix rather than tracked individually.
  await systemPrisma.user.deleteMany({ where: { email: { contains: RUN } } });
  if (pharmacyIds.length > 0) {
    await systemPrisma.pharmacy.deleteMany({ where: { id: { in: pharmacyIds } } });
  }
  await systemPrisma.$disconnect();
});

/**
 * Run `fn` with the AuditEvent append-only trigger switched off.
 *
 * Cleanup only. The `finally` matters: a throw while the trigger was off would
 * leave the database running without its append-only guarantee.
 */
async function withAuditTriggerDisabled<T>(fn: () => Promise<T>): Promise<T> {
  await systemPrisma.$executeRawUnsafe(
    `ALTER TABLE "AuditEvent" DISABLE TRIGGER "audit_event_no_update_delete"`,
  );
  try {
    return await fn();
  } finally {
    await systemPrisma.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" ENABLE TRIGGER "audit_event_no_update_delete"`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe("only the platform owner reaches the console", () => {
  it("refuses every export to an account without the flag", async () => {
    /*
     * Catches: a caller that forgets the gate, and any future export that copies
     * the module's shape without copying `requireSuperAdmin`. Asserted on all
     * five entry points because that is the surface, not one function.
     */
    await expect(listPlatformPharmacies(outsiderActor)).rejects.toThrow(
      SuperAdminRequiredError,
    );
    await expect(listSwitchablePharmacies(outsiderActor)).rejects.toThrow(
      SuperAdminRequiredError,
    );
    await expect(getPlatformPharmacy(outsiderActor, "any-id")).rejects.toThrow(
      SuperAdminRequiredError,
    );
    await expect(
      createPharmacyWithManager(outsiderActor, {
        name: "Should not exist",
        managerFullName: "Nobody",
        managerEmail: `refused-${RUN}@wasal.test`,
        managerPassword: MANAGER_PASSWORD,
      }),
    ).rejects.toThrow(SuperAdminRequiredError);
    await expect(
      createPharmacyAccount(outsiderActor, {
        pharmacyId: "any-id",
        fullName: "Nobody",
        email: `refused-account-${RUN}@wasal.test`,
        role: "PHARMACIST",
      }),
    ).rejects.toThrow(SuperAdminRequiredError);
    await expect(
      switchActivePharmacy(outsiderActor, { pharmacyId: "any-id" }),
    ).rejects.toThrow(SuperAdminRequiredError);

    expect(
      await systemPrisma.user.count({ where: { email: { contains: `refused` } } }),
    ).toBe(0);
  });
});

describe("creating a pharmacy and its first manager", () => {
  it("writes the pharmacy, the manager membership and both audit rows together", async () => {
    /*
     * Catches: a pharmacy created without its manager (unreachable, because
     * nobody can create accounts for it except the owner, and the manager is how
     * the pharmacy becomes operable), and a manager created as INVITED despite a
     * password being supplied.
     */
    const result = await createPharmacyWithManager(ownerActor, {
      name: `Created Pharmacy (${RUN})`,
      timeZone: "Africa/Cairo",
      defaultLocale: "AR_EG",
      quietHoursStart: "21:30",
      quietHoursEnd: "07:00",
      managerFullName: `First Manager (${RUN})`,
      managerEmail: `first-manager-${RUN}@wasal.test`,
      managerPhoneE164: "+201000000000",
      managerPassword: MANAGER_PASSWORD,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.code).toBe("PHARMACY_CREATED");
    pharmacyIds.push(result.data.pharmacyId);

    const pharmacy = await systemPrisma.pharmacy.findUniqueOrThrow({
      where: { id: result.data.pharmacyId },
      select: {
        name: true,
        timeZone: true,
        defaultLocale: true,
        quietHoursStart: true,
        quietHoursEnd: true,
      },
    });
    expect(pharmacy).toEqual({
      name: `Created Pharmacy (${RUN})`,
      timeZone: "Africa/Cairo",
      defaultLocale: "AR_EG",
      quietHoursStart: "21:30",
      quietHoursEnd: "07:00",
    });

    const manager = await systemPrisma.user.findUniqueOrThrow({
      where: { email: `first-manager-${RUN}@wasal.test` },
      select: { id: true, status: true, passwordHash: true },
    });
    // The password was supplied, so the account is live rather than INVITED.
    expect(manager.status).toBe("ACTIVE");
    expect(manager.passwordHash).not.toBeNull();

    const membership = await systemPrisma.pharmacyMembership.findFirstOrThrow({
      where: { userId: manager.id, pharmacyId: result.data.pharmacyId },
      select: { role: true, active: true },
    });
    expect(membership).toEqual({ role: "PHARMACY_ADMIN", active: true });

    const created = await systemPrisma.auditEvent.findFirst({
      where: { pharmacyId: result.data.pharmacyId, action: "PHARMACY_CREATED" },
      select: { actorUserId: true, entityType: true, entityId: true },
    });
    expect(created).toEqual({
      actorUserId: owner.id,
      entityType: "Pharmacy",
      entityId: result.data.pharmacyId,
    });
  });

  it("refuses an unusable manager field and leaves no pharmacy behind", async () => {
    /*
     * Catches: creating the pharmacy first and validating the manager after —
     * which the transaction prevents, but only if the refusal is returned rather
     * than thrown past it.
     */
    const result = await createPharmacyWithManager(ownerActor, {
      name: `Half-built Pharmacy (${RUN})`,
      managerFullName: `Bad Email (${RUN})`,
      managerEmail: "not-an-email",
      managerPassword: MANAGER_PASSWORD,
    });

    expect(result).toEqual({
      ok: false,
      code: "INVALID_INPUT",
      detail: "managerEmail",
    });

    expect(
      await systemPrisma.pharmacy.count({
        where: { name: `Half-built Pharmacy (${RUN})` },
      }),
    ).toBe(0);
  });
});

describe("creating accounts in an existing pharmacy", () => {
  it("adds a doctor, and refuses every role that is not manager or doctor", async () => {
    /*
     * Catches: the platform console inheriting the general role schema, which
     * would let the owner mint an ASSISTANT or VIEWER through a hand-written
     * POST. The schema is the only thing standing there — the form lists two.
     */
    const pharmacy = await makePharmacy("accounts");

    const created = await createPharmacyAccount(ownerActor, {
      pharmacyId: pharmacy.id,
      fullName: `Doctor Account (${RUN})`,
      email: `doctor-${RUN}@wasal.test`,
      role: "PHARMACIST",
      initialPassword: MANAGER_PASSWORD,
    });

    expect(created.ok).toBe(true);
    if (created.ok) expect(created.code).toBe("ACCOUNT_CREATED");

    const membership = await systemPrisma.pharmacyMembership.findFirstOrThrow({
      where: { pharmacyId: pharmacy.id, user: { email: `doctor-${RUN}@wasal.test` } },
      select: { role: true, active: true },
    });
    expect(membership).toEqual({ role: "PHARMACIST", active: true });

    const refused = await createPharmacyAccount(ownerActor, {
      pharmacyId: pharmacy.id,
      fullName: `Assistant Account (${RUN})`,
      email: `assistant-${RUN}@wasal.test`,
      role: "ASSISTANT",
    });

    expect(refused).toEqual({ ok: false, code: "INVALID_INPUT", detail: "role" });
    expect(
      await systemPrisma.user.count({ where: { email: `assistant-${RUN}@wasal.test` } }),
    ).toBe(0);
  });

  it("reports an unknown pharmacy rather than creating an orphan account", async () => {
    const result = await createPharmacyAccount(ownerActor, {
      pharmacyId: `missing-${RUN}`,
      fullName: `Orphan (${RUN})`,
      email: `orphan-${RUN}@wasal.test`,
      role: "PHARMACIST",
    });

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(
      await systemPrisma.user.count({ where: { email: `orphan-${RUN}@wasal.test` } }),
    ).toBe(0);
  });
});

describe("opening a pharmacy", () => {
  it("repoints only the calling session, and records it in the target pharmacy", async () => {
    /*
     * Catches: switching by mutating the user or every session they hold (the
     * owner may have the console open in two places, and one tab should not move
     * the other), and a switch that leaves no trace in the pharmacy whose data
     * the owner just opened.
     */
    const first = await makePharmacy("switch-first");
    const second = await makePharmacy("switch-second");

    const calling = await createSession({
      userId: owner.id,
      activePharmacyId: first.id,
    });
    sessionIds.push(calling.sessionId);

    const other = await createSession({
      userId: owner.id,
      activePharmacyId: first.id,
    });
    sessionIds.push(other.sessionId);

    const result = await switchActivePharmacy(
      { userId: owner.id, sessionId: calling.sessionId, isSuperAdmin: true },
      { pharmacyId: second.id },
    );

    expect(result).toEqual({
      ok: true,
      code: "PHARMACY_OPENED",
      data: { pharmacyId: second.id, name: second.name },
    });

    const [callingRow, otherRow] = await Promise.all([
      systemPrisma.session.findUniqueOrThrow({
        where: { id: calling.sessionId },
        select: { activePharmacyId: true },
      }),
      systemPrisma.session.findUniqueOrThrow({
        where: { id: other.sessionId },
        select: { activePharmacyId: true },
      }),
    ]);
    expect(callingRow.activePharmacyId).toBe(second.id);
    expect(otherRow.activePharmacyId).toBe(first.id);

    const access = await systemPrisma.auditEvent.findFirst({
      where: { pharmacyId: second.id, action: "PHARMACY_ACCESSED" },
      select: { actorUserId: true, entityId: true },
    });
    expect(access).toEqual({ actorUserId: owner.id, entityId: second.id });
  });

  it("refuses a session that no longer exists", async () => {
    /*
     * Catches: an update by primary key alone. A revoked or expired session must
     * not be repointed by a stale id.
     */
    const pharmacy = await makePharmacy("switch-stale");

    const result = await switchActivePharmacy(
      { userId: owner.id, sessionId: `stale-${RUN}`, isSuperAdmin: true },
      { pharmacyId: pharmacy.id },
    );

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});

describe("what the console lists", () => {
  it("reports each pharmacy's managers, doctors, staff and patients", async () => {
    /*
     * Catches: counting INACTIVE memberships, and a patient count that is not
     * scoped to the pharmacy the row describes.
     */
    const pharmacy = await makePharmacy("counts");

    const manager = await createPharmacyAccount(ownerActor, {
      pharmacyId: pharmacy.id,
      fullName: `Count Manager (${RUN})`,
      email: `count-manager-${RUN}@wasal.test`,
      role: "PHARMACY_ADMIN",
    });
    expect(manager.ok).toBe(true);

    const doctor = await createPharmacyAccount(ownerActor, {
      pharmacyId: pharmacy.id,
      fullName: `Count Doctor (${RUN})`,
      email: `count-doctor-${RUN}@wasal.test`,
      role: "PHARMACIST",
    });
    expect(doctor.ok).toBe(true);

    // An inactive membership must not be counted.
    const leaver = await systemPrisma.user.create({
      data: {
        email: `count-leaver-${RUN}@wasal.test`,
        fullName: `Count Leaver (${RUN})`,
        status: "ACTIVE",
      },
    });
    await systemPrisma.pharmacyMembership.create({
      data: { userId: leaver.id, pharmacyId: pharmacy.id, role: "PHARMACIST", active: false },
    });

    await systemPrisma.patient.createMany({
      data: [
        {
          pharmacyId: pharmacy.id,
          fullName: `Count Patient 1 (${RUN})`,
          phoneE164: "+201000000000",
        },
        {
          pharmacyId: pharmacy.id,
          fullName: `Count Patient 2 (${RUN})`,
          phoneE164: "+201000000001",
        },
      ],
    });

    const rows = await listPlatformPharmacies(ownerActor);
    const row = rows.find((candidate) => candidate.id === pharmacy.id);

    expect(row).toMatchObject({
      name: pharmacy.name,
      managers: 1,
      doctors: 1,
      staff: 2,
      patients: 2,
    });

    const detail = await getPlatformPharmacy(ownerActor, pharmacy.id);
    expect(detail?.patients).toBe(2);
    // The deactivated colleague is listed too — the users screen includes them
    // so an accidental deactivation can be undone — but the summary counts above
    // ignore them.
    expect(detail?.staff.map((member) => member.role).sort()).toEqual([
      "PHARMACIST",
      "PHARMACIST",
      "PHARMACY_ADMIN",
    ]);
    expect(detail?.staff.some((member) => member.userId === leaver.id && !member.active)).toBe(
      true,
    );

    // Every pharmacy, regardless of status, is offered by the shell switcher —
    // the selected value must always match an option.
    const switchable = await listSwitchablePharmacies(ownerActor);
    expect(switchable.some((option) => option.id === pharmacy.id)).toBe(true);
  });

  it("returns null for a pharmacy that does not exist", async () => {
    await expect(
      getPlatformPharmacy(ownerActor, `does-not-exist-${RUN}`),
    ).resolves.toBeNull();
  });
});
