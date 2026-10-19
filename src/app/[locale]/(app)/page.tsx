import { getTranslations } from "next-intl/server";
import { locale as localeParam } from "next/root-params";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import { CASE_STATUS_TONE, PRIORITY_TONE, Pill, enumKey } from "@/components/status";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
  PageHeader,
  Skeleton,
  StatCard,
  buttonClass,
} from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { getDashboardSummary, getUpcomingRefills } from "@/server/queries/dashboard";
import { listOpenCases } from "@/server/queries/patients";
import { UpcomingRefillsCard } from "@/components/refills/UpcomingRefillsCard";

/**
 * The dashboard.
 *
 * The screen a pharmacist opens first, so it answers one question before any
 * other: *who needs me right now*. The attention list is therefore the first
 * thing below the counts and it is real — ordered by the same triage the
 * follow-ups queue uses, because a bare count tells a pharmacist there is work
 * without telling them where to start.
 *
 * The delivery strip is deliberately separated from everything clinical and
 * carries a note saying so. "Delivered, no reply" and "expired before sending"
 * look like two shades of the same thing on a bar chart and are opposites: one
 * is the patient's silence, the other is our own outage. Merging them is the
 * easiest way to report an infrastructure failure as patient non-adherence.
 *
 * The locale comes from the root parameter rather than the `params` prop — see
 * `src/i18n/request.ts`. It is a plain function call available during
 * prerendering, so nothing here has to await `params` and give up the shell.
 */

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent />
      </Suspense>
    </div>
  );
}

async function DashboardContent() {
  const locale = await localeParam();

  const user = await requireSessionUser(locale);
  const t = await getTranslations({ locale, namespace: "dashboard" });
  const tEnums = await getTranslations({ locale, namespace: "enums" });
  const format = countFormatter(locale);

  // No pharmacy lookup: the session already resolved the membership, and
  // re-reading the row to get a name and a time zone the session context
  // carries would be a second query per dashboard load for nothing.
  const [summary, attention, upcomingRefills] = await Promise.all([
    getDashboardSummary(user.pharmacyId, user.pharmacyTimeZone),
    listOpenCases(user.pharmacyId, 5),
    getUpcomingRefills(user.pharmacyId, user.pharmacyTimeZone, 7),
  ]);

  const { delivery } = summary;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        subtitle={`${t("welcome", { name: user.fullName })} · ${user.pharmacyName}`}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t("activePatients")}
          value={format.format(summary.activePatients)}
          unit={t("patientsUnit")}
        />
        <StatCard
          label={t("openCases")}
          value={format.format(summary.openCases)}
          unit={t("casesUnit")}
          tone={summary.openCases > 0 ? "attention" : "neutral"}
        />
        <StatCard
          label={t("openAlerts")}
          value={format.format(summary.openAlerts)}
          unit={t("alertsUnit")}
          tone={summary.alertsBySeverity.URGENT > 0 ? "attention" : "neutral"}
          // The breakdown only earns its space when something is urgent. Showing
          // "0 urgent, 0 high, 0 normal, 0 low" trains the reader to skip the line.
          hint={
            summary.alertsBySeverity.URGENT > 0
              ? t("alertsUrgent", {
                  count: format.format(summary.alertsBySeverity.URGENT),
                  severity: tEnums(enumKey.severity("URGENT")),
                })
              : undefined
          }
        />
        <StatCard
          label={t("today")}
          value={format.format(summary.today.total)}
          unit={t("dosesUnit")}
          hint={
            summary.today.total > 0
              ? t("todayAnswered", {
                  answered: format.format(summary.today.answered),
                  total: format.format(summary.today.total),
                })
              : undefined
          }
        />
      </div>

      <Card>
        <CardHeader
          title={t("needsAttention")}
          subtitle={t("needsAttentionHint")}
          actions={
            <Link href="/follow-ups" className={buttonClass("ghost", "sm")}>
              {t("viewAllCases")}
            </Link>
          }
        />
        <CardBody className="space-y-3">
          {attention.length === 0 ? (
            <EmptyState title={t("noAttention")} hint={t("noAttentionHint")} />
          ) : (
            attention.map((kase) => {
              /*
               * Case titles are bilingual columns and either may be null —
               * a rule-opened case gets both, a pharmacist-opened one may not.
               * Falling back across the pair rather than showing an empty row.
               */
              const title =
                locale === "ar"
                  ? (kase.titleAr ?? kase.titleEn ?? kase.summary)
                  : (kase.titleEn ?? kase.titleAr ?? kase.summary);

              return (
                <Link
                  key={kase.id}
                  href={`/follow-ups/${kase.id}`}
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 p-3 transition hover:border-teal-300 hover:bg-teal-50/40 dark:border-slate-800 dark:hover:border-teal-800 dark:hover:bg-teal-950/20"
                >
                  <Pill
                    tone={PRIORITY_TONE[kase.priority]}
                    dot={kase.priority === "URGENT"}
                  >
                    {tEnums(enumKey.priority(kase.priority))}
                  </Pill>
                  <span className="font-medium text-slate-900 dark:text-slate-50">
                    {kase.patient.fullName}
                  </span>
                  <Pill tone={CASE_STATUS_TONE[kase.status]}>
                    {tEnums(enumKey.caseStatus(kase.status))}
                  </Pill>
                  {title ? (
                    <span className="text-sm text-slate-500 dark:text-slate-400">{title}</span>
                  ) : null}
                </Link>
              );
            })
          )}
        </CardBody>
      </Card>

      <UpcomingRefillsCard refills={upcomingRefills} locale={locale} />

      <Card>
        <CardHeader
          title={t("deliveryHealth")}
          subtitle={t("deliveryWindow", { days: delivery.windowDays })}
        />
        <CardBody className="space-y-4">
          {delivery.attempted === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("deliveryEmpty")}</p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <DeliveryStat
                  label={t("deliveryDelivered")}
                  value={delivery.delivered}
                  tone="text-teal-700 dark:text-teal-400"
                />
                <DeliveryStat
                  label={t("deliveryNoReply")}
                  value={delivery.noReply}
                  tone="text-slate-600 dark:text-slate-300"
                />
                <DeliveryStat
                  label={t("deliveryFailed")}
                  value={delivery.failed}
                  tone="text-rose-700 dark:text-rose-400"
                />
                <DeliveryStat
                  label={t("deliveryExpired")}
                  value={delivery.expired}
                  tone="text-amber-700 dark:text-amber-400"
                />
              </div>

              <Notice tone="info">{t("deliveryNote")}</Notice>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function DeliveryStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

/**
 * Latin digits in both locales. A count is scanned rather than read aloud, and
 * "128" resolves faster than "١٢٨" for staff who work in both scripts all day —
 * the same choice the patient list makes for adherence percentages.
 */
function countFormatter(locale: string) {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US");
}

function DashboardSkeleton() {
  return (
    <div aria-hidden className="space-y-6">
      <Skeleton className="h-16" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
