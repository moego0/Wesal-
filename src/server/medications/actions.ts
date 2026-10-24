"use server";

import { DateTime } from "luxon";
import { hasLocale } from "next-intl";
import { type Prisma } from "@/generated/prisma/client";
import type {
  MedicationStatus,
  ScheduleChangeKind,
  ScheduleMode,
  ScheduleStatus,
} from "@/generated/prisma/enums";
import { redirect } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { isValidWallClock } from "@/lib/time";
import { AUDIT_ACTION, writeAudit, type AuditWriter } from "@/server/audit";
import { requireSessionUser } from "@/server/auth/current-user";
import { requirePermission } from "@/server/auth/rbac";
import { systemPrisma } from "@/server/db";
import {
  materializeSchedule,
  reconcileScheduleChange,
} from "@/server/scheduling/materialize";
import {
  calculateDailyConsumption,
  calculateDaysSupply,
  calculateDepletionDate,
  calculateTotalPackages,
  calculateTreatmentDays,
  calculateTreatmentEndDate,
} from "@/lib/refills";

/**
 * Adding a medication and its schedule, and changing either.
 *
 * ## Why these run on the unguarded client
 *
 * Every transaction below is opened with `systemPrisma`, which is unusual for
 * application code and is deliberate. The materializer
 * (`src/server/scheduling/materialize.ts`) reads and updates `ReminderEvent`
 * rows by `scheduleId` alone — correctly, because it is handed one schedule and
 * those rows are identified by their instant. The tenant guard in
 * `src/server/db.ts` rejects any `findMany`/`updateMany` without a top-level
 * `pharmacyId`, so a guarded transaction cannot run it at all.
 *
 * The alternative would be to reconcile the projection after commit, on a second
 * transaction, which is exactly the failure this screen must not have: a new
 * spec stored while the old reminders are still pending. So the whole operation
 * runs on one unguarded transaction and EVERY statement in it carries an
 * explicit `pharmacyId` predicate. That is the price, and it is paid at each
 * call site rather than trusted to the guard.
 *
 * ## A schedule change is a clinical event, not an edit
 *
 * In ONE transaction, in this order:
 *
 *   1. the new spec is written and `revision` is bumped,
 *   2. a `MedicationScheduleRevision` row records what it changed from and to,
 *   3. an `AuditEvent` is written (`AuditEvent` is append-only, so it cannot be
 *      corrected later),
 *   4. `reconcileScheduleChange` diffs the projection: future `ReminderEvent`
 *      rows the new spec no longer contains are SUPERSEDED — never left
 *      SCHEDULED, because a stale future reminder is a cancelled dose the
 *      patient is told to take.
 *
 * ## The medication status is the only status control
 *
 * `dispatch.ts` gates on `schedule.status`, not on the medication's, so a
 * medication set to DISCONTINUED while its schedule stayed ACTIVE keeps sending
 * — forever, and silently. The two cannot be allowed to disagree, so the form
 * exposes one control and `scheduleStatusFor` derives the schedule's status from
 * it on every save. A disagreement that arrives from outside this screen (a
 * migration, a script) is repaired the next time the medication is saved.
 */

