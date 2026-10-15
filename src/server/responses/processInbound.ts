import type { MessageIntent, ResponseChannel, ResponseState } from "@/generated/prisma/enums";
import { systemPrisma } from "@/server/db";
import type { InboundKind, NormalizedInboundEvent } from "@/server/messaging/provider";
import { answerFromButtonLabel, parseButtonPayload } from "@/server/messaging/menu";
import { getMessagingProvider } from "@/server/messaging/factory";
import { branchForTap, sendRefinementMenu } from "@/server/scheduling/dispatch";
import { writeSystemAudit } from "@/server/audit";
import { attributeInbound, classifyFreeText, intentToAnswer, mostRecentOpenEvent } from "./attribute";
import { applyResponse, recordOptOut } from "./applyResponse";

/**
 * The inbound pipeline.
 *
 * The webhook route does exactly three things — verify the signature, persist,
 * return 200 — and then enqueues. Everything that touches clinical data happens
 * here, asynchronously, because Meta retries a webhook that does not answer
 * quickly, and a slow handler therefore turns into duplicate deliveries.
 *
 * Idempotent by construction: `InboundMessage.providerMessageId` is unique, so a
 * redelivery is stored once, and this function no-ops on an already-processed
 * row.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export type ProcessOutcome =
  | { status: "ALREADY_PROCESSED" }
  | { status: "NOT_FOUND" }
  | {
      status: "UNROUTED";
      reason: "NO_PHARMACY" | "NO_PATIENT" | "AMBIGUOUS_PHONE" | "UNRECOGNISED_LABEL";
    }
  | {
      status: "ROUTED";
      patientId: string;
      reminderEventId: string | null;
      answer: ResponseState | null;
      applied: boolean;
      caseId: string | null;
      snoozeEventId: string | null;
      /** Whether the follow-up menu that the tap unlocked was delivered. */
      menuSent: boolean;
    }
  | { status: "OPTED_OUT"; patientId: string };

