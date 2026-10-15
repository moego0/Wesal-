import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemPrisma } from "@/server/db";
import { listOpenCases, listPatients, type PatientListRow } from "@/server/queries/patients";

/**
 * The adherence denominator, asserted against a real database.
 *
 * `listPatients` decides which doses count toward a patient's adherence rate,
 * and that decision is the single most consequential number the product shows a
 * pharmacist. It is also the easiest thing in the codebase to get subtly wrong
 * in a way no type checker can see: every branch below is a valid Prisma query
 * that returns rows.
 *
 * Two rules are load-bearing and both are asserted directly:
 *
 *   1. A dose we never delivered is not the patient's failure. `EXPIRED` is our
 *      downtime, `CANCELLED`/`SUPERSEDED` are our own schedule edits. Counting
 *      them reports our outages as their non-adherence.
 *   2. A dose still waiting for an answer is not yet evidence of anything.
 *      Silence only becomes a miss once the response window has closed and the
 *      settlement sweep has stamped `settledAtUtc`.
 *
 * The fixtures here are built by hand rather than taken from `prisma/seed.ts`,
 * because the seed's numbers are a random walk: they would drift with any change
 * to the PRNG and the assertion would have to be loosened to survive. These rows
 * are constructed so the expected rate is exactly 2/4 and nothing about that is
 * incidental.
 */

const RUN = randomUUID().slice(0, 8);

let pharmacyId: string;
let otherPharmacyId: string;
let patientId: string;
let emptyPatientId: string;
let medicationId: string;
let scheduleId: string;

beforeAll(async () => {
  const [pharmacy, otherPharmacy] = await Promise.all([
    systemPrisma.pharmacy.create({ data: { name: `Queries A (${RUN})` } }),
    systemPrisma.pharmacy.create({ data: { name: `Queries B (${RUN})` } }),
  ]);
  pharmacyId = pharmacy.id;
  otherPharmacyId = otherPharmacy.id;

  const [patient, emptyPatient] = await Promise.all([
    systemPrisma.patient.create({
      data: {
        pharmacyId,
        fullName: `Query Patient Alpha ${RUN}`,
        phoneE164: "+201099900001",
      },
    }),
    // No doses at all. Exists to pin the null-vs-zero distinction.
    systemPrisma.patient.create({
      data: {
        pharmacyId,
        fullName: `Query Patient Beta ${RUN}`,
        phoneE164: "+201099900002",
      },
    }),
  ]);
  patientId = patient.id;
  emptyPatientId = emptyPatient.id;

  // A patient in a different pharmacy, to prove the tenant scope is real.
  await systemPrisma.patient.create({
    data: {
      pharmacyId: otherPharmacyId,
      fullName: `Query Patient Foreign ${RUN}`,
      phoneE164: "+201099900003",
    },
  });

  const medication = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId,
      patientId,
      medicationNameText: "Query Test Medicine",
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
  await systemPrisma.pharmacy
    .deleteMany({ where: { id: { in: [pharmacyId, otherPharmacyId] } } })
    .catch(() => {});
  await systemPrisma.$disconnect();
});

let doseSeq = 0;

/**
 * Build a dose inside the 30-day reporting window with an explicit delivery and
 * response state. `@@unique([scheduleId, doseAtUtc])` means each call needs its
 * own instant.
 */
async function makeDose(opts: {
  deliveryState: string;
  responseState: string;
  settled?: boolean;
  countedForAdherence?: boolean;
  ruleEligible?: boolean;
  patientId?: string;
}) {
  const doseAtUtc = new Date(Date.now() - (doseSeq += 1) * 3_600_000);

  return systemPrisma.reminderEvent.create({
    data: {
      pharmacyId,
      patientId: opts.patientId ?? patientId,
      medicationId,
      scheduleId,
      scheduleRevisionSnapshot: 1,
      doseAtUtc,
      doseLocalDate: new Date(doseAtUtc.toISOString().slice(0, 10) + "T00:00:00.000Z"),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(doseAtUtc.getTime() + 4 * 3_600_000),
      deliveryState: opts.deliveryState as never,
      responseState: opts.responseState as never,
      settledAtUtc: opts.settled ? new Date(doseAtUtc.getTime() + 4 * 3_600_000) : null,
      countedForAdherence: opts.countedForAdherence ?? true,
      ruleEligible: opts.ruleEligible ?? true,
    },
  });
}

/** Find one patient in a list result, failing loudly rather than yielding undefined. */
function findRow(rows: PatientListRow[], id: string): PatientListRow {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`patient ${id} missing from list`);
  return row;
}

