import "dotenv/config";

import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemPrisma } from "@/server/db";
import { getDashboardSummary } from "@/server/queries/dashboard";

/**
 * The dashboard's arithmetic.
 *
 * Two claims on this panel are load-bearing and neither is visible from reading
 * the query:
 *
 *   "TODAY" IS THE PHARMACY'S DAY. The evening shift is the one that reads this
 *   screen, and it is exactly the shift whose doses sit on the far side of a UTC
 *   day boundary. Computing the boundary from the server clock moves the 23:30
 *   dose into tomorrow for everyone looking at the panel after 21:00 UTC.
 *
 *   "DELIVERED, NO REPLY" AND "EXPIRED BEFORE SENDING" ARE OPPOSITES. One is
 *   the patient's silence, the other is our own outage. A dashboard that folds
 *   them into one number reports an infrastructure failure as patient
 *   non-adherence, and the pharmacist has no way to tell which they are looking
 *   at. These tests exist so that merging them fails loudly.
 */

const RUN = randomUUID().slice(0, 8);

let pharmacyId: string;
let patientId: string;
let medicationId: string;
let scheduleId: string;
let seq = 0;

/** A second pharmacy, to prove nothing leaks across the tenant boundary. */
let otherPharmacyId: string;

beforeAll(async () => {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Dashboard (${RUN})`, timeZone: "Africa/Cairo" },
  });
  pharmacyId = pharmacy.id;

  const other = await systemPrisma.pharmacy.create({
    data: { name: `Dashboard Other (${RUN})` },
  });
  otherPharmacyId = other.id;

  const patient = await systemPrisma.patient.create({
    data: { pharmacyId, fullName: `Dashboard Patient ${RUN}`, phoneE164: "+201090000001" },
  });
  patientId = patient.id;

  const medication = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId,
      patientId,
      medicationNameText: "Dashboard Medicine",
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
      daysOfWeek: [],
      timeZone: "Africa/Cairo",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  scheduleId = schedule.id;
});

afterAll(async () => {
  await systemPrisma.pharmacy.delete({ where: { id: pharmacyId } }).catch(() => {});
  await systemPrisma.pharmacy.delete({ where: { id: otherPharmacyId } }).catch(() => {});
  await systemPrisma.$disconnect();
});

function todayIn(zone: string): string {
  return DateTime.now().setZone(zone).toISODate() ?? "1970-01-01";
}

/** The pharmacy's local today, as the `@db.Date` column stores it. */
function localDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function addDose(options: {
  deliveryState: string;
  responseState?: string;
  /** Local calendar date the dose belongs to. Defaults to the pharmacy's today. */
  localDateIso?: string;
  /** Defaults to "a few minutes ago", so it falls inside the delivery window. */
  doseAtUtc?: Date;
  pharmacyId?: string;
}) {
  const n = (seq += 1);
  const at = options.doseAtUtc ?? new Date(Date.now() - n * 60_000);

  return systemPrisma.reminderEvent.create({
    data: {
      pharmacyId: options.pharmacyId ?? pharmacyId,
      patientId,
      medicationId,
      scheduleId,
      scheduleRevisionSnapshot: 1,
      doseAtUtc: at,
      doseLocalDate: localDate(options.localDateIso ?? todayIn("Africa/Cairo")),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(at.getTime() + 4 * 3_600_000),
      deliveryState: options.deliveryState as never,
      responseState: (options.responseState ?? "NONE") as never,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("today is the pharmacy's day, not the server's", () => {
  it("counts a dose that belongs to the pharmacy's local date", async () => {
    const iso = todayIn("Africa/Cairo");
    await addDose({ deliveryState: "DELIVERED", localDateIso: iso });

    const summary = await getDashboardSummary(pharmacyId, "Africa/Cairo");
    expect(summary.today.total).toBeGreaterThanOrEqual(1);
  });

  it("re-derives the boundary from the zone it is given", async () => {
    /*
     * Kiritimati is UTC+14 and Midway is UTC-11, so their local dates are ALWAYS
     * a day apart — no dependence on what time this test happens to run at.
     * A dose filed under Kiritimati's today must be invisible to a panel whose
     * pharmacy is on Midway's, and vice versa.
     *
     * This is the assertion that fails if the "today" boundary is ever computed
     * from UTC or from the server clock: both panels would then see the same
     * number, and the evening shift would read yesterday's doses as today's.
     */
    const kiritimatiToday = todayIn("Pacific/Kiritimati");
    const midwayToday = todayIn("Pacific/Midway");

    expect(kiritimatiToday).not.toBe(midwayToday);

    const before = await getDashboardSummary(pharmacyId, "Pacific/Midway");
    await addDose({ deliveryState: "DELIVERED", localDateIso: kiritimatiToday });

    const kiritimati = await getDashboardSummary(pharmacyId, "Pacific/Kiritimati");
    const midway = await getDashboardSummary(pharmacyId, "Pacific/Midway");

    expect(kiritimati.today.total).toBeGreaterThan(0);
    expect(midway.today.total).toBe(before.today.total);
  });

  it("counts an answered dose as answered and stops awaiting it", async () => {
    const iso = todayIn("Africa/Cairo");
    const before = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    await addDose({ deliveryState: "DELIVERED", responseState: "TAKEN", localDateIso: iso });

    const after = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    expect(after.today.total).toBe(before.today.total + 1);
    expect(after.today.answered).toBe(before.today.answered + 1);
    expect(after.today.awaiting).toBe(after.today.total - after.today.answered);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the delivery strip separates our failure from the patient's silence", () => {
  it("counts a message the provider accepted as delivered, whatever state it has reached since", async () => {
    const before = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    // Answered doses have moved on from DELIVERED to READ or beyond. Counting
    // `deliveryState === "DELIVERED"` would report a message the patient opened
    // as NOT delivered — the number would fall as engagement rose.
    await addDose({ deliveryState: "SENT" });
    await addDose({ deliveryState: "DELIVERED" });
    await addDose({ deliveryState: "READ" });

    const after = await getDashboardSummary(pharmacyId, "Africa/Cairo");
    expect(after.delivery.delivered).toBe(before.delivery.delivered + 3);
  });

  it("does not count a scheduled, expired, failed or withdrawn dose as delivered", async () => {
    const before = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    await addDose({ deliveryState: "SCHEDULED" });
    await addDose({ deliveryState: "EXPIRED" });
    await addDose({ deliveryState: "FAILED" });
    await addDose({ deliveryState: "CANCELLED" });
    await addDose({ deliveryState: "SUPERSEDED" });
    await addDose({ deliveryState: "SKIPPED" });

    const after = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    expect(after.delivery.delivered).toBe(before.delivery.delivered);
    expect(after.delivery.expired).toBe(before.delivery.expired + 1);
    expect(after.delivery.failed).toBe(before.delivery.failed + 1);
    // Everything in the window is "attempted", including the ones we never
    // managed to send — that is the honest denominator for a health strip.
    expect(after.delivery.attempted).toBe(before.delivery.attempted + 6);
  });

  it("counts silence only where a message actually reached the patient", async () => {
    const before = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    // Reached the patient, no answer. This is the patient's silence.
    await addDose({ deliveryState: "DELIVERED", responseState: "NONE" });
    // Never left our building. This is our outage, and it must NOT appear as
    // silence — that is the merge that blames the patient for our downtime.
    await addDose({ deliveryState: "EXPIRED", responseState: "NONE" });
    await addDose({ deliveryState: "FAILED", responseState: "NONE" });

    const after = await getDashboardSummary(pharmacyId, "Africa/Cairo");
    expect(after.delivery.noReply).toBe(before.delivery.noReply + 1);
  });

  it("does not count an answered dose as silence", async () => {
    const before = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    await addDose({ deliveryState: "DELIVERED", responseState: "TAKEN" });

    const after = await getDashboardSummary(pharmacyId, "Africa/Cairo");
    expect(after.delivery.noReply).toBe(before.delivery.noReply);
  });

  it("ignores doses older than the window", async () => {
    const before = await getDashboardSummary(pharmacyId, "Africa/Cairo", 7);

    await addDose({
      deliveryState: "DELIVERED",
      doseAtUtc: new Date(Date.now() - 30 * 86_400_000),
      localDateIso: DateTime.now().setZone("Africa/Cairo").minus({ days: 30 }).toISODate() ?? "",
    });

    const after = await getDashboardSummary(pharmacyId, "Africa/Cairo", 7);
    expect(after.delivery.attempted).toBe(before.delivery.attempted);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("what needs a human", () => {
  it("counts only live cases and breaks alerts down by severity", async () => {
    const before = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    await systemPrisma.followUpCase.create({
      data: { pharmacyId, patientId, origin: "MANUAL", status: "OPEN", priority: "URGENT" },
    });
    await systemPrisma.followUpCase.create({
      data: { pharmacyId, patientId, origin: "MANUAL", status: "IN_PROGRESS" },
    });
    // Resolved work is not work. Leaving it in the count is how a panel becomes
    // permanently red and stops being read.
    await systemPrisma.followUpCase.create({
      data: {
        pharmacyId,
        patientId,
        origin: "MANUAL",
        status: "RESOLVED",
        resolvedAtUtc: new Date(),
      },
    });

    for (const [severity, status] of [
      ["URGENT", "OPEN"],
      ["HIGH", "ACKNOWLEDGED"],
      ["LOW", "RESOLVED_AUTO"],
    ] as const) {
      await systemPrisma.alert.create({
        data: {
          pharmacyId,
          patientId,
          ruleKey: `TEST_${RUN}_${severity}`,
          ruleVersion: 1,
          dedupeKey: `${RUN}|${severity}`,
          severity,
          status,
          titleAr: "اختبار",
          titleEn: "Test",
          detailAr: "اختبار",
          detailEn: "Test",
          evidence: {},
        },
      });
    }

    const after = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    expect(after.openCases).toBe(before.openCases + 2);
    // RESOLVED_AUTO is not live, so it lands in neither the total nor the
    // breakdown.
    expect(after.openAlerts).toBe(before.openAlerts + 2);
    expect(after.alertsBySeverity.URGENT).toBe(before.alertsBySeverity.URGENT + 1);
    expect(after.alertsBySeverity.HIGH).toBe(before.alertsBySeverity.HIGH + 1);
    expect(after.alertsBySeverity.LOW).toBe(before.alertsBySeverity.LOW);

    // ACKNOWLEDGED still asserts a current problem — someone has seen it, nobody
    // has dealt with it — so it stays in the count.
    expect(after.openAlerts).toBe(
      after.alertsBySeverity.LOW +
        after.alertsBySeverity.NORMAL +
        after.alertsBySeverity.HIGH +
        after.alertsBySeverity.URGENT,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("tenancy", () => {
  it("counts nothing belonging to another pharmacy", async () => {
    const otherPatient = await systemPrisma.patient.create({
      data: { pharmacyId: otherPharmacyId, fullName: `Stranger ${RUN}`, phoneE164: "+201090000002" },
    });
    const otherMedication = await systemPrisma.medicationRecord.create({
      data: {
        pharmacyId: otherPharmacyId,
        patientId: otherPatient.id,
        medicationNameText: "Other Medicine",
        startedOn: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const otherSchedule = await systemPrisma.medicationSchedule.create({
      data: {
        pharmacyId: otherPharmacyId,
        patientId: otherPatient.id,
        medicationId: otherMedication.id,
        mode: "FIXED_TIMES_OF_DAY",
        timesOfDay: ["08:00"],
        daysOfWeek: [],
        timeZone: "Africa/Cairo",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    const other = await getDashboardSummary(otherPharmacyId, "Africa/Cairo");
    // That pharmacy has one patient and no doses yet, and must report exactly
    // that — not this pharmacy's activity.
    expect(other.activePatients).toBe(1);
    expect(other.today.total).toBe(0);
    expect(other.delivery.attempted).toBe(0);
    expect(other.openCases).toBe(0);

    const mineBefore = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    await systemPrisma.reminderEvent.create({
      data: {
        pharmacyId: otherPharmacyId,
        patientId: otherPatient.id,
        medicationId: otherMedication.id,
        scheduleId: otherSchedule.id,
        scheduleRevisionSnapshot: 1,
        doseAtUtc: new Date(),
        doseLocalDate: localDate(todayIn("Africa/Cairo")),
        doseLocalTime: "08:00",
        responseWindowEndsAtUtc: new Date(Date.now() + 3_600_000),
        deliveryState: "DELIVERED",
      },
    });

    const theirs = await getDashboardSummary(otherPharmacyId, "Africa/Cairo");
    const mineAfter = await getDashboardSummary(pharmacyId, "Africa/Cairo");

    // The same dose instant, the same local date, a different pharmacy. Only
    // one of these panels may move.
    expect(theirs.today.total).toBe(1);
    expect(mineAfter.today.total).toBe(mineBefore.today.total);
    expect(mineAfter.delivery.attempted).toBe(mineBefore.delivery.attempted);
  });
});
