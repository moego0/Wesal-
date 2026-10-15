import { DateTime } from "luxon";
import type { DeliveryState, ScheduleChangeKind, ScheduleStatus } from "@/generated/prisma/enums";
import { systemPrisma } from "@/server/db";
import { env } from "@/server/env";
import {
  computeResponseWindowMinutes,
  expandSchedule,
  minutesBetween,
  type ExpandableSchedule,
  type DoseInstant,
} from "@/lib/time";

/**
 * Materialization.
 *
 * `ReminderEvent` rows are a RECONCILABLE PROJECTION, not a source of truth.
 * They are generated ahead of time so that three things are possible:
 *
 *   - idempotency, via a durable row to compare-and-swap against;
 *   - attribution, because an inbound reply must resolve to one specific dose;
 *   - editing, because a pharmacist needs to see and change upcoming reminders.
 *
 * But any materialized row may be flipped to CANCELLED or SUPERSEDED at any
 * moment by a schedule edit. Nothing downstream may assume a row is stable.
 *
 * The horizon is deliberately short (72h by default). Its length IS the size of
 * the reconciliation problem: a pharmacist editing dose times at 09:00 must
 * have that edit fully applied to everything the patient will see. A short
 * horizon also bounds the damage from a stale tzdata database — bad rows age
 * out in three days rather than seven.
 */

/** Anything that can run the queries below — the client or a transaction handle. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

type MaterializeResult = {
  created: number;
  revived: number;
  superseded: number;
  cancelled: number;
};

type ScheduleWithContext = {
  id: string;
  pharmacyId: string;
  patientId: string;
  medicationId: string;
  status: ScheduleStatus;
  mode: "FIXED_TIMES_OF_DAY" | "INTERVAL_HOURS" | "PRN";
  timesOfDay: string[];
  daysOfWeek: number[];
  intervalHours: number | null;
  anchorAtUtc: Date | null;
  timeZone: string;
  startDate: Date;
  endDate: Date | null;
  responseWindowMinutes: number | null;
  revision: number;
  materializedThroughUtc: Date | null;
};

function toExpandable(schedule: ScheduleWithContext): ExpandableSchedule {
  return {
    mode: schedule.mode,
    timesOfDay: schedule.timesOfDay,
    daysOfWeek: schedule.daysOfWeek,
    intervalHours: schedule.intervalHours,
    anchorAtUtc: schedule.anchorAtUtc,
    timeZone: schedule.timeZone,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
  };
}

/** Rows read back from the projection, for diffing against a fresh expansion. */
type ExistingRow = { id: string; doseAtUtc: Date; deliveryState: DeliveryState };

/**
 * `@db.Date` columns arrive as midnight UTC. Converting with a local-zone
 * interpretation would shift the day boundary for any zone behind UTC.
 */
function toDateOnly(localDate: string): Date {
  return new Date(`${localDate}T00:00:00.000Z`);
}

function horizonEnd(now: Date): Date {
  return new Date(now.getTime() + env().MATERIALIZE_HORIZON_HOURS * 3600_000);
}

/**
 * Expand with one extra day of lookahead.
 *
 * The response window for a dose depends on the time to the NEXT dose, so the
 * final dose inside the horizon cannot be computed without peeking past it.
 * The lookahead doses are used for context only and never persisted.
 */
function expandWithLookahead(schedule: ScheduleWithContext, from: Date, to: Date) {
  const lookaheadEnd = new Date(to.getTime() + 24 * 3600_000);
  const all = expandSchedule(toExpandable(schedule), from, lookaheadEnd);
  const inHorizon = all.filter((d) => d.atUtc <= to);

  return { inHorizon, all };
}

function buildRow(
  schedule: ScheduleWithContext,
  dose: DoseInstant,
  next: DoseInstant | undefined,
) {
  const minutesToNext = next ? minutesBetween(dose.atUtc, next.atUtc) : null;

  return {
    pharmacyId: schedule.pharmacyId,
    patientId: schedule.patientId,
    medicationId: schedule.medicationId,
    scheduleId: schedule.id,
    scheduleRevisionSnapshot: schedule.revision,
    kind: "SCHEDULED_DOSE" as const,
    doseAtUtc: dose.atUtc,
    doseLocalDate: toDateOnly(dose.localDate),
    doseLocalTime: dose.localTime,
    dstAdjusted: dose.adjusted,
    responseWindowEndsAtUtc: new Date(
      dose.atUtc.getTime() +
        computeResponseWindowMinutes(schedule.responseWindowMinutes, minutesToNext) * 60_000,
    ),
  };
}

