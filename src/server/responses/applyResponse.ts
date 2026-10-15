import type {
  CaseOrigin,
  MessageIntent,
  Priority,
  ResponseChannel,
  ResponseState,
  Severity,
} from "@/generated/prisma/enums";
import { systemPrisma } from "@/server/db";
import { problemCategoryLabel } from "@/server/messaging/menu";

/**
 * Applying a patient response.
 *
 * Three rules govern everything here, and each exists because the obvious
 * alternative produces wrong clinical records:
 *
 *   1. ALWAYS STORE, NEVER THROW.
 *      `PatientResponse` deliberately has no unique constraint on
 *      `reminderEventId`. A duplicate tap must be storable and ignorable. If it
 *      threw, the webhook would answer Meta with a 500 and Meta would retry —
 *      forever. The duplicate is recorded, marked `applied = false`, and the
 *      pharmacist can see that the patient tapped twice.
 *
 *   2. FIRST RESPONSE WINS FOR ADHERENCE.
 *      Tapping "خدته" and then "فوّتت الجرعة" does not mean the dose was missed;
 *      it usually means a mis-tap, or a patient correcting themselves. The first
 *      answer is what scores the dose, and every later answer is kept as history
 *      with `appliedToAdherence = false`. The reverse — last-write-wins — lets a
 *      pocket-dial erase an accurate record.
 *
 *   3. UNION FOR SAFETY.
 *      "First wins" is a rule about scoring, not about listening. If a second
 *      message reports a PROBLEM, a case is opened even though the response did
 *      not score. A symptom report must never be suppressed by a bookkeeping
 *      rule.
 */

/**
 * How long after the response window a reply stops being trustworthy as a
 * description of that dose.
 *
 * The reply is still stored — a patient saying "I missed yesterday morning's
 * dose" the next day is useful to the pharmacist. It is excluded from the rule
 * engine, because "missed" reported 14 hours late cannot reliably be
 * distinguished from a patient who simply did not engage until then.
 */
const STALE_AFTER_MS = 12 * 3600_000;

/** Snooze bounds. The point of a snooze is a nudge, not indefinite deferral. */
const MIN_SNOOZE_MINUTES = 5;
const MAX_SNOOZE_MINUTES = 240;
const MAX_SNOOZES_PER_EVENT = 3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export type ApplyResponseInput = {
  pharmacyId: string;
  patientId: string;
  /** Null when attribution could not tie the reply to a specific dose. */
  reminderEventId: string | null;
  channel: ResponseChannel;
  /** Null when the patient opened a menu without answering, or sent free text. */
  answer: ResponseState | null;
  freeText?: string | null;
  intentClassified?: MessageIntent | null;
  /** wamid of the reply itself — the idempotency key against Meta's retries. */
  rawMessageId?: string | null;
  inboundMessageId?: string | null;
  receivedAtUtc: Date;
  snoozeMinutes?: number | null;
  patientClaimedAtUtc?: Date | null;
  /** Payload of the button tapped, when there was one. Preserved verbatim. */
  rawPayload?: string | null;
};

export type ApplyResponseResult = {
  responseId: string | null;
  /** Meta redelivered a reply we had already stored. */
  duplicate: boolean;
  /** Whether this response set the dose's outcome. */
  applied: boolean;
  appliedToAdherence: boolean;
  ruleEligible: boolean;
  staleFlag: boolean;
  /** A reply arriving after the dose had been settled as NO_RESPONSE. */
  lateReopen: boolean;
  caseId: string | null;
  alertId: string | null;
  snoozeEventId: string | null;
  snoozeSuppressedReason?: string;
};

