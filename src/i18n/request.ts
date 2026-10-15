import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { locale as requestLocaleParam } from "next/root-params";
import { routing, type AppLocale } from "./routing";

/**
 * Catalogs are listed explicitly instead of importing `../messages/${locale}.json`:
 * a computed specifier is opaque to the bundler, which would either fail at
 * build time or ship every catalog into every chunk.
 */
const catalogs: Record<AppLocale, () => Promise<{ default: Record<string, unknown> }>> = {
  ar: () => import("../messages/ar.json"),
  en: () => import("../messages/en.json"),
};

export default getRequestConfig(async () => {
  // Read the [locale] root parameter rather than the deprecated `requestLocale`
  // argument. The deprecated path reads `headers()`, which would opt every page
  // that translates anything into dynamic rendering; the root parameter is
  // available during prerendering, so the shell stays static per locale.
  const requested = await requestLocaleParam();
  const locale: AppLocale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return { locale, messages: (await catalogs[locale]()).default };
});
