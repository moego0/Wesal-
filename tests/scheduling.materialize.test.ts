import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemPrisma } from "@/server/db";
import {
  materializeSchedule,
  reconcileScheduleChange,
} from "@/server/scheduling/materialize";

/**
 * The materializer, which is where the calendar becomes rows.
 *
 * `ReminderEvent` rows are a RECONCILABLE PROJECTION, not a source of truth.
 * Everything downstream — dispatch, attribution, adherence — treats a row as
 * stable once written, so the only thing keeping that assumption honest is that
 * the projection is rebuilt correctly every time the schedule or the horizon
 * moves. Three properties are load-bearing and none of them are visible from
 * reading the code:
 *
 *   1. Re-running over the same window creates nothing. Without this, the
 *      15-minute sweep would multiply every dose by however many times it ran.
 *   2. The response window of the LAST dose in the horizon is computed from the
 *      next dose — which lies outside the horizon. Without the lookahead day,
 *      the final reminder of every patient would claim a 24-hour response window
 *      and a reply the next morning would land on yesterday's dose.
 *   3. Moving a dose away and back RESTORES THE SAME ROWS, with the same ids.
 *      "The pharmacist tried 09:00, then put it back" must not leave the patient
 *      with no reminders — and must not orphan whatever already pointed at those
 *      slots.
 *
 * Everything is asserted against a real database on `Africa/Cairo`, because the
 * DST behaviour here is Dr. Jekyll and Mr. Hyde: correct in a unit test of the
 * pure expansion, and wrong the moment a boundary is crossed on the way to a
 * stored `@db.Date`.
 */

const RUN = randomUUID().slice(0, 8);

let pharmacyId: string;
let patientId: string;
let medicationId: string;
let seq = 0;

