import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import { Pill } from "@/components/status";
import {
  Card,
  CardBody,
  CardHeader,
  DefinitionList,
  EmptyState,
  Field,
  FormActions,
  Notice,
  PageHeader,
  SkeletonRows,
  StatCard,
  Table,
  Td,
  Th,
  Tr,
  buttonClass,
  inputClass,
  selectClass,
} from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import {
  countPatientsByCreator,
  type MembershipRow,
} from "@/server/queries/admin";
import { getPlatformPharmacy } from "@/server/platform/admin";
import { createAccountAction, switchPharmacyAction } from "@/server/platform/actions";

/**
 * One pharmacy, as the platform owner sees it: its staff, its patient count and
 * the form that adds the next account.
 *
 * Account creation lives here because it is the platform owner's power. The
 * pharmacy's own users screen keeps role changes and deactivation, but its add
 * form is hidden — and its action refuses the POST — for everyone else.
 *
 * Like the operations console, a caller who is not the platform owner gets a
 * 404 rather than a permission error. The data call re-checks the flag as well.
 *
 * `params` is a promise handed straight to the `<Suspense>` child rather than
 * awaited here. Under `cacheComponents`, awaiting a dynamic segment at the top
 * marks the whole route request-bound and `next build` refuses to prerender it;
 * passing the promise down keeps the shell static while the record streams.
 */
export default function PlatformPharmacyPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<SkeletonRows rows={8} />}>
      <PharmacyBody params={params} searchParams={searchParams} />
    </Suspense>
  );
}

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const OK_CODES = new Set(["ACCOUNT_CREATED", "PHARMACY_OPENED"]);

const ERROR_CODES = new Set(["NOT_FOUND", "INVALID_INPUT", "EMAIL_TAKEN"]);

const FIELD_MESSAGE: Record<string, string> = {
  fullName: "fullName",
  email: "email",
  role: "role",
  phoneE164: "phoneE164",
  initialPassword: "initialPassword",
  pharmacyId: "pharmacyId",
};

