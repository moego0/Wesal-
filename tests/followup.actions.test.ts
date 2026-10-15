import "dotenv/config";

import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The session cookie, held where the mocked `next/headers` can read it.
 *
 * `vi.hoisted` rather than a plain `let`: the factory below is hoisted above
 * every import in this file, so a variable declared normally would still be in
 * its temporal dead zone when the mock registers.
 */
const session = vi.hoisted(() => ({ token: null as string | null }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wasal_session" && session.token
        ? { name, value: session.token }
        : undefined,
  }),
}));

// `requireSessionUser` redirects through `next/navigation` when there is no
// session. Nothing here exercises that path, but a real redirect call outside a
// Next request would throw an unrelated error and hide what actually failed.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`unexpected redirect to ${url}`);
  },
}));

import { AUDIT_ACTION } from "@/server/audit";
import { createSession } from "@/server/auth/session";
import { systemPrisma } from "@/server/db";
import {
  changeCaseStatus,
  recordIntervention,
  type CaseActionState,
} from "@/server/followup/actions";

/**
 * The follow-up writes, asserted against a real database.
 *
 * A Server Action is a public endpoint: the form on the page is a courtesy, and
 * anything the browser can post can also be posted by hand with any `caseId` in
 * it. So these tests do not drive the form — they call the actions directly with
 * a `FormData` built here, which is exactly what an attacker would do.
 *
 * Three properties are asserted, each because there is a specific way to get it
 * wrong that no type checker can see:
 *
 *   1. An illegal status move is refused AND changes nothing. A closed case that
 *      reopens silently erases the recorded decision that it was finished.
 *   2. Recording an intervention writes EXACTLY ONE `AuditEvent`, in the same
 *      transaction, with no clinical free text in it. `AuditEvent` is append-only
 *      at the database level, so a duplicate row or a leaked note can never be
 *      corrected afterwards.
 *   3. A case in another pharmacy is indistinguishable from one that does not
 *      exist. `pharmacyId` on the session is the only thing standing between two
 *      tenants here, and the failure mode is silent: the write simply succeeds on
 *      someone else's patient.
 *
 * Requires a migrated database (`npm run db:migrate`), like the other tests that
 * talk to Postgres.
 */

const RUN = randomUUID().slice(0, 8);

const IDLE: CaseActionState = { kind: "idle" };

/** A pharmacist's free text, used to prove it does not reach the audit trail. */
const NOTE_TEXT = `Patient confirmed the morning dose ${RUN}`;

let pharmacyId: string;
let otherPharmacyId: string;
let patientId: string;
let foreignPatientId: string;
let openCaseId: string;
let closingCaseId: string;
let permissionCaseId: string;
let resolvedCaseId: string;
let foreignCaseId: string;
let pharmacistUserId: string;
let assistantUserId: string;
let pharmacistEmail: string;
let assistantEmail: string;
let pharmacistToken: string;
let assistantToken: string;

