import type { MessageIntent, ResponseState } from "@/generated/prisma/enums";
import { systemPrisma } from "@/server/db";
import type { NormalizedInboundEvent } from "@/server/messaging/provider";
import { parseButtonPayload, normalizeLabel } from "@/server/messaging/menu";
import { normalizePhone } from "@/lib/phone";

/**
 * Attribution: which dose is this reply about?
 *
 * This is the hardest correctness problem in the system, and it is hard for a
 * reason that is easy to miss: **WhatsApp template button payloads are static.**
 * They are fixed when the template is approved, so the reminder event id cannot
 * be embedded in one. A patient tapping "✅ خدته" on a template sends us nothing
 * but the wamid of the message they tapped.
 *
 * So there are three channels, tried in order of trustworthiness:
 *
 *   1. `context.id` → the wamid of the tapped message → `ReminderDispatch` →
 *      `ReminderEvent`. Exact, and the ONLY channel available for template
 *      replies. This is why the mock provider must exercise it.
 *   2. Explicit payload `evt:<eventId>:<answer>`. Exact, but only possible on
 *      free-form interactive messages we sent inside a session window.
 *   3. Free text. Never exact. Classified, and biased hard toward
 *      UNATTRIBUTED — a wrong attribution silently corrupts a patient's
 *      adherence record, while an unattributed reply merely asks the pharmacist
 *      to look.
 *
 * A reply that cannot be attributed is still stored. Losing it would be worse
 * than storing it unlinked: the patient told us something and we must not drop
 * it on the floor.
 */

export type Attribution =
  | {
      kind: "EVENT";
      reminderEventId: string;
      patientId: string;
      pharmacyId: string;
      method: "CONTEXT_ID" | "PAYLOAD";
    }
  | { kind: "PATIENT"; patientId: string; pharmacyId: string; method: "PHONE_UNIQUE" }
  | {
      /**
       * Several patients share this handset. Common in Egypt, which is why
       * `Patient` has a non-unique index on (pharmacyId, phoneE164) rather than
       * a unique constraint.
       *
       * We deliberately do NOT guess. Picking the most recently reminded patient
       * would be right often enough to look fine and wrong often enough to
       * corrupt records — and the failure is silent.
       */
      kind: "AMBIGUOUS";
      candidatePatientIds: string[];
      pharmacyId: string;
      method: "PHONE_AMBIGUOUS";
    }
  | { kind: "UNKNOWN"; method: "NO_MATCH" };

/** Payload format for free-form interactive replies: `evt:<id>:<answer>`. */

/**
 * Classify free text.
 *
 * Intentionally conservative and keyword-based. Arabic is morphologically rich
 * and patients write in dialect, so any classifier here will be wrong; the
 * design absorbs that by treating a classified free-text reply as *eligible for
 * the pharmacist's review*, never as a settled dose. `intentClassified` is
 * advisory and the resulting response is marked low-confidence.
 *
 * Note STOP is matched first and is the one intent we act on automatically —
 * a patient asking to stop must not keep receiving messages while a human
 * decides.
 */
export function classifyFreeText(text: string): MessageIntent {
  // Normalise before matching, for the same reason `answerFromButtonLabel`
  // does: a patient who types «خَدت» with a diacritic or «خــدت» with tatweel
  // is saying the same thing as one who types «خدت». Without this the
  // free-text path is stricter than the button-label path about what counts as
  // the same sentence, which is backwards — free text is the noisier input.
  const t = normalizeLabel(text).toLowerCase();
  if (!t) return "OTHER";

  // Keywords are normalised too, so the literals below keep matching when
  // written with أ/إ/ة while the incoming text uses the other spelling.
  const has = (...keys: string[]) => keys.some((k) => t.includes(normalizeLabel(k)));

  if (has("اوقف", "أوقف", "وقف", "الغاء", "إلغاء", "مش عايز", "مش عاوز", "stop", "unsubscribe")) {
    return "STOP";
  }
  if (has("مشكلة", "عرض", "تعبان", "دوخة", "دوار", "ترجيع", "حساسية", "وجع", "problem", "side effect")) {
    return "PROBLEM";
  }
  if (has("عايز", "عاوز", "محتاج", "خلص", "مش موجود", "refill", "renew")) {
    return "REFILL";
  }
  if (has("بعدين", "بعد شوية", "فكرني", "فكّرني", "later", "remind")) {
    return "REMIND_LATER";
  }
  // Negation is tested BEFORE the affirmative keyword it contains. "مخدتش" and
  // "مش خدت" both contain "خدت", so the TAKEN branch below would swallow them
  // and a patient reporting a missed dose would be recorded as having taken it
  // — the single worst direction this classifier can be wrong in.
  if (
    has(
      "مش خدت", "مش اخدت", "ما خدت", "مخدتش", "مخدت", "لسه مخدتش", "لم اخد",
      "not taken", "not take", "didn't take", "didn’t take", "did not take",
      "havent taken", "haven't taken",
    )
  ) {
    return "MISSED";
  }
  // "اخذت" and "تناولت" are the MSA spellings; the colloquial entries above
  // only cover the د-forms ("أخذت" normalises to "اخذت").
  if (has("خدت", "اخدت", "أخدت", "اخذت", "تناولت", "taken", "took")) {
    return "TAKEN";
  }
  if (has("نسيت", "فوّتت", "فوتت", "مخدتش", "missed", "forgot")) {
    return "MISSED";
  }

  return "OTHER";
}