export async function applyResponse(input: ApplyResponseInput): Promise<ApplyResponseResult> {
  return systemPrisma.$transaction(async (tx: Tx) => {
    // ── idempotency against Meta's webhook retries ──
    //
    // `InboundMessage.providerMessageId` is already unique, so the same reply
    // rarely reaches here twice. This is the second line of defence: if it does,
    // we return the existing row rather than creating a phantom second response
    // that would read to the pharmacist as the patient answering twice.
    if (input.rawMessageId) {
      const existing = await tx.patientResponse.findUnique({
        where: { rawMessageId: input.rawMessageId },
        select: { id: true },
      });

      if (existing) {
        return {
          responseId: existing.id,
          duplicate: true,
          applied: false,
          appliedToAdherence: false,
          ruleEligible: false,
          staleFlag: false,
          lateReopen: false,
          caseId: null,
          alertId: null,
          snoozeEventId: null,
        };
      }
    }

    const event = input.reminderEventId
      ? await tx.reminderEvent.findUnique({
          where: { id: input.reminderEventId },
          select: {
            id: true,
            pharmacyId: true,
            patientId: true,
            medicationId: true,
            scheduleId: true,
            doseAtUtc: true,
            responseWindowEndsAtUtc: true,
            responseState: true,
            settledAtUtc: true,
            countedForAdherence: true,
            snoozeCount: true,
          },
        })
      : null;

    // A reply that resolved to a dose belonging to a different patient would
    // mean attribution is wrong. Refuse to write it rather than corrupt a record.
    if (event && event.patientId !== input.patientId) {
      throw new Error(
        `Attribution mismatch: event ${event.id} belongs to patient ${event.patientId}, not ${input.patientId}`,
      );
    }

    const staleFlag = Boolean(
      event &&
        input.receivedAtUtc.getTime() >
          event.responseWindowEndsAtUtc.getTime() + STALE_AFTER_MS,
    );

    // ── first-response-wins ──
    const priorCount = event
      ? await tx.patientResponse.count({
          where: { reminderEventId: event.id, applied: true },
        })
      : 0;

    const isFirst = priorCount === 0;

    // A response carrying no answer (opening the refinement menu) records the
    // engagement but applies nothing — the dose stays open for a real answer.
    const applied = isFirst && input.answer !== null;

    const appliedToAdherence = applied && event ? event.countedForAdherence : applied;

    // `lateReopen` is the honest record of a reply that arrived after the dose
    // had already been written off as NO_RESPONSE. The settlement row is not
    // erased — both facts stand, and the reporting layer decides which to trust.
    const lateReopen = Boolean(applied && event?.settledAtUtc);

    const intentLabel =
      input.answer === "PROBLEM" && input.rawPayload
        ? problemCategoryLabel(input.rawPayload)
        : null;

    const response = await tx.patientResponse.create({
      data: {
        pharmacyId: input.pharmacyId,
        patientId: input.patientId,
        reminderEventId: event?.id ?? null,
        inboundMessageId: input.inboundMessageId ?? null,
        rawMessageId: input.rawMessageId ?? null,
        channel: input.channel,
        answer: input.answer,
        freeText: input.freeText ?? intentLabel ?? null,
        intentClassified: input.intentClassified ?? null,
        // Patient-reported discipline: these are structurally fixed on this
        // path, and a DB CHECK constraint enforces the invariant independently
        // of this code.
        source: "PATIENT_REPORTED",
        isVerified: false,
        verificationState: "UNVERIFIED",
        applied,
        appliedToAdherence,
        // A duplicate or stale response is kept for history but excluded from
        // the fact book, so it can neither manufacture a "3 consecutive misses"
        // alert nor mask a real one.
        ruleEligible: applied && !staleFlag,
        staleFlag,
        receivedAtUtc: input.receivedAtUtc,
        patientClaimedAtUtc: input.patientClaimedAtUtc ?? null,
      },
      select: { id: true },
    });

    if (event && applied) {
      await tx.reminderEvent.update({
        where: { id: event.id },
        data: {
          responseState: input.answer,
          lateReopen: lateReopen || event.responseState !== "NONE",
        },
      });
    }

    // ── union for safety: a reported problem always opens a case ──
    let caseId: string | null = null;
    let alertId: string | null = null;

    if (input.answer === "PROBLEM") {
      const opened = await openProblemCase(tx, {
        pharmacyId: input.pharmacyId,
        patientId: input.patientId,
        medicationId: event?.medicationId ?? null,
        eventId: event?.id ?? null,
        responseId: response.id,
        category: intentLabel,
        freeText: input.freeText ?? null,
        atUtc: input.receivedAtUtc,
      });
      caseId = opened.caseId;
      alertId = opened.alertId;
    }

    // ── snooze ──
    let snoozeEventId: string | null = null;
    let snoozeSuppressedReason: string | undefined;

    if (input.answer === "REMIND_LATER" && event) {
      const snooze = await createSnoozeEvent(tx, event, input, intentLabel);
      snoozeEventId = snooze.id;
      snoozeSuppressedReason = snooze.suppressedReason;
    }

    return {
      responseId: response.id,
      duplicate: false,
      applied,
      appliedToAdherence,
      ruleEligible: applied && !staleFlag,
      staleFlag,
      lateReopen,
      caseId,
      alertId,
      snoozeEventId,
      snoozeSuppressedReason,
    };
  });
}

/**
 * Create a follow-up case (and its alert) for a patient-reported problem.
 *
 * Idempotent against the partial unique index on `Alert(dedupeKey)`: a second
 * problem report while one is still open does not create a second row, it bumps
 * the occurrence count. The insert is attempted rather than pre-checked with a
 * SELECT, because a read-then-insert races and the index is the only thing that
 * actually enforces it.
 */
