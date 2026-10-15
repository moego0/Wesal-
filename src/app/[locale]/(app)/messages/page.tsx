import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { DeliveryState, ResponseState } from "@/generated/prisma/enums";
import { Link } from "@/i18n/navigation";
import { DoseOutcome, enumKey } from "@/components/status";
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
import { requirePermission } from "@/server/auth/rbac";
import {
  DELIVERY_HISTORY_DEFAULT_LIMIT,
  DELIVERY_HISTORY_MAX_LIMIT,
  listDeliveryHistory,
  type DeliveryHistoryRow,
} from "@/server/queries/reports";

/**
 * The delivery history: every reminder the system sent and what came back.
 *
 * This is the screen a pharmacist opens when a patient says "you never messaged
 * me", so it is built around two independent facts that the schema keeps apart
 * and the eye must too:
 *
 *   - DELIVERY is ours. It is rendered as an outline pill (`DoseOutcome`), in
 *     the cool end of the palette, and it answers "what happened to the
 *     message".
 *   - RESPONSE is the patient's. It is a filled pill with clinical colour.
 *
 * A `DELIVERED` message with no reply must never read as a successful dose, so
 * the pair is rendered by `DoseOutcome` and never collapsed into one badge. The
 * legend under the table says the same thing in words, because a colour alone
 * is not an explanation.
 *
 * `searchParams` is deliberately NOT awaited at the top: under `cacheComponents`
 * that would make the whole route request-bound and cost the page its static
 * shell. The promise is handed to the `<Suspense>` child — see SCREENS.md §1 and
 * the patient list, whose filter handling this mirrors.
 *
 * Scale is the other constraint. A pharmacy's send history grows by a row per
 * patient per dose per day forever, so the page is paginated by `limit`/`offset`
 * with the total always visible, and the limit is capped in the query module.
 * Nothing here ever loads a pharmacy's whole history into one page.
 */

const DELIVERY_STATES = Object.values(DeliveryState);
const RESPONSE_STATES = Object.values(ResponseState);

/** How far back the log opens by default. */
const DEFAULT_WINDOW_DAYS = 7;

/** Narrow an untrusted query-string value to a value the filter understands. */
function parseOneOf<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string") return undefined;
  return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function parseText(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `YYYY-MM-DD` day, or undefined.
 *
 * The round-trip check rejects a well-shaped but impossible date: `2026-02-31`
 * parses happily and rolls over to 3 March, which would silently widen the
 * range the pharmacist asked for.
 */
function parseDay(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10) === value ? value : undefined;
}

