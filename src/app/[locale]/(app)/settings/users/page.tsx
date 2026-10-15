import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { PharmacyRole } from "@/generated/prisma/enums";
import { Link } from "@/i18n/navigation";
import { Pill } from "@/components/status";
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
import { hasPermission, requirePermission } from "@/server/auth/rbac";
import {
  countActiveAdmins,
  listPharmacyMemberships,
  type MembershipRow,
} from "@/server/queries/admin";
import { changeMemberRole, inviteMember, setMemberActive } from "@/server/users/actions";

/**
 * The pharmacy's users.
 *
 * Every guard rail this screen presents is enforced twice: once here, as text
 * that explains it, and once in `@/server/users/actions` against the session,
 * which is the copy that decides anything. A select disabled in the UI is a
 * courtesy; the row it belongs to is a POST away from being submitted by hand.
 * The two places they can disagree are called out where they occur.
 *
 * Same shape as the patient list: `params` awaited at the top (the `[locale]`
 * segment is statically known), the `searchParams` promise passed into
 * `<Suspense>`, and `requireSessionUser` called first inside the child so the
 * build never resolves a session.
 */

function one(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const OK_CODES = new Set([
  "MEMBER_INVITED",
  "ROLE_CHANGED",
  "MEMBER_ACTIVATED",
  "MEMBER_DEACTIVATED",
  "NO_CHANGE",
]);

const ERROR_CODES = new Set([
  "NOT_FOUND",
  "SELF_ROLE",
  "SELF_DEACTIVATE",
  "LAST_ADMIN",
  "EMAIL_TAKEN",
  "INVALID_INPUT",
  "FORBIDDEN",
]);

const FIELD_MESSAGE: Record<string, string> = {
  email: "field.email",
  fullName: "field.fullName",
  role: "field.role",
  phoneE164: "field.phoneE164",
  initialPassword: "field.initialPassword",
  membershipId: "field.membershipId",
};

export default async function UsersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "users" });

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} />

      <Suspense fallback={<SkeletonRows rows={6} />}>
        <UsersBody locale={locale} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function UsersBody({
  locale,
  searchParams,
}: {
  locale: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const user = await requireSessionUser(locale);
  requirePermission(user, "user:manage");

  const [t, tNav, tRoles] = await Promise.all([
    getTranslations({ locale, namespace: "users" }),
    getTranslations({ locale, namespace: "users.nav" }),
    getTranslations({ locale, namespace: "roles" }),
  ]);

  const [members, adminCount] = await Promise.all([
    listPharmacyMemberships(user.pharmacyId, user.userId),
    countActiveAdmins(user.pharmacyId),
  ]);

  const ok = one(raw.ok);
  const error = one(raw.error);
  const field = one(raw.field);

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
          <li>
            <span
              aria-current="page"
              className="block rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100"
            >
              {tNav("users")}
            </span>
          </li>
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
        <Notice tone={ok === "NO_CHANGE" ? "info" : "success"} title={t(`ok.${ok}`)} />
      ) : null}

      {error ? (
        <Notice tone="danger" title={t("error.title")}>
          {[
            ERROR_CODES.has(error) ? t(`error.${error}`) : null,
            field ? t(`error.${FIELD_MESSAGE[field] ?? "error.INVALID_INPUT"}`) : null,
          ]
            .filter(Boolean)
            .join(" ")}
        </Notice>
      ) : null}

      {/*
       * The last-admin rule, stated before anyone hits it. It is not a UI guard:
       * `applyMembershipRole` / `applyMembershipActive` re-check it inside the
       * transaction, holding a lock on the pharmacy row, because two demotions
       * submitted at the same moment would otherwise both pass a read-then-write
       * check and leave the pharmacy with no administrator at all.
       */}
      {adminCount === 1 ? (
        <Notice tone="warning" title={t("adminCountWarning")} />
      ) : null}

      <Card>
        <CardHeader
          title={t("invite.title")}
          subtitle={t("invite.hint")}
          actions={
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {t("adminCount", { count: formatNumber(locale, adminCount) })}
            </span>
          }
        />
        <CardBody>
          <form action={inviteMember} className="space-y-4">
            <input type="hidden" name="locale" value={locale} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("invite.fullName")} htmlFor="invite-name" required>
                <input
                  id="invite-name"
                  name="fullName"
                  required
                  maxLength={120}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>

              <Field label={t("invite.email")} htmlFor="invite-email" required>
                <input
                  id="invite-email"
                  name="email"
                  type="email"
                  required
                  dir="ltr"
                  maxLength={200}
                  autoComplete="off"
                  className={inputClass}
                />
              </Field>

              <Field label={t("invite.role")} htmlFor="invite-role" required>
                <select id="invite-role" name="role" required className={selectClass}>
                  {/* `Object.values(PharmacyRole)` — the enum itself, not a
                      hand-written list. A role added to the schema appears here,
                      and `roles.*` already has its label or the coverage test
                      fails; a literal list here would silently omit it. */}
                  {Object.values(PharmacyRole).map((role) => (
                    <option key={role} value={role}>
                      {tRoles(role)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label={t("invite.phone")} htmlFor="invite-phone">
                <input
                  id="invite-phone"
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
                  label={t("invite.password")}
                  htmlFor="invite-password"
                  hint={t("invite.passwordHint")}
                >
                  <input
                    id="invite-password"
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
                {t("invite.submit")}
              </button>
            </FormActions>
          </form>
        </CardBody>
      </Card>

      {members.length === 0 ? (
        <EmptyState title={t("empty")} hint={t("emptyHint")} />
      ) : (
        <>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("subtitle", { count: formatNumber(locale, members.length) })}
          </p>

          <Table>
            <thead>
              <tr>
                <Th>{t("columns.name")}</Th>
                <Th>{t("columns.email")}</Th>
                <Th>{t("columns.role")}</Th>
                <Th>{t("columns.lastLogin")}</Th>
                <Th align="end">{t("columns.actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <MemberRow
                  key={member.membershipId}
                  locale={locale}
                  member={member}
                  /* `adminCount === 1` and this row is an active admin means this
                     row IS the last one. Disabling is only a courtesy — the
                     action refuses it regardless, and the row would have to be
                     read back to say why. */
                  soleAdmin={
                    adminCount === 1 && member.role === "PHARMACY_ADMIN" && member.active
                  }
                />
              ))}
            </tbody>
          </Table>

          <p className="text-xs text-slate-500 dark:text-slate-400">{t("footnote")}</p>
        </>
      )}
    </div>
  );
}

