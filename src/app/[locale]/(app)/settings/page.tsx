import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Locale as PrismaLocale } from "@/generated/prisma/enums";
import { Link } from "@/i18n/navigation";
import { SEVERITY_TONE, Pill } from "@/components/status";
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  FormActions,
  Notice,
  PageHeader,
  SkeletonRows,
  buttonClass,
  inputClass,
  selectClass,
} from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { hasPermission, requirePermission } from "@/server/auth/rbac";
import type { RuleParams } from "@/server/rules/catalog";
import {
  DRY_RUN_SAMPLE,
  dryRunRuleSettings,
  getPharmacyProfile,
  listPharmacyChannels,
  listRuleSettings,
  paramMeta,
  supportedTimeZones,
  type RuleDryRun,
  type RuleSetting,
} from "@/server/queries/admin";
import { saveRuleSettings, updatePharmacyProfile } from "@/server/settings/actions";

/**
 * Pharmacy settings: the profile, and the thresholds every alert rule runs with.
 *
 * Built exactly like the patient list — `params` is awaited here because
 * `[locale]` has a `generateStaticParams`, and the `searchParams` PROMISE is
 * handed to a `<Suspense>` child instead of being awaited, so awaiting it in
 * there does not make the route request-bound. The child calls
 * `requireSessionUser` before it reads anything, which is what keeps `next build`
 * from trying to resolve a session at build time.
 *
 * ## Why the result of a POST arrives in the query string
 *
 * Every form here is a plain `<form action={serverAction}>` — no client
 * component, so no `useActionState`. The action therefore cannot hand back a
 * state object; it redirects, and the outcome travels as `?ok=…` /
 * `?error=…&field=…`, which is the one channel a POST has back to a Server
 * Component. The codes are the action's machine-readable result and the words
 * live in the catalog, so both languages say the same thing and the coverage
 * test can see both.
 */

/**
 * `searchParams` values are untrusted: a query string can be repeated
 * (`?ok=a&ok=b`) so the type is `string | string[] | undefined`. Narrow once.
 */
function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const OK_CODES = new Set(["PROFILE_SAVED", "RULE_SAVED"]);
const ERROR_CODES = new Set(["INVALID_INPUT", "NOT_FOUND", "FORBIDDEN"]);

/**
 * Field name → the message that explains it.
 *
 * A rule parameter's name is deliberately absent. The names are catalogue keys
 * (`threshold`, `windowDays`), not words, and the bounds differ per rule — so a
 * parameter rejected out of range falls through to `field.params` while the
 * range is printed beside the input it belongs to. A sentence per parameter
 * would be a second copy of `RULE_PARAM_META` in a translation file, and that is
 * the copy that goes stale.
 */
const FIELD_MESSAGE: Record<string, string> = {
  name: "field.name",
  timeZone: "field.timeZone",
  defaultLocale: "field.defaultLocale",
  quietHoursStart: "field.quietHoursStart",
  quietHoursEnd: "field.quietHoursEnd",
  ruleKey: "field.ruleKey",
};

/**
 * `Pharmacy.defaultLocale` is Prisma's `Locale` — `AR_EG` / `EN` — while the
 * routing locale is `ar` / `en`. The two language names already exist in the
 * `localeSwitcher` namespace, so this points at that key rather than adding a
 * second copy of them.
 */
