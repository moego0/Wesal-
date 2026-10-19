import { describe, expect, it } from "vitest";
import {
  calculateDailyConsumption,
  calculateDaysSupply,
  calculateDepletionDate,
  calculateFullTreatmentPlan,
  calculateRefillAlertDates,
  calculateRefillDueDate,
  calculateTreatmentEndDate,
  getDaysRemaining,
  isOperatingHour,
  isRefillApproachingDepletion,
  isRefillOverdue,
  isRefillUrgentDepletion,
  isTreatmentActive,
} from "../src/lib/refills";

describe("refills calculation module", () => {
  it("calculates daily consumption accurately", () => {
    expect(calculateDailyConsumption(1, 1)).toBe(1);
    expect(calculateDailyConsumption(1, 2)).toBe(2);
    expect(calculateDailyConsumption(2, 3)).toBe(6);
    expect(calculateDailyConsumption(0.5, 2)).toBe(1);
    expect(calculateDailyConsumption(0, 1)).toBe(1); // fallback
  });

  it("calculates days supply accurately", () => {
    expect(calculateDaysSupply(30, 1)).toBe(30);
    expect(calculateDaysSupply(30, 2)).toBe(15);
    expect(calculateDaysSupply(20, 3)).toBe(6);
    expect(calculateDaysSupply(60, 2)).toBe(30);
  });

  it("calculates treatment end dates with calendar month variations", () => {
    const startJan = new Date("2026-01-01T00:00:00.000Z");
    // 1 month from Jan 1 is Feb 1 (31 days)
    const end1Month = calculateTreatmentEndDate(startJan, 1, "MONTHS");
    expect(end1Month.toISOString().slice(0, 10)).toBe("2026-02-01");

    // 6 months from Jan 1 is July 1 (181 days)
    const end6Months = calculateTreatmentEndDate(startJan, 6, "MONTHS");
    expect(end6Months.toISOString().slice(0, 10)).toBe("2026-07-01");

    // 2 weeks from Jan 1 is Jan 15
    const end2Weeks = calculateTreatmentEndDate(startJan, 2, "WEEKS");
    expect(end2Weeks.toISOString().slice(0, 10)).toBe("2026-01-15");

    // 10 days from Jan 1 is Jan 11
    const end10Days = calculateTreatmentEndDate(startJan, 10, "DAYS");
    expect(end10Days.toISOString().slice(0, 10)).toBe("2026-01-11");
  });

  it("calculates depletion date and refill due date", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    const depletion = calculateDepletionDate(start, 30);
    expect(depletion.toISOString().slice(0, 10)).toBe("2026-01-31");

    const refillDue = calculateRefillDueDate(depletion, 5);
    expect(refillDue.toISOString().slice(0, 10)).toBe("2026-01-26");
  });

  it("calculates days remaining and alert thresholds correctly", () => {
    const now = new Date("2026-01-20T00:00:00.000Z");
    const runOut = new Date("2026-01-25T00:00:00.000Z");

    const daysRemaining = getDaysRemaining(runOut, now);
    expect(daysRemaining).toBe(5);

    expect(isRefillApproachingDepletion(daysRemaining, 5)).toBe(true);
    expect(isRefillUrgentDepletion(daysRemaining, 1)).toBe(false);
    expect(isRefillOverdue(daysRemaining)).toBe(false);

    // Urgent case: 1 day remaining
    const urgentDays = getDaysRemaining(new Date("2026-01-21T00:00:00.000Z"), now);
    expect(urgentDays).toBe(1);
    expect(isRefillUrgentDepletion(urgentDays, 1)).toBe(true);

    // Overdue case
    const overdueDays = getDaysRemaining(new Date("2026-01-19T00:00:00.000Z"), now);
    expect(overdueDays).toBe(-1);
    expect(isRefillOverdue(overdueDays)).toBe(true);
  });

  it("generates full treatment plan according to user example", () => {
    // Prompt Example:
    // Package: 30 tablets
    // Dosage: 1 tablet daily
    // Treatment duration: 6 months
    // One package lasts 30 days
    // Patient requires approximately 6 packages throughout treatment
    const plan = calculateFullTreatmentPlan({
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      durationValue: 6,
      durationUnit: "MONTHS",
      unitsPerPackage: 30,
      unitsPerDose: 1,
      dosesPerDay: 1,
      refillLeadDays: 5,
    });

    expect(plan.dailyConsumption).toBe(1);
    expect(plan.daysSupplyPerPackage).toBe(30);
    expect(plan.totalPackagesNeeded).toBe(7); // 181 days / 30 = 6.03 -> 7 packages to cover full 181 days
    expect(plan.cycles.length).toBeGreaterThanOrEqual(6);

    const firstCycle = plan.cycles[0];
    expect(firstCycle.cycleNumber).toBe(1);
    expect(firstCycle.startDate.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(firstCycle.expectedRunOutDate.toISOString().slice(0, 10)).toBe("2026-01-31");
    expect(firstCycle.refillDueDate.toISOString().slice(0, 10)).toBe("2026-01-26");

    const secondCycle = plan.cycles[1];
    expect(secondCycle.cycleNumber).toBe(2);
    expect(secondCycle.startDate.toISOString().slice(0, 10)).toBe("2026-01-31");
    expect(secondCycle.expectedRunOutDate.toISOString().slice(0, 10)).toBe("2026-03-02");
  });

  it("calculates alert dates accurately for lead and urgent warnings", () => {
    const depletion = new Date("2026-01-30T00:00:00.000Z");
    const { warningDate, urgentDate } = calculateRefillAlertDates(depletion, 5, 1);
    expect(warningDate.toISOString().slice(0, 10)).toBe("2026-01-25");
    expect(urgentDate.toISOString().slice(0, 10)).toBe("2026-01-29");
  });

  it("evaluates pharmacy operating hours with 24-hour toggle and configured hours", () => {
    // 24-hour pharmacy always returns true
    const morning = new Date("2026-01-01T04:00:00.000Z");
    expect(isOperatingHour(morning, true, "08:00", "22:00")).toBe(true);

    // Non-24h pharmacy: 09:00 Cairo time should be within 08:00 to 22:00
    // UTC 07:00 is 09:00 Cairo (UTC+2)
    const insideHours = new Date("2026-01-01T07:00:00.000Z");
    expect(isOperatingHour(insideHours, false, "08:00", "22:00", "Africa/Cairo")).toBe(true);

    // UTC 03:00 is 05:00 Cairo (outside 08:00-22:00)
    const outsideHours = new Date("2026-01-01T03:00:00.000Z");
    expect(isOperatingHour(outsideHours, false, "08:00", "22:00", "Africa/Cairo")).toBe(false);
  });

  it("correctly identifies active treatment vs expired treatment", () => {
    const end = new Date("2026-06-01T00:00:00.000Z");
    const beforeEnd = new Date("2026-05-15T00:00:00.000Z");
    const afterEnd = new Date("2026-06-05T00:00:00.000Z");

    expect(isTreatmentActive(beforeEnd, end)).toBe(true);
    expect(isTreatmentActive(afterEnd, end)).toBe(false);
    expect(isTreatmentActive(afterEnd, null)).toBe(true); // Ongoing / no end date
  });
});

