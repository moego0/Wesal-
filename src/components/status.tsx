import type { ReactNode } from "react";
import type {
  AlertStatus,
  CaseOrigin,
  CaseStatus,
  ConsentCaptureMethod,
  ConsentType,
  DeliveryState,
  PatientStatus,
  Priority,
  ResponseState,
  Severity,
  VerificationState,
} from "@/generated/prisma/enums";

/**
 * Domain status → appearance, in one place.
 *
 * Two rules govern everything here, and both are load-bearing.
 *
 * ## 1. Delivery and response are visually different KINDS of thing
 *
 * They are separate database fields for a reason (see the schema), and the
 * interface has to preserve that separation or the model is wasted. So:
 *
 *   - **Delivery** is an OUTLINE pill: no fill, muted, infrastructure-ish. It
 *     answers "what happened to the message", which is our problem.
 *   - **Response** is a FILLED pill with semantic colour. It answers "what did
 *     the patient say", which is clinical.
 *
 * A pharmacist glancing at a row must never be able to read "delivered" as a
 * kind of "taken".
 *
 * ## 2. Silence is not failure
 *
 * `ResponseState.NONE` is renderable as a muted dash, never as a red "missed".
 * The patient not answering and the patient telling us they skipped a dose are
 * different facts with different follow-up, and colouring them the same would
 * quietly convert our non-delivery and their silence into apparent
 * non-adherence. Same reasoning for `DeliveryState.EXPIRED`: that is OUR
 * downtime, and it must not read as a patient fault.
 *
 * Labels are NOT here. Every pill takes translated text from the caller, so the
 * catalogs stay the single source of the words.
 */

export type Tone = "neutral" | "info" | "good" | "warn" | "bad" | "critical" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  neutral:
    "border-slate-300 bg-white text-slate-700 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300",
  info: "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  good: "border-teal-300 bg-teal-50 text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300",
  warn: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  bad: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  critical:
    "border-rose-600 bg-rose-600 text-white dark:border-rose-500 dark:bg-rose-500 dark:text-white",
  muted:
    "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400",
};

/** A filled pill. Use for patient responses, severities, case status. */
export function Pill({
  tone = "neutral",
  children,
  dot = false,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  /** A leading dot draws the eye to the genuinely urgent ones. */
  dot?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE_CLASS[tone]}`}
    >
      {dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

/**
 * An outline pill. Use for delivery state only.
 *
 * Kept separate from `Pill` rather than a variant so that using the wrong one is
 * a deliberate act rather than a forgotten flag.
 */
export function OutlinePill({
  tone = "muted",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  const outline: Record<Tone, string> = {
    neutral:
      "border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-400",
    info: "border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-400",
    good: "border-teal-300 text-teal-700 dark:border-teal-800 dark:text-teal-400",
    warn: "border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-400",
    bad: "border-rose-300 text-rose-700 dark:border-rose-800 dark:text-rose-400",
    critical: "border-rose-500 text-rose-700 dark:border-rose-500 dark:text-rose-400",
    muted: "border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-500",
  };

  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${outline[tone]}`}
    >
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tone tables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Delivery tones stay in the cool, low-saturation end on purpose — see rule 1.
 *
 * `EXPIRED` is `warn` and NOT `bad`: nothing was sent because it became too late
 * to be worth sending, which is an operational condition. Colouring it red would
 * put our scheduling on the same footing as a patient's missed dose.
 */
export const DELIVERY_TONE: Record<DeliveryState, Tone> = {
  SCHEDULED: "muted",
  SENDING: "info",
  SENT: "info",
  DELIVERED: "neutral",
  READ: "neutral",
  FAILED: "bad",
  EXPIRED: "warn",
  CANCELLED: "muted",
  SUPERSEDED: "muted",
  SKIPPED: "muted",
};

/**
 * Response tones carry the clinical meaning.
 *
 * `NONE` is deliberately `muted` and renders as a dash. It is the single most
 * consequential colour choice in this file: making it red would report silence
 * as a missed dose, which is exactly the inference the PRD forbids.
 */
export const RESPONSE_TONE: Record<ResponseState, Tone> = {
  NONE: "muted",
  TAKEN: "good",
  TAKEN_LATE: "warn",
  MISSED: "bad",
  REMIND_LATER: "info",
  PROBLEM: "critical",
  UNATTRIBUTED: "muted",
};

export const SEVERITY_TONE: Record<Severity, Tone> = {
  LOW: "muted",
  NORMAL: "info",
  HIGH: "warn",
  URGENT: "critical",
};

/**
 * A case's priority describes how soon it needs a human, which in this domain is
 * the same question `Severity` answers — so it reads the same way, deliberately.
 * Two visual languages for "urgent" would make a pharmacist learn both.
 */
export const PRIORITY_TONE: Record<Priority, Tone> = {
  LOW: "muted",
  NORMAL: "info",
  HIGH: "warn",
  URGENT: "critical",
};

