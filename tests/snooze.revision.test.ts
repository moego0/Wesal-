// First import on purpose: `@/server/db` resolves env() while it is being
// evaluated, and vitest does not load .env for us. ESM evaluates imports in
// source order, so this has to be a side-effect import and not a call.
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemPrisma } from "@/server/db";
import { applyResponse } from "@/server/responses/applyResponse";

/**
 * The snooze event a patient's "remind me later" produces.
 *
 * There was no test here at all, which is why two defects survived in a file
 * whose sibling behaviours are covered carefully.
 *
 *   1. `scheduleRevisionSnapshot` was the literal 1. `claimDueReminder`
 *      supersedes any event whose snapshot disagrees with the schedule's live
 *      revision, and `revision` is bumped on every schedule edit — so on any
 *      schedule anyone had ever changed, every snooze was created correctly,
 *      marked SUPERSEDED at claim time, and silently never sent. The patient
 *      tapped "remind me later" and heard nothing, which reads as the system
 *      being broken rather than the nudge being dropped.
 *
 *   2. The local date and time were derived with `getUTC*()`, so a snooze was
 *      stamped with the UTC wall clock rather than the patient's. `doseLocalTime`
 *      is what adherence-by-time-of-day groups on, so every snoozed dose landed
 *      in the wrong bucket — 2 to 3 hours early in Cairo, and the database CHECK
 *      cannot catch it because "19:30" is a perfectly valid HH:mm, just the
 *      wrong clock.
 *
 * The dates below are in January on purpose: Egypt observes DST, and in the
 * northern winter Cairo is unambiguously UTC+2, so this asserts the conversion
 * without also asserting a DST rule that changes.
 */

const RUN = randomUUID().slice(0, 8);

const CAIRO_JANUARY_OFFSET_HOURS = 2;

/** 06:00 UTC is 08:00 in Cairo in January — the schedule's own dose time. */
const DOSE_AT_UTC = new Date("2026-01-15T06:00:00.000Z");

let pharmacyId = "";
let patientId = "";
let medicationId = "";
let scheduleId = "";
let doseSeq = 0;

beforeAll(async () => {
  const pharmacy = await systemPrisma.pharmacy.create({ data: { name: `Snooze (${RUN})` } });
  pharmacyId = pharmacy.id;

  const patient = await systemPrisma.patient.create({
    data: { pharmacyId, fullName: `Snooze Patient ${RUN}`, phoneE164: "+201555000333" },
  });
  patientId = patient.id;

  const medication = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId,
      patientId,
      medicationNameText: "Snooze Test Medicine",
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

  expect(schedule.revision).toBe(1);
});

afterAll(async () => {
  await systemPrisma.patientResponse.deleteMany({ where: { patientId } });
  await systemPrisma.reminderEvent.deleteMany({ where: { pharmacyId } });
  await systemPrisma.medicationSchedule.deleteMany({ where: { id: scheduleId } });
  await systemPrisma.medicationRecord.deleteMany({ where: { id: medicationId } });
  await systemPrisma.patient.deleteMany({ where: { id: patientId } });
  await systemPrisma.pharmacy.deleteMany({ where: { id: pharmacyId } });
  await systemPrisma.$disconnect();
});

/** A delivered dose the patient is answering, with an open response window. */
function makeDose() {
  // `(scheduleId, doseAtUtc)` is unique, so each fixture dose must be a
  // distinct instant.
  const doseAtUtc = new Date(DOSE_AT_UTC.getTime() + (doseSeq += 1) * 60_000);

  return systemPrisma.reminderEvent.create({
    data: {
      pharmacyId,
      patientId,
      medicationId,
      scheduleId,
      scheduleRevisionSnapshot: 1,
      doseAtUtc,
      doseLocalDate: new Date("2026-01-15T00:00:00.000Z"),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(doseAtUtc.getTime() + 4 * 3_600_000),
      deliveryState: "DELIVERED",
      firstSentAtUtc: doseAtUtc,
    },
  });
}

/**
 * The patient's answer. Derived from the dose rather than fixed, because a
 * snooze's own `(scheduleId, doseAtUtc)` slot is unique: two snoozes computed
 * from one constant instant collide, and the second is dropped as a duplicate
 * slot rather than created.
 */
function answerTimeFor(doseAtUtc: Date) {
  return new Date(doseAtUtc.getTime() + 14 * 3_600_000 + 30 * 60_000);
}

function snooze(eventId: string, receivedAtUtc: Date) {
  return applyResponse({
    pharmacyId,
    patientId,
    reminderEventId: eventId,
    channel: "WHATSAPP_BUTTON",
    answer: "REMIND_LATER",
    receivedAtUtc,
    rawMessageId: `wamid.${RUN}.${randomUUID()}`,
  });
}

describe("a snooze carries the schedule's live revision", () => {
  it("survives the schedule having been edited", async () => {
    // The schedule is edited after the reminder went out — a dose-time change,
    // the most ordinary thing a pharmacist does.
    await systemPrisma.medicationSchedule.update({
      where: { id: scheduleId },
      data: { revision: 2 },
    });

    const dose = await makeDose();
    const result = await snooze(dose.id, answerTimeFor(dose.doseAtUtc));

    expect(result.snoozeSuppressedReason).toBeUndefined();
    expect(result.snoozeEventId).toBeTruthy();

    const created = await systemPrisma.reminderEvent.findUniqueOrThrow({
      where: { id: result.snoozeEventId! },
      select: {
        kind: true,
        scheduleRevisionSnapshot: true,
        countedForAdherence: true,
        deliveryState: true,
        parentEventId: true,
      },
    });

    // Not the literal 1, which is what made this nudge undeliverable.
    expect(created.scheduleRevisionSnapshot).toBe(2);

    // The nudge is not a dose, so it must not score one.
    expect(created.kind).toBe("SNOOZE");
    expect(created.countedForAdherence).toBe(false);
    expect(created.deliveryState).toBe("SCHEDULED");
    expect(created.parentEventId).toBe(dose.id);
  });

  // The other half of the same guard — a schedule edit after the snooze exists
  // superseding it — is covered in `dispatch.cas.test.ts`, which asserts
  // `deliveryState: "SUPERSEDED"` and `supersededByScheduleRevision` after a
  // revision bump. What had no coverage was the creation side: the snapshot
  // value above.
});

describe("a snooze is stamped with the patient's local clock", () => {
  it("records Cairo wall-clock time, not UTC", async () => {
    const dose = await makeDose();
    const receivedAtUtc = answerTimeFor(dose.doseAtUtc);
    const result = await snooze(dose.id, receivedAtUtc);
    expect(result.snoozeEventId).toBeTruthy();

    const created = await systemPrisma.reminderEvent.findUniqueOrThrow({
      where: { id: result.snoozeEventId! },
      select: { doseLocalDate: true, doseLocalTime: true },
    });

    const utcHour = receivedAtUtc.getUTCHours();
    const minutes = String(receivedAtUtc.getUTCMinutes()).padStart(2, "0");
    const expectedHour = String(utcHour + CAIRO_JANUARY_OFFSET_HOURS).padStart(2, "0");

    expect(created.doseLocalTime).toBe(`${expectedHour}:${minutes}`);
    // The signature of the old bug: the UTC wall clock written straight through.
    expect(created.doseLocalTime).not.toBe(`${String(utcHour).padStart(2, "0")}:${minutes}`);

    // The local calendar day as a date at UTC midnight, which is the shape
    // `@db.Date` and the reporting queries both expect.
    expect(created.doseLocalDate.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
});
