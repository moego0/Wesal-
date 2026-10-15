import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { AdherenceValue, Pill } from "@/components/status";
import {
  Card,
  CardBody,
  CardHeader,
  Notice,
  PageHeader,
  SkeletonRows,
  StatCard,
  Table,
  Td,
  Th,
  Tr,
  buttonClass,
  selectClass,
} from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { requirePermission } from "@/server/auth/rbac";
import {
  REPORT_WINDOW_CHOICES,
  getOperationsReport,
  type ReportWindowDays,
} from "@/server/queries/reports";

/**
 * The operations report.
 *
 * The PRD's acceptance criterion is the structure of this page, not a footnote
 * on it: DELIVERY RATE, PATIENT-REPORTED RESPONSE RATE and VERIFIED OUTCOME are
 * reported separately and are never conflated. The three sections therefore
 * each carry their own heading, their own plain-language caption and a badge
 * that says whose fact it is:
 *
 *   1. Delivery — our infrastructure. How many reminders we attempted, sent,
 *      failed and let expire.
 *   2. Patient-reported responses — the patient's own account. The caption says
 *      so outright: a response is patient-reported, never verified fact.
 *   3. Verified outcomes — the only section a pharmacist confirmed or corrected.
 *
 * The numbers come from three different sources and are allowed to disagree;
 * that is the point. A delivered dose with no reply appears in section 1 and,
 * once settled, in section 2 as "no reply" — never as a miss. An `EXPIRED` dose
 * (our downtime) never reaches section 2 at all.
 *
 * The arithmetic — including the mirrored adherence predicate — lives in
 * `@/server/queries/reports`, asserted by `tests/reports.test.ts`. Nothing on
 * this page computes a rate.
 */

const DEFAULT_DAYS: ReportWindowDays = 30;

