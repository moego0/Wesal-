import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import { PageHeader, SkeletonRows } from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { requirePermission } from "@/server/auth/rbac";
import { supportedTimeZones } from "@/server/queries/admin";
import { RegisterPatientForm } from "../PatientForms";

/**
 * Register a patient, and take their consent, in one pass.
 *
 * `params` holds only the root locale segment, so awaiting it here is safe under
 * `cacheComponents` — the header and the back link prerender, and only the form
 * itself (which needs the session) streams. See `patients/page.tsx`.
 */

const BACK_LINK_CLASSES =
  "inline-flex text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100";

export default async function NewPatientPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "patientForm" });

  return (
    <div className="space-y-6">
      <Link href="/patients" className={BACK_LINK_CLASSES}>
        ← {t("back")}
      </Link>

      <PageHeader title={t("registerTitle")} subtitle={t("registerSubtitle")} />

      <Suspense fallback={<SkeletonRows rows={8} />}>
        <RegisterForm locale={locale} />
      </Suspense>
    </div>
  );
}

async function RegisterForm({ locale }: { locale: string }) {
  const user = await requireSessionUser(locale);

  /*
   * Registering is front-desk work, so an ASSISTANT may do it — and every role
   * that holds `patient:write` also holds `patient:consent`, so the consent
   * fields on this form are never a control the reader is not allowed to use.
   */
  requirePermission(user, "patient:write");

  return (
    <RegisterPatientForm
      locale={locale}
      // The pharmacy's own zone is the default because it is nearly always the
      // patient's, and a wrong one silently moves every future dose.
      defaultTimeZone={user.pharmacyTimeZone}
      timeZones={supportedTimeZones(user.pharmacyTimeZone)}
    />
  );
}
