import type { ResponseState } from "@/generated/prisma/enums";

/**
 * The WhatsApp interaction vocabulary.
 *
 * One home for every button label, because the labels are read in BOTH
 * directions: we send them, and we match them against what comes back. If the
 * outbound side and the inbound side each carried their own copy, re-wording a
 * button would silently stop all replies being recognised — the messages would
 * still arrive, nothing would error, and the adherence data would quietly go
 * empty. That is the failure mode this file exists to prevent.
 *
 * ## Why the buttons are shaped this way
 *
 * Meta renders only TWO quick-reply buttons before collapsing the rest behind
 * "See all options", so the client's five-option menu cannot ship as five
 * buttons — most patients would never see three of them.
 *
 * Instead the approved TEMPLATE carries three buttons matching the actual
 * decision the patient is making ("did you take it?"). Any tap opens the
 * 24-hour customer service window, and the refinement menus below — free-form
 * interactive messages, not templates — deliver the full option set.
 *
 * Two consequences worth stating: re-wording a refinement menu needs no Meta
 * re-approval, and the refinement message bills as a service message, not a
 * second template.
 *
 * ## Attribution
 *
 * Template button payloads are STATIC — fixed at approval time — so the reminder
 * event id cannot travel in one. A template tap arrives carrying only
 * `context.id` (the wamid of the message tapped) and the button's LABEL. The
 * label is therefore part of the routing protocol, not decoration; see
 * `answerFromButtonLabel`.
 *
 * Refinement menus are ours, so they carry an exact payload: `evt:<id>:<answer>`.
 */

export type MenuButton = {
  /** Stable id. Carries the event id for our own interactive messages. */
  id: string;
  /** What the patient sees. Also the inbound matching key — see the note above. */
  title: string;
};

/**
 * The three approved template buttons.
 *
 * Titles are the Arabic that was submitted to Meta. Changing them means the
 * inbound matcher changes with them, which is why they are not inlined at the
 * call site.
 */
export const TEMPLATE_BUTTON_LABELS = {
  TAKEN: "خدته ✅",
  NOT_YET: "لسه ❌",
  PROBLEM: "عندي مشكلة ⚠️",
} as const;

export function templateButtons(): MenuButton[] {
  return [
    { id: "TAKEN", title: TEMPLATE_BUTTON_LABELS.TAKEN },
    { id: "NOT_YET", title: TEMPLATE_BUTTON_LABELS.NOT_YET },
    { id: "PROBLEM", title: TEMPLATE_BUTTON_LABELS.PROBLEM },
  ];
}

/**
 * The three opening buttons, carrying an explicit event id.
 *
 * Used when the session window is already open and the reminder can be sent as a
 * free-form interactive message. The labels are the same as the template's, so
 * the patient's experience does not change based on which billing path the
 * message took — but unlike the template's, these payloads actually carry the
 * event id, which makes attribution exact rather than label-matched.
 */
export function reminderButtons(reminderEventId: string): MenuButton[] {
  return [
    { id: `evt:${reminderEventId}:TAKEN`, title: TEMPLATE_BUTTON_LABELS.TAKEN },
    { id: `evt:${reminderEventId}:NOT_YET`, title: TEMPLATE_BUTTON_LABELS.NOT_YET },
    { id: `evt:${reminderEventId}:PROBLEM`, title: TEMPLATE_BUTTON_LABELS.PROBLEM },
  ];
}

/** Snooze durations offered, in minutes. */
export const SNOOZE_OPTIONS = [15, 60] as const;

/**
 * The refinement menus, sent as free-form interactive messages inside the
 * session window the patient's own tap opened.
 *
 * Payloads are `evt:<reminderEventId>:<answer>`, which is only possible because
 * these are NOT template buttons.
 */
