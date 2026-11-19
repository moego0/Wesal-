"use client";

import { useState, useTransition } from "react";
import {
  AlertTriangle,
  AlertCircle,
  ShieldCheck,
  Clock,
  ArrowRightLeft,
  Stethoscope,
  FileText,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Info,
  CheckCircle2,
  Pill as PillIcon,
  HelpCircle,
  X,
  ExternalLink,
  Activity,
  Layers,
  HeartPulse,
  Send,
  Calendar,
  RefreshCw,
  Database,
  Search,
  AlertOctagon,
} from "lucide-react";
import type {
  InteractionEngineReport,
  DetectedInteraction,
  MedicationCatalogStatus,
} from "@/server/ddi/engine";
import { BackgroundGradient } from "@/components/ui/background-gradient";
import { buttonClass } from "@/components/ui";

export interface ActiveMedicationItem {
  id: string;
  name: string;
  doseAmount?: string;
  instructions?: string;
}

export function PatientMedicationInteractions({
  report: initialReport,
  patientId,
  patientName,
  activeMedications = [],
  locale = "ar",
}: {
  report: InteractionEngineReport | null;
  patientId: string;
  patientName: string;
  activeMedications?: ActiveMedicationItem[];
  locale?: string;
}) {
  const isAr = locale === "ar";
  const [report, setReport] = useState<InteractionEngineReport | null>(initialReport);
  const [isExpanded, setIsExpanded] = useState(true);
  const [selectedInteraction, setSelectedInteraction] = useState<DetectedInteraction | null>(null);
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  const [isRechecking, setIsRechecking] = useState(false);
  const [recheckSuccess, setRecheckSuccess] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);

  // If there are no active medications, there is nothing to evaluate
  if (activeMedications.length === 0 && (!report || report.patientMedicationsCount === 0)) {
    return null;
  }

  const hasInteractions = Boolean(report && report.interactionsCount > 0);
  const hasMajor = Boolean(report && report.interactionsBySeverity.major > 0);
  const unmatched = report?.unmatchedMedications || [];
  const hasUnmatched = unmatched.length > 0;

  // Re-check action triggered by the user
  async function handleRecheck() {
    setIsRechecking(true);
    setRecheckSuccess(false);
    setRecheckError(null);

    try {
      const res = await fetch("/api/clinical/ddi/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          medications: activeMedications.map((m) => ({
            identifier: m.id,
            name: m.name,
            doseAmount: m.doseAmount,
            instructions: m.instructions,
          })),
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as { report: InteractionEngineReport };
        setReport(data.report);
        setRecheckSuccess(true);
        setTimeout(() => setRecheckSuccess(false), 3500);
      } else {
        const err = await res.json();
        setRecheckError(err.error || err.message || (isAr ? "فشل فحص الأدوية" : "Re-check failed"));
      }
    } catch (err) {
      setRecheckError((err as Error).message);
    } finally {
      setIsRechecking(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* ──────────────── Action Toolbar / Re-check Strip ──────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2">
          <Database className="size-4 text-teal-600 dark:text-teal-400" />
          <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
            {isAr
              ? "فحص الكتالوج الدوائي والتفاعلات (DDI & Catalog)"
              : "Medication Catalog & DDI Status"}
          </span>
          {report && (
            <span className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
              ({report.patientMedicationsCount} {isAr ? "أدوية نشطة" : "active medications"})
            </span>
          )}
        </div>

        {/* ─── THE RE-CHECK BUTTON ─── */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRecheck}
            disabled={isRechecking || activeMedications.length === 0}
            className="inline-flex items-center gap-1.5 rounded-xl border border-teal-300 bg-teal-50/80 px-3 py-1.5 text-xs font-semibold text-teal-800 shadow-sm transition-all hover:bg-teal-100 hover:border-teal-400 disabled:opacity-50 dark:border-teal-800 dark:bg-teal-950/60 dark:text-teal-300 dark:hover:bg-teal-900"
            title={isAr ? "إعادة فحص الأدوية النشطة والتحقق من وجودها في قاعدة البيانات" : "Re-check active medications and verify database status"}
          >
            <RefreshCw className={`size-3.5 ${isRechecking ? "animate-spin text-teal-600" : ""}`} />
            <span>
              {isRechecking
                ? isAr
                  ? "جارٍ إعادة الفحص..."
                  : "Checking database..."
                : isAr
                  ? "إعادة فحص الأدوية وقاعدة البيانات"
                  : "Re-check Drugs & Database"}
            </span>
          </button>

          {recheckSuccess && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 animate-in fade-in duration-200">
              <CheckCircle2 className="size-3.5" />
              <span>{isAr ? "تم تحديث الفحص بنجاح" : "Up to date"}</span>
            </span>
          )}
        </div>
      </div>

      {recheckError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/80 p-3 text-xs text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/50 dark:text-rose-300">
          {recheckError}
        </div>
      )}

      {/* ──────────────── Aceternity BackgroundGradient DDI Alert (If Conflicts Found) ──────────────── */}
      {hasInteractions ? (
        <BackgroundGradient
          variant={hasMajor ? "rose-amber" : "amber-orange"}
          containerClassName="w-full shadow-lg"
          className="bg-white p-5 dark:bg-slate-900 border border-slate-100 dark:border-slate-800"
        >
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-3">
              <div
                className={`flex size-10 items-center justify-center rounded-xl ${
                  hasMajor
                    ? "bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400"
                    : "bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400"
                }`}
              >
                <AlertTriangle className="size-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                    {isAr ? "تنبيه التفاعلات الدوائية (DDI Alert)" : "Drug-Drug Interaction Alert"}
                  </h3>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      hasMajor
                        ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                        : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                    }`}
                  >
                    <span className="size-1.5 rounded-full bg-current animate-ping" />
                    {hasMajor
                      ? isAr
                        ? "حرج / Major"
                        : "Major Conflict"
                      : isAr
                        ? "متوسط / Moderate"
                        : "Moderate Conflict"}
                  </span>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {isAr
                    ? `تم اكتشاف ${report?.interactionsCount} تفاعل بين أدوية المريض النشطة (${report?.patientMedicationsCount} أدوية)`
                    : `Detected ${report?.interactionsCount} interaction(s) across ${report?.patientMedicationsCount} active medications`}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 transition-colors"
              >
                {isExpanded ? (
                  <>
                    <span>{isAr ? "إخفاء التفاصيل" : "Collapse"}</span>
                    <ChevronUp className="size-3.5" />
                  </>
                ) : (
                  <>
                    <span>{isAr ? "عرض التفاصيل والحلول" : "View Details & Solutions"}</span>
                    <ChevronDown className="size-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Interaction Items List */}
          {isExpanded && report && (
            <div className="mt-4 space-y-4">
              {report.interactions.map((interaction) => (
                <InteractionCard
                  key={interaction.id}
                  interaction={interaction}
                  isAr={isAr}
                  onOpenReview={() => {
                    setSelectedInteraction(interaction);
                    setIsReviewModalOpen(true);
                  }}
                />
              ))}

              {/* Clinical Disclaimer footer */}
              <div className="flex items-start gap-2 pt-2 text-[11px] text-slate-400 dark:text-slate-500">
                <Info className="size-3.5 shrink-0 mt-0.5" />
                <p>{report.safetyDisclaimer}</p>
              </div>
            </div>
          )}
        </BackgroundGradient>
      ) : report && report.patientMedicationsCount >= 2 ? (
        /* ──────────────── No Known Interactions (All Clear) ──────────────── */
        <div className="rounded-2xl border border-emerald-200/80 bg-emerald-50/40 p-4 dark:border-emerald-900/40 dark:bg-emerald-950/20">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/80 dark:text-emerald-400">
                <ShieldCheck className="size-5" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-emerald-950 dark:text-emerald-300">
                  {isAr
                    ? "لم يتم العثور على تفاعلات دوائية مسجلة بين الأدوية النشطة"
                    : "No Known Drug Interactions Detected"}
                </h4>
                <p className="text-xs text-emerald-800/80 dark:text-emerald-400/80">
                  {isAr
                    ? `تم الفحص بين الأدوية النشطة (${report.patientMedicationsCount}) مع قاعدة بيانات DDInter 2.0 والكتالوج الموحد.`
                    : `Evaluated ${report.evaluatedPairsCount} drug pair(s) across ${report.patientMedicationsCount} active medications.`}
                </p>
              </div>
            </div>

            <span className="hidden sm:inline-flex items-center gap-1 rounded-full border border-emerald-300/60 bg-emerald-100/60 px-2.5 py-0.5 text-[11px] font-medium text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-900/40 dark:text-emerald-300">
              <CheckCircle2 className="size-3 text-emerald-600 dark:text-emerald-400" />
              {isAr ? "فحص سريري معتمد" : "Catalog Evaluated"}
            </span>
          </div>
        </div>
      ) : (
        /* ──────────────── Single Medication Notice ──────────────── */
        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/40">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                <PillIcon className="size-5" />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {isAr
                    ? "يوجد دواء واحد نشط فقط للمريض"
                    : "Single Active Medication"}
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {isAr
                    ? "يتطلب فحص التفاعلات الدوائية (DDI) وجود دوائين نشطين على الأقل. يمكنك فحص حالة الدواء في قاعدة البيانات أدناه."
                    : "DDI conflict detection requires at least 2 active medications. Review database catalog status below."}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────────────────
          SECTION: "TELL WHICH DRUGS AREN'T IN THE DATABASE"
          Prominently displays any medications that could NOT be mapped to standardized catalog ingredients.
         ───────────────────────────────────────────────────────────────────────────── */}
      {hasUnmatched ? (
        <div className="rounded-2xl border-2 border-amber-300/80 bg-amber-50/70 p-4 dark:border-amber-800/80 dark:bg-amber-950/30 space-y-3 shadow-sm animate-in fade-in-50 duration-200">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200/80 pb-2.5 dark:border-amber-900/60">
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 items-center justify-center rounded-lg bg-amber-200/80 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                <AlertOctagon className="size-4.5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-amber-950 dark:text-amber-200 flex items-center gap-2">
                  <span>
                    {isAr
                      ? "أدوية غير مسجلة في قاعدة البيانات (تتطلب تدقيقاً يدوياً):"
                      : "Medications Not Found in Database (Manual Review Required):"}
                  </span>
                  <span className="rounded-md bg-amber-200 px-2 py-0.5 text-[10px] font-extrabold text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                    {unmatched.length} {isAr ? "غير مسجل" : "Uncataloged"}
                  </span>
                </h4>
                <p className="text-[11px] text-amber-800 dark:text-amber-300">
                  {isAr
                    ? "لم يتم العثور على الأدوية التالية في الكتالوج الموحد (eg-drugs, OMC, RxNorm). نظراً لعدم مطابقة المادة الفعالة، لا يمكن حساب تفاعلاتها تلقائياً."
                    : "The following medications do not match any recognized entity in the unified catalog. Automated DDI checking cannot be completed for these medications."}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            {unmatched.map((item) => (
              <div
                key={item.identifier + item.name}
                className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-200 bg-white/90 p-3 shadow-xs dark:border-amber-900/50 dark:bg-slate-900/80"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <PillIcon className="size-4 text-amber-600 dark:text-amber-400" />
                    <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                      {item.name}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
                      <Database className="size-3" />
                      {isAr ? "غير مسجل في الكتالوج" : "NOT IN DATABASE"}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-600 dark:text-slate-400">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {isAr ? "سبب عدم المطابقة: " : "Reason: "}
                    </span>
                    {isAr
                      ? "لم يتم العثور على مادة فعالة موحدة مطابقة لهذا الاسم بالكتالوج."
                      : item.reason}
                  </p>
                  <p className="text-[11px] font-medium text-amber-800 dark:text-amber-400">
                    {isAr
                      ? "تنبيه سريري: عدم رصد تفاعل لهذا الدواء لا يضمن أمانه. يجب على الصيدلي التحقق يدوياً من مواده الفعالة."
                      : "Clinical caveat: Absence of interaction records for this drug does not imply safety. Pharmacist must manually inspect active ingredients."}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : report && report.patientMedicationsCount > 0 ? (
        <div className="rounded-xl border border-teal-200/60 bg-teal-50/40 p-3 text-xs text-teal-900 dark:border-teal-900/40 dark:bg-teal-950/20 dark:text-teal-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-4 text-teal-600 dark:text-teal-400 shrink-0" />
            <span>
              {isAr
                ? `جميع أدوية المريض (${report.patientMedicationsCount} أدوية) مسجلة ومطابقة في الكتالوج الموحد للأدوية.`
                : `All active medications (${report.patientMedicationsCount}) are matched to standardized database catalog records.`}
            </span>
          </div>
        </div>
      ) : null}

      {/* ──────────────── Pharmacist Intervention & Review Modal ──────────────── */}
      {isReviewModalOpen && selectedInteraction && (
        <DdiReviewModal
          interaction={selectedInteraction}
          patientId={patientId}
          patientName={patientName}
          isAr={isAr}
          onClose={() => {
            setIsReviewModalOpen(false);
            setSelectedInteraction(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Individual Interaction Card featuring "How to Solve It" strategies.
 */
function InteractionCard({
  interaction,
  isAr,
  onOpenReview,
}: {
  interaction: DetectedInteraction;
  isAr: boolean;
  onOpenReview: () => void;
}) {
  const isMajor = interaction.severity === "MAJOR";
  const isApproved = interaction.clinicalApprovalState === "CLINICALLY_APPROVED";

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 dark:border-slate-800 dark:bg-slate-900/70 space-y-3">
      {/* Drugs Pair Row */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-800 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
            <PillIcon className="size-3.5 text-teal-600 dark:text-teal-400" />
            {interaction.ingredientA.name}
            {interaction.ingredientA.nameAr ? ` (${interaction.ingredientA.nameAr})` : ""}
          </span>
          <ArrowRightLeft className="size-3.5 text-slate-400" />
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-800 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
            <PillIcon className="size-3.5 text-teal-600 dark:text-teal-400" />
            {interaction.ingredientB.name}
            {interaction.ingredientB.nameAr ? ` (${interaction.ingredientB.nameAr})` : ""}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <span
            className={`rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${
              isMajor
                ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
            }`}
          >
            {interaction.severity}
          </span>
          <span
            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${
              isApproved
                ? "bg-teal-50 text-teal-700 border border-teal-200 dark:bg-teal-950/60 dark:text-teal-300 dark:border-teal-800"
                : "bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700"
            }`}
          >
            {isApproved ? <CheckCircle2 className="size-3" /> : <Clock className="size-3" />}
            {isApproved
              ? isAr
                ? "معتمد سريرياً"
                : "Approved"
              : isAr
                ? "قيد المراجعة"
                : "Unreviewed"}
          </span>
        </div>
      </div>

      {/* Mechanism & Clinical Risk */}
      {interaction.mechanism && (
        <div className="text-xs text-slate-700 dark:text-slate-300 space-y-1">
          <p className="font-medium text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
            <Activity className="size-3.5 text-rose-500" />
            {isAr ? "الآلية الدوائية والتأثير السريري:" : "Clinical Mechanism & Risk:"}
          </p>
          <p className="rounded-lg bg-white p-2.5 border border-slate-200/80 leading-relaxed text-slate-600 dark:border-slate-800 dark:bg-slate-900/90 dark:text-slate-400">
            {interaction.mechanism}
          </p>
        </div>
      )}

      {/* ──────────────── "HOW TO SOLVE IT" (Actionable Clinical Resolution) ──────────────── */}
      <div className="rounded-xl border border-teal-200/80 bg-gradient-to-br from-teal-50/60 via-white to-sky-50/50 p-3.5 dark:border-teal-900/50 dark:from-teal-950/30 dark:via-slate-900 dark:to-sky-950/20 space-y-3">
        <div className="flex items-center justify-between border-b border-teal-100 pb-2 dark:border-teal-900/60">
          <span className="flex items-center gap-1.5 text-xs font-bold text-teal-950 dark:text-teal-300">
            <Sparkles className="size-4 text-teal-600 dark:text-teal-400" />
            {isAr ? "كيفية التعامل مع التفاعل والحلول المتاحة:" : "How to Solve It & Clinical Management:"}
          </span>
          <span className="text-[11px] font-medium text-teal-700 dark:text-teal-400">
            {isAr ? "إجراءات مقترحة" : "Actionable Steps"}
          </span>
        </div>

        {/* Strategy 1: Smart Timing Rule (Administration separation) */}
        {interaction.timingRule ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50/80 p-2.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
            <Clock className="size-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-amber-950 dark:text-amber-100">
                {isAr
                  ? `الحل الزمني: الفصل بـ (${interaction.timingRule.minIntervalHours} ساعات) على الأقل بين الجرعات`
                  : `Timing Solution: Minimum ${interaction.timingRule.minIntervalHours} hours interval separation`}
              </p>
              <p className="text-[11px] text-amber-900 dark:text-amber-300 leading-relaxed">
                {interaction.timingRule.timingInstructionAr || interaction.timingRule.timingInstructionEn}
              </p>
              <div className="flex items-center gap-1.5 pt-0.5 text-[10px] text-amber-800/80 dark:text-amber-400/80">
                <FileText className="size-3" />
                <span>
                  {isAr ? "المرجع السريري: " : "Reference: "}
                  {interaction.timingRule.clinicalReference}
                </span>
              </div>
            </div>
          </div>
        ) : null}

        {/* Strategy 2: Clinical Guidance & Monitoring */}
        <div className="rounded-lg bg-white/90 p-2.5 text-xs text-slate-700 border border-slate-200/70 dark:bg-slate-800/70 dark:border-slate-700/70 dark:text-slate-300 space-y-1">
          <p className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
            <HeartPulse className="size-3.5 text-teal-600 dark:text-teal-400" />
            {isAr ? "التوجيه السريري والمراقبة الحيوية:" : "Recommended Clinical Guidance & Monitoring:"}
          </p>
          <p className="leading-relaxed">
            {interaction.management ||
              (isAr
                ? "مراقبة العلامات الحيوية وتعديل الجرعة إذا لزم الأمر، أو النظر في استبدال أحد الدوائين ببديل علاجي مناسب."
                : "Monitor vital signs and consider dose adjustment or therapeutic alternative if clinically indicated.")}
          </p>
        </div>

        {/* Action Button: Record Pharmacist Intervention */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
            <Stethoscope className="size-3.5 text-teal-600 dark:text-teal-400" />
            <span>{isAr ? "يتطلب توثيق القرار الصيدلاني" : "Requires pharmacist documentation"}</span>
          </div>

          <button
            type="button"
            onClick={onOpenReview}
            className="inline-flex items-center gap-1.5 rounded-xl bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-teal-700 transition-colors dark:bg-teal-700 dark:hover:bg-teal-600"
          >
            <Stethoscope className="size-3.5" />
            {isAr ? "تسجيل التدخل الصيدلاني أو المراجعة" : "Record Pharmacist Intervention"}
          </button>
        </div>
      </div>

      {/* Metadata / Source */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-slate-400 dark:text-slate-500 border-t border-slate-100 dark:border-slate-800/80">
        <span>
          {isAr ? "المصدر: " : "Source: "}
          {interaction.source} ({interaction.reference || "Verified Research Corpus"})
        </span>
        {interaction.relatedMedications.length > 0 && (
          <span>
            {isAr ? "في وصفة المريض: " : "In Regimen: "}
            {interaction.relatedMedications.join(" & ")}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Modal to submit a Pharmacist Review or Clinical Intervention for an interaction.
 */
function DdiReviewModal({
  interaction,
  patientId,
  patientName,
  isAr,
  onClose,
}: {
  interaction: DetectedInteraction;
  patientId: string;
  patientName: string;
  isAr: boolean;
  onClose: () => void;
}) {
  const [decision, setDecision] = useState<"APPROVED" | "MODIFIED" | "REJECTED" | "NEEDS_MORE_EVIDENCE">("APPROVED");
  const [notes, setNotes] = useState(
    interaction.timingRule
      ? isAr
        ? `تم تنبيه المريض بضرورة الفصل بـ ${interaction.timingRule.minIntervalHours} ساعات على الأقل بين ${interaction.ingredientA.name} و ${interaction.ingredientB.name}.`
        : `Patient advised to separate administration of ${interaction.ingredientA.name} and ${interaction.ingredientB.name} by at least ${interaction.timingRule.minIntervalHours} hours.`
      : isAr
        ? `تمت مراجعة التفاعل بين ${interaction.ingredientA.name} و ${interaction.ingredientB.name} ومتابعة الحالة.`
        : `Reviewed interaction between ${interaction.ingredientA.name} and ${interaction.ingredientB.name}. Monitoring advised.`
  );
  const [isPending, startTransition] = useTransition();
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/clinical/ddi/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            interactionId: interaction.id,
            reviewerUserId: "pharmacist_on_duty",
            reviewerRole: "PHARMACIST",
            decision,
            clinicalNotes: notes,
          }),
        });

        if (res.ok) {
          setSuccess(true);
          setTimeout(() => {
            onClose();
          }, 1200);
        } else {
          const err = await res.json();
          setError(err.message || (isAr ? "فشل حفظ التدخل الصيدلاني" : "Failed to save review"));
        }
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-800 dark:bg-slate-900 space-y-4">
        {/* Modal Header */}
        <div className="flex items-start justify-between border-b border-slate-100 pb-3 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-xl bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300">
              <Stethoscope className="size-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {isAr ? "تسجيل مراجعة وتدخل صيدلاني" : "Record Pharmacist Review & Intervention"}
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {isAr ? `المريض: ${patientName}` : `Patient: ${patientName}`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          >
            <X className="size-4" />
          </button>
        </div>

        {success ? (
          <div className="py-8 text-center space-y-2">
            <CheckCircle2 className="mx-auto size-10 text-emerald-500 animate-in zoom-in" />
            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {isAr ? "تم تسجيل التدخل والمراجعة بنجاح" : "Review and Intervention Saved Successfully"}
            </h4>
            <p className="text-xs text-slate-500">
              {isAr ? "تم تحديث حالة التفاعل في سجل المريض." : "Interaction status updated in patient clinical record."}
            </p>
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            {error && (
              <div className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
                {error}
              </div>
            )}

            {/* Interacting Pair Reminder */}
            <div className="rounded-lg bg-slate-50 p-2.5 text-xs text-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {isAr ? "التفاعل المستهدف: " : "Target Interaction: "}
              </span>
              {interaction.ingredientA.name} + {interaction.ingredientB.name} ({interaction.severity})
            </div>

            {/* Decision selector */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                {isAr ? "القرار الصيدلاني / السريري:" : "Clinical Pharmacist Decision:"}
              </label>
              <select
                value={decision}
                onChange={(e) => setDecision(e.target.value as any)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 shadow-sm focus:border-teal-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="APPROVED">{isAr ? "اعتماد الخطة مع الإجراءات الوقائية (Approved with Safeguards)" : "Approved with Safeguards"}</option>
                <option value="MODIFIED">{isAr ? "تعديل مواعيد الجرعات / فاصل زمني (Modified Schedule)" : "Modified Schedule"}</option>
                <option value="REJECTED">{isAr ? "رفض الجمع بين الدوائين وتغيير العلاج (Discontinue / Switch)" : "Discontinue / Switch Medication"}</option>
                <option value="NEEDS_MORE_EVIDENCE">{isAr ? "إحالة للطبيب المعالج لمزيد من التقييم (Refer to Physician)" : "Refer to Prescribing Physician"}</option>
              </select>
            </div>

            {/* Clinical Notes */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                {isAr ? "الملاحظات وتوجيهات المريض:" : "Pharmacist Notes & Patient Advice:"}
              </label>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                required
                className="w-full rounded-xl border border-slate-300 bg-white p-2.5 text-xs text-slate-900 shadow-sm focus:border-teal-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {isAr ? "إلغاء" : "Cancel"}
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="rounded-xl bg-teal-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-teal-700 disabled:opacity-50 dark:bg-teal-700 dark:hover:bg-teal-600"
              >
                {isPending
                  ? isAr
                    ? "جارٍ الحفظ..."
                    : "Saving..."
                  : isAr
                    ? "حفظ واعتماد المراجعة"
                    : "Save & Approve"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
