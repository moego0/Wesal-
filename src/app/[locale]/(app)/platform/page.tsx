import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Locale } from "@/generated/prisma/enums";
import { Link } from "@/i18n/navigation";
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
  Table,
  Td,
  Th,
  Tr,
  buttonClass,
  inputClass,
  selectClass,
} from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { supportedTimeZones } from "@/server/queries/admin";
import { listPlatformPharmacies } from "@/server/platform/admin";
import { createPharmacyAction } from "@/server/platform/actions";

/**
 * The platform console.
 *
 * The one screen that is not scoped to a pharmacy: it lists every pharmacy on
 * the installation, and it is where a pharmacy — and its first manager — is
 * created. It exists only for the platform owner (`User.isSuperAdmin`), which is
 * a flag on the account rather than a role, because no pharmacy role can be
 * granted it.
 *
 * ## Why the guard is `notFound()`
 *
 * Same reasoning as the operations console: `src/app` has no `error.tsx`, so a
 * thrown `PermissionDeniedError` would be a 500 with a stack trace. A 404 is
 * indistinguishable from a route that does not exist, which is the right answer
 * for a surface that is deliberately absent from everybody else's navigation.
 * `listPlatformPharmacies` re-checks the flag and throws if it is missing, so a
 * broken guard here fails closed rather than leaking the list.
 *
 * ## Why the form and the list share a page
 *
 * A brand-new installation has no pharmacies; a screen that only lists rows
 * would be empty with no way forward. Creating one is the page's primary action
 * until there are rows, and stays at the top afterwards.
 */
export default async function PlatformPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "platform" });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Suspense fallback={<SkeletonRows rows={7} />}>
        <PlatformBody locale={locale} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const OK_CODES = new Set(["PHARMACY_CREATED"]);

const ERROR_CODES = new Set(["NOT_FOUND", "INVALID_INPUT", "EMAIL_TAKEN"]);

/**
 * The core reports the offending field by its INPUT name; the catalog uses the
 * same names so a refusal can be shown beside the field that caused it. A field
 * this page does not render (or a future one) falls back to the generic wording.
 */
const FIELD_MESSAGE: Record<string, string> = {
  name: "name",
  timeZone: "timeZone",
  defaultLocale: "defaultLocale",
  quietHoursStart: "quietHoursStart",
  quietHoursEnd: "quietHoursEnd",
  managerFullName: "managerFullName",
  managerEmail: "managerEmail",
  managerPhoneE164: "managerPhoneE164",
  managerPassword: "managerPassword",
};

