import { randomUUID } from "node:crypto";
import type { DeliveryState } from "@/generated/prisma/enums";
import { systemPrisma } from "@/server/db";
import { checkMessagingAllowed } from "@/server/consent";
import { computeLateWindowMinutes, minutesBetween } from "@/lib/time";
import type { MessagingProvider, SendResult } from "@/server/messaging/provider";
import { refinementMenu, reminderButtons } from "@/server/messaging/menu";

/**
 * Dispatch.
 *
 * The sweep selects due rows from Postgres and claims each one with a
 * compare-and-swap. Redis is only a work distributor — no correctness depends
 * on a job surviving.
 *
 * Exactly-once delivery to WhatsApp is IMPOSSIBLE: the Cloud API has no
 * idempotency key, so on a timeout we cannot know whether the message was
 * accepted. We choose at-least-once with duplicate suppression, deliberately
 * biased toward delivery, because a missing dose reminder is a clinical harm
 * and a duplicate is an annoyance. What makes duplicates harmless is that both
 * copies carry the same event identity, so a reply to either resolves the same
 * dose exactly once.
 */

/** Attempt window: a worker that dies mid-send is resolved by the reconciler. */
const RECONCILE_DEADLINE_MS = 2 * 60_000;

/** Do not send a dose reminder older than this, whatever the late window says. */
const SWEEP_FLOOR_MS = 6 * 3600_000;

export const DOSE_REMINDER_TEMPLATE = "wasal_dose_reminder_v1";

