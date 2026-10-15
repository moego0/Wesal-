import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemPrisma } from "@/server/db";
import { hashPassword } from "@/server/auth/password";

/**
 * The hard constraints, asserted against a real database.
 *
 * These live in `20261014060000_hard_constraints` as indexes, CHECKs and a
 * trigger, because Prisma's schema DSL cannot express any of them — which also
 * means Prisma does not know they exist. A later `prisma migrate dev` can decide
 * an unrecognised partial index is drift and drop it, and nothing in the
 * TypeScript would notice.
 *
 * So every test here asserts the GUARANTEE, not the object's existence. Checking
 * that an index is named `alert_one_open_per_key` proves nothing about whether
 * it still prevents a second open alert; inserting one and watching the second
 * fail does.
 *
 * Requires the database to be migrated (`npm run db:migrate`).
 */

const RUN = randomUUID().slice(0, 8);

let pharmacyId: string;
let patientId: string;
let medicationId: string;
let scheduleId: string;

beforeAll(async () => {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Hard constraints (${RUN})` },
  });
  pharmacyId = pharmacy.id;

  const patient = await systemPrisma.patient.create({
    data: {
      pharmacyId,
      fullName: `Constraint Patient (${RUN})`,
      phoneE164: "+201000000000",
    },
  });
  patientId = patient.id;

  const medication = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId,
      patientId,
      medicationNameText: "Constraint Test Medicine",
      startedOn: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  medicationId = medication.id;

  const schedule = await systemPrisma.medicationSchedule.create({
    data: {
      pharmacyId,
      patientId,
      medicationId,
      mode: "FIXED_TIMES_OF_DAY",
      timesOfDay: ["08:00"],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timeZone: "Africa/Cairo",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  scheduleId = schedule.id;
});

afterAll(async () => {
  // ReminderEvent, MedicationSchedule, MedicationRecord and Patient all cascade
  // from Pharmacy. AuditEvent has no FK and is append-only, so it is cleared
  // separately — see that test for why the trigger has to come off first.
  await systemPrisma.pharmacy.delete({ where: { id: pharmacyId } }).catch(() => {});
  await withAuditTriggerDisabled(() =>
    systemPrisma.auditEvent.deleteMany({ where: { pharmacyId } }),
  );
  await systemPrisma.$disconnect();
});

/**
 * Build a valid ReminderEvent, then apply only the field under test.
 *
 * Each call takes a fresh dose slot. `@@unique([scheduleId, doseAtUtc])` is
 * itself one of the constraints under test, so reusing one instant would make
 * every row after the first collide for a reason none of these tests are about.
 */
let doseSeq = 0;

async function makeEvent(overrides: Record<string, unknown> = {}) {
  const doseAtUtc = new Date(
    Date.UTC(2026, 5, 1, 6, 0, 0) + (doseSeq += 1) * 3600_000,
  );

  return systemPrisma.reminderEvent.create({
    data: {
      pharmacyId,
      patientId,
      medicationId,
      scheduleId,
      scheduleRevisionSnapshot: 1,
      doseAtUtc,
      doseLocalDate: new Date(doseAtUtc.toISOString().slice(0, 10) + "T00:00:00.000Z"),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(doseAtUtc.getTime() + 4 * 3600_000),
      ...overrides,
    },
  });
}

async function makeAlert(
  dedupeKey: string,
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED_MANUAL" | "RESOLVED_AUTO" | "SUPPRESSED",
) {
  return systemPrisma.alert.create({
    data: {
      pharmacyId,
      patientId,
      ruleKey: "TEST_RULE",
      ruleVersion: 1,
      dedupeKey,
      status,
      severity: "NORMAL",
      titleAr: "عنوان",
      titleEn: "Title",
      detailAr: "تفصيل",
      detailEn: "Detail",
      evidence: { reason: "test" },
    },
  });
}

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

describe("at most one open alert per dedupe key", () => {
  it("rejects a second OPEN alert with the same key", async () => {
    const key = `TEST_RULE|${patientId}|${RUN}`;
    const first = await makeAlert(key, "OPEN");

    await expect(makeAlert(key, "OPEN")).rejects.toThrow();

    // The first one must still be there and untouched — a failed insert must not
    // have damaged the row that legitimately holds the key.
    const survivor = await systemPrisma.alert.findUnique({ where: { id: first.id } });
    expect(survivor?.status).toBe("OPEN");
  });

  it("rejects an ACKNOWLEDGED alert while an OPEN one holds the key", async () => {
    // Acknowledged is inside the index predicate precisely because a pharmacist
    // saying "I have seen this" does not make the problem go away.
    const key = `TEST_RULE|ack|${RUN}`;
    await makeAlert(key, "OPEN");
    await expect(makeAlert(key, "ACKNOWLEDGED")).rejects.toThrow();
  });

  it("allows a new alert once the previous one is resolved", async () => {
    // Outside the predicate on purpose: a resolved condition frees the key, which
    // is what lets a recurring problem reopen instead of being permanently
    // suppressed by its own history.
    const key = `TEST_RULE|resolved|${RUN}`;
    await makeAlert(key, "RESOLVED_MANUAL");

    const reopened = await makeAlert(key, "OPEN");
    expect(reopened.status).toBe("OPEN");
    expect(reopened.dedupeKey).toBe(key);
  });

  it("allows several alerts for different keys", async () => {
    const a = await makeAlert(`TEST_RULE|a|${RUN}`, "OPEN");
    const b = await makeAlert(`TEST_RULE|b|${RUN}`, "OPEN");
    expect(a.id).not.toBe(b.id);
  });

  it("lets two concurrent inserts race and produces exactly one winner", async () => {
    // The whole reason this is an index rather than a check-then-insert: a
    // rolling redeploy overlapping a cron tick runs two evaluators at once, both
    // read "no open alert", and both insert. A pharmacist then sees the same
    // patient three times and stops trusting the queue.
    const key = `TEST_RULE|race|${RUN}`;

    const results = await Promise.allSettled([
      makeAlert(key, "OPEN"),
      makeAlert(key, "OPEN"),
      makeAlert(key, "OPEN"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);

    const open = await systemPrisma.alert.count({
      where: { dedupeKey: key, status: "OPEN" },
    });
    expect(open).toBe(1);
  });
});

describe("a patient-reported response is never verified", () => {
  it("rejects isVerified=true on a PATIENT_REPORTED row", async () => {
    await expect(
      systemPrisma.patientResponse.create({
        data: {
          pharmacyId,
          patientId,
          channel: "WHATSAPP_BUTTON",
          answer: "TAKEN",
          source: "PATIENT_REPORTED",
          isVerified: true,
          receivedAtUtc: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts the same row with isVerified=false", async () => {
    const row = await systemPrisma.patientResponse.create({
      data: {
        pharmacyId,
        patientId,
        channel: "WHATSAPP_BUTTON",
        answer: "TAKEN",
        source: "PATIENT_REPORTED",
        isVerified: false,
        verificationState: "UNVERIFIED",
        receivedAtUtc: new Date(),
      },
    });
    expect(row.isVerified).toBe(false);
  });
});

describe("AuditEvent is append-only", () => {
  it("accepts an insert, refuses an update, and refuses a delete", async () => {
    const row = await systemPrisma.auditEvent.create({
      data: {
        pharmacyId,
        actorType: "SYSTEM",
        entityType: "Test",
        entityId: RUN,
        action: "CREATED",
      },
    });

    await expect(
      systemPrisma.auditEvent.update({
        where: { id: row.id },
        data: { action: "TAMPERED" },
      }),
    ).rejects.toThrow();

    await expect(
      systemPrisma.auditEvent.delete({ where: { id: row.id } }),
    ).rejects.toThrow();

    // Still intact and unmodified. This is the assertion that matters: an audit
    // log that merely logs its refusals but still applies the write would be
    // worse than none at all, because it would be trusted.
    const survivor = await systemPrisma.auditEvent.findUnique({ where: { id: row.id } });
    expect(survivor?.action).toBe("CREATED");
  });

  it("is enforced regardless of role, which REVOKE could not achieve", async () => {
    // The comment in the migration claims a trigger was chosen over
    // `REVOKE UPDATE, DELETE` because the app connects as the table owner and
    // cannot revoke from itself. This asserts the practical consequence: a raw
    // statement, bypassing Prisma's model layer entirely, is still refused.
    await expect(
      systemPrisma.$executeRawUnsafe(
        `UPDATE "AuditEvent" SET "action" = 'TAMPERED' WHERE "entityId" = $1`,
        RUN,
      ),
    ).rejects.toThrow();
  });
});

describe("scheduling counters cannot go negative", () => {
  it("rejects a negative attemptCount", async () => {
    // A negative attemptCount makes the retry guard (`attempt < 2`) silently
    // permit unlimited retries — a slow-motion way to spam a patient.
    await expect(makeEvent({ attemptCount: -1 })).rejects.toThrow();
  });

  it("rejects a negative snoozeCount", async () => {
    await expect(makeEvent({ snoozeCount: -1 })).rejects.toThrow();
  });

  it("rejects scheduleRevisionSnapshot of 0", async () => {
    await expect(makeEvent({ scheduleRevisionSnapshot: 0 })).rejects.toThrow();
  });

  it("accepts zero counters", async () => {
    const event = await makeEvent({ attemptCount: 0, snoozeCount: 0 });
    expect(event.attemptCount).toBe(0);
  });
});

describe("a response window must end after its dose", () => {
  it("rejects a window that closes before the dose opens", async () => {
    // A window that closes first settles every reminder as NO_RESPONSE the
    // instant it is created, which would report a whole panel of patients as
    // non-adherent overnight.
    await expect(
      makeEvent({
        doseAtUtc: new Date("2026-06-02T06:00:00.000Z"),
        responseWindowEndsAtUtc: new Date("2026-06-02T05:00:00.000Z"),
      }),
    ).rejects.toThrow();
  });

  it("rejects a window ending exactly at the dose", async () => {
    const same = new Date("2026-06-03T06:00:00.000Z");
    await expect(
      makeEvent({ doseAtUtc: same, responseWindowEndsAtUtc: same }),
    ).rejects.toThrow();
  });
});

describe("doseLocalTime must be a real wall-clock time", () => {
  it.each(["8:00", "24:00", "08:60", "0800", "", "08:00:00"])(
    "rejects %j",
    async (bad) => {
      await expect(makeEvent({ doseLocalTime: bad })).rejects.toThrow();
    },
  );

  it.each(["00:00", "08:00", "23:59"])("accepts %j", async (good) => {
    const event = await makeEvent({ doseLocalTime: good });
    expect(event.doseLocalTime).toBe(good);
  });
});

describe("a snooze is not a dose", () => {
  it("rejects a SNOOZE event that counts for adherence", async () => {
    // The dose is the scoring unit. A snooze child that counted would make a
    // patient who snoozed twice in one evening look like they had three doses —
    // and a patient who snoozed instead of taking it would look MORE adherent.
    await expect(
      makeEvent({ kind: "SNOOZE", countedForAdherence: true }),
    ).rejects.toThrow();
  });

  it("accepts a SNOOZE event that does not count", async () => {
    const event = await makeEvent({ kind: "SNOOZE", countedForAdherence: false });
    expect(event.kind).toBe("SNOOZE");
    expect(event.countedForAdherence).toBe(false);
  });

  it("accepts an ordinary dose that counts", async () => {
    const event = await makeEvent({ kind: "SCHEDULED_DOSE", countedForAdherence: true });
    expect(event.countedForAdherence).toBe(true);
  });
});

describe("the partial index is a partial index, not a plain unique constraint", () => {
  it("is defined with the OPEN/ACKNOWLEDGED predicate", async () => {
    // Belt and braces on top of the behavioural tests above: a plain UNIQUE
    // index would pass most of them while permanently forbidding a resolved
    // condition from ever reopening. In that case the third test in the first
    // block would fail — this one names the cause directly.
    const rows = await systemPrisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'alert_one_open_per_key'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("UNIQUE");
    expect(rows[0].indexdef).toContain("WHERE");
    expect(rows[0].indexdef).toContain("OPEN");
    expect(rows[0].indexdef).toContain("ACKNOWLEDGED");
  });

  it("keeps the AuditEvent trigger enabled after this suite finishes", async () => {
    // Guards the one genuinely dangerous thing this file does: temporarily
    // disabling an immutability trigger for cleanup. If a `finally` were ever
    // dropped, this is what would catch it.
    const rows = await systemPrisma.$queryRawUnsafe<{ tgenabled: string }[]>(
      `SELECT t.tgenabled::text AS tgenabled FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'AuditEvent' AND t.tgname = 'audit_event_no_update_delete'`,
    );

    expect(rows).toHaveLength(1);
    // 'O' = enabled for origin (normal). 'D' would mean disabled — a database
    // quietly running without its append-only guarantee.
    expect(rows[0].tgenabled).toBe("O");
  });
});

// A user is created here purely to prove the CHECK is not secretly coupled to
// having one — the constraint is about the response, not about who witnessed it.
describe("verification is a property of the response, not the actor", () => {
  it("still refuses a verified patient report when a user is attached", async () => {
    const user = await systemPrisma.user.create({
      data: {
        email: `constraint-${RUN}@wasal.test`,
        fullName: "Constraint Tester",
        passwordHash: await hashPassword("ConstraintTest!2026"),
      },
    });

    await expect(
      systemPrisma.patientResponse.create({
        data: {
          pharmacyId,
          patientId,
          channel: "WHATSAPP_BUTTON",
          answer: "TAKEN",
          source: "PATIENT_REPORTED",
          isVerified: true,
          verifiedByUserId: user.id,
          receivedAtUtc: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});