export const CASE_STATUS_TONE: Record<CaseStatus, Tone> = {
  OPEN: "bad",
  IN_PROGRESS: "warn",
  WAITING_PATIENT: "info",
  RESOLVED: "good",
  CLOSED_NO_ACTION: "muted",
};

export const ALERT_STATUS_TONE: Record<AlertStatus, Tone> = {
  OPEN: "critical",
  ACKNOWLEDGED: "warn",
  RESOLVED_AUTO: "good",
  RESOLVED_MANUAL: "good",
  SUPPRESSED: "muted",
};

export const PATIENT_STATUS_TONE: Record<PatientStatus, Tone> = {
  ACTIVE: "good",
  PAUSED: "warn",
  ARCHIVED: "muted",
};

/**
 * `PHARMACIST_CORRECTED` reads as `warn`, not `good`.
 *
 * It is not a confirmation — it means the pharmacist's record DISAGREES with
 * what the patient reported. The patient's own report is never promoted; this
 * pill describes the correction sitting beside it.
 */
export const VERIFICATION_TONE: Record<VerificationState, Tone> = {
  UNVERIFIED: "muted",
  PHARMACIST_CONFIRMED: "good",
  PHARMACIST_CORRECTED: "warn",
};

// ─────────────────────────────────────────────────────────────────────────────
// Translation keys
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enum value → key inside the `enums` message namespace.
 *
 * Generated by prefix function rather than written out, so adding an enum member
 * yields a missing-translation at runtime instead of a silently absent map
 * entry. `tests/i18n.coverage.test.ts` asserts every value here resolves in both
 * catalogs.
 */
export const enumKey = {
  delivery: (v: DeliveryState) => `delivery.${v}`,
  response: (v: ResponseState) => `response.${v}`,
  severity: (v: Severity) => `severity.${v}`,
  caseStatus: (v: CaseStatus) => `caseStatus.${v}`,
  alertStatus: (v: AlertStatus) => `alertStatus.${v}`,
  patientStatus: (v: PatientStatus) => `patientStatus.${v}`,
  verification: (v: VerificationState) => `verification.${v}`,
  caseOrigin: (v: CaseOrigin) => `caseOrigin.${v}`,
  consentType: (v: ConsentType) => `consentType.${v}`,
  captureMethod: (v: ConsentCaptureMethod) => `consentCaptureMethod.${v}`,

  /**
   * Priority points at the `severity` keys rather than owning a duplicate set.
   *
   * The two enums hold the same four values and mean the same thing here, so four
   * more translations would be four more chances for "URGENT" to drift into
   * disagreeing with itself across two screens. The coverage test still enumerates
   * `Object.values(Priority)` against these keys, so nothing goes unchecked.
   */
  priority: (v: Priority) => `severity.${v}`,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Composed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A dose's two independent facts, side by side and visually distinct.
 *
 * The pairing is the whole point: a row where the message was `DELIVERED` and
 * the patient said `MISSED` is a real, actionable situation, and it is
 * unreadable if both facts are rendered as the same kind of badge.
 */
export function DoseOutcome({
  delivery,
  deliveryLabel,
  response,
  responseLabel,
  className = "",
}: {
  delivery: DeliveryState;
  deliveryLabel: ReactNode;
  /** `null` renders the muted dash — an unanswered dose is not a failure. */
  response: ResponseState | null;
  responseLabel: ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      <OutlinePill tone={DELIVERY_TONE[delivery]}>{deliveryLabel}</OutlinePill>
      {response === null || response === "NONE" ? (
        <span
          aria-hidden
          className="text-sm text-slate-300 dark:text-slate-600"
          title={typeof responseLabel === "string" ? responseLabel : undefined}
        >
          —
        </span>
      ) : (
        <Pill
          tone={RESPONSE_TONE[response]}
          dot={response === "PROBLEM" || response === "MISSED"}
        >
          {responseLabel}
        </Pill>
      )}
    </span>
  );
}

/**
 * An adherence percentage.
 *
 * `null` is not `0`. A patient with no scorable doses has NO adherence rate, and
 * rendering that as 0% would accuse them of missing doses that were never
 * scheduled, never delivered, or never counted.
 */
export function AdherenceValue({
  rate,
  label,
  className = "",
}: {
  /** 0–1, or null when nothing was scorable. */
  rate: number | null;
  label: string;
  className?: string;
}) {
  if (rate === null) {
    return (
      <span className={`text-sm text-slate-400 dark:text-slate-500 ${className}`}>
        {label}
      </span>
    );
  }

  const pct = Math.round(rate * 100);
  const tone =
    pct >= 80
      ? "text-teal-700 dark:text-teal-400"
      : pct >= 60
        ? "text-amber-700 dark:text-amber-400"
        : "text-rose-700 dark:text-rose-400";

  return (
    <span className={`text-sm font-medium tabular-nums ${tone} ${className}`}>
      {pct}%
    </span>
  );
}
