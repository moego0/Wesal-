import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { InterventionOutcome } from "@/generated/prisma/enums";
import { Link } from "@/i18n/navigation";
import {
  ALERT_STATUS_TONE,
  CASE_STATUS_TONE,
  PRIORITY_TONE,
  Pill,
  SEVERITY_TONE,
  enumKey,
  type Tone,
} from "@/components/status";
import {
  Card,
  CardBody,
  CardHeader,
  DefinitionList,
  Notice,
  PageHeader,
  Skeleton,
  SkeletonRows,
  buttonClass,
} from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { hasPermission, requirePermission } from "@/server/auth/rbac";
import {
  CASE_STATUS_TRANSITIONS,
  getCaseDetail,
  getInterventionAuthors,
  isTerminalStatus,
} from "@/server/queries/followups";
import { ChangeStatusForm, RecordInterventionForm } from "./CaseForms";

/**
 * One follow-up case: why it was opened, what has been done about it, and the
 * form that records what is being done now.
 *
 * The screen answers the question a pharmacist asks at the start of a shift —
 * "what happened here, and what do I owe this patient?" The alerts answer the
 * first half with the facts the rule actually saw, and the timeline answers the
 * second: a case with three calls on it must not invite a fourth identical one.
 *
 * `params` is handed to the `<Suspense>` child rather than awaited here: under
 * `cacheComponents`, awaiting it at the top marks the whole route request-bound
 * and Next refuses to prerender it. The chrome stays static and the record
 * streams into it.
 */
export default function CasePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<CaseSkeleton />}>
        <CaseRecord params={params} />
      </Suspense>
    </div>
  );
}

/** A catalog lookup for one evidence key, or null when no label exists for it. */
type EvidenceLabel = (key: string) => string | null;

/** The two label lookups a duration needs, bound to a translator by the caller. */
type DurationLabels = {
  seconds: (value: string) => string;
  minutes: (value: string) => string;
};