async function PharmacyBody({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, id: pharmacyId } = await params;
  const raw = await searchParams;
  const user = await requireSessionUser(locale);

  if (!user.isSuperAdmin) notFound();

  const detail = await getPlatformPharmacy(user, pharmacyId);

  if (!detail) notFound();

  const [t, tRoles, patientCounts] = await Promise.all([
    getTranslations({ locale, namespace: "platform" }),
    getTranslations({ locale, namespace: "roles" }),
    countPatientsByCreator(detail.pharmacy.id),
  ]);

  const ok = one(raw.ok);
  const error = one(raw.error);
  const field = one(raw.field);

  const managers = detail.staff.filter(
    (member) => member.active && member.role === "PHARMACY_ADMIN",
  ).length;
  const doctors = detail.staff.filter(
    (member) => member.active && member.role === "PHARMACIST",
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader title={t("detail.title")} />

      <div className="space-y-1">
        <Link
          href="/platform"
          className="text-sm font-medium text-teal-700 hover:underline dark:text-teal-400"
        >
          {t("detail.back")}
        </Link>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          {detail.pharmacy.name}
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          <span dir="ltr">{detail.pharmacy.timeZone}</span>
          {" · "}
          {t(
            detail.pharmacy.status === "ACTIVE"
              ? "status.ACTIVE"
              : "status.OTHER",
            { status: detail.pharmacy.status },
          )}
        </p>
      </div>

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

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t("detail.managers")}
          value={formatNumber(locale, managers)}
          hint={t("detail.managersHint")}
        />
        <StatCard
          label={t("detail.doctors")}
          value={formatNumber(locale, doctors)}
          hint={t("detail.doctorsHint")}
        />
        <StatCard
          label={t("detail.patients")}
          value={formatNumber(locale, detail.patients)}
          hint={t("detail.patientsHint")}
        />
      </div>

      <Card>
        <CardHeader title={t("detail.info.title")} />
        <CardBody>
          <DefinitionList
            items={[
              {
                term: t("detail.info.timeZone"),
                detail: <span dir="ltr">{detail.pharmacy.timeZone}</span>,
              },
              {
                term: t("detail.info.defaultLocale"),
                detail: t(`newPharmacy.locale.${detail.pharmacy.defaultLocale}`),
              },
              {
                term: t("detail.info.quietHours"),
                detail: (
                  <span dir="ltr" className="tabular-nums">
                    {detail.pharmacy.quietHoursStart}–{detail.pharmacy.quietHoursEnd}
                  </span>
                ),
              },
              {
                term: t("detail.info.created"),
                detail: (
                  <span dir="ltr" className="tabular-nums">
                    {formatDate(locale, detail.pharmacy.createdAt)}
                  </span>
                ),
              },
            ]}
          />
        </CardBody>
      </Card>

      {/*
       * Opening the pharmacy repoints THIS session. Every page below is scoped
       * by the session's pharmacy, so this is how the owner moves between
       * pharmacies without signing out; the switch is audited in the pharmacy
       * being opened.
       */}
      <Card>
        <CardHeader title={t("detail.open.title")} subtitle={t("detail.open.hint")} />
        <CardBody>
          <form action={switchPharmacyAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="pharmacyId" value={detail.pharmacy.id} />
            <input type="hidden" name="to" value="/" />
            <button type="submit" className={buttonClass("secondary")}>
              {t("detail.open.submit")}
            </button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t("detail.addAccount.title")}
          subtitle={t("detail.addAccount.hint")}
        />
        <CardBody>
          <form action={createAccountAction} className="space-y-4">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="pharmacyId" value={detail.pharmacy.id} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t("detail.addAccount.fullName")}
                htmlFor="account-name"
                required
              >
                <input
                  id="account-name"
                  name="fullName"
                  required
                  minLength={2}
                  maxLength={120}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>

              <Field
                label={t("detail.addAccount.email")}
                htmlFor="account-email"
                required
              >
                <input
                  id="account-email"
                  name="email"
                  type="email"
                  required
                  dir="ltr"
                  maxLength={200}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>

              <Field label={t("detail.addAccount.role")} htmlFor="account-role" required>
                <select
                  id="account-role"
                  name="role"
                  required
                  className={selectClass}
                >
                  {/* Manager and doctor only. The action's role schema is the
                      same list, so a hand-written POST cannot add an assistant. */}
                  <option value="PHARMACY_ADMIN">{tRoles("PHARMACY_ADMIN")}</option>
                  <option value="PHARMACIST">{tRoles("PHARMACIST")}</option>
                </select>
              </Field>

              <Field
                label={t("detail.addAccount.phone")}
                htmlFor="account-phone"
              >
                <input
                  id="account-phone"
                  name="phoneE164"
                  type="tel"
                  dir="ltr"
                  maxLength={20}
                  placeholder="+201000000000"
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>

              <div className="sm:col-span-2">
                <Field
                  label={t("detail.addAccount.password")}
                  htmlFor="account-password"
                  hint={t("detail.addAccount.passwordHint")}
                >
                  <input
                    id="account-password"
                    name="initialPassword"
                    type="password"
                    dir="ltr"
                    minLength={10}
                    maxLength={200}
                    autoComplete="new-password"
                    className={inputClass}
                  />
                </Field>
              </div>
            </div>

            <FormActions>
              <button type="submit" className={buttonClass("primary")}>
                {t("detail.addAccount.submit")}
              </button>
            </FormActions>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t("detail.staff.title")}
          subtitle={t("detail.staff.subtitle", {
            count: formatNumber(locale, detail.staff.length),
          })}
        />
        {detail.staff.length === 0 ? (
          <EmptyState
            title={t("detail.staff.empty")}
            hint={t("detail.staff.emptyHint")}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("detail.staff.columns.name")}</Th>
                <Th>{t("detail.staff.columns.email")}</Th>
                <Th>{t("detail.staff.columns.role")}</Th>
                <Th>{t("detail.staff.columns.status")}</Th>
                <Th align="end">{t("detail.staff.columns.patients")}</Th>
                <Th>{t("detail.staff.columns.joined")}</Th>
              </tr>
            </thead>
            <tbody>
              {detail.staff.map((member) => (
                <StaffRow
                  key={member.membershipId}
                  locale={locale}
                  member={member}
                  patientCount={patientCounts.byUserId.get(member.userId) ?? 0}
                />
              ))}
            </tbody>
          </Table>
        )}

        {patientCounts.unassigned > 0 ? (
          <div className="px-5 pb-4">
            <Notice
              tone="info"
              title={t("detail.staff.unassigned", {
                count: formatNumber(locale, patientCounts.unassigned),
              })}
            />
          </div>
        ) : null}
      </Card>
    </div>
  );
}

/**
 * One staff member. `async` with its own translators rather than a `t` prop,
 * matching the users screen: a translator's type comes from its namespace, and
 * widening it to `(key: string) => string` to pass it down would discard that.
 */
async function StaffRow({
  locale,
  member,
  patientCount,
}: {
  locale: string;
  member: MembershipRow;
  patientCount: number;
}) {
  const [t, tRoles] = await Promise.all([
    getTranslations({ locale, namespace: "platform" }),
    getTranslations({ locale, namespace: "roles" }),
  ]);

  return (
    <Tr className={member.active ? undefined : "opacity-60"}>
      <Td>
        <span className="block font-medium text-slate-800 dark:text-slate-100">
          {member.fullName}
        </span>
        <span className="block text-xs text-slate-500 dark:text-slate-400">
          {t(member.active ? "detail.staff.active" : "detail.staff.inactive")}
        </span>
      </Td>
      <Td className="text-xs">
        <span dir="ltr" className="block">
          {member.email}
        </span>
        {member.phoneE164 ? (
          <span
            dir="ltr"
            className="block tabular-nums text-slate-500 dark:text-slate-400"
          >
            {member.phoneE164}
          </span>
        ) : null}
      </Td>
      <Td className="text-sm">{tRoles(member.role)}</Td>
      <Td>
        <Pill tone={member.userStatus === "ACTIVE" ? "good" : "warn"}>
          {t(`detail.staff.userStatus.${member.userStatus}`)}
        </Pill>
      </Td>
      <Td align="end" className="tabular-nums">
        {formatNumber(locale, patientCount)}
      </Td>
      <Td className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
        <span dir="ltr" className="tabular-nums">
          {formatDate(locale, member.joinedAt)}
        </span>
      </Td>
    </Tr>
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
