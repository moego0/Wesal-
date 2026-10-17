import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import {
  Card,
  CardHeader,
  EmptyState,
  Notice,
  PageHeader,
  Skeleton,
  StatCard,
  Table,
  Td,
  Th,
  Tr,
} from "@/components/ui";
import { isAdminEnabled } from "@/server/admin/flag";
import {
  getPharmacyOps,
  getQueueDepth,
  getSweepHealth,
  listPharmacyTemplates,
  type SweepStatus,
} from "@/server/admin/ops";
import { requireSessionUser } from "@/server/auth/current-user";
import { hasPermission } from "@/server/auth/rbac";
import { listPharmacyChannels } from "@/server/queries/admin";

/**
 * The operations console.
 *
 * Read-only. It surfaces, in one place, the handful of facts that are otherwise
 * only reachable by opening `psql` on the server — and the facts it surfaces
 * were chosen because every one of them describes a failure that is otherwise
 * SILENT. A stopped sweep, a reply that matched no pharmacy, a send stuck
 * mid-flight: none of these raise an error, and the app keeps returning 200 the
 * whole time. See the Verification section of `docs/DEPLOY.md`, which asks an
 * operator to check exactly these by hand.
 *
 * ## Why both guards below are `notFound()`
 *
 * `src/app` has no `error.tsx` and no `not-found.tsx`. So `requirePermission`,
 * which throws `PermissionDeniedError`, would surface as a raw 500 with a stack
 * trace — and a stack trace on an authorization failure is both ugly and an
 * information leak.
 *
 * `notFound()` gives a clean 404 that is *indistinguishable from the flag being
 * off*, which is the right answer for an operations surface: someone without the
 * permission cannot tell whether the console exists, is switched off, or is
 * simply not for them. This deliberately diverges from `settings/*`, which do
 * use `requirePermission`; those are ordinary product screens where a loud
 * failure is more useful than a quiet one.
 *
 * The flag is checked FIRST, before the session is even resolved. A deployment
 * that never enabled the console should not do a database round trip to decide
 * that the route does not exist.
 */

export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin" });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/* `params` is awaited above (the segment is statically known) and the
          session-dependent work streams in below — the ordering that keeps
          `next build` from resolving a session at build time. */}
      <Suspense fallback={<SkeletonRowsFallback />}>
        <AdminBody locale={locale} />
      </Suspense>
    </div>
  );
}

function SkeletonRowsFallback() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-28" />
      <Skeleton className="h-64" />
      <Skeleton className="h-48" />
    </div>
  );
}