describe("the adherence denominator counts only doses the patient could answer", () => {
  beforeAll(async () => {
    // 2 scored as taken — the numerator.
    await makeDose({ deliveryState: "DELIVERED", responseState: "TAKEN" });
    await makeDose({ deliveryState: "READ", responseState: "TAKEN_LATE" });

    // 2 scored against — one answered, one settled by silence.
    await makeDose({ deliveryState: "DELIVERED", responseState: "MISSED" });
    await makeDose({ deliveryState: "DELIVERED", responseState: "NONE", settled: true });

    // Everything below must be EXCLUDED.
    // Still in flight: unanswered, window not yet closed.
    await makeDose({ deliveryState: "DELIVERED", responseState: "NONE" });
    // Never delivered — our downtime, not their failure.
    await makeDose({ deliveryState: "EXPIRED", responseState: "NONE", settled: true });
    await makeDose({ deliveryState: "FAILED", responseState: "NONE", settled: true });
    // Our own schedule edits.
    await makeDose({ deliveryState: "CANCELLED", responseState: "NONE", settled: true });
    await makeDose({ deliveryState: "SUPERSEDED", responseState: "NONE", settled: true });
    // A snooze child is a reminder, not a dose; the parent carries the score.
    await makeDose({
      deliveryState: "DELIVERED",
      responseState: "TAKEN",
      countedForAdherence: false,
    });
    // Stale: recorded for history, excluded from the fact book.
    await makeDose({
      deliveryState: "DELIVERED",
      responseState: "TAKEN",
      ruleEligible: false,
    });
  });

  it("reports exactly the four scorable doses, and nothing else", async () => {
    const { rows } = await listPatients(pharmacyId, { search: `Alpha ${RUN}` });
    const row = findRow(rows, patientId);

    expect(row.scorableDoses).toBe(4);
    expect(row.adherence).toBe(0.5);
  });

  it("excludes the in-flight dose rather than counting it as a miss", async () => {
    // Guarding the specific mistake: an unanswered dose that has NOT settled is
    // still pending, so making the denominator 5 would report a miss the patient
    // has not yet had the chance to avoid.
    const { rows } = await listPatients(pharmacyId, { search: `Alpha ${RUN}` });
    const row = findRow(rows, patientId);

    expect(row.adherence).not.toBe(2 / 5);
    expect(row.adherence).not.toBe(2 / 6);
  });
});

describe("no scorable doses is not the same as zero adherence", () => {
  it("returns null rather than 0 for a patient who has not been scored", async () => {
    const { rows } = await listPatients(pharmacyId, { search: `Beta ${RUN}` });
    const row = findRow(rows, emptyPatientId);

    // The distinction that matters clinically: 0% says "this patient ignores
    // every reminder", null says "we have no evidence yet". A patient enrolled
    // this morning has not missed anything.
    expect(row.adherence).toBeNull();
    expect(row.scorableDoses).toBe(0);
  });
});

describe("the list is scoped to one pharmacy", () => {
  it("never returns another pharmacy's patients", async () => {
    const [scoped, unscoped] = await Promise.all([
      listPatients(pharmacyId, { limit: 200 }),
      listPatients(otherPharmacyId, { limit: 200 }),
    ]);

    const scopedIds = new Set(scoped.rows.map((r) => r.id));
    expect(scopedIds.has(patientId)).toBe(true);
    expect(scoped.rows.some((r) => r.fullName.includes(`Foreign ${RUN}`))).toBe(false);

    // And the isolation holds in the other direction.
    expect(unscoped.rows.some((r) => r.id === patientId)).toBe(false);
    expect(unscoped.rows.some((r) => r.fullName.includes(`Foreign ${RUN}`))).toBe(true);
  });

  it("counts only this pharmacy's patients in the total", async () => {
    const { total } = await listPatients(pharmacyId, { limit: 200 });
    expect(total).toBe(2);
  });
});

describe("search", () => {
  it("matches a partial name", async () => {
    const { rows } = await listPatients(pharmacyId, { search: "Alpha" });
    expect(rows.map((r) => r.id)).toContain(patientId);
  });

  it("matches a partial phone number", async () => {
    // Staff search the way the number is written on the card in front of them,
    // so a suffix search has to work — not just a full E.164 match.
    const { rows } = await listPatients(pharmacyId, { search: "9900001" });
    expect(rows.map((r) => r.id)).toEqual([patientId]);
  });

  it("treats whitespace as no filter rather than as a query matching nothing", async () => {
    const { total } = await listPatients(pharmacyId, { search: "   ", limit: 200 });
    expect(total).toBe(2);
  });

  it("returns nothing for a query that matches nothing", async () => {
    const { rows, total } = await listPatients(pharmacyId, { search: "no-such-patient-xyz" });
    expect(rows).toEqual([]);
    expect(total).toBe(0);
  });
});

