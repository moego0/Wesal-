import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import {
  AdherenceValue,
  ALERT_STATUS_TONE,
  CASE_STATUS_TONE,
  DoseOutcome,
  PATIENT_STATUS_TONE,
  Pill,
  SEVERITY_TONE,
  enumKey,
} from "@/components/status";
import {
  Card,
  CardBody,
  CardHeader,
  DefinitionList,
  EmptyState,
  PageHeader,
  Skeleton,
  SkeletonRows,
  Table,
  Td,
  Th,
  Tr,
  buttonClass,
} from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { hasPermission } from "@/server/auth/rbac";
import {
  getPatientAdherence,
  getPatientAlerts,
  getPatientDetail,
  getRecentDoses,
} from "@/server/queries/patients";
import { PatientMedicationRefills } from "@/components/refills/PatientMedicationRefills";

/**
 * One patient's record: who they are, what they are taking, what they answered,
 * and what needs following up.
 *
 * The consent banner is the first thing on the page when consent is missing,
 * before any of the clinical content. It is not decoration — without a consent
 * record the dispatch pre-flight refuses to send, so a patient in that state is
 * silently receiving nothing, and that is the single most important fact about
 * them.
 *
 * `params` is a promise handed straight to the `<Suspense>` child rather than
 * awaited here. Awaiting it at the top is a build ERROR under `cacheComponents`,
 * not a warning: it marks the whole route request-bound and Next refuses to
 * prerender it. Passing the promise down keeps the container and its skeleton
 * static, so the app chrome paints while the record streams.
 */

export default function PatientPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<PatientSkeleton />}>
        <PatientRecord params={params} />
      </Suspense>
    </div>
  );
}

