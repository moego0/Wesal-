import type {
  DeliveryState,
  ResponseState,
  VerificationState,
} from "@/generated/prisma/enums";
import { prisma } from "@/server/db";

/**
 * Read models for the two operational screens: the delivery history
 * (`/messages`) and the reports page (`/reports`).
 *
 * Both live here rather than inline in their pages for the same reason
 * `patients.ts` exists: they are decision-making queries (denominators,
 * windows, exclusions) and a number a pharmacist acts on has to be defined in
 * exactly one place.
 *
 * ## The one rule this module is built around
 *
 * Delivery, patient-reported response and verified outcome are THREE different
 * facts about the same dose, and the product requirement is explicit that they
 * are reported separately and never conflated:
 *
 *   - Delivery is OUR infrastructure. It says what happened to the message.
 *   - Response is what the PATIENT SAID. Patient-reported, never verified.
 *   - Verification is the only section a pharmacist has confirmed or corrected.
 *
 * A dose can be `DELIVERED` with no reply, or `EXPIRED` (our downtime) with the
 * patient never asked at all. Merging those into one "adherence" number would
 * blame the patient for our outage, which is precisely what the PRD forbids.
 *
 * ## The adherence predicate is mirrored, not re-derived
 *
 * `scorableDoseCore` in `src/server/queries/patients.ts` is the single
 * definition of which doses may be scored against a patient. This module
 * contains a deliberate copy of it (@see `scorableDoseCore` below). That file
 * could not be edited when this module was written, and a report that computed
 * adherence from a looser predicate than the patient list would produce two
 * different numbers for the same patient on the same afternoon — after which a
 * pharmacist stops trusting both. If the shared predicate changes, this copy
 * must change with it; the comment on the copy says so.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared predicate — a mirror of `scorableDoseCore` in patients.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Doses the patient never had a fair chance to take. Excluded from the
 * denominator. `EXPIRED` is our own downtime and the cancellations are our own
 * schedule edits; counting them against the patient would report our failures
 * as their non-adherence.
 *
 * Mirrors `NEVER_DELIVERED` in `src/server/queries/patients.ts`.
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

/** Doses that were actually taken. The numerator of the adherence rate. */
const TAKEN: ResponseState[] = ["TAKEN", "TAKEN_LATE"];

/** Delivery states that mean a message actually left us. */
const ATTEMPTED: DeliveryState[] = ["SENDING", "SENT", "DELIVERED", "READ"];

/**
 * MIRROR of `scorableDoseCore` in `src/server/queries/patients.ts`.
 *
 * The clause list is intentional and must stay key-for-key identical to the
 * private helper there: pharmacy scope, `countedForAdherence`, `ruleEligible`,
 * the `NEVER_DELIVERED` exclusion, and the OR that only settles an unanswered
 * dose once `settledAtUtc` is stamped. A divergence here would make the report
 * and the patient list disagree about the same patient.
 *
 * The only difference is the upper bound of the window (`lt: until`). It is a
 * no-op for scoring — a future or in-flight dose is already excluded by the OR,
 * because it is neither answered nor settled — and exists so the response
 * numbers and the delivery numbers on the report describe the same instant
 * range. Without it, a dose still in the future would sit in the response
 * denominator's universe as a `NONE` that has not settled, which is invisible
 * in the totals but makes the two sections' windows quietly different.
 */