const LOCALE_SWITCHER_KEY: Record<PrismaLocale, string> = { AR_EG: "ar", EN: "en" };

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "settings" });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Suspense fallback={<SkeletonRows rows={8} />}>
        <SettingsBody locale={locale} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function SettingsBody({
  locale,
  searchParams,
}: {
  locale: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const user = await requireSessionUser(locale);
  // The page refuses rather than rendering a read-only version: everything on it
  // is a form, and a form that appears to work and then rejects the POST is
  // worse than a page that says it is not for you.
  requirePermission(user, "settings:manage");

  const [t, tNav, tLocaleSwitcher] = await Promise.all([
    getTranslations({ locale, namespace: "settings" }),
    getTranslations({ locale, namespace: "settings.nav" }),
    getTranslations({ locale, namespace: "localeSwitcher" }),
  ]);

  const [profile, channels, rules] = await Promise.all([
    getPharmacyProfile(user.pharmacyId),
    listPharmacyChannels(user.pharmacyId),
    listRuleSettings(user.pharmacyId),
  ]);

  if (!profile) notFound();

  const ok = one(raw.ok);
  const error = one(raw.error);
  const field = one(raw.field);
  const dryKey = one(raw.dry);

  /*
   * The dry run is computed only for the rule that was asked for.
   *
   * Seven rules on every page load would be seven sequential scans of the same
   * reminder rows, for a number nobody asked to see. `?dry=<ruleKey>` is a GET
   * form with a submit button, so the projection is one click and lands inside
   * the rule's own card.
   *
   * It projects the SAVED values, never the numbers currently sitting in the
   * inputs: a GET form does not carry another form's fields, and a projection of
   * something the engine is not actually running would be a number about
   * nothing. The values just saved are projected by the action itself, and that
   * figure arrives in the `RULE_SAVED` notice below.
   */
  const dryRule = dryKey ? rules.find((r) => r.key === dryKey) : undefined;

  const dry = dryRule
    ? (
        await dryRunRuleSettings(
          user.pharmacyId,
          [{ key: dryRule.key, params: paramsOf(dryRule) }],
          DRY_RUN_SAMPLE,
        )
      ).get(dryRule.key)
    : undefined;

  return (
    <div className="space-y-6">
      <nav aria-label={tNav("label")}>
        <ul className="flex flex-wrap items-center gap-1">
          <li>
            <span
              aria-current="page"
              className="block rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100"
            >
              {tNav("profile")}
            </span>
          </li>
          {/* Gated per item: `settings:manage` does not imply `user:manage` in the
              role map, and a link to a page that will refuse you is a dead end
              dressed up as navigation. */}
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
          {hasPermission(user, "audit:read") ? (
            <li>
              <Link
                href="/settings/audit"
                className="block rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                {tNav("audit")}
              </Link>
            </li>
          ) : null}
        </ul>
      </nav>

      {ok && OK_CODES.has(ok) ? (
        <Notice tone="success" title={ok === "PROFILE_SAVED" ? t("ok.PROFILE_SAVED") : undefined}>
          {ok === "RULE_SAVED"
            ? one(raw.alerts) === undefined
              ? t("ok.RULE_SAVED_UNPROJECTED")
              : t("ok.RULE_SAVED", {
                  // Pre-formatted, so the count keeps Latin digits in Arabic the
                  // way every other number in this app does.
                  alerts: formatNumber(locale, Number(one(raw.alerts))),
                })
            : null}
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="danger" title={t("error.title")}>
          {[
            ERROR_CODES.has(error) ? t(`error.${error}`) : null,
            field ? t(`error.${FIELD_MESSAGE[field] ?? "field.params"}`) : null,
          ]
            .filter(Boolean)
            .join(" ")}
        </Notice>
      ) : null}

      <Card>
        <CardHeader title={t("profile.title")} subtitle={t("profile.hint")} />
        <CardBody>
          <form action={updatePharmacyProfile} className="space-y-4">
            {/* The action cannot read the URL it was posted from, so the locale
                travels in the form — and is validated, because it ends up in a
                redirect target. */}
            <input type="hidden" name="locale" value={locale} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("profile.name")} htmlFor="pharmacy-name" required>
                <input
                  id="pharmacy-name"
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={profile.name}
                  className={inputClass}
                />
              </Field>

              <Field
                label={t("profile.timeZone")}
                htmlFor="pharmacy-time-zone"
                hint={t("profile.timeZoneHint")}
              >
                {/*
                 * A `<datalist>` rather than a 400-option `<select>`: the IANA
                 * list is long enough that scrolling it is slower than typing the
                 * first few letters, and the browser filters it natively. It also
                 * leaves room for a zone the runtime knows — the action validates
                 * with `Intl`, which is the same authority the scheduler uses.
                 */}
                <input
                  id="pharmacy-time-zone"
                  name="timeZone"
                  list="pharmacy-time-zones"
                  required
                  dir="ltr"
                  defaultValue={profile.timeZone}
                  className={inputClass}
                />
                <datalist id="pharmacy-time-zones">
                  {supportedTimeZones(profile.timeZone).map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
              </Field>

              <Field label={t("profile.defaultLocale")} htmlFor="pharmacy-locale">
                <select
                  id="pharmacy-locale"
                  name="defaultLocale"
                  defaultValue={profile.defaultLocale}
                  className={selectClass}
                >
                  {Object.values(PrismaLocale).map((value) => (
                    <option key={value} value={value}>
                      {tLocaleSwitcher(LOCALE_SWITCHER_KEY[value])}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label={t("profile.quietStart")} htmlFor="pharmacy-quiet-start">
                  <input
                    id="pharmacy-quiet-start"
                    name="quietHoursStart"
                    type="time"
                    required
                    dir="ltr"
                    defaultValue={profile.quietHoursStart}
                    className={inputClass}
                  />
                </Field>
                <Field
                  label={t("profile.quietEnd")}
                  htmlFor="pharmacy-quiet-end"
                  hint={t("profile.quietHint")}
                >
                  <input
                    id="pharmacy-quiet-end"
                    name="quietHoursEnd"
                    type="time"
                    required
                    dir="ltr"
                    defaultValue={profile.quietHoursEnd}
                    className={inputClass}
                  />
                </Field>
              </div>
            </div>

            <Field
              label={t("profile.reason")}
              htmlFor="pharmacy-reason"
              hint={t("profile.reasonHint")}
            >
              <input id="pharmacy-reason" name="reason" maxLength={200} className={inputClass} />
            </Field>

            <FormActions>
              <button type="submit" className={buttonClass("primary")}>
                {t("profile.submit")}
              </button>
            </FormActions>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("channels.title")} subtitle={t("channels.hint")} />
        <CardBody>
          {channels.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("channels.empty")}</p>
          ) : (
            /*
             * A list, not a form. A channel's number is the routing key inbound
             * webhooks are matched on, so editing it here would silently orphan
             * every reply the patient sends — there is deliberately no input on
             * this card.
             */
            <ul className="space-y-2">
              {channels.map((channel) => (
                <li
                  key={channel.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
                >
                  <span
                    dir="ltr"
                    className="font-medium tabular-nums text-slate-800 dark:text-slate-200"
                  >
                    {channel.displayPhoneE164}
                  </span>
                  <span dir="ltr" className="text-xs text-slate-500 dark:text-slate-400">
                    {channel.provider}
                  </span>
                  <Pill tone={channel.status === "ACTIVE" ? "good" : "muted"}>
                    {channel.status}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
            {t("rules.title")}
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("rules.subtitle", { count: formatNumber(locale, rules.length) })}
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t("rules.hint")}</p>
        </div>

        {rules.length === 0 ? (
          <EmptyState title={t("rules.title")} hint={t("rules.hint")} />
        ) : (
          <div className="space-y-4">
            {rules.map((rule) => (
              <RuleCard
                key={rule.key}
                locale={locale}
                rule={rule}
                dry={dryRule?.key === rule.key ? dry : undefined}
                dryRequested={dryRule?.key === rule.key}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * One rule: what it is running with now, the form that changes it, and the dry
 * run.
 *
 * `async` and takes its own translators rather than receiving a `t` function as
 * a prop — a translator's type is derived from the messages it was built for,
 * and narrowing it to `(key: string) => string` to pass it down would throw that
 * away. The reference screens take a second translator inside the component that
 * needs one, and `getTranslations` resolves the same cached messages.
 */
async function RuleCard({
  locale,
  rule,
  dry,
  dryRequested,
}: {
  locale: string;
  rule: RuleSetting;
  dry: RuleDryRun | null | undefined;
  dryRequested: boolean;
}) {
  const [t, tSeverity] = await Promise.all([
    getTranslations({ locale, namespace: "settings" }),
    getTranslations({ locale, namespace: "enums" }),
  ]);

  return (
    <Card>
      <CardHeader
        title={locale === "ar" ? rule.nameAr : rule.nameEn}
        subtitle={locale === "ar" ? rule.descriptionAr : rule.descriptionEn}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={SEVERITY_TONE[rule.severity]}>
              {tSeverity(`severity.${rule.severity}`)}
            </Pill>
            <Pill tone={rule.ownRowId ? "info" : "muted"}>
              {rule.ownRowId ? t("rules.override") : t("rules.catalogDefault")}
            </Pill>
          </div>
        }
      />
      <CardBody className="space-y-4">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("rules.version", { version: formatNumber(locale, rule.version) })} ·{" "}
          {rule.updatedAt
            ? t("rules.updatedAt", { date: formatDateTime(locale, rule.updatedAt) })
            : t("rules.neverChanged")}
        </p>

        <form action={saveRuleSettings} className="space-y-4">
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="ruleKey" value={rule.key} />

          <div className="grid gap-4 sm:grid-cols-3">
            {rule.params.map((param) => {
              const meta = paramMeta(rule.key, param.name);
              return (
                <Field
                  key={param.name}
                  // The parameter name is a catalogue key and stays Latin, so the
                  // unit is what tells a pharmacist whether `threshold` is a
                  // number of doses or a proportion — the two live under the same
                  // key in different rules.
                  label={`${param.name} — ${t(`rules.unit.${meta.kind}`)}`}
                  htmlFor={`rule-${rule.key}-${param.name}`}
                  hint={t("rules.range", {
                    min: formatNumber(locale, meta.min),
                    max: formatNumber(locale, meta.max),
                  })}
                >
                  <input
                    id={`rule-${rule.key}-${param.name}`}
                    // The action collects everything under this prefix and narrows
                    // it to the parameters the rule resolves to, so a new
                    // catalogue parameter needs no change to the action.
                    name={`param.${param.name}`}
                    type="number"
                    required
                    dir="ltr"
                    step={meta.kind === "ratio" ? "0.05" : "1"}
                    min={meta.min}
                    max={meta.max}
                    defaultValue={param.value}
                    className={inputClass}
                  />
                </Field>
              );
            })}
          </div>

          <Field label={t("profile.reason")} htmlFor={`rule-${rule.key}-reason`}>
            <input
              id={`rule-${rule.key}-reason`}
              name="reason"
              maxLength={200}
              className={inputClass}
            />
          </Field>

          <FormActions>
            <button type="submit" className={buttonClass("primary", "sm")}>
              {t("rules.submit")}
            </button>
          </FormActions>
        </form>

        {/*
         * A GET form, not a POST: the projection changes nothing, and a GET keeps
         * the result on the URL where it can be reloaded or shared. It carries
         * only the rule key — the parameters are the ones that are saved.
         */}
        <div className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <form method="get" className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="dry" value={rule.key} />
            <button type="submit" className={buttonClass("secondary", "sm")}>
              {t("rules.dryRunSubmit")}
            </button>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {t("rules.dryRunHint")}
            </span>
          </form>

          {dryRequested ? (
            dry === null || dry === undefined ? (
              /* `null` is a projection that could not be computed — a dash or a
                 zero here would both claim something we do not know. */
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {t("rules.dryRunInvalid")}
              </p>
            ) : dry.alerts === 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {t("rules.dryRunClean")}
              </p>
            ) : (
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  {t("rules.dryRunResult", {
                    alerts: formatNumber(locale, dry.alerts),
                    patients: formatNumber(locale, dry.patientsMatching),
                  })}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t("rules.dryRunSample", {
                    sample: formatNumber(locale, dry.patientsEvaluated),
                  })}
                </p>
              </div>
            )
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

/** A rule's displayed parameters, back in the shape the dry run takes. */
function paramsOf(rule: RuleSetting): RuleParams {
  return Object.fromEntries(rule.params.map((p) => [p.name, p.value])) as RuleParams;
}

/**
 * Latin digits in both locales, matching the dashboard and the patient list. A
 * count is scanned rather than read aloud, and `128` resolves faster than `١٢٨`
 * for staff who work in both scripts all day.
 */
function formatNumber(locale: string, value: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US").format(value);
}

function formatDateTime(locale: string, value: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}
