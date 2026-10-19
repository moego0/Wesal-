import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PharmacyRole, type UserStatus } from "@/generated/prisma/enums";
import { PermissionDeniedError, hasPermission, permissionsFor, requirePermission } from "@/server/auth/rbac";
import {
  applyMembershipActive,
  applyMembershipRole,
  applyPharmacyProfile,
  applyRuleParams,
  countActiveAdmins,
  invitePharmacyMember,
  listPharmacyMemberships,
  type AdminActor,
} from "@/server/queries/admin";
import { systemPrisma } from "@/server/db";

/**
 * The administration screens' server-side guarantees, against the real database.
 *
 * Everything here is a rule the SCREEN does not enforce. A disabled `<select>`,
 * a hidden nav item and a greyed-out button are all one hand-written POST away
 * from being irrelevant, so each assertion below goes at the function the
 * action layer actually calls, with fixtures built by hand so the expected
 * outcome is exact rather than "whatever the seed produced".
 *
 * The mutation cores live in `@/server/queries/admin` rather than in the
 * `"use server"` files that call them, which is what makes this test possible
 * without a browser: `actor` is an explicit argument (trusted input — see the
 * header comment on the mutation section), so a test can present any actor it
 * likes and the guards must hold anyway.
 */

const RUN = randomUUID().slice(0, 8);

const userIds: string[] = [];
const pharmacyIds: string[] = [];