function scorableDoseCore(pharmacyId: string, since: Date, until: Date) {
  return {
    pharmacyId,
    countedForAdherence: true,
    ruleEligible: true,
    doseAtUtc: { gte: since, lt: until },
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

// ─────────────────────────────────────────────────────────────────────────────
// Delivery history — the `/messages` screen
// ─────────────────────────────────────────────────────────────────────────────

/** A log screen opens on a small page; the total is what carries the scale. */
export const DELIVERY_HISTORY_DEFAULT_LIMIT = 25;

/**
 * Hard cap, enforced here and not only in the page.
 *
 * A pharmacy's send history grows without bound — it is the one table in this
 * product that has a row per patient per dose per day, forever. Without a cap
 * somebody eventually loads all of it into one page, and the failure arrives as
 * a request that looks fine in development and times out in the third year of
 * production. The cap makes the limit explicit rather than accidental.
 */
export const DELIVERY_HISTORY_MAX_LIMIT = 100;

export type DeliveryHistoryOptions = {
  /** Matched against the patient's name and phone number. */
  patientQuery?: string;
  deliveryState?: DeliveryState;
  responseState?: ResponseState;
  /** Inclusive local calendar day, matching `doseLocalDate`. */
  from?: Date;
  /** Inclusive local calendar day, matching `doseLocalDate`. */
  to?: Date;
  limit?: number;
  offset?: number;
};

export type DeliveryHistoryRow = {
  id: string;
  patientId: string;
  patientName: string;
  medicationName: string;
  /** The patient's local calendar day and wall-clock time the dose belonged to. */
  doseLocalDate: Date;
  doseLocalTime: string;
  deliveryState: DeliveryState;
  responseState: ResponseState;
  /** Set when silence was recorded as the final disposition. */
  settledAtUtc: Date | null;
  /** Rows in `ReminderDispatch`: how many sends were actually attempted. */
  dispatchCount: number;
  /**
   * The most recent failed attempt's reason, `errorMessage` falling back to
   * `errorCode`. Null when no attempt failed.
   */
  lastFailure: string | null;
  /** When the patient's FIRST reply to this dose arrived. */
  responseReceivedAtUtc: Date | null;
  /** The patient's own words, when the reply carried any. */
  responseFreeText: string | null;
};

/**
 * The delivery history: every reminder we materialized in the window, what the
 * infrastructure did with it, and what came back.
 *
 * This is the screen a pharmacist opens when a patient says "you never messaged
 * me", so it must be able to show all three of: a dose we never delivered
 * (ours), a dose delivered that the patient ignored (should have been visible,
 * no answer), and a dose delivered three times and rejected every time (ours
 * again, in a different way). Hence the dispatch count and last failure on each
 * row: "sent 3 times, all rejected" and "never attempted" are the same
 * `deliveryState` in two very different situations.
 *
 * Date filtering is on `doseLocalDate`, the patient's local calendar day. That
 * is the day the pharmacist means by "yesterday", and it is a stored column
 * rather than a UTC conversion done at query time. Ordering is by `doseAtUtc`
 * (indexed together with `pharmacyId`) with `id` as a tiebreak, so paging is
 * stable when two doses share an instant.
 */
export async function listDeliveryHistory(
  pharmacyId: string,
  options: DeliveryHistoryOptions = {},
): Promise<{ rows: DeliveryHistoryRow[]; total: number }> {
  const { patientQuery, deliveryState, responseState, from, to } = options;
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? DELIVERY_HISTORY_DEFAULT_LIMIT), 1),
    DELIVERY_HISTORY_MAX_LIMIT,
  );
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);

  const search = patientQuery?.trim();

  const where = {
    pharmacyId,
    ...(search
      ? {
          patient: {
            OR: [
              // Insensitive: the English half of the data and Latin
              // transliterations are searched case-insensitively, which costs
              // nothing in Arabic (no case).
              { fullName: { contains: search, mode: "insensitive" as const } },
              { phoneE164: { contains: search } },
            ],
          },
        }
      : {}),
    ...(deliveryState ? { deliveryState } : {}),
    ...(responseState ? { responseState } : {}),
    ...(from || to
      ? {
          doseLocalDate: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };

  const [events, total] = await Promise.all([
    prisma.reminderEvent.findMany({
      where,
      orderBy: [{ doseAtUtc: "desc" }, { id: "desc" }],
      take: limit,
      skip: offset,
      select: {
        id: true,
        doseLocalDate: true,
        doseLocalTime: true,
        deliveryState: true,
        responseState: true,
        settledAtUtc: true,
        attemptCount: true,
        patient: { select: { id: true, fullName: true } },
        medication: { select: { medicationNameText: true } },
        responses: {
          orderBy: { receivedAtUtc: "asc" },
          take: 1,
          select: { receivedAtUtc: true, freeText: true },
        },
      },
    }),
    prisma.reminderEvent.count({ where }),
  ]);

  if (events.length === 0) return { rows: [], total };

  // One query for the whole page's dispatch attempts rather than one per row.
  const dispatches = await prisma.reminderDispatch.findMany({
    where: { pharmacyId, reminderEventId: { in: events.map((e) => e.id) } },
    orderBy: { attemptNo: "asc" },
    select: {
      reminderEventId: true,
      attemptNo: true,
      status: true,
      errorCode: true,
      errorMessage: true,
    },
  });

  const dispatchTally = new Map<
    string,
    { count: number; lastFailure: string | null; lastFailureAttemptNo: number }
  >();

  for (const dispatch of dispatches) {
    const entry = dispatchTally.get(dispatch.reminderEventId) ?? {
      count: 0,
      lastFailure: null,
      lastFailureAttemptNo: -1,
    };
    entry.count += 1;

    if (dispatch.status === "FAILED" && dispatch.attemptNo > entry.lastFailureAttemptNo) {
      entry.lastFailureAttemptNo = dispatch.attemptNo;
      entry.lastFailure =
        dispatch.errorMessage?.trim() || dispatch.errorCode?.trim() || null;
    }

    dispatchTally.set(dispatch.reminderEventId, entry);
  }

  const rows: DeliveryHistoryRow[] = events.map((event) => {
    const tally = dispatchTally.get(event.id);
    const firstResponse = event.responses[0];

    return {
      id: event.id,
      patientId: event.patient.id,
      patientName: event.patient.fullName,
      medicationName: event.medication.medicationNameText,
      doseLocalDate: event.doseLocalDate,
      doseLocalTime: event.doseLocalTime,
      deliveryState: event.deliveryState,
      responseState: event.responseState,
      settledAtUtc: event.settledAtUtc,
      // `attemptCount` is denormalized on the event; the dispatch rows are the
      // record. Preferring the rows means a row can never claim more attempts
      // than exist, and "never attempted" is an absence rather than a zero.
      dispatchCount: tally?.count ?? 0,
      lastFailure: tally?.lastFailure ?? null,
      responseReceivedAtUtc: firstResponse?.receivedAtUtc ?? null,
      responseFreeText: firstResponse?.freeText ?? null,
    };
  });

  return { rows, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Operations report — the `/reports` screen
// ─────────────────────────────────────────────────────────────────────────────

/** The windows the report can be run over. Anything else is clamped. */
export const REPORT_WINDOW_CHOICES = [7, 30, 90] as const;

export type ReportWindowDays = (typeof REPORT_WINDOW_CHOICES)[number];

export type TimeOfDayBucket = "MORNING" | "AFTERNOON" | "EVENING" | "NIGHT";

/**
 * Day-parts a dose's local wall-clock time is bucketed into.
 *
 * The question this answers is concrete — "does this patient forget the EVENING
 * dose specifically?" — so the buckets are the ones a pharmacy day divides into,
 * not equal thirds: night covers the quiet-hours tail (22:00–04:59), and the
 * boundaries are at the schedule patterns the app actually materializes.
 */
const TIME_OF_DAY_BUCKETS: ReadonlyArray<{ key: TimeOfDayBucket; hours: number[] }> = [
  { key: "MORNING", hours: [5, 6, 7, 8, 9, 10, 11] },
  { key: "AFTERNOON", hours: [12, 13, 14, 15, 16] },
  { key: "EVENING", hours: [17, 18, 19, 20, 21] },
  { key: "NIGHT", hours: [22, 23, 0, 1, 2, 3, 4] },
];

const HOUR_TO_BUCKET = new Map<number, TimeOfDayBucket>(
  TIME_OF_DAY_BUCKETS.flatMap(({ key, hours }) => hours.map((h) => [h, key] as const)),
);

export type ReportSectionDelivery = {
  /** Every dose the window contains — the denominator of "ours". */
  due: number;
  /** We tried: SENDING, SENT, DELIVERED, READ or FAILED. */
  attempted: number;
  /** Past due and still SCHEDULED: the dispatcher never got to it. */
  neverAttempted: number;
  /** CANCELLED, SUPERSEDED, SKIPPED — removed by our own schedule edits. */
  cancelledByUs: number;
  /** EXPIRED: became too late to be worth sending. Our downtime, not the patient's. */
  expired: number;
  /** The provider accepted it: SENT + DELIVERED + READ. */
  sent: number;
  /** It reached the handset: DELIVERED + READ. */
  delivered: number;
  failed: number;
  /** delivered / attempted over the window, or null when nothing was attempted. */
  deliveryRate: number | null;
};

export type ReportSectionResponses = {
  /** Doses the patient had a fair chance to answer — the shared predicate. */
  scorable: number;
  taken: number;
  takenLate: number;
  missed: number;
  /** Settled without an answer. Silence, reported AS silence. */
  noReply: number;
  /**
   * `(taken + takenLate) / scorable` — the patient's own account of taking
   * their medication. NOT a verified outcome (see the verification section).
   */
  reportedAdherence: number | null;
  /** `(taken + takenLate + missed) / scorable` — how often the patient answers at all. */
  responseRate: number | null;
  /**
   * Counts deliberately OUTSIDE the rate above, each for its own reason.
   *
   * `problem` and `remindLater` are real patient actions, but the shared
   * predicate does not settle a dose on them, so folding them into the rate
   * would silently redefine the denominator the patient list uses.
   * `inFlight` is an unanswered dose whose window has not closed: not yet
   * evidence of anything, so it is neither a reply nor a miss.
   */
  notCounted: {
    problem: number;
    remindLater: number;
    unattributed: number;
    inFlight: number;
  };
};

export type ReportSectionVerification = {
  /** Recorded answers in the window: the denominator of this section alone. */
  recorded: number;
  confirmed: number;
  corrected: number;
  unverified: number;
  /** `(confirmed + corrected) / recorded`, or null when nothing was recorded. */
  verificationRate: number | null;
};

export type MissedPatternRow = {
  /** "0"–"6" (0 = Sunday) for days, or a `TimeOfDayBucket` for time of day. */
  key: string;
  /** Scorable doses in this bucket: the denominator. */
  total: number;
  /** Doses the patient reported MISSED. Never silence — see below. */
  missed: number;
};

export type ReportProblemReason = { reason: string | null; count: number };

export type ReportSectionFollowUps = {
  opened: number;
  withFirstAction: number;
  resolved: number;
  /** `resolved / opened`, or null when no case was opened in the window. */
  completionRate: number | null;
};

export type ReportWorkloadRow = {
  userId: string;
  /** Null if the user row is gone (audit-ish columns survive deletions). */
  fullName: string | null;
  interventions: number;
};

export type ReportSectionInbound = {
  received: number;
  /** Arrived but could not be routed to a pharmacy. */
  unrouted: number;
  failed: number;
};

export type OperationsReport = {
  window: { days: number; since: Date; until: Date };
  /** 1. Our infrastructure. */
  delivery: ReportSectionDelivery;
  /** 2. The patient's own account. Patient-reported, never verified. */
  responses: ReportSectionResponses;
  /** 3. The only verified numbers on the page. */
  verification: ReportSectionVerification;
  /** Day of week the patient reported missing (0 = Sunday). */
  missedByDayOfWeek: MissedPatternRow[];
  /** Day part the patient reported missing. */
  missedByTimeOfDay: MissedPatternRow[];
  problems: { total: number; top: ReportProblemReason[] };
  followUps: ReportSectionFollowUps;
  workload: { total: number; byUser: ReportWorkloadRow[] };
  inbound: ReportSectionInbound;
};

/**
 * The operations report over a rolling window.
 *
 * `days` is clamped rather than trusted: the page validates it against
 * `REPORT_WINDOW_CHOICES` for the select, but a query string is untrusted input
 * and a report over `?days=100000` would scan the whole table.
 *
 * The three sections come from different sources on purpose:
 *   - delivery reads `ReminderEvent.deliveryState` — every dose, including ones
 *     excluded from scoring;
 *   - responses reads `ReminderEvent.responseState` under the mirrored
 *     `scorableDoseCore` predicate;
 *   - verification reads `PatientResponse.verificationState`, rows a pharmacist
 *     has touched.
 */
export async function getOperationsReport(
  pharmacyId: string,
  days: number,
): Promise<OperationsReport> {
  const windowDays = Math.min(Math.max(Math.trunc(days) || 1, 1), 365);
  const until = new Date();
  const since = new Date(until.getTime() - windowDays * 86_400_000);
  const window = { gte: since, lt: until };

  /**
   * Doses that reached the patient's phone at all: scorable for content, but
   * the delivery state was ours to get right. Used as the universe for the
   * patient-side counts that the scoring predicate deliberately excludes, so
   * every number in section 2 is about the same set of doses.
   */
  const patientReachable = {
    pharmacyId,
    countedForAdherence: true,
    ruleEligible: true,
    deliveryState: { notIn: NEVER_DELIVERED },
    doseAtUtc: window,
  };

  const [
    deliveryRows,
    scorableRows,
    reachableRows,
    inFlightCount,
    missedByDayRows,
    missedByTimeRows,
    verificationRows,
    problemRows,
    followUpRows,
    followUpFirstAction,
    workloadRows,
    inboundRows,
  ] = await Promise.all([
    // 1. Delivery — every event in the window, scoring or not.
    prisma.reminderEvent.groupBy({
      by: ["deliveryState"],
      where: { pharmacyId, doseAtUtc: window },
      _count: { _all: true },
    }),

    // 2a. Scorable doses by outcome (the mirrored predicate).
    prisma.reminderEvent.groupBy({
      by: ["responseState"],
      where: scorableDoseCore(pharmacyId, since, until),
      _count: { _all: true },
    }),

    // 2b. Delivered doses by response, including the states scoring excludes.
    prisma.reminderEvent.groupBy({
      by: ["responseState"],
      where: patientReachable,
      _count: { _all: true },
    }),

    // 2c. Of those, the unanswered ones still inside their response window.
    //
    // Restricted to doses a message actually left us for. A dose the dispatcher
    // never attempted is not "awaiting a reply" — nothing was sent to reply to —
    // and it is already reported in the delivery section as past due with no
    // attempt. Counting it here would quietly describe our own outage as the
    // patient's pending decision.
    prisma.reminderEvent.count({
      where: {
        ...patientReachable,
        deliveryState: { in: ATTEMPTED },
        responseState: "NONE",
        settledAtUtc: null,
      },
    }),

    // Missed patterns, split by the local date and the local wall-clock time.
    prisma.reminderEvent.groupBy({
      by: ["doseLocalDate", "responseState"],
      where: scorableDoseCore(pharmacyId, since, until),
      _count: { _all: true },
    }),
    prisma.reminderEvent.groupBy({
      by: ["doseLocalTime", "responseState"],
      where: scorableDoseCore(pharmacyId, since, until),
      _count: { _all: true },
    }),

    // 3. Verification — the only section that is not patient-reported.
    prisma.patientResponse.groupBy({
      by: ["verificationState"],
      where: {
        pharmacyId,
        receivedAtUtc: window,
        // One row per answer the system acted on, PLUS any pharmacist
        // verification row. Filtering on `applied` alone would drop a
        // correction row recorded without superseding the patient's answer;
        // counting every row would let a duplicate tap drag the rate down.
        OR: [{ applied: true }, { verificationState: { not: "UNVERIFIED" } }],
      },
      _count: { _all: true },
    }),

    // Reported problem reasons, worst-offender first.
    prisma.patientResponse.groupBy({
      by: ["freeText"],
      where: {
        pharmacyId,
        answer: "PROBLEM",
        applied: true,
        receivedAtUtc: window,
      },
      _count: { _all: true },
      orderBy: { _count: { freeText: "desc" } },
      take: 10,
    }),

    prisma.followUpCase.groupBy({
      by: ["status"],
      where: { pharmacyId, openedAtUtc: window },
      _count: { _all: true },
    }),
    prisma.followUpCase.count({
      where: { pharmacyId, openedAtUtc: window, firstActionAtUtc: { not: null } },
    }),
    prisma.pharmacistIntervention.groupBy({
      by: ["performedByUserId"],
      where: { pharmacyId, performedAtUtc: window },
      _count: { _all: true },
      orderBy: { _count: { performedByUserId: "desc" } },
    }),
    prisma.inboundMessage.groupBy({
      by: ["processingStatus"],
      where: { pharmacyId, receivedAtUtc: window },
      _count: { _all: true },
    }),
  ]);

  // ── 1. Delivery ────────────────────────────────────────────────────────────

  const deliveryCount = (states: DeliveryState[]) =>
    deliveryRows
      .filter((row) => states.includes(row.deliveryState))
      .reduce((sum, row) => sum + row._count._all, 0);

  const due = deliveryRows.reduce((sum, row) => sum + row._count._all, 0);
  const attempted = deliveryCount(["SENDING", "SENT", "DELIVERED", "READ", "FAILED"]);
  const sent = deliveryCount(["SENT", "DELIVERED", "READ"]);
  const delivered = deliveryCount(["DELIVERED", "READ"]);

  const delivery: ReportSectionDelivery = {
    due,
    attempted,
    neverAttempted: deliveryCount(["SCHEDULED"]),
    cancelledByUs: deliveryCount(["CANCELLED", "SUPERSEDED", "SKIPPED"]),
    expired: deliveryCount(["EXPIRED"]),
    sent,
    delivered,
    failed: deliveryCount(["FAILED"]),
    // Null, not 0: nothing attempted is no evidence about our delivery, and 0%
    // would read as total failure.
    deliveryRate: attempted > 0 ? delivered / attempted : null,
  };

  // ── 2. Patient-reported responses ──────────────────────────────────────────

  const scorableByState = new Map(
    scorableRows.map((row) => [row.responseState, row._count._all]),
  );
  const reachableByState = new Map(
    reachableRows.map((row) => [row.responseState, row._count._all]),
  );

  const taken = scorableByState.get("TAKEN") ?? 0;
  const takenLate = scorableByState.get("TAKEN_LATE") ?? 0;
  const missed = scorableByState.get("MISSED") ?? 0;
  // Settled silence: `NONE` with `settledAtUtc` stamped, which is exactly what
  // the mirrored OR admits into the denominator.
  const noReply = scorableByState.get("NONE") ?? 0;
  const scorable = taken + takenLate + missed + noReply;

  const responses: ReportSectionResponses = {
    scorable,
    taken,
    takenLate,
    missed,
    noReply,
    reportedAdherence: scorable > 0 ? (taken + takenLate) / scorable : null,
    responseRate: scorable > 0 ? (taken + takenLate + missed) / scorable : null,
    notCounted: {
      problem: reachableByState.get("PROBLEM") ?? 0,
      remindLater: reachableByState.get("REMIND_LATER") ?? 0,
      unattributed: reachableByState.get("UNATTRIBUTED") ?? 0,
      inFlight: inFlightCount,
    },
  };

  /*
   * Missed-dose patterns count ONLY `MISSED`.
   *
   * This is the one place where the silence rule is easiest to get wrong and
   * most damaging: `noReply` doses are settled silence, and silence is not a
   * miss (SCREENS.md §6). Folding them in here would produce a "your patient
   * forgets the evening dose" pattern out of doses where the patient was simply
   * never answered — or worse, out of our own expired sends, which never reach
   * this query at all because `EXPIRED` is not in the scorable set.
   */
  const missedByDayOfWeek: MissedPatternRow[] = Array.from({ length: 7 }, (_, day) => ({
    key: String(day),
    total: 0,
    missed: 0,
  }));

  for (const row of missedByDayRows) {
    const day = row.doseLocalDate.getUTCDay();
    const bucket = missedByDayOfWeek[day];
    bucket.total += row._count._all;
    if (row.responseState === "MISSED") bucket.missed += row._count._all;
  }

  const missedByTimeOfDay: MissedPatternRow[] = TIME_OF_DAY_BUCKETS.map(({ key }) => ({
    key,
    total: 0,
    missed: 0,
  }));
  const timeBucketByKey = new Map(missedByTimeOfDay.map((row) => [row.key, row]));

  for (const row of missedByTimeRows) {
    // A wall-clock reading that does not parse is dropped, never guessed —
    // see `timeOfDayBucket`. The dose still counts in the day-of-week view,
    // where its date is known.
    const bucketKey = timeOfDayBucket(row.doseLocalTime);
    if (!bucketKey) continue;

    const bucket = timeBucketByKey.get(bucketKey);
    if (!bucket) continue;

    bucket.total += row._count._all;
    if (row.responseState === "MISSED") bucket.missed += row._count._all;
  }

  const problems = {
    total: problemRows.reduce((sum, row) => sum + row._count._all, 0),
    top: problemRows.map((row) => ({
      reason: row.freeText,
      count: row._count._all,
    })),
  };

  // ── 3. Verified outcomes ───────────────────────────────────────────────────

  const verificationByState = new Map<VerificationState, number>(
    verificationRows.map((row) => [row.verificationState, row._count._all]),
  );
  const confirmed = verificationByState.get("PHARMACIST_CONFIRMED") ?? 0;
  const corrected = verificationByState.get("PHARMACIST_CORRECTED") ?? 0;
  const recorded = verificationRows.reduce((sum, row) => sum + row._count._all, 0);

  const verification: ReportSectionVerification = {
    recorded,
    confirmed,
    corrected,
    unverified: recorded - confirmed - corrected,
    verificationRate: recorded > 0 ? (confirmed + corrected) / recorded : null,
  };

  // ── Operations (follow-up, workload, inbound) ─────────────────────────────

  const opened = followUpRows.reduce((sum, row) => sum + row._count._all, 0);
  const resolved = followUpRows
    .filter((row) => row.status === "RESOLVED" || row.status === "CLOSED_NO_ACTION")
    .reduce((sum, row) => sum + row._count._all, 0);

  const followUps: ReportSectionFollowUps = {
    opened,
    withFirstAction: followUpFirstAction,
    resolved,
    completionRate: opened > 0 ? resolved / opened : null,
  };

  // Interventions point at `performedByUserId` as a plain scalar (the schema
  // keeps audit-ish references relationless so they survive user deletion), so
  // the names come from a second, deliberately small lookup.
  const userIds = workloadRows.map((row) => row.performedByUserId);
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, fullName: true },
      })
    : [];
  const nameById = new Map(users.map((user) => [user.id, user.fullName]));

  const workload = {
    total: workloadRows.reduce((sum, row) => sum + row._count._all, 0),
    byUser: workloadRows.map((row) => ({
      userId: row.performedByUserId,
      fullName: nameById.get(row.performedByUserId) ?? null,
      interventions: row._count._all,
    })),
  };

  const inboundByStatus = new Map(
    inboundRows.map((row) => [row.processingStatus, row._count._all]),
  );

  const inbound: ReportSectionInbound = {
    received: inboundRows.reduce((sum, row) => sum + row._count._all, 0),
    unrouted: inboundByStatus.get("UNROUTED") ?? 0,
    failed: inboundByStatus.get("FAILED") ?? 0,
  };

  return {
    window: { days: windowDays, since, until },
    delivery,
    responses,
    verification,
    missedByDayOfWeek,
    missedByTimeOfDay,
    problems,
    followUps,
    workload,
    inbound,
  };
}

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/**
 * The day part a local "HH:mm" falls into.
 *
 * `doseLocalTime` is constrained at the database level to a real wall-clock
 * "HH:mm" (`reminder_event_local_time_format` in the hard-constraints
 * migration), so a value reaching this function malformed is a bug or
 * corruption rather than data — the null branch is defence in depth. It returns
 * null instead of guessing even so, and the caller drops the row: placing a dose
 * in the wrong column of this particular pattern is worse than leaving it out,
 * because a pharmacist acts on "your patient forgets the evening dose".
 */
function timeOfDayBucket(localTime: string): TimeOfDayBucket | null {
  const match = TIME_PATTERN.exec(localTime);
  if (!match) return null;

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) return null;

  return HOUR_TO_BUCKET.get(hours) ?? null;
}