async function CaseRecord({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;

  const user = await requireSessionUser(locale);
  requirePermission(user, "followup:read");

  const t = await getTranslations({ locale, namespace: "caseDetail" });
  const tEnums = await getTranslations({ locale, namespace: "enums" });
  const tCases = await getTranslations({ locale, namespace: "followUps" });
  const tType = await getTranslations({
    locale,
    namespace: "caseDetail.interventionType",
  });
  const tOutcome = await getTranslations({
    locale,
    namespace: "caseDetail.interventionOutcome",
  });
  const tEvidence = await getTranslations({
    locale,
    namespace: "caseDetail.evidence",
  });

  const kase = await getCaseDetail(user.pharmacyId, id);

  // A case in another pharmacy is indistinguishable from one that does not
  // exist: the query scopes by `pharmacyId`, and both render this same page.
  if (!kase) notFound();

  const authors = await getInterventionAuthors(
    user.pharmacyId,
    kase.interventions.map((i) => i.performedByUserId),
  );

  const evidenceLabel: EvidenceLabel = (key) => (tEvidence.has(key) ? tEvidence(key) : null);
  const durationLabels: DurationLabels = {
    seconds: (value) => t("durationSeconds", { seconds: value }),
    minutes: (value) => t("durationMinutes", { minutes: value }),
  };

  const canWrite = hasPermission(user, "followup:write");
  const terminal = isTerminalStatus(kase.status);
  const overdue = kase.dueByUtc !== null && kase.dueByUtc < new Date();

  return (
    <div className="space-y-6">
      <Link
        href="/follow-ups"
        className="inline-flex text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
      >
        ← {t("back")}
      </Link>

      <PageHeader
        title={kase.patient.fullName}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="tabular-nums" dir="ltr">
              {kase.patient.phoneE164}
            </span>
            <Pill
              tone={PRIORITY_TONE[kase.priority]}
              dot={kase.priority === "URGENT"}
            >
              {tEnums(enumKey.priority(kase.priority))}
            </Pill>
            <Pill tone={CASE_STATUS_TONE[kase.status]}>
              {tEnums(enumKey.caseStatus(kase.status))}
            </Pill>
          </span>
        }
        actions={
          hasPermission(user, "patient:read") ? (
            <Link
              href={`/patients/${kase.patient.id}`}
              className={buttonClass("secondary", "sm")}
            >
              {t("openPatient")}
            </Link>
          ) : null
        }
      />

      {/*
        A closed case says so before the reader starts wondering where the form
        went. The wording points forward — a recurring problem is a new case —
        because the record itself must not be reopened.
      */}
      {terminal ? <Notice tone="info">{t("terminal")}</Notice> : null}

      <Card>
        <CardHeader title={t("caseCard")} />
        <CardBody className="space-y-4">
          <div className="space-y-1">
            <CaseHeading kase={kase} locale={locale} />
            {kase.summary ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                <span className="font-medium text-slate-500 dark:text-slate-400">
                  {t("summary")}:{" "}
                </span>
                {kase.summary}
              </p>
            ) : null}
          </div>

          <DefinitionList
            items={[
              {
                term: t("medication"),
                detail: kase.medication ? (
                  <span>
                    {kase.medication.medicationNameText}
                    {kase.medication.doseAmountText ? (
                      <span className="text-slate-500">
                        {" · "}
                        <span dir="ltr">{kase.medication.doseAmountText}</span>
                      </span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-slate-400">{t("noMedication")}</span>
                ),
              },
              {
                term: t("origin"),
                detail: tEnums(enumKey.caseOrigin(kase.origin)),
              },
              {
                term: t("openedAt"),
                detail: formatDateTime(locale, kase.openedAtUtc),
              },
              {
                term: t("dueBy"),
                detail:
                  kase.dueByUtc === null ? (
                    <span className="text-slate-400">{tCases("noDueDate")}</span>
                  ) : overdue && !terminal ? (
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <Pill tone="critical" dot>
                        {tCases("overdue")}
                      </Pill>
                      <span className="tabular-nums">
                        {formatDateTime(locale, kase.dueByUtc)}
                      </span>
                    </span>
                  ) : (
                    <span className="tabular-nums">
                      {formatDateTime(locale, kase.dueByUtc)}
                    </span>
                  ),
              },
              ...(kase.resolvedAtUtc
                ? [
                    {
                      term: t("resolvedAt"),
                      detail: formatDateTime(locale, kase.resolvedAtUtc),
                    },
                  ]
                : []),
              ...(kase.resolutionNotes
                ? [{ term: t("resolutionNotes"), detail: kase.resolutionNotes }]
                : []),
            ]}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("alertsTitle")} />
        <CardBody className="space-y-4">
          {kase.alerts.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("alertsEmpty")}
            </p>
          ) : (
            kase.alerts.map((alert) => {
              const detail = locale === "ar" ? alert.detailAr : alert.detailEn;

              return (
                <div
                  key={alert.id}
                  className="space-y-2 border-b border-slate-100 pb-4 last:border-0 last:pb-0 dark:border-slate-800/60"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill
                      tone={SEVERITY_TONE[alert.severity]}
                      dot={alert.severity === "URGENT"}
                    >
                      {tEnums(enumKey.severity(alert.severity))}
                    </Pill>
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {locale === "ar" ? alert.titleAr : alert.titleEn}
                    </span>
                    <Pill tone={ALERT_STATUS_TONE[alert.status]}>
                      {tEnums(enumKey.alertStatus(alert.status))}
                    </Pill>
                  </div>

                  <p className="text-xs text-slate-500 dark:text-slate-400">{detail}</p>

                  <AlertEvidence
                    evidence={alert.evidence}
                    locale={locale}
                    title={t("evidenceTitle")}
                    label={evidenceLabel}
                    fallback={detail}
                  />

                  <p className="text-[11px] text-slate-400">
                    {formatDateTime(locale, alert.openedAtUtc)}
                    {" · "}
                    <span dir="ltr">{alert.ruleKey}</span>
                    {" v"}
                    {formatCount(locale, alert.ruleVersion)}
                    {alert.occurrenceCount > 1 ? (
                      <> · {formatCount(locale, alert.occurrenceCount)}×</>
                    ) : null}
                  </p>
                </div>
              );
            })
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("interventionsTitle")} />
        <CardBody>
          {kase.interventions.length === 0 ? (
            <div className="space-y-1">
              <p className="text-sm text-slate-700 dark:text-slate-200">
                {t("interventionsEmpty")}
              </p>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t("interventionsEmptyHint")}
              </p>
            </div>
          ) : (
            <ol>
              {kase.interventions.map((intervention, index) => (
                <li key={intervention.id} className="relative flex gap-4 pb-5 last:pb-0">
                  {/* The rail. `start-` rather than `left-`: the whole timeline
                      has to mirror in Arabic without a special case. */}
                  <span
                    aria-hidden
                    className={`absolute start-[5px] top-4 h-full w-px bg-slate-200 dark:bg-slate-800 ${
                      index === kase.interventions.length - 1 ? "hidden" : ""
                    }`}
                  />
                  <span
                    aria-hidden
                    className="mt-1.5 size-2.5 shrink-0 rounded-full bg-teal-500 ring-4 ring-teal-500/10"
                  />
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone="neutral">
                        {tType(intervention.interventionType)}
                      </Pill>
                      <Pill tone={INTERVENTION_OUTCOME_TONE[intervention.outcome]}>
                        {tOutcome(intervention.outcome)}
                      </Pill>
                      <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        {formatDateTime(locale, intervention.performedAtUtc)}
                      </span>
                      {authors.has(intervention.performedByUserId) ? (
                        <span className="text-xs text-slate-400">
                          {authors.get(intervention.performedByUserId)}
                        </span>
                      ) : null}
                      {intervention.durationSeconds !== null ? (
                        <span className="text-xs tabular-nums text-slate-400">
                          {durationLabel(
                            locale,
                            intervention.durationSeconds,
                            durationLabels,
                          )}
                        </span>
                      ) : null}
                    </div>
                    {intervention.notes ? (
                      <p className="text-sm whitespace-pre-line text-slate-700 dark:text-slate-200">
                        {intervention.notes}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      {canWrite && !terminal ? (
        <Card>
          <CardHeader title={t("recordTitle")} subtitle={t("recordHint")} />
          <CardBody>
            {/* The moves offered are exactly the moves the action accepts, from
                the one transition table both sides read. */}
            <RecordInterventionForm
              caseId={kase.id}
              locale={locale}
              nextStatusOptions={[...CASE_STATUS_TRANSITIONS[kase.status]]}
            />
          </CardBody>
        </Card>
      ) : null}

      {canWrite && !terminal ? (
        <Card>
          <CardHeader title={t("moveTitle")} />
          <CardBody>
            <ChangeStatusForm
              caseId={kase.id}
              locale={locale}
              options={[...CASE_STATUS_TRANSITIONS[kase.status]]}
            />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Tone for an intervention's outcome.
 *
 * Declared here rather than imported because `@/components/status` has no map for
 * these enums and this work may not edit that file; the same `Tone` vocabulary is
 * reused, so these pills sit beside the shared ones without looking foreign.
 *
 * The choices are clinical, and follow the rule the shared file states twice:
 *
 *   - Only a real contact is green. `REACHED` and `PATIENT_CONFIRMED` mean the
 *     patient was spoken to, which is what the case wanted.
 *   - The two non-contacts are `warn`, never `bad`. Not reaching a patient is OUR
 *     failed attempt; rendering that red would blame the patient for our phone.
 *   - Only `PATIENT_DENIED` is red, because that is the patient reporting they
 *     are not taking the medicine — the fact this product exists to catch.
 *
 * The intervention TYPE has no map on purpose: it is structural (what was done),
 * and the outcome pill already carries the clinical colour. Two coloured pills on
 * one line would compete, and a reader would have to work out which is the
 * finding.
 */
const INTERVENTION_OUTCOME_TONE: Record<InterventionOutcome, Tone> = {
  REACHED: "good",
  PATIENT_CONFIRMED: "good",
  LEFT_MESSAGE: "info",
  NO_ANSWER: "warn",
  UNABLE_TO_CONTACT: "warn",
  PATIENT_DENIED: "bad",
};

/**
 * The case's own heading.
 *
 * `titleAr`/`titleEn` are nullable — a case opened by hand has no rule-generated
 * title — and the fallback is nothing, rather than an empty heading the reader
 * has to interpret.
 */
function CaseHeading({
  kase,
  locale,
}: {
  kase: { titleAr: string | null; titleEn: string | null };
  locale: string;
}) {
  const title = locale === "ar" ? kase.titleAr : kase.titleEn;
  if (!title) return null;

  return (
    <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
      {title}
    </h2>
  );
}

/**
 * The evidence an alert carries, rendered as facts rather than as JSON.
 *
 * `Alert.evidence` is a `Json` column holding the triggering `ReminderEvent` ids
 * and the computed values that satisfied the predicate. Dumping it is
 * technically complete and practically useless: a pharmacist reading
 * `{"missedCount":3,"windowDays":7}` learns nothing that `3 missed in 7 days`
 * does not say at a glance.
 *
 * Every key is looked up in the catalog and falls back to a humanised form of the
 * key itself, so a rule that starts carrying a new fact renders as something
 * readable instead of an unknown. If the object holds nothing renderable at all,
 * the alert's own `detailAr`/`detailEn` is shown — the sentence the rule engine
 * already wrote, which is the honest fallback.
 */
function AlertEvidence({
  evidence,
  locale,
  title,
  label,
  fallback,
}: {
  evidence: unknown;
  locale: string;
  /** Resolved by the caller: the heading is in `caseDetail`, not `evidence`. */
  title: string;
  label: EvidenceLabel;
  fallback: string;
}) {
  const entries =
    evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)
      ? Object.entries(evidence as Record<string, unknown>).filter(
          ([, value]) => value !== null && value !== undefined && value !== "",
        )
      : [];

  if (entries.length === 0) {
    return (
      <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">
        {fallback}
      </p>
    );
  }

  return (
    <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {title}
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {entries.map(([key, value]) => (
          <div key={key} className="min-w-0 space-y-0.5">
            <dt className="text-[11px] text-slate-500 dark:text-slate-400">
              {label(key) ?? humanise(key)}
            </dt>
            <dd className="text-xs break-words text-slate-700 dark:text-slate-200">
              {/* Ids and instants are Latin/numeric runs: without their own
                  direction the surrounding RTL paragraph reorders them. */}
              {key === "eventIds" || key === "doseTimes" ? (
                <span dir="ltr" className="tabular-nums">
                  {valueFor(locale, key, value, label)}
                </span>
              ) : (
                valueFor(locale, key, value, label)
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A key no catalog knows yet: `missedCount` → `missed count`. */
function humanise(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** Facts that are rates: 0–1 in the data, percentages on the screen. */
const RATE_KEYS = new Set([
  "rate",
  "ratio",
  "threshold",
  "drop",
  "previousRate",
  "recentRate",
]);

/**
 * One evidence value, as text.
 *
 * Deliberately total: an unknown shape renders as `String(value)` rather than
 * throwing inside a settled detail page. The one substitution is `doseTimes`,
 * whose items arrive as ISO instants and are shown as the times the patient was
 * reminded — an ISO string with milliseconds is a machine's answer to a human's
 * question.
 */
function valueFor(
  locale: string,
  key: string,
  value: unknown,
  label: EvidenceLabel,
): string {
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        key === "doseTimes" && typeof item === "string"
          ? (formatInstant(locale, item) ?? item)
          : String(item),
      )
      .join(" · ");
  }

  if (typeof value === "number") {
    if (RATE_KEYS.has(key) && value >= 0 && value <= 1) {
      return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US", {
        style: "percent",
        maximumFractionDigits: 0,
      }).format(value);
    }
    return formatCount(locale, value);
  }

  if (value !== null && typeof value === "object") {
    // A nested fact object (a response breakdown, say) is flattened into its own
    // pairs rather than rendered as `[object Object]`.
    return Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== null && nested !== undefined)
      .map(([nestedKey, nested]) => `${label(nestedKey) ?? humanise(nestedKey)}: ${String(nested)}`)
      .join(" · ");
  }

  return String(value);
}

/**
 * A call length in the unit a person would say it in: seconds under two minutes,
 * whole minutes above. "0.3 minutes" is not a number anybody speaks aloud.
 */
function durationLabel(
  locale: string,
  seconds: number,
  labels: DurationLabels,
): string {
  if (seconds < 120) return labels.seconds(formatCount(locale, seconds));
  return labels.minutes(formatCount(locale, Math.round(seconds / 60)));
}

/** Latin digits in both locales, matching the dashboard and the queue. */
function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US").format(
    value,
  );
}

function formatDateTime(locale: string, date: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

/** An ISO instant from rule evidence, or null when it is not one. */
function formatInstant(locale: string, value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : formatDateTime(locale, parsed);
}

function CaseSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-28" />
      <SkeletonRows rows={3} />
    </div>
  );
}
