import { prisma } from "@/server/db";
import type {
  DeliveryState,
  PatientStatus,
  ResponseState,
} from "@/generated/prisma/enums";

/**
 * Read models for the patient-facing screens.
 *
 * Queries live here rather than inline in pages for two reasons. They are
 * reused by more than one screen (the patient list, the dashboard counts and the
 * follow-up list all want the same adherence number), and — more importantly —
 * the adherence denominator is a clinical decision that must be defined exactly
 * once. Two screens computing "adherence" slightly differently is how a
 * pharmacist ends up distrusting both numbers.
 *
 * Every function takes an explicit `pharmacyId`. The tenant guard in
 * `@/server/db` rejects a query that does not scope to one, so this is enforced
 * rather than remembered.
 */

/**
 * Doses the patient never had a fair chance to take.
 *
 * Excluded from the denominator. `EXPIRED` is our own downtime and the
 * cancellations are our own schedule edits; counting them against the patient
 * would report our failures as their non-adherence.
 */
const NEVER_DELIVERED: DeliveryState[] = [
  "EXPIRED",
  "FAILED",
  "CANCELLED",
  "SUPERSEDED",
  "SKIPPED",
];

/** Responses that settle a dose. `NONE` is handled separately — see below. */
const ANSWERED: ResponseState[] = ["TAKEN", "TAKEN_LATE", "MISSED"];

/** Doses that were actually taken. The numerator. */
const TAKEN: ResponseState[] = ["TAKEN", "TAKEN_LATE"];

/**
 * The predicate deciding which doses are scorable, defined exactly once.
 *
 * Both the patient list and the patient detail screen need an adherence figure,
 * and if they each spell this out they will drift — one of them will forget the
 * `ruleEligible` clause, or count `FAILED` as a miss, and the same patient will
 * show 92% on one screen and 87% on the other on the same afternoon. A
 * pharmacist who catches that stops trusting both numbers.
 *
 * Deliberately returns the shared core only. Callers add their own patient scope
 * (`{ in: ids }` for a list, a single id for a detail view), because those two
 * shapes cannot be expressed as one parameter without either a cast or a union
 * that Prisma's generated types reject.
 *
 * THIS PREDICATE DEPENDS ON `settleNoResponse` AND CANNOT BE READ ALONE.
 *
 * `SCHEDULED` and `SENDING` are absent from `NEVER_DELIVERED`, so on its own this
 * predicate would call a never-sent dose "settled silence" and count our own
 * outage against the patient. What rules that out is not this file: it is that
 * `settleNoResponse` only ever stamps `settledAtUtc` on
 * `deliveryState IN ('SENT','DELIVERED','READ')`. A dose we never managed to
 * send therefore cannot satisfy the `NONE` + settled branch below, however long
 * it sits there.
 *
 * So the two files hold one invariant between them. Widening the `where` clause
 * in `settleNoResponse` — to sweep up stragglers, say — silently reaches in here
 * and starts reporting undelivered doses as missed medication. If you widen it,
 * add `SCHEDULED` and `SENDING` to `NEVER_DELIVERED` in the same change.
 * `tests/reports.test.ts` pins the current behaviour, mirrored key-for-key in
 * `@/server/queries/reports`.
 */
function scorableDoseCore(pharmacyId: string, since: Date) {
  return {
    pharmacyId,
    countedForAdherence: true,
    ruleEligible: true,
    doseAtUtc: { gte: since },
    deliveryState: { notIn: NEVER_DELIVERED },
    // A dose belongs in the denominator if the patient answered it, OR if it
    // went unanswered long enough to be settled. An unanswered dose that has NOT
    // yet settled is still in flight and must not be scored either way.
    OR: [
      { responseState: { in: ANSWERED } },
      { responseState: "NONE" as const, settledAtUtc: { not: null } },
    ],
  };
}

type AdherenceRow = {
  patientId: string;
  responseState: ResponseState;
  _count: { _all: number };
};

/** Fold grouped rows into per-patient taken/total pairs. */
function tallyAdherence(rows: AdherenceRow[]) {
  const tally = new Map<string, { taken: number; total: number }>();

  for (const row of rows) {
    const entry = tally.get(row.patientId) ?? { taken: 0, total: 0 };
    entry.total += row._count._all;
    if (TAKEN.includes(row.responseState)) entry.taken += row._count._all;
    tally.set(row.patientId, entry);
  }

  return tally;
}

/**
 * One patient's adherence over a window, or `null` when nothing was scorable.
 *
 * `null` rather than 0: a patient enrolled this morning has not missed anything,
 * and a rate of 0% would say they had.
 */