async function openProblemCase(
  tx: Tx,
  args: {
    pharmacyId: string;
    patientId: string;
    medicationId: string | null;
    eventId: string | null;
    responseId: string;
    category: string | null;
    freeText: string | null;
    atUtc: Date;
  },
): Promise<{ caseId: string | null; alertId: string | null }> {
  const dedupeKey = `PATIENT_REPORTED_PROBLEM|${args.patientId}|${args.medicationId ?? "none"}`;

  const patient = await tx.patient.findUnique({
    where: { id: args.patientId },
    select: { fullName: true },
  });
  const patientName = patient?.fullName ?? "";

  const detail =
    args.category ?? args.freeText ?? "Patient reported a problem via WhatsApp";

  const evidence = {
    responseId: args.responseId,
    reminderEventId: args.eventId,
    category: args.category,
    freeText: args.freeText,
    reportedAtUtc: args.atUtc.toISOString(),
    source: "PATIENT_REPORTED",
  };

  let alert = await tx.alert.findFirst({
    where: { dedupeKey, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    select: { id: true, caseId: true },
  });

  if (alert) {
    // Already open — this is a repeat report, which is itself clinically
    // meaningful, so it is counted rather than swallowed.
    await tx.alert.update({
      where: { id: alert.id },
      data: {
        lastSeenAtUtc: args.atUtc,
        occurrenceCount: { increment: 1 },
        evidence,
      },
    });
    await tx.alertEvent.create({
      data: {
        alertId: alert.id,
        eventType: "REPEATED",
        meta: { detail },
        atUtc: args.atUtc,
      },
    });
  } else {
    alert = await tx.alert.create({
      data: {
        pharmacyId: args.pharmacyId,
        patientId: args.patientId,
        medicationId: args.medicationId,
        ruleKey: "PATIENT_REPORTED_PROBLEM",
        ruleVersion: 1,
        dedupeKey,
        severity: "URGENT" as Severity,
        status: "OPEN",
        titleAr: `بلاغ مشكلة من ${patientName}`,
        titleEn: `Problem reported by ${patientName}`,
        detailAr: detail,
        detailEn: detail,
        evidence,
        openedAtUtc: args.atUtc,
        lastSeenAtUtc: args.atUtc,
      },
      select: { id: true, caseId: true },
    });

    await tx.alertEvent.create({
      data: {
        alertId: alert.id,
        eventType: "OPENED",
        meta: { detail },
        atUtc: args.atUtc,
      },
    });
  }

  if (alert.caseId) {
    return { caseId: alert.caseId, alertId: alert.id };
  }

  const created = await tx.followUpCase.create({
    data: {
      pharmacyId: args.pharmacyId,
      patientId: args.patientId,
      medicationId: args.medicationId,
      openedByAlertId: alert.id,
      origin: "PROBLEM_RESPONSE" as CaseOrigin,
      priority: "HIGH" as Priority,
      status: "OPEN",
      titleAr: `مشكلة أبلغ عنها ${patientName}`,
      titleEn: `Problem reported by ${patientName}`,
      summary: detail,
    },
    select: { id: true },
  });

  await tx.alert.update({
    where: { id: alert.id },
    data: { caseId: created.id },
  });

  return { caseId: created.id, alertId: alert.id };
}

/**
 * Create the snooze child reminder.
 *
 * Three clamps, each of which prevents a distinct bad outcome:
 *
 *   - the duration is bounded, so "remind me later" cannot become "remind me
 *     tomorrow";
 *   - a snooze that would land at or after the NEXT scheduled dose is dropped,
 *     because the next reminder is about to fire anyway and two reminders for
 *     two different doses minutes apart is how patients learn to ignore them;
 *   - the chain is capped, so a patient cannot keep a dose open indefinitely.
 *
 * `countedForAdherence: false` is enforced by a database CHECK constraint, not
 * just by this line: the dose is the unit of adherence scoring, not the nudge.
 */
async function createSnoozeEvent(
  tx: Tx,
  event: {
    id: string;
    pharmacyId: string;
    patientId: string;
    medicationId: string;
    scheduleId: string;
    doseAtUtc: Date;
    snoozeCount: number;
  },
  input: ApplyResponseInput,
  label: string | null,
): Promise<{ id: string | null; suppressedReason?: string }> {
  if (event.snoozeCount >= MAX_SNOOZES_PER_EVENT) {
    return {
      id: null,
      suppressedReason: "MAX_SNOOZES_REACHED",
    };
  }

  const minutes = Math.min(
    MAX_SNOOZE_MINUTES,
    Math.max(MIN_SNOOZE_MINUTES, input.snoozeMinutes ?? 15),
  );

  const snoozeAt = new Date(input.receivedAtUtc.getTime() + minutes * 60_000);

  const nextDose = await tx.reminderEvent.findFirst({
    where: {
      scheduleId: event.scheduleId,
      doseAtUtc: { gt: event.doseAtUtc },
      kind: "SCHEDULED_DOSE",
      deliveryState: { notIn: ["CANCELLED", "SUPERSEDED"] },
    },
    orderBy: { doseAtUtc: "asc" },
    select: { doseAtUtc: true },
  });

  if (nextDose && snoozeAt.getTime() >= nextDose.doseAtUtc.getTime()) {
    return { id: null, suppressedReason: "NEXT_DOSE_IMMINENT" };
  }

  const schedule = await tx.medicationSchedule.findUnique({
    where: { id: event.scheduleId },
    select: { responseWindowMinutes: true },
  });

  const windowMinutes = schedule?.responseWindowMinutes ?? 120;

  try {
    const created = await tx.reminderEvent.create({
      data: {
        pharmacyId: event.pharmacyId,
        patientId: event.patientId,
        medicationId: event.medicationId,
        scheduleId: event.scheduleId,
        scheduleRevisionSnapshot: 1,
        kind: "SNOOZE",
        parentEventId: event.id,
        doseAtUtc: snoozeAt,
        doseLocalDate: new Date(
          Date.UTC(
            input.receivedAtUtc.getUTCFullYear(),
            input.receivedAtUtc.getUTCMonth(),
            input.receivedAtUtc.getUTCDate(),
          ),
        ),
        doseLocalTime: `${String(input.receivedAtUtc.getUTCHours()).padStart(2, "0")}:${String(
          input.receivedAtUtc.getUTCMinutes(),
        ).padStart(2, "0")}`,
        responseWindowEndsAtUtc: new Date(snoozeAt.getTime() + windowMinutes * 60_000),
        // The dose is what gets scored. A nudge that nobody answers must not
        // read as a missed dose.
        countedForAdherence: false,
        skipReason: label,
      },
      select: { id: true },
    });

    await tx.reminderEvent.update({
      where: { id: event.id },
      data: { snoozeCount: { increment: 1 } },
    });

    return { id: created.id };
  } catch (err) {
    // Unique violation on (scheduleId, doseAtUtc): the snooze landed exactly on
    // a real dose slot. The real reminder is strictly better, so drop the snooze
    // rather than rescheduling it somewhere arbitrary.
    if (isUniqueViolation(err)) {
      return { id: null, suppressedReason: "COLLIDES_WITH_SCHEDULED_DOSE" };
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * Record a patient STOP request.
 *
 * Handled outside the normal response path because it is an instruction about
 * future messaging, not an answer about a past dose. Applied immediately and
 * without human confirmation: continuing to message someone who asked us to
 * stop, while a pharmacist decides, is not a defensible default.
 */
export async function recordOptOut(
  pharmacyId: string,
  patientId: string,
  atUtc: Date,
): Promise<void> {
  await systemPrisma.$transaction(async (tx: Tx) => {
    // `messagingOptOutAt` is the mechanism, and it is the first thing
    // `checkMessagingAllowed` tests — so the reason the pharmacist sees is the
    // most specific one available.
    //
    // Note the patient's `status` is deliberately NOT changed. Opting out of
    // messaging is a decision about one channel, not about the care
    // relationship; marking them ARCHIVED would hide an active patient from the
    // pharmacist's list, which is a worse error than the one it would fix.
    await tx.patient.update({
      where: { id: patientId },
      data: { messagingOptOutAt: atUtc },
    });

    await tx.consentRecord.create({
      data: {
        pharmacyId,
        patientId,
        consentType: "WHATSAPP_MESSAGING",
        granted: false,
        revokedAt: atUtc,
        revokedReason: "Patient sent STOP via WhatsApp",
        captureMethod: "DIGITAL",
        notes: "Opt-out received as an inbound WhatsApp message",
      },
    });

    // Cancel everything already materialized. Without this, the next sweep
    // would happily send a reminder the patient explicitly refused.
    await tx.reminderEvent.updateMany({
      where: {
        patientId,
        deliveryState: "SCHEDULED",
        doseAtUtc: { gt: atUtc },
      },
      data: { deliveryState: "CANCELLED", cancelReason: "PATIENT_OPTED_OUT" },
    });
  });
}
