import { DateTime } from "luxon";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import { PageHeader, SkeletonRows } from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { requirePermission } from "@/server/auth/rbac";
import { supportedTimeZones } from "@/server/queries/admin";
import { getPatientForMedication } from "@/server/queries/medications";
import { MedicationForm } from "../MedicationForm";

/**
 * Add a medication and its schedule to one patient.
 *
 * `params` carries an `[id]`, so it is awaited inside the `<Suspense>` child and
 * never at the top of the page: an awaited non-root segment binds the route and
 * `next build` rejects it under `cacheComponents`.
 */

export default function AddMedicationPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<SkeletonRows rows={8} />}>
        <AddMedication params={params} />
      </Suspense>
    </div>
  );
}

async function AddMedication({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const t = await getTranslations({ locale, namespace: "medications" });

  const user = await requireSessionUser(locale);

  // Both, because the action writes a medication and a schedule in one
  // transaction and a role that may do neither must not reach this screen.
  requirePermission(user, "medication:write");
  requirePermission(user, "schedule:write");

  const patient = await getPatientForMedication(user.pharmacyId, id);

  // Another pharmacy's patient is indistinguishable from one that does not
  // exist — the query scopes by pharmacyId and both render the same page.
  if (!patient) notFound();

  /*
   * Today in the PATIENT's zone, not the server's. A schedule saved at 11pm in
   * Cairo with a UTC start date would begin a day early, and the first dose is
   * the one that matters most.
   */
  const today = DateTime.now().setZone(patient.timeZone).toFormat("yyyy-MM-dd");

  return (
    <>
      <Link
        href={`/patients/${patient.id}`}
        className="inline-flex text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
      >
        ← {t("back")}
      </Link>

      <PageHeader
        title={t("addTitle")}
        subtitle={t("patientLabel", { name: patient.fullName })}
      />

      <MedicationForm
        locale={locale}
        patientId={patient.id}
        patientTimeZone={patient.timeZone}
        timeZones={supportedTimeZones(patient.timeZone)}
        today={today}
        medication={null}
        schedule={null}
      />
    </>
  );
}