/**
 * Extend the materialized horizon for one schedule.
 *
 * Safe to run repeatedly and concurrently: the unique constraint on
 * `(scheduleId, doseAtUtc)` turns a repeat run into a no-op, and the overlap
 * with the previous horizon (`materializedThroughUtc - 1h`) closes any gap if
 * two runs interleave.
 */
export async function materializeSchedule(
  tx: Tx,
  schedule: ScheduleWithContext,
  now = new Date(),
): Promise<MaterializeResult> {
  const result: MaterializeResult = { created: 0, revived: 0, superseded: 0, cancelled: 0 };

  if (schedule.status !== "ACTIVE" || schedule.mode === "PRN") return result;

  const to = horizonEnd(now);
  const from = schedule.materializedThroughUtc
    ? new Date(Math.max(now.getTime(), schedule.materializedThroughUtc.getTime() - 3600_000))
    : now;

  const { inHorizon, all } = expandWithLookahead(schedule, from, to);
  if (inHorizon.length === 0) return result;

  const desiredInstants = new Set(inHorizon.map((d) => d.atUtc.getTime()));

  const existing: ExistingRow[] = await tx.reminderEvent.findMany({
    where: { scheduleId: schedule.id, doseAtUtc: { gte: from } },
    select: { id: true, doseAtUtc: true, deliveryState: true },
  });

  const existingInstants = new Set(existing.map((e) => e.doseAtUtc.getTime()));

  // ── create the missing ones ──
  const rows = inHorizon
    .map((dose) => {
      const idx = all.indexOf(dose);
      return buildRow(schedule, dose, all[idx + 1]);
    })
    .filter((row) => !existingInstants.has(row.doseAtUtc.getTime()));

  if (rows.length > 0) {
    // skipDuplicates makes a concurrent second run harmless rather than a
    // unique-violation that would abort the sweep for every other patient.
    const created = await tx.reminderEvent.createMany({ data: rows, skipDuplicates: true });
    result.created = created.count;
  }

  // ── revive rows whose slot is back in the desired set ──
  //
  // This is what makes "unpause" and "move a time and move it back" correct.
  // Without it, a pharmacist experimenting with dose times would permanently
  // lose the original reminders.
  const revivable = existing.filter(
    (e) =>
      (e.deliveryState === "CANCELLED" || e.deliveryState === "SUPERSEDED") &&
      desiredInstants.has(e.doseAtUtc.getTime()) &&
      e.doseAtUtc.getTime() > now.getTime(),
  );

  if (revivable.length > 0) {
    const revived = await tx.reminderEvent.updateMany({
      // Only touch rows still in a mutable state — this guard is what stops a
      // concurrent writer's transition from being clobbered.
      where: { id: { in: revivable.map((e) => e.id) }, deliveryState: { in: ["CANCELLED", "SUPERSEDED"] } },
      data: { deliveryState: "SCHEDULED", cancelReason: null, supersededByScheduleRevision: null },
    });
    result.revived = revived.count;
  }

  await tx.medicationSchedule.update({
    where: { id: schedule.id },
    data: { materializedThroughUtc: to },
  });

  return result;
}

/**
 * Apply a schedule change to the projection.
 *
 * Called with the NEW spec already written, inside the same transaction, so a
 * half-applied change cannot be observed.
 *
 * The distinction between SUPERSEDED and CANCELLED is not cosmetic: a superseded
 * dose moved to a new time, while a cancelled dose no longer exists clinically.
 * Adherence reporting and the pharmacist's view treat them differently.
 */
