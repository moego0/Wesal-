"use server";

import { hasLocale } from "next-intl";
import { redirect } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { requireSessionUser } from "@/server/auth/current-user";
import { PermissionDeniedError, requirePermission } from "@/server/auth/rbac";
import type { SessionContext } from "@/server/auth/session";
import { findRule } from "@/server/rules/catalog";
import { dryRunRule } from "@/server/rules/evaluator";
import { DRY_RUN_SAMPLE, applyPharmacyProfile, applyRuleParams } from "@/server/queries/admin";

/**
 * Writes for the pharmacy settings screen.
 *
 * Both exports are public endpoints. Hiding a form on a page protects nothing:
 * anyone with a session can POST here directly, with any payload, so each one
 * re-derives the session and re-checks the permission before it reads a field.
 *
 * ## Why these redirect instead of returning state
 *
 * The conventional shape here would be `(prevState, formData) => State` driven by
 * `useActionState`, which is what `LoginForm.tsx` and the follow-up screen do.
 * It needs a client component, and this screen is built entirely from Server
 * Components — so the two actions below take the plain `(formData) => void` form
 * that a `<form action={…}>` calls directly, and they report their outcome the
 * way HTTP already does: a POST that redirects to a GET carrying a result code
 * in the query string, which the page renders as a notice.
 *
 * The alternative — returning a state object — would have been silently
 * impossible: React calls a bare form action with ONE argument, so a two-argument
 * signature would receive the `FormData` as `prevState` and `undefined` as
 * `formData`, and every submission would fail validation with no error anywhere.
 *
 * Redirect AFTER the transaction, never inside it. `redirect()` works by
 * throwing, and a throw inside `$transaction` rolls the transaction back — the
 * change would be silently undone by the very call that announced it.
 */

/**
 * FormData values are `string | File | null`, and an untouched optional field
 * arrives as `""` rather than as absent. Folding blank to `undefined` once, here,
 * is what lets the schemas below declare optional fields as `.optional()`.
 */
function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The locale a redirect comes back to. It travels in the form because an action
 * cannot read the URL it was posted from, and it is validated rather than
 * trusted — it ends up in a redirect target.
 */
function safeLocale(value: FormDataEntryValue | null): AppLocale {
  return hasLocale(routing.locales, value) ? value : routing.defaultLocale;
}

/**
 * Session, then permission, before any field is read.
 *
 * A refusal is bounced to the dashboard rather than back to `/settings`. The
 * settings PAGE refuses to render for a caller without `settings:manage`, so
 * redirecting there would answer a forged POST with an error page and tell the
 * caller nothing they can act on; the dashboard renders for every role, and the
 * point of the bounce is simply that nothing was written.
 */
async function settingsManager(
  formData: FormData,
): Promise<{ locale: AppLocale; user: SessionContext }> {
  const locale = safeLocale(formData.get("locale"));
  const user = await requireSessionUser(locale);

  try {
    requirePermission(user, "settings:manage");
  } catch (error) {
    if (error instanceof PermissionDeniedError) redirect({ href: "/", locale });
    throw error;
  }

  return { locale, user };
}

const SETTINGS = "/settings";

/** How a rule parameter arrives from the form: `param.<name>`. */
const PARAM_PREFIX = "param.";

/**
 * The pharmacy profile: name, time zone, default language, quiet hours.
 *
 * Scoped by the session's `pharmacyId`, never by anything in the form — the form
 * has no field for it, and `applyPharmacyProfile` updates `where: { id:
 * actor.pharmacyId }`. There is nothing to tamper with, which is a stronger
 * position than validating an id that should not have been sent.
 */