async function makePharmacy(label: string) {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Admin Test ${label} (${RUN})`, timeZone: "Africa/Cairo" },
  });
  pharmacyIds.push(pharmacy.id);
  return pharmacy;
}

async function makeUser(label: string, status: UserStatus = "ACTIVE") {
  const user = await systemPrisma.user.create({
    data: {
      email: `admin-${label}-${RUN}@wasal.test`,
      fullName: `Admin Test ${label} (${RUN})`,
      status,
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeMembership(
  userId: string,
  pharmacyId: string,
  role: PharmacyRole,
  active = true,
) {
  return systemPrisma.pharmacyMembership.create({
    data: { userId, pharmacyId, role, active },
  });
}

/** A fresh colleague in `pharmacyId`, created by this test and removed after. */
async function addMember(
  pharmacyId: string,
  role: PharmacyRole,
  label: string,
  active = true,
) {
  const user = await makeUser(label);
  const membership = await makeMembership(user.id, pharmacyId, role, active);
  return { user, membership };
}

/** The rows these helpers return, so the module-level fixtures stay typed. */
type TestPharmacy = Awaited<ReturnType<typeof makePharmacy>>;
type TestUser = Awaited<ReturnType<typeof makeUser>>;

const auditCount = (pharmacyId: string) =>
  systemPrisma.auditEvent.count({ where: { pharmacyId } });

/** The newest event for a pharmacy — `id` is monotonic, so it is the last write. */
const latestAudit = (pharmacyId: string) =>
  systemPrisma.auditEvent.findFirst({
    where: { pharmacyId },
    orderBy: { id: "desc" },
    select: {
      action: true,
      entityType: true,
      entityId: true,
      actorUserId: true,
      before: true,
      after: true,
    },
  });

let pharmacyA: TestPharmacy;
let pharmacyB: TestPharmacy;
let pharmacyC: TestPharmacy;

let adminA: TestUser;
let secondAdminA: TestUser;
let assistantA: TestUser;
let adminB: TestUser;
let soloAdminC: TestUser;
/** No membership anywhere. Used as an actor to reach the last-admin guard. */
let outsider: TestUser;

/** The actor the settings and users screens would pass, for pharmacy A. */
let actorA: AdminActor;

beforeAll(async () => {
  [pharmacyA, pharmacyB, pharmacyC] = await Promise.all([
    makePharmacy("A"),
    makePharmacy("B"),
    makePharmacy("C"),
  ]);

  const users = await Promise.all([
    makeUser("a-admin"),
    makeUser("a-second"),
    makeUser("a-assistant"),
    makeUser("b-admin"),
    makeUser("c-solo"),
    makeUser("outsider"),
  ]);
  [adminA, secondAdminA, assistantA, adminB, soloAdminC, outsider] = users;

  await Promise.all([
    makeMembership(adminA.id, pharmacyA.id, "PHARMACY_ADMIN"),
    makeMembership(secondAdminA.id, pharmacyA.id, "PHARMACY_ADMIN"),
    makeMembership(assistantA.id, pharmacyA.id, "ASSISTANT"),
    makeMembership(adminB.id, pharmacyB.id, "PHARMACY_ADMIN"),
    // Pharmacy C's ONLY active administrator.
    makeMembership(soloAdminC.id, pharmacyC.id, "PHARMACY_ADMIN"),
  ]);

  actorA = { pharmacyId: pharmacyA.id, userId: adminA.id };
});

afterAll(async () => {
  // AuditEvent has no foreign key to Pharmacy and is append-only, so it is
  // cleared separately and the trigger has to come off to do it.
  if (pharmacyIds.length > 0) {
    await withAuditTriggerDisabled(() =>
      systemPrisma.auditEvent.deleteMany({ where: { pharmacyId: { in: pharmacyIds } } }),
    );
  }
  if (userIds.length > 0) {
    await systemPrisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (pharmacyIds.length > 0) {
    await systemPrisma.pharmacy.deleteMany({ where: { id: { in: pharmacyIds } } });
  }
  await systemPrisma.$disconnect();
});

/**
 * Run `fn` with the AuditEvent append-only trigger switched off.
 *
 * Needed only to CLEAN UP rows this test created. The `finally` matters: if it
 * threw while the trigger was off, the database would keep running without its
 * append-only guarantee and nothing would ever report it.
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

describe("reading the audit log is an administrator's power", () => {
  it("refuses `audit:read` to an ASSISTANT", async () => {
    /*
     * Catches: treating the audit log as "just another read screen". An
     * assistant sees every patient in the pharmacy; the log says which of their
     * colleagues changed what, and which patient records were opened when. The
     * role is read back out of the membership row rather than typed here, so
     * this fails if the stored value stops granting what the screen assumes.
     */
    const membership = await systemPrisma.pharmacyMembership.findFirstOrThrow({
      where: { userId: assistantA.id, pharmacyId: pharmacyA.id },
      select: { role: true },
    });

    expect(membership.role).toBe("ASSISTANT");
    expect(hasPermission(membership, "audit:read")).toBe(false);
    expect(hasPermission({ role: "ASSISTANT" }, "audit:read")).toBe(false);

    // The screen's gate, not an imitation of it: this is the same call the
    // audit page makes before it queries anything.
    expect(() => requirePermission({ role: "ASSISTANT" }, "audit:read")).toThrow(
      PermissionDeniedError,
    );
  });

  it("grants `audit:read` to exactly one role, and keeps the other admin powers apart", () => {
    /*
     * Catches: a role quietly gaining the log — most likely VIEWER, which reads
     * like "the read-only role" and is the reason `VIEWER_EXCLUDED` exists. It
     * iterates the enum rather than a literal list, so a fifth role fails this
     * test until someone decides its audit access on purpose.
     */
    const readers = Object.values(PharmacyRole).filter((role) =>
      hasPermission({ role }, "audit:read"),
    );
    expect(readers).toEqual(["PHARMACY_ADMIN"]);

    const messageReaders = Object.values(PharmacyRole).filter((role) =>
      hasPermission({ role }, "message:read"),
    );
    expect(messageReaders).toEqual(["PHARMACY_ADMIN"]);

    // A PHARMACIST runs the clinical side. Catches: a pharmacist retuning the
    // alert thresholds that judge their own follow-up work, editing staff, or
    // reading message delivery logs.
    expect(permissionsFor("PHARMACIST").has("settings:manage")).toBe(false);
    expect(permissionsFor("PHARMACIST").has("user:manage")).toBe(false);
    expect(permissionsFor("PHARMACIST").has("message:read")).toBe(false);
    expect(permissionsFor("PHARMACIST").has("followup:write")).toBe(true);

    // The exact ASSISTANT set. Catches: a permission added to ASSISTANT by
    // accident while widening something else.
    expect([...permissionsFor("ASSISTANT")].sort()).toEqual(
      [
        "followup:read",
        "medication:read",
        "patient:consent",
        "patient:read",
        "patient:write",
        "schedule:read",
      ].sort(),
    );
  });
});

describe("nobody can remove their own access", () => {
  it("refuses a self-demotion, and writes nothing at all", async () => {
    /*
     * Catches: an admin demoting themselves into a role that cannot undo it.
     * The check cannot be "unless they are the last admin": a pharmacy with two
     * admins would still let one of them lock themselves out. The row and the
     * audit count are asserted unchanged, because a refusal that still writes
     * something is a refusal the log disagrees with.
     */
    const own = await systemPrisma.pharmacyMembership.findFirstOrThrow({
      where: { userId: adminA.id, pharmacyId: pharmacyA.id },
    });
    const before = await auditCount(pharmacyA.id);

    const result = await applyMembershipRole(actorA, {
      membershipId: own.id,
      role: "VIEWER",
    });

    expect(result).toEqual({ ok: false, code: "SELF_ROLE" });

    const after = await systemPrisma.pharmacyMembership.findUniqueOrThrow({
      where: { id: own.id },
      select: { role: true },
    });
    expect(after.role).toBe("PHARMACY_ADMIN");
    expect(await auditCount(pharmacyA.id)).toBe(before);
  });

  it("refuses a self-deactivation, and leaves the membership active", async () => {
    /*
     * Catches: the same trap one step further along — the account that could
     * reactivate the membership is the account that just lost it.
     */
    const own = await systemPrisma.pharmacyMembership.findFirstOrThrow({
      where: { userId: adminA.id, pharmacyId: pharmacyA.id },
    });
    const before = await auditCount(pharmacyA.id);

    const result = await applyMembershipActive(actorA, {
      membershipId: own.id,
      active: false,
    });

    expect(result).toEqual({ ok: false, code: "SELF_DEACTIVATE" });

    const after = await systemPrisma.pharmacyMembership.findUniqueOrThrow({
      where: { id: own.id },
      select: { active: true },
    });
    expect(after.active).toBe(true);
    expect(await auditCount(pharmacyA.id)).toBe(before);
  });
});

describe("a pharmacy always keeps one active administrator", () => {
  it("refuses to demote the last active PHARMACY_ADMIN", async () => {
    /*
     * Catches: a read-then-write check that two concurrent demotions both pass.
     * The guard runs inside the transaction holding a lock on the pharmacy row,
     * and no database constraint could replace it — `PharmacyMembership` cannot
     * express "at least one active admin".
     *
     * The actor here has no membership in this pharmacy. That is deliberate:
     * the core takes `actor` as trusted input (the action layer has already run
     * `requirePermission`), so the invariant has to hold on the TARGET rather
     * than on the caller's credentials — which is what makes this second line of
     * defence worth having when a call path changes.
     */
    const target = await systemPrisma.pharmacyMembership.findFirstOrThrow({
      where: { userId: soloAdminC.id, pharmacyId: pharmacyC.id },
    });
    const before = await auditCount(pharmacyC.id);

    const result = await applyMembershipRole(
      { pharmacyId: pharmacyC.id, userId: outsider.id },
      { membershipId: target.id, role: "PHARMACIST" },
    );

    expect(result).toEqual({ ok: false, code: "LAST_ADMIN" });

    const after = await systemPrisma.pharmacyMembership.findUniqueOrThrow({
      where: { id: target.id },
      select: { role: true, active: true },
    });
    expect(after.role).toBe("PHARMACY_ADMIN");
    expect(after.active).toBe(true);
    expect(await countActiveAdmins(pharmacyC.id)).toBe(1);
    expect(await auditCount(pharmacyC.id)).toBe(before);
  });

  it("refuses to deactivate the last active PHARMACY_ADMIN", async () => {
    /*
     * Catches: fixing demotion and forgetting deactivation, which reaches the
     * same end state by a different route — a pharmacy whose only administrator
     * can no longer sign in.
     */
    const target = await systemPrisma.pharmacyMembership.findFirstOrThrow({
      where: { userId: soloAdminC.id, pharmacyId: pharmacyC.id },
    });

    const result = await applyMembershipActive(
      { pharmacyId: pharmacyC.id, userId: outsider.id },
      { membershipId: target.id, active: false },
    );

    expect(result).toEqual({ ok: false, code: "LAST_ADMIN" });

    const after = await systemPrisma.pharmacyMembership.findUniqueOrThrow({
      where: { id: target.id },
      select: { active: true },
    });
    expect(after.active).toBe(true);
    expect(await countActiveAdmins(pharmacyC.id)).toBe(1);
  });

  it("allows the demotion once a second administrator exists", async () => {
    /*
     * Catches: a last-admin guard so eager it refuses everything — which would
     * look identical from the outside (a button that never works) while making
     * the two tests above pass for the wrong reason.
     */
    const { membership } = await addMember(pharmacyA.id, "PHARMACY_ADMIN", "a-spare");

    expect(await countActiveAdmins(pharmacyA.id)).toBe(3);

    const result = await applyMembershipRole(actorA, {
      membershipId: membership.id,
      role: "PHARMACIST",
    });

    expect(result.ok).toBe(true);
    expect(await countActiveAdmins(pharmacyA.id)).toBe(2);

    const after = await systemPrisma.pharmacyMembership.findUniqueOrThrow({
      where: { id: membership.id },
      select: { role: true },
    });
    expect(after.role).toBe("PHARMACIST");
  });

  it("counts only active administrators of the pharmacy it was asked about", async () => {
    /*
     * Catches: a count without a tenant scope, which would make the guard
     * depend on another pharmacy's staff. Pharmacy B's admin and the inactive
     * membership must not appear in pharmacy C's count.
     */
    const { membership } = await addMember(pharmacyC.id, "PHARMACY_ADMIN", "c-off", false);

    expect(await countActiveAdmins(pharmacyC.id)).toBe(1);
    expect(membership.active).toBe(false);
    expect(await countActiveAdmins(pharmacyB.id)).toBe(1);
  });
});

describe("one pharmacy cannot touch another's staff", () => {
  it("reports a membership in another pharmacy as not found, and does not change it", async () => {
    /*
     * Catches: `findUnique({ where: { id } })` instead of a `pharmacyId`-scoped
     * `findFirst`. Any admin could then demote or deactivate a colleague at a
     * competing pharmacy by guessing a cuid — and would get a success message.
     */
    const target = await systemPrisma.pharmacyMembership.findFirstOrThrow({
      where: { userId: adminB.id, pharmacyId: pharmacyB.id },
    });
    const auditsA = await auditCount(pharmacyA.id);
    const auditsB = await auditCount(pharmacyB.id);

    const demote = await applyMembershipRole(actorA, {
      membershipId: target.id,
      role: "VIEWER",
    });
    const deactivate = await applyMembershipActive(actorA, {
      membershipId: target.id,
      active: false,
    });

    expect(demote).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(deactivate).toEqual({ ok: false, code: "NOT_FOUND" });

    const after = await systemPrisma.pharmacyMembership.findUniqueOrThrow({
      where: { id: target.id },
      select: { role: true, active: true, pharmacyId: true },
    });
    expect(after.role).toBe("PHARMACY_ADMIN");
    expect(after.active).toBe(true);

    // Nothing in either pharmacy's log: a refused cross-tenant write must not
    // leave a trail that reads like an attempt against the wrong tenant.
    expect(await auditCount(pharmacyA.id)).toBe(auditsA);
    expect(await auditCount(pharmacyB.id)).toBe(auditsB);
  });
});

describe("every mutation writes exactly one audit event", () => {
  it("logs a pharmacy profile change once, with the before and after it replaced", async () => {
    /*
     * Catches: auditing outside the transaction (a crash between the two leaves
     * a change with no record), logging twice, and writing an audit row whose
     * `before` is actually the value after the update — the log would then
     * describe a change that never happened.
     */
    const before = await auditCount(pharmacyA.id);
    const original = await systemPrisma.pharmacy.findUniqueOrThrow({
      where: { id: pharmacyA.id },
      select: { name: true },
    });

    const result = await applyPharmacyProfile(actorA, {
      name: `Renamed Pharmacy A (${RUN})`,
      timeZone: "Africa/Cairo",
      defaultLocale: "AR_EG",
      quietHoursStart: "21:00",
      quietHoursEnd: "07:30",
      reason: "closing time moved",
    });

    expect(result).toEqual({ ok: true, code: "PROFILE_SAVED", data: undefined });
    expect(await auditCount(pharmacyA.id)).toBe(before + 1);

    const row = await latestAudit(pharmacyA.id);
    expect(row?.action).toBe("PHARMACY_UPDATED");
    expect(row?.entityType).toBe("Pharmacy");
    expect(row?.entityId).toBe(pharmacyA.id);
    expect(row?.actorUserId).toBe(adminA.id);
    expect(row?.before).toMatchObject({ name: original.name });
    expect(row?.after).toMatchObject({ name: `Renamed Pharmacy A (${RUN})` });

    const stored = await systemPrisma.pharmacy.findUniqueOrThrow({
      where: { id: pharmacyA.id },
      select: { name: true, quietHoursStart: true },
    });
    expect(stored.name).toBe(`Renamed Pharmacy A (${RUN})`);
    expect(stored.quietHoursStart).toBe("21:00");
  });

  it("logs a rule threshold change once, as a new version rather than an edit", async () => {
    /*
     * Catches: updating the `RuleDefinition` row in place. An alert raised in
     * March records `ruleVersion`; retuning the threshold in April would erase
     * what the engine was actually configured to do when that alert fired.
     */
    const before = await auditCount(pharmacyA.id);

    const result = await applyRuleParams(actorA, {
      ruleKey: "CONSECUTIVE_MISSES",
      params: { threshold: 5, lookbackDoses: 21 },
    });

    expect(result.ok).toBe(true);
    expect(await auditCount(pharmacyA.id)).toBe(before + 1);

    const row = await latestAudit(pharmacyA.id);
    expect(row?.action).toBe("RULE_CHANGED");
    expect(row?.entityType).toBe("RuleDefinition");
    expect(row?.actorUserId).toBe(adminA.id);

    const definitions = await systemPrisma.ruleDefinition.findMany({
      where: { pharmacyId: pharmacyA.id, ruleKey: "CONSECUTIVE_MISSES" },
      orderBy: { version: "desc" },
      select: { id: true, version: true, params: true, enabled: true },
    });
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.id).toBe(row?.entityId);
    expect(definitions[0]!.params).toMatchObject({ threshold: 5, lookbackDoses: 21 });
    // Written as enabled, always: `loadRulesFor` filters `enabled: true` in the
    // same query that picks the pharmacy's row, so a disabled override is not
    // "off" — it is invisible, and the system default silently takes over.
    expect(definitions[0]!.enabled).toBe(true);
  });

  it("refuses an out-of-range threshold without writing anything", async () => {
    /*
     * Catches: validating in the form only. `threshold: 900` would make the
     * rule fire for every patient on every sweep, and a client is free to post
     * that straight past the `max` on the number input.
     */
    const audits = await auditCount(pharmacyA.id);
    const definitions = await systemPrisma.ruleDefinition.count({
      where: { pharmacyId: pharmacyA.id },
    });

    const result = await applyRuleParams(actorA, {
      ruleKey: "CONSECUTIVE_MISSES",
      params: { threshold: 900, lookbackDoses: 21 },
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT", detail: "threshold" });
    expect(await auditCount(pharmacyA.id)).toBe(audits);
    expect(
      await systemPrisma.ruleDefinition.count({ where: { pharmacyId: pharmacyA.id } }),
    ).toBe(definitions);
  });

  it("logs an invitation once, and creates the person and the membership with it", async () => {
    /*
     * Catches: an invite that creates the `User` and then fails to create the
     * membership (leaving an account nobody can act on), and an invite that
     * writes two audit rows for what the reader thinks of as one action.
     */
    const before = await auditCount(pharmacyA.id);

    const result = await invitePharmacyMember(actorA, {
      email: `invited-${RUN}@wasal.test`,
      fullName: `Invited Colleague (${RUN})`,
      role: "PHARMACIST",
    });

    expect(result.ok).toBe(true);
    expect(await auditCount(pharmacyA.id)).toBe(before + 1);

    const row = await latestAudit(pharmacyA.id);
    expect(row?.action).toBe("USER_INVITED");
    expect(row?.entityType).toBe("PharmacyMembership");

    const created = await systemPrisma.user.findUniqueOrThrow({
      where: { email: `invited-${RUN}@wasal.test` },
      select: { id: true, status: true, passwordHash: true },
    });
    userIds.push(created.id);

    // No password was supplied, so the account cannot sign in at all. Anything
    // else would be a password nobody knows.
    expect(created.status).toBe("INVITED");
    expect(created.passwordHash).toBeNull();

    const membership = await systemPrisma.pharmacyMembership.findFirstOrThrow({
      where: { userId: created.id, pharmacyId: pharmacyA.id },
      select: { id: true, role: true, active: true },
    });
    expect(membership.id).toBe(row?.entityId);
    expect(membership.role).toBe("PHARMACIST");
    expect(membership.active).toBe(true);
  });

  it("refuses to invite somebody who is already a member, writing nothing", async () => {
    /*
     * Catches: a duplicate invite that either creates a second membership for
     * one person (the unique index would reject it as a 500) or, worse, creates
     * a second `User` for one human.
     */
    const before = await auditCount(pharmacyA.id);

    const result = await invitePharmacyMember(actorA, {
      email: assistantA.email,
      fullName: "Duplicate",
      role: "ASSISTANT",
    });

    expect(result).toEqual({ ok: false, code: "EMAIL_TAKEN" });
    expect(await auditCount(pharmacyA.id)).toBe(before);
  });

  it("logs a role change once, and logs nothing for a no-op", async () => {
    /*
     * Catches: padding the log with "nothing happened" entries, which is how an
     * audit trail becomes something nobody reads. The no-op is submitted
     * through the same function as the change, so the only difference is the
     * value — exactly as a re-submitted form produces it.
     */
    const { membership } = await addMember(pharmacyA.id, "VIEWER", "a-viewer");

    const before = await auditCount(pharmacyA.id);

    const noop = await applyMembershipRole(actorA, {
      membershipId: membership.id,
      role: "VIEWER",
    });
    expect(noop).toEqual({ ok: true, code: "NO_CHANGE", data: undefined });
    expect(await auditCount(pharmacyA.id)).toBe(before);

    const changed = await applyMembershipRole(actorA, {
      membershipId: membership.id,
      role: "ASSISTANT",
      reason: "front desk",
    });
    expect(changed).toEqual({ ok: true, code: "ROLE_CHANGED", data: undefined });
    expect(await auditCount(pharmacyA.id)).toBe(before + 1);

    const row = await latestAudit(pharmacyA.id);
    expect(row?.action).toBe("USER_ROLE_CHANGED");
    expect(row?.entityId).toBe(membership.id);
    expect(row?.before).toMatchObject({ userId: membership.userId, role: "VIEWER" });
    expect(row?.after).toMatchObject({ userId: membership.userId, role: "ASSISTANT" });
  });

  it("logs a deactivation and a reactivation once each, and never touches the global account", async () => {
    /*
     * Catches: suspending `User.status` instead of the membership. `User` is a
     * global identity — the same person may be on staff at a second pharmacy,
     * and suspending the account here would sign them out there.
     */
    const { user, membership } = await addMember(pharmacyA.id, "ASSISTANT", "a-leaver");

    const before = await auditCount(pharmacyA.id);

    const off = await applyMembershipActive(actorA, {
      membershipId: membership.id,
      active: "false",
      reason: "left the pharmacy",
    });
    expect(off).toEqual({ ok: true, code: "MEMBER_DEACTIVATED", data: undefined });
    expect(await auditCount(pharmacyA.id)).toBe(before + 1);

    const offRow = await latestAudit(pharmacyA.id);
    expect(offRow?.action).toBe("USER_SUSPENDED");
    expect(offRow?.entityId).toBe(membership.id);

    const on = await applyMembershipActive(actorA, {
      membershipId: membership.id,
      active: true,
    });
    expect(on).toEqual({ ok: true, code: "MEMBER_ACTIVATED", data: undefined });
    expect(await auditCount(pharmacyA.id)).toBe(before + 2);
    expect((await latestAudit(pharmacyA.id))?.action).toBe("USER_REACTIVATED");

    // The membership is the tail we suspend — this account is still usable
    // anywhere else it belongs.
    expect(
      await systemPrisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { status: true },
      }),
    ).toEqual({ status: "ACTIVE" });
  });
});

describe("the members list the screen renders", () => {
  it("scopes to the pharmacy, and marks the caller's own row", async () => {
    /*
     * Catches: a members list that leaks another pharmacy's staff — visible to
     * an admin as "our users", with a role select next to each one — and an
     * `isSelf` flag computed from anything other than the session's user id,
     * which is what decides whether the row is editable.
     */
    const rows = await listPharmacyMemberships(pharmacyA.id, adminA.id);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.membershipId.length > 0)).toBe(true);
    expect(rows.some((row) => row.userId === adminB.id)).toBe(false);

    const self = rows.find((row) => row.userId === adminA.id);
    expect(self?.isSelf).toBe(true);
    expect(self?.role).toBe("PHARMACY_ADMIN");

    expect(rows.filter((row) => row.isSelf)).toHaveLength(1);

    // Pharmacy B sees its own admin, and does not see pharmacy A's.
    const otherRows = await listPharmacyMemberships(pharmacyB.id, adminB.id);
    expect(otherRows.map((row) => row.userId)).toEqual([adminB.id]);
  });
});