async function AdminBody({ locale }: { locale: string }) {
  if (!isAdminEnabled()) notFound();

  const user = await requireSessionUser(locale);

  if (!hasPermission(user, "settings:manage")) notFound();

  const t = await getTranslations({ locale, namespace: "admin" });

  const [sweeps, queues, ops, channels, templates] = await Promise.all([
    getSweepHealth(),
    getQueueDepth(),
    getPharmacyOps(user.pharmacyId),
    listPharmacyChannels(user.pharmacyId),
    listPharmacyTemplates(user.pharmacyId),
  ]);

  const stale = sweeps.filter((sweep) => sweep.stale);

  // A map rather than a repeated `find`, and keyed by both fields so two queues
  // with the same state cannot be confused for each other.
  const depth = new Map(queues.map((row) => [`${row.queue}|${row.state}`, row.count]));
  const queueNames = [...new Set(queues.map((row) => row.queue))];

  return (
    <div className="space-y-6">
      <AdminNav locale={locale} />

      {stale.length > 0 ? (
        <Notice tone="danger" title={t("health.bad.title")}>
          {t("health.bad.body", {
            stale: formatNumber(locale, stale.length),
            total: formatNumber(locale, sweeps.length),
          })}
        </Notice>
      ) : (
        <Notice tone="success" title={t("health.good.title")}>
          {t("health.good.body")}
        </Notice>
      )}

      {/*
       * Called out separately from the sweep health above, because it is a
       * different failure with a different cause and a different fix. A stale
       * sweep means the worker stopped; an unrouted reply means the worker is
       * fine and the channel's number disagrees with what Meta sends. Folding
       * them into one banner would send an operator to the wrong place.
       */}
      {ops.unrouted > 0 ? (
        <Notice tone="danger" title={t("unrouted.title")}>
          {t("unrouted.body", { count: formatNumber(locale, ops.unrouted) })}
        </Notice>
      ) : null}

      <section className="space-y-3">
        <Card>
          <CardHeader title={t("sweeps.title")} subtitle={t("sweeps.subtitle")} />
          <Table>
            <thead>
              <tr>
                <Th>{t("sweeps.sweep")}</Th>
                <Th>{t("sweeps.status")}</Th>
                <Th>{t("sweeps.age")}</Th>
                <Th>{t("sweeps.duration")}</Th>
                <Th>{t("sweeps.error")}</Th>
              </tr>
            </thead>
            <tbody>
              {sweeps.map((sweep) => (
                <SweepRow key={sweep.sweep} locale={locale} sweep={sweep} />
              ))}
            </tbody>
          </Table>
        </Card>
      </section>

      <section className="space-y-3">
        <Card>
          <CardHeader title={t("queues.title")} subtitle={t("queues.subtitle")} />
          <Table>
            <thead>
              <tr>
                <Th>{t("queues.queue")}</Th>
                {QUEUE_STATES.map((state) => (
                  <Th key={state} align="end">
                    {t(`queues.states.${state}`)}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {queueNames.map((queue) => (
                <Tr key={queue}>
                  {/* Keyed off BullMQ's own names, with the catalog as a
                      lookup and the raw name as the fallback — the same shape
                      the audit log uses for actions. A queue that exists in
                      Redis but not in the catalog still renders. */}
                  <Td>
                    {t.has(`queues.names.${queue}`) ? t(`queues.names.${queue}`) : queue}
                  </Td>
                  {QUEUE_STATES.map((state) => (
                    <Td key={state} align="end" className="tabular-nums">
                      {formatNumber(locale, depth.get(`${queue}|${state}`) ?? 0)}
                    </Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          {t("pharmacy.title")}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label={t("pharmacy.unrouted")}
            value={formatNumber(locale, ops.unrouted)}
            hint={t("pharmacy.unroutedHint")}
            tone={ops.unrouted > 0 ? "attention" : "neutral"}
          />
          <StatCard
            label={t("pharmacy.unprocessed")}
            value={formatNumber(locale, ops.unprocessed)}
            hint={t("pharmacy.unprocessedHint")}
            tone={ops.unprocessed > 0 ? "attention" : "neutral"}
          />
          <StatCard
            label={t("pharmacy.stuck")}
            value={formatNumber(locale, ops.attemptingOverdue)}
            hint={t("pharmacy.stuckHint")}
            tone={ops.attemptingOverdue > 0 ? "attention" : "neutral"}
          />
          <StatCard
            label={t("pharmacy.failed")}
            value={formatNumber(locale, ops.failedLast24h)}
            tone={ops.failedLast24h > 0 ? "attention" : "neutral"}
          />
        </div>
      </section>

      <section className="space-y-3">
        <Card>
          <CardHeader title={t("failures.title")} subtitle={t("failures.subtitle")} />
          {ops.recentFailures.length === 0 ? (
            <EmptyState title={t("failures.empty")} hint={t("failures.emptyHint")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("failures.when")}</Th>
                  <Th>{t("failures.patient")}</Th>
                  <Th>{t("failures.code")}</Th>
                  <Th>{t("failures.message")}</Th>
                </tr>
              </thead>
              <tbody>
                {ops.recentFailures.map((failure) => (
                  <Tr key={failure.id}>
                    <Td className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                      <span dir="ltr" className="tabular-nums">
                        {failure.failedAtUtc
                          ? formatDateTime(locale, failure.failedAtUtc)
                          : t("failures.unknownTime")}
                      </span>
                    </Td>
                    <Td>
                      <span dir="ltr" className="tabular-nums text-sm">
                        {failure.toPhoneE164}
                      </span>
                    </Td>
                    <Td>
                      <span dir="ltr" className="font-mono text-xs">
                        {failure.errorCode ?? "—"}
                      </span>
                    </Td>
                    <Td className="max-w-80 text-xs">{failure.errorMessage ?? "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("channels.title")} subtitle={t("channels.subtitle")} />
          {channels.length === 0 ? (
            <EmptyState title={t("channels.empty")} hint={t("channels.emptyHint")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("channels.number")}</Th>
                  <Th>{t("channels.provider")}</Th>
                  <Th>{t("channels.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {channels.map((channel) => (
                  <Tr key={channel.id}>
                    <Td>
                      <span dir="ltr" className="tabular-nums text-sm">
                        {channel.displayPhoneE164 || "—"}
                      </span>
                      {/* The routing key. Shown because the single most common
                          silent failure is this value disagreeing with what Meta
                          sends, and comparing them is the whole diagnosis. */}
                      <span className="block font-mono text-[11px] text-slate-400 dark:text-slate-500">
                        <span dir="ltr">{channel.providerPhoneNumberId}</span>
                      </span>
                    </Td>
                    <Td className="font-mono text-xs">{channel.provider}</Td>
                    <Td className="text-xs">{channel.status}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title={t("templates.title")} subtitle={t("templates.subtitle")} />
          {templates.length === 0 ? (
            <EmptyState title={t("templates.empty")} hint={t("templates.emptyHint")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("templates.name")}</Th>
                  <Th>{t("templates.language")}</Th>
                  <Th>{t("templates.templateStatus")}</Th>
                </tr>
              </thead>
              <tbody>
                {templates.map((template) => (
                  <Tr key={template.id}>
                    <Td className="font-mono text-xs">
                      <span dir="ltr">{template.providerName}</span>
                    </Td>
                    <Td>
                      <span dir="ltr" className="text-xs">
                        {template.languageCode}
                      </span>
                    </Td>
                    <Td className="text-xs">{template.status}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </section>
    </div>
  );
}

/**
 * The settings sections, with Operations as the current one.
 *
 * Duplicated from `settings/audit/page.tsx` rather than extracted, matching how
 * that page already does it. The guards genuinely differ per section — this one
 * is `settings:manage`, the users list is `user:manage`, the audit log is
 * `audit:read` — so a shared component would need all three passed in and would
 * save less than the indirection costs.
 */
async function AdminNav({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: "admin.nav" });

  const linkClass =
    "block rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100";

  return (
    <nav aria-label={t("label")}>
      <ul className="flex flex-wrap items-center gap-1">
        <li>
          <Link href="/settings" className={linkClass}>
            {t("profile")}
          </Link>
        </li>
        <li>
          <Link href="/settings/users" className={linkClass}>
            {t("users")}
          </Link>
        </li>
        <li>
          <Link href="/settings/audit" className={linkClass}>
            {t("audit")}
          </Link>
        </li>
        <li>
          <span
            aria-current="page"
            className="block rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100"
          >
            {t("operations")}
          </span>
        </li>
      </ul>
    </nav>
  );
}

/**
 * The states the queue table shows, in the order a reader looks for them.
 *
 * Must stay in step with `JOB_STATES` in `@/server/admin/ops`, which is what is
 * actually asked of Redis. `paused` is not among them — see the note there.
 */
const QUEUE_STATES = ["wait", "active", "delayed", "failed", "completed"] as const;

/**
 * One sweep.
 *
 * `async` with its own translator rather than taking a `t` prop, for the same
 * reason `AuditRowView` does: a translator's type comes from the messages it was
 * built for, and widening it to `(key: string) => string` to pass it down would
 * throw that away.
 */
async function SweepRow({ locale, sweep }: { locale: string; sweep: SweepStatus }) {
  const [t, tNames] = await Promise.all([
    getTranslations({ locale, namespace: "admin" }),
    getTranslations({ locale, namespace: "admin.sweeps.names" }),
  ]);

  const never = sweep.ageSeconds < 0;

  /*
   * The duration cell is blank for a sweep that has never run, rather than "0s".
   * `deriveSweepStatus` deliberately reports `null` for a missing heartbeat, and
   * "took zero milliseconds" is a claim about a run that did not happen.
   */
  const duration =
    sweep.lastDurationMs === null
      ? "—"
      : t("sweeps.milliseconds", { count: formatNumber(locale, sweep.lastDurationMs) });

  return (
    <Tr>
      <Td>
        <span className="block text-sm text-slate-800 dark:text-slate-200">
          {tNames.has(sweep.sweep) ? tNames(sweep.sweep) : sweep.sweep}
        </span>
        <span
          dir="ltr"
          className="block font-mono text-[11px] text-slate-400 dark:text-slate-500"
        >
          {sweep.sweep}
        </span>
      </Td>

      <Td>
        {sweep.stale ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-700 dark:text-rose-300">
            <span aria-hidden className="size-1.5 rounded-full bg-rose-500" />
            {never ? t("sweeps.never") : t("sweeps.stale")}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-700 dark:text-teal-300">
            <span aria-hidden className="size-1.5 rounded-full bg-teal-500" />
            {t("sweeps.running")}
          </span>
        )}
      </Td>

      <Td className="whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
        {never
          ? t("sweeps.never")
          : t("sweeps.seconds", { count: formatNumber(locale, sweep.ageSeconds) })}
      </Td>

      <Td className="whitespace-nowrap text-xs tabular-nums text-slate-500 dark:text-slate-400">
        {duration}
      </Td>

      <Td className="max-w-80 text-xs">
        {sweep.lastError ? (
          <span className="text-rose-700 dark:text-rose-300">
            <span dir="ltr">{sweep.lastError}</span>
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">{t("sweeps.noError")}</span>
        )}
      </Td>
    </Tr>
  );
}

/** Latin digits in both locales — a metric is scanned, not read aloud. */
function formatNumber(locale: string, value: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US").format(value);
}

function formatDateTime(locale: string, value: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(value);
}