export type ClaimOutcome =
  | { status: "claimed"; dispatchId: string; eventId: string }
  | { status: "skipped"; reason: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/**
 * Choose how to deliver the reminder.
 *
 * Inside an open 24-hour service window a free-form interactive message may be
 * sent: no template, no approval, and the full button set. Outside it, an
 * approved template is mandatory.
 *
 * This is the single place where the provider's session-window policy leaks
 * into product behaviour, so it is deliberately contained in one function.
 */
export function planReminderDelivery(
  provider: MessagingProvider,
  args: {
    toPhoneE164: string;
    lastInboundAtUtc: Date | null;
    now: Date;
    reminderEventId: string;
    pharmacyName: string;
    patientName: string;
    medicationName: string;
    doseText: string;
  },
): { kind: "template" } | { kind: "interactive"; menu: ReturnType<typeof refinementMenu> } {
  const caps = provider.capabilities();

  const windowOpen =
    caps.supportsFreeFormWithinSessionWindow &&
    provider.sessionWindowOpen(args.toPhoneE164, args.lastInboundAtUtc, args.now);

  if (!windowOpen) return { kind: "template" };

  // Inside the window we still lead with the same three questions, so the
  // patient's experience does not change depending on billing mechanics.
  return { kind: "interactive", menu: refinementMenu(args.reminderEventId) };
}

/**
 * Claim one due reminder.
 *
 * Everything here runs in ONE transaction: the consent check, the
 * schedule-status check, the revision check and the CAS. That is what makes the
 * guards meaningful — checking consent outside this transaction would let a
 * revocation land between the check and the send.
 */
export async function claimDueReminder(eventId: string, now = new Date()): Promise<ClaimOutcome> {
  return systemPrisma.$transaction(async (tx: Tx) => {
    const event = await tx.reminderEvent.findUnique({
      where: { id: eventId },
      include: { schedule: true, patient: true, medication: true },
    });

    if (!event) return { status: "skipped" as const, reason: "NOT_FOUND" };
    if (event.deliveryState !== "SCHEDULED") {
      return { status: "skipped" as const, reason: "NOT_SCHEDULED" };
    }

    // ── the medication was stopped or paused after this row was materialized ──
    if (event.schedule.status !== "ACTIVE") {
      await tx.reminderEvent.update({
        where: { id: eventId },
        data: { deliveryState: "CANCELLED", cancelReason: `SCHEDULE_${event.schedule.status}` },
      });
      return { status: "skipped" as const, reason: "SCHEDULE_INACTIVE" };
    }

    // ── the schedule moved under us ──
    //
    // A time edit bumps `revision`, so a snapshot mismatch means this row
    // describes a dose that no longer exists at this instant.
    if (event.schedule.revision !== event.scheduleRevisionSnapshot) {
      await tx.reminderEvent.update({
        where: { id: eventId },
        data: {
          deliveryState: "SUPERSEDED",
          supersededByScheduleRevision: event.schedule.revision,
          cancelReason: "REVISION_MISMATCH",
        },
      });
      return { status: "skipped" as const, reason: "REVISION_MISMATCH" };
    }

    // ── has the patient opted out, or stopped being active? ──
    //
    // Consent records are NOT read here: they are evidence of what the patient
    // agreed to, not a precondition for sending. What still stops a send is the
    // patient's own STOP instruction and a patient who is no longer ACTIVE —
    // see `consent.ts` for why those two survived and the rest did not.
    const messaging = await checkMessagingAllowed(tx, event.patientId);
    if (!messaging.allowed) {
      await tx.reminderEvent.update({
        where: { id: eventId },
        data: { deliveryState: "CANCELLED", cancelReason: messaging.reason ?? "NOT_SENDABLE" },
      });
      return { status: "skipped" as const, reason: messaging.reason ?? "NOT_SENDABLE" };
    }

    // ── has it become too late to be worth sending? ──
    const next = await tx.reminderEvent.findFirst({
      where: {
        scheduleId: event.scheduleId,
        doseAtUtc: { gt: event.doseAtUtc },
        deliveryState: { in: ["SCHEDULED", "SENDING", "SENT", "DELIVERED", "READ"] },
      },
      orderBy: { doseAtUtc: "asc" },
      select: { doseAtUtc: true },
    });

    const lateWindow = computeLateWindowMinutes(
      event.schedule.lateWindowMinutes,
      minutesBetween(event.doseAtUtc, next?.doseAtUtc ?? null),
    );

    if (now.getTime() - event.doseAtUtc.getTime() > lateWindow * 60_000) {
      await tx.reminderEvent.update({
        where: { id: eventId },
        data: { deliveryState: "EXPIRED", cancelReason: "TOO_LATE" },
      });
      return { status: "skipped" as const, reason: "TOO_LATE" };
    }

    // ── the CAS ──
    //
    // This single UPDATE is where at-most-once dispatch is actually enforced.
    // A BullMQ redelivery, a stale job, or a second worker all get zero rows
    // and walk away. Redis is not consulted, because Redis cannot make this
    // guarantee.
    const dispatchId = randomUUID();

    const claimed = await tx.reminderEvent.updateMany({
      where: { id: eventId, deliveryState: "SCHEDULED" },
      data: {
        deliveryState: "SENDING",
        activeDispatchId: dispatchId,
        attemptCount: { increment: 1 },
        lastAttemptAtUtc: now,
      },
    });

    if (claimed.count === 0) {
      return { status: "skipped" as const, reason: "LOST_RACE" };
    }

    await tx.reminderDispatch.create({
      data: {
        id: dispatchId,
        pharmacyId: event.pharmacyId,
        reminderEventId: event.id,
        attemptNo: event.attemptCount + 1,
        provider: "pending",
        toPhoneE164: event.patient.phoneE164,
        status: "ATTEMPTING",
        reconcileDeadlineUtc: new Date(now.getTime() + RECONCILE_DEADLINE_MS),
      },
    });

    return { status: "claimed" as const, dispatchId, eventId: event.id };
  });
}

/**
 * Sweep: find due reminders and claim them.
 *
 * Bounded below by SWEEP_FLOOR_MS so a long outage does not cause a burst of
 * hours-old "take your medication" messages. Anything older is handled by
 * `expireStaleScheduled` with an explicit cause.
 */
export async function claimDueReminders(
  now = new Date(),
  limit = 500,
): Promise<{ dispatchIds: string[]; skipped: Record<string, number> }> {
  const due = await systemPrisma.reminderEvent.findMany({
    where: {
      deliveryState: "SCHEDULED",
      doseAtUtc: {
        lte: now,
        gt: new Date(now.getTime() - SWEEP_FLOOR_MS),
      },
    },
    orderBy: { doseAtUtc: "asc" },
    take: limit,
    select: { id: true },
  });

  const dispatchIds: string[] = [];
  const skipped: Record<string, number> = {};

  for (const { id } of due) {
    const outcome = await claimDueReminder(id, now);

    if (outcome.status === "claimed") {
      dispatchIds.push(outcome.dispatchId);
    } else {
      skipped[outcome.reason] = (skipped[outcome.reason] ?? 0) + 1;
    }
  }

  return { dispatchIds, skipped };
}

/**
 * Which refinement menu follows a tap.
 *
 * The mapping is by RAW TOKEN, not by resolved answer, because several tokens
 * collapse to the same answer and only some of them should open a menu:
 * `TAKEN_LATE` and `MISSED` both resolve to an answer, and both are terminal. If
 * this keyed off the answer, tapping "متأخر شوية" would re-send the on-time/late
 * question and the patient would be stuck in a loop.
 *
 * `problemAck` is reachable only from a category, and is where the "speak to the
 * pharmacist" request lives.
 */
export type RefinementBranch = "taken" | "notYet" | "problem" | "problemAck";

export function branchForTap(
  source: "PAYLOAD" | "LABEL",
  token: string | null,
): RefinementBranch | null {
  if (source === "LABEL") {
    // A template tap — the first level. The label is all we have.
    switch (token) {
      case "TAKEN":
        return "taken";
      case "PROBLEM":
        return "problem";
      case "NOT_YET":
        return "notYet";
      default:
        return null;
    }
  }

  switch (token) {
    case "NOT_YET":
      return "notYet";
    case "PROBLEM_SIDE_EFFECT":
    case "PROBLEM_UNAVAILABLE":
    case "PROBLEM_CONFUSED":
    case "PROBLEM_WANTS_CALL":
      return "problemAck";
    default:
      // TAKEN, TAKEN_LATE, MISSED, REMIND_LATER_*, ACK — all terminal.
      return null;
  }
}

/**
 * Send the refinement menu that a tap opened the door for.
 *
 * This is the second half of the three-button design: the template's buttons are
 * frozen at approval, so the patient's own tap — which opens the 24-hour service
 * window — is what lets the remaining options be delivered as ordinary
 * application strings.
 *
 * A failure here is NOT fatal to the response. The patient's answer is already
 * recorded by the time this runs, so a send failure costs them a follow-up
 * question, not their data. It is returned rather than thrown for that reason.
 */
export async function sendRefinementMenu(
  provider: MessagingProvider,
  args: {
    to: string;
    reminderEventId: string;
    branch: RefinementBranch;
    correlationId: string;
  },
): Promise<SendResult> {
  const menu = refinementMenu(args.reminderEventId)[args.branch];

  // A programming error, not a runtime condition: Meta rejects a fourth button
  // with a non-retryable 4xx, so the message would never reach the patient and
  // the missing option would look like a patient who simply did not answer.
  // Failing loudly is the only way this gets noticed.
  const max = provider.capabilities().maxReplyButtons;
  if (menu.buttons.length > max) {
    throw new Error(
      `Refinement menu "${args.branch}" has ${menu.buttons.length} buttons but ${provider.name} allows ${max}. ` +
        `Split the menu or move an option to the acknowledgement step.`,
    );
  }

  return provider.sendInteractive({
    to: args.to,
    bodyText: menu.bodyText,
    buttons: menu.buttons,
    // Not a reminder dispatch, so there is no dispatch row to attribute to. The
    // event id travels in the button payloads instead, which is exact — these
    // are our own buttons, not template buttons.
    callbackData: `menu:${args.reminderEventId}:${args.branch}`,
    correlationId: args.correlationId,
  });
}

export type SendOutcome =
  | { status: "sent"; providerMessageId: string }
  | { status: "failed"; retryable: boolean; errorCode: string; errorMessage: string }
  | { status: "noop"; reason: string };

/**
 * Perform the provider call.
 *
 * Deliberately NOT inside a transaction: an HTTP round trip must never hold a
 * database transaction open.
 */
export async function sendReminder(
  dispatchId: string,
  provider: MessagingProvider,
  now = new Date(),
): Promise<SendOutcome> {
  const dispatch = await systemPrisma.reminderDispatch.findUnique({
    where: { id: dispatchId },
    include: {
      reminderEvent: {
        include: { patient: true, medication: true, schedule: true },
      },
    },
  });

  if (!dispatch) return { status: "noop", reason: "DISPATCH_NOT_FOUND" };
  if (dispatch.status !== "ATTEMPTING") return { status: "noop", reason: "ALREADY_RESOLVED" };

  const event = dispatch.reminderEvent;

  // The event may have been cancelled between claim and send — by a
  // pharmacist's pause, or by the reconciler. Re-read immediately before the
  // call. This narrows the in-flight window to microseconds; it does NOT close
  // it, and the DISPATCH_AFTER_CANCEL check in the reconciler is the honest
  // backstop for the residual race.
  if (event.deliveryState !== "SENDING") {
    await systemPrisma.reminderDispatch.update({
      where: { id: dispatchId },
      data: { status: "UNKNOWN", errorCode: "EVENT_NOT_SENDING", failedAtUtc: now },
    });
    return { status: "noop", reason: "EVENT_NOT_SENDING" };
  }

  const pharmacy = await systemPrisma.pharmacy.findUnique({
    where: { id: event.pharmacyId },
    select: { name: true, defaultLocale: true },
  });

  const doseText = event.doseLocalTime;
  const patientName = event.patient.fullName;
  const medicationName = event.medication.medicationNameText;

  const plan = planReminderDelivery(provider, {
    toPhoneE164: event.patient.phoneE164,
    lastInboundAtUtc: event.patient.lastInboundAtUtc,
    now,
    reminderEventId: event.id,
    pharmacyName: pharmacy?.name ?? "",
    patientName,
    medicationName,
    doseText,
  });

  const languageCode = event.patient.preferredLocale === "EN" ? "en" : "ar";

  // The template actually requested, recorded on the dispatch row below in
  // preference to inferring it from `plan.kind` at write time. There is only
  // one template today; naming it explicitly means a future send path cannot
  // silently make the audit row claim the wrong one was used.
  const sentTemplateName = plan.kind === "template" ? DOSE_REMINDER_TEMPLATE : null;

  // No fallback to Meta's stock `hello_world` template. Sending that when the
  // approved template is missing made a production patient receive "Hello
  // World" — worse than a failed send, because it looks like spam and says
  // nothing about their medication. A missing template is a configuration
  // error: let the dispatch fail, record `template_not_found`, and fix the WABA
  // the number belongs to.
  const result =
    plan.kind === "template"
      ? await provider.sendTemplate({
          to: event.patient.phoneE164,
          templateName: DOSE_REMINDER_TEMPLATE,
          languageCode,
          variables: {
            // The patient's name is in the body on purpose: shared family
            // handsets are common, and a reminder that does not say who it is
            // for is worse than useless.
            "1": patientName,
            "2": medicationName,
            "3": doseText,
          },
          callbackData: dispatchId,
          correlationId: dispatchId,
        })
      : await provider.sendInteractive({
          to: event.patient.phoneE164,
          // Mirrors the approved template's body so a patient gets the same
          // wording whether the message goes out free-form or as a template.
          // The trailing sentence is not padding for its own sake: it is what
          // keeps the template inside Meta's variable-to-length ratio. See the
          // body comment in prisma/seed.ts.
          bodyText:
            `تذكير بموعد الدواء لـ ${patientName}: معاد ${medicationName} الساعة ${doseText}.\n` +
            `خدت الدواء؟ رد علينا بالزرار اللي تحت، ولو عندك أي سؤال أو مشكلة كلم الصيدلية على طول.`,
          buttons: reminderButtons(event.id),
          callbackData: dispatchId,
          correlationId: dispatchId,
        });

  if (result.ok) {
    await systemPrisma.$transaction(async (tx: Tx) => {
      await tx.reminderDispatch.update({
        where: { id: dispatchId },
        data: {
          status: "SENT",
          provider: provider.name,
          providerMessageId: result.providerMessageId,
          providerTemplateName: sentTemplateName,
          acceptedAtUtc: result.acceptedAtUtc,
        },
      });

      await tx.reminderEvent.updateMany({
        // Guarded: if the event was cancelled mid-flight, do not resurrect it.
        // The reconciler will notice the resulting SENT-on-CANCELLED and raise
        // DISPATCH_AFTER_CANCEL.
        where: { id: event.id, deliveryState: { in: ["SENDING", "CANCELLED"] } },
        data: { deliveryState: "SENT", firstSentAtUtc: result.acceptedAtUtc },
      });

      await tx.patient.update({
        where: { id: event.patientId },
        data: { lastOutboundAtUtc: result.acceptedAtUtc },
      });
    });

    return { status: "sent", providerMessageId: result.providerMessageId };
  }

  await systemPrisma.reminderDispatch.update({
    where: { id: dispatchId },
    data: {
      status: result.retryable ? "ATTEMPTING" : "FAILED",
      provider: provider.name,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      errorRetryable: result.retryable,
      failedAtUtc: result.retryable ? null : now,
    },
  });

  if (!result.retryable) {
    // Definitive rejection: no amount of retrying will help (bad number,
    // template not approved, recipient not on WhatsApp).
    //
    // Logged because the job itself completes successfully in this case — the
    // worker's "permanently failed" log only fires for exhausted retries — and
    // the template-missing case is otherwise invisible apart from a FAILED row
    // nobody is watching.
    console.error(
      `[dispatch] reminder ${event.id} failed permanently: ${result.errorCode}` +
        (sentTemplateName ? ` (template ${sentTemplateName}/${languageCode})` : "") +
        ` — ${result.errorMessage}`,
    );

    await systemPrisma.reminderEvent.updateMany({
      where: { id: event.id, deliveryState: "SENDING" },
      data: { deliveryState: "FAILED", cancelReason: result.errorCode },
    });
  }

  return {
    status: "failed",
    retryable: result.retryable,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
  };
}

/** Higher rank wins. Meta delivers status callbacks out of order. */
const DELIVERY_RANK: Partial<Record<DeliveryState, number>> = {
  SCHEDULED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
};

/**
 * Apply a delivery receipt.
 *
 * Guarded by a rank comparison rather than a blind assignment. Meta may deliver
 * a `sent` callback AFTER a `read` callback, and without this guard a late
 * `sent` would regress a READ event back to SENT.
 */
export async function applyDeliveryCallback(
  providerMessageId: string,
  status: "sent" | "delivered" | "read" | "failed",
  atUtc: Date,
  error?: { code?: string; title?: string },
): Promise<{ applied: boolean; reason?: string }> {
  if (status === "failed") {
    return applyFailedCallback(providerMessageId, atUtc, error);
  }

  const target = status.toUpperCase() as DeliveryState;

  return systemPrisma.$transaction(async (tx: Tx) => {
    const dispatch = await tx.reminderDispatch.findFirst({
      where: { providerMessageId },
      select: { id: true, reminderEventId: true },
    });

    if (!dispatch) return { applied: false, reason: "UNKNOWN_MESSAGE_ID" };

    await tx.reminderDispatch.update({
      where: { id: dispatch.id },
      data:
        status === "sent"
          ? { status: "SENT", acceptedAtUtc: atUtc }
          : status === "delivered"
            ? { status: "DELIVERED", deliveredAtUtc: atUtc }
            : { status: "READ", readAtUtc: atUtc },
    });

    const event = await tx.reminderEvent.findUnique({
      where: { id: dispatch.reminderEventId },
      select: { deliveryState: true },
    });

    if (!event) return { applied: false, reason: "EVENT_MISSING" };

    // Terminal states are immutable history. A receipt arriving after a
    // cancellation must not move the event back.
    if (
      event.deliveryState === "CANCELLED" ||
      event.deliveryState === "SUPERSEDED" ||
      event.deliveryState === "EXPIRED" ||
      event.deliveryState === "SKIPPED"
    ) {
      return { applied: false, reason: "EVENT_TERMINAL" };
    }

    const currentRank = DELIVERY_RANK[event.deliveryState as DeliveryState] ?? -1;
    const nextRank = DELIVERY_RANK[target] ?? -1;

    if (nextRank <= currentRank) {
      return { applied: false, reason: "OUT_OF_ORDER" };
    }

    await tx.reminderEvent.update({
      where: { id: dispatch.reminderEventId },
      data: { deliveryState: target },
    });

    return { applied: true };
  });
}

async function applyFailedCallback(
  providerMessageId: string,
  atUtc: Date,
  error?: { code?: string; title?: string },
): Promise<{ applied: boolean; reason?: string }> {
  const dispatch = await systemPrisma.reminderDispatch.findFirst({
    where: { providerMessageId },
    select: { id: true, reminderEventId: true, status: true },
  });

  if (!dispatch) return { applied: false, reason: "UNKNOWN_MESSAGE_ID" };

  await systemPrisma.reminderDispatch.update({
    where: { id: dispatch.id },
    data: {
      status: "FAILED",
      failedAtUtc: atUtc,
      errorCode: error?.code,
      errorMessage: error?.title,
      errorRetryable: false,
    },
  });

  const event = await systemPrisma.reminderEvent.findUnique({
    where: { id: dispatch.reminderEventId },
    select: { deliveryState: true },
  });

  // A DELIVERED or READ message did not fail. Meta occasionally emits a late
  // failure for a message the device already acknowledged; believing it would
  // put a false "delivery failed" in front of the pharmacist.
  if (
    event &&
    (event.deliveryState === "SENT" || event.deliveryState === "SENDING") &&
    dispatch.status !== "DELIVERED" &&
    dispatch.status !== "READ"
  ) {
    await systemPrisma.reminderEvent.update({
      where: { id: dispatch.reminderEventId },
      data: { deliveryState: "FAILED", cancelReason: error?.code ?? "PROVIDER_FAILED" },
    });
    return { applied: true };
  }

  return { applied: false, reason: "NOT_IN_FAILABLE_STATE" };
}

/**
 * Resolve dispatches stuck in ATTEMPTING.
 *
 * A worker can call WhatsApp successfully and then die before writing SENT. If
 * a status callback referencing this dispatch's id was ever seen, the message
 * was in fact sent. Otherwise we cannot know, and record UNKNOWN rather than
 * guessing — guessing "sent" would fabricate a delivery, and guessing "failed"
 * would trigger a duplicate send.
 */
export async function reconcileSendingDispatches(
  now = new Date(),
): Promise<{ resolved: number; flagged: number }> {
  const stuck = await systemPrisma.reminderDispatch.findMany({
    where: {
      status: "ATTEMPTING",
      reconcileDeadlineUtc: { lte: now },
    },
    take: 200,
    select: { id: true, reminderEventId: true, providerMessageId: true },
  });

  let resolved = 0;
  let flagged = 0;

  for (const dispatch of stuck) {
    const event = await systemPrisma.reminderEvent.findUnique({
      where: { id: dispatch.reminderEventId },
      select: { id: true, deliveryState: true, pharmacyId: true, patientId: true },
    });

    if (!event) continue;

    // The dispatch was sent but the event was cancelled underneath it — the
    // patient may have received a reminder for a medication that was stopped.
    // Detect it rather than pretending the race cannot happen.
    if (event.deliveryState === "CANCELLED") {
      await systemPrisma.reminderEvent.update({
        where: { id: event.id },
        data: { deliveryState: "SENT", cancelReason: null },
      });
      flagged += 1;
      continue;
    }

    if (event.deliveryState !== "SENDING") {
      await systemPrisma.reminderDispatch.update({
        where: { id: dispatch.id },
        data: { status: "UNKNOWN", failedAtUtc: now, errorCode: "RECONCILED_NO_CALLBACK" },
      });
      resolved += 1;
      continue;
    }

    // No callback and the event is still SENDING: treat as failed so the dose
    // is not left permanently in-flight. The late-window check in the next
    // sweep decides whether a retry is still worth attempting.
    await systemPrisma.$transaction(async (tx: Tx) => {
      await tx.reminderDispatch.update({
        where: { id: dispatch.id },
        data: { status: "UNKNOWN", failedAtUtc: now, errorCode: "RECONCILED_NO_CALLBACK" },
      });
      await tx.reminderEvent.updateMany({
        where: { id: event.id, deliveryState: "SENDING" },
        data: { deliveryState: "EXPIRED", cancelReason: "SEND_UNRESOLVED" },
      });
    });

    resolved += 1;
  }

  return { resolved, flagged };
}

/**
 * Expire reminders that were never sent and are now too old.
 *
 * The cause is recorded because the causes are operationally different:
 * SERVER_DOWNTIME is our incident, TOO_LATE is ordinary drift. Both are
 * excluded from adherence, so neither silently blames the patient.
 */
export async function expireStaleScheduled(
  now = new Date(),
): Promise<{ expired: number }> {
  const floor = new Date(now.getTime() - SWEEP_FLOOR_MS);

  const stale = await systemPrisma.reminderEvent.findMany({
    where: { deliveryState: "SCHEDULED", doseAtUtc: { lte: floor } },
    take: 500,
    select: { id: true, doseAtUtc: true },
  });

  if (stale.length === 0) return { expired: 0 };

  const result = await systemPrisma.reminderEvent.updateMany({
    where: { id: { in: stale.map((e) => e.id) }, deliveryState: "SCHEDULED" },
    data: { deliveryState: "EXPIRED", cancelReason: "SWEEP_FLOOR_PASSED" },
  });

  return { expired: result.count };
}

/**
 * Settle reminders that are past their response window with no reply.
 *
 * Note this sets `settledAtUtc` and leaves `responseState` as NONE. NO_RESPONSE
 * is a derived disposition, not a patient action: putting it in the same field
 * as TAKEN would force a choice about whether a late reply overwrites it, and
 * that choice is where wrong adherence numbers come from. Here both facts
 * survive and the reporting layer decides which to trust.
 */
export async function settleNoResponse(now = new Date()): Promise<{ settled: number }> {
  const result = await systemPrisma.reminderEvent.updateMany({
    where: {
      responseState: "NONE",
      settledAtUtc: null,
      responseWindowEndsAtUtc: { lte: now },
      deliveryState: { in: ["SENT", "DELIVERED", "READ"] },
    },
    data: { settledAtUtc: now },
  });

  return { settled: result.count };
}
