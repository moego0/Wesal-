"use server";

import { hasLocale } from "next-intl";
import { redirect } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { requireSessionUser } from "@/server/auth/current-user";
import type { SessionContext } from "@/server/auth/session";
import {
  createPharmacyAccount,
  createPharmacyWithManager,
  switchActivePharmacy,
  type PlatformActor,
} from "./admin";

/**
 * Writes for the platform console: create a pharmacy, create a pharmacy
 * account, and open a pharmacy.
 *
 * Every export is a public endpoint. Authorization comes FIRST — before any
 * field is read — and it is `isSuperAdmin`, not a permission: no pharmacy role
 * can be granted this power, and the platform core re-checks it anyway.
 *
 * Outcomes travel back in the query string, matching every other admin screen
 * in this app: the console is made of Server Components, a bare
 * `<form action={…}>` action cannot return state, and a redirect is the one
 * channel a POST has back to the page.
 */

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The locale a redirect comes back to; validated because it ends up in a URL. */
function safeLocale(value: FormDataEntryValue | null): AppLocale {
  return hasLocale(routing.locales, value) ? value : routing.defaultLocale;
}

/**
 * Session, then the platform-owner check, before anything else.
 *
 * A non-owner is bounced to the dashboard rather than shown a 404: the console
 * is deliberately absent from their navigation, and this action is not a route
 * they can stumble into with a link.
 */
async function platformSession(
  formData: FormData,
): Promise<{ locale: AppLocale; actor: PlatformActor }> {
  const locale = safeLocale(formData.get("locale"));
  const user = await requireSessionUser(locale);

  if (!user.isSuperAdmin) redirect({ href: "/", locale });

  return { locale, actor: toActor(user) };
}

function toActor(user: SessionContext): PlatformActor {
  return { userId: user.userId, sessionId: user.sessionId, isSuperAdmin: user.isSuperAdmin };
}

const PLATFORM = "/platform";

/** Path segments are only ever built from an id that matches this. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Where a pharmacy switcher may land after the session is repointed. */
const SWITCH_TARGETS = new Set(["/", "/patients", "/settings", "/platform"]);

function detailPath(pharmacyId: string | undefined): string {
  return pharmacyId && SAFE_ID.test(pharmacyId) ? `${PLATFORM}/${pharmacyId}` : PLATFORM;
}

export async function createPharmacyAction(formData: FormData): Promise<void> {
  const { locale, actor } = await platformSession(formData);

  const result = await createPharmacyWithManager(actor, {
    name: field(formData, "name"),
    timeZone: field(formData, "timeZone"),
    defaultLocale: field(formData, "defaultLocale"),
    quietHoursStart: field(formData, "quietHoursStart"),
    quietHoursEnd: field(formData, "quietHoursEnd"),
    managerFullName: field(formData, "managerFullName"),
    managerEmail: field(formData, "managerEmail"),
    managerPhoneE164: field(formData, "managerPhoneE164"),
    managerPassword: field(formData, "managerPassword"),
  });

  if (!result.ok) {
    redirect({
      href: {
        pathname: PLATFORM,
        query: { error: result.code, field: result.detail ?? "" },
      },
      locale,
    });
  } else {
    redirect({ href: detailPath(result.data.pharmacyId), locale });
  }
}

export async function createAccountAction(formData: FormData): Promise<void> {
  const { locale, actor } = await platformSession(formData);

  // The raw form value is only used to choose the redirect target after the
  // core has validated it; an unusable value falls back to the list.
  const pharmacyId = field(formData, "pharmacyId");
  const back = detailPath(pharmacyId);

  const result = await createPharmacyAccount(actor, {
    pharmacyId,
    fullName: field(formData, "fullName"),
    email: field(formData, "email"),
    role: field(formData, "role"),
    phoneE164: field(formData, "phoneE164"),
    initialPassword: field(formData, "initialPassword"),
  });

  if (!result.ok) {
    redirect({
      href: {
        pathname: back,
        query: { error: result.code, field: result.detail ?? "" },
      },
      locale,
    });
  }

  redirect({ href: { pathname: back, query: { ok: result.code } }, locale });
}

export async function switchPharmacyAction(formData: FormData): Promise<void> {
  const { locale, actor } = await platformSession(formData);

  const result = await switchActivePharmacy(actor, {
    pharmacyId: field(formData, "pharmacyId"),
  });

  if (!result.ok) {
    redirect({
      href: {
        pathname: PLATFORM,
        query: { error: result.code, field: result.detail ?? "" },
      },
      locale,
    });
  }

  const requested = field(formData, "to");
  const target = requested && SWITCH_TARGETS.has(requested) ? requested : "/";

  redirect({ href: target, locale });
}
