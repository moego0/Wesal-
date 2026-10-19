import { DateTime } from "luxon";

/**
 * Medication depletion and refill calculation primitives.
 *
 * All dates use Luxon to respect Egyptian / configured IANA timezones and
 * calendar month variations (e.g., February 28/29, April 30, July 31),
 * avoiding naive 30-day assumptions.
 */

export type DurationUnit = "DAYS" | "WEEKS" | "MONTHS";

export type RefillCycle = {
  cycleNumber: number;
  startDate: Date;
  expectedRunOutDate: Date;
  refillDueDate: Date;
  daysSupply: number;
  packagesCount: number;
};

export type TreatmentPlan = {
  startDate: Date;
  endDate: Date;
  totalTreatmentDays: number;
  dailyConsumption: number;
  daysSupplyPerPackage: number;
  totalPackagesNeeded: number;
  cycles: RefillCycle[];
};

/**
 * Calculates daily consumption from units per dose and doses per day.
 * e.g., 2 tablets * 3 times/day = 6 tablets/day.
 */
export function calculateDailyConsumption(unitsPerDose: number, dosesPerDay: number): number {
  if (unitsPerDose <= 0 || dosesPerDay <= 0) return 1;
  return Number((unitsPerDose * dosesPerDay).toFixed(2));
}

/**
 * Calculates how many days one package lasts.
 * e.g., 30 tablets / 1 tablet daily = 30 days.
 * e.g., 30 tablets / 2 tablets daily = 15 days.
 */
export function calculateDaysSupply(unitsPerPackage: number, dailyConsumption: number): number {
  if (unitsPerPackage <= 0 || dailyConsumption <= 0) return 30;
  const days = Math.floor(unitsPerPackage / dailyConsumption);
  return Math.max(1, days);
}

/**
 * Converts a JS Date into a Luxon DateTime pinned to the start of day (midnight) in the given zone.
 */
function toMidnightInZone(date: Date, zone: string): DateTime {
  return DateTime.fromJSDate(date, { zone }).startOf("day");
}

/**
 * Calculates treatment end date based on duration value and unit (DAYS, WEEKS, MONTHS).
 * Uses real calendar arithmetic (e.g. 1 month from Jan 1 is Feb 1, 6 months from Jan 1 is July 1).
 */
export function calculateTreatmentEndDate(
  startDate: Date,
  durationValue: number,
  durationUnit: DurationUnit,
  timeZone = "Africa/Cairo",
): Date {
  const start = toMidnightInZone(startDate, timeZone);
  let end: DateTime;

  switch (durationUnit) {
    case "DAYS":
      end = start.plus({ days: durationValue });
      break;
    case "WEEKS":
      end = start.plus({ weeks: durationValue });
      break;
    case "MONTHS":
      end = start.plus({ months: durationValue });
      break;
    default:
      end = start.plus({ days: durationValue });
      break;
  }

  return new Date(end.toFormat("yyyy-MM-dd") + "T00:00:00.000Z");
}

/**
 * Calculates the expected depletion date for a given start date and days supply.
 */
export function calculateDepletionDate(
  startDate: Date,
  daysSupply: number,
  timeZone = "Africa/Cairo",
): Date {
  const start = toMidnightInZone(startDate, timeZone);
  const depletion = start.plus({ days: daysSupply });
  return new Date(depletion.toFormat("yyyy-MM-dd") + "T00:00:00.000Z");
}

/**
 * Calculates the refill due date (e.g., 5 days before depletion).
 */
export function calculateRefillDueDate(
  depletionDate: Date,
  leadDays = 5,
  timeZone = "Africa/Cairo",
): Date {
  const depletion = toMidnightInZone(depletionDate, timeZone);
  const due = depletion.minus({ days: leadDays });
  return new Date(due.toFormat("yyyy-MM-dd") + "T00:00:00.000Z");
}

/**
 * Calculates calendar days remaining between `now` and `targetDate`.
 * Returns negative numbers if targetDate has already passed.
 */
export function getDaysRemaining(
  targetDate: Date,
  now = new Date(),
  timeZone = "Africa/Cairo",
): number {
  const nowDate = toMidnightInZone(now, timeZone);
  const target = toMidnightInZone(targetDate, timeZone);
  const diff = target.diff(nowDate, "days").days;
  return Math.round(diff);
}

/**
 * Determines whether medication is approaching depletion within the warning window.
 */
export function isRefillApproachingDepletion(daysRemaining: number, leadDays = 5): boolean {
  return daysRemaining <= leadDays && daysRemaining > 1;
}

/**
 * Determines whether medication depletion is urgent (e.g. <= 1 day remaining).
 */
export function isRefillUrgentDepletion(daysRemaining: number, urgentDays = 1): boolean {
  return daysRemaining <= urgentDays && daysRemaining >= 0;
}

/**
 * Determines whether expected refill depletion date has passed without confirmation.
 */
export function isRefillOverdue(daysRemaining: number): boolean {
  return daysRemaining < 0;
}

/**
 * Generates the full treatment refill plan and cycles.
 */
