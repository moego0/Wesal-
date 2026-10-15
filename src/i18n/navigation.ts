import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/**
 * Locale-aware navigation.
 *
 * Use these everywhere instead of `next/link` and `next/navigation`.
 *
 * `routing` declares `localePrefix: "always"`, so every href needs the locale in
 * front of it. Hand-building `/${locale}/patients` works and is what the first
 * screens did, but it puts the same string concatenation in dozens of places —
 * and the failure mode is silent: a link missing its prefix renders fine from
 * one locale and 404s from the other, which is exactly the kind of bug that
 * survives until a pharmacist who reads English hits it.
 *
 * `Link` here prefixes automatically, so hrefs are written as the route they
 * mean: `<Link href="/patients">`. `redirect` and `useRouter().push` take the
 * same unprefixed form.
 *
 * Note `usePathname` returns the path WITHOUT the locale, which is what makes it
 * usable for marking the active nav item in either language.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