/** Map a classified intent onto an answer, when it is safe to do so. */
export function intentToAnswer(intent: MessageIntent): ResponseState | null {
  switch (intent) {
    case "TAKEN":
      return "TAKEN" as ResponseState;
    case "MISSED":
      return "MISSED" as ResponseState;
    case "REMIND_LATER":
      return "REMIND_LATER" as ResponseState;
    case "PROBLEM":
      return "PROBLEM" as ResponseState;
    // STOP and REFILL are instructions to the pharmacy, not adherence facts.
    // Recording them as an answer would silently score the dose.
    case "STOP":
    case "REFILL":
    case "OTHER":
    default:
      return null;
  }
}

/**
 * Resolve an inbound message to a patient and, when possible, to one dose.
 *
 * Order matters: an exact event match beats a phone match even when the phone is
 * unambiguous, because the event carries the pharmacy and patient already and
 * cannot be wrong about which dose was being asked about.
 */
export async function attributeInbound(
  event: NormalizedInboundEvent,
  channelPharmacyId: string | null,
): Promise<Attribution> {
  // ── channel 1 + 2: exact, via the message the patient acted on ──

  if (event.buttonPayload) {
    const parsed = parseButtonPayload(event.buttonPayload);
    if (parsed) {
      const reminder = await systemPrisma.reminderEvent.findUnique({
        where: { id: parsed.reminderEventId },
        select: { id: true, patientId: true, pharmacyId: true },
      });
      if (reminder) {
        return {
          kind: "EVENT",
          reminderEventId: reminder.id,
          patientId: reminder.patientId,
          pharmacyId: reminder.pharmacyId,
          method: "PAYLOAD",
        };
      }
    }
  }

  if (event.contextMessageId) {
    // The tapped wamid resolves through the dispatch we created for it. This is
    // the ONLY path a template-button tap can take.
    const dispatch = await systemPrisma.reminderDispatch.findFirst({
      where: { providerMessageId: event.contextMessageId },
      select: {
        reminderEvent: {
          select: { id: true, patientId: true, pharmacyId: true },
        },
      },
    });

    if (dispatch?.reminderEvent) {
      return {
        kind: "EVENT",
        reminderEventId: dispatch.reminderEvent.id,
        patientId: dispatch.reminderEvent.patientId,
        pharmacyId: dispatch.reminderEvent.pharmacyId,
        method: "CONTEXT_ID",
      };
    }

    // A context id we do not recognise also covers a patient replying to their
    // own earlier outbound message, or to a message sent before a database
    // restore. Fall through to phone resolution rather than failing.
  }

  // ── channel 3: phone number ──

  const phone = safeNormalize(event.fromPhoneE164);
  if (!phone || !channelPharmacyId) return { kind: "UNKNOWN", method: "NO_MATCH" };

  const patients = await systemPrisma.patient.findMany({
    where: { pharmacyId: channelPharmacyId, phoneE164: phone },
    select: { id: true },
    take: 5,
  });

  if (patients.length === 1) {
    return {
      kind: "PATIENT",
      patientId: patients[0].id,
      pharmacyId: channelPharmacyId,
      method: "PHONE_UNIQUE",
    };
  }

  if (patients.length > 1) {
    return {
      kind: "AMBIGUOUS",
      candidatePatientIds: patients.map((p) => p.id),
      pharmacyId: channelPharmacyId,
      method: "PHONE_AMBIGUOUS",
    };
  }

  return { kind: "UNKNOWN", method: "NO_MATCH" };
}

/**
 * Find the most recent still-open dose for a patient, for replies that we know
 * came from a specific patient but that carry no event reference.
 *
 * Bounded by the response window: a patient texting "خدت" six hours later is
 * plausibly answering the last reminder, but one texting three days later is
 * starting a new conversation, and attaching that to an old dose would falsify
 * the record.
 */
export async function mostRecentOpenEvent(
  patientId: string,
  now = new Date(),
): Promise<{ id: string } | null> {
  return systemPrisma.reminderEvent.findMany({
    where: {
      patientId,
      responseState: "NONE",
      settledAtUtc: null,
      deliveryState: { in: ["SENT", "DELIVERED", "READ"] },
      responseWindowEndsAtUtc: { gte: now },
    },
    orderBy: { doseAtUtc: "desc" },
    take: 1,
    select: { id: true },
  }).then((rows) => rows[0] ?? null);
}

function safeNormalize(phone: string): string | null {
  try {
    return normalizePhone(phone).e164;
  } catch {
    return null;
  }
}