export async function updatePharmacyProfile(formData: FormData): Promise<void> {
  const { locale, user } = await settingsManager(formData);

  const is24HoursRaw = formData.get("is24Hours");
  const is24Hours = is24HoursRaw === "true" || is24HoursRaw === "on" || is24HoursRaw === "1";

  const result = await applyPharmacyProfile(
    { pharmacyId: user.pharmacyId, userId: user.userId },
    {
      name: field(formData, "name"),
      timeZone: field(formData, "timeZone"),
      defaultLocale: field(formData, "defaultLocale"),
      quietHoursStart: field(formData, "quietHoursStart"),
      quietHoursEnd: field(formData, "quietHoursEnd"),
      is24Hours,
      operatingHoursStart: field(formData, "operatingHoursStart"),
      operatingHoursEnd: field(formData, "operatingHoursEnd"),
      refillLeadDays: field(formData, "refillLeadDays"),
      refillUrgentDays: field(formData, "refillUrgentDays"),
      reason: field(formData, "reason"),
    },
  );

  if (!result.ok) {
    return redirect({
      href: {
        pathname: SETTINGS,
        query: { error: result.code, field: result.detail ?? "" },
      },
      locale,
    });
  }

  redirect({ href: { pathname: SETTINGS, query: { ok: result.code } }, locale });
}

/**
 * Save one rule's thresholds.
 *
 * The parameters are collected by prefix rather than by a hand-written list, so
 * adding a parameter to the catalogue and the form is enough — the action does
 * not have to be edited, and cannot be edited to forget one. `applyRuleParams`
 * then narrows the collected values to the parameters that rule actually
 * resolves to, so a field smuggled in under a prefix that the rule never uses is
 * dropped rather than stored.
 *
 * The dry run afterwards is not a preview: it is the same helper the sweeps use,
 * run against the parameters that were just written, answering "how many alerts
 * would the engine have raised under this setting on the data as it stands". A
 * threshold that silences a rule for everyone is a legitimate setting and a
 * dangerous accident, and this is the number that tells them apart. It is run
 * OUTSIDE the transaction so a slow scan does not hold row locks, and its failure
 * is swallowed — the change is already committed, and reporting a failed
 * projection as a failed save would be a lie about what the database holds.
 */
export async function saveRuleSettings(formData: FormData): Promise<void> {
  const { locale, user } = await settingsManager(formData);

  const rawKey = field(formData, "ruleKey");
  const spec = rawKey ? findRule(rawKey) : undefined;

  if (!spec) {
    // `return` rather than a bare call: `redirect` is destructured from
    // `createNavigation`, and TypeScript only treats a call as terminating
    // control flow when it can see the `never` on the declaration — so this
    // return is what lets `spec` be narrowed below.
    return redirect({
      href: { pathname: SETTINGS, query: { error: "INVALID_INPUT", field: "ruleKey" } },
      locale,
    });
  }

  const params: Record<string, unknown> = {};
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string" && name.startsWith(PARAM_PREFIX)) {
      params[name.slice(PARAM_PREFIX.length)] = value;
    }
  }

  const result = await applyRuleParams(
    { pharmacyId: user.pharmacyId, userId: user.userId },
    { ruleKey: spec.key, params, reason: field(formData, "reason") },
  );

  if (!result.ok) {
    return redirect({
      href: {
        pathname: SETTINGS,
        query: { rule: spec.key, error: result.code, field: result.detail ?? "" },
      },
      locale,
    });
  }

  let alerts: number | null = null;
  let patients: number | null = null;

  try {
    const sample = await dryRunRule(
      user.pharmacyId,
      result.data.ruleKey,
      result.data.params,
      new Date(),
      DRY_RUN_SAMPLE,
    );
    // One match is one alert: `dryRunRule` deduplicates per patient and
    // medication exactly as the sweep's dedupe key does.
    alerts = sample.matchesPerPatient.length;
    patients = sample.patientsMatching;
  } catch {
    alerts = null;
    patients = null;
  }

  redirect({
    href: {
      pathname: SETTINGS,
      query: {
        rule: result.data.ruleKey,
        ok: result.code,
        ...(alerts === null ? {} : { alerts: String(alerts), patients: String(patients) }),
      },
    },
    locale,
  });
}
