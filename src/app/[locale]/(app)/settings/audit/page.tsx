import { getTranslations } from "next-intl/server";
import { DateTime } from "luxon";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import {
  Card,
  CardBody,
  EmptyState,
  Notice,
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
import { hasPermission, requirePermission } from "@/server/auth/rbac";
import {
  listAuditEvents,
  listAuditFilterOptions,
  type AuditFilters,
  type AuditRow,
} from "@/server/queries/admin";

/**
 * The audit log.
 *
 * Read-only BY CONSTRUCTION, not by policy. `AuditEvent` has no update or delete
 * path anywhere in the application, and the database trigger added in
 * `20261014060000_hard_constraints` rejects both even from raw SQL — so nothing
 * on this screen is withheld from the admin as a matter of taste. There is no
 * edit affordance because there is no edit, and the notice at the top says so
 * rather than leaving an admin to wonder whether they are missing a button.
 *
 * The filters are a plain `GET` form with no `action`, like the patient list's,
 * so re-submitting keeps the `/ar` or `/en` prefix. The filter values are
 * untrusted query-string values and are narrowed before they reach a query;
 * `buildAuditWhere` then interpolates them as parameters, never as SQL.
 *
 * `params` is awaited here (the `[locale]` segment is statically known) and the
 * `searchParams` promise is passed into `<Suspense>`, where the child awaits it
 * after `requireSessionUser` — the order that keeps `next build` from resolving
 * a session at build time.
 */

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** `yyyy-MM-dd` from an `<input type="date">`, kept as a local calendar date. */
function parseDate(value: string | string[] | undefined): string | undefined {
  const raw = one(value);
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

function parsePage(value: string | string[] | undefined): number {
  const raw = one(value);
  if (!raw) return 1;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "audit" });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Suspense fallback={<SkeletonRows rows={8} />}>
        <AuditBody locale={locale} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function AuditBody({
  locale,
  searchParams,
}: {
  locale: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const user = await requireSessionUser(locale);
  requirePermission(user, "audit:read");

  const [t, tNav, tAction, tEntity] = await Promise.all([
    getTranslations({ locale, namespace: "audit" }),
    getTranslations({ locale, namespace: "audit.nav" }),
    getTranslations({ locale, namespace: "audit.action" }),
    getTranslations({ locale, namespace: "audit.entity" }),
  ]);

  const actor = one(raw.actor);
  const action = one(raw.action);
  const entityType = one(raw.entityType);
  const from = parseDate(raw.from);
  const to = parseDate(raw.to);
  const page = parsePage(raw.page);

  /*
   * The range is interpreted in the PHARMACY's time zone, not the server's and
   * not UTC.
   *
   * "From the 1st to the 3rd" is a question a person asks about their own
   * working days. Converting those calendar dates at UTC midnight would drop
   * everything a pharmacy in Cairo did after 21:00 on the last day of the range
   * — and Egypt reintroduced daylight saving, so a fixed offset would be an hour
   * wrong twice a year. Luxon does the conversion from the zone the scheduler
   * already uses to store the reminder times.
   */
  const zone = user.pharmacyTimeZone || "UTC";

  const filters: AuditFilters = {
    actor,
    action,
    entityType,
    ...(from
      ? { fromUtc: DateTime.fromISO(from, { zone }).startOf("day").toUTC().toJSDate() }
      : {}),
    ...(to ? { toUtc: DateTime.fromISO(to, { zone }).endOf("day").toUTC().toJSDate() } : {}),
  };

  const [result, options] = await Promise.all([
    listAuditEvents(user.pharmacyId, filters, page),
    listAuditFilterOptions(user.pharmacyId),
  ]);

  // Any filter narrows the log; the empty state has to say which of the two
  // reasons it is empty for.
  const filtered = Boolean(actor || action || entityType || from || to);

  return (
    <div className="space-y-6">
      <nav aria-label={tNav("label")}>
        <ul className="flex flex-wrap items-center gap-1">
          {hasPermission(user, "settings:manage") ? (
            <li>
              <Link
                href="/settings"
                className="block rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                {tNav("profile")}
              </Link>
            </li>
          ) : null}
          {hasPermission(user, "user:manage") ? (
            <li>
              <Link
                href="/settings/users"
                className="block rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                {tNav("users")}
              </Link>
            </li>
          ) : null}
          <li>
            <span
              aria-current="page"
              className="block rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100"
            >
              {tNav("audit")}
            </span>
          </li>
        </ul>
      </nav>

      {/*
       * Stated up front rather than buried. An audit log whose reader believes it
       * might have been edited is worth nothing, and the reason this one cannot
       * be is not that the UI declines to offer it — it is that the database
       * refuses the write.
       */}
      <Notice tone="info" title={t("immutable.title")}>
        {t("immutable.body")}
      </Notice>

      <Card>
        <CardBody>
          <form method="get" className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="audit-actor"
                  className="text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  {t("filters.actor")}
                </label>
                <select
                  id="audit-actor"
                  name="actor"
                  defaultValue={actor ?? ""}
                  className={selectClass}
                >
                  <option value="">{t("filters.anyActor")}</option>
                  {options.actors.map((option) => (
                    <option key={option.value} value={option.value}>
                      {/* The system actor has no user to name, so it is labelled
                          from the catalog rather than from a database row. */}
                      {option.label === "" ? t("system") : option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="audit-action"
                  className="text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  {t("filters.action")}
                </label>
                <select
                  id="audit-action"
                  name="action"
                  defaultValue={action ?? ""}
                  className={selectClass}
                >
                  <option value="">{t("filters.anyAction")}</option>
                  {/* From the log's own contents, not from `AUDIT_ACTION`: a row
                      written by a feature that no longer exists still has to be
                      reachable, or the log looks like it never happened. */}
                  {options.actions.map((value) => (
                    <option key={value} value={value}>
                      {tAction.has(value) ? tAction(value) : value}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="audit-entity"
                  className="text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  {t("filters.entityType")}
                </label>
                <select
                  id="audit-entity"
                  name="entityType"
                  defaultValue={entityType ?? ""}
                  className={selectClass}
                >
                  <option value="">{t("filters.anyEntity")}</option>
                  {options.entityTypes.map((value) => (
                    <option key={value} value={value}>
                      {tEntity.has(value) ? tEntity(value) : value}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="audit-from"
                  className="text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  {t("filters.from")}
                </label>
                <input
                  id="audit-from"
                  name="from"
                  type="date"
                  dir="ltr"
                  defaultValue={from ?? ""}
                  className={inputClass}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="audit-to"
                  className="text-xs font-medium text-slate-600 dark:text-slate-400"
                >
                  {t("filters.to")}
                </label>
                <input
                  id="audit-to"
                  name="to"
                  type="date"
                  dir="ltr"
                  defaultValue={to ?? ""}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className={buttonClass("secondary")}>
                {t("filters.apply")}
              </button>
              {filtered ? (
                <Link href="/settings/audit" className={buttonClass("ghost")}>
                  {t("filters.clear")}
                </Link>
              ) : null}
              <span className="ms-auto text-sm text-slate-500 dark:text-slate-400">
                {t("total", { count: formatNumber(locale, result.total) })}
              </span>
            </div>
          </form>
        </CardBody>
      </Card>

      {result.rows.length === 0 ? (
        <EmptyState
          title={filtered ? t("noResults") : t("empty")}
          hint={filtered ? t("noResultsHint") : t("emptyHint")}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>{t("columns.time")}</Th>
              <Th>{t("columns.actor")}</Th>
              <Th>{t("columns.action")}</Th>
              <Th>{t("columns.entity")}</Th>
              <Th>{t("columns.detail")}</Th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <AuditRowView key={row.id} locale={locale} row={row} />
            ))}
          </tbody>
        </Table>
      )}

      {result.pageCount > 1 ? (
        <Pagination
          locale={locale}
          page={result.page}
          pageCount={result.pageCount}
          filters={{ actor, action, entityType, from, to }}
        />
      ) : null}
    </div>
  );
}

/**
 * One entry.
 *
 * The action is shown as the translated sentence with the raw code beneath it,
 * and the code is not decoration: it is the stable identifier, it is what a
 * support engineer searches for, and it is what makes a row written by a version
 * of the app that no longer knows this action readable anyway. `tAction.has`
 * falls back to the bare code rather than rendering a key path at a pharmacist,
 * which is what next-intl does with a miss.
 *
 * `async` with its own translators rather than a `t` prop: a translator's type
 * comes from the messages it was built for, and narrowing it to
 * `(key: string) => string` to pass it down would throw that away.
 */
async function AuditRowView({ locale, row }: { locale: string; row: AuditRow }) {
  const [t, tAction, tEntity] = await Promise.all([
    getTranslations({ locale, namespace: "audit" }),
    getTranslations({ locale, namespace: "audit.action" }),
    getTranslations({ locale, namespace: "audit.entity" }),
  ]);

  const detail = collectDetail(row);

  return (
    <Tr>
      <Td className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
        <span dir="ltr" className="tabular-nums">
          {formatDateTime(locale, row.occurredAtUtc)}
        </span>
      </Td>

      <Td>
        {row.actorName ? (
          <span className="text-sm text-slate-800 dark:text-slate-200">{row.actorName}</span>
        ) : (
          /* No actor is a fact about the entry, not missing data: the worker and
             the webhook receiver write rows without a session behind them. */
          <span className="text-sm text-slate-500 dark:text-slate-400">{t("system")}</span>
        )}
        {row.ipAddress ? (
          <span dir="ltr" className="block text-xs tabular-nums text-slate-400 dark:text-slate-500">
            {row.ipAddress}
          </span>
        ) : null}
      </Td>

      <Td>
        <span className="block text-sm text-slate-800 dark:text-slate-200">
          {tAction.has(row.action) ? tAction(row.action) : row.action}
        </span>
        <span dir="ltr" className="block font-mono text-[11px] text-slate-400 dark:text-slate-500">
          {row.action}
        </span>
      </Td>

      <Td>
        <span className="block text-sm text-slate-700 dark:text-slate-300">
          {tEntity.has(row.entityType) ? tEntity(row.entityType) : row.entityType}
        </span>
        {row.entityId ? (
          <span
            dir="ltr"
            className="block max-w-40 truncate font-mono text-[11px] text-slate-400 dark:text-slate-500"
            title={row.entityId}
          >
            {row.entityId}
          </span>
        ) : null}
      </Td>

      <Td>
        {detail.length === 0 ? (
          <span className="text-xs text-slate-400 dark:text-slate-500">{t("noDetail")}</span>
        ) : (
          <dl className="space-y-1">
            {detail.map((item) => (
              <div key={item.key} className="space-y-0.5">
                <dt className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  {t(item.key)}
                </dt>
                <dd className="text-xs text-slate-700 dark:text-slate-300">{item.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Td>
    </Tr>
  );
}

/**
 * The `Json` payloads, flattened into labelled rows.
 *
 * `before` and `after` are `Json` columns, so what comes back is `unknown` — an
 * object, an array, a string, or null, depending on which feature wrote it. The
 * shapes are NOT uniform and cannot be: this screen shows every action in the
 * product, including ones whose writer has been deleted. So the rendering is
 * driven by the value's own type rather than by a schema, and anything nested
 * deeper than a scalar is shown as compact JSON — verbose, but complete, and
 * complete is the only property an audit detail has to have.
 *
 * Keys stay as they were written. `userId` and `role` are Prisma field names,
 * not words; translating them would mean a second vocabulary to keep in step
 * with the schema, and a mismatch there would make the log ungreppable.
 *
 * The three possible rows are returned as keys rather than as labels, because
 * the words for them belong in the catalog and this function has no translator.
 */
type DetailKey = "before" | "after" | "reason";

function collectDetail(row: AuditRow): { key: DetailKey; value: string }[] {
  const out: { key: DetailKey; value: string }[] = [];

  const push = (key: DetailKey, value: unknown) => {
    const rendered = renderValue(value);
    if (rendered === null) return;
    out.push({ key, value: rendered });
  };

  push("before", row.before);
  push("after", row.after);
  push("reason", row.reason);

  return out;
}

/** A scalar as text; anything structured as compact JSON; null as nothing. */
function renderValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const json = JSON.stringify(value);
  return json === undefined || json === "{}" || json === "[]" || json === "null" ? null : json;
}

/**
 * The pager, as links rather than form buttons.
 *
 * A `<Link>` keeps the filter query string — dropping it on page two is the
 * classic way a filtered log silently becomes an unfiltered one halfway through
 * reading it. The page number is clamped by `listAuditEvents` as well, so a
 * stale link past the end renders the last page rather than nothing.
 */
async function Pagination({
  locale,
  page,
  pageCount,
  filters,
}: {
  locale: string;
  page: number;
  pageCount: number;
  filters: Record<string, string | undefined>;
}) {
  const t = await getTranslations({ locale, namespace: "audit" });

  const href = (target: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) query.set(key, value);
    }
    query.set("page", String(target));
    return `/settings/audit?${query.toString()}`;
  };

  return (
    <nav aria-label={t("pagination")} className="flex flex-wrap items-center gap-3">
      {page > 1 ? (
        <Link href={href(page - 1)} className={buttonClass("secondary", "sm")}>
          {t("previous")}
        </Link>
      ) : null}

      <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
        {t("page", { page: formatNumber(locale, page), pages: formatNumber(locale, pageCount) })}
      </span>

      {page < pageCount ? (
        <Link href={href(page + 1)} className={buttonClass("secondary", "sm")}>
          {t("next")}
        </Link>
      ) : null}
    </nav>
  );
}

/** Latin digits in both locales — a timestamp is scanned, not read aloud. */
function formatDateTime(locale: string, value: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(value);
}

function formatNumber(locale: string, value: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US").format(value);
}