beforeAll(async () => {
  const [pharmacy, otherPharmacy] = await Promise.all([
    systemPrisma.pharmacy.create({ data: { name: `Follow-up actions A (${RUN})` } }),
    systemPrisma.pharmacy.create({ data: { name: `Follow-up actions B (${RUN})` } }),
  ]);
  pharmacyId = pharmacy.id;
  otherPharmacyId = otherPharmacy.id;

  pharmacistEmail = `followup-pharmacist-${RUN}@test.local`;
  assistantEmail = `followup-assistant-${RUN}@test.local`;

  const [pharmacist, assistant] = await Promise.all([
    systemPrisma.user.create({
      data: { email: pharmacistEmail, fullName: `Pharmacist ${RUN}`, locale: "AR_EG" },
    }),
    systemPrisma.user.create({
      data: { email: assistantEmail, fullName: `Assistant ${RUN}`, locale: "AR_EG" },
    }),
  ]);
  pharmacistUserId = pharmacist.id;
  assistantUserId = assistant.id;

  await Promise.all([
    systemPrisma.pharmacyMembership.create({
      data: { userId: pharmacistUserId, pharmacyId, role: "PHARMACIST", active: true },
    }),
    systemPrisma.pharmacyMembership.create({
      data: { userId: assistantUserId, pharmacyId, role: "ASSISTANT", active: true },
    }),
  ]);

  const [patient, foreignPatient] = await Promise.all([
    systemPrisma.patient.create({
      data: { pharmacyId, fullName: `Follow-up Patient ${RUN}`, phoneE164: "+201099910001" },
    }),
    systemPrisma.patient.create({
      data: {
        pharmacyId: otherPharmacyId,
        fullName: `Foreign Patient ${RUN}`,
        phoneE164: "+201099910002",
      },
    }),
  ]);
  patientId = patient.id;
  foreignPatientId = foreignPatient.id;

  const [openCase, closingCase, permissionCase, resolvedCase, foreignCase] =
    await Promise.all([
      systemPrisma.followUpCase.create({
        data: { pharmacyId, patientId, origin: "RULE_ALERT", priority: "HIGH", status: "OPEN" },
      }),
      systemPrisma.followUpCase.create({
        data: { pharmacyId, patientId, origin: "MANUAL", priority: "NORMAL", status: "OPEN" },
      }),
      systemPrisma.followUpCase.create({
        data: { pharmacyId, patientId, origin: "MANUAL", priority: "LOW", status: "OPEN" },
      }),
      // Already finished, with the closure recorded. Nothing here may change it.
      systemPrisma.followUpCase.create({
        data: {
          pharmacyId,
          patientId,
          origin: "MANUAL",
          priority: "NORMAL",
          status: "RESOLVED",
          resolvedAtUtc: new Date("2026-09-01T09:00:00.000Z"),
          resolutionCode: "RESOLVED",
          resolutionNotes: "Closed before these tests ran.",
        },
      }),
      systemPrisma.followUpCase.create({
        data: {
          pharmacyId: otherPharmacyId,
          patientId: foreignPatientId,
          origin: "RULE_ALERT",
          priority: "URGENT",
          status: "OPEN",
        },
      }),
    ]);

  openCaseId = openCase.id;
  closingCaseId = closingCase.id;
  permissionCaseId = permissionCase.id;
  resolvedCaseId = resolvedCase.id;
  foreignCaseId = foreignCase.id;

  pharmacistToken = (
    await createSession({ userId: pharmacistUserId, activePharmacyId: pharmacyId })
  ).token;
  assistantToken = (
    await createSession({ userId: assistantUserId, activePharmacyId: pharmacyId })
  ).token;

  session.token = pharmacistToken;
});

afterAll(async () => {
  // AuditEvent has no foreign key, so nothing cascades it away. The trigger is
  // switched off only to remove the rows this file created — see the helper
  // below for why the `finally` matters.
  await systemPrisma.pharmacy
    .deleteMany({ where: { id: { in: [pharmacyId, otherPharmacyId] } } })
    .catch(() => {});
  if (pharmacyId && otherPharmacyId) {
    await withAuditTriggerDisabled(() =>
      systemPrisma.auditEvent.deleteMany({
        where: { pharmacyId: { in: [pharmacyId, otherPharmacyId] } },
      }),
    ).catch(() => {});
  }
  await systemPrisma.user
    .deleteMany({ where: { email: { in: [pharmacistEmail, assistantEmail] } } })
    .catch(() => {});
  await systemPrisma.$disconnect();
});