beforeAll(async () => {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Materialize (${RUN})` },
  });
  pharmacyId = pharmacy.id;

  const patient = await systemPrisma.patient.create({
    data: {
      pharmacyId,
      fullName: `Materialize Patient ${RUN}`,
      phoneE164: `+20108${String((seq += 1)).padStart(6, "0")}`,
    },
  });
  patientId = patient.id;

  const medication = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId,
      patientId,
      medicationNameText: "Materialize Medicine",
      startedOn: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  medicationId = medication.id;
});

afterAll(async () => {
  await systemPrisma.pharmacy.delete({ where: { id: pharmacyId } }).catch(() => {});
  await systemPrisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

async function makeSchedule(data: Record<string, unknown> = {}) {
  const schedule = await systemPrisma.medicationSchedule.create({
    data: {
      pharmacyId,
      patientId,
      medicationId,
      mode: "FIXED_TIMES_OF_DAY",
      timesOfDay: ["08:00"],
      // Empty means every day, which keeps the fixtures free of weekday maths.
      daysOfWeek: [],
      timeZone: "Africa/Cairo",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      ...data,
    },
  });

  return schedule.id;
}

/**
 * Re-read the schedule and hand the materializer exactly the fields it reads.
 *
 * Written out rather than spread, so that adding a field to the query means
 * deciding whether materialization depends on it.
 */
async function scheduleContext(id: string) {
  const row = await systemPrisma.medicationSchedule.findUniqueOrThrow({ where: { id } });

  return {
    id: row.id,
    pharmacyId: row.pharmacyId,
    patientId: row.patientId,
    medicationId: row.medicationId,
    status: row.status,
    mode: row.mode,
    timesOfDay: row.timesOfDay,
    daysOfWeek: row.daysOfWeek,
    intervalHours: row.intervalHours,
    anchorAtUtc: row.anchorAtUtc,
    timeZone: row.timeZone,
    startDate: row.startDate,
    endDate: row.endDate,
    responseWindowMinutes: row.responseWindowMinutes,
    revision: row.revision,
    materializedThroughUtc: row.materializedThroughUtc,
  };
}

function listRows(scheduleId: string) {
  return systemPrisma.reminderEvent.findMany({
    where: { scheduleId },
    orderBy: { doseAtUtc: "asc" },
    select: {
      id: true,
      doseAtUtc: true,
      doseLocalDate: true,
      doseLocalTime: true,
      dstAdjusted: true,
      responseWindowEndsAtUtc: true,
      deliveryState: true,
      cancelReason: true,
      supersededByScheduleRevision: true,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("re-running over the same window", () => {
  it("creates nothing the second time", async () => {
    const scheduleId = await makeSchedule();
    const now = new Date("2026-03-10T07:30:00.000Z");

    const first = await materializeSchedule(systemPrisma, await scheduleContext(scheduleId), now);
    expect(first.created).toBeGreaterThan(0);

    const afterFirst = await listRows(scheduleId);

    /*
     * The ORIGINAL context is passed again on purpose, with its
     * `materializedThroughUtc` still null. Re-reading the row would move `from`
     * to the end of the previous horizon and cover one hour instead of three
     * days — which would pass for the wrong reason, since a one-hour window
     * often contains no dose at all.
     */
    const second = await materializeSchedule(systemPrisma, await scheduleContext(scheduleId), now);
    expect(second.created).toBe(0);

    const afterSecond = await listRows(scheduleId);
    expect(afterSecond.map((r) => r.id)).toEqual(afterFirst.map((r) => r.id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the response window of the last dose in the horizon", () => {
  it("is computed from the next dose, which lies past the horizon", async () => {
    // Every 4 hours, so three intervals is 720 minutes — comfortably under the
    // 24-hour fallback and therefore able to tell the two apart.
    const scheduleId = await makeSchedule({
      mode: "INTERVAL_HOURS",
      intervalHours: 4,
      timesOfDay: [],
      anchorAtUtc: new Date("2026-03-10T00:00:00.000Z"),
    });

    const now = new Date("2026-03-10T07:30:00.000Z");
    await materializeSchedule(systemPrisma, await scheduleContext(scheduleId), now);

    const rows = await listRows(scheduleId);
    expect(rows.length).toBeGreaterThan(3);

    for (const row of rows) {
      const windowMinutes =
        (row.responseWindowEndsAtUtc.getTime() - row.doseAtUtc.getTime()) / 60_000;

      /*
       * 720 for every row INCLUDING the last. The last row is the assertion: the
       * only way to know that a dose 4 hours after it exists is to expand past
       * the horizon, and a run without the lookahead day would give that row the
       * 1440-minute fallback instead. A reply the following morning would then be
       * filed against a dose from the previous afternoon.
       */
      expect(windowMinutes).toBe(720);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a schedule edit reconciles the projection", () => {
  it("supersedes the old instants and creates the new ones", async () => {
    const scheduleId = await makeSchedule();
    const now = new Date("2026-03-10T07:30:00.000Z");

    await materializeSchedule(systemPrisma, await scheduleContext(scheduleId), now);
    const before = await listRows(scheduleId);
    expect(before.length).toBeGreaterThan(0);

    await systemPrisma.medicationSchedule.update({
      where: { id: scheduleId },
      data: { timesOfDay: ["09:00"], revision: { increment: 1 } },
    });

    const result = await reconcileScheduleChange(
      systemPrisma,
      await scheduleContext(scheduleId),
      "TIMES_CHANGED",
      now,
    );

    expect(result.superseded).toBe(before.length);

    const after = await listRows(scheduleId);
    const superseded = after.filter((r) => r.deliveryState === "SUPERSEDED");
    const scheduled = after.filter((r) => r.deliveryState === "SCHEDULED");

    expect(superseded).toHaveLength(before.length);
    expect(superseded.every((r) => r.supersededByScheduleRevision === 2)).toBe(true);
    expect(superseded.every((r) => r.cancelReason === "TIMES_CHANGED")).toBe(true);

    // SUPERSEDED rather than CANCELLED: the dose moved, it was not withdrawn.
    // The two are excluded from adherence for different reasons and a
    // pharmacist reading the delivery log needs to tell them apart.
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.every((r) => r.doseLocalTime === "09:00")).toBe(true);
  });

  it("restores the same rows, with the same ids, when the time is moved back", async () => {
    const scheduleId = await makeSchedule();
    const now = new Date("2026-03-10T07:30:00.000Z");

    await materializeSchedule(systemPrisma, await scheduleContext(scheduleId), now);
    const original = await listRows(scheduleId);
    expect(original.length).toBeGreaterThan(0);

    const move = async (time: string) => {
      await systemPrisma.medicationSchedule.update({
        where: { id: scheduleId },
        data: { timesOfDay: [time], revision: { increment: 1 } },
      });
      return reconcileScheduleChange(
        systemPrisma,
        await scheduleContext(scheduleId),
        "TIMES_CHANGED",
        now,
      );
    };

    await move("09:00");
    const back = await move("08:00");

    expect(back.revived).toBe(original.length);

    const scheduled = (await listRows(scheduleId)).filter(
      (r) => r.deliveryState === "SCHEDULED",
    );

    /*
     * The SAME ids, not fresh rows at the same instants. A pharmacist
     * experimenting with dose times would otherwise silently detach every
     * dispatch and response already recorded against those slots — and the
     * patient's history would show a gap where nothing happened.
     */
    expect(scheduled.map((r) => r.id).sort()).toEqual(original.map((r) => r.id).sort());
    expect(scheduled.every((r) => r.doseLocalTime === "08:00")).toBe(true);
  });

  it("cancels every future reminder when the medication is paused, sparing what was sent", async () => {
    const scheduleId = await makeSchedule();
    const now = new Date("2026-03-10T07:30:00.000Z");

    await materializeSchedule(systemPrisma, await scheduleContext(scheduleId), now);
    const before = await listRows(scheduleId);

    // One reminder already went out. It is history: the patient received it, and
    // rewriting it would make the delivery log lie.
    const sent = before[0];
    await systemPrisma.reminderEvent.update({
      where: { id: sent.id },
      data: { deliveryState: "SENT" },
    });

    await systemPrisma.medicationSchedule.update({
      where: { id: scheduleId },
      data: { status: "PAUSED" },
    });

    const result = await reconcileScheduleChange(
      systemPrisma,
      await scheduleContext(scheduleId),
      "PAUSED",
      now,
    );

    expect(result.cancelled).toBe(before.length - 1);

    const after = await listRows(scheduleId);
    const stillSent = after.find((r) => r.id === sent.id);

    expect(stillSent?.deliveryState).toBe("SENT");
    expect(after.filter((r) => r.deliveryState === "SENT")).toHaveLength(1);
    expect(after.filter((r) => r.deliveryState === "CANCELLED")).toHaveLength(before.length - 1);
    expect(
      after.filter((r) => r.deliveryState === "CANCELLED").every((r) => r.cancelReason === "PAUSED"),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Egypt's DST transitions, all the way into the stored rows", () => {
  it("keeps the wall clock and moves the UTC instant when the clocks go back", async () => {
    const scheduleId = await makeSchedule({ startDate: new Date("2026-10-01T00:00:00.000Z") });

    // Egypt leaves DST on the last Thursday of October — 2026-10-29 — at 24:00,
    // when the clocks drop from +03:00 to +02:00.
    const now = new Date("2026-10-27T20:00:00.000Z");
    await materializeSchedule(systemPrisma, await scheduleContext(scheduleId), now);

    const rows = await listRows(scheduleId);
    expect(rows.map((r) => r.doseLocalDate.toISOString().slice(0, 10))).toEqual([
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
    ]);

    // The wall clock never moves. That is the entire reason `timesOfDay` is
    // stored as "HH:mm" and resolved through a tz library at materialization
    // rather than kept as a UTC instant or a fixed +02:00 offset.
    expect(rows.map((r) => r.doseLocalTime)).toEqual(["08:00", "08:00", "08:00"]);

    expect(rows.map((r) => r.doseAtUtc.toISOString())).toEqual([
      "2026-10-28T05:00:00.000Z", // +03:00
      "2026-10-29T05:00:00.000Z", // +03:00 — the transition is at 24:00 that day
      "2026-10-30T06:00:00.000Z", // +02:00
    ]);

    // 24 hours, then 25. A schedule stored as a fixed offset would emit a
    // reminder an hour early for the rest of the winter.
    const gapBefore = rows[1].doseAtUtc.getTime() - rows[0].doseAtUtc.getTime();
    const gapAfter = rows[2].doseAtUtc.getTime() - rows[1].doseAtUtc.getTime();
    expect(gapBefore).toBe(24 * 3_600_000);
    expect(gapAfter).toBe(25 * 3_600_000);
  });

  it("flags a dose that DST forced off its wall-clock time", async () => {
    const scheduleId = await makeSchedule({
      timesOfDay: ["00:30"],
      startDate: new Date("2026-04-01T00:00:00.000Z"),
    });

    // Egypt enters DST on the last Friday of April — 2026-04-24 — at 00:00, when
    // the clocks jump from +02:00 to +03:00. Local 00:30 does not exist that day.
    const now = new Date("2026-04-23T20:00:00.000Z");
    await materializeSchedule(systemPrisma, await scheduleContext(scheduleId), now);

    const rows = await listRows(scheduleId);
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const gap = rows[0];
    expect(gap.doseLocalDate.toISOString().slice(0, 10)).toBe("2026-04-24");
    expect(gap.doseAtUtc.toISOString()).toBe("2026-04-23T22:30:00.000Z");

    /*
     * The flag is the point, and so is what `doseLocalTime` holds. Luxon
     * resolves the nonexistent 00:30 by shifting it to 01:30 and reports the
     * result as perfectly valid, so nothing downstream could tell from the
     * instant alone that the dose moved. The stored local time is therefore the
     * one the dose ACTUALLY falls at — 01:30 — and `dstAdjusted` is what tells
     * the pharmacist it is not the 00:30 they asked for. A row labelled 00:30
     * would name a time that never happens.
     */
    expect(gap.dstAdjusted).toBe(true);
    expect(gap.doseLocalTime).toBe("01:30");

    // Every other day is ordinary and must not carry the flag, or it stops
    // meaning anything.
    expect(rows.slice(1).every((r) => r.dstAdjusted === false)).toBe(true);
  });
});
