import { DateTime } from "luxon";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { Link } from "@/i18n/navigation";
import { PRIORITY_TONE, Pill, enumKey } from "@/components/status";
import { EmptyState, PageHeader, SkeletonRows, Table, Td, Th, Tr } from "@/components/ui";
import { requireSessionUser } from "@/server/auth/current-user";
import { requirePermission } from "@/server/auth/rbac";
import {
  getFollowUpProblemCases,
  getFollowUpMissedCases,
  getClinicalInterventionsLog,
} from "@/server/queries/followups";
import { prisma } from "@/server/db";
import { QuickResolveModal } from "@/components/followups/QuickResolveModal";
import { ResendReminderButton } from "@/components/followups/ResendReminderButton";
import { NewInterventionModal } from "@/components/followups/NewInterventionModal";

export default async function FollowUpsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { locale } = await params;
  const { tab = "problems" } = await searchParams;
  const isAr = locale === "ar";

  const user = await requireSessionUser(locale);
  requirePermission(user, "followup:read");

  const [problemCases, missedCases, interventions, patientsList] = await Promise.all([
    getFollowUpProblemCases(user.pharmacyId, 100),
    getFollowUpMissedCases(user.pharmacyId, 100),
    getClinicalInterventionsLog(user.pharmacyId, 100),
    prisma.patient.findMany({
      where: { pharmacyId: user.pharmacyId, status: "ACTIVE" },
      orderBy: { fullName: "asc" },
      take: 150,
      select: { id: true, fullName: true, phoneE164: true },
    }),
  ]);

  const activeTab = tab === "missed" ? "missed" : tab === "interventions" ? "interventions" : "problems";

  const title =
    activeTab === "problems"
      ? isAr ? "المريض لديه مشكلة تتعلق بالدواء" : "Medication Problem Follow-up"
      : activeTab === "missed"
      ? isAr ? "المريض نسي تناول الدواء / لا يوجد رد" : "Missed Doses & No Response"
      : isAr ? "سجل التدخلات السريرية (Clinical Intervention Log)" : "Clinical Intervention Log";

  const subtitle =
    activeTab === "problems"
      ? isAr ? "متابعة الحالات والأعراض الجانبية والاستفسارات المبلغ عنها من المرضى وحلها مباشرة" : "Manage and resolve patient-reported medication issues"
      : activeTab === "missed"
      ? isAr ? "متابعة الجرعات الفائتة والمرضى الذين لم يستجيبوا للتذكير وإعادة المراسلة الفورية" : "Track missed doses and send immediate follow-up reminders"
      : isAr ? "السجل الكامل للتدخلات الصيدلانية، التعامل مع الأعراض الجانبية، التحويل للأطباء، والتداخلات الدوائية" : "Comprehensive log of pharmacist clinical interventions and consultations";

  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          activeTab === "interventions" ? (
            <NewInterventionModal patients={patientsList} locale={locale} />
          ) : null
        }
      />

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-200 dark:border-slate-800">
        <Link
          href="/follow-ups?tab=problems"
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition ${
            activeTab === "problems"
              ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300"
              : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          <span>⚠️ {isAr ? "المريض لديه مشكلة تتعلق بالدواء" : "Medication Problem"}</span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
            {problemCases.length}
          </span>
        </Link>

        <Link
          href="/follow-ups?tab=missed"
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition ${
            activeTab === "missed"
              ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300"
              : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          <span>⏰ {isAr ? "المريض نسي تناول الدواء / لا يوجد رد" : "Missed / No Response"}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {missedCases.length}
          </span>
        </Link>

        <Link
          href="/follow-ups?tab=interventions"
          className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-semibold transition ${
            activeTab === "interventions"
              ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300"
              : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          <span>📋 {isAr ? "سجل التدخلات السريرية (Clinical Intervention Log)" : "Clinical Intervention Log"}</span>
          <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-bold text-teal-800 dark:bg-teal-950/60 dark:text-teal-300">
            {interventions.length}
          </span>
        </Link>
      </div>

      {/* Tab 1: Problems */}
      {activeTab === "problems" && (
        <Suspense fallback={<SkeletonRows rows={6} />}>
          {problemCases.length === 0 ? (
            <EmptyState
              title={isAr ? "لا توجد مشاكل دوائية مفتوحة حالياً" : "No open medication problems"}
              hint={isAr ? "ممتاز! لم يبلغ أي مريض عن مشكلة أو عرض جانبي يتطلب المتابعة." : "Great! No patients have reported medication issues."}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-12 text-center">#</Th>
                  <Th>{isAr ? "المريض" : "Patient"}</Th>
                  <Th>{isAr ? "الدواء المعني" : "Medication"}</Th>
                  <Th>{isAr ? "تفاصيل المشكلة / العرض" : "Problem Details"}</Th>
                  <Th>{isAr ? "الأولوية" : "Priority"}</Th>
                  <Th>{isAr ? "الصيدلي المتابع / المسؤول" : "Assigned Pharmacist"}</Th>
                  <Th align="end">{isAr ? "تاريخ الإبلاغ" : "Reported At"}</Th>
                  <Th align="center">{isAr ? "الإجراء" : "Action"}</Th>
                </tr>
              </thead>
              <tbody>
                {problemCases.map((row, index) => (
                  <Tr key={row.id}>
                    <Td className="text-center font-bold text-slate-400 tabular-nums">
                      {index + 1}
                    </Td>

                    <Td>
                      <Link
                        href={`/patients/${row.patientId}`}
                        className="font-semibold text-teal-700 hover:underline dark:text-teal-400"
                      >
                        {row.patientName}
                      </Link>
                      <div className="text-xs text-slate-500 tabular-nums" dir="ltr">
                        {row.patientPhone}
                      </div>
                    </Td>

                    <Td className="font-medium text-slate-900 dark:text-slate-100">
                      {row.medicationName}
                    </Td>

                    <Td className="max-w-xs">
                      <span className="font-medium text-amber-900 dark:text-amber-300 line-clamp-2 text-xs">
                        {row.problemSummary}
                      </span>
                      {row.alertTitle && (
                        <span className="mt-0.5 block text-[11px] text-slate-400 line-clamp-1">
                          {row.alertTitle}
                        </span>
                      )}
                    </Td>

                    <Td>
                      <Pill tone={PRIORITY_TONE[row.priority]} dot={row.priority === "URGENT"}>
                        {row.priority}
                      </Pill>
                    </Td>

                    <Td className="text-xs">
                      {row.pharmacistName ? (
                        <span className="font-medium text-teal-800 dark:text-teal-300">
                          {row.pharmacistName}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </Td>

                    <Td align="end" className="text-xs text-slate-500 tabular-nums">
                      {DateTime.fromJSDate(row.openedAtUtc, { zone: user.pharmacyTimeZone }).toFormat("yyyy-MM-dd HH:mm")}
                    </Td>

                    <Td align="center">
                      <QuickResolveModal
                        caseId={row.id}
                        patientName={row.patientName}
                        medicationName={row.medicationName}
                        problemSummary={row.problemSummary}
                        locale={locale}
                      />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Suspense>
      )}

      {/* Tab 2: Missed Doses / No Response */}
      {activeTab === "missed" && (
        <Suspense fallback={<SkeletonRows rows={6} />}>
          {missedCases.length === 0 ? (
            <EmptyState
              title={isAr ? "لا توجد جرعات فائتة أو تذكيرات معلقة" : "No missed doses or pending reminders"}
              hint={isAr ? "جميع المرضى ملتزمون بتأكيد تناول جرعاتهم في مواعيدها." : "All patients are up to date on their medication schedules."}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-12 text-center">#</Th>
                  <Th>{isAr ? "المريض" : "Patient"}</Th>
                  <Th>{isAr ? "الدواء" : "Medication"}</Th>
                  <Th>{isAr ? "الحالة" : "Status"}</Th>
                  <Th>{isAr ? "موعد الجرعة" : "Dose Time"}</Th>
                  <Th>{isAr ? "الصيدلي المسؤول / المتابع" : "Assigned Pharmacist"}</Th>
                  <Th align="center">{isAr ? "إجراء المتابعة" : "Follow-up Action"}</Th>
                </tr>
              </thead>
              <tbody>
                {missedCases.map((row, index) => (
                  <Tr key={row.id}>
                    <Td className="text-center font-bold text-slate-400 tabular-nums">
                      {index + 1}
                    </Td>

                    <Td>
                      <Link
                        href={`/patients/${row.patientId}`}
                        className="font-semibold text-teal-700 hover:underline dark:text-teal-400"
                      >
                        {row.patientName}
                      </Link>
                      <div className="text-xs text-slate-500 tabular-nums" dir="ltr">
                        {row.patientPhone}
                      </div>
                    </Td>

                    <Td className="font-medium text-slate-900 dark:text-slate-100">
                      {row.medicationName}
                    </Td>

                    <Td>
                      {row.state === "MISSED" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">
                          ❌ {isAr ? "جرعة فائتة (لم يتناول)" : "Missed Dose"}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                          ⌛ {isAr ? "لا يوجد رد على التذكير" : "No Response"}
                        </span>
                      )}
                    </Td>

                    <Td className="text-xs text-slate-600 dark:text-slate-300 tabular-nums">
                      {row.doseTimeText}
                    </Td>

                    <Td className="text-xs">
                      {row.pharmacistName ? (
                        <span className="font-medium text-teal-800 dark:text-teal-300">
                          {row.pharmacistName}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </Td>

                    <Td align="center">
                      <ResendReminderButton
                        patientId={row.patientId}
                        medicationId={row.medicationId}
                        patientName={row.patientName}
                        medicationName={row.medicationName}
                        locale={locale}
                      />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Suspense>
      )}

      {/* Tab 3: Clinical Intervention Log */}
      {activeTab === "interventions" && (
        <Suspense fallback={<SkeletonRows rows={6} />}>
          {interventions.length === 0 ? (
            <EmptyState
              title={isAr ? "سجل التدخلات السريرية فارغ حالياً" : "Clinical intervention log is empty"}
              hint={isAr ? "يمكنك توثيق أول تدخل صيدلاني أو تحويل لطبيب بالضغط على زر 'تسجيل تدخل سريري جديد' بالأعلى." : "Start documenting pharmacist interventions using the button above."}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-12 text-center">#</Th>
                  <Th>{isAr ? "التاريخ والوقت" : "Date & Time"}</Th>
                  <Th>{isAr ? "المريض" : "Patient"}</Th>
                  <Th>{isAr ? "الدواء" : "Medication"}</Th>
                  <Th>{isAr ? "تصنيف التدخل السريري" : "Intervention Type"}</Th>
                  <Th>{isAr ? "تفاصيل الإجراء والملاحظات السريرية" : "Clinical Action & Notes"}</Th>
                  <Th>{isAr ? "الصيدلي المتدخل" : "Intervening Pharmacist"}</Th>
                  <Th>{isAr ? "النتيجة" : "Outcome"}</Th>
                </tr>
              </thead>
              <tbody>
                {interventions.map((row, index) => (
                  <Tr key={row.id}>
                    <Td className="text-center font-bold text-slate-400 tabular-nums">
                      {index + 1}
                    </Td>

                    <Td className="text-xs text-slate-500 tabular-nums">
                      {DateTime.fromJSDate(row.performedAtUtc, { zone: user.pharmacyTimeZone }).toFormat("yyyy-MM-dd HH:mm")}
                    </Td>

                    <Td>
                      <Link
                        href={`/patients/${row.patientId}`}
                        className="font-semibold text-teal-700 hover:underline dark:text-teal-400"
                      >
                        {row.patientName}
                      </Link>
                      <div className="text-xs text-slate-500 tabular-nums" dir="ltr">
                        {row.patientPhone}
                      </div>
                    </Td>

                    <Td className="text-xs font-medium text-slate-900 dark:text-slate-100">
                      {row.medicationName ?? "—"}
                    </Td>

                    <Td>
                      {row.category === "SIDE_EFFECT" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                          ⚠️ {row.categoryLabelAr}
                        </span>
                      )}
                      {row.category === "DOCTOR_REFERRAL" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-800 dark:bg-purple-950/60 dark:text-purple-300">
                          👨‍⚕️ {row.categoryLabelAr}
                        </span>
                      )}
                      {row.category === "DRUG_INTERACTION" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800 dark:bg-rose-950/60 dark:text-rose-300">
                          💊🔄💊 {row.categoryLabelAr}
                        </span>
                      )}
                      {row.category === "DOSE_CLARIFICATION" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800 dark:bg-sky-950/60 dark:text-sky-300">
                          ℹ️ {row.categoryLabelAr}
                        </span>
                      )}
                      {row.category === "GENERAL" && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-teal-100 px-2 py-0.5 text-xs font-semibold text-teal-800 dark:bg-teal-950/60 dark:text-teal-300">
                          ✓ {row.categoryLabelAr}
                        </span>
                      )}
                    </Td>

                    <Td className="max-w-md text-xs text-slate-700 dark:text-slate-300">
                      {row.notes}
                    </Td>

                    <Td className="text-xs">
                      {row.pharmacistName ? (
                        <span className="font-semibold text-teal-800 dark:text-teal-300">
                          {row.pharmacistName}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </Td>

                    <Td className="text-xs text-slate-600 dark:text-slate-400">
                      {row.outcomeLabelAr}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Suspense>
      )}
    </div>
  );
}