export function calculateFullTreatmentPlan({
  startDate,
  durationValue,
  durationUnit,
  endDate,
  unitsPerPackage,
  unitsPerDose,
  dosesPerDay,
  timeZone = "Africa/Cairo",
  refillLeadDays = 5,
}: {
  startDate: Date;
  durationValue?: number | null;
  durationUnit?: DurationUnit | null;
  endDate?: Date | null;
  unitsPerPackage: number;
  unitsPerDose: number;
  dosesPerDay: number;
  timeZone?: string;
  refillLeadDays?: number;
}): TreatmentPlan {
  const finalEndDate =
    endDate ??
    (durationValue && durationUnit
      ? calculateTreatmentEndDate(startDate, durationValue, durationUnit, timeZone)
      : calculateTreatmentEndDate(startDate, 1, "MONTHS", timeZone));

  const startDt = toMidnightInZone(startDate, timeZone);
  const endDt = toMidnightInZone(finalEndDate, timeZone);
  const totalTreatmentDays = Math.max(1, Math.round(endDt.diff(startDt, "days").days));

  const dailyConsumption = calculateDailyConsumption(unitsPerDose, dosesPerDay);
  const daysSupplyPerPackage = calculateDaysSupply(unitsPerPackage, dailyConsumption);
  const totalPackagesNeeded = Math.ceil(totalTreatmentDays / daysSupplyPerPackage);

  const cycles: RefillCycle[] = [];
  let currentStart = startDt;
  let cycleIndex = 1;

  while (currentStart < endDt && cycleIndex <= totalPackagesNeeded) {
    const expectedRunOut = currentStart.plus({ days: daysSupplyPerPackage });
    const cycleStartDate = new Date(currentStart.toFormat("yyyy-MM-dd") + "T00:00:00.000Z");
    const cycleRunOutDate = new Date(expectedRunOut.toFormat("yyyy-MM-dd") + "T00:00:00.000Z");
    const cycleRefillDueDate = calculateRefillDueDate(cycleRunOutDate, refillLeadDays, timeZone);

    cycles.push({
      cycleNumber: cycleIndex,
      startDate: cycleStartDate,
      expectedRunOutDate: cycleRunOutDate,
      refillDueDate: cycleRefillDueDate,
      daysSupply: daysSupplyPerPackage,
      packagesCount: 1,
    });

    currentStart = expectedRunOut;
    cycleIndex++;
  }

  return {
    startDate: new Date(startDt.toFormat("yyyy-MM-dd") + "T00:00:00.000Z"),
    endDate: new Date(endDt.toFormat("yyyy-MM-dd") + "T00:00:00.000Z"),
    totalTreatmentDays,
    dailyConsumption,
    daysSupplyPerPackage,
    totalPackagesNeeded,
    cycles,
  };
}

/**
 * Calculates calendar days of treatment between start and end dates.
 */
export function calculateTreatmentDays(
  startDate: Date,
  endDate: Date,
  timeZone = "Africa/Cairo",
): number {
  const startDt = toMidnightInZone(startDate, timeZone);
  const endDt = toMidnightInZone(endDate, timeZone);
  return Math.max(1, Math.round(endDt.diff(startDt, "days").days));
}

/**
 * Calculates total packages needed for a given duration.
 */
export function calculateTotalPackages(
  totalDays: number,
  daysSupplyPerPackage: number,
): number {
  if (daysSupplyPerPackage <= 0) return 1;
  return Math.max(1, Math.ceil(totalDays / daysSupplyPerPackage));
}

/**
 * Calculates alert dates for lead warning (e.g. 5 days out) and urgent warning (e.g. 1 day out).
 */
export function calculateRefillAlertDates(
  depletionDate: Date,
  leadDays = 5,
  urgentDays = 1,
  timeZone = "Africa/Cairo",
): { warningDate: Date; urgentDate: Date } {
  const depletion = toMidnightInZone(depletionDate, timeZone);
  const warning = depletion.minus({ days: leadDays });
  const urgent = depletion.minus({ days: urgentDays });
  return {
    warningDate: new Date(warning.toFormat("yyyy-MM-dd") + "T00:00:00.000Z"),
    urgentDate: new Date(urgent.toFormat("yyyy-MM-dd") + "T00:00:00.000Z"),
  };
}

/**
 * Calculates calendar days remaining between now and target date.
 */
export function calculateDaysRemaining(
  targetDate: Date,
  now = new Date(),
  timeZone = "Africa/Cairo",
): number {
  return getDaysRemaining(targetDate, now, timeZone);
}

/**
 * Checks if current time is within pharmacy operating hours, or 24/7 if enabled.
 */
export function isOperatingHour(
  date: Date,
  is24Hours: boolean,
  startHour?: string | null,
  endHour?: string | null,
  timeZone = "Africa/Cairo",
): boolean {
  if (is24Hours) return true;
  if (!startHour || !endHour) return true;

  const dt = DateTime.fromJSDate(date, { zone: timeZone });
  const currentMinutes = dt.hour * 60 + dt.minute;

  const [sH, sM] = startHour.split(":").map(Number);
  const [eH, eM] = endHour.split(":").map(Number);
  const startMinutes = (sH ?? 8) * 60 + (sM ?? 0);
  const endMinutes = (eH ?? 22) * 60 + (eM ?? 0);

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

/**
 * Checks whether a treatment is still active.
 */
export function isTreatmentActive(currentDate: Date, treatmentEndDate: Date | null): boolean {
  if (!treatmentEndDate) return true;
  return currentDate.getTime() <= treatmentEndDate.getTime();
}