function parseDays(value: string | string[] | undefined): ReportWindowDays {
  if (typeof value !== "string") return DEFAULT_DAYS;
  const parsed = Number.parseInt(value, 10);
  return (REPORT_WINDOW_CHOICES as readonly number[]).includes(parsed)
    ? (parsed as ReportWindowDays)
    : DEFAULT_DAYS;
}

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "reports" });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Suspense fallback={<SkeletonRows rows={10} />}>
        <ReportBody locale={locale} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function ReportBody({
  locale,
  searchParams,
}: {
  locale: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const user = await requireSessionUser(locale);
  requirePermission(user, "report:read");

  const t = await getTranslations({ locale, namespace: "reports" });
  const count = countFormatter(locale);

  const days = parseDays(raw.days);
  const report = await getOperationsReport(user.pharmacyId, days);

  const { delivery, responses, verification, followUps, workload } = report;

  return (
    <div className="space-y-6">
      {/* A plain GET form with no `action`, so the locale prefix survives. */}
      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="report-days"
            className="text-xs font-medium text-slate-600 dark:text-slate-400"
          >
            {t("window.label")}
          </label>
          <select
            key={days}
            id="report-days"
            name="days"
            defaultValue={String(days)}
            className={selectClass}
          >
            {REPORT_WINDOW_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {t("window.days", { days: count.format(choice) })}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" className={buttonClass("secondary")}>
          {t("window.submit")}
        </button>
      </form>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        <span dir="ltr" className="tabular-nums">
          {formatDate(locale, report.window.since)} – {formatDate(locale, report.window.until)}
        </span>
      </p>

      {/* ── 1. Delivery — OURS ─────────────────────────────────────────────── */}

      <Card>
        <CardHeader
          title={t("delivery.title")}
          subtitle={t("delivery.caption")}
          actions={<Pill tone="info">{t("delivery.badge")}</Pill>}
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t("delivery.attempted")}
              value={count.format(delivery.attempted)}
            />
            <StatCard
              label={t("delivery.delivered")}
              value={count.format(delivery.delivered)}
            />
            <StatCard
              label={t("delivery.failed")}
              value={count.format(delivery.failed)}
              tone={delivery.failed > 0 ? "attention" : "neutral"}
            />
            <StatCard
              label={t("delivery.expired")}
              value={count.format(delivery.expired)}
            />
          </div>

          <div>
            <MetricRow label={t("delivery.rate")} hint={t("delivery.rateHint")}>
              <RateValue rate={delivery.deliveryRate} locale={locale} noneLabel={t("noData")} />
            </MetricRow>
            <MetricRow label={t("delivery.due")}>
              <CountValue>{count.format(delivery.due)}</CountValue>
            </MetricRow>
            <MetricRow label={t("delivery.sent")}>
              <CountValue>{count.format(delivery.sent)}</CountValue>
            </MetricRow>
            <MetricRow label={t("delivery.neverAttempted")}>
              <CountValue>{count.format(delivery.neverAttempted)}</CountValue>
            </MetricRow>
            <MetricRow label={t("delivery.cancelledByUs")}>
              <CountValue>{count.format(delivery.cancelledByUs)}</CountValue>
            </MetricRow>
          </div>

          <div>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
              {t("delivery.inbound")}
            </h3>
            <MetricRow label={t("delivery.inboundReceived")}>
              <CountValue>{count.format(report.inbound.received)}</CountValue>
            </MetricRow>
            <MetricRow label={t("delivery.inboundUnrouted")}>
              <CountValue>{count.format(report.inbound.unrouted)}</CountValue>
            </MetricRow>
            <MetricRow label={t("delivery.inboundFailed")}>
              <CountValue>{count.format(report.inbound.failed)}</CountValue>
            </MetricRow>
          </div>

          {/* Inbound failures are OUR failures with a clinical consequence: the
              replies that failed to route are missing from the response
              numbers below, so the report has to say that out loud. */}
          {report.inbound.unrouted + report.inbound.failed > 0 ? (
            <Notice tone="warning">{t("delivery.inboundWarning")}</Notice>
          ) : null}
        </CardBody>
      </Card>

      {/* ── 2. Patient-reported responses — THE PATIENT'S ACCOUNT ─────────── */}

      <Card>
        <CardHeader
          title={t("responses.title")}
          subtitle={t("responses.caption")}
          actions={<Pill tone="warn">{t("responses.badge")}</Pill>}
        />
        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t("responses.scorable")}
              value={count.format(responses.scorable)}
              hint={t("responses.scorableHint")}
            />
            <StatCard
              label={t("responses.taken")}
              value={count.format(responses.taken)}
            />
            <StatCard
              label={t("responses.missed")}
              value={count.format(responses.missed)}
              tone={responses.missed > 0 ? "attention" : "neutral"}
            />
            <StatCard
              label={t("responses.noReply")}
              value={count.format(responses.noReply)}
              hint={t("responses.noReplyHint")}
            />
          </div>

          <div>
            <MetricRow label={t("responses.rate")} hint={t("responses.rateHint")}>
              <AdherenceValue rate={responses.responseRate} label={t("noData")} />
            </MetricRow>
            <MetricRow label={t("responses.adherence")} hint={t("responses.adherenceHint")}>
              <AdherenceValue rate={responses.reportedAdherence} label={t("noData")} />
            </MetricRow>
          </div>

          <div>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
              {t("responses.inRateHint")}
            </h3>
            <MetricRow label={t("responses.taken")}>
              <CountValue>{count.format(responses.taken)}</CountValue>
            </MetricRow>
            <MetricRow label={t("responses.takenLate")}>
              <CountValue>{count.format(responses.takenLate)}</CountValue>
            </MetricRow>
            <MetricRow label={t("responses.missed")}>
              <CountValue>{count.format(responses.missed)}</CountValue>
            </MetricRow>
            <MetricRow label={t("responses.noReply")} hint={t("responses.noReplyHint")}>
              <CountValue>{count.format(responses.noReply)}</CountValue>
            </MetricRow>
          </div>

          <div>
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
              {t("responses.notCountedTitle")}
            </h3>
            <MetricRow label={t("responses.problem")} hint={t("responses.problemHint")}>
              <CountValue>{count.format(responses.notCounted.problem)}</CountValue>
            </MetricRow>
            <MetricRow label={t("responses.remindLater")}>
              <CountValue>{count.format(responses.notCounted.remindLater)}</CountValue>
            </MetricRow>
            <MetricRow label={t("responses.unattributed")}>
              <CountValue>{count.format(responses.notCounted.unattributed)}</CountValue>
            </MetricRow>
            <MetricRow label={t("responses.inFlight")} hint={t("responses.inFlightHint")}>
              <CountValue>{count.format(responses.notCounted.inFlight)}</CountValue>
            </MetricRow>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              {t("responses.patterns")}
            </h3>
            <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
              {t("responses.patternsHint")}
            </p>

            {responses.scorable === 0 ? (
              <p className="text-sm text-slate-400 dark:text-slate-500">
                {t("responses.missedNone")}
              </p>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <PatternTable
                  title={t("responses.byDayOfWeek")}
                  rows={report.missedByDayOfWeek.map((row) => ({
                    key: row.key,
                    label: weekdayName(locale, Number.parseInt(row.key, 10)),
                    missed: row.missed,
                    total: row.total,
                  }))}
                  ofTotalLabel={t("responses.missedOfTotal")}
                  count={count}
                />
                <PatternTable
                  title={t("responses.byTimeOfDay")}
                  rows={report.missedByTimeOfDay.map((row) => ({
                    key: row.key,
                    label: t(`responses.${row.key}`),
                    missed: row.missed,
                    total: row.total,
                  }))}
                  ofTotalLabel={t("responses.missedOfTotal")}
                  count={count}
                />
              </div>
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              {t("responses.problemsTitle")}
            </h3>
            <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
              {t("responses.problemsSubtitle")}
            </p>

            {report.problems.total === 0 ? (
              <p className="text-sm text-slate-400 dark:text-slate-500">
                {t("responses.problemsEmpty")}
              </p>
            ) : (
              <>
                <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
                  {t("responses.problemsTotal", { count: count.format(report.problems.total) })}
                </p>
                {report.problems.top.map((problem, index) => (
                  <MetricRow
                    key={`${problem.reason ?? "none"}-${index}`}
                    label={problem.reason ?? t("responses.problemNoReason")}
                  >
                    <CountValue>{count.format(problem.count)}</CountValue>
                  </MetricRow>
                ))}
              </>
            )}
          </div>
        </CardBody>
      </Card>

      {/* ── 3. Verified outcomes — THE ONLY VERIFIED SECTION ──────────────── */}

      <Card>
        <CardHeader
          title={t("verification.title")}
          subtitle={t("verification.caption")}
          actions={<Pill tone="good">{t("verification.badge")}</Pill>}
        />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label={t("verification.recorded")}
              value={count.format(verification.recorded)}
            />
            <StatCard
              label={t("verification.confirmed")}
              value={count.format(verification.confirmed)}
            />
            <StatCard
              label={t("verification.corrected")}
              value={count.format(verification.corrected)}
            />
            <StatCard
              label={t("verification.unverified")}
              value={count.format(verification.unverified)}
            />
          </div>

          <MetricRow label={t("verification.rate")} hint={t("verification.rateHint")}>
            <RateValue
              rate={verification.verificationRate}
              locale={locale}
              noneLabel={t("noData")}
            />
          </MetricRow>

          <p className="text-xs text-slate-500 dark:text-slate-400">{t("verification.note")}</p>
        </CardBody>
      </Card>

      {/* ── Operations: follow-up and workload ────────────────────────────── */}

      <Card>
        <CardHeader
          title={t("followUps.title")}
          subtitle={t("followUps.caption")}
          actions={<Pill tone="neutral">{t("followUps.badge")}</Pill>}
        />
        <CardBody className="space-y-4">
          <div>
            <MetricRow label={t("followUps.completion")} hint={t("followUps.completionHint")}>
              <RateValue rate={followUps.completionRate} locale={locale} noneLabel={t("noData")} />
            </MetricRow>
            <MetricRow label={t("followUps.opened")}>
              <CountValue>{count.format(followUps.opened)}</CountValue>
            </MetricRow>
            <MetricRow label={t("followUps.withFirstAction")}>
              <CountValue>{count.format(followUps.withFirstAction)}</CountValue>
            </MetricRow>
            <MetricRow label={t("followUps.resolved")}>
              <CountValue>{count.format(followUps.resolved)}</CountValue>
            </MetricRow>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              {t("workload.title")}
            </h3>
            <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
              {t("workload.total")}:{" "}
              <span className="tabular-nums">{count.format(workload.total)}</span>
            </p>

            {workload.byUser.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-slate-500">{t("workload.empty")}</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>{t("workload.columns.user")}</Th>
                    <Th align="end">{t("workload.columns.interventions")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {workload.byUser.map((member) => (
                    <Tr key={member.userId}>
                      <Td>{member.fullName ?? t("workload.unknownUser")}</Td>
                      <Td align="end" className="tabular-nums">
                        {count.format(member.interventions)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * One label/value row.
 *
 * `justify-between` with logical padding rather than a physical side, so the
 * label and the figure swap ends correctly under RTL.
 */
function MetricRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 py-2 last:border-0 dark:border-slate-800/60">
      <div className="space-y-0.5">
        <p className="text-sm text-slate-700 dark:text-slate-200">{label}</p>
        {hint ? <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

function CountValue({ children }: { children: ReactNode }) {
  return (
    <span className="text-base font-medium tabular-nums text-slate-900 dark:text-slate-50">
      {children}
    </span>
  );
}

/**
 * A rate that is NOT an adherence rate.
 *
 * Deliberately not `AdherenceValue`: that component colours a rate teal at 80%
 * and rose below 60%, which are adherence thresholds. A delivery or
 * verification rate has no such clinical line, and borrowing the colours would
 * invent one.
 */
function RateValue({
  rate,
  locale,
  noneLabel,
}: {
  rate: number | null;
  locale: string;
  noneLabel: string;
}) {
  if (rate === null) {
    return <span className="text-sm text-slate-400 dark:text-slate-500">{noneLabel}</span>;
  }

  return (
    <span className="text-base font-medium tabular-nums text-slate-900 dark:text-slate-50">
      {formatPercent(locale, rate)}
    </span>
  );
}

/**
 * One pattern table: the patient-reported misses in a time bucket, over the
 * doses that bucket contained.
 *
 * The denominator is shown beside every number on purpose. "12 missed" is not
 * actionable until it reads "12 of 40" — three misses out of four and twelve
 * out of three hundred are different clinical pictures.
 */
function PatternTable({
  title,
  rows,
  ofTotalLabel,
  count,
}: {
  title: string;
  rows: { key: string; label: string; missed: number; total: number }[];
  ofTotalLabel: string;
  count: Intl.NumberFormat;
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">{title}</p>
      <Table>
        <tbody>
          {rows.map((row) => (
            <Tr key={row.key}>
              <Td>{row.label}</Td>
              <Td align="end" className="tabular-nums">
                <span className={row.missed > 0 ? "text-slate-900 dark:text-slate-50" : undefined}>
                  {ofTotalLabel
                    .replace("{missed}", count.format(row.missed))
                    .replace("{total}", count.format(row.total))}
                </span>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

/** Latin digits in both locales, matching the dashboard's count formatter. */
function countFormatter(locale: string): Intl.NumberFormat {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US");
}

function formatPercent(locale: string, rate: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(rate);
}

function formatDate(locale: string, date: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
  }).format(date);
}

/**
 * A weekday name from its `Date.getUTCDay()` index.
 *
 * From `Intl` rather than seven catalog keys: the schema already defines
 * 0 = Sunday, and the platform knows what Sunday is called in the reader's
 * language. The reference date is a known Sunday.
 */
function weekdayName(locale: string, day: number): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-US", {
    weekday: "long",
  }).format(new Date(Date.UTC(2024, 0, 7 + day)));
}
