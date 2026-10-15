import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { hasPermission, type Permission } from "./rbac";
import {
  SESSION_COOKIE_NAME,
  validateSession,
  type SessionContext,
} from "./session";

/**
 * The bridge between the session cookie and the rest of the server code.
 *
 * Everything that needs to know who is asking goes through here, so the cookie
 * name, the validation rules and the redirect-to-login behaviour exist in one
 * place rather than being re-derived per page.
 */

export async function getSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null;
}

/**
 * Memoised per request: the app shell, the page and anything nested all need
 * the current user, and that must be one session lookup per request, not one
 * per component.
 */
export const getSessionUser = cache(async (): Promise<SessionContext | null> => {
  const token = await getSessionToken();
  if (!token) return null;

  return validateSession(token);
});

/**
 * For anything that cannot render without a user. `redirect` throws, so the
 * return type is non-null by construction and callers do not need a second
 * null check that everyone would forget.
 */
export async function requireSessionUser(locale: string): Promise<SessionContext> {
  const user = await getSessionUser();
  if (!user) redirect(`/${locale}/login`);

  return user;
}

/**
 * For route handlers under `/api`, which nothing else guards: `src/proxy.ts`
 * excludes `/api` from its matcher, so a handler that does not check here is
 * open to the internet.
 *
 * Neither existing helper can be used for this. `requireSessionUser` redirects,
 * which answers a `fetch` with a login page and a 200; `requirePermission`
 * throws, which a handler turns into a 500. A caller asking for data is owed a
 * status code that says what actually happened.
 *
 * The permission is a required argument rather than an optional one, so a new
 * handler cannot be written without deciding who is allowed to call it.
 */
export async function requireApiSession(
  permission: Permission,
): Promise<
  { user: SessionContext; response: null } | { user: null; response: Response }
> {
  const user = await getSessionUser();

  if (!user) {
    return {
      user: null,
      response: Response.json({ ok: false, error: "UNAUTHENTICATED" }, { status: 401 }),
    };
  }

  if (!hasPermission(user, permission)) {
    return {
      user: null,
      response: Response.json({ ok: false, error: "FORBIDDEN" }, { status: 403 }),
    };
  }

  return { user, response: null };
}

/** Login only. Setting cookies is restricted to Server Actions and handlers. */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    // "lax" rather than "strict": a strict cookie is dropped on a top-level
    // navigation from an external link, so a pharmacist following a WhatsApp
    // link into the app would land on the login page while already signed in.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete({ name: SESSION_COOKIE_NAME, path: "/" });
}
