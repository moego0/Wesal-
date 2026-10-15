import type { CaseStatus } from "@/generated/prisma/enums";
import { prisma } from "@/server/db";

/**
 * Reads and rules for the follow-up screens.
 *
 * `listOpenCases` in `./patients` already serves the queue — it is the triage
 * ordering, and it was written to be shared rather than copied. What lives here
 * is what the queue does not need: the case record itself, with the alerts that
 * opened it and the full intervention history.
 *
 * ## Why the state machine is in a queries module
 *
 * A `"use server"` file may only export async functions, so the transition table
 * cannot live beside the action that enforces it. It is here instead of being
 * written out twice, because the screen has to offer only the moves the action
 * will accept — a pharmacist shown a control that is going to be refused has
 * been given a dead end, and two copies of this table would drift apart the
 * first time someone adds a status.
 */

/**
 * Which status a case may move to next.
 *
 * A case is worked in one direction — `OPEN` → `IN_PROGRESS` →
 * `WAITING_PATIENT` — and ends in one of the two terminal states. `RESOLVED` and
 * `CLOSED_NO_ACTION` are absorbing on purpose: reopening a closed case would
 * quietly erase the fact that someone decided it was finished, and a genuinely
 * recurring problem deserves a new case with its own record and its own
 * intervention history rather than a resurrected old one.
 *
 * Moving BACKWARDS among the live states is allowed. A pharmacist marks a case
 * in progress, then finds the patient was in hospital and the case is really
 * waiting on them; or the patient replies and it is in progress again. The
 * workflow states are a description of where the case is, not a ladder to be
 * climbed once, and locking the order would only teach people to pick the wrong
 * one to avoid being stuck.
 *
 * Every live state can close directly, because that is the commonest path of
 * all: the pharmacist picks up the phone, sorts it out, and the case is done.
 */
export const CASE_STATUS_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  OPEN: ["IN_PROGRESS", "WAITING_PATIENT", "RESOLVED", "CLOSED_NO_ACTION"],
  IN_PROGRESS: ["OPEN", "WAITING_PATIENT", "RESOLVED", "CLOSED_NO_ACTION"],
  WAITING_PATIENT: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED_NO_ACTION"],
  RESOLVED: [],
  CLOSED_NO_ACTION: [],
};

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_STATUS_TRANSITIONS[from].includes(to);
}

/** A case nobody has to work on any more. */
export function isTerminalStatus(status: CaseStatus): boolean {
  return CASE_STATUS_TRANSITIONS[status].length === 0;
}

// ─────────────────────────────────────────────────────────────────────────────

export type CaseDetail = NonNullable<Awaited<ReturnType<typeof getCaseDetail>>>;

/**
 * One case, with everything the pharmacist needs to act on it.
 *
 * `findFirst` scoped by `pharmacyId`, not `findUnique` by id: a case belonging
 * to another pharmacy has to be indistinguishable from one that does not exist,
 * and this is the query where that is decided.
 *
 * The alerts are the case's justification — a case opened by a rule is not
 * answerable without the evidence that fired it, so `evidence` is selected
 * rather than looked up separately on a screen that already has the alert row in
 * hand.
 */
export async function getCaseDetail(pharmacyId: string, caseId: string) {
  return prisma.followUpCase.findFirst({
    where: { id: caseId, pharmacyId },
    include: {
      patient: { select: { id: true, fullName: true, phoneE164: true } },
      medication: {
        select: { id: true, medicationNameText: true, doseAmountText: true, status: true },
      },
      interventions: {
        orderBy: { performedAtUtc: "desc" },
        select: {
          id: true,
          interventionType: true,
          outcome: true,
          notes: true,
          performedAtUtc: true,
          durationSeconds: true,
          performedByUserId: true,
        },
      },
      alerts: {
        // Worst first, then newest: the alert that explains the case reads
        // first, and the same ordering as the queue means the two screens never
        // disagree about which alert matters.
        orderBy: [{ severity: "desc" }, { openedAtUtc: "desc" }],
        select: {
          id: true,
          ruleKey: true,
          ruleVersion: true,
          severity: true,
          status: true,
          titleAr: true,
          titleEn: true,
          detailAr: true,
          detailEn: true,
          evidence: true,
          openedAtUtc: true,
          resolvedAtUtc: true,
          occurrenceCount: true,
        },
      },
    },
  });
}

/**
 * Who recorded each intervention, for the timeline's attribution line.
 *
 * Resolved through `PharmacyMembership` rather than `User`: the id on a
 * `PharmacistIntervention` is a user id, but the question the timeline answers is
 * "which of us did this", and staff who have left the pharmacy are not part of
 * "us" any more. Someone with no membership simply has no name here, which is
 * the honest answer — the row itself still records who acted.
 *
 * `PharmacyMembership` is not a tenant model in the guard's sense (it is the
 * join table, not the row), so the `pharmacyId` predicate here is not enforced by
 * `@/server/db` — it is here because it is the correct scope.
 */
export async function getInterventionAuthors(
  pharmacyId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();

  const memberships = await prisma.pharmacyMembership.findMany({
    where: { pharmacyId, userId: { in: unique } },
    select: { userId: true, user: { select: { fullName: true } } },
  });

  return new Map(memberships.map((m) => [m.userId, m.user.fullName]));
}
