"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

/**
 * Language switch.
 *
 * A client component because only the browser knows which page the user is
 * actually on: the switcher stays in the persistent shell, and a switch has to
 * keep the reader on the same screen, not drop them at the dashboard.
 *
 * `usePathname` here is next-intl's, which returns the path WITHOUT the locale,
 * so the new locale is a parameter of the navigation rather than a string edit.
 */
export function LocaleSwitcher() {
  const t = useTranslations("localeSwitcher");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function switchTo(next: string) {
    if (next === locale) return;

    // The query string is not part of the pathname, and dropping it would lose
    // a filtered patient list to a language switch.
    const query = window.location.search;

    startTransition(() => router.replace(`${pathname}${query}`, { locale: next }));
  }

  return (
    <select
      value={locale}
      onChange={(event) => switchTo(event.target.value)}
      disabled={pending}
      aria-label={t("label")}
      className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 shadow-xs transition outline-none hover:border-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/30 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300 dark:hover:border-slate-600"
    >
      {routing.locales.map((option) => (
        <option key={option} value={option}>
          {t(option)}
        </option>
      ))}
    </select>
  );
}
