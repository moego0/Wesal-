import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Image from "next/image";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getSessionUser } from "@/server/auth/current-user";
import { LoginForm } from "./LoginForm";

/**
 * Sign-in.
 *
 * The page shell is static; everything that touches the session streams in
 * behind a Suspense boundary. Under Cache Components a `cookies()` read is a
 * dynamic dependency, so it is not allowed to block the whole route from
 * prerendering.
 */

type LoginPageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({
  params,
}: LoginPageProps): Promise<Metadata> {
  const { locale } = await params;
  const [t, tCommon] = await Promise.all([
    getTranslations({ locale, namespace: "auth.login" }),
    getTranslations({ locale, namespace: "common" }),
  ]);

  return { title: `${t("title")} — ${tCommon("appName")}` };
}

export default async function LoginPage({ params }: LoginPageProps) {
  const { locale } = await params;
  const [t, tCommon] = await Promise.all([
    getTranslations({ locale, namespace: "auth.login" }),
    getTranslations({ locale, namespace: "common" }),
  ]);

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12 font-sans">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          {/*
            The full lockup on its own white plate: its navy wordmark is
            unreadable directly on the dark theme's background. Decorative —
            the page subtitle already names the app.
          */}
          <div className="mx-auto mb-4 w-44 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200/60 dark:ring-slate-700">
            <Image
              src="/brand/wisal-logo.png"
              alt=""
              width={640}
              height={665}
              className="h-auto w-full"
              priority
            />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {tCommon("appName")} · {t("subtitle")}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          {/*
            An authenticated visitor who reaches the login URL is sent on to the
            dashboard rather than shown a second sign-in form.
          */}
          <Suspense fallback={<LoginFormSkeleton />}>
            <AlreadySignedIn locale={locale} />
          </Suspense>
        </div>
      </div>
    </main>
  );
}

/**
 * Resolving the session throws a `redirect` for a signed-in visitor — which is
 * why the form lives inside this component and not as its Suspense fallback.
 */
async function AlreadySignedIn({ locale }: { locale: string }) {
  const user = await getSessionUser();
  if (user) redirect(`/${locale}`);

  return <LoginForm locale={locale} />;
}

/** Mirrors the form's box sizes so the card does not jump when it arrives. */
function LoginFormSkeleton() {
  return (
    <div aria-hidden className="space-y-4">
      <div className="h-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
      <div className="h-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
      <div className="h-10 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />
    </div>
  );
}
