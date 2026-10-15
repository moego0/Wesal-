import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { routing, type AppLocale } from "@/i18n/routing";

/**
 * Request interception: locale routing, then the login gate.
 *
 * Named `proxy.ts`, not `middleware.ts`: Next.js 16 renamed the convention and
 * warns on the old filename. Same behaviour, same signature.
 *
 * The gate checks for the PRESENCE of the session cookie only. It deliberately
 * does not validate the session: this runs before the app, holds no database
 * connection, and a forged cookie would only get an attacker as far as a layout
 * that validates properly and redirects. Cheap rejection of the common case,
 * real validation where it belongs.
 */

/**
 * Duplicated from `@/server/auth/session` on purpose: importing that module
 * would pull the Prisma client and the full env schema into the proxy bundle,
 * where neither belongs.
 */
const SESSION_COOKIE = "wasal_session";

/** Everything else needs a session. Route groups do not appear in the URL. */
const PUBLIC_PATHS = new Set(["/login"]);

const handleI18n = createMiddleware(routing);

function splitLocale(pathname: string): { locale: AppLocale; rest: string } {
  const segments = pathname.split("/");
  const candidate = segments[1];

  const locale = (routing.locales as readonly string[]).includes(candidate)
    ? (candidate as AppLocale)
    : routing.defaultLocale;

  return { locale, rest: `/${segments.slice(2).join("/")}` };
}

export function proxy(request: NextRequest): NextResponse {
  // Locale routing first. An unprefixed path is redirected here, so by the
  // time the gate runs the URL names a locale and the login redirect can
  // preserve it.
  const response = handleI18n(request);
  if (response.status >= 300 && response.status < 400) return response;

  const { locale, rest } = splitLocale(request.nextUrl.pathname);
  if (PUBLIC_PATHS.has(rest)) return response;
  if (request.cookies.has(SESSION_COOKIE)) return response;

  return NextResponse.redirect(new URL(`/${locale}/login`, request.url));
}

export const config = {
  // Skip the API surface and anything that looks like a file: a favicon or a
  // stylesheet has no locale and no session, and redirecting them to a login
  // page breaks the very page that needed them.
  matcher: ["/((?!api|_next|monitoring|.*\\..*).*)"],
};
