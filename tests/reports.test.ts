import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DispatchStatus,
  InboundStatus,
  ResponseState,
  VerificationState,
  type DeliveryState,
} from "@/generated/prisma/enums";
import { systemPrisma } from "@/server/db";
import {
  DELIVERY_HISTORY_DEFAULT_LIMIT,
  DELIVERY_HISTORY_MAX_LIMIT,
  getOperationsReport,
  listDeliveryHistory,
  type DeliveryHistoryRow,
  type OperationsReport,
} from "@/server/queries/reports";

/**
 * The operations report and the delivery history, asserted against a real
 * database with hand-built fixtures.
 *
 * The PRD's acceptance criterion — delivery rate, patient-reported response rate
 * and verified outcome reported separately and never conflated — is a claim
 * about NUMBERS, not about layout, so it is asserted here as numbers. Every
 * fixture row below exists to make one of the three sections come out different
 * from the other two:
 *
 *   delivery   — 17 doses, 11 attempted, 10 delivered, 1 failed, 1 expired.
 *   responses  — only 5 of those doses are scorable, and the missed-versus-
 *                silence rule is visible in the day-part pattern.
 *   verification — 11 recorded responses, 3 verified. Nothing in common with
 *                the counts above, on purpose.
 *
 * If a future refactor merges any two of these — the single most tempting
 * mistake in this file's subject area — at least one exact assertion breaks.
 *
 * Fixtures are built by hand rather than taken from `prisma/seed.ts` for the
 * same reason as `queries.patients.test.ts`: the seed is a random walk, and an
 * assertion against it would have to be loosened until it no longer proved
 * anything. Each dose here sits a distinct whole number of days in the past, so
 * the 7/30/365-day windows below have exact, non-incidental expected values.
 */

const RUN = randomUUID().slice(0, 8);
const DAY = 86_400_000;
const MINUTE = 60_000;
const T0 = Date.now();

let pharmacyId: string;
let otherPharmacyId: string;
let capPharmacyId: string;
let idlePharmacyId: string;

let patientId: string;
let otherPatientId: string;

let medicationId: string;
let scheduleId: string;
let otherMedicationId: string;
let otherScheduleId: string;
let capMedicationId: string;
let capScheduleId: string;
let idleMedicationId: string;
let idleScheduleId: string;

let workedUserId: string;
let secondUserId: string;

const userIds: string[] = [];
const inboundIds: string[] = [];

/** A dose as this test needs to see it. Deliberately not Prisma's model type. */
type DoseRow = { id: string; doseAtUtc: Date; doseLocalDate: Date };

const doses = new Map<string, DoseRow>();

let report: OperationsReport;
let sevenDayReport: OperationsReport;
let yearReport: OperationsReport;
let otherReport: OperationsReport;
let idleReport: OperationsReport;

const PATIENT_NAME = `Reports Patient Alpha ${RUN}`;
const PATIENT_PHONE = "+201099910001";
const MEDICATION_NAME = `Reports Medicine ${RUN}`;

