import { DateTime } from "luxon";

/**
 * Timezone and dose-expansion primitives.
 *
 * Every instant that leaves this module came from Luxon, never from `Date`
 * arithmetic and never from a hard-coded offset. Egypt reintroduced DST in 2023
 * and has changed the transition rule since; a fixed `+02:00` is the classic
 * way an Egyptian scheduling app starts sending reminders an hour early.
 */

// Measured behaviour of Luxon 3.x for Africa/Cairo (see tests/time.test.ts):
//
//   Spring forward — a nonexistent local time is silently shifted forward by
//   the size of the gap. `fromISO('2026-04-24T00:30', Cairo)` yields
//   `2026-04-24T01:30+03:00`. It is VALID, so the shift must be detected by
//   comparing wall clocks; it cannot be caught by an isValid() check.
//
//   Fall back — an ambiguous local time resolves to the FIRST occurrence
//   (`2026-10-29T23:30` -> `+03:00`, before the clocks go back). That is the
//   behaviour we want: fire once, not twice.

export type DoseInstant = {
  /** The resolved UTC instant. */
  atUtc: Date;
  /** Local date at the dose, `yyyy-MM-dd`. Correct across the DST change. */
  localDate: string;
  /**
   * The wall-clock time the dose ACTUALLY falls at, `HH:mm` — which is the
   * requested time except where DST forced a move, when it is the shifted one
   * (`adjusted` says so). Storing the requested time instead would put a
   * reminder's label at an instant it never fires.
   */
  localTime: string;
  /**
   * True when DST forced the dose off its nominal wall-clock time, i.e. the
   * requested local time does not exist and had to be shifted. Surfaced to the
   * pharmacist so a moved dose is never silent.
   */
  adjusted: boolean;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidWallClock(time: string): boolean {
  return HHMM.test(time);
}

/**
 * Resolve a local wall-clock dose time to a UTC instant.
 *
 * Note this takes a local DATE and TIME rather than a DateTime, because the
 * whole point is that the schedule stores wall-clock times that must stay
 * stable across DST.
 */
export function resolveDoseInstant(
  localDate: string,
  localTime: string,
  zone: string,
): DoseInstant {
  if (!isValidWallClock(localTime)) {
    throw new Error(`Invalid wall-clock time: ${JSON.stringify(localTime)} (expected HH:mm)`);
  }

  const requested = DateTime.fromISO(`${localDate}T${localTime}`, { zone });

  if (!requested.isValid) {
    throw new Error(
      `Could not resolve ${localDate}T${localTime} in ${zone}: ${requested.invalidReason}`,
    );
  }

  // Detect the spring-forward shift: Luxon returns a valid DateTime whose wall
  // clock is not the one we asked for.
  const adjusted = requested.toFormat("HH:mm") !== localTime;

  return {
    atUtc: requested.toUTC().toJSDate(),
    localDate: requested.toFormat("yyyy-MM-dd"),
    localTime: requested.toFormat("HH:mm"),
    adjusted,
  };
}

export type ExpandableSchedule = {
  mode: "FIXED_TIMES_OF_DAY" | "INTERVAL_HOURS" | "PRN";
  timesOfDay: string[];
  /** 0 = Sunday. Empty means every day. */
  daysOfWeek: number[];
  intervalHours: number | null;
  anchorAtUtc: Date | null;
  timeZone: string;
  startDate: Date;
  endDate: Date | null;
};

/**
 * Expand a schedule into the concrete dose instants falling within
 * `[fromUtc, toUtc]`.
 *
 * Pure and deterministic: the same schedule and window always produce the same
 * instants, which is what lets the materializer treat insertion as idempotent
 * and simply diff against what is already stored.
 */
export function expandSchedule(
  schedule: ExpandableSchedule,
  fromUtc: Date,
  toUtc: Date,
): DoseInstant[] {
  if (schedule.mode === "PRN") return [];
  if (fromUtc >= toUtc) return [];

  return schedule.mode === "INTERVAL_HOURS"
    ? expandInterval(schedule, fromUtc, toUtc)
    : expandFixedTimes(schedule, fromUtc, toUtc);
}

function inDateRange(localDate: string, schedule: ExpandableSchedule): boolean {
  // startDate/endDate are @db.Date, so Prisma hands them back as midnight UTC.
  // They must be read in UTC: interpreting them in the pharmacy's zone would
  // shift the boundary by a day for any zone behind UTC.
  const startLocal = DateTime.fromJSDate(schedule.startDate, { zone: "utc" }).toFormat("yyyy-MM-dd");

  const endLocal = schedule.endDate
    ? DateTime.fromJSDate(schedule.endDate, { zone: "utc" }).toFormat("yyyy-MM-dd")
    : null;

  return localDate >= startLocal && (endLocal === null || localDate <= endLocal);
}

function expandFixedTimes(
  schedule: ExpandableSchedule,
  fromUtc: Date,
  toUtc: Date,
): DoseInstant[] {
  const zone = schedule.timeZone;
  const out: DoseInstant[] = [];

  // Walk local days, not UTC days. A 72-hour UTC window can touch four local
  // dates around a DST change, and iterating UTC dates would drop doses.
  let cursor = DateTime.fromJSDate(fromUtc, { zone }).startOf("day").minus({ days: 1 });
  const last = DateTime.fromJSDate(toUtc, { zone }).endOf("day").plus({ days: 1 });

  while (cursor <= last) {
    const localDate = cursor.toFormat("yyyy-MM-dd");
    // Luxon weekday: 1 = Monday .. 7 = Sunday. We store 0 = Sunday.
    const weekday = cursor.weekday % 7;

    const dayMatches =
      schedule.daysOfWeek.length === 0 || schedule.daysOfWeek.includes(weekday);

    if (dayMatches && inDateRange(localDate, schedule)) {
      for (const time of schedule.timesOfDay) {
        const dose = resolveDoseInstant(localDate, time, zone);
        if (dose.atUtc >= fromUtc && dose.atUtc <= toUtc) out.push(dose);
      }
    }

    cursor = cursor.plus({ days: 1 });
  }

  return dedupe(out);
}

function expandInterval(
  schedule: ExpandableSchedule,
  fromUtc: Date,
  toUtc: Date,
): DoseInstant[] {
  const zone = schedule.timeZone;
  const hours = schedule.intervalHours;

  if (!hours || hours <= 0 || !schedule.anchorAtUtc) return [];

  const out: DoseInstant[] = [];
  let at = DateTime.fromJSDate(schedule.anchorAtUtc, { zone: "utc" });

  // Fast-forward to the window without stepping one interval at a time from a
  // possibly year-old anchor.
  const gapHours = DateTime.fromJSDate(fromUtc, { zone: "utc" }).diff(at, "hours").hours;
  if (gapHours > hours) {
    at = at.plus({ hours: Math.floor(gapHours / hours) * hours });
  }

  // Bounded so a malformed anchor/interval cannot spin forever.
  let guard = 0;
  while (at.toJSDate() <= toUtc && guard++ < 5000) {
    const asLocal = at.setZone(zone);
    const localDate = asLocal.toFormat("yyyy-MM-dd");

    if (at.toJSDate() >= fromUtc && inDateRange(localDate, schedule)) {
      out.push({
        atUtc: at.toJSDate(),
        localDate,
        localTime: asLocal.toFormat("HH:mm"),
        // Interval dosing is anchored to an absolute instant, so local times
        // drift by an hour across a DST change. That is correct for "every 6
        // hours" and is flagged so the pharmacist is not surprised.
        adjusted: false,
      });
    }

    at = at.plus({ hours });
  }

  return dedupe(out);
}

function dedupe(doses: DoseInstant[]): DoseInstant[] {
  const seen = new Map<number, DoseInstant>();
  for (const d of doses) seen.set(d.atUtc.getTime(), d);
  return [...seen.values()].sort((a, b) => a.atUtc.getTime() - b.atUtc.getTime());
}

/**
 * How late a reminder is still worth sending.
 *
 * The `0.5 * timeToNextDose` term is the clinically meaningful one: a "take your
 * 08:00 dose" reminder arriving at 11:30 is worse than no reminder when the next
 * dose is due at 12:00. The 180-minute cap stops a once-daily drug accepting a
 * reminder at 23:00 for an 08:00 dose; the 20-minute floor stops an ordinary
 * queue jitter from expiring everything.
 */
export function computeLateWindowMinutes(
  override: number | null,
  minutesToNextDose: number | null,
): number {
  if (override !== null && override > 0) return override;
  if (minutesToNextDose === null) return 180;

  return Math.max(20, Math.min(180, Math.floor(0.5 * minutesToNextDose)));
}

/**
 * How long after a dose a reply is still attributed to it.
 *
 * Beyond three dosing intervals the answer is more likely about a different
 * dose than the one it names, so it stops being evidence.
 */
export function computeResponseWindowMinutes(
  override: number | null,
  minutesToNextDose: number | null,
): number {
  if (override !== null && override > 0) return override;
  if (minutesToNextDose === null) return 24 * 60;

  return Math.max(120, Math.min(24 * 60, Math.floor(3 * minutesToNextDose)));
}

/** Minutes between two instants, or null when `next` is absent or in the past. */
export function minutesBetween(from: Date, next: Date | null | undefined): number | null {
  if (!next) return null;
  const diff = (next.getTime() - from.getTime()) / 60000;
  return diff > 0 ? Math.floor(diff) : null;
}

export function startOfLocalDayUtc(instant: Date, zone: string): Date {
  return DateTime.fromJSDate(instant, { zone }).startOf("day").toUTC().toJSDate();
}
