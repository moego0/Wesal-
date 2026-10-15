import { DateTime } from "luxon";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, SkeletonRows } from "@/components/ui";
import { Pill } from "@/components/status";
import { Link } from "@/i18n/navigation";
import { requireSessionUser } from "@/server/auth/current-user";
import { requirePermission } from "@/server/auth/rbac";
import { supportedTimeZones } from "@/server/queries/admin";
import { getMedicationDetail, pickPrimarySchedule } from "@/server/queries/medications";
import {
  MedicationForm,
  type MedicationFormRecord,
  type ScheduleFormRecord,
} from "../../MedicationForm";

/**
 * Edit a medication, change its schedule, or stop it.
 *
 * A schedule change is a clinical event, not an edit, so this screen shows the
 * last few revisions of the schedule it is editing: a pharmacist about to move a
 * dose time can see when it was last moved and why. The history is not a second
 * write path — it is written by the action, inside the transaction that also
 * reconciles the future reminders.
 *
 * `params` carries two non-root segments, so it is awaited inside the
 * `<Suspense>` child and never at the top of the page.
 */

export default function EditMedicationPage({
  params,
}: {
  params: Promise<{ locale: string; id: string; medId: string }>;
}) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<SkeletonRows rows={8} />}>
        <EditMedication params={params} />
      </Suspense>
    </div>
  );
}

async function EditMedication({
  params,
}: {
  params: Promise<{ locale: string; id: string; medId: string }>;
}) {
  const { locale, id, medId } = await params;
  const t = await getTranslations({ locale, namespace: "medications" });

  const user = await requireSessionUser(locale);
  requirePermission(user, "medication:write");
  requirePermission(user, "schedule:write");

  const medication = await getMedicationDetail(user.pharmacyId, medId);

  /*
   * The medication must be this pharmacy's (the query scopes it) AND belong to
   * the patient named in the URL. A hand-edited URL that pairs a real medication
   * with the wrong patient would otherwise render a form whose cancel link, save
   * and audit rows all point at a different chart than the reader believes.
   */
  if (!medication || medication.patient.id !== id) notFound();

  const schedule = pickPrimarySchedule(medication.schedules);

  const record: MedicationFormRecord = {
    id: medication.id,
    name: medication.medicationNameText,
    // The RxCUI the picker stored, if any. It has to be carried into the form
    // and posted back: the update writes what the form sends, so a code left out
    // here would be nulled by the first unrelated edit — a name change, a dose
    // change, a pause.
    medicationCode: medication.medicationCode,
    strength: medication.strengthText ?? "",
    doseAmount: medication.doseAmountText ?? "",
    // One box writes one column: the reader's language. Inventing a translation
    // nobody wrote is worse than a blank second language.
    instructions:
      (locale === "ar" ? medication.instructionsTextAr : medication.instructionsTextEn) ?? "",
    prescriber: medication.prescriberText ?? "",
    indication: medication.indicationText ?? "",
    startedOn: medication.startedOn.toISOString().slice(0, 10),
    status: medication.status,
  };

  const scheduleRecord: ScheduleFormRecord | null = schedule
    ? {
        id: schedule.id,
        mode: schedule.mode,
        timesOfDay: schedule.timesOfDay,
        daysOfWeek: schedule.daysOfWeek,
        timeZone: schedule.timeZone,
        startDate: schedule.startDate.toISOString().slice(0, 10),
        endDate: schedule.endDate ? schedule.endDate.toISOString().slice(0, 10) : null,
        lateWindowMinutes: schedule.lateWindowMinutes,
      }
    : null;

  const today = DateTime.now().setZone(medication.patient.timeZone).toFormat("yyyy-MM-dd");

  return (
    <>
      <Link
        href={`/patients/${medication.patient.id}`}
        className="inline-flex text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
      >
        ← {t("back")}
      </Link>

      <PageHeader
        title={t("editTitle")}
        subtitle={t("patientLabel", { name: medication.patient.fullName })}
      />

      <MedicationForm
        locale={locale}
        patientId={medication.patient.id}
        patientTimeZone={medication.patient.timeZone}
        timeZones={supportedTimeZones(medication.patient.timeZone)}
        today={today}
        medication={record}
        schedule={scheduleRecord}
      />

      <Card>
        <CardHeader title={t("revisions")} />
        {schedule && schedule.revisions.length > 0 ? (
          <CardBody>
            <ul className="space-y-3">
              {schedule.revisions.map((revision) => (
                <li key={revision.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Pill tone="muted">{t("revisionLabel", { n: revision.revision })}</Pill>
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {t(`changeKind.${revision.changeKind}`)}
                  </span>
                  <span className="text-xs tabular-nums text-slate-400">
                    {formatDateTime(locale, revision.changedAtUtc)}
                  </span>
                  {revision.reason ? (
                    <span className="w-full text-sm text-slate-600 dark:text-slate-300">
                      {revision.reason}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardBody>
        ) : (
          <CardBody>
            <EmptyState title={t("noRevisions")} />
          </CardBody>
        )}
      </Card>
    </>
  );
}

function formatDateTime(locale: string, date: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}