export async function reconcileScheduleChange(
  tx: Tx,
  schedule: ScheduleWithContext,
  changeKind: ScheduleChangeKind,
  now = new Date(),
): Promise<MaterializeResult> {
  const result: MaterializeResult = { created: 0, revived: 0, superseded: 0, cancelled: 0 };

  const terminalKinds: ScheduleChangeKind[] = ["PAUSED", "DISCONTINUED", "COMPLETED"];
  const isTerminal = terminalKinds.includes(changeKind);

  const existing: ExistingRow[] = await tx.reminderEvent.findMany({
    where: {
      scheduleId: schedule.id,
      doseAtUtc: { gt: now },
      deliveryState: { in: ["SCHEDULED", "CANCELLED", "SUPERSEDED"] },
    },
    select: { id: true, doseAtUtc: true, deliveryState: true },
  });

  if (isTerminal) {
    // Pause / discontinue: every future reminder goes, and none come back until
    // an explicit resume. Rows already SENT or SENDING are immutable history.
    const cancelled = await tx.reminderEvent.updateMany({
      where: { id: { in: existing.map((e) => e.id) }, deliveryState: "SCHEDULED" },
      data: { deliveryState: "CANCELLED", cancelReason: changeKind },
    });
    result.cancelled = cancelled.count;
    return result;
  }

  // Time/mode/day/timezone edits: diff the projection against the new spec.
  const to = horizonEnd(now);
  const { inHorizon, all } = expandWithLookahead(schedule, now, to);
  const desired = new Set(inHorizon.map((d) => d.atUtc.getTime()));
  const existingByInstant = new Map(existing.map((e) => [e.doseAtUtc.getTime(), e]));

  const toSupersede = existing.filter(
    (e) => e.deliveryState === "SCHEDULED" && !desired.has(e.doseAtUtc.getTime()),
  );

  if (toSupersede.length > 0) {
    const superseded = await tx.reminderEvent.updateMany({
      where: { id: { in: toSupersede.map((e) => e.id) }, deliveryState: "SCHEDULED" },
      data: {
        deliveryState: "SUPERSEDED",
        supersededByScheduleRevision: schedule.revision,
        cancelReason: changeKind,
      },
    });
    result.superseded = superseded.count;
  }

  const toRevive = existing.filter(
    (e) =>
      (e.deliveryState === "CANCELLED" || e.deliveryState === "SUPERSEDED") &&
      desired.has(e.doseAtUtc.getTime()),
  );

  if (toRevive.length > 0) {
    const revived = await tx.reminderEvent.updateMany({
      where: { id: { in: toRevive.map((e) => e.id) }, deliveryState: { in: ["CANCELLED", "SUPERSEDED"] } },
      data: { deliveryState: "SCHEDULED", cancelReason: null, supersededByScheduleRevision: null },
    });
    result.revived = revived.count;
  }

  const rows = inHorizon
    .filter((d) => !existingByInstant.has(d.atUtc.getTime()))
    .map((dose) => {
      const idx = all.indexOf(dose);
      return buildRow(schedule, dose, all[idx + 1]);
    });

  if (rows.length > 0) {
    const created = await tx.reminderEvent.createMany({ data: rows, skipDuplicates: true });
    result.created = created.count;
  }

  await tx.medicationSchedule.update({
    where: { id: schedule.id },
    data: { materializedThroughUtc: to },
  });

  return result;
}

/**
 * Sweep entry point: extend the horizon for every schedule that needs it.
 *
 * Runs every 15 minutes. Uses `systemPrisma` legitimately — this spans every
 * pharmacy by design.
 */
export async function materializeDueSchedules(now = new Date()): Promise<{
  schedules: number;
  created: number;
  revived: number;
}> {
  const horizon = horizonEnd(now);

  const schedules = await systemPrisma.medicationSchedule.findMany({
    where: {
      status: "ACTIVE",
      mode: { not: "PRN" },
      OR: [{ materializedThroughUtc: null }, { materializedThroughUtc: { lt: horizon } }],
    },
    take: 500,
    // Postgres sorts NULLs LAST under ASC by default, which would starve every
    // schedule that has never been materialized — exactly the ones a new
    // patient needs. Push them to the front explicitly.
    orderBy: { materializedThroughUtc: { sort: "asc", nulls: "first" } },
  });

  let created = 0;
  let revived = 0;

  for (const schedule of schedules) {
    // A schedule whose end date has passed is complete, not merely unmaterialized.
    if (schedule.endDate) {
      const end = DateTime.fromJSDate(schedule.endDate, { zone: "utc" }).endOf("day");
      if (end < DateTime.fromJSDate(now)) {
        await systemPrisma.medicationSchedule.update({
          where: { id: schedule.id },
          data: { status: "COMPLETED" },
        });
        continue;
      }
    }

    const res = await materializeSchedule(systemPrisma, schedule as ScheduleWithContext, now);
    created += res.created;
    revived += res.revived;
  }

  return { schedules: schedules.length, created, revived };
}
