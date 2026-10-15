import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import { PageHeader, SkeletonRows } from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { requirePermission } from "@/server/auth/rbac";
import { supportedTimeZones } from "@/server/queries/admin";
import { getPatientDetail } from "@/server/queries/patients";
import { EditPatientForm, type PatientFormRecord } from "../../PatientForms";

/**
 * Edit one patient's record, and append a consent record when consent changed.
 *
 * `params` carries an `[id]`, so it is handed to the `<Suspense>` child and
 * awaited there — awaiting it at the top would bind the whole route and fail the
 * build under `cacheComponents`. Same shape as `patients/[id]/page.tsx`.
 */

export default function EditPatientPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<SkeletonRows rows={8} />}>
        <EditPatient params={params} />
      </Suspense>
    </div>
  );
}

async function EditPatient({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const t = await getTranslations({ locale, namespace: "patientForm" });

  const user = await requireSessionUser(locale);

  /*
   * Only PHARMACY_ADMIN, PHARMACIST and ASSISTANT hold `patient:write`, and all
   * three hold `patient:consent` — so the consent fields below are never a
   * control the reader may not use, and a save cannot be refused for touching
   * them by a role that was allowed to open this screen.
   */
  requirePermission(user, "patient:write");

  const patient = await getPatientDetail(user.pharmacyId, id);

  // Another pharmacy's patient is indistinguishable from one that does not
  // exist: the query scopes by pharmacyId and both land here.
  if (!patient) notFound();

  const record: PatientFormRecord = {
    id: patient.id,
    fullName: patient.fullName,
    // The number as it was typed, so re-normalising it on save reproduces the
    // same E.164 and an edit to some other field does not rewrite it.
    phone: patient.phoneRaw ?? patient.phoneE164,
    phoneE164: patient.phoneE164,
    dateOfBirth: patient.dateOfBirth ? patient.dateOfBirth.toISOString().slice(0, 10) : null,
    gender: patient.gender ?? "UNSPECIFIED",
    preferredLocale: patient.preferredLocale,
    timeZone: patient.timeZone,
    careNotes: patient.careNotes,
    externalRef: patient.externalRef,
    status: patient.status,
  };

  return (
    <>
      <Link
        href={`/patients/${patient.id}`}
        className="inline-flex text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
      >
        ← {t("back")}
      </Link>

      <PageHeader title={t("editTitle")} subtitle={t("editSubtitle")} />

      <EditPatientForm
        locale={locale}
        patient={record}
        consent={latestWhatsappConsent(patient.consents)}
        timeZones={supportedTimeZones(patient.timeZone)}
      />
    </>
  );
}

/**
 * The consent row the update action will compare the form against.
 *
 * Deliberately the same ordering the action and the dispatch pre-flight use —
 * `grantedAt desc` with a `createdAt desc` tiebreak — rather than "the newest
 * row". Prefilling a value the action does not consider current would make every
 * unrelated save look like a consent change, and append a consent record each
 * time; agreement between the two is what keeps the diff honest.
 *
 * `grantedAt` is null on a refusal, and Postgres sorts NULLs first under DESC,
 * so a refusal is the current record until a newer GRANTED row exists. That is
 * the convention the action applies too, so the prefilled checkbox matches the
 * row a save would compare against. Nothing reads this at send time any more —
 * consent is evidence, and `src/server/consent.ts` says why.
 */
function latestWhatsappConsent(
  consents: ReadonlyArray<{
    consentType: string;
    granted: boolean;
    grantedAt: Date | null;
    createdAt: Date;
    captureMethod: string;
    evidenceRef: string | null;
    notes: string | null;
  }>,
) {
  const rows = consents.filter((row) => row.consentType === "WHATSAPP_MESSAGING");
  if (rows.length === 0) return null;

  // The same sort Postgres performs for the action's `orderBy`.
  const [latest] = [...rows].sort((a, b) => {
    const aRefused = a.grantedAt === null;
    const bRefused = b.grantedAt === null;
    if (aRefused !== bRefused) return aRefused ? -1 : 1;
    if (a.grantedAt && b.grantedAt && a.grantedAt.getTime() !== b.grantedAt.getTime()) {
      return b.grantedAt.getTime() - a.grantedAt.getTime();
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return {
    granted: latest.granted,
    captureMethod: latest.captureMethod,
    evidenceRef: latest.evidenceRef,
    notes: latest.notes,
  };
}