beforeAll(async () => {
  const [pharmacy, other, cap, idle] = await Promise.all([
    systemPrisma.pharmacy.create({ data: { name: `Reports A (${RUN})` } }),
    systemPrisma.pharmacy.create({ data: { name: `Reports B (${RUN})` } }),
    systemPrisma.pharmacy.create({ data: { name: `Reports Cap (${RUN})` } }),
    systemPrisma.pharmacy.create({ data: { name: `Reports Idle (${RUN})` } }),
  ]);
  pharmacyId = pharmacy.id;
  otherPharmacyId = other.id;
  capPharmacyId = cap.id;
  idlePharmacyId = idle.id;

  const [patient, otherPatient] = await Promise.all([
    systemPrisma.patient.create({
      data: { pharmacyId, fullName: PATIENT_NAME, phoneE164: PATIENT_PHONE },
    }),
    // Same name and same phone as the patient above, in another pharmacy. The
    // strongest possible tenant-leak fixture: if a query forgets its pharmacy
    // filter, a search by either field silently returns this patient's rows.
    systemPrisma.patient.create({
      data: { pharmacyId: otherPharmacyId, fullName: PATIENT_NAME, phoneE164: PATIENT_PHONE },
    }),
  ]);
  patientId = patient.id;
  otherPatientId = otherPatient.id;

  const [medication, otherMedication] = await Promise.all([
    makeMedication(pharmacyId, patientId),
    makeMedication(otherPharmacyId, otherPatientId),
  ]);
  medicationId = medication.record.id;
  scheduleId = medication.schedule.id;
  otherMedicationId = otherMedication.record.id;
  otherScheduleId = otherMedication.schedule.id;

  // A third pharmacy whose only job is to hold more doses than one page may
  // contain, so the limit cap can be observed rather than assumed.
  const capPatient = await systemPrisma.patient.create({
    data: { pharmacyId: capPharmacyId, fullName: `Reports Cap Patient ${RUN}`, phoneE164: "+201099910002" },
  });
  const capMedication = await makeMedication(capPharmacyId, capPatient.id);
  capMedicationId = capMedication.record.id;
  capScheduleId = capMedication.schedule.id;

  // A fourth with a single never-attempted dose: the null-is-not-zero fixture.
  const idlePatient = await systemPrisma.patient.create({
    data: { pharmacyId: idlePharmacyId, fullName: `Reports Idle Patient ${RUN}`, phoneE164: "+201099910003" },
  });
  const idleMedication = await makeMedication(idlePharmacyId, idlePatient.id);
  idleMedicationId = idleMedication.record.id;
  idleScheduleId = idleMedication.schedule.id;

  const [worked, second] = await Promise.all([
    systemPrisma.user.create({
      data: { email: `reports-worked-${RUN}@test.local`, fullName: `Reports Pharmacist ${RUN}` },
    }),
    systemPrisma.user.create({
      data: { email: `reports-second-${RUN}@test.local`, fullName: `Reports Second ${RUN}` },
    }),
  ]);
  workedUserId = worked.id;
  secondUserId = second.id;
  userIds.push(worked.id, second.id);

  // ── The 17 doses ──────────────────────────────────────────────────────────

  for (const spec of DOSE_PLAN) {
    doses.set(spec.key, await makeDose(spec));
  }

  // ── Dispatch attempts ─────────────────────────────────────────────────────

  await systemPrisma.reminderDispatch.create({
    data: {
      id: `${doses.get("taken")!.id}-1`,
      pharmacyId,
      reminderEventId: doses.get("taken")!.id,
      attemptNo: 1,
      provider: "WHATSAPP",
      toPhoneE164: PATIENT_PHONE,
      status: "DELIVERED" satisfies DispatchStatus,
      reconcileDeadlineUtc: new Date(T0 + DAY),
    },
  });

  // Three attempts, the last two rejected. The row must end up able to say
  // "sent 3 times, all rejected" — and "131047" is the code of the LATEST
  // failed attempt, not of the first one, whose message text is different.
  const failedDose = doses.get("failed")!;
  await systemPrisma.reminderDispatch.createMany({
    data: [
      {
        id: `${failedDose.id}-1`,
        pharmacyId,
        reminderEventId: failedDose.id,
        attemptNo: 1,
        provider: "WHATSAPP",
        toPhoneE164: PATIENT_PHONE,
        status: "FAILED",
        errorMessage: "Message undeliverable (Reports test)",
        reconcileDeadlineUtc: new Date(T0 + DAY),
      },
      {
        id: `${failedDose.id}-2`,
        pharmacyId,
        reminderEventId: failedDose.id,
        attemptNo: 2,
        provider: "WHATSAPP",
        toPhoneE164: PATIENT_PHONE,
        status: "FAILED",
        errorCode: "131047",
        reconcileDeadlineUtc: new Date(T0 + DAY),
      },
      {
        id: `${failedDose.id}-3`,
        pharmacyId,
        reminderEventId: failedDose.id,
        attemptNo: 3,
        provider: "WHATSAPP",
        toPhoneE164: PATIENT_PHONE,
        status: "ACCEPTED",
        reconcileDeadlineUtc: new Date(T0 + DAY),
      },
    ],
  });

  // ── Patient responses ─────────────────────────────────────────────────────

  // The applied reply for every dose the patient answered.
  for (const spec of REPLY_PLAN) {
    const dose = doses.get(spec.dose)!;
    await makeResponse({
      dose,
      answer: spec.answer,
      freeText: spec.freeText ?? null,
      receivedAtUtc: new Date(dose.doseAtUtc.getTime() + 10 * MINUTE),
    });
  }

  // Two standalone problem reports not tied to a dose, so the reasons list has
  // something to group and the "no details given" bucket is exercised.
  for (const freeText of ["صداع", "دوخة", null]) {
    await makeResponse({
      dose: null,
      answer: "PROBLEM",
      freeText,
      receivedAtUtc: new Date(T0 - 20 * MINUTE),
    });
  }

  // Pharmacist verification rows: recorded BESIDE the patient's own answer,
  // never as an edit of it. `applied: false` because these rows changed no
  // dose — they are audit rows a pharmacist wrote.
  for (const spec of VERIFICATION_PLAN) {
    const dose = doses.get(spec.dose)!;
    await makeResponse({
      dose,
      answer: spec.answer,
      applied: false,
      verificationState: spec.verificationState,
      receivedAtUtc: new Date(dose.doseAtUtc.getTime() + 60 * MINUTE),
    });
  }

  // Duplicate taps: the same answer twice, the second one not applied. Both
  // must stay out of the verification denominator — a patient double-tapping a
  // button must not look like an unverified response.
  for (const key of ["taken", "stale"]) {
    const dose = doses.get(key)!;
    await makeResponse({
      dose,
      answer: "TAKEN",
      applied: false,
      receivedAtUtc: new Date(dose.doseAtUtc.getTime() + 5 * MINUTE),
    });
  }

  // Outside every window under test: a response the report must not see.
  await makeResponse({
    dose: null,
    answer: "PROBLEM",
    freeText: "من فترة",
    receivedAtUtc: new Date(T0 - 200 * DAY),
  });

  // ── Follow-up cases: five opened in the window, one long before it ────────

  await systemPrisma.followUpCase.createMany({
    data: [
      { pharmacyId, patientId, origin: "PROBLEM_RESPONSE", status: "OPEN", openedAtUtc: new Date(T0 - 2 * DAY) },
      {
        pharmacyId,
        patientId,
        origin: "RULE_ALERT",
        status: "IN_PROGRESS",
        openedAtUtc: new Date(T0 - 3 * DAY),
        firstActionAtUtc: new Date(T0 - 3 * DAY + 30 * MINUTE),
      },
      {
        pharmacyId,
        patientId,
        origin: "MANUAL",
        status: "RESOLVED",
        openedAtUtc: new Date(T0 - 4 * DAY),
        firstActionAtUtc: new Date(T0 - 4 * DAY + 30 * MINUTE),
        resolvedAtUtc: new Date(T0 - 4 * DAY + 2 * 3_600_000),
      },
      {
        pharmacyId,
        patientId,
        origin: "REFILL",
        status: "CLOSED_NO_ACTION",
        openedAtUtc: new Date(T0 - 5 * DAY),
        firstActionAtUtc: new Date(T0 - 5 * DAY + 30 * MINUTE),
      },
      { pharmacyId, patientId, origin: "UNSOLICITED_MESSAGE", status: "WAITING_PATIENT", openedAtUtc: new Date(T0 - 6 * DAY) },
      { pharmacyId, patientId, origin: "MANUAL", status: "OPEN", openedAtUtc: new Date(T0 - 200 * DAY) },
    ],
  });

  // ── Interventions: 3 + 2 + 1 for a user that no longer exists ─────────────

  const interventionRow = (performedByUserId: string, minutesAgo: number) => ({
    pharmacyId,
    patientId,
    interventionType: "PHONE_CALL" as const,
    outcome: "REACHED" as const,
    performedByUserId,
    performedAtUtc: new Date(T0 - minutesAgo * MINUTE),
  });

  await systemPrisma.pharmacistIntervention.createMany({
    data: [
      interventionRow(workedUserId, 10),
      interventionRow(workedUserId, 20),
      interventionRow(workedUserId, 30),
      interventionRow(secondUserId, 40),
      interventionRow(secondUserId, 50),
      // Audit columns survive user deletion, so the report has to render a
      // count whose owner has no name rather than dropping the row.
      interventionRow(`reports-gone-${RUN}`, 60),
      // Outside the 30-day window: only the 365-day report may see this one.
      interventionRow(workedUserId, 200 * 24 * 60),
    ],
  });

  // ── Inbound messages ──────────────────────────────────────────────────────

  const inboundRow = (
    n: number,
    status: InboundStatus,
    pharmacy: string | null,
    receivedAtUtc: Date,
  ) => ({
    pharmacyId: pharmacy,
    providerMessageId: `wamid.reports.${RUN}.${n}`,
    fromPhoneE164: PATIENT_PHONE,
    toPhoneE164: "+201000000000",
    type: "button",
    rawPayload: {},
    receivedAtUtc,
    processingStatus: status,
  });

  const inboundData = [
    inboundRow(1, "ROUTED", pharmacyId, new Date(T0 - 15 * MINUTE)),
    inboundRow(2, "UNROUTED", pharmacyId, new Date(T0 - 16 * MINUTE)),
    inboundRow(3, "FAILED", pharmacyId, new Date(T0 - 17 * MINUTE)),
    inboundRow(4, "RECEIVED", pharmacyId, new Date(T0 - 18 * MINUTE)),
    inboundRow(5, "ROUTED", pharmacyId, new Date(T0 - 200 * DAY)),
    // Arrived but resolved to no pharmacy at all. It belongs to no report, and
    // it must not inflate anyone's totals.
    inboundRow(6, "UNROUTED", null, new Date(T0 - 19 * MINUTE)),
  ];
  await systemPrisma.inboundMessage.createMany({ data: inboundData });
  inboundIds.push(
    ...(await systemPrisma.inboundMessage
      .findMany({
        where: { providerMessageId: { startsWith: `wamid.reports.${RUN}.` } },
        select: { id: true },
      })
      .then((rows) => rows.map((row) => row.id))),
  );

  // ── The other pharmacy: one of everything, to prove the scope is real ─────

  await systemPrisma.reminderEvent.create({
    data: {
      pharmacyId: otherPharmacyId,
      patientId: otherPatientId,
      medicationId: otherMedicationId,
      scheduleId: otherScheduleId,
      scheduleRevisionSnapshot: 1,
      doseAtUtc: new Date(T0 - 2 * 3_600_000),
      doseLocalDate: dateOnly(new Date(T0 - 2 * 3_600_000)),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(T0 + 2 * 3_600_000),
      deliveryState: "DELIVERED",
      responseState: "TAKEN",
    },
  });
  await systemPrisma.followUpCase.create({
    data: { pharmacyId: otherPharmacyId, patientId: otherPatientId, origin: "MANUAL", status: "OPEN" },
  });
  await systemPrisma.pharmacistIntervention.create({
    data: {
      pharmacyId: otherPharmacyId,
      patientId: otherPatientId,
      interventionType: "PHONE_CALL",
      outcome: "REACHED",
      performedByUserId: secondUserId,
      performedAtUtc: new Date(T0 - 25 * MINUTE),
    },
  });
  await systemPrisma.inboundMessage.create({
    data: inboundRow(20, "ROUTED", otherPharmacyId, new Date(T0 - 21 * MINUTE)),
  });
  inboundIds.push(
    ...(await systemPrisma.inboundMessage
      .findMany({
        where: { providerMessageId: `wamid.reports.${RUN}.20` },
        select: { id: true },
      })
      .then((rows) => rows.map((row) => row.id))),
  );

  // ── The never-attempted pharmacy: a single dose nothing was done with ─────

  await systemPrisma.reminderEvent.create({
    data: {
      pharmacyId: idlePharmacyId,
      patientId: idlePatient.id,
      medicationId: idleMedicationId,
      scheduleId: idleScheduleId,
      scheduleRevisionSnapshot: 1,
      doseAtUtc: new Date(T0 - 3 * 3_600_000),
      doseLocalDate: dateOnly(new Date(T0 - 3 * 3_600_000)),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(T0 + 3_600_000),
      deliveryState: "SCHEDULED",
      responseState: "NONE",
    },
  });

  // ── The cap pharmacy: more doses than one page may hold ───────────────────

  const capDoseAt = (index: number) => new Date(T0 - (index + 1) * 7 * MINUTE);
  await systemPrisma.reminderEvent.createMany({
    data: Array.from({ length: DELIVERY_HISTORY_MAX_LIMIT + 20 }, (_, index) => ({
      pharmacyId: capPharmacyId,
      patientId: capPatient.id,
      medicationId: capMedicationId,
      scheduleId: capScheduleId,
      scheduleRevisionSnapshot: 1,
      doseAtUtc: capDoseAt(index),
      doseLocalDate: dateOnly(capDoseAt(index)),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(capDoseAt(index).getTime() + 4 * 3_600_000),
      deliveryState: "DELIVERED" as DeliveryState,
      responseState: "TAKEN" as ResponseState,
    })),
  });

  // ── Run the reports once; the assertions below read these snapshots ───────

  [report, sevenDayReport, yearReport, otherReport, idleReport] = await Promise.all([
    getOperationsReport(pharmacyId, 30),
    getOperationsReport(pharmacyId, 7),
    getOperationsReport(pharmacyId, 365),
    getOperationsReport(otherPharmacyId, 30),
    getOperationsReport(idlePharmacyId, 30),
  ]);
});