async function PatientRecord({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const t = await getTranslations({ locale, namespace: "patient" });

  const user = await requireSessionUser(locale);
  const tDoses = await getTranslations({ locale, namespace: "doses" });
  const tEnums = await getTranslations({ locale, namespace: "enums" });

  const patient = await getPatientDetail(user.pharmacyId, id);

  /*
   * A patient in another pharmacy is indistinguishable from one that does not
   * exist — the query scopes by pharmacyId, and this is where that shows. Both
   * render the same not-found page.
   *
   * KNOWN TRADEOFF: under Partial Prerendering this returns an HTTP 200 with the
   * 404 UI, not a 404 status. The static shell has already flushed (that is the
   * point of PPR), so the status line is committed before this line runs and
   * cannot be revised. Getting a real 404 would mean `export const instant =
   * false` on this route, which makes it block — trading a skeleton on every
   * valid load to correct a status code on a URL a pharmacist only reaches by
   * editing it by hand. The invalid case is a typo, the valid case is the job.
   *
   * The security property is unaffected either way: a cross-tenant id and a
   * nonexistent id produce byte-identical responses.
   */
  if (!patient) notFound();

  const [doses, adherence, alerts] = await Promise.all([
    getRecentDoses(user.pharmacyId, patient.id, 25),
    getPatientAdherence(user.pharmacyId, patient.id),
    getPatientAlerts(user.pharmacyId, patient.id),
  ]);

  const messagingConsent = patient.consents.find(
    (c) => c.consentType === "WHATSAPP_MESSAGING",
  );
  const hasMessagingConsent = Boolean(messagingConsent?.granted && !messagingConsent.revokedAt);

  const activeMedications = patient.medications.filter((m) => m.status === "ACTIVE");

  /*
   * Both permissions, because a medication and its schedule are written in one
   * transaction by one action. A role holding only `medication:write` would be
   * shown a button that leads to a screen refusing it — the dead link the
   * conventions forbid. An ASSISTANT holds `medication:read` but neither write,
   * so for them these controls do not exist.
   */
  const canManageMedications =
    hasPermission(user, "medication:write") && hasPermission(user, "schedule:write");

  const openCases = patient.cases.filter(
    (c) => c.status === "OPEN" || c.status === "IN_PROGRESS" || c.status === "WAITING_PATIENT",
  );

  return (
    <div className="space-y-6">
      <Link
        href="/patients"
        className="inline-flex text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
      >
        ← {t("back")}
      </Link>

      <PageHeader
        title={patient.fullName}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="tabular-nums" dir="ltr">
              {patient.phoneE164}
            </span>
            <Pill tone={PATIENT_STATUS_TONE[patient.status]}>
              {tEnums(enumKey.patientStatus(patient.status))}
            </Pill>
          </span>
        }
        actions={
          hasPermission(user, "patient:write") ? (
            <Link
              href={`/patients/${patient.id}/edit`}
              className={buttonClass("secondary", "sm")}
            >
              {locale === "ar" ? "تعديل بيانات المريض" : "Edit patient"}
            </Link>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatBlock
          label={t("recentDoses")}
          value={<AdherenceValue rate={adherence} label={tDoses("notScored")} />}
        />
        <StatBlock label={t("medications")} value={activeMedications.length} />
        <StatBlock label={t("cases")} value={openCases.length} />
        <StatBlock label={tEnums("severity.URGENT")} value={alerts.length} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title={t("contact")} />
          <CardBody>
            <DefinitionList
              items={[
                { term: t("phone"), detail: <span dir="ltr">{patient.phoneE164}</span> },
                {
                  term: t("enrolledAt"),
                  detail: formatDate(locale, patient.createdAt),
                },
                ...(patient.externalRef
                  ? [{ term: t("externalRef"), detail: patient.externalRef }]
                  : []),
                ...(patient.careNotes
                  ? [{ term: t("notes"), detail: patient.careNotes }]
                  : []),
              ]}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={t("consent")}
            actions={
              // A record of what was agreed, not a send permission. A missing
              // one is worth stating plainly and is deliberately NOT an alarm:
              // nothing about the reminder schedule depends on it any more.
              hasMessagingConsent ? (
                <Pill tone="good">{t("consentGranted")}</Pill>
              ) : (
                <Pill tone="muted">{t("consentMissing")}</Pill>
              )
            }
          />
          <CardBody>
            {messagingConsent ? (
              <DefinitionList
                items={[
                  {
                    term: t("consentMethod"),
                    detail: tEnums(enumKey.captureMethod(messagingConsent.captureMethod)),
                  },
                  {
                    term: t("consentDate"),
                    detail: messagingConsent.grantedAt
                      ? formatDate(locale, messagingConsent.grantedAt)
                      : "—",
                  },
                ]}
              />
            ) : (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t("consentMissing")}
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      {alerts.length > 0 ? (
        <Card>
          <CardHeader title={t("cases")} />
          <CardBody className="space-y-2">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className="flex flex-wrap items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
              >
                <Pill tone={SEVERITY_TONE[alert.severity]}>
                  {tEnums(enumKey.severity(alert.severity))}
                </Pill>
                {/* Titles are stored per-locale on the alert row itself rather
                    than looked up by ruleKey, so a rule whose wording changes
                    cannot rewrite the history of what a pharmacist was told. */}
                <span>{locale === "ar" ? alert.titleAr : alert.titleEn}</span>
                <Pill tone={ALERT_STATUS_TONE[alert.status]}>
                  {tEnums(enumKey.alertStatus(alert.status))}
                </Pill>
                <span className="text-xs text-slate-400">{formatDate(locale, alert.openedAtUtc)}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title={t("medications")}
          actions={
            canManageMedications ? (
              <Link
                href={`/patients/${patient.id}/medications/new`}
                className={buttonClass("primary", "sm")}
              >
                {t("addMedication")}
              </Link>
            ) : undefined
          }
        />
        <CardBody className="space-y-4">
          {activeMedications.length === 0 ? (
            <EmptyState
              title={t("noMedications")}
              // The default hint tells the reader to add one. For a role that
              // cannot, that is an instruction with no button behind it.
              hint={
                canManageMedications
                  ? t("noMedicationsHint")
                  : t("noMedicationsHintReadOnly")
              }
            />
          ) : (
            activeMedications.map((medication) => (
              <div
                key={medication.id}
                className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium text-slate-900 dark:text-slate-50">
                    {medication.medicationNameText}
                    {medication.doseAmountText ? (
                      <span className="ms-2 text-sm font-normal text-slate-500 dark:text-slate-400">
                        {medication.doseAmountText}
                      </span>
                    ) : null}
                  </p>

                  {canManageMedications ? (
                    <Link
                      href={`/patients/${patient.id}/medications/${medication.id}/edit`}
                      className={buttonClass("ghost", "sm")}
                    >
                      {t("editMedication")}
                    </Link>
                  ) : null}
                </div>

                {(() => {
                  const instructions =
                    locale === "ar"
                      ? medication.instructionsTextAr
                      : medication.instructionsTextEn;
                  return instructions ? (
                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                      {instructions}
                    </p>
                  ) : null;
                })()}

                <div className="mt-3 space-y-1.5">
                  {medication.schedules.map((schedule) => (
                    <div
                      key={schedule.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600 dark:text-slate-300"
                    >
                      <span className="font-medium tabular-nums" dir="ltr">
                        {schedule.timesOfDay.join(" · ")}
                      </span>
                      <span className="text-xs text-slate-400">
                        {t("scheduleFrom")} {formatDate(locale, schedule.startDate)}
                        {" · "}
                        {schedule.endDate
                          ? `${t("scheduleUntil")} ${formatDate(locale, schedule.endDate)}`
                          : t("scheduleOngoing")}
                      </span>
                      <span className="text-xs text-slate-400">
                        {t("scheduleRevision", { n: schedule.revision })}
                      </span>
                      <Pill tone={schedule.status === "ACTIVE" ? "good" : "muted"}>
                        {schedule.status}
                      </Pill>
                    </div>
                  ))}
                </div>

                <PatientMedicationRefills
                  medication={medication as any}
                  patient={{
                    id: patient.id,
                    fullName: patient.fullName,
                    phoneE164: patient.phoneE164,
                  }}
                  canManage={canManageMedications}
                  locale={locale}
                />
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("recentDoses")} />
        {doses.length === 0 ? (
          <CardBody>
            <EmptyState title={t("noDoses")} hint={t("noDosesHint")} />
          </CardBody>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{tDoses("columns.date")}</Th>
                <Th>{tDoses("columns.time")}</Th>
                <Th>{tDoses("columns.medication")}</Th>
                <Th>{tDoses("columns.delivery")}</Th>
                <Th>{tDoses("columns.receivedAt")}</Th>
              </tr>
            </thead>
            <tbody>
              {doses.map((dose) => {
                const first = dose.responses[0];
                return (
                  <Tr key={dose.id}>
                    <Td className="tabular-nums">{dose.doseLocalDate.toISOString().slice(0, 10)}</Td>
                    <Td className="tabular-nums">
                      <span dir="ltr">{dose.doseLocalTime}</span>
                    </Td>
                    <Td>
                      {dose.medication.medicationNameText}
                      {!dose.countedForAdherence ? (
                        <span className="ms-1.5 text-xs text-slate-400">{tDoses("notScored")}</span>
                      ) : null}
                      {dose.snoozeCount > 0 ? (
                        <span className="ms-1.5 text-xs text-slate-400">
                          {tDoses("snoozed", { count: dose.snoozeCount })}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      <DoseOutcome
                        delivery={dose.deliveryState}
                        deliveryLabel={tEnums(enumKey.delivery(dose.deliveryState))}
                        response={dose.responseState}
                        responseLabel={
                          first?.freeText
                            ? first.freeText
                            : tEnums(enumKey.response(dose.responseState))
                        }
                      />
                    </Td>
                    <Td className="tabular-nums text-xs text-slate-500">
                      {first ? formatDateTime(locale, first.receivedAtUtc) : "—"}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title={t("cases")} />
        {patient.cases.length === 0 ? (
          <CardBody>
            <EmptyState title={t("noCases")} />
          </CardBody>
        ) : (
          <CardBody className="space-y-3">
            {patient.cases.map((kase) => (
              <div
                key={kase.id}
                className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone={CASE_STATUS_TONE[kase.status]}>
                    {tEnums(enumKey.caseStatus(kase.status))}
                  </Pill>
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    {tEnums(enumKey.caseOrigin(kase.origin))}
                  </span>
                  <span className="text-xs text-slate-400">{formatDate(locale, kase.openedAtUtc)}</span>
                </div>
                <p className="mt-1.5 text-sm font-medium text-slate-800 dark:text-slate-100">
                  {locale === "ar" ? kase.titleAr : kase.titleEn}
                </p>
                {kase.summary ? (
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{kase.summary}</p>
                ) : null}
                {kase.interventions.length > 0 ? (
                  <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    {kase.interventions[0].notes ?? kase.interventions[0].outcome}
                  </p>
                ) : (
                  <Link
                    href={`/follow-ups/${kase.id}`}
                    className={`${buttonClass("secondary", "sm")} mt-2`}
                  >
                    {t("cases")}
                  </Link>
                )}
              </div>
            ))}
          </CardBody>
        )}
      </Card>
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">
        {value}
      </p>
    </div>
  );
}

function formatDate(locale: string, date: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "medium",
  }).format(date);
}

function formatDateTime(locale: string, date: Date): string {
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function PatientSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <SkeletonRows rows={4} />
    </div>
  );
}