export async function getPatientAdherence(
  pharmacyId: string,
  patientId: string,
  windowDays = 30,
): Promise<number | null> {
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const rows = await prisma.reminderEvent.groupBy({
    by: ["patientId", "responseState"],
    where: { ...scorableDoseCore(pharmacyId, since), patientId },
    _count: { _all: true },
  });

  const entry = tallyAdherence(rows).get(patientId);
  return entry && entry.total > 0 ? entry.taken / entry.total : null;
}

// ─────────────────────────────────────────────────────────────────────────────

export type PatientListRow = {
  id: string;
  fullName: string;
  phoneE164: string;
  /** The enum, not `string`: the row feeds a `Record<PatientStatus, Tone>` map. */
  status: PatientStatus;
  enrolledAt: Date;
  medicationCount: number;
  activeScheduleCount: number;
  openCaseCount: number;
  openAlertCount: number;
  /** 0–1, or null when nothing in the window was scorable. */
  adherence: number | null;
  scorableDoses: number;
};

export type ListPatientsOptions = {
  search?: string;
  status?: "ACTIVE" | "PAUSED" | "ARCHIVED";
  limit?: number;
  offset?: number;
  /** Days of history the adherence figure covers. */
  windowDays?: number;
};

/**
 * The patient list.
 *
 * Not paginated by cursor: a single pharmacy's panel is tens to low hundreds of
 * patients, and an offset page is what makes "page 3 of the list I am looking
 * at" a stable idea for a pharmacist. If a pharmacy ever exceeds the limit this
 * has to become keyset pagination, and the `limit` cap below is what makes that
 * obvious rather than silent.
 */