/** A form submission, as the browser would build it. */
function fd(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

describe("recording an intervention", () => {
  it("writes exactly one audit event, in the same transaction, without the notes", async () => {
    const state = await recordIntervention(
      IDLE,
      fd({
        caseId: openCaseId,
        locale: "en",
        interventionType: "PHONE_CALL",
        outcome: "REACHED",
        notes: NOTE_TEXT,
        nextFollowUpDate: "2026-11-03",
      }),
    );

    expect(state.kind).toBe("ok");
    expect(state.kind === "ok" && state.status).toBe("OPEN");

    // The intervention itself, scoped to the pharmacy that recorded it.
    const interventions = await systemPrisma.pharmacistIntervention.findMany({
      where: { caseId: openCaseId },
    });
    expect(interventions).toHaveLength(1);
    expect(interventions[0].notes).toBe(NOTE_TEXT);
    expect(interventions[0].performedByUserId).toBe(pharmacistUserId);
    expect(interventions[0].pharmacyId).toBe(pharmacyId);
    expect(interventions[0].outcome).toBe("REACHED");

    /*
     * Exactly ONE row, and no other event on this case.
     *
     * The mistake this exists to catch: an action that audits outside the
     * transaction — a crash between the two writes leaves a recorded patient
     * contact with no trace at all — or one that writes the row twice, which
     * makes the trail claim the pharmacist called twice. `AuditEvent` cannot be
     * updated or deleted afterwards, so a wrong row here is permanent.
     */
    const audits = await systemPrisma.auditEvent.findMany({
      where: { entityType: "FollowUpCase", entityId: openCaseId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe(AUDIT_ACTION.INTERVENTION_RECORDED);
    expect(audits[0].pharmacyId).toBe(pharmacyId);
    expect(audits[0].actorType).toBe("USER");
    expect(audits[0].actorUserId).toBe(pharmacistUserId);

    /*
     * The note is clinical content. The audit trail outlives every retention
     * decision in the product and can never be corrected, so the free text must
     * live in `PharmacistIntervention` — which the pharmacy owns and can
     * eventually amend or purge — and not in `AuditEvent`.
     */
    expect(JSON.stringify(audits[0].after)).not.toContain(NOTE_TEXT);
    expect(JSON.stringify(audits[0].before)).not.toContain(NOTE_TEXT);
  });

  it("puts the next follow-up at the end of the chosen day in the pharmacy's timezone", async () => {
    const row = await systemPrisma.followUpCase.findUnique({
      where: { id: openCaseId },
    });

    /*
     * 23:59 local, not midnight.
     *
     * The mistake this catches: storing the date as midnight UTC. A case due
     * "on the 3rd" would then show as overdue for the whole of the 3rd — the day
     * the pharmacist was told to follow up on — and the queue would nag about a
     * deadline that has not passed.
     */
    expect(row?.dueByUtc).not.toBeNull();
    const due = DateTime.fromJSDate(row!.dueByUtc!, { zone: "Africa/Cairo" });
    expect(due.toISODate()).toBe("2026-11-03");
    expect(due.hour).toBe(23);
    expect(due.minute).toBe(59);

    // Recording a contact is the first action on the case, and it is stamped
    // once: a later intervention must not move it.
    expect(row?.firstActionAtUtc).not.toBeNull();
    expect(row?.status).toBe("OPEN");
  });
});

describe("closing a case by recording the intervention that settled it", () => {
  it("resolves the case, stamps the closure, and drops the next follow-up date", async () => {
    const state = await recordIntervention(
      IDLE,
      fd({
        caseId: closingCaseId,
        locale: "en",
        interventionType: "REFILL_SET",
        outcome: "PATIENT_CONFIRMED",
        notes: "Refill arranged for the 1st.",
        nextFollowUpDate: "2026-12-01",
        nextStatus: "RESOLVED",
      }),
    );

    expect(state.kind).toBe("ok");
    expect(state.kind === "ok" && state.status).toBe("RESOLVED");

    const row = await systemPrisma.followUpCase.findUnique({
      where: { id: closingCaseId },
    });
    expect(row?.status).toBe("RESOLVED");
    expect(row?.resolvedAtUtc).not.toBeNull();
    expect(row?.resolutionCode).toBe("RESOLVED");
    expect(row?.resolutionNotes).toBe("Refill arranged for the 1st.");

    // The mistake this catches: a closed case left holding a future due date.
    // Nothing more is owed on this case, and a due date would keep it looking
    // like outstanding work to any report that reads the column.
    expect(row?.dueByUtc).toBeNull();

    /*
     * One row, and it is named for the write that happened rather than for its
     * effect: every intervention POST is `INTERVENTION_RECORDED`, and the
     * closure it caused is in the payload and the reason. Naming the row
     * `CASE_RESOLVED` instead would hide the contact behind the outcome, and a
     * reader counting closures would be the only one who could find it.
     *
     * What matters for the trail is that the closure is IN the row: `after`
     * carries the status and the instant, and `reason` says why. A closure that
     * left no trace would be exactly the case the audit table exists to prevent.
     */
    const audits = await systemPrisma.auditEvent.findMany({
      where: { entityId: closingCaseId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe(AUDIT_ACTION.INTERVENTION_RECORDED);
    expect(audits[0].after).toMatchObject({ status: "RESOLVED" });
    expect(audits[0].reason).not.toBeNull();
    expect(JSON.stringify(audits[0].after)).toContain("resolvedAtUtc");
  });
});

describe("the status machine", () => {
  it("refuses to reopen a closed case, and writes nothing when it does", async () => {
    const before = await systemPrisma.followUpCase.findUnique({
      where: { id: resolvedCaseId },
    });

    const state = await changeCaseStatus(
      IDLE,
      fd({ caseId: resolvedCaseId, locale: "en", status: "OPEN" }),
    );

    /*
     * The mistake this catches: a status endpoint that trusts the dropdown. The
     * UI only offers legal targets, but the action is a public endpoint, and a
     * case that can be reopened by a hand-built POST quietly erases the record
     * that a pharmacist decided it was finished — which is the decision the
     * case history exists to preserve.
     */
    expect(state).toEqual({
      kind: "error",
      code: "ILLEGAL_TRANSITION",
      from: "RESOLVED",
      to: "OPEN",
    });

    const after = await systemPrisma.followUpCase.findUnique({
      where: { id: resolvedCaseId },
    });
    expect(after?.status).toBe("RESOLVED");
    expect(after?.resolvedAtUtc?.toISOString()).toBe(
      before?.resolvedAtUtc?.toISOString(),
    );

    // A refused move is not a partial one: no audit row either. An event saying
    // "status changed" next to a case whose status did not change is worse than
    // no event at all.
    expect(
      await systemPrisma.auditEvent.count({ where: { entityId: resolvedCaseId } }),
    ).toBe(0);
  });

  it("moves a live case and audits the move under the user who made it", async () => {
    const state = await changeCaseStatus(
      IDLE,
      fd({ caseId: permissionCaseId, locale: "en", status: "IN_PROGRESS" }),
    );

    expect(state.kind).toBe("ok");
    expect(state.kind === "ok" && state.status).toBe("IN_PROGRESS");

    const row = await systemPrisma.followUpCase.findUnique({
      where: { id: permissionCaseId },
    });
    expect(row?.status).toBe("IN_PROGRESS");
    expect(row?.firstActionAtUtc).not.toBeNull();

    const audits = await systemPrisma.auditEvent.findMany({
      where: { entityId: permissionCaseId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBe(pharmacistUserId);
    expect(audits[0].actorType).toBe("USER");
  });
});

describe("tenant scope", () => {
  it("cannot record an intervention on another pharmacy's case", async () => {
    const state = await recordIntervention(
      IDLE,
      fd({
        caseId: foreignCaseId,
        locale: "en",
        interventionType: "PHONE_CALL",
        outcome: "REACHED",
        notes: "Should never be written.",
      }),
    );

    /*
     * The mistake this catches: looking the case up by id alone. The write would
     * succeed against another pharmacy's patient, and nothing in the response
     * would look different — the pharmacist would see a saved intervention and
     * the other pharmacy's case would carry a contact that never happened.
     */
    expect(state).toEqual({ kind: "error", code: "NOT_FOUND", from: null, to: null });

    expect(
      await systemPrisma.pharmacistIntervention.count({ where: { caseId: foreignCaseId } }),
    ).toBe(0);

    const foreign = await systemPrisma.followUpCase.findUnique({
      where: { id: foreignCaseId },
    });
    expect(foreign?.status).toBe("OPEN");
    expect(foreign?.firstActionAtUtc).toBeNull();
    expect(await systemPrisma.auditEvent.count({ where: { entityId: foreignCaseId } })).toBe(
      0,
    );
  });

  it("answers a foreign case exactly as it answers one that does not exist", async () => {
    const form = (caseId: string) =>
      fd({
        caseId,
        locale: "en",
        interventionType: "PHONE_CALL",
        outcome: "REACHED",
      });

    const [foreign, missing] = await Promise.all([
      recordIntervention(IDLE, form(foreignCaseId)),
      recordIntervention(IDLE, form(`cus_does_not_exist_${RUN}`)),
    ]);

    // Byte-identical states. A distinguishable response would let a stranger
    // with a session map another pharmacy's case ids by probing.
    expect(foreign).toEqual(missing);
  });
});

describe("permissions", () => {
  it("refuses a user whose role has no followup:write", async () => {
    session.token = assistantToken;

    try {
      const state = await recordIntervention(
        IDLE,
        fd({
          caseId: permissionCaseId,
          locale: "en",
          interventionType: "PHONE_CALL",
          outcome: "REACHED",
          notes: "An assistant should not be able to write this.",
        }),
      );

      /*
       * The mistake this catches: relying on the page to hide the form. An
       * assistant can read the queue and the case; posting to the action by hand
       * must still be refused, because the rendering rule protects nothing.
       */
      expect(state).toEqual({ kind: "error", code: "FORBIDDEN", from: null, to: null });
      expect(
        await systemPrisma.pharmacistIntervention.count({
          where: { caseId: permissionCaseId },
        }),
      ).toBe(0);
    } finally {
      session.token = pharmacistToken;
    }
  });
});

/**
 * Run `fn` with the AuditEvent append-only trigger switched off.
 *
 * Needed only to CLEAN UP rows this file created — the trigger is a database
 * guarantee, not a suggestion. The `finally` matters: if the cleanup threw while
 * the trigger was off, the database would keep running without its append-only
 * guarantee and nothing would ever report it. Same helper as
 * `tests/hard-constraints.test.ts`, where each constraint is asserted directly.
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