export function refinementMenu(reminderEventId: string) {
  const id = (answer: string) => `evt:${reminderEventId}:${answer}`;

  return {
    taken: {
      bodyText: "تمام 🌿 خدت الدواء في المعاد ولا متأخر؟",
      buttons: [
        { id: id("TAKEN"), title: "في المعاد ✅" },
        { id: id("TAKEN_LATE"), title: "متأخر شوية 🟡" },
      ],
    },
    notYet: {
      bodyText: "مفيش مشكلة. تحب نعمل إيه؟",
      buttons: [
        { id: id("REMIND_LATER_15"), title: "فكّرني بعد ١٥ د" },
        { id: id("REMIND_LATER_60"), title: "فكّرني بعد ساعة" },
        { id: id("MISSED"), title: "فوّتت الجرعة ❌" },
      ],
    },
    problem: {
      bodyText: "معلش، قولي إيه المشكلة؟",
      // EXACTLY THREE. Meta rejects an interactive message carrying more than
      // three reply buttons with a non-retryable 4xx, so a fourth button here
      // means the message never reaches the patient at all.
      //
      // The three kept are the ones that need to be RECORDED as a category for
      // reporting: a side effect, an availability problem, and a dosing
      // misunderstanding. "I want to speak to the pharmacist" is not a category
      // — it is a request for contact, and it is offered on the acknowledgement
      // that follows, where it applies to every branch.
      buttons: [
        { id: id("PROBLEM_SIDE_EFFECT"), title: "عرض جانبي" },
        { id: id("PROBLEM_UNAVAILABLE"), title: "الدواء مش متوفر" },
        { id: id("PROBLEM_CONFUSED"), title: "مش فاهم الجرعة" },
      ],
    },
    /**
     * Sent after the patient picks a problem category.
     *
     * This is where "عايز أكلم الصيدلي" lives, because it is a request rather
     * than a classification. Putting it here means it is reachable from every
     * problem branch without spending one of the three category slots on it.
     */
    problemAck: {
      bodyText: "شكرًا إنك قلت لنا 🌿 سجّلنا المشكلة وهيتواصل معاك الصيدلي.",
      buttons: [
        { id: id("PROBLEM_WANTS_CALL"), title: "عايز أكلم الصيدلي" },
        { id: id("ACK"), title: "تمام، شكرًا" },
      ],
    },
  };
}

export type ParsedReply = {
  reminderEventId: string;
  /** Null when the patient opened a menu rather than answering. */
  answer: ResponseState | null;
  snoozeMinutes: number | null;
  /** True for the PROBLEM sub-categories, which all resolve to PROBLEM. */
  isProblemCategory: boolean;
};

const EVENT_PAYLOAD = /^evt:([A-Za-z0-9_-]+):([A-Z0-9_]+)$/;

/**
 * Decode an interactive-message payload.
 *
 * Snooze durations are encoded into the answer token (`REMIND_LATER_15`) rather
 * than as a separate field, because WhatsApp button ids must round-trip as one
 * opaque string.
 */
export function parseButtonPayload(payload: string): ParsedReply | null {
  const match = EVENT_PAYLOAD.exec(payload.trim());
  if (!match) return null;

  const [, reminderEventId, raw] = match;

  const snooze = /^REMIND_LATER_(\d+)$/.exec(raw);
  if (snooze) {
    return {
      reminderEventId,
      answer: "REMIND_LATER" as ResponseState,
      snoozeMinutes: Number(snooze[1]),
      isProblemCategory: false,
    };
  }

  if (raw === "NOT_YET") {
    // Not an answer — the patient opened the refinement menu. Recorded so the
    // pharmacist can see the engagement, but it does not resolve the dose.
    return { reminderEventId, answer: null, snoozeMinutes: null, isProblemCategory: false };
  }

  const plain: ResponseState[] = [
    "TAKEN",
    "TAKEN_LATE",
    "MISSED",
    "REMIND_LATER",
    "PROBLEM",
    "UNATTRIBUTED",
  ];

  if (plain.includes(raw as ResponseState)) {
    return {
      reminderEventId,
      answer: raw as ResponseState,
      snoozeMinutes: null,
      isProblemCategory: false,
    };
  }

  if (raw.startsWith("PROBLEM_")) {
    return {
      reminderEventId,
      answer: "PROBLEM" as ResponseState,
      snoozeMinutes: null,
      isProblemCategory: true,
    };
  }

  return null;
}