export async function listPatients(
  pharmacyId: string,
  options: ListPatientsOptions = {},
): Promise<{ rows: PatientListRow[]; total: number }> {
  const { search, status, limit = 50, offset = 0, windowDays = 30 } = options;

  const since = new Date(Date.now() - windowDays * 86_400_000);

  const where = {
    pharmacyId,
    ...(status ? { status } : {}),
    ...(search && search.trim()
      ? {
          OR: [
            // `mode: "insensitive"` matters for the English half of the data and
            // for staff searching a Latin transliteration. Arabic has no case,
            // so this costs nothing there.
            { fullName: { contains: search.trim(), mode: "insensitive" as const } },
            { phoneE164: { contains: search.trim() } },
            { externalRef: { contains: search.trim(), mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [patients, total] = await Promise.all([
    prisma.patient.findMany({
      where,
      orderBy: { fullName: "asc" },
      take: Math.min(limit, 200),
      skip: offset,
      select: {
        id: true,
        fullName: true,
        phoneE164: true,
        status: true,
        createdAt: true,
        _count: {
          select: {
            medications: { where: { status: "ACTIVE" } },
            schedules: { where: { status: "ACTIVE" } },
            cases: { where: { status: { in: ["OPEN", "IN_PROGRESS", "WAITING_PATIENT"] } } },
          },
        },
      },
    }),
    prisma.patient.count({ where }),
  ]);

  if (patients.length === 0) return { rows: [], total };

  const ids = patients.map((p) => p.id);

  // One grouped query for the whole page instead of one per patient. This is the
  // query that would otherwise turn a 50-patient list into 51 round trips.
  const [scored, alerts] = await Promise.all([
    prisma.reminderEvent.groupBy({
      by: ["patientId", "responseState"],
      where: { ...scorableDoseCore(pharmacyId, since), patientId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.alert.groupBy({
      by: ["patientId"],
      where: {
        pharmacyId,
        patientId: { in: ids },
        status: { in: ["OPEN", "ACKNOWLEDGED"] },
      },
      _count: { _all: true },
    }),
  ]);

  const tally = tallyAdherence(scored);

  const alertCounts = new Map(alerts.map((a) => [a.patientId, a._count._all]));

  const rows: PatientListRow[] = patients.map((p) => {
    const scoredRow = tally.get(p.id);
    return {
      id: p.id,
      fullName: p.fullName,
      phoneE164: p.phoneE164,
      status: p.status,
      enrolledAt: p.createdAt,
      medicationCount: p._count.medications,
      activeScheduleCount: p._count.schedules,
      openCaseCount: p._count.cases,
      openAlertCount: alertCounts.get(p.id) ?? 0,
      // No scorable doses means no rate — NOT a rate of zero. A patient enrolled
      // yesterday has not missed anything, and showing 0% would say they had.
      adherence: scoredRow && scoredRow.total > 0 ? scoredRow.taken / scoredRow.total : null,
      scorableDoses: scoredRow?.total ?? 0,
    };
  });

  return { rows, total };
}

// ─────────────────────────────────────────────────────────────────────────────

export type PatientDetail = NonNullable<Awaited<ReturnType<typeof getPatientDetail>>>;

export async function getPatientDetail(pharmacyId: string, patientId: string) {
  const patient = await prisma.patient.findFirst({
    where: { id: patientId, pharmacyId },
    include: {
      consents: { orderBy: { grantedAt: "desc" } },
      medications: {
        orderBy: [{ status: "asc" }, { startedOn: "desc" }],
        include: {
          schedules: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              status: true,
              mode: true,
              timesOfDay: true,
              daysOfWeek: true,
              timeZone: true,
              startDate: true,
              endDate: true,
              revision: true,
              lateWindowMinutes: true,
            },
          },
        },
      },
      cases: {
        orderBy: { openedAtUtc: "desc" },
        take: 20,
        include: { interventions: { orderBy: { performedAtUtc: "desc" }, take: 5 } },
      },
    },
  });

  // `findFirst` scoped by pharmacyId, not `findUnique` by id: a patient belonging
  // to another pharmacy must be indistinguishable from one that does not exist.
  if (!patient) return null;

  return patient;
}

/**
 * A patient's live alerts.
 *
 * Separate from `getPatientDetail` because `Alert` has no back-relation on
 * `Patient` — it is reachable only by `patientId`, which is deliberate: an alert
 * is about a patient, but it is a pharmacy-level operational record, not part of
 * the patient's chart.
 *
 * Only live ones. A resolved alert rendered on this screen reads as a current
 * problem.
 */
export async function getPatientAlerts(pharmacyId: string, patientId: string, limit = 10) {
  return prisma.alert.findMany({
    where: { pharmacyId, patientId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    orderBy: [{ severity: "desc" }, { openedAtUtc: "desc" }],
    take: limit,
    select: {
      id: true,
      ruleKey: true,
      severity: true,
      status: true,
      titleAr: true,
      titleEn: true,
      detailAr: true,
      detailEn: true,
      openedAtUtc: true,
      occurrenceCount: true,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recent doses for one patient, with the answer attached.
 *
 * `responses` is a list rather than a single field because the schema permits
 * several: the design keeps the FIRST answer for adherence and every later one
 * for history, so a dose the patient tapped twice genuinely has two rows.
 */
export async function getRecentDoses(
  pharmacyId: string,
  patientId: string,
  limit = 50,
) {
  return prisma.reminderEvent.findMany({
    where: { pharmacyId, patientId },
    orderBy: { doseAtUtc: "desc" },
    take: limit,
    select: {
      id: true,
      kind: true,
      doseAtUtc: true,
      doseLocalDate: true,
      doseLocalTime: true,
      deliveryState: true,
      responseState: true,
      countedForAdherence: true,
      settledAtUtc: true,
      snoozeCount: true,
      medication: { select: { id: true, medicationNameText: true } },
      responses: {
        orderBy: { receivedAtUtc: "asc" },
        select: {
          id: true,
          answer: true,
          channel: true,
          source: true,
          isVerified: true,
          verificationState: true,
          appliedToAdherence: true,
          ruleEligible: true,
          staleFlag: true,
          freeText: true,
          receivedAtUtc: true,
        },
      },
    },
  });
}

/**
 * The open follow-up queue, worst first.
 *
 * Ordering is by severity then age: the pharmacist works down the list, so the
 * order IS the triage. `Severity` is declared LOW→URGENT in the schema, so
 * `desc` puts urgent at the top.
 */
export async function listOpenCases(pharmacyId: string, limit = 100) {
  return prisma.followUpCase.findMany({
    where: { pharmacyId, status: { in: ["OPEN", "IN_PROGRESS", "WAITING_PATIENT"] } },
    orderBy: [{ priority: "desc" }, { openedAtUtc: "asc" }],
    take: limit,
    include: {
      patient: { select: { id: true, fullName: true, phoneE164: true } },
      medication: { select: { id: true, medicationNameText: true } },
      interventions: { orderBy: { performedAtUtc: "desc" }, take: 1 },
      alerts: {
        where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        orderBy: { severity: "desc" },
        take: 3,
        select: { id: true, ruleKey: true, severity: true, titleAr: true, titleEn: true, openedAtUtc: true },
      },
    },
  });
}
