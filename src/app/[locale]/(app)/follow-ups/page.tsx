import { DateTime } from "luxon";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import {
  CASE_STATUS_TONE,
  PRIORITY_TONE,
  Pill,
  SEVERITY_TONE,
  enumKey,
} from "@/components/status";
import { EmptyState, PageHeader, SkeletonRows, Table, Td, Th, Tr } from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { requirePermission } from "@/server/auth/rbac";
import { listOpenCases } from "@/server/queries/patients";

/**
 * The follow-up queue — the pharmacist's triage list.
 *
 * The ordering is the screen. `listOpenCases` sorts by priority descending and
 * then oldest-first, so reading the list top to bottom IS the triage; there is
 * deliberately no sort control, because a pharmacist who can re-sort this list
 * is one who can hide the urgent case at the bottom of page two.
 *
 * `params` is awaited here rather than inside the boundary, matching the
 * patients list: the locale is a static route parameter, so the header and the
 * table's frame still prerender while the cases stream in behind `<Suspense>`.
 * Only the rows depend on the session.
 */
export default async function FollowUpsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "followUps" });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} />

      <Suspense fallback={<SkeletonRows rows={6} />}>
        <CaseQueue locale={locale} />
      </Suspense>
    </div>
  );
}

/**
 * How many cases the queue will show. It is a triage list, not an archive: a
 * hundred rows is already more than a shift can work, and the subtitle says how
 * many there are so a pharmacist can see that the list was cut rather than
 * assume the pharmacy is having a quiet week.
 */
const QUEUE_LIMIT = 100;

