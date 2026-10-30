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
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const [memberships, directUsers] = await Promise.all([
    prisma.pharmacyMembership.findMany({
      where: { pharmacyId, userId: { in: unique } },
      select: { userId: true, user: { select: { fullName: true } } },
    }),
    prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, fullName: true },
    }),
  ]);

  const map = new Map<string, string>();
  for (const u of directUsers) {
    map.set(u.id, u.fullName);
  }
  for (const m of memberships) {
    map.set(m.userId, m.user.fullName);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Specialized Follow-up Queues (Problems & Missed/No-Response) & Intervention Log
// ─────────────────────────────────────────────────────────────────────────────

export type ProblemFollowUpRow = {
  id: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
  medicationName: string;
  problemSummary: string;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  status: CaseStatus;
  openedAtUtc: Date;
  dueByUtc: Date | null;
  pharmacistName: string | null;
  alertTitle: string | null;
  lastAction: string | null;
};

/**
 * Page 1: "المريض لديه مشكلة تتعلق بالدواء"
 * Returns open cases opened due to problem response, patient-reported issues, or urgent alerts.
 */
export async function getFollowUpProblemCases(
  pharmacyId: string,
  limit = 100,
): Promise<ProblemFollowUpRow[]> {
  const cases = await prisma.followUpCase.findMany({
    where: {
      pharmacyId,
      status: { in: ["OPEN", "IN_PROGRESS", "WAITING_PATIENT"] },
    },
    orderBy: [{ priority: "desc" }, { openedAtUtc: "asc" }],
    take: limit,
    include: {
      patient: { select: { id: true, fullName: true, phoneE164: true } },
      medication: { select: { id: true, medicationNameText: true } },
      interventions: { orderBy: { performedAtUtc: "desc" }, take: 1 },
      alerts: {
        where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        orderBy: { severity: "desc" },
        take: 1,
        select: { id: true, ruleKey: true, severity: true, titleAr: true, titleEn: true, detailAr: true },
      },
    },
  });

  const authorIds = [
    ...cases.map((c) => c.assigneeUserId).filter((id): id is string => Boolean(id)),
    ...cases.map((c) => c.interventions[0]?.performedByUserId).filter((id): id is string => Boolean(id)),
    ...cases.map((c) => c.openedByUserId).filter((id): id is string => Boolean(id)),
  ];

  const authors = await getInterventionAuthors(pharmacyId, authorIds);

  return cases.map((kase) => {
    const topAlert = kase.alerts[0];
    const lastIntervention = kase.interventions[0];
    const assignedId = kase.assigneeUserId ?? lastIntervention?.performedByUserId ?? kase.openedByUserId ?? null;

    let summary = kase.summary ?? topAlert?.detailAr ?? topAlert?.titleAr ?? "أبلغ المريض عن مشكلة أو استفسار دوائي";
    if (summary.startsWith("PROBLEM_")) {
      const map: Record<string, string> = {
        PROBLEM_SIDE_EFFECT: "عرض جانبي للدواء",
        PROBLEM_UNAVAILABLE: "الدواء غير متوفر لدى المريض",
        PROBLEM_CONFUSED: "استفسار أو عدم وضوح الجرعة",
        PROBLEM_WANTS_CALL: "طلب التحدث مع الصيدلي",
      };
      summary = map[summary] ?? summary;
    }

    return {
      id: kase.id,
      patientId: kase.patient.id,
      patientName: kase.patient.fullName,
      patientPhone: kase.patient.phoneE164,
      medicationName: kase.medication?.medicationNameText ?? "دواء غير محدد",
      problemSummary: summary,
      priority: kase.priority,
      status: kase.status,
      openedAtUtc: kase.openedAtUtc,
      dueByUtc: kase.dueByUtc,
      pharmacistName: assignedId ? authors.get(assignedId) ?? null : null,
      alertTitle: topAlert ? topAlert.titleAr ?? topAlert.titleEn : null,
      lastAction: lastIntervention?.notes ?? null,
    };
  });
}

export type MissedDoseFollowUpRow = {
  id: string; // reminderEventId
  patientId: string;
  patientName: string;
  patientPhone: string;
  medicationId: string;
  medicationName: string;
  doseTimeText: string;
  doseAtUtc: Date;
  state: "MISSED" | "NO_RESPONSE";
  pharmacistName: string | null;
  lastRemindedAtUtc: Date | null;
  caseId: string | null;
};

/**
 * Page 2: "المريض نسي تناول الدواء / لا يوجد رد"
 * Returns patients who missed a dose or did not respond in recent days.
 */
export async function getFollowUpMissedCases(
  pharmacyId: string,
  limit = 100,
): Promise<MissedDoseFollowUpRow[]> {
  const threeDaysAgo = new Date(Date.now() - 4 * 86_400_000);

  // 1. Fetch recent reminder events where patient missed dose or did not respond
  const events = await prisma.reminderEvent.findMany({
    where: {
      pharmacyId,
      doseAtUtc: { gte: threeDaysAgo },
      responseState: { in: ["MISSED", "NONE"] },
      deliveryState: { in: ["SENT", "DELIVERED", "READ"] },
      patient: { status: "ACTIVE" },
      medication: { status: "ACTIVE" },
    },
    orderBy: { doseAtUtc: "desc" },
    take: limit * 2,
    include: {
      patient: { select: { id: true, fullName: true, phoneE164: true, createdByUserId: true } },
      medication: { select: { id: true, medicationNameText: true } },
      schedule: { select: { id: true } },
    },
  });

  // Distinct by patientId + medicationId to show the latest occurrence per patient
  const seenKey = new Set<string>();
  const filteredEvents = events.filter((e) => {
    const key = `${e.patientId}:${e.medicationId}`;
    if (seenKey.has(key)) return false;
    seenKey.add(key);
    return true;
  }).slice(0, limit);

  // Find any active cases or interventions for these patients to attribute pharmacist
  const patientIds = filteredEvents.map((e) => e.patientId);

  const [activeCases, latestInterventions] = await Promise.all([
    prisma.followUpCase.findMany({
      where: {
        pharmacyId,
        patientId: { in: patientIds },
        status: { in: ["OPEN", "IN_PROGRESS", "WAITING_PATIENT"] },
      },
      select: { id: true, patientId: true, medicationId: true, assigneeUserId: true },
    }),
    prisma.pharmacistIntervention.findMany({
      where: { pharmacyId, patientId: { in: patientIds } },
      orderBy: { performedAtUtc: "desc" },
      distinct: ["patientId"],
      select: { patientId: true, performedByUserId: true },
    }),
  ]);

  const caseByPatient = new Map(activeCases.map((c) => [c.patientId, c]));
  const interventionByPatient = new Map(latestInterventions.map((i) => [i.patientId, i.performedByUserId]));

  const authorIds = [
    ...activeCases.map((c) => c.assigneeUserId).filter((id): id is string => Boolean(id)),
    ...latestInterventions.map((i) => i.performedByUserId),
    ...filteredEvents.map((e) => e.patient.createdByUserId).filter((id): id is string => Boolean(id)),
  ];

  const authors = await getInterventionAuthors(pharmacyId, authorIds);

  return filteredEvents.map((event) => {
    const activeCase = caseByPatient.get(event.patientId);
    const assignedId =
      activeCase?.assigneeUserId ??
      interventionByPatient.get(event.patientId) ??
      event.patient.createdByUserId ??
      null;

    return {
      id: event.id,
      patientId: event.patient.id,
      patientName: event.patient.fullName,
      patientPhone: event.patient.phoneE164,
      medicationId: event.medication.id,
      medicationName: event.medication.medicationNameText,
      doseTimeText: `${event.doseLocalDate.toISOString().slice(0, 10)} ${event.doseLocalTime}`,
      doseAtUtc: event.doseAtUtc,
      state: event.responseState === "MISSED" ? "MISSED" : "NO_RESPONSE",
      pharmacistName: assignedId ? authors.get(assignedId) ?? null : null,
      lastRemindedAtUtc: event.doseAtUtc,
      caseId: activeCase?.id ?? null,
    };
  });
}

export type ClinicalInterventionLogRow = {
  id: string;
  performedAtUtc: Date;
  patientId: string;
  patientName: string;
  patientPhone: string;
  medicationName: string | null;
  pharmacistName: string | null;
  interventionType: string;
  category: "SIDE_EFFECT" | "DOCTOR_REFERRAL" | "DRUG_INTERACTION" | "DOSE_CLARIFICATION" | "GENERAL";
  categoryLabelAr: string;
  notes: string;
  outcome: string;
  outcomeLabelAr: string;
  caseId: string | null;
};

/**
 * Page 3 / Tab: سجل التدخلات السريرية (Clinical Intervention Log)
 * Returns all clinical interventions with parsed categories and pharmacist names.
 */
export async function getClinicalInterventionsLog(
  pharmacyId: string,
  limit = 100,
): Promise<ClinicalInterventionLogRow[]> {
  const interventions = await prisma.pharmacistIntervention.findMany({
    where: { pharmacyId },
    orderBy: { performedAtUtc: "desc" },
    take: limit,
    include: {
      patient: { select: { id: true, fullName: true, phoneE164: true } },
      medication: { select: { id: true, medicationNameText: true } },
    },
  });

  const authorIds = interventions.map((i) => i.performedByUserId);
  const authors = await getInterventionAuthors(pharmacyId, authorIds);

  const outcomeLabels: Record<string, string> = {
    REACHED: "تم التواصل مع المريض",
    NO_ANSWER: "لا يوجد رد",
    LEFT_MESSAGE: "تم ترك رسالة للمريض",
    PATIENT_CONFIRMED: "أكد المريض اتباع التوجيه",
    PATIENT_DENIED: "رفض المريض التوجيه",
    UNABLE_TO_CONTACT: "تعذر الاتصال",
  };

  return interventions.map((item) => {
    const rawNotes = item.notes ?? "";

    // Parse category from notes if tagged
    let category: ClinicalInterventionLogRow["category"] = "GENERAL";
    let categoryLabelAr = "تدخل وتثقيف عام";

    if (rawNotes.includes("[SIDE_EFFECT]") || item.interventionType === "PATIENT_EDUCATION") {
      category = "SIDE_EFFECT";
      categoryLabelAr = "التعامل مع عرض جانبي";
    } else if (rawNotes.includes("[DOCTOR_REFERRAL]") || item.interventionType === "REFERRAL") {
      category = "DOCTOR_REFERRAL";
      categoryLabelAr = "تحويل إلى الطبيب المعالج";
    } else if (rawNotes.includes("[DRUG_INTERACTION]")) {
      category = "DRUG_INTERACTION";
      categoryLabelAr = "تداخل دوائي";
    } else if (rawNotes.includes("[DOSE_CLARIFICATION]") || item.interventionType === "DOSE_CHANGE") {
      category = "DOSE_CLARIFICATION";
      categoryLabelAr = "توضيح وتعديل الجرعة";
    }

    const cleanNotes = rawNotes
      .replace(/\[(SIDE_EFFECT|DOCTOR_REFERRAL|DRUG_INTERACTION|DOSE_CLARIFICATION|GENERAL)\]/g, "")
      .trim();

    return {
      id: item.id,
      performedAtUtc: item.performedAtUtc,
      patientId: item.patient.id,
      patientName: item.patient.fullName,
      patientPhone: item.patient.phoneE164,
      medicationName: item.medication?.medicationNameText ?? null,
      pharmacistName: authors.get(item.performedByUserId) ?? null,
      interventionType: item.interventionType,
      category,
      categoryLabelAr,
      notes: cleanNotes || "تم تقديم الاستشارة والمتابعة الصيدلانية",
      outcome: item.outcome,
      outcomeLabelAr: outcomeLabels[item.outcome] ?? item.outcome,
      caseId: item.caseId,
    };
  });
}