export type MedicationFormState = {
  /** Form-level failure as a stable code the form translates. Never prose. */
  formError: string | null;
  /** Field name → error code. */
  fieldErrors: Record<string, string>;
  /** Echo of what was submitted, so a rejected save does not wipe the form. */
  values: Record<string, string>;
  /** Time inputs as typed, in order, blanks dropped. */
  times: string[];
  /** Day-of-week checkboxes (0 = Sunday). */
  days: number[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Input helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The same narrowing `auth/actions.ts` does. Not imported from there — a
 * `"use server"` module may only export async functions, so helpers like this
 * one are repeated per module rather than shared.
 */
function safeLocale(value: FormDataEntryValue | null): AppLocale {
  return typeof value === "string" && hasLocale(routing.locales, value)
    ? value
    : routing.defaultLocale;
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function nullable(value: string): string | null {
  return value === "" ? null : value;
}

const ECHOED = [
  "patientId",
  "medicationId",
  "scheduleId",
  "name",
  "medicationCode",
  "strength",
  "doseAmount",
  "instructions",
  "prescriber",
  "indication",
  "startedOn",
  "mode",
  "timeZone",
  "startDate",
  "endDate",
  "lateWindowMinutes",
  "status",
  "reason",
  "unitsPerPackage",
  "unitsPerDose",
  "dosesPerDay",
  "treatmentDurationValue",
  "treatmentDurationUnit",
  "prescriberDoctorName",
  "prescriberDoctorPhone",
] as const;

function echo(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of ECHOED) values[key] = field(formData, key);
  return values;
}

/** The raw time strings as the pharmacist typed them, blanks dropped. */
function rawTimes(formData: FormData): string[] {
  return formData
    .getAll("timesOfDay")
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value !== "");
}

function checkedDays(formData: FormData): number[] {
  return [
    ...new Set(
      formData
        .getAll("daysOfWeek")
        .map((value) => Number(value))
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
    ),
  ].sort((a, b) => a - b);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wall-clock times
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Arabic-Indic, extended Arabic-Indic and fullwidth digits, so that a pharmacist
 * typing `٨:٠٠` on an Arabic keyboard stores 08:00 rather than a string the
 * materializer cannot expand — where it would surface as a schedule that quietly
 * never sends.
 */
const DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
};

/** `H:MM`, `HH:MM`, `HHMM`, `H.MM`, `H٫MM`, optionally `:SS` with SS = 00. */
const TIME_INPUT = /^([0-9]{1,2})(?::|\.|٫|：)?([0-9]{2})(?::([0-9]{2}))?$/;

/**
 * Normalise what a human typed into the exact `HH:MM` the rest of the system
 * requires.
 *
 * `ReminderEvent.doseLocalTime` has a database CHECK for
 * `^([01][0-9]|2[0-3]):[0-5][0-9]$` — `"8:00"`, `"0800"`, `"24:00"`, `"08:60"`
 * and `"08:00:00"` are all rejected at INSERT, and a bad entry in
 * `MedicationSchedule.timesOfDay` is rejected later, by `expandSchedule`
 * throwing inside the materializer, where it shows up as a sweep that stopped
 * working with nothing on screen to explain it. So the input is folded here,
 * once, and the caller stores only what this function returns.
 *
 * Returns null when the input is not a plausible time at all; the caller turns
 * that into a field error rather than guessing.
 */
function normalizeTimeOfDay(input: string): string | null {
  const folded = input
    .replace(/[٠-٩۰-۹０-９]/g, (digit) => DIGITS[digit] ?? digit)
    // U+00A0 and the bidi marks arrive from phones and from copy-paste out of
    // Word. None of them is visible in the input box, and all of them break
    // the pattern.
    .replace(/[\s ‎‏]/g, "");

  const match = TIME_INPUT.exec(folded);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  // Seconds are tolerated only as :00. "08:00:30" is a different time, and
  // silently dropping the 30 would move a dose the pharmacist did not move.
  if (match[3] !== undefined && match[3] !== "00") return null;
  if (hours > 23 || minutes > 59) return null;

  const normalized = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

  // Belt and braces: the shared predicate, so this cannot drift from the
  // format the materializer and the database both enforce.
  return isValidWallClock(normalized) ? normalized : null;
}

/** Sort and de-duplicate: 08:00 typed twice is one dose, not two reminders. */
function canonicalTimes(times: string[]): string[] {
  return [...new Set(times)].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Other field parsing
// ─────────────────────────────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const SCHEDULE_MODES = ["FIXED_TIMES_OF_DAY", "PRN"] as const;
const MEDICATION_STATUSES = ["ACTIVE", "ON_HOLD", "DISCONTINUED", "COMPLETED"] as const;

/**
 * An RxCUI is a plain integer, so the check is a whitelist rather than a
 * cleanup: whatever fails it is dropped, not repaired.
 *
 * The dropped value is SILENT, unlike every other field on this form. The input
 * is hidden, so a `fieldErrors` entry could not be shown beside anything, and a
 * bad code must never cost the pharmacist a legitimate save — the invariant is
 * "only a well-formed RxCUI is ever persisted", not "the sender is told". Same
 * posture as `normalizeTimeOfDay` returning null.
 */
const RXCUI = /^\d{1,8}$/;

const NAME_MAX = 160;
const STRENGTH_MAX = 80;
const DOSE_MAX = 120;
const INSTRUCTIONS_MAX = 500;
const PRESCRIBER_MAX = 120;
const INDICATION_MAX = 200;
const REASON_MAX = 500;
/** More than this in one day is a data-entry mistake, not a regimen. */
const MAX_TIMES_PER_DAY = 12;

/**
 * `YYYY-MM-DD` from an `<input type="date">` into the UTC-midnight `Date` a
 * `@db.Date` column expects — the convention `expandSchedule` reads back, so the
 * day boundary cannot shift with a timezone.
 */
function parseDateOnly(value: string): Date | null {
  if (!DATE_ONLY.test(value)) return null;

  const at = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return null;

  // 2026-02-31 is a well-formed string that JS silently rolls into March.
  return at.toISOString().slice(0, 10) === value ? at : null;
}

/** The patient's current local date, for stamping `discontinuedOn`. */
function todayInZone(zone: string): Date {
  const local = DateTime.now().setZone(zone).toFormat("yyyy-MM-dd");
  return new Date(`${local}T00:00:00.000Z`);
}

let ianaZones: Set<string> | null = null;

/**
 * IANA identifiers only. A fixed offset such as `+03:00` would pin a schedule to
 * a permanent offset and start sending an hour early the next time Egypt changes
 * its DST rule, so it is rejected rather than stored.
 */
function isIanaTimeZone(value: string): boolean {
  if (value === "") return false;
  if (value === "UTC") return true;
  ianaZones ??= new Set(Intl.supportedValuesOf("timeZone"));
  return ianaZones.has(value);
}

type MedicationInput = {
  medicationNameText: string;
  medicationCode: string | null;
  strengthText: string | null;
  doseAmountText: string | null;
  instructions: string | null;
  prescriberText: string | null;
  indicationText: string | null;
  startedOn: Date;
  unitsPerPackage: number | null;
  unitsPerDose: number | null;
  dosesPerDay: number | null;
  treatmentDurationValue: number | null;
  treatmentDurationUnit: "DAYS" | "WEEKS" | "MONTHS" | null;
  prescriberDoctorName: string | null;
  prescriberDoctorPhone: string | null;
};

function parseMedicationFields(
  formData: FormData,
  fieldErrors: Record<string, string>,
): MedicationInput {
  const medicationNameText = field(formData, "name");
  const codeRaw = field(formData, "medicationCode");
  const strengthText = nullable(field(formData, "strength"));
  const doseAmountText = nullable(field(formData, "doseAmount"));
  const instructions = nullable(field(formData, "instructions"));
  const prescriberText = nullable(field(formData, "prescriber"));
  const indicationText = nullable(field(formData, "indication"));
  const startedOnRaw = field(formData, "startedOn");

  const unitsPerPackageRaw = field(formData, "unitsPerPackage");
  const unitsPerDoseRaw = field(formData, "unitsPerDose");
  const dosesPerDayRaw = field(formData, "dosesPerDay");
  const durationValRaw = field(formData, "treatmentDurationValue");
  const durationUnitRaw = field(formData, "treatmentDurationUnit");
  const prescriberDoctorName = nullable(field(formData, "prescriberDoctorName"));
  const prescriberDoctorPhone = nullable(field(formData, "prescriberDoctorPhone"));

  if (medicationNameText.length < 2 || medicationNameText.length > NAME_MAX) {
    fieldErrors.name = medicationNameText === "" ? "REQUIRED" : "INVALID";
  }
  if (strengthText && strengthText.length > STRENGTH_MAX) fieldErrors.strength = "TOO_LONG";
  if (doseAmountText && doseAmountText.length > DOSE_MAX) fieldErrors.doseAmount = "TOO_LONG";
  if (instructions && instructions.length > INSTRUCTIONS_MAX) {
    fieldErrors.instructions = "TOO_LONG";
  }
  if (prescriberText && prescriberText.length > PRESCRIBER_MAX) {
    fieldErrors.prescriber = "TOO_LONG";
  }
  if (prescriberDoctorName && prescriberDoctorName.length > PRESCRIBER_MAX) {
    fieldErrors.prescriberDoctorName = "TOO_LONG";
  }
  if (prescriberDoctorPhone && prescriberDoctorPhone.length > 40) {
    fieldErrors.prescriberDoctorPhone = "TOO_LONG";
  }
  if (indicationText && indicationText.length > INDICATION_MAX) {
    fieldErrors.indication = "TOO_LONG";
  }

  const startedOn = parseDateOnly(startedOnRaw);
  if (!startedOn) fieldErrors.startedOn = startedOnRaw === "" ? "REQUIRED" : "INVALID_DATE";

  let unitsPerPackage: number | null = null;
  if (unitsPerPackageRaw !== "") {
    const parsed = Number(unitsPerPackageRaw);
    if (Number.isInteger(parsed) && parsed > 0) unitsPerPackage = parsed;
    else fieldErrors.unitsPerPackage = "INVALID_NUMBER";
  }

  let unitsPerDose: number | null = null;
  if (unitsPerDoseRaw !== "") {
    const parsed = Number(unitsPerDoseRaw);
    if (!Number.isNaN(parsed) && parsed > 0) unitsPerDose = parsed;
    else fieldErrors.unitsPerDose = "INVALID_NUMBER";
  }

  let dosesPerDay: number | null = null;
  if (dosesPerDayRaw !== "") {
    const parsed = Number(dosesPerDayRaw);
    if (Number.isInteger(parsed) && parsed > 0) dosesPerDay = parsed;
    else fieldErrors.dosesPerDay = "INVALID_NUMBER";
  }

  let treatmentDurationValue: number | null = null;
  if (durationValRaw !== "") {
    const parsed = Number(durationValRaw);
    if (Number.isInteger(parsed) && parsed > 0) treatmentDurationValue = parsed;
    else fieldErrors.treatmentDurationValue = "INVALID_NUMBER";
  }

  let treatmentDurationUnit: "DAYS" | "WEEKS" | "MONTHS" | null = null;
  if (durationUnitRaw !== "") {
    if (["DAYS", "WEEKS", "MONTHS"].includes(durationUnitRaw)) {
      treatmentDurationUnit = durationUnitRaw as "DAYS" | "WEEKS" | "MONTHS";
    } else {
      fieldErrors.treatmentDurationUnit = "INVALID_UNIT";
    }
  }

  if (treatmentDurationValue && !treatmentDurationUnit) {
    fieldErrors.treatmentDurationUnit = "REQUIRED";
  }

  return {
    medicationNameText,
    medicationCode: RXCUI.test(codeRaw) ? codeRaw : null,
    strengthText,
    doseAmountText,
    instructions,
    prescriberText,
    indicationText,
    startedOn: startedOn ?? new Date(),
    unitsPerPackage,
    unitsPerDose,
    dosesPerDay,
    treatmentDurationValue,
    treatmentDurationUnit,
    prescriberDoctorName,
    prescriberDoctorPhone,
  };
}

type ScheduleInput = {
  mode: (typeof SCHEDULE_MODES)[number];
  /** What the pharmacist chose for the medication; the form's only status control. */
  medicationStatus: MedicationStatus;
  /** Derived from it. This is what `dispatch.ts` reads. */
  status: ScheduleStatus;
  timesOfDay: string[];
  daysOfWeek: number[];
  timeZone: string;
  startDate: Date;
  endDate: Date | null;
  lateWindowMinutes: number | null;
  reason: string | null;
};

function parseScheduleFields(
  formData: FormData,
  patientTimeZone: string,
  fieldErrors: Record<string, string>,
  medicationInput?: Partial<MedicationInput>,
): ScheduleInput {
  const modeRaw = field(formData, "mode");
  if (modeRaw !== "" && !(SCHEDULE_MODES as readonly string[]).includes(modeRaw)) {
    fieldErrors.mode = "INVALID";
  }
  const mode = (SCHEDULE_MODES as readonly string[]).includes(modeRaw)
    ? (modeRaw as (typeof SCHEDULE_MODES)[number])
    : "FIXED_TIMES_OF_DAY";

  const statusRaw = field(formData, "status");
  if (statusRaw !== "" && !(MEDICATION_STATUSES as readonly string[]).includes(statusRaw)) {
    fieldErrors.status = "INVALID";
  }
  const medicationStatus = (MEDICATION_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as MedicationStatus)
    : "ACTIVE";

  const timeZone = field(formData, "timeZone") || patientTimeZone;
  if (!isIanaTimeZone(timeZone)) fieldErrors.timeZone = "INVALID_TIMEZONE";

  const startDateRaw = field(formData, "startDate");
  const endDateRaw = field(formData, "endDate");

  const startDate = parseDateOnly(startDateRaw);
  if (!startDate) fieldErrors.startDate = startDateRaw === "" ? "REQUIRED" : "INVALID_DATE";

  let endDate: Date | null = null;
  if (endDateRaw !== "") {
    endDate = parseDateOnly(endDateRaw);
    if (!endDate) fieldErrors.endDate = "INVALID_DATE";
  } else if (
    startDate &&
    medicationInput?.treatmentDurationValue &&
    medicationInput?.treatmentDurationUnit
  ) {
    // Automatically calculate end date from duration when not explicitly overridden
    endDate = calculateTreatmentEndDate(
      startDate,
      medicationInput.treatmentDurationValue,
      medicationInput.treatmentDurationUnit,
    );
  }

  if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
    fieldErrors.endDate = "END_BEFORE_START";
  }

  const lateWindowRaw = field(formData, "lateWindowMinutes");
  let lateWindowMinutes: number | null = null;
  if (lateWindowRaw !== "") {
    const parsed = Number(lateWindowRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1440) {
      fieldErrors.lateWindowMinutes = "INVALID";
    } else {
      lateWindowMinutes = parsed;
    }
  }

  const reason = nullable(field(formData, "reason"));
  if (reason && reason.length > REASON_MAX) fieldErrors.reason = "TOO_LONG";

  let timesOfDay: string[] = [];
  if (mode === "FIXED_TIMES_OF_DAY") {
    const normalized: string[] = [];

    for (const raw of rawTimes(formData)) {
      const time = normalizeTimeOfDay(raw);
      if (time === null) {
        fieldErrors.timesOfDay = "INVALID_TIME";
        break;
      }
      normalized.push(time);
    }

    timesOfDay = canonicalTimes(normalized);

    if (!fieldErrors.timesOfDay && timesOfDay.length === 0) {
      fieldErrors.timesOfDay = "TIMES_REQUIRED";
    } else if (timesOfDay.length > MAX_TIMES_PER_DAY) {
      fieldErrors.timesOfDay = "TOO_MANY";
    }
  }

  const daysOfWeek = checkedDays(formData);
  if (daysOfWeek.length === 0) fieldErrors.daysOfWeek = "DAYS_REQUIRED";

  return {
    mode,
    medicationStatus,
    status: scheduleStatusFor(medicationStatus),
    timesOfDay,
    daysOfWeek,
    timeZone,
    startDate: startDate ?? new Date(),
    endDate,
    lateWindowMinutes,
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The coupling between a medication's status and its schedule's
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one place the two statuses are related.
 *
 * `dispatch.ts` refuses to send unless `event.schedule.status === "ACTIVE"`, so
 * the schedule is the gate and the medication's status only matters through it.
 * `ON_HOLD` maps to PAUSED rather than ACTIVE because "hold this for now" is a
 * pause, and a pause that still sends is not a pause.
 */
function scheduleStatusFor(status: MedicationStatus): ScheduleStatus {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "ON_HOLD":
      return "PAUSED";
    case "DISCONTINUED":
      return "DISCONTINUED";
    case "COMPLETED":
      return "COMPLETED";
  }
}

type ScheduleShape = {
  status: ScheduleStatus;
  mode: ScheduleMode;
  timesOfDay: string[];
  daysOfWeek: number[];
  timeZone: string;
  startDate: Date;
  endDate: Date | null;
  lateWindowMinutes: number | null;
};

/** The spec a revision row snapshots — dates as `yyyy-MM-dd`, never instants. */
function toSnapshot(schedule: ScheduleShape & { revision: number }) {
  return {
    revision: schedule.revision,
    status: schedule.status,
    mode: schedule.mode,
    timesOfDay: schedule.timesOfDay,
    daysOfWeek: schedule.daysOfWeek,
    timeZone: schedule.timeZone,
    startDate: schedule.startDate.toISOString().slice(0, 10),
    endDate: schedule.endDate ? schedule.endDate.toISOString().slice(0, 10) : null,
    lateWindowMinutes: schedule.lateWindowMinutes,
  };
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameDay(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

/**
 * What KIND of change this was.
 *
 * Not cosmetic: the materializer treats PAUSED/DISCONTINUED/COMPLETED as terminal
 * (cancel everything ahead, create nothing) and every other kind as a diff, and
 * the revision row is what a pharmacist reads to see how a regimen evolved.
 *
 * Ordered by how much of the regimen each one moves. A timezone edit re-times
 * every dose in the schedule, so it is reported as itself even when a time also
 * moved in the same save.
 */
function scheduleChangeKind(before: ScheduleShape, after: ScheduleShape): ScheduleChangeKind {
  if (before.status !== after.status) {
    switch (after.status) {
      case "PAUSED":
        return "PAUSED";
      case "DISCONTINUED":
        return "DISCONTINUED";
      case "COMPLETED":
        return "COMPLETED";
      case "ACTIVE":
        return "RESUMED";
      default:
        // DRAFT is not reachable from this form; MODE_CHANGED is the closest
        // non-terminal kind and keeps the reconcile a diff rather than a purge.
        return "MODE_CHANGED";
    }
  }

  if (before.mode !== after.mode) return "MODE_CHANGED";
  if (before.timeZone !== after.timeZone) return "TZ_CHANGED";
  if (!sameValues(before.timesOfDay, after.timesOfDay)) return "TIMES_CHANGED";
  if (!sameValues(before.daysOfWeek.map(String), after.daysOfWeek.map(String))) {
    return "DAYS_CHANGED";
  }
  if (!sameDay(before.startDate, after.startDate) || !sameDay(before.endDate, after.endDate)) {
    return "END_DATE_CHANGED";
  }

  // The dose itself, or the window it may be sent in.
  return "DOSE_CHANGED";
}

/** The audit action matching the kind, so the trail says what happened. */
function auditActionFor(changeKind: ScheduleChangeKind): string {
  switch (changeKind) {
    case "PAUSED":
      return AUDIT_ACTION.SCHEDULE_PAUSED;
    case "RESUMED":
      return AUDIT_ACTION.SCHEDULE_RESUMED;
    case "DISCONTINUED":
      return AUDIT_ACTION.SCHEDULE_DISCONTINUED;
    default:
      return AUDIT_ACTION.SCHEDULE_CHANGED;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

type WriteContext = {
  pharmacyId: string;
  userId: string;
  now: Date;
};

/**
 * Create a schedule, its first revision row, its audit row, and its horizon.
 *
 * `revision` starts at 1 and a revision row is written for it too: treating
 * revision 1 as implicit would leave the history a pharmacist reads beginning at
 * 2, with no answer to "what did this look like when it was created".
 */
async function createScheduleInTx(
  tx: Tx,
  ctx: WriteContext,
  ids: { patientId: string; medicationId: string },
  spec: ScheduleInput,
) {
  const schedule = await tx.medicationSchedule.create({
    data: {
      pharmacyId: ctx.pharmacyId,
      patientId: ids.patientId,
      medicationId: ids.medicationId,
      status: spec.status,
      mode: spec.mode,
      timesOfDay: spec.timesOfDay,
      daysOfWeek: spec.daysOfWeek,
      timeZone: spec.timeZone,
      startDate: spec.startDate,
      endDate: spec.endDate,
      lateWindowMinutes: spec.lateWindowMinutes,
      revision: 1,
      createdByUserId: ctx.userId,
      updatedByUserId: ctx.userId,
    },
  });

  await tx.medicationScheduleRevision.create({
    data: {
      scheduleId: schedule.id,
      revision: schedule.revision,
      snapshot: toSnapshot(schedule),
      changeKind: "CREATED",
      changedByUserId: ctx.userId,
      reason: spec.reason,
    },
  });

  await writeAudit(tx as unknown as AuditWriter, {
    pharmacyId: ctx.pharmacyId,
    actorType: "USER",
    actorUserId: ctx.userId,
    entityType: "MedicationSchedule",
    entityId: schedule.id,
    action: AUDIT_ACTION.SCHEDULE_CREATED,
    after: toSnapshot(schedule),
  });

  // Starts the projection. Without this the schedule has no reminders until the
  // sweep's next pass — up to 15 minutes in which a patient registered at the
  // counter gets nothing.
  await materializeSchedule(tx, schedule, ctx.now);

  return schedule;
}

/**
 * Apply a change to an existing schedule: revise, record, audit, reconcile.
 *
 * The order is the contract. The revision is bumped with an atomic `increment`
 * rather than by reading and adding one, so two pharmacists editing the same
 * regimen at the same moment cannot agree on a revision number — the
 * `@@unique([scheduleId, revision])` would catch it, but only after the
 * materials were already in flight.
 */
async function applyScheduleChangeInTx(
  tx: Tx,
  ctx: WriteContext,
  before: ScheduleShape & { id: string; revision: number },
  after: ScheduleInput,
) {
  const changeKind = scheduleChangeKind(before, after);

  const updated = await tx.medicationSchedule.update({
    where: { id: before.id },
    data: {
      status: after.status,
      mode: after.mode,
      timesOfDay: after.timesOfDay,
      daysOfWeek: after.daysOfWeek,
      timeZone: after.timeZone,
      startDate: after.startDate,
      endDate: after.endDate,
      lateWindowMinutes: after.lateWindowMinutes,
      revision: { increment: 1 },
      updatedByUserId: ctx.userId,
    },
  });

  await tx.medicationScheduleRevision.create({
    data: {
      scheduleId: updated.id,
      revision: updated.revision,
      snapshot: toSnapshot(updated),
      changeKind,
      changedByUserId: ctx.userId,
      reason: after.reason,
    },
  });

  await writeAudit(tx as unknown as AuditWriter, {
    pharmacyId: ctx.pharmacyId,
    actorType: "USER",
    actorUserId: ctx.userId,
    entityType: "MedicationSchedule",
    entityId: updated.id,
    action: auditActionFor(changeKind),
    before: toSnapshot(before),
    after: toSnapshot(updated),
    reason: after.reason ?? undefined,
  });

  // The projection catches up last, inside the same transaction, so no reader —
  // and no dispatcher — can ever see the new spec beside the old reminders.
  await reconcileScheduleChange(tx, updated, changeKind, ctx.now);

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// Add a medication and its schedule
// ─────────────────────────────────────────────────────────────────────────────

export async function createMedicationWithSchedule(
  _prev: MedicationFormState,
  formData: FormData,
): Promise<MedicationFormState> {
  const locale = safeLocale(formData.get("locale"));
  const user = await requireSessionUser(locale);
  requirePermission(user, "medication:write");
  requirePermission(user, "schedule:write");

  const values = echo(formData);
  const times = rawTimes(formData);
  const days = checkedDays(formData);

  const fieldErrors: Record<string, string> = {};
  const patientId = field(formData, "patientId");

  const patient = await systemPrisma.patient.findFirst({
    where: { id: patientId, pharmacyId: user.pharmacyId },
    select: { id: true, timeZone: true },
  });

  if (!patient) {
    return { formError: "NOT_FOUND", fieldErrors: {}, values, times, days };
  }

  const medication = parseMedicationFields(formData, fieldErrors);
  const schedule = parseScheduleFields(formData, patient.timeZone, fieldErrors, medication);

  if (Object.keys(fieldErrors).length > 0) {
    return { formError: null, fieldErrors, values, times, days };
  }

  /*
   * `instructionsTextAr` / `instructionsTextEn` are separate columns and this
   * form has one box. The box is filled in the language the pharmacist is
   * reading, so that is the column written and the other stays null: a
   * translation nobody wrote must not be invented, and the detail screen already
   * renders whichever column matches the reader.
   */
  const instructions =
    locale === "en"
      ? { instructionsTextEn: medication.instructions }
      : { instructionsTextAr: medication.instructions };

  await systemPrisma.$transaction(async (tx) => {
    const record = await tx.medicationRecord.create({
      data: {
        pharmacyId: user.pharmacyId,
        patientId: patient.id,
        medicationNameText: medication.medicationNameText,
        medicationCode: medication.medicationCode,
        strengthText: medication.strengthText,
        doseAmountText: medication.doseAmountText,
        prescriberText: medication.prescriberText,
        indicationText: medication.indicationText,
        startedOn: medication.startedOn,
        createdByUserId: user.userId,
        unitsPerPackage: medication.unitsPerPackage,
        unitsPerDose: medication.unitsPerDose,
        dosesPerDay: medication.dosesPerDay,
        treatmentDurationValue: medication.treatmentDurationValue,
        treatmentDurationUnit: medication.treatmentDurationUnit,
        prescriberDoctorName: medication.prescriberDoctorName,
        prescriberDoctorPhone: medication.prescriberDoctorPhone,
        ...instructions,
      },
    });

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: user.pharmacyId,
      actorType: "USER",
      actorUserId: user.userId,
      entityType: "MedicationRecord",
      entityId: record.id,
      action: AUDIT_ACTION.MEDICATION_CREATED,
      after: {
        patientId: patient.id,
        medicationNameText: record.medicationNameText,
        medicationCode: record.medicationCode,
        strengthText: record.strengthText,
        startedOn: record.startedOn.toISOString().slice(0, 10),
      },
    });

    // A new medication is ACTIVE whatever the form posted, so its schedule is
    // ACTIVE: the projection starts immediately and the patient's first reminder
    // exists before the pharmacist leaves the screen.
    await createScheduleInTx(
      tx,
      { pharmacyId: user.pharmacyId, userId: user.userId, now: new Date() },
      { patientId: patient.id, medicationId: record.id },
      { ...schedule, medicationStatus: "ACTIVE", status: "ACTIVE" },
    );

    // Initial Refill Record (cycle 1)
    if (medication.unitsPerPackage) {
      let daysSupply = 30;
      if (medication.unitsPerDose && (medication.dosesPerDay || schedule.timesOfDay.length)) {
        const daily = calculateDailyConsumption(
          medication.unitsPerDose,
          medication.dosesPerDay ?? schedule.timesOfDay.length ?? 1,
        );
        daysSupply = calculateDaysSupply(medication.unitsPerPackage, daily);
      } else {
        daysSupply = calculateDaysSupply(medication.unitsPerPackage, 1);
      }
      const depletionDate = calculateDepletionDate(medication.startedOn, daysSupply);

      let packagesNeeded = 1;
      if (medication.treatmentDurationValue && medication.treatmentDurationUnit) {
        const treatmentEnd = calculateTreatmentEndDate(
          medication.startedOn,
          medication.treatmentDurationValue,
          medication.treatmentDurationUnit as "DAYS" | "WEEKS" | "MONTHS",
        );
        const treatmentDays = calculateTreatmentDays(medication.startedOn, treatmentEnd);
        packagesNeeded = calculateTotalPackages(treatmentDays, daysSupply);
      }

      await tx.refillRecord.create({
        data: {
          pharmacyId: user.pharmacyId,
          patientId: patient.id,
          medicationId: record.id,
          status: "PENDING",
          cycleNumber: 1,
          packagesNeeded,
          daysSupply,
          expectedRunOutOn: depletionDate,
          refillDueOn: depletionDate,
          unitsDispensed: medication.unitsPerPackage,
          lastDispensedOn: medication.startedOn,
        },
      });
    }
  });

  return redirect({ href: `/patients/${patient.id}`, locale });
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit a medication, or change its schedule
// ─────────────────────────────────────────────────────────────────────────────

export async function updateMedicationWithSchedule(
  _prev: MedicationFormState,
  formData: FormData,
): Promise<MedicationFormState> {
  const locale = safeLocale(formData.get("locale"));
  const user = await requireSessionUser(locale);
  requirePermission(user, "medication:write");
  requirePermission(user, "schedule:write");

  const values = echo(formData);
  const times = rawTimes(formData);
  const days = checkedDays(formData);

  // Scoped by pharmacyId in the predicate, never `findUnique` by id: another
  // pharmacy's medication must be indistinguishable from one that does not
  // exist, and this action is a public endpoint.
  const medication = await systemPrisma.medicationRecord.findFirst({
    where: { id: field(formData, "medicationId"), pharmacyId: user.pharmacyId },
    include: {
      patient: { select: { id: true, timeZone: true } },
      schedules: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!medication) {
    return { formError: "NOT_FOUND", fieldErrors: {}, values, times, days };
  }

  const fieldErrors: Record<string, string> = {};
  const input = parseMedicationFields(formData, fieldErrors);
  const spec = parseScheduleFields(formData, medication.patient.timeZone, fieldErrors, input);

  if (Object.keys(fieldErrors).length > 0) {
    return { formError: null, fieldErrors, values, times, days };
  }

  /*
   * Which schedule this edits.
   *
   * The page decides with `pickPrimarySchedule` and posts the id back, so the
   * action cannot silently edit a different regimen than the one on screen. The
   * fallback repeats that helper's preference order for a form that posted
   * nothing (or an id that is not this medication's): the live schedule, else
   * the newest. A medication with no schedule at all gets one — the alternative
   * is a medication that can never remind anyone, and a pharmacist who would
   * never find out.
   */
  const submittedId = field(formData, "scheduleId");
  const target =
    medication.schedules.find((s) => s.id === submittedId) ??
    medication.schedules.find((s) => s.status === "ACTIVE") ??
    medication.schedules[0] ??
    null;

  const instructions =
    locale === "en"
      ? { instructionsTextEn: input.instructions }
      : { instructionsTextAr: input.instructions };

  await systemPrisma.$transaction(async (tx) => {
    await tx.medicationRecord.update({
      where: { id: medication.id },
      data: {
        medicationNameText: input.medicationNameText,
        medicationCode: input.medicationCode,
        strengthText: input.strengthText,
        doseAmountText: input.doseAmountText,
        prescriberText: input.prescriberText,
        indicationText: input.indicationText,
        startedOn: input.startedOn,
        status: spec.medicationStatus,
        unitsPerPackage: input.unitsPerPackage,
        unitsPerDose: input.unitsPerDose,
        dosesPerDay: input.dosesPerDay,
        treatmentDurationValue: input.treatmentDurationValue,
        treatmentDurationUnit: input.treatmentDurationUnit,
        prescriberDoctorName: input.prescriberDoctorName,
        prescriberDoctorPhone: input.prescriberDoctorPhone,
        // Kept consistent in both directions: a discontinued row says when and
        // why, and a restarted one does not claim to be stopped.
        discontinuedOn:
          spec.medicationStatus === "DISCONTINUED"
            ? (medication.discontinuedOn ?? todayInZone(medication.patient.timeZone))
            : null,
        discontinueReason: spec.medicationStatus === "DISCONTINUED" ? spec.reason : null,
        ...instructions,
      },
    });

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: user.pharmacyId,
      actorType: "USER",
      actorUserId: user.userId,
      entityType: "MedicationRecord",
      entityId: medication.id,
      action:
        spec.medicationStatus === "DISCONTINUED" && medication.status !== "DISCONTINUED"
          ? AUDIT_ACTION.MEDICATION_DISCONTINUED
          : AUDIT_ACTION.MEDICATION_UPDATED,
      before: {
        medicationNameText: medication.medicationNameText,
        medicationCode: medication.medicationCode,
        doseAmountText: medication.doseAmountText,
        status: medication.status,
      },
      after: {
        medicationNameText: input.medicationNameText,
        medicationCode: input.medicationCode,
        doseAmountText: input.doseAmountText,
        status: spec.medicationStatus,
      },
      reason: spec.reason ?? undefined,
    });

    const ctx: WriteContext = {
      pharmacyId: user.pharmacyId,
      userId: user.userId,
      now: new Date(),
    };

    const ids = { patientId: medication.patientId, medicationId: medication.id };

    if (target) {
      await applyScheduleChangeInTx(tx, ctx, target, spec);
    } else {
      await createScheduleInTx(tx, ctx, ids, spec);
    }

    // Update active Refill Record if units/duration changed
    if (input.unitsPerPackage) {
      let daysSupply = 30;
      if (input.unitsPerDose && (input.dosesPerDay || spec.timesOfDay.length)) {
        const daily = calculateDailyConsumption(
          input.unitsPerDose,
          input.dosesPerDay ?? spec.timesOfDay.length ?? 1,
        );
        daysSupply = calculateDaysSupply(input.unitsPerPackage, daily);
      } else {
        daysSupply = calculateDaysSupply(input.unitsPerPackage, 1);
      }

      let packagesNeeded = 1;
      if (input.treatmentDurationValue && input.treatmentDurationUnit) {
        const treatmentEnd = calculateTreatmentEndDate(
          input.startedOn,
          input.treatmentDurationValue,
          input.treatmentDurationUnit as "DAYS" | "WEEKS" | "MONTHS",
        );
        const treatmentDays = calculateTreatmentDays(input.startedOn, treatmentEnd);
        packagesNeeded = calculateTotalPackages(treatmentDays, daysSupply);
      }

      const latestRefill = await tx.refillRecord.findFirst({
        where: { medicationId: medication.id },
        orderBy: { cycleNumber: "desc" },
      });

      if (!latestRefill) {
        const depletionDate = calculateDepletionDate(input.startedOn, daysSupply);
        await tx.refillRecord.create({
          data: {
            pharmacyId: user.pharmacyId,
            patientId: medication.patientId,
            medicationId: medication.id,
            status: "PENDING",
            cycleNumber: 1,
            packagesNeeded,
            daysSupply,
            expectedRunOutOn: depletionDate,
            refillDueOn: depletionDate,
            unitsDispensed: input.unitsPerPackage,
            lastDispensedOn: input.startedOn,
          },
        });
      } else if (latestRefill.status === "PENDING" || latestRefill.status === "ESTIMATED") {
        const depletionDate = calculateDepletionDate(
          latestRefill.lastDispensedOn ?? input.startedOn,
          daysSupply,
        );
        await tx.refillRecord.update({
          where: { id: latestRefill.id },
          data: {
            packagesNeeded,
            daysSupply,
            expectedRunOutOn: depletionDate,
            refillDueOn: depletionDate,
          },
        });
      }
    }
  });

  return redirect({ href: `/patients/${medication.patientId}`, locale });
}

/**
 * Permanently delete a medication and its associated schedules, reminders, and refills.
 */
export async function deleteMedication(formData: FormData): Promise<void> {
  const medicationId = field(formData, "medicationId");
  const locale = safeLocale(field(formData, "locale"));

  if (!medicationId) {
    throw new Error("Missing medicationId");
  }

  const user = await requireSessionUser(locale);
  requirePermission(user, "medication:write");
  requirePermission(user, "schedule:write");

  const medication = await systemPrisma.medicationRecord.findFirst({
    where: { id: medicationId, pharmacyId: user.pharmacyId },
    select: { id: true, patientId: true, medicationNameText: true },
  });

  if (!medication) {
    throw new Error("Medication not found");
  }

  await systemPrisma.$transaction(async (tx) => {
    // 1. Unlink optional relations in follow-up cases and interventions
    await tx.followUpCase.updateMany({
      where: { medicationId: medication.id, pharmacyId: user.pharmacyId },
      data: { medicationId: null },
    });
    await tx.pharmacistIntervention.updateMany({
      where: { medicationId: medication.id, pharmacyId: user.pharmacyId },
      data: { medicationId: null },
    });

    // 2. Delete Refills
    await tx.refillRecord.deleteMany({
      where: { medicationId: medication.id, pharmacyId: user.pharmacyId },
    });

    // 3. Delete ReminderEvents
    await tx.reminderEvent.deleteMany({
      where: { medicationId: medication.id, pharmacyId: user.pharmacyId },
    });

    // 4. Delete Schedules
    await tx.medicationSchedule.deleteMany({
      where: { medicationId: medication.id, pharmacyId: user.pharmacyId },
    });

    // 5. Delete MedicationRecord
    await tx.medicationRecord.delete({
      where: { id: medication.id },
    });

    // 6. Write Audit
    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: user.pharmacyId,
      actorType: "USER",
      actorUserId: user.userId,
      entityType: "MedicationRecord",
      entityId: medication.id,
      action: AUDIT_ACTION.MEDICATION_DELETED,
      before: {
        medicationNameText: medication.medicationNameText,
      },
      reason: "Medication deleted by user",
    });
  });

  return redirect({ href: `/patients/${medication.patientId}`, locale });
}
