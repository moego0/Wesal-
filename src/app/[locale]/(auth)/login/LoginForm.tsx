"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { loginAction, type LoginState } from "@/server/auth/actions";

/**
 * The sign-in form.
 *
 * A plain `<form action={…}>` around a Server Action, so it submits — and
 * reports a failure — without JavaScript. `useActionState` only upgrades it
 * with a pending state and an inline error.
 */

const FIELD_CLASSES =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-xs transition outline-none placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/30 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-500";

const LABEL_CLASSES = "block text-sm font-medium text-slate-700 dark:text-slate-300";

export function LoginForm({ locale }: { locale: string }) {
  const t = useTranslations("auth.login");
  const [state, formAction] = useActionState(loginAction, {
    error: null,
  } satisfies LoginState);

  return (
    <form action={formAction} className="space-y-4">
      {/* The action cannot read the URL it was posted from, so the locale it
          should bounce back to travels with the form. */}
      <input type="hidden" name="locale" value={locale} />

      <div className="space-y-1.5">
        <label htmlFor="email" className={LABEL_CLASSES}>
          {t("email")}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          // An email address is Latin text: left-aligned in both languages, so
          // an RTL reader is not typing into a right-aligned box that shifts
          // with every keystroke.
          dir="ltr"
          aria-describedby={state.error ? "login-error" : undefined}
          className={FIELD_CLASSES}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="password" className={LABEL_CLASSES}>
          {t("password")}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          dir="ltr"
          aria-describedby={state.error ? "login-error" : undefined}
          className={FIELD_CLASSES}
        />
      </div>

      {/* One message for every rejection — wrong password, unknown address,
          suspended account, no membership. The server does not say which, and
          neither does the UI: any distinction here is free intelligence for
          whoever is guessing. */}
      {state.error ? (
        <p
          id="login-error"
          role="alert"
          className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300"
        >
          {t("failed")}
        </p>
      ) : null}

      <SubmitButton label={t("submit")} pendingLabel={t("pending")} />
    </form>
  );
}

/**
 * `useFormStatus` has to be read from inside the form, so the button is its own
 * component. It also keeps the pending label rendered with the plain HTML the
 * fallback (no-JS) path already has.
 */
function SubmitButton({
  label,
  pendingLabel,
}: {
  label: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-60 dark:focus-visible:ring-offset-slate-900"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