async function CaseQueue({ locale }: { locale: string }) {
  const user = await requireSessionUser(locale);
  requirePermission(user, "followup:read");

  const t = await getTranslations({ locale, namespace: "followUps" });
  const tEnums = await getTranslations({ locale, namespace: "enums" });
  /*
   * Intervention labels live in the case-detail fragment, not here: `followUps`
   * is already in the main catalogs and this screen may not add to it, while a
   * second copy of the same six words is a second chance for them to disagree.
   * "Open case" comes from there for the same reason.
   */
  const tCase = await getTranslations({ locale, namespace: "caseDetail" });
  const tOutcome = await getTranslations({
    locale,
    namespace: "caseDetail.interventionOutcome",
  });

  const cases = await listOpenCases(user.pharmacyId, QUEUE_LIMIT);

  if (cases.length === 0) {
    return <EmptyState title={t("empty")} hint={t("emptyHint")} />;
  }

  const now = DateTime.now().setZone(user.pharmacyTimeZone);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        {t("subtitle", { count: formatCount(locale, cases.length) })}
      </p>

      <Table>
        <thead>
          <tr>
            <Th>{t("columns.patient")}</Th>
            <Th>{t("columns.priority")}</Th>
            <Th>{t("columns.status")}</Th>
            <Th>{t("columns.origin")}</Th>
            <Th align="end">{t("columns.openedAt")}</Th>
            <Th align="end">{t("columns.dueBy")}</Th>
            <Th>{t("columns.alerts")}</Th>
            <Th>{t("columns.lastAction")}</Th>
          </tr>
        </thead>
        <tbody>
          {cases.map((kase) => {
            const overdue =
              kase.dueByUtc !== null && kase.dueByUtc < now.toJSDate();
            const last = kase.interventions[0];

            /*
             * Calendar days in the pharmacy's own timezone, not elapsed hours: a
             * case opened at 22:00 last night is "yesterday" to everyone who
             * reads this screen, while 11 elapsed hours would call it today.
             */
            const opened = DateTime.fromJSDate(kase.openedAtUtc, {
              zone: user.pharmacyTimeZone,
            });
            const openedDays = Math.floor(
              now.startOf("day").diff(opened.startOf("day"), "days").days,
            );

            return (
              <Tr key={kase.id}>
                <Td>
                  {/* The name goes to the patient's record, which is where the
                      regimen and the dose history are; the case itself is
                      reachable from every row's last cell. */}
                  <Link
                    href={`/patients/${kase.patient.id}`}
                    title={t("openPatient")}
                    className="font-medium text-teal-700 hover:underline dark:text-teal-400"
                  >
                    {kase.patient.fullName}
                  </Link>
                </Td>

                <Td>
                  {/* Filled, not outline: priority is a clinical judgement about
                      this patient, not infrastructure. */}
                  <Pill
                    tone={PRIORITY_TONE[kase.priority]}
                    dot={kase.priority === "URGENT"}
                  >
                    {tEnums(enumKey.priority(kase.priority))}
                  </Pill>
                </Td>

                <Td>
                  <Pill tone={CASE_STATUS_TONE[kase.status]}>
                    {tEnums(enumKey.caseStatus(kase.status))}
                  </Pill>
                </Td>

                <Td className="text-sm text-slate-500 dark:text-slate-400">
                  {tEnums(enumKey.caseOrigin(kase.origin))}
                </Td>

                <Td align="end" className="text-xs text-slate-500">
                  {/* Relative, with the exact date on hover: "3 days ago" is
                      what decides whether a case is stale, and the date is what
                      gets written on a follow-up note. */}
                  <span title={formatDate(locale, kase.openedAtUtc)}>
                    {openedDays <= 0
                      ? t("openedToday")
                      : openedDays === 1
                        ? t("openedYesterday")
                        : t("openedDaysAgo", { days: formatCount(locale, openedDays) })}
                  </span>
                </Td>

                <Td align="end">
                  {kase.dueByUtc === null ? (
                    <span className="text-xs text-slate-400">{t("noDueDate")}</span>
                  ) : overdue ? (
                    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                      <Pill tone="critical" dot title={t("overdue")}>
                        {t("overdue")}
                      </Pill>
                      <span className="text-xs tabular-nums">
                        {formatDate(locale, kase.dueByUtc)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-xs tabular-nums">
                      {formatDate(locale, kase.dueByUtc)}
                    </span>
                  )}
                </Td>

                <Td>
                  {kase.alerts.length === 0 ? (
                    <span className="text-xs text-slate-400">—</span>
                  ) : (
                    <ul className="space-y-1">
                      {kase.alerts.map((alert) => (
                        <li key={alert.id}>
                          {/* Titles are stored per-locale on the alert row, so a
                              rule whose wording changed later cannot rewrite
                              what this pharmacist was told. */}
                          <Pill
                            tone={SEVERITY_TONE[alert.severity]}
                            dot={alert.severity === "URGENT"}
                          >
                            {locale === "ar" ? alert.titleAr : alert.titleEn}
                          </Pill>
                        </li>
                      ))}
                    </ul>
                  )}
                </Td>

                <Td>
                  <Link
                    href={`/follow-ups/${kase.id}`}
                    title={tCase("openCase")}
                    className="block max-w-56 text-slate-600 hover:text-teal-700 dark:text-slate-300 dark:hover:text-teal-400"
                  >
                    {last ? (
                      <>
                        <span className="line-clamp-2 text-xs">
                          {last.notes ?? tOutcome(last.outcome)}
                        </span>
                        <span className="mt-0.5 block text-[11px] tabular-nums text-slate-400">
                          {formatDate(locale, last.performedAtUtc)}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-xs text-slate-400">—</span>
                        <span className="mt-0.5 block text-[11px] text-teal-700 dark:text-teal-400">
                          {tCase("openCase")}
                        </span>
                      </>
                    )}
                  </Link>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

/**
 * Latin digits in both locales, matching the dashboard. A count is scanned, not
 * read aloud, and `128` resolves faster than `١٢٨` for staff who work in both
 * scripts all day.
 *
 * The formatted string is what goes into the ICU message: passing the raw number
 * would let next-intl format it with the locale's default numbering system,
 * which for `ar` is Arabic-Indic.
 */
function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US").format(value);
}

function formatDate(locale: string, date: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
  }).format(date);
}
