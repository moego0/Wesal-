import { defineRouting } from "next-intl/routing";

/**
 * Locale routing.
 *
 * Arabic first: the pharmacists and assistants this tool is built for read
 * Arabic, and an Egyptian pharmacy's daily work happens in it. English exists
 * for the occasional expatriate staff member, not as a fallback.
 */
export const routing = defineRouting({
  locales: ["ar", "en"],
  defaultLocale: "ar",
  // Always prefix. An unprefixed "/" would mean guessing the reader's language
  // on every entry point, and every shared link would resolve differently
  // depending on who opens it.
  localePrefix: "always",
});

export type AppLocale = (typeof routing.locales)[number];

/** Text direction per locale. Arabic is the reason this app has to care. */
export const localeDirection: Record<AppLocale, "rtl" | "ltr"> = {
  ar: "rtl",
  en: "ltr",
};