afterAll(async () => {
  // Inbound messages have no relation to Pharmacy, so they do not cascade.
  await systemPrisma.inboundMessage
    .deleteMany({ where: { id: { in: inboundIds } } })
    .catch(() => {});
  await systemPrisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await systemPrisma.pharmacy
    .deleteMany({
      where: { id: { in: [pharmacyId, otherPharmacyId, capPharmacyId, idlePharmacyId] } },
    })
    .catch(() => {});
  await systemPrisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture plans
// ─────────────────────────────────────────────────────────────────────────────

const DOSE_PLAN: ReadonlyArray<{
  key: string;
  daysAgo: number;
  localTime: string;
  delivery: DeliveryState;
  response: ResponseState;
  settled?: boolean;
  countedForAdherence?: boolean;
  ruleEligible?: boolean;
}> = [
  { key: "taken", daysAgo: 1, localTime: "08:00", delivery: "DELIVERED", response: "TAKEN" },
  { key: "takenLate", daysAgo: 2, localTime: "13:00", delivery: "READ", response: "TAKEN_LATE" },
  { key: "missed", daysAgo: 3, localTime: "19:00", delivery: "DELIVERED", response: "MISSED" },
  { key: "noReply", daysAgo: 4, localTime: "23:00", delivery: "DELIVERED", response: "NONE", settled: true },
  { key: "inFlight", daysAgo: 5, localTime: "08:00", delivery: "DELIVERED", response: "NONE" },
  { key: "expired", daysAgo: 6, localTime: "08:00", delivery: "EXPIRED", response: "NONE", settled: true },
  { key: "failed", daysAgo: 7, localTime: "08:00", delivery: "FAILED", response: "NONE", settled: true },
  { key: "cancelled", daysAgo: 8, localTime: "08:00", delivery: "CANCELLED", response: "NONE", settled: true },
  { key: "superseded", daysAgo: 9, localTime: "08:00", delivery: "SUPERSEDED", response: "NONE" },
  { key: "skipped", daysAgo: 10, localTime: "08:00", delivery: "SKIPPED", response: "NONE" },
  { key: "scheduled", daysAgo: 11, localTime: "08:00", delivery: "SCHEDULED", response: "NONE" },
  { key: "problem", daysAgo: 12, localTime: "08:00", delivery: "DELIVERED", response: "PROBLEM" },
  { key: "remindLater", daysAgo: 13, localTime: "08:00", delivery: "DELIVERED", response: "REMIND_LATER" },
  { key: "unattributed", daysAgo: 14, localTime: "08:00", delivery: "DELIVERED", response: "UNATTRIBUTED" },
  {
    key: "snoozeChild",
    daysAgo: 15,
    localTime: "08:00",
    delivery: "DELIVERED",
    response: "TAKEN",
    countedForAdherence: false,
  },
  { key: "stale", daysAgo: 16, localTime: "08:00", delivery: "DELIVERED", response: "TAKEN", ruleEligible: false },
  { key: "settledNoSend", daysAgo: 17, localTime: "09:00", delivery: "SCHEDULED", response: "NONE", settled: true },
];

/** The applied reply for each dose the patient answered. */
const REPLY_PLAN: ReadonlyArray<{ dose: string; answer: ResponseState; freeText?: string }> = [
  { dose: "taken", answer: "TAKEN" },
  { dose: "takenLate", answer: "TAKEN_LATE" },
  { dose: "missed", answer: "MISSED" },
  { dose: "problem", answer: "PROBLEM", freeText: "صداع" },
  { dose: "remindLater", answer: "REMIND_LATER" },
  { dose: "unattributed", answer: "UNATTRIBUTED" },
  { dose: "snoozeChild", answer: "TAKEN" },
  { dose: "stale", answer: "TAKEN" },
];

/** Pharmacist audit rows, recorded beside the patient's own answer. */
const VERIFICATION_PLAN: ReadonlyArray<{
  dose: string;
  answer: ResponseState;
  verificationState: VerificationState;
}> = [
  { dose: "takenLate", answer: "TAKEN_LATE", verificationState: "PHARMACIST_CONFIRMED" },
  { dose: "missed", answer: "TAKEN_LATE", verificationState: "PHARMACIST_CORRECTED" },
  { dose: "snoozeChild", answer: "TAKEN", verificationState: "PHARMACIST_CONFIRMED" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

function dateOnly(date: Date): Date {
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

async function makeMedication(pharmacy: string, patient: string) {
  const record = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId: pharmacy,
      patientId: patient,
      medicationNameText: MEDICATION_NAME,
      startedOn: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  const schedule = await systemPrisma.medicationSchedule.create({
    data: {
      pharmacyId: pharmacy,
      patientId: patient,
      medicationId: record.id,
      mode: "FIXED_TIMES_OF_DAY",
      timesOfDay: ["08:00"],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timeZone: "Africa/Cairo",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  return { record, schedule };
}

/**
 * Create one dose of the plan at a distinct whole number of days in the past.
 *
 * `doseLocalDate` follows `doseAtUtc`, as the materializer writes it, so the
 * stored row stays self-consistent; because each dose sits a different number
 * of days back, every dose has its own local date and the date-range filter
 * below can be asserted exactly.
 */
async function makeDose(spec: {
  key: string;
  daysAgo: number;
  localTime: string;
  delivery: DeliveryState;
  response: ResponseState;
  settled?: boolean;
  countedForAdherence?: boolean;
  ruleEligible?: boolean;
}): Promise<DoseRow> {
  const doseAtUtc = new Date(T0 - spec.daysAgo * DAY);

  const event = await systemPrisma.reminderEvent.create({
    data: {
      pharmacyId,
      patientId,
      medicationId,
      scheduleId,
      scheduleRevisionSnapshot: 1,
      doseAtUtc,
      doseLocalDate: dateOnly(doseAtUtc),
      doseLocalTime: spec.localTime,
      responseWindowEndsAtUtc: new Date(doseAtUtc.getTime() + 4 * 3_600_000),
      deliveryState: spec.delivery,
      responseState: spec.response,
      settledAtUtc: spec.settled ? new Date(doseAtUtc.getTime() + 4 * 3_600_000) : null,
      countedForAdherence: spec.countedForAdherence ?? true,
      ruleEligible: spec.ruleEligible ?? true,
    },
    select: { id: true, doseAtUtc: true, doseLocalDate: true },
  });

  return event;
}

async function makeResponse(opts: {
  dose: DoseRow | null;
  answer: ResponseState;
  freeText?: string | null;
  applied?: boolean;
  verificationState?: VerificationState;
  receivedAtUtc: Date;
}) {
  return systemPrisma.patientResponse.create({
    data: {
      pharmacyId,
      patientId,
      reminderEventId: opts.dose?.id ?? null,
      channel: "WHATSAPP_BUTTON",
      answer: opts.answer,
      freeText: opts.freeText ?? null,
      applied: opts.applied ?? true,
      verificationState: opts.verificationState ?? "UNVERIFIED",
      receivedAtUtc: opts.receivedAtUtc,
    },
  });
}

function findRow(rows: DeliveryHistoryRow[], key: string): DeliveryHistoryRow {
  const id = doses.get(key)!.id;
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`dose ${key} (${id}) missing from the delivery history`);
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Delivery — our own infrastructure
// ─────────────────────────────────────────────────────────────────────────────

describe("the delivery section reports what our infrastructure did", () => {
  it("counts every dose in the window, including the ones scoring ignores", async () => {
    // The mistake this exists to catch: building the delivery section out of the
    // scorable set. Then a dose we failed to send — the exact thing a pharmacy
    // has to be able to see — would vanish from the only section that reports
    // our side, and our own outage would disappear from the report.
    expect(report.window.days).toBe(30);
    expect(report.delivery.due).toBe(17);
    expect(report.delivery.attempted).toBe(11);
    expect(report.delivery.sent).toBe(10);
    expect(report.delivery.delivered).toBe(10);
    expect(report.delivery.failed).toBe(1);
    expect(report.delivery.expired).toBe(1);
    // Both never-attempted doses: one still inside its window, one already
    // settled by the sweep. Both are ours to explain.
    expect(report.delivery.neverAttempted).toBe(2);
    expect(report.delivery.cancelledByUs).toBe(3);
    // 10 of the 11 attempts arrived. Not 10/17: a dose we never sent is not a
    // failed delivery, it is no evidence at all about our delivery.
    expect(report.delivery.deliveryRate).toBe(10 / 11);
  });

  it("is unchanged by another pharmacy's activity", async () => {
    // The mistake: a missing pharmacyId filter. The other pharmacy has the same
    // patient name and phone, so a leak would be invisible to the eye.
    expect(otherReport.delivery.due).toBe(1);
    expect(otherReport.delivery.delivered).toBe(1);
    expect(otherReport.responses.scorable).toBe(1);
    expect(otherReport.delivery.due).not.toBe(report.delivery.due);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Patient-reported responses — the patient's own account
// ─────────────────────────────────────────────────────────────────────────────

describe("the response section scores only doses the patient could answer", () => {
  it("excludes expired, failed and cancelled doses from the denominator", async () => {
    // The mistake this exists to catch — the single most damaging one in this
    // file: counting our own failures against the patient. EXPIRED (up 1),
    // FAILED (up 1) and CANCELLED (up 1) are settled doses the patient never
    // received; folding them in would make this 8. Dropping the "settled"
    // requirement would add every in-flight dose and make it 9.
    expect(report.responses.scorable).toBe(5);
    expect(report.responses.scorable).not.toBe(8);
    expect(report.responses.scorable).not.toBe(9);
    // None of those doses may appear as a miss either.
    expect(report.responses.missed).toBe(1);
  });

  it("counts a delivered but unanswered dose as no reply, not as a miss", async () => {
    // The mistake: treating silence as failure. A reminder that arrived and was
    // never answered is the absence of information. The patient's own account
    // has taken=1, takenLate=1, missed=1 — and noReply stands beside them,
    // reported as itself.
    expect(report.responses.taken).toBe(1);
    expect(report.responses.takenLate).toBe(1);
    expect(report.responses.missed).toBe(1);
    expect(report.responses.noReply).toBe(2);
  });

  it("computes the reported rates over the scorable doses only", async () => {
    // 2 of 5 taken or taken late; 3 of 5 answered at all. The other 12 doses in
    // the window are excluded from both, not scored as failures.
    expect(report.responses.reportedAdherence).toBe(2 / 5);
    expect(report.responses.responseRate).toBe(3 / 5);
  });

  it("keeps a settled never-attempted dose in the denominator, mirroring the shared predicate", async () => {
    // This is the deliberate consequence of mirroring `scorableDoseCore`: it
    // excludes only the NEVER_DELIVERED states, and SCHEDULED is not one of
    // them, so a never-attempted dose that the sweep settled IS scorable, and
    // lands in `noReply`. The report shows the same number the patient list
    // would. Documented here so that if the shared predicate is later tightened,
    // this test fails and points at the mirror instead of drifting silently.
    expect(report.responses.scorable).toBe(5);
    expect(report.responses.noReply).toBe(2);
    // The never-attempted dose still awaiting its window is scored NOWHERE: not
    // in the denominator, and not as in flight either — nothing was sent, so
    // there is no reply to await.
    expect(report.responses.notCounted.inFlight).toBe(1);
  });

  it("reports patient actions the rate deliberately leaves out", async () => {
    // A problem report and a snooze request are real patient actions, but the
    // shared predicate does not settle a dose on them, so folding them into the
    // rate would silently redefine the denominator the patient list uses.
    expect(report.responses.notCounted.problem).toBe(1);
    expect(report.responses.notCounted.remindLater).toBe(1);
    expect(report.responses.notCounted.unattributed).toBe(1);
  });

  it("counts only the patient's own misses in the missed patterns", async () => {
    // The mistake: building the "forgets the evening dose" pattern out of
    // no-reply doses, or out of our expired sends. Only the EVENING bucket has
    // a miss; the NIGHT dose that was settled unanswered has none, which is
    // exactly the distinction SCREENS.md §6 requires.
    expect(report.missedByTimeOfDay).toEqual([
      { key: "MORNING", total: 2, missed: 0 },
      { key: "AFTERNOON", total: 1, missed: 0 },
      { key: "EVENING", total: 1, missed: 1 },
      { key: "NIGHT", total: 1, missed: 0 },
    ]);

    // The day pattern covers the same five scorable doses. Which weekday a dose
    // lands on depends on the day the suite runs, and the doses sit far enough
    // apart (up to 17 days) that two of them can share a weekday — so the
    // assertions are on the SUM and on the missed dose's own weekday, both of
    // which are exact.
    const missedDay = doses.get("missed")!.doseLocalDate.getUTCDay();
    const dayTotals = report.missedByDayOfWeek.reduce((sum, row) => sum + row.total, 0);
    const dayMisses = report.missedByDayOfWeek.reduce((sum, row) => sum + row.missed, 0);

    expect(report.missedByDayOfWeek).toHaveLength(7);
    expect(dayTotals).toBe(5);
    expect(dayMisses).toBe(1);
    // Exactly one weekday carries a miss, and it is the missed dose's own: the
    // settled no-reply doses count in those totals but never in the misses.
    expect(report.missedByDayOfWeek[missedDay].missed).toBe(1);
    expect(
      report.missedByDayOfWeek.filter((row) => row.missed > 0).map((row) => row.key),
    ).toEqual([String(missedDay)]);
    expect(report.missedByDayOfWeek[missedDay].total).toBeGreaterThanOrEqual(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Verified outcomes — the only section that is not patient-reported
// ─────────────────────────────────────────────────────────────────────────────

describe("the verification section counts only what a pharmacist touched", () => {
  it("measures verification over the responses recorded in the window", async () => {
    // Every applied response is a recorded response: 8 dose answers + 3
    // problem reports that reached no specific dose + 3 pharmacist audit rows.
    // Two confirmations and one correction, so 3 of 14.
    expect(report.verification.recorded).toBe(14);
    expect(report.verification.confirmed).toBe(2);
    expect(report.verification.corrected).toBe(1);
    expect(report.verification.unverified).toBe(11);
    expect(report.verification.verificationRate).toBe(3 / 14);
  });

  it("keeps duplicate taps out of the denominator", async () => {
    // The mistake: counting every PatientResponse row. A patient double-tapping
    // the same button would then lower the verification rate, which says
    // something about the patient's thumb rather than about the pharmacist's
    // work. Two duplicates exist in the fixtures, so 16 is the bug.
    expect(report.verification.recorded).toBe(14);
    expect(report.verification.recorded).not.toBe(16);
  });

  it("counts a correction row recorded without superseding the patient's answer", async () => {
    // The mistake, in the other direction: filtering the section on
    // `applied: true` alone. A pharmacist's correction is a separate row that
    // applied nothing, and dropping it would erase the pharmacist's work —
    // leaving 13 rather than 14.
    expect(report.verification.corrected).toBe(1);
    expect(report.verification.recorded).not.toBe(13);
  });

  it("excludes a response received before the window", async () => {
    // A 200-day-old response is real history but not part of this window.
    expect(report.verification.recorded).toBe(14);
    expect(yearReport.verification.recorded).toBe(15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The three sections are not conflated
// ─────────────────────────────────────────────────────────────────────────────

describe("the three sections report different numbers for the same window", () => {
  it("never lets one section's figure stand in for another's", async () => {
    // The PRD's acceptance criterion, asserted directly. The fixtures are built
    // so that these three numbers differ: 10 doses were delivered, 5 doses are
    // scorable, 14 responses were recorded. A refactor that computed any one of
    // them from another's set would have to change at least one of these.
    expect(report.delivery.delivered).toBe(10);
    expect(report.responses.scorable).toBe(5);
    expect(report.verification.recorded).toBe(14);

    expect(report.delivery.delivered).not.toBe(report.responses.scorable);
    expect(report.verification.recorded).not.toBe(report.delivery.delivered);
    expect(report.verification.recorded).not.toBe(report.responses.scorable);

    // The rates must differ too: a "delivery rate" of 10/11 is our
    // infrastructure, a "response rate" of 3/5 is the patient's behaviour.
    expect(report.delivery.deliveryRate).toBe(10 / 11);
    expect(report.responses.responseRate).toBe(3 / 5);
    expect(report.delivery.deliveryRate).not.toBe(report.responses.responseRate);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Problem reasons, follow-up, workload, inbound
// ─────────────────────────────────────────────────────────────────────────────

describe("problem reasons and operations", () => {
  it("groups the reported problems, most frequent first", async () => {
    // Four problem reports in the window, one of them outside the 7-day report
    // and another outside the window entirely.
    expect(report.problems.total).toBe(4);
    expect(report.problems.top[0]).toEqual({ reason: "صداع", count: 2 });
    expect(report.problems.top.map((row) => row.count)).toEqual([2, 1, 1]);

    // The two single-report reasons tie on count, so their relative order is
    // not defined — asserted as a set. One of them carries no text at all, and
    // must still be reported rather than dropped.
    const singleReasons = report.problems.top.slice(1).map((row) => row.reason);
    expect(singleReasons).toContain("دوخة");
    expect(singleReasons).toContain(null);
  });

  it("reports follow-up completion over the cases opened in the window", async () => {
    // The mistake: dividing by all cases ever, or counting only RESOLVED while
    // CLOSED_NO_ACTION is also a finished case.
    expect(report.followUps.opened).toBe(5);
    expect(report.followUps.withFirstAction).toBe(3);
    expect(report.followUps.resolved).toBe(2);
    expect(report.followUps.completionRate).toBe(2 / 5);
  });

  it("attributes interventions to the pharmacist who recorded them", async () => {
    // Three for the first user, two for the second, one for a user row that no
    // longer exists. The orphan must be counted and rendered without a name,
    // not silently dropped — deleting a user does not undo the work.
    expect(report.workload.total).toBe(6);
    expect(report.workload.byUser.map((row) => row.interventions)).toEqual([3, 2, 1]);
    expect(report.workload.byUser[0].userId).toBe(workedUserId);
    expect(report.workload.byUser[0].fullName).toBe(`Reports Pharmacist ${RUN}`);
    expect(report.workload.byUser[1].userId).toBe(secondUserId);
    expect(report.workload.byUser[2].userId).toBe(`reports-gone-${RUN}`);
    expect(report.workload.byUser[2].fullName).toBeNull();
  });

  it("reports inbound processing outcomes, including the lost replies", async () => {
    // A message that arrived and could not be routed is our failure with a
    // clinical consequence: that reply is missing from the response figures.
    expect(report.inbound.received).toBe(4);
    expect(report.inbound.unrouted).toBe(1);
    expect(report.inbound.failed).toBe(1);

    // A message that resolved to no pharmacy at all belongs to no pharmacy's
    // report — it must not inflate these totals.
    expect(report.inbound.received).not.toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The window
// ─────────────────────────────────────────────────────────────────────────────

describe("the reporting window", () => {
  it("narrows and widens every section, not just the labels", async () => {
    // Doses sit 1..18 days back. A 7-day report sees the first six and none of
    // the rest — the boundary is not decorative: the 7-day dose falls outside
    // `since` because the query's clock is later than the fixture's.
    expect(sevenDayReport.window.days).toBe(7);
    expect(sevenDayReport.delivery.due).toBe(6);
    expect(sevenDayReport.responses.scorable).toBe(4);

    // Widening to a year picks up the deliberately old rows: the out-of-window
    // response, the old case, the old intervention and the old inbound message.
    expect(yearReport.followUps.opened).toBe(6);
    expect(yearReport.workload.total).toBe(7);
    expect(yearReport.verification.recorded).toBe(15);
    expect(yearReport.problems.total).toBe(5);
    expect(yearReport.inbound.received).toBe(5);
  });

  it("clamps a window a query string could not ask for", async () => {
    // `?days=100000` must not scan the whole table, and a zero-day window is
    // still a window.
    expect((await getOperationsReport(pharmacyId, 0)).window.days).toBe(1);
    expect((await getOperationsReport(pharmacyId, 100_000)).window.days).toBe(365);
  });

  it("reports null rather than 0 when there is nothing to measure", async () => {
    // The distinction that matters: 0% delivery says "we failed every send",
    // null says "we have not sent anything yet". A pharmacy that enrolled its
    // first patient this morning has not failed anyone.
    expect(idleReport.delivery.due).toBe(1);
    expect(idleReport.delivery.attempted).toBe(0);
    expect(idleReport.delivery.neverAttempted).toBe(1);
    expect(idleReport.delivery.deliveryRate).toBeNull();

    expect(idleReport.responses.scorable).toBe(0);
    expect(idleReport.responses.responseRate).toBeNull();
    expect(idleReport.responses.reportedAdherence).toBeNull();

    expect(idleReport.verification.recorded).toBe(0);
    expect(idleReport.verification.verificationRate).toBeNull();
    expect(idleReport.followUps.completionRate).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The delivery history — the /messages screen
// ─────────────────────────────────────────────────────────────────────────────

describe("the delivery history", () => {
  it("returns one page of the pharmacy's doses, newest first, with the true total", async () => {
    const { rows, total } = await listDeliveryHistory(pharmacyId);

    // The mistake: measuring scale by what fits on the page. A log screen that
    // reports "17" because 17 rows fitted would lie the moment it mattered.
    expect(total).toBe(17);
    expect(rows).toHaveLength(17);
    expect(rows[0].id).toBe(doses.get("taken")!.id);
    expect(rows[16].id).toBe(doses.get("settledNoSend")!.id);

    const row = findRow(rows, "taken");
    expect(row.patientName).toBe(PATIENT_NAME);
    expect(row.patientId).toBe(patientId);
    expect(row.medicationName).toBe(MEDICATION_NAME);
    expect(row.deliveryState).toBe("DELIVERED");
    expect(row.responseState).toBe("TAKEN");
  });

  it("caps the page size so one request can never hold a whole history", async () => {
    // The cap pharmacy holds 120 doses. A hand-edited `?limit=1000` must still
    // return 100 rows — the query module enforces the cap, not just the page.
    const capped = await listDeliveryHistory(capPharmacyId, { limit: 1000 });
    expect(capped.total).toBe(DELIVERY_HISTORY_MAX_LIMIT + 20);
    expect(capped.rows).toHaveLength(DELIVERY_HISTORY_MAX_LIMIT);

    // The default is one small page, and paging reaches the rest.
    const firstPage = await listDeliveryHistory(capPharmacyId);
    expect(firstPage.rows).toHaveLength(DELIVERY_HISTORY_DEFAULT_LIMIT);
    expect(firstPage.total).toBe(120);

    const secondPage = await listDeliveryHistory(capPharmacyId, { limit: 100, offset: 100 });
    expect(secondPage.rows).toHaveLength(20);

    // A nonsense limit falls back to a single row rather than to everything.
    const zero = await listDeliveryHistory(capPharmacyId, { limit: 0 });
    expect(zero.rows).toHaveLength(1);
    expect(zero.total).toBe(120);
  });

  it("says how many sends were attempted and why the last one failed", async () => {
    // The mistake: rendering `deliveryState` alone and letting "sent 3 times,
    // all rejected" read the same as "never attempted". Both are one badge; only
    // the dispatch rows tell them apart.
    const { rows } = await listDeliveryHistory(pharmacyId);

    const rejected = findRow(rows, "failed");
    expect(rejected.dispatchCount).toBe(3);
    // The code of the LATEST failed attempt, not the first one's message.
    expect(rejected.lastFailure).toBe("131047");

    const delivered = findRow(rows, "taken");
    expect(delivered.dispatchCount).toBe(1);
    expect(delivered.lastFailure).toBeNull();

    const neverAttempted = findRow(rows, "scheduled");
    expect(neverAttempted.dispatchCount).toBe(0);
    expect(neverAttempted.lastFailure).toBeNull();
  });

  it("shows the patient's own words and when they arrived", async () => {
    const { rows } = await listDeliveryHistory(pharmacyId);

    const reported = findRow(rows, "problem");
    expect(reported.responseState).toBe("PROBLEM");
    expect(reported.responseFreeText).toBe("صداع");
    expect(reported.responseReceivedAtUtc).not.toBeNull();

    // A dose with no reply says exactly that: no response time, and — while the
    // window is still open — no settlement either.
    const silent = findRow(rows, "inFlight");
    expect(silent.responseState).toBe("NONE");
    expect(silent.responseReceivedAtUtc).toBeNull();
    expect(silent.settledAtUtc).toBeNull();
  });

  it("filters by delivery state, response state, day and patient", async () => {
    const expired = await listDeliveryHistory(pharmacyId, { deliveryState: "EXPIRED" });
    expect(expired.total).toBe(1);
    expect(expired.rows[0].id).toBe(doses.get("expired")!.id);

    const missedAndDelivered = await listDeliveryHistory(pharmacyId, {
      deliveryState: "DELIVERED",
      responseState: "MISSED",
    });
    expect(missedAndDelivered.total).toBe(1);
    expect(missedAndDelivered.rows[0].id).toBe(doses.get("missed")!.id);

    // The date filter is on the patient's own calendar day — the day meant by
    // "yesterday" — and each fixture dose has its own, so the range is exact.
    const day = dateOnly(doses.get("missed")!.doseLocalDate);
    const oneDay = await listDeliveryHistory(pharmacyId, { from: day, to: day });
    expect(oneDay.total).toBe(1);
    expect(oneDay.rows[0].id).toBe(doses.get("missed")!.id);

    const byPhone = await listDeliveryHistory(pharmacyId, { patientQuery: "9910001" });
    expect(byPhone.total).toBe(17);

    const byName = await listDeliveryHistory(pharmacyId, { patientQuery: `alpha ${RUN}` });
    expect(byName.total).toBe(17);
  });

  it("never returns another pharmacy's history, even for an identical patient", async () => {
    // The other pharmacy holds a patient with the SAME name and phone number.
    // If the patient filter replaced the tenant filter instead of narrowing it,
    // this search would return that pharmacy's rows.
    const mine = await listDeliveryHistory(pharmacyId, { patientQuery: "Alpha" });
    expect(mine.total).toBe(17);
    expect(mine.rows.every((row) => row.patientId === patientId)).toBe(true);

    const theirs = await listDeliveryHistory(otherPharmacyId, { patientQuery: "Alpha" });
    expect(theirs.total).toBe(1);
    expect(theirs.rows[0].patientId).toBe(otherPatientId);
  });
});