export async function processInboundMessage(
  inboundMessageId: string,
): Promise<ProcessOutcome> {
  const row = await systemPrisma.inboundMessage.findUnique({
    where: { id: inboundMessageId },
    select: {
      id: true,
      pharmacyId: true,
      providerMessageId: true,
      fromPhoneE164: true,
      toPhoneE164: true,
      contextMessageId: true,
      type: true,
      rawPayload: true,
      receivedAtUtc: true,
      processedAtUtc: true,
    },
  });

  if (!row) return { status: "NOT_FOUND" };
  if (row.processedAtUtc) return { status: "ALREADY_PROCESSED" };

  const event = reconstructInbound(row);

  // ── which pharmacy received this? ──
  //
  // `toPhoneE164` holds the receiving channel key (Meta's `phone_number_id`),
  // not a dialable number — that is what the webhook is routed by.
  const channel = row.pharmacyId
    ? { pharmacyId: row.pharmacyId }
    : await systemPrisma.messagingChannel.findFirst({
        where: { providerPhoneNumberId: row.toPhoneE164 },
        select: { pharmacyId: true },
      });

  const pharmacyId = channel?.pharmacyId ?? null;

  if (!pharmacyId) {
    await markUnrouted(row.id, "NO_PHARMACY");
    return { status: "UNROUTED", reason: "NO_PHARMACY" };
  }

  const attribution = await attributeInbound(event, pharmacyId);

  if (attribution.kind === "UNKNOWN") {
    await markUnrouted(row.id, "NO_PATIENT");
    return { status: "UNROUTED", reason: "NO_PATIENT" };
  }

  if (attribution.kind === "AMBIGUOUS") {
    // Several patients share this handset. We deliberately do not guess: a wrong
    // guess silently corrupts one patient's adherence record and there is no
    // signal that it happened.
    //
    // It is stored and surfaced for the pharmacist to disambiguate rather than
    // dropped, because the patient did tell us something.
    await markUnrouted(row.id, "AMBIGUOUS_PHONE");
    return { status: "UNROUTED", reason: "AMBIGUOUS_PHONE" };
  }

  const patientId = attribution.patientId;

  // Every inbound refreshes the session window, including ones we cannot
  // attribute — the patient has engaged, and that is true regardless of whether
  // we know who they are or what they meant.
  await systemPrisma.patient.update({
    where: { id: patientId },
    data: { lastInboundAtUtc: row.receivedAtUtc },
  });

  // ── decode what was said ──
  const decoded = decodeReply(event);

  // STOP is an instruction about the future, not an answer about a dose, so it
  // is applied immediately and without human confirmation. Continuing to message
  // someone who asked us to stop, while a pharmacist gets round to deciding, is
  // not a defensible default.
  if (decoded.intent === "STOP") {
    await recordOptOut(pharmacyId, patientId, row.receivedAtUtc);
    await finalise(row.id, {
      status: "ROUTED",
      patientId,
      reminderEventId: attribution.kind === "EVENT" ? attribution.reminderEventId : null,
    });
    return { status: "OPTED_OUT", patientId };
  }

  // ── resolve the dose ──
  //
  // An exact event wins. Otherwise, for a reply that clearly came from one
  // patient and carries no reference, the most recent still-open dose is
  // attached — bounded by the response window, so a message sent three days
  // later starts a new conversation rather than falsifying an old dose.
  let reminderEventId: string | null =
    attribution.kind === "EVENT" ? attribution.reminderEventId : null;

  if (!reminderEventId && decoded.answer !== null) {
    const recent = await mostRecentOpenEvent(patientId, row.receivedAtUtc);
    reminderEventId = recent?.id ?? null;
  }

  // A template reply whose label we do not recognise is a genuine operational
  // problem: it means the approved template was edited and the inbound matcher
  // no longer knows what it is reading. The reply is still stored, but it is
  // recorded as ineligible for scoring and surfaced, because the alternative —
  // treating an unknown label as *something* — would silently write a wrong
  // adherence fact for every patient.
  if (
    !decoded.recognised &&
    decoded.title !== null &&
    attribution.kind === "EVENT"
  ) {
    await writeSystemAudit({
      pharmacyId,
      entityType: "WhatsAppTemplate",
      entityId: attribution.reminderEventId,
      action: "TEMPLATE_LABEL_UNRECOGNISED",
      reason: `Unrecognised button label: ${decoded.title}`,
    });

    await finalise(row.id, { status: "ROUTED", patientId, reminderEventId });
    return { status: "UNROUTED", reason: "UNRECOGNISED_LABEL" };
  }

  const result = await applyResponse({
    pharmacyId,
    patientId,
    reminderEventId,
    channel: decoded.channel,
    answer: decoded.answer,
    freeText: decoded.text ?? decoded.title ?? null,
    intentClassified: decoded.intent,
    rawMessageId: row.providerMessageId,
    inboundMessageId: row.id,
    receivedAtUtc: row.receivedAtUtc,
    snoozeMinutes: decoded.snoozeMinutes,
    rawPayload: event.buttonPayload,
  });

  await finalise(row.id, { status: "ROUTED", patientId, reminderEventId });

  // ── open the refinement step ──
  //
  // The patient's tap opened the 24-hour service window. That is the entire
  // mechanism by which the options beyond the template's three buttons are
  // reachable, so this send is the load-bearing half of the interaction design,
  // not a nicety.
  //
  // A failure here does NOT fail the message: the answer is already recorded, so
  // the cost is a follow-up question the patient never got, not lost data.
  let menuSent = false;
  if (
    reminderEventId &&
    (decoded.source === "PAYLOAD" || decoded.source === "LABEL")
  ) {
    const branch = branchForTap(decoded.source, decoded.rawToken);

    if (branch) {
      try {
        const provider = getMessagingProvider();
        const sent = await sendRefinementMenu(provider, {
          to: event.fromPhoneE164,
          reminderEventId,
          branch,
          correlationId: row.providerMessageId,
        });

        if (!sent.ok) {
          console.error(
            `[inbound] refinement menu "${branch}" not sent for event ${reminderEventId}: ${sent.errorCode} ${sent.errorMessage}`,
          );
        } else {
          menuSent = true;
        }
      } catch (err) {
        // Thrown only for a menu that exceeds the provider's button limit — a
        // programming error worth surfacing loudly rather than retrying.
        console.error(`[inbound] refinement menu "${branch}" is invalid`, err);
      }
    }
  }

  return {
    status: "ROUTED",
    patientId,
    reminderEventId,
    answer: decoded.answer,
    applied: result.applied,
    caseId: result.caseId,
    snoozeEventId: result.snoozeEventId,
    menuSent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoding
// ─────────────────────────────────────────────────────────────────────────────

type Decoded = {
  answer: ResponseState | null;
  snoozeMinutes: number | null;
  intent: MessageIntent | null;
  text: string | null;
  title: string | null;
  channel: ResponseChannel;
  /** Which mechanism produced the answer. Drives the unrecognised-label check. */
  source: "PAYLOAD" | "LABEL" | "TEXT" | "NONE";
  /**
   * The raw token, before it was collapsed into an answer: `TAKEN_LATE`,
   * `REMIND_LATER_15`, `PROBLEM_SIDE_EFFECT`. Needed because several tokens map
   * to the same answer and only some of them should open a refinement menu —
   * keying the menu off the answer alone would re-ask a question the patient
   * just answered.
   */
  rawToken: string | null;
  /** False when a LABEL matched nothing in the vocabulary. */
  recognised: boolean;
};

/**
 * Turn a normalized inbound message into an answer.
 *
 * Three mechanisms, in descending order of trust:
 *
 *   1. PAYLOAD — our own interactive message carried an explicit `evt:<id>:<…>`.
 *      Exact.
 *   2. LABEL — a template button tap. Template payloads are static, so all we
 *      get is the button's visible text. Recovered by matching against the
 *      vocabulary in `@/server/messaging/menu`.
 *   3. TEXT — free text, classified conservatively. Advisory only.
 */
function decodeReply(event: NormalizedInboundEvent): Decoded {
  const channel: ResponseChannel =
    event.kind === "LIST_REPLY"
      ? "WHATSAPP_LIST"
      : event.kind === "TEXT"
        ? "WHATSAPP_TEXT"
        : "WHATSAPP_BUTTON";

  if (event.buttonPayload) {
    const parsed = parseButtonPayload(event.buttonPayload);
    if (parsed) {
      return {
        answer: parsed.answer,
        snoozeMinutes: parsed.snoozeMinutes,
        intent: null,
        text: null,
        title: null,
        channel,
        source: "PAYLOAD",
        rawToken: event.buttonPayload.split(":").pop() ?? null,
        recognised: true,
      };
    }
  }

  const label = event.title ?? null;
  if (label && (event.kind === "BUTTON_REPLY" || event.kind === "LIST_REPLY")) {
    const parsed = answerFromButtonLabel(label);
    if (parsed) {
      return {
        answer: parsed.answer,
        snoozeMinutes: parsed.snoozeMinutes,
        intent: null,
        text: null,
        title: label,
        channel,
        source: "LABEL",
        rawToken: null,
        recognised: true,
      };
    }
    // An unrecognised label is reported, not guessed at — see the caller.
    return {
      answer: null,
      snoozeMinutes: null,
      intent: null,
      text: null,
      title: label,
      channel,
      source: "LABEL",
      rawToken: null,
      recognised: false,
    };
  }

  const text = event.text ?? null;
  if (text) {
    const intent = classifyFreeText(text);
    return {
      answer: intentToAnswer(intent),
      snoozeMinutes: null,
      intent,
      text,
      title: null,
      channel,
      source: "TEXT",
      rawToken: null,
      recognised: true,
    };
  }

  // Media, stickers, voice notes, unsupported types. The patient sent
  // *something* and we must not pretend otherwise, but there is no answer in it.
  return {
    answer: null,
    snoozeMinutes: null,
    intent: null,
    text: null,
    title: null,
    channel,
    source: "NONE",
    rawToken: null,
    recognised: true,
  };
}

/**
 * Rebuild the normalized shape from the stored row.
 *
 * The schema has no column for a button payload or label, so they are recovered
 * from `rawPayload`. The webhook is expected to store an envelope
 * (`{ normalized, raw }`) which makes this exact; the other two branches keep the
 * drain working against a plain normalized object or a raw Meta payload, so a
 * mismatch in storage format degrades instead of losing patient replies.
 */
function reconstructInbound(row: {
  providerMessageId: string;
  fromPhoneE164: string;
  toPhoneE164: string;
  contextMessageId: string | null;
  type: string;
  rawPayload: unknown;
  receivedAtUtc: Date;
}): NormalizedInboundEvent {
  const base: NormalizedInboundEvent = {
    providerMessageId: row.providerMessageId,
    providerTimestamp: row.receivedAtUtc,
    fromPhoneE164: row.fromPhoneE164,
    toPhoneE164: row.toPhoneE164,
    kind: mapKind(row.type),
    buttonPayload: null,
    // The schema has no column for these and this fallback has no stored
    // envelope to read them from — the same reason `buttonPayload` starts null.
    rowId: null,
    title: null,
    mediaType: null,
    contextMessageId: row.contextMessageId,
    text: null,
    raw: row.rawPayload,
  };

  const payload = row.rawPayload;

  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;

    // Branch 1: the envelope the webhook is asked to store.
    const normalized = obj.normalized as Record<string, unknown> | undefined;
    if (normalized && typeof normalized === "object") {
      return mergeNormalized(base, normalized);
    }

    // Branch 2: an already-flat object.
    if ("buttonPayload" in obj || "text" in obj || "contextMessageId" in obj) {
      return mergeNormalized(base, obj);
    }

    // Branch 3: a raw Meta payload.
    const meta = extractFromMetaPayload(obj);
    if (meta) return { ...base, ...meta };
  }

  return base;
}

function mergeNormalized(
  base: NormalizedInboundEvent,
  src: Record<string, unknown>,
): NormalizedInboundEvent {
  return {
    ...base,
    kind: (src.kind as InboundKind) ?? base.kind,
    buttonPayload: (src.buttonPayload as string | null) ?? null,
    contextMessageId: (src.contextMessageId as string | null) ?? base.contextMessageId,
    title: (src.title as string | null) ?? null,
    text: (src.text as string | null) ?? null,
  };
}

/** Last-resort extraction from Meta's own payload tree. */
function extractFromMetaPayload(
  obj: Record<string, unknown>,
): Partial<NormalizedInboundEvent> | null {
  try {
    const entry = (obj.entry as unknown[])?.[0] as Record<string, unknown> | undefined;
    const change = (entry?.changes as unknown[])?.[0] as Record<string, unknown> | undefined;
    const value = change?.value as Record<string, unknown> | undefined;
    const message = (value?.messages as unknown[])?.[0] as Record<string, unknown> | undefined;

    if (!message) return null;

    const type = message.type as string;
    const context = message.context as Record<string, unknown> | undefined;

    if (type === "button") {
      const button = message.button as Record<string, unknown> | undefined;
      return {
        kind: "BUTTON_REPLY",
        text: (button?.text as string) ?? null,
        buttonPayload: (button?.payload as string) ?? null,
        contextMessageId: (context?.id as string) ?? null,
        ...(button?.text ? { title: button.text as string } : {}),
      } as Partial<NormalizedInboundEvent>;
    }

    if (type === "interactive") {
      const interactive = message.interactive as Record<string, unknown> | undefined;
      const reply = (interactive?.button_reply ?? interactive?.list_reply) as
        | Record<string, unknown>
        | undefined;
      return {
        kind: interactive?.list_reply ? "LIST_REPLY" : "BUTTON_REPLY",
        buttonPayload: (reply?.id as string) ?? null,
        ...(reply?.title ? { title: reply.title as string } : {}),
        contextMessageId: (context?.id as string) ?? null,
      } as Partial<NormalizedInboundEvent>;
    }

    if (type === "text") {
      const text = message.text as Record<string, unknown> | undefined;
      return {
        kind: "TEXT",
        text: (text?.body as string) ?? null,
        contextMessageId: (context?.id as string) ?? null,
      };
    }

    return { kind: "MEDIA", contextMessageId: (context?.id as string) ?? null };
  } catch {
    return null;
  }
}

function mapKind(type: string): InboundKind {
  switch (type?.toLowerCase()) {
    case "button":
    case "button_reply":
      return "BUTTON_REPLY";
    case "interactive":
    case "list_reply":
      return "LIST_REPLY";
    case "text":
      return "TEXT";
    case "image":
    case "audio":
    case "video":
    case "document":
    case "sticker":
    case "voice":
      return "MEDIA";
    default:
      return "UNKNOWN";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bookkeeping
// ─────────────────────────────────────────────────────────────────────────────

async function finalise(
  id: string,
  routed: { status: "ROUTED"; patientId: string; reminderEventId: string | null },
): Promise<void> {
  await systemPrisma.inboundMessage.update({
    where: { id },
    data: {
      processingStatus: "ROUTED",
      processedAtUtc: new Date(),
      routedPatientId: routed.patientId,
      routedEventId: routed.reminderEventId,
    },
  });
}

/**
 * Mark a message we could not route.
 *
 * Deliberately NOT an error state. An unattributable message is a normal
 * occurrence — a wrong number, a shared handset, a stranger — and treating it as
 * a failure would fill the error log with routine events and hide real ones.
 */
async function markUnrouted(id: string, reason: string): Promise<void> {
  await systemPrisma.inboundMessage.update({
    where: { id },
    data: {
      processingStatus: "UNROUTED",
      processedAtUtc: new Date(),
      processingError: reason,
    },
  });
}

/**
 * Drain pending inbound messages.
 *
 * Backs the `drain-inbound` sweep as well as the webhook's immediate enqueue, so
 * a message persisted just before a worker restart is still processed rather
 * than stranded.
 */
export async function drainInbound(limit = 100): Promise<{ processed: number; byStatus: Record<string, number> }> {
  const pending = await systemPrisma.inboundMessage.findMany({
    where: { processedAtUtc: null },
    orderBy: { receivedAtUtc: "asc" },
    take: limit,
    select: { id: true },
  });

  const byStatus: Record<string, number> = {};
  let processed = 0;

  for (const { id } of pending) {
    try {
      const outcome = await processInboundMessage(id);
      byStatus[outcome.status] = (byStatus[outcome.status] ?? 0) + 1;
      processed += 1;
    } catch (err) {
      // One malformed message must not stop the drain — the rest of the batch is
      // real patient replies.
      await systemPrisma.inboundMessage.update({
        where: { id },
        data: {
          processingStatus: "FAILED",
          processingError: err instanceof Error ? err.message : String(err),
          processedAtUtc: new Date(),
        },
      });
      byStatus.FAILED = (byStatus.FAILED ?? 0) + 1;
    }
  }

  return { processed, byStatus };
}
