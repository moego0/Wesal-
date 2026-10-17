import { getTranslations } from "next-intl/server";
import Image from "next/image";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import { isAdminEnabled } from "@/server/admin/flag";
import { logoutAction } from "@/server/auth/actions";
import { requireSessionUser } from "@/server/auth/current-user";
import { hasPermission, type Permission } from "@/server/auth/rbac";
import { LocaleSwitcher } from "./LocaleSwitcher";

/**
 * The authenticated shell: every page under it is behind a session.
 *
 * The session is resolved in the streaming part of the page, not here — a
 * `cookies()` read would otherwise hold up the whole route. Anything that only
 * needs the locale (the brand, the page frame) still renders immediately.
 */

const NAV_ITEMS: ReadonlyArray<{
  key: "dashboard" | "patients" | "followUps" | "messages" | "reports" | "settings" | "operations";
  href: string;
  permission?: Permission;
  /** Also requires `ENABLE_ADMIN`. See the filter in `SessionBar`. */
  adminOnly?: boolean;
}> = [
  { key: "dashboard", href: "/" },
  { key: "patients", href: "/patients" },
  // No permission guard: every role holds `followup:read`, so there is nobody
  // who can see this link and be refused by the page behind it.
  { key: "followUps", href: "/follow-ups" },
  // The delivery log and the reports are both `report:read`. An ASSISTANT does
  // not hold it — enrollment work, not analytics — so without the guard they
  // would be shown two links that dead-end on a permission error.
  { key: "messages", href: "/messages", permission: "report:read" },
  { key: "reports", href: "/reports", permission: "report:read" },
  // Only a pharmacy admin can open Settings, so only a pharmacy admin is shown
  // the way in. A link to a page that will refuse them is a dead end dressed up
  // as navigation.
  { key: "settings", href: "/settings", permission: "settings:manage" },
  // Operations is a superset of the same audience — `settings:manage` is held
  // only by a pharmacy admin — but it is ALSO behind `ENABLE_ADMIN`, so it needs
  // the flag too. A pharmacist admin on a deployment that never turned the
  // console on would otherwise be shown a link that 404s.
  { key: "operations", href: "/admin", permission: "settings:manage", adminOnly: true },
];

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "common" });

  return (
    <div className="flex min-h-full flex-1 flex-col bg-slate-50 font-sans dark:bg-slate-950">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur-sm dark:border-slate-800 dark:bg-slate-900/90">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:outline-none"
          >
            <span className="grid h-8 place-items-center rounded-lg bg-white px-1.5 dark:ring-1 dark:ring-slate-700">
              {/*
                The logo's navy would disappear into the dark header, so the
                mark keeps its own white tile in both themes. Decorative: the
                pharmacy name beside it is the accessible label.
              */}
              <Image
                src="/brand/wisal-mark-wide.png"
                alt=""
                width={480}
                height={268}
                className="h-6 w-auto"
                priority
              />
            </span>
            <span className="text-base font-semibold text-slate-900 dark:text-slate-50">
              {t("appName")}
            </span>
          </Link>

          <Suspense fallback={<SessionBarSkeleton />}>
            <SessionBar locale={locale} />
          </Suspense>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}

/**
 * Everything that needs to know who is asking: the nav (a role decides what
 * exists for them), the pharmacy the data belongs to, the user, and the way
 * out.
 *
 * `requireSessionUser` redirects to the login page when the cookie is missing,
 * expired, revoked, or the user has lost their last membership — so this
 * component has a user by the time it renders.
 *
 * `ENABLE_ADMIN` is read here, and specifically NOT in `AppLayout` above. This
 * component is inside `<Suspense>` and already request-scoped, so the flag is
 * resolved per request; `AppLayout` renders the static shell, into which a flag
 * read under `cacheComponents` could be baked at build time — after which
 * turning the console on would require a rebuild rather than a restart.
 */
async function SessionBar({ locale }: { locale: string }) {
  const user = await requireSessionUser(locale);
  const [tNav, tRoles, tLogout] = await Promise.all([
    getTranslations({ locale, namespace: "nav" }),
    getTranslations({ locale, namespace: "roles" }),
    getTranslations({ locale, namespace: "auth" }),
  ]);

  const items = NAV_ITEMS.filter(
    (item) =>
      (item.permission === undefined || hasPermission(user, item.permission)) &&
      (item.adminOnly !== true || isAdminEnabled()),
  );

  return (
    <>
      <nav aria-label={tNav("label")} className="order-last w-full lg:order-none lg:w-auto">
        <ul className="flex flex-wrap items-center gap-1">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="block rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:outline-none dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              >
                {tNav(item.key)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="ms-auto flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* Which pharmacy's data this is. A pharmacist covering a shift at a
            second branch needs to see that at a glance, not infer it. */}
        <span className="hidden items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600 sm:inline-flex dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
          <span aria-hidden className="size-1.5 rounded-full bg-teal-500" />
          {user.pharmacyName}
        </span>

        <span className="text-sm">
          <span className="font-medium text-slate-900 dark:text-slate-100">
            {user.fullName}
          </span>
          <span className="text-slate-500 dark:text-slate-400"> · {tRoles(user.role)}</span>
        </span>

        <LocaleSwitcher />

        <form action={logoutAction}>
          <input type="hidden" name="locale" value={locale} />
          <button
            type="submit"
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:outline-none dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800"
          >
            {tLogout("logout")}
          </button>
        </form>
      </div>
    </>
  );
}

/**
 * Holds the session bar's height while it resolves, so the page below does not
 * jump when the real one arrives.
 */
function SessionBarSkeleton() {
  return (
    <div aria-hidden className="ms-auto flex items-center gap-3">
      <div className="hidden h-6 w-28 animate-pulse rounded-full bg-slate-100 sm:block dark:bg-slate-800" />
      <div className="h-6 w-24 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
      <div className="h-6 w-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
    </div>
  );
}