function parsePositiveInt(
  value: string | string[] | undefined,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** A UTC calendar day, matching how `doseLocalDate` is stored. */
function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default async function MessagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "messages" });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Suspense fallback={<SkeletonRows rows={8} />}>
        <MessageLog locale={locale} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function MessageLog({
  locale,
  searchParams,
}: {
  locale: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const user = await requireSessionUser(locale);
  requirePermission(user, "report:read");

  const t = await getTranslations({ locale, namespace: "messages" });
  const tEnums = await getTranslations({ locale, namespace: "enums" });
  // `settled` and `inFlight` already exist in the shared `doses` catalog and
  // mean exactly what this screen needs; a second pair of keys saying the same
  // thing is a second pair that can drift.
  const tDoses = await getTranslations({ locale, namespace: "doses" });
  const count = countFormatter(locale);

  const patientQuery = parseText(raw.patient);
  const deliveryState = parseOneOf(raw.delivery, DELIVERY_STATES);
  const responseState = parseOneOf(raw.response, RESPONSE_STATES);

  const rawFrom = parseDay(raw.from);
  const rawTo = parseDay(raw.to);

  let from = rawFrom ?? dayString(new Date(Date.now() - (DEFAULT_WINDOW_DAYS - 1) * 86_400_000));
  let to = rawTo ?? dayString(new Date());
  // A reversed range is a typo, not an empty result. Swapping shows the days
  // the pharmacist meant instead of an empty table.
  if (from > to) [from, to] = [to, from];

  const limit = parsePositiveInt(raw.limit, DELIVERY_HISTORY_DEFAULT_LIMIT, DELIVERY_HISTORY_MAX_LIMIT);
  // The upper bound is only there to keep a hand-edited `?page=99999999` from
  // asking Postgres to skip a hundred million rows.
  let page = parsePositiveInt(raw.page, 1, 10_000);

  const load = (atPage: number) =>
    listDeliveryHistory(user.pharmacyId, {
      patientQuery,
      deliveryState,
      responseState,
      from: new Date(`${from}T00:00:00.000Z`),
      to: new Date(`${to}T00:00:00.000Z`),
      limit,
      offset: (atPage - 1) * limit,
    });

  let { rows, total } = await load(page);

  // A hand-edited or stale `?page=` past the end would otherwise pair an empty
  // table with a non-zero total. Re-clamped and re-read once, no loop.
  const lastPage = Math.max(1, Math.ceil(total / limit));
  if (rows.length === 0 && total > 0 && page > lastPage) {
    page = lastPage;
    ({ rows, total } = await load(page));
  }

  const filtered = Boolean(patientQuery || deliveryState || responseState || rawFrom || rawTo);
  const pageQuery = (atPage: number) =>
    `/messages${buildQuery({
      patient: patientQuery,
      delivery: deliveryState,
      response: responseState,
      from,
      to,
      page: atPage,
      limit,
    })}`;

  /**
   * The dispatch story behind a delivery state.
   *
   * `deliveryState` alone cannot tell "sent three times, rejected every time"
   * from "never attempted" — both can read as a single badge, and only this log
   * can show the difference. So a failure always shows the attempt count and
   * the provider's reason; more than one attempt shows the count even when they
   * succeeded; and a state that should have produced attempts but has none says
   * so explicitly.
   *
   * A single successful attempt says nothing extra: the pill already says
   * `DELIVERED`, and "1 attempt" beside every row would train people to stop
   * reading the line that matters.
   */
  const dispatchNote = (row: DeliveryHistoryRow) => {
    if (row.lastFailure) {
      const reason =
        row.lastFailure.length > 80 ? `${row.lastFailure.slice(0, 80)}…` : row.lastFailure;

      return (
        <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
          {t("attempts", { count: count.format(row.dispatchCount) })}
          <span className="mx-1">·</span>
          {t("lastFailureLabel")}
          {/* The provider's message is Latin and can carry symbols; `<bdi>`
              isolates it so it cannot reorder the Arabic around it. */}
          <bdi className="ms-1" title={row.lastFailure}>
            {reason}
          </bdi>
        </p>
      );
    }

    if (row.dispatchCount > 1) {
      return (
        <p className="mt-1 text-xs text-slate-400">
          {t("attempts", { count: count.format(row.dispatchCount) })}
        </p>
      );
    }

    if (
      row.dispatchCount === 0 &&
      (row.deliveryState === "SCHEDULED" || row.deliveryState === "FAILED")
    ) {
      return <p className="mt-1 text-xs text-slate-400">{t("neverAttempted")}</p>;
    }

    return null;
  };

  return (
    <div className="space-y-4">
      {/* A plain GET form with no `action`: it re-submits to the current path,
          so the locale prefix survives the search. Adding `action="/messages"`
          would silently drop `/ar` and break the other language. */}
      <form method="get" className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-52 flex-1 flex-col gap-1.5">
          <label
            htmlFor="message-patient"
            className="text-xs font-medium text-slate-600 dark:text-slate-400"
          >
            {t("filters.patient")}
          </label>
          <input
            key={patientQuery ?? ""}
            id="message-patient"
            name="patient"
            type="search"
            defaultValue={patientQuery ?? ""}
            placeholder={t("filters.patientPlaceholder")}
            className={inputClass}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="message-delivery"
            className="text-xs font-medium text-slate-600 dark:text-slate-400"
          >
            {t("filters.delivery")}
          </label>
          <select
            key={deliveryState ?? "ALL"}
            id="message-delivery"
            name="delivery"
            defaultValue={deliveryState ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.allStates")}</option>
            {DELIVERY_STATES.map((state) => (
              <option key={state} value={state}>
                {tEnums(enumKey.delivery(state))}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="message-response"
            className="text-xs font-medium text-slate-600 dark:text-slate-400"
          >
            {t("filters.response")}
          </label>
          <select
            key={responseState ?? "ALL"}
            id="message-response"
            name="response"
            defaultValue={responseState ?? ""}
            className={selectClass}
          >
            <option value="">{t("filters.allStates")}</option>
            {RESPONSE_STATES.map((state) => (
              <option key={state} value={state}>
                {tEnums(enumKey.response(state))}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="message-from"
            className="text-xs font-medium text-slate-600 dark:text-slate-400"
          >
            {t("filters.from")}
          </label>
          <input
            key={`from-${from}`}
            id="message-from"
            name="from"
            type="date"
            defaultValue={from}
            className={inputClass}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="message-to"
            className="text-xs font-medium text-slate-600 dark:text-slate-400"
          >
            {t("filters.to")}
          </label>
          <input
            key={`to-${to}`}
            id="message-to"
            name="to"
            type="date"
            defaultValue={to}
            className={inputClass}
          />
        </div>

        <button type="submit" className={buttonClass("secondary")}>
          {t("filters.submit")}
        </button>

        {filtered ? (
          <Link href="/messages" className={buttonClass("ghost")}>
            {t("filters.clear")}
          </Link>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <EmptyState title={t("empty")} hint={t("emptyHint")} />
      ) : (
        <>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("legend")}</p>

          <Table>
            <thead>
              <tr>
                <Th>{t("columns.patient")}</Th>
                <Th>{t("columns.medication")}</Th>
                <Th>{t("columns.date")}</Th>
                <Th>{t("columns.time")}</Th>
                <Th>{t("columns.delivery")}</Th>
                <Th>{t("columns.receivedAt")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Tr key={row.id}>
                  <Td>
                    <Link
                      href={`/patients/${row.patientId}`}
                      className="font-medium text-teal-700 hover:underline dark:text-teal-400"
                    >
                      {row.patientName}
                    </Link>
                  </Td>
                  <Td>{row.medicationName}</Td>
                  <Td className="tabular-nums">
                    {row.doseLocalDate.toISOString().slice(0, 10)}
                  </Td>
                  <Td className="tabular-nums">
                    {/* A leading digit run inherits the paragraph direction
                        under `dir="rtl"` and reorders, so the wall-clock time
                        carries its own. */}
                    <span dir="ltr">{row.doseLocalTime}</span>
                  </Td>
                  <Td>
                    {/* The pair, never one badge: the outline says what our
                        infrastructure did, the filled pill says what the
                        patient said. See SCREENS.md §6. */}
                    <DoseOutcome
                      delivery={row.deliveryState}
                      deliveryLabel={tEnums(enumKey.delivery(row.deliveryState))}
                      response={row.responseState}
                      responseLabel={
                        row.responseFreeText ?? tEnums(enumKey.response(row.responseState))
                      }
                    />
                    {dispatchNote(row)}
                  </Td>
                  <Td className="text-xs tabular-nums text-slate-500">
                    {row.responseReceivedAtUtc
                      ? formatDateTime(locale, row.responseReceivedAtUtc)
                      : row.settledAtUtc
                        ? tDoses("settled")
                        : "—"}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("showing", {
                from: count.format((page - 1) * limit + 1),
                to: count.format((page - 1) * limit + rows.length),
                total: count.format(total),
              })}
            </p>

            {lastPage > 1 ? (
              <div className="flex items-center gap-2">
                {page > 1 ? (
                  <Link href={pageQuery(page - 1)} className={buttonClass("secondary", "sm")}>
                    {t("previous")}
                  </Link>
                ) : (
                  <span aria-disabled className={`${buttonClass("secondary", "sm")} opacity-50`}>
                    {t("previous")}
                  </span>
                )}

                {page < lastPage ? (
                  <Link href={pageQuery(page + 1)} className={buttonClass("secondary", "sm")}>
                    {t("next")}
                  </Link>
                ) : (
                  <span aria-disabled className={`${buttonClass("secondary", "sm")} opacity-50`}>
                    {t("next")}
                  </span>
                )}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Query-string builder for the paging links.
 *
 * The effective window is always carried, even when it is the default, so
 * paging can never silently change which days are being looked at.
 */
function buildQuery(input: {
  patient?: string;
  delivery?: string;
  response?: string;
  from: string;
  to: string;
  page: number;
  limit: number;
}): string {
  const params = new URLSearchParams();
  if (input.patient) params.set("patient", input.patient);
  if (input.delivery) params.set("delivery", input.delivery);
  if (input.response) params.set("response", input.response);
  params.set("from", input.from);
  params.set("to", input.to);
  params.set("page", String(input.page));
  params.set("limit", String(input.limit));
  return `?${params.toString()}`;
}

/** Latin digits in both locales, matching the dashboard's count formatter. */
function countFormatter(locale: string): Intl.NumberFormat {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US");
}

function formatDateTime(locale: string, date: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}