async function PlatformBody({
  locale,
  searchParams,
}: {
  locale: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const user = await requireSessionUser(locale);

  if (!user.isSuperAdmin) notFound();

  const t = await getTranslations({ locale, namespace: "platform" });
  const pharmacies = await listPlatformPharmacies(user);

  const ok = one(raw.ok);
  const error = one(raw.error);
  const field = one(raw.field);

  const zones = supportedTimeZones("Africa/Cairo");

  return (
    <div className="space-y-6">
      {ok && OK_CODES.has(ok) ? <Notice tone="success" title={t(`ok.${ok}`)} /> : null}

      {error ? (
        <Notice tone="danger" title={t("error.title")}>
          {[
            ERROR_CODES.has(error) ? t(`error.${error}`) : null,
            field && FIELD_MESSAGE[field]
              ? t(`error.field.${FIELD_MESSAGE[field]}`)
              : null,
          ]
            .filter(Boolean)
            .join(" ")}
        </Notice>
      ) : null}

      <Card>
        <CardHeader
          title={t("newPharmacy.title")}
          subtitle={t("newPharmacy.hint")}
        />
        <CardBody>
          <form action={createPharmacyAction} className="space-y-4">
            <input type="hidden" name="locale" value={locale} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("newPharmacy.name")}
                htmlFor="pharmacy-name"
                required
              >
                <input
                  id="pharmacy-name"
                  name="name"
                  required
                  minLength={2}
                  maxLength={120}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>

              <Field
                label={t("newPharmacy.timeZone")}
                htmlFor="pharmacy-time-zone"
                hint={t("newPharmacy.timeZoneHint")}
              >
                <select
                  id="pharmacy-time-zone"
                  name="timeZone"
                  defaultValue="Africa/Cairo"
                  className={selectClass}
                >
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t("newPharmacy.defaultLocale")} htmlFor="pharmacy-locale">
                <select
                  id="pharmacy-locale"
                  name="defaultLocale"
                  defaultValue={Locale.AR_EG}
                  className={selectClass}
                >
                  {/*
                   * The enum itself, not a hand-written list — the same argument
                   * as the role selects: an added locale appears here, and the
                   * missing label would fail the message coverage test.
                   */}
                  {Object.values(Locale).map((value) => (
                    <option key={value} value={value}>
                      {t(`newPharmacy.locale.${value}`)}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field
                  label={t("newPharmacy.quietStart")}
                  htmlFor="pharmacy-quiet-start"
                >
                  <input
                    id="pharmacy-quiet-start"
                    name="quietHoursStart"
                    type="time"
                    defaultValue="21:30"
                    dir="ltr"
                    className={inputClass}
                  />
                </Field>
                <Field
                  label={t("newPharmacy.quietEnd")}
                  htmlFor="pharmacy-quiet-end"
                >
                  <input
                    id="pharmacy-quiet-end"
                    name="quietHoursEnd"
                    type="time"
                    defaultValue="07:00"
                    dir="ltr"
                    className={inputClass}
                  />
                </Field>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                {t("newPharmacy.managerSection")}
              </h3>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("newPharmacy.managerFullName")}
                htmlFor="manager-name"
                required
              >
                <input
                  id="manager-name"
                  name="managerFullName"
                  required
                  minLength={2}
                  maxLength={120}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>

              <Field
                label={t("newPharmacy.managerEmail")}
                htmlFor="manager-email"
                required
              >
                <input
                  id="manager-email"
                  name="managerEmail"
                  type="email"
                  required
                  dir="ltr"
                  maxLength={200}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>

              <Field
                label={t("newPharmacy.managerPhone")}
                htmlFor="manager-phone"
              >
                <input
                  id="manager-phone"
                  name="managerPhoneE164"
                  type="tel"
                  dir="ltr"
                  maxLength={20}
                  placeholder="+201000000000"
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>

              <Field
                label={t("newPharmacy.managerPassword")}
                htmlFor="manager-password"
                hint={t("newPharmacy.managerPasswordHint")}
                required
              >
                <input
                  id="manager-password"
                  name="managerPassword"
                  type="password"
                  required
                  dir="ltr"
                  minLength={10}
                  maxLength={200}
                  autoComplete="new-password"
                  className={inputClass}
                />
              </Field>
            </div>

            <FormActions>
              <button type="submit" className={buttonClass("primary")}>
                {t("newPharmacy.submit")}
              </button>
            </FormActions>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("list.title")} />
        {pharmacies.length === 0 ? (
          <EmptyState title={t("list.empty")} hint={t("list.emptyHint")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("list.columns.name")}</Th>
                <Th align="end">{t("list.columns.managers")}</Th>
                <Th align="end">{t("list.columns.doctors")}</Th>
                <Th align="end">{t("list.columns.patients")}</Th>
                <Th>{t("list.columns.created")}</Th>
              </tr>
            </thead>
            <tbody>
              {pharmacies.map((pharmacy) => (
                <Tr key={pharmacy.id}>
                  <Td>
                    <Link
                      href={`/platform/${pharmacy.id}`}
                      className="font-medium text-slate-800 underline-offset-2 hover:underline dark:text-slate-100"
                    >
                      {pharmacy.name}
                    </Link>
                    <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                      <span dir="ltr">{pharmacy.timeZone}</span>
                      {" · "}
                      {t(
                        pharmacy.status === "ACTIVE"
                          ? "status.ACTIVE"
                          : "status.OTHER",
                        { status: pharmacy.status },
                      )}
                    </span>
                  </Td>
                  <Td align="end" className="tabular-nums">
                    {formatNumber(locale, pharmacy.managers)}
                  </Td>
                  <Td align="end" className="tabular-nums">
                    {formatNumber(locale, pharmacy.doctors)}
                  </Td>
                  <Td align="end" className="tabular-nums">
                    {formatNumber(locale, pharmacy.patients)}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
                    <span dir="ltr" className="tabular-nums">
                      {formatDate(locale, pharmacy.createdAt)}
                    </span>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Stated once, on the screen that makes the rule: this is the only place
          accounts come from, and no pharmacy manager can use it. */}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {t("footnote")}
      </p>
    </div>
  );
}

/** Latin digits in both locales — a count is scanned, not read aloud. */
function formatNumber(locale: string, value: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US").format(value);
}

function formatDate(locale: string, value: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
  }).format(value);
}
