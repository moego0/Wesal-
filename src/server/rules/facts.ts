import type { DeliveryState, ResponseState } from "@/generated/prisma/enums";
import { systemPrisma } from "@/server/db";

/**
 * The fact book.
 *
 * Every clinical rule reads from this, and nothing else. Centralising the
 * derivation of a dose's outcome is what stops rule A and rule B disagreeing
 * about whether the same dose was taken — a class of bug that is nearly
 * impossible to find later, because both rules look individually correct.
 *
 * ## What counts as adherence
 *
 * The denominator is the doses we asked about and the patient could have
 * answered:
 *
 *   TAKEN + TAKEN_LATE + MISSED + NO_RESPONSE
 *
 * Deliberately EXCLUDED, each for a different reason:
 *
 *   - UNDELIVERED — we never sent it. The patient cannot be scored on a
 *     reminder that our own outage, an expired window, or a provider failure
 *     prevented. `EXPIRED` is our fault, and counting it as a miss would blame
 *     the patient for our downtime.
 *   - PENDING — the window has not closed. Counting it would make adherence
 *     drift downward purely as a function of the time of day the report is run.
 *   - PROBLEM — the patient told us something went wrong. That is engagement,
 *     not non-adherence, and it opens a case instead.
 *   - DEFERRED — the patient asked to be reminded later and the chain is still
 *     open. Scoring it now would penalise them for using the feature we offered.
 *
 * NO_RESPONSE is the one silence that does count: the reminder was delivered,
 * the window closed, and nothing came back.
 */

export type DoseOutcome =
  | "TAKEN"
  | "TAKEN_LATE"
  | "MISSED"
  | "NO_RESPONSE"
  | "PROBLEM"
  | "DEFERRED"
  | "UNDELIVERED"
  | "PENDING";

export type DoseFact = {
  eventId: string;
  scheduleId: string;
  medicationId: string;
  medicationName: string;
  doseAtUtc: Date;
  doseLocalDate: Date;
  deliveryState: DeliveryState;
  responseState: ResponseState;
  settledAtUtc: Date | null;
  lateReopen: boolean;
  /** The projection's own eligibility gate — false for stale/ambiguous rows. */
  ruleEligible: boolean;
  countedForAdherence: boolean;
  outcome: DoseOutcome;
};

/** Present in the denominators of every adherence calculation. */
export const SCORED_OUTCOMES: DoseOutcome[] = ["TAKEN", "TAKEN_LATE", "MISSED", "NO_RESPONSE"];
export const ADHERENT_OUTCOMES: DoseOutcome[] = ["TAKEN", "TAKEN_LATE"];

type EventRow = {
  id: string;
  scheduleId: string;
  medicationId: string;
  doseAtUtc: Date;
  doseLocalDate: Date;
  deliveryState: DeliveryState;
  responseState: ResponseState;
  settledAtUtc: Date | null;
  lateReopen: boolean;
  ruleEligible: boolean;
  countedForAdherence: boolean;
  kind: string;
  parentEventId: string | null;
  medication?: { medicationNameText: string } | null;
};

/**
 * Derive one dose's outcome. Pure, so it can be tested without a database and
 * so the rules that consume it cannot each invent their own interpretation.
 */
export function deriveDoseOutcome(
  event: EventRow,
  children: EventRow[] = [],
): DoseOutcome {
  // A reminder that never reached the patient is not evidence about the patient.
  if (
    event.deliveryState === "EXPIRED" ||
    event.deliveryState === "CANCELLED" ||
    event.deliveryState === "SUPERSEDED" ||
    event.deliveryState === "SKIPPED" ||
    event.deliveryState === "FAILED"
  ) {
    return "UNDELIVERED";
  }

  if (event.deliveryState === "SCHEDULED" || event.deliveryState === "SENDING") {
    return "PENDING";
  }

  switch (event.responseState) {
    case "TAKEN":
      return "TAKEN";
    case "TAKEN_LATE":
      return "TAKEN_LATE";
    case "MISSED":
      return "MISSED";
    case "PROBLEM":
      return "PROBLEM";

    case "REMIND_LATER": {
      // The dose's real outcome is whatever came of the snooze. Following the
      // chain is the difference between "the patient deferred twice and then
      // took it" reading as adherence and reading as a miss.
      const answered = children
        .filter((c) => c.kind === "SNOOZE")
        .sort((a, b) => a.doseAtUtc.getTime() - b.doseAtUtc.getTime())
        .find((c) => c.responseState !== "NONE" && c.responseState !== "REMIND_LATER");

      if (answered) return deriveDoseOutcome(answered, []);

      const anySettled = children.some((c) => c.kind === "SNOOZE" && c.settledAtUtc);
      const snoozeStillOpen = children.some(
        (c) => c.kind === "SNOOZE" && c.settledAtUtc === null && c.responseState === "NONE",
      );

      if (snoozeStillOpen) return "DEFERRED";
      if (anySettled) {
        // They were reminded again and still said nothing. That silence is now
        // the dose's outcome.
        return "NO_RESPONSE";
      }
      return "DEFERRED";
    }

    case "UNATTRIBUTED":
      return "DEFERRED";

    case "NONE":
    default:
      // Settled with no reply: the reminder was delivered and the window closed.
      return event.settledAtUtc ? "NO_RESPONSE" : "PENDING";
  }
}