/**
 * Strip the differences that do not change meaning: emoji, Arabic diacritics,
 * the several spellings of alef, and whitespace.
 *
 * Without this, "خدته ✅" sent by us and "خدته" echoed back by a client that
 * drops emoji would not match, and every template reply would go unrecognised.
 */
export function normalizeLabel(label: string): string {
  return label
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Recover the answer from a button's LABEL.
 *
 * This is the only route available for a template reply: its payload is fixed at
 * approval time and carries nothing. The label is all we get besides
 * `context.id`.
 *
 * An unrecognised label returns null rather than guessing. The reply is still
 * stored — losing something a patient told us would be worse — but it is marked
 * ineligible for the rule engine so an unmatched label cannot silently score a
 * dose either way. A null result here is a signal to check the template in the
 * Meta console, and it is worth alerting on.
 */
export function answerFromButtonLabel(
  label: string | null | undefined,
): ParsedReply | null {
  if (!label) return null;

  const key = normalizeLabel(label);

  const answers: Record<string, ResponseState> = {
    [normalizeLabel(TEMPLATE_BUTTON_LABELS.TAKEN)]: "TAKEN" as ResponseState,
    [normalizeLabel(TEMPLATE_BUTTON_LABELS.PROBLEM)]: "PROBLEM" as ResponseState,
    [normalizeLabel("في المعاد ✅")]: "TAKEN" as ResponseState,
    [normalizeLabel("متأخر شوية 🟡")]: "TAKEN_LATE" as ResponseState,
    [normalizeLabel("فوّتت الجرعة ❌")]: "MISSED" as ResponseState,
    [normalizeLabel("عرض جانبي")]: "PROBLEM" as ResponseState,
    [normalizeLabel("الدواء مش متوفر")]: "PROBLEM" as ResponseState,
    [normalizeLabel("مش فاهم الجرعة")]: "PROBLEM" as ResponseState,
    [normalizeLabel("عايز أكلم الصيدلي")]: "PROBLEM" as ResponseState,
  };

  if (normalizeLabel(TEMPLATE_BUTTON_LABELS.NOT_YET) === key) {
    return {
      reminderEventId: "",
      answer: null,
      snoozeMinutes: null,
      isProblemCategory: false,
    };
  }

  // A dismissal. Recognised, so it is not reported as an unrecognised label, but
  // it carries no clinical answer — the patient is closing the conversation, not
  // telling us about a dose.
  if (key === normalizeLabel("تمام، شكرًا") || key === normalizeLabel("تمام شكرا")) {
    return {
      reminderEventId: "",
      answer: null,
      snoozeMinutes: null,
      isProblemCategory: false,
    };
  }

  const snoozeMatch = /^فكرني بعد (\d+)/.exec(key);
  if (snoozeMatch) {
    // "فكّرني بعد ١٥ د" / "فكّرني بعد ساعة" — durations are also encoded in our
    // own payload path, this covers the label path only.
    const n = Number(snoozeMatch[1]);
    return {
      reminderEventId: "",
      answer: "REMIND_LATER" as ResponseState,
      snoozeMinutes: Number.isFinite(n) && n > 0 ? n : 60,
      isProblemCategory: false,
    };
  }
  if (key.includes("فكرني بعد ساعه")) {
    return {
      reminderEventId: "",
      answer: "REMIND_LATER" as ResponseState,
      snoozeMinutes: 60,
      isProblemCategory: false,
    };
  }

  const answer = answers[key];
  if (!answer) return null;

  return { reminderEventId: "", answer, snoozeMinutes: null, isProblemCategory: false };
}

/** Human-readable label for a problem sub-category, for the pharmacist's view. */
export function problemCategoryLabel(payload: string | null): string | null {
  if (!payload) return null;
  const map: Record<string, string> = {
    PROBLEM_SIDE_EFFECT: "أبلغ عن عرض جانبي",
    PROBLEM_UNAVAILABLE: "الدواء غير متوفر",
    PROBLEM_CONFUSED: "غير فاهم الجرعة",
    PROBLEM_WANTS_CALL: "طلب التحدث مع الصيدلي",
  };
  return map[payload.split(":").pop() ?? ""] ?? null;
}
