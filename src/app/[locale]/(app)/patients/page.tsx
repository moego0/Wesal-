import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import type { PatientStatus } from "@/generated/prisma/enums";
import { Link } from "@/i18n/navigation";
import { AdherenceValue, PATIENT_STATUS_TONE, Pill } from "@/components/status";
import {
  EmptyState,
  PageHeader,
  SkeletonRows,
  Table,
  Td,
  Th,
  Tr,
  buttonClass,
  inputClass,
  selectClass,
} from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { listPatients } from "@/server/queries/patients";

/**
 * The patient list.
 *
 * `searchParams` is deliberately NOT awaited here. Under `cacheComponents` an
 * awaited `searchParams` makes the entire route request-bound, which would cost
 * this page its static shell for the sake of two form fields. The promise is
 * handed to a `<Suspense>` child that awaits it, so the header and the filter
 * form's frame stream immediately and only the results wait.
 *
 * The filter is a plain `GET` form with no `action`, so the browser re-submits to
 * the current path. That is what keeps `/ar/patients` from degrading into
 * `/patients` — a locale prefix lost on the first search a pharmacist runs.
 */

const STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;

/** Narrow an untrusted query-string value to a status the filter understands. */
function parseStatus(value: string | string[] | undefined): PatientStatus | undefined {
  if (typeof value !== "string") return undefined;
  return (STATUSES as readonly string[]).includes(value)
    ? (value as PatientStatus)
    : undefined;
}

function parseQuery(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export default async function PatientsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "patients" });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        actions={
          <Link href="/patients/new" className={buttonClass("primary")}>
            {t("add")}
          </Link>
        }
      />

      <Suspense fallback={<SkeletonRows rows={6} />}>
        <PatientResults locale={locale} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function PatientResults({
  locale,
  searchParams,
}: {
  locale: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const user = await requireSessionUser(locale);
  const t = await getTranslations({ locale, namespace: "patients" });

  /*
   * A second translator scoped to the enum catalog.
   *
   * next-intl resolves keys relative to the namespace a translator was built
   * with; there is no absolute-path escape (`t("/enums…")` is not a thing), so
   * reaching another namespace means a second `getTranslations` call. Writing
   * the label map out inline instead would be the other option — and would put
   * four status translations in a page file where the coverage test cannot see
   * them.
   */
  const tStatus = await getTranslations({ locale, namespace: "enums.patientStatus" });

  const q = parseQuery(raw.q);
  const status = parseStatus(raw.status);

  const { rows, total } = await listPatients(user.pharmacyId, { search: q, status });

  const filtered = Boolean(q || status);

  return (
    <div className="space-y-4">
      {/* `key` on the input is what makes the field follow the URL after a
          history navigation: without it React keeps the DOM value and the box
          disagrees with the results below it. */}
      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-56 flex-1 flex-col gap-1.5">
          <label
            htmlFor="patient-search"
            className="text-xs font-medium text-slate-600 dark:text-slate-400"
          >
            {t("searchLabel")}
          </label>
          <input
            key={q ?? ""}
            id="patient-search"
            name="q"
            type="search"
            defaultValue={q ?? ""}
            placeholder={t("searchPlaceholder")}
            className={inputClass}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="patient-status"
            className="text-xs font-medium text-slate-600 dark:text-slate-400"
          >
            {t("statusFilter")}
          </label>
          <select
            key={status ?? "ALL"}
            id="patient-status"
            name="status"
            defaultValue={status ?? ""}
            className={selectClass}
          >
            <option value="">{t("allStatuses")}</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {tStatus(value)}
              </option>
            ))}
          </select>
        </div>

        <button type="submit" className={buttonClass("secondary")}>
          {t("submit")}
        </button>

        {filtered ? (
          <Link href="/patients" className={buttonClass("ghost")}>
            {t("clear")}
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? t("noResults") : t("empty")}
          hint={filtered ? t("noResultsHint") : t("emptyHint")}
        />
      ) : (
        <>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("subtitle", { count: total })}
          </p>

          <Table>
            <thead>
              <tr>
                <Th>{t("columns.name")}</Th>
                <Th>{t("columns.phone")}</Th>
                <Th>{t("columns.status")}</Th>
                <Th align="end">{t("columns.adherence")}</Th>
                <Th align="end">{t("columns.medications")}</Th>
                <Th align="end">{t("columns.cases")}</Th>
                <Th align="end">{t("columns.alerts")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <Link
                      href={`/patients/${row.id}`}
                      className="font-medium text-teal-700 hover:underline dark:text-teal-400"
                    >
                      {row.fullName}
                    </Link>
                  </Td>
                  <Td className="tabular-nums">
                    {/* A leading "+" on a number is reordered to the wrong end
                        under `dir="rtl"` unless the run is explicitly LTR, so a
                        phone number must carry its own direction rather than
                        inherit the page's. */}
                    <span dir="ltr">{row.phoneE164}</span>
                  </Td>
                  <Td>
                    <Pill tone={PATIENT_STATUS_TONE[row.status]}>{tStatus(row.status)}</Pill>
                  </Td>
                  <Td align="end">
                    <span
                      title={row.adherence === null ? t("adherenceNoDataHint") : t("adherenceHint")}
                    >
                      <AdherenceValue
                        rate={row.adherence}
                        label={
                          row.adherence === null
                            ? t("adherenceNone")
                            : formatPercent(locale, row.adherence)
                        }
                      />
                    </span>
                  </Td>
                  <Td align="end" className="tabular-nums">
                    {row.medicationCount}
                  </Td>
                  <Td align="end" className="tabular-nums">
                    {row.openCaseCount}
                  </Td>
                  <Td align="end" className="tabular-nums">
                    {row.openAlertCount}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
    </div>
  );
}

/**
 * Latin digits in both locales, matching the dashboard's count formatter. A rate
 * is scanned, not read aloud, and "92%" resolves faster than "٩٢٪" for staff who
 * work in both scripts all day.
 */
function formatPercent(locale: string, rate: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(rate);
}