export type FactBook = {
  patientId: string;
  now: Date;
  doses: DoseFact[];
  byMedication: Map<string, DoseFact[]>;
};

/**
 * Build the fact book for one patient.
 *
 * Bounded by `sinceDays`. An unbounded scan would make an eight-month-old
 * patient slower to evaluate than a new one, and every rule here works over a
 * recent window anyway.
 */
export async function buildFactBook(
  patientId: string,
  now: Date,
  sinceDays = 120,
): Promise<FactBook> {
  const since = new Date(now.getTime() - sinceDays * 86_400_000);

  const rows: EventRow[] = await systemPrisma.reminderEvent.findMany({
    where: {
      patientId,
      doseAtUtc: { gte: since, lte: now },
    },
    orderBy: { doseAtUtc: "asc" },
    select: {
      id: true,
      scheduleId: true,
      medicationId: true,
      doseAtUtc: true,
      doseLocalDate: true,
      deliveryState: true,
      responseState: true,
      settledAtUtc: true,
      lateReopen: true,
      ruleEligible: true,
      countedForAdherence: true,
      kind: true,
      parentEventId: true,
      medication: { select: { medicationNameText: true } },
    },
  });

  const childrenByParent = new Map<string, EventRow[]>();
  for (const row of rows) {
    if (!row.parentEventId) continue;
    const list = childrenByParent.get(row.parentEventId) ?? [];
    list.push(row);
    childrenByParent.set(row.parentEventId, list);
  }

  const doses: DoseFact[] = rows
    // Snooze children are not doses. They are folded into their parent's outcome
    // by `deriveDoseOutcome`, and counting them separately would double-count a
    // single missed dose every time the patient asked to be reminded later.
    .filter((row) => row.kind === "SCHEDULED_DOSE")
    .map((row) => ({
      eventId: row.id,
      scheduleId: row.scheduleId,
      medicationId: row.medicationId,
      medicationName: row.medication?.medicationNameText ?? "",
      doseAtUtc: row.doseAtUtc,
      doseLocalDate: row.doseLocalDate,
      deliveryState: row.deliveryState,
      responseState: row.responseState,
      settledAtUtc: row.settledAtUtc,
      lateReopen: row.lateReopen,
      // A dose the projection marked ineligible (a stale or ambiguous response)
      // is excluded from the fact book entirely, so it can neither manufacture a
      // "3 misses in a row" alert nor mask a real one.
      ruleEligible: row.ruleEligible,
      countedForAdherence: row.countedForAdherence,
      outcome: deriveDoseOutcome(row, childrenByParent.get(row.id) ?? []),
    }))
    .filter((dose) => dose.ruleEligible && dose.countedForAdherence);

  const byMedication = new Map<string, DoseFact[]>();
  for (const dose of doses) {
    const list = byMedication.get(dose.medicationId) ?? [];
    list.push(dose);
    byMedication.set(dose.medicationId, list);
  }

  return { patientId, now, doses, byMedication };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregates. Pure functions over facts — used by the catalog and by reporting,
// so the dashboard and the rules cannot disagree about a patient's adherence.
// ─────────────────────────────────────────────────────────────────────────────

export function adherenceRate(doses: DoseFact[]): number | null {
  const scored = doses.filter((d) => SCORED_OUTCOMES.includes(d.outcome));
  if (scored.length === 0) return null;

  const adherent = scored.filter((d) => ADHERENT_OUTCOMES.includes(d.outcome));
  return adherent.length / scored.length;
}

export function countBy(doses: DoseFact[], outcome: DoseOutcome): number {
  return doses.filter((d) => d.outcome === outcome).length;
}

/**
 * Length of the run of `predicate`-satisfying doses at the END of the list.
 *
 * Strictly trailing, and stops at the first dose that does not satisfy it — so a
 * patient who missed three, took one, then missed three has a current streak of
 * three, not six. A non-trailing count would keep an alert open forever after a
 * single bad week.
 */
export function trailingStreak(
  doses: DoseFact[],
  predicate: (dose: DoseFact) => boolean,
): number {
  let streak = 0;
  for (let i = doses.length - 1; i >= 0; i -= 1) {
    if (!predicate(doses[i])) break;
    streak += 1;
  }
  return streak;
}

/** Doses strictly after `since`. */
export function since(doses: DoseFact[], at: Date): DoseFact[] {
  return doses.filter((d) => d.doseAtUtc.getTime() >= at.getTime());
}

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