/**
 * One colleague.
 *
 * Two forms, not one: changing a role and ending someone's access are different
 * decisions with different consequences, and a single form with two submit
 * buttons is how someone deactivates a colleague while meaning to promote them.
 * Each carries its own `membershipId`, so a refusal can point at the row.
 *
 * `async` with its own translators rather than a `t` prop — a translator's type
 * comes from the messages it was built for, and narrowing it to
 * `(key: string) => string` to pass it down would discard that.
 */
async function MemberRow({
  locale,
  member,
  soleAdmin,
}: {
  locale: string;
  member: MembershipRow;
  soleAdmin: boolean;
}) {
  const [t, tRoles] = await Promise.all([
    getTranslations({ locale, namespace: "users" }),
    getTranslations({ locale, namespace: "roles" }),
  ]);

  /*
   * The two controls that are withheld are withheld for the caller's OWN row
   * only, because that is the only case the server refuses outright. Everything
   * else is disablable-but-explainable: a role select greyed out with no reason
   * visible reads as a broken page, so `soleAdmin` carries a `title` and the
   * notice above the table states the rule.
   */
  const lockedSelf = member.isSelf;
  const roleDisabled = lockedSelf || soleAdmin;
  const activeToggleDisabled = lockedSelf || soleAdmin;

  return (
    <Tr className={member.active ? undefined : "opacity-60"}>
      <Td>
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-800 dark:text-slate-100">
            {member.fullName}
          </span>
          {member.isSelf ? <Pill tone="info">{t("you")}</Pill> : null}
          {/* The two states are different facts and are shown apart: the
              membership is this pharmacy's access to the person, the account
              status is the person's ability to sign in anywhere. */}
          <Pill tone={member.active ? "good" : "muted"}>{t(member.active ? "active" : "inactive")}</Pill>
          {member.userStatus !== "ACTIVE" ? (
            <span title={t("statusHint")}>
              <Pill tone="warn">{t(`status.${member.userStatus}`)}</Pill>
            </span>
          ) : null}
        </span>
      </Td>

      <Td className="text-xs">
        <span dir="ltr" className="block">
          {member.email}
        </span>
        {member.phoneE164 ? (
          <span dir="ltr" className="block tabular-nums text-slate-500 dark:text-slate-400">
            {member.phoneE164}
          </span>
        ) : null}
      </Td>

      <Td>
        {lockedSelf ? (
          <span className="text-sm text-slate-600 dark:text-slate-300" title={t("youHint")}>
            {tRoles(member.role)}
          </span>
        ) : (
          <form action={changeMemberRole} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="membershipId" value={member.membershipId} />
            <select
              name="role"
              defaultValue={member.role}
              disabled={roleDisabled}
              title={soleAdmin ? t("adminCountWarning") : undefined}
              aria-label={t("roleLabel")}
              className={selectClass}
            >
              {Object.values(PharmacyRole).map((role) => (
                <option key={role} value={role}>
                  {tRoles(role)}
                </option>
              ))}
            </select>
            <input
              name="reason"
              maxLength={200}
              placeholder={t("reason")}
              aria-label={t("reason")}
              className={inputClass}
            />
            <button
              type="submit"
              disabled={roleDisabled}
              className={buttonClass("secondary", "sm")}
            >
              {t("roleSubmit")}
            </button>
          </form>
        )}
      </Td>

      <Td className="text-xs text-slate-500 dark:text-slate-400">
        {member.lastLoginAt ? (
          <span dir="ltr" className="tabular-nums">
            {formatDateTime(locale, member.lastLoginAt)}
          </span>
        ) : (
          t("neverLoggedIn")
        )}
      </Td>

      <Td align="end">
        {lockedSelf ? (
          <span className="text-xs text-slate-500 dark:text-slate-400">{t("youHint")}</span>
        ) : (
          <form action={setMemberActive} className="inline-flex">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="membershipId" value={member.membershipId} />
            {/* The resulting state, not the button that was pressed: the action
                writes and audits exactly this, so a client that flips it is only
                asking for the opposite of what it asked before. */}
            <input type="hidden" name="active" value={member.active ? "false" : "true"} />
            <button
              type="submit"
              disabled={activeToggleDisabled}
              title={
                soleAdmin
                  ? t("adminCountWarning")
                  : member.active
                    ? t("deactivateConfirm")
                    : t("statusHint")
              }
              className={buttonClass(member.active ? "danger" : "secondary", "sm")}
            >
              {t(member.active ? "deactivate" : "reactivate")}
            </button>
          </form>
        )}
      </Td>
    </Tr>
  );
}

/** Latin digits in both locales — a date is scanned, not read aloud. */
function formatDateTime(locale: string, value: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function formatNumber(locale: string, value: number): string {
  return new Intl.NumberFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US").format(value);
}