describe("status filter", () => {
  it("filters to the requested status", async () => {
    const active = await listPatients(pharmacyId, { status: "ACTIVE", limit: 200 });
    expect(active.total).toBe(2);

    const archived = await listPatients(pharmacyId, { status: "ARCHIVED", limit: 200 });
    expect(archived.total).toBe(0);
    expect(archived.rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("counts the list shows beside each patient", () => {
  beforeAll(async () => {
    await systemPrisma.followUpCase.create({
      data: {
        pharmacyId,
        patientId,
        origin: "RULE_ALERT",
        priority: "URGENT",
        status: "OPEN",
      },
    });

    await systemPrisma.followUpCase.create({
      data: { pharmacyId, patientId, origin: "MANUAL", priority: "LOW", status: "RESOLVED" },
    });

    await systemPrisma.alert.create({
      data: {
        pharmacyId,
        patientId,
        ruleKey: "QUERY_TEST",
        ruleVersion: 1,
        dedupeKey: `QUERY_TEST|${patientId}|open-${RUN}`,
        severity: "HIGH",
        titleAr: "اختبار",
        titleEn: "Test",
        detailAr: "تفاصيل",
        detailEn: "Detail",
        evidence: {},
        status: "OPEN",
      },
    });

    await systemPrisma.alert.create({
      data: {
        pharmacyId,
        patientId,
        ruleKey: "QUERY_TEST",
        ruleVersion: 1,
        dedupeKey: `QUERY_TEST|${patientId}|ack-${RUN}`,
        severity: "NORMAL",
        titleAr: "اختبار",
        titleEn: "Test",
        detailAr: "تفاصيل",
        detailEn: "Detail",
        evidence: {},
        status: "ACKNOWLEDGED",
      },
    });

    // Must not be counted: a resolved alert is history, not an open problem.
    // Its dedupeKey differs, so the partial unique index permits the insert.
    await systemPrisma.alert.create({
      data: {
        pharmacyId,
        patientId,
        ruleKey: "QUERY_TEST",
        ruleVersion: 1,
        dedupeKey: `QUERY_TEST|${patientId}|resolved-${RUN}`,
        severity: "URGENT",
        titleAr: "اختبار",
        titleEn: "Test",
        detailAr: "تفاصيل",
        detailEn: "Detail",
        evidence: {},
        status: "RESOLVED_MANUAL",
      },
    });
  });

  it("counts open cases but not resolved ones", async () => {
    const { rows } = await listPatients(pharmacyId, { search: `Alpha ${RUN}` });
    expect(findRow(rows, patientId).openCaseCount).toBe(1);
  });

  it("counts open and acknowledged alerts but not resolved ones", async () => {
    const { rows } = await listPatients(pharmacyId, { search: `Alpha ${RUN}` });
    // 2 of the 3 alerts, despite the resolved one being the most severe. Severity
    // does not make a closed alert open again.
    expect(findRow(rows, patientId).openAlertCount).toBe(2);
  });
});

describe("the follow-up queue is ordered as a triage list", () => {
  it("puts urgent cases first, then the oldest within a severity", async () => {
    const cases = await listOpenCases(pharmacyId, 100);

    expect(cases.length).toBeGreaterThan(0);

    // Only live cases belong in a queue the pharmacist works down.
    expect(cases.every((c) => c.status !== "RESOLVED" && c.status !== "CLOSED_NO_ACTION")).toBe(
      true,
    );

    const rank = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 } as const;
    const priorities = cases.map((c) => rank[c.priority]);

    // Non-increasing priority, i.e. the list never steps back up to something
    // less severe. Asserted as a property rather than an exact sequence so the
    // seeded data can change without weakening the test.
    for (let i = 1; i < priorities.length; i += 1) {
      expect(priorities[i]).toBeLessThanOrEqual(priorities[i - 1]);

      if (priorities[i] === priorities[i - 1]) {
        expect(cases[i].openedAtUtc.getTime()).toBeGreaterThanOrEqual(
          cases[i - 1].openedAtUtc.getTime(),
        );
      }
    }
  });
});
