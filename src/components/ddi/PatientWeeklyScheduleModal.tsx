"use client";

import React, { useState, useMemo } from "react";
import {
  Calendar,
  Clock,
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  Info,
  X,
  ChevronDown,
  Sparkles,
  ArrowRightLeft,
  Pill,
  CheckCircle2,
  ExternalLink,
  Filter,
  Eye,
  AlertOctagon,
  HelpCircle,
} from "lucide-react";
import type { DetectedInteraction } from "@/server/ddi/engine";

export interface ScheduledMedicationItem {
  id: string;
  medicationNameText: string;
  doseAmountText?: string | null;
  instructionsTextAr?: string | null;
  instructionsTextEn?: string | null;
  status: string;
  mode?: string;
  schedules: Array<{
    id: string;
    status: string;
    mode: string;
    timesOfDay: string[];
    daysOfWeek: number[];
    startDate?: Date | string;
    endDate?: Date | string | null;
    revision?: number;
  }>;
}

export interface PatientWeeklyScheduleProps {
  patientName: string;
  patientPhone?: string;
  medications: ScheduledMedicationItem[];
  interactions: DetectedInteraction[];
  unmatchedMedications?: Array<{ identifier: string; name: string; reason: string }>;
  locale?: string;
}

// 7 Days of the clinical week starting from Saturday (standard in Egypt & Middle East)
const DAYS_OF_WEEK = [
  { index: 6, key: "saturday", labelAr: "السبت", labelEn: "Saturday", shortAr: "سبت", shortEn: "Sat" },
  { index: 0, key: "sunday", labelAr: "الأحد", labelEn: "Sunday", shortAr: "أحد", shortEn: "Sun" },
  { index: 1, key: "monday", labelAr: "الإثنين", labelEn: "Monday", shortAr: "إثنين", shortEn: "Mon" },
  { index: 2, key: "tuesday", labelAr: "الثلاثاء", labelEn: "Tuesday", shortAr: "ثلاثاء", shortEn: "Tue" },
  { index: 3, key: "wednesday", labelAr: "الأربعاء", labelEn: "Wednesday", shortAr: "أربعاء", shortEn: "Wed" },
  { index: 4, key: "thursday", labelAr: "الخميس", labelEn: "Thursday", shortAr: "خميس", shortEn: "Thu" },
  { index: 5, key: "friday", labelAr: "الجمعة", labelEn: "Friday", shortAr: "جمعة", shortEn: "Fri" },
];

export interface DoseSlot {
  time: string; // "08:00"
  medicationId: string;
  medicationName: string;
  doseAmount?: string | null;
  instructions?: string | null;
  scheduleId: string;
  conflicts: DoseConflict[];
  hasMajorConflict: boolean;
  hasModerateConflict: boolean;
}

export interface DoseConflict {
  interaction: DetectedInteraction;
  interactingMedName: string;
  isSameTime: boolean;
  sameTimeValue?: string;
  severity: "MAJOR" | "MODERATE" | "MINOR" | "UNKNOWN";
  avoidanceStrategy: {
    timingRuleText?: string | null;
    timingIntervalHours?: number;
    managementText?: string | null;
    sameTimeAlert?: string | null;
    clinicalReference?: string | null;
  };
}

export function PatientWeeklyScheduleButton({
  patientName,
  patientPhone,
  medications = [],
  interactions = [],
  unmatchedMedications = [],
  locale = "ar",
}: PatientWeeklyScheduleProps) {
  const [isOpen, setIsOpen] = useState(false);
  const isAr = locale === "ar";
  const hasInteractions = interactions.length > 0;
  const majorCount = interactions.filter((i) => i.severity === "MAJOR").length;

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="group relative inline-flex items-center gap-2 rounded-xl border border-teal-300/80 bg-teal-50/80 px-3 py-1.5 text-xs font-semibold text-teal-900 shadow-xs hover:border-teal-400 hover:bg-teal-100/90 dark:border-teal-800 dark:bg-teal-950/60 dark:text-teal-200 dark:hover:bg-teal-900/80 transition-all cursor-pointer"
        title={
          isAr
            ? "عرض جدول الأسبوع الدوائي للمريض وفحص التفاعلات وتفاصيل تفاديها"
            : "View patient weekly medication schedule & interaction avoidance map"
        }
      >
        <Calendar className="size-4 text-teal-600 dark:text-teal-400 transition-transform group-hover:scale-110" />
        <span>{isAr ? "جدول الأسبوع والتفاعلات" : "Weekly Schedule & DDI Map"}</span>

        {hasInteractions && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
              majorCount > 0
                ? "bg-rose-500 text-white animate-pulse"
                : "bg-amber-500 text-white"
            }`}
          >
            <AlertTriangle className="size-2.5" />
            <span>{interactions.length}</span>
          </span>
        )}
      </button>

      {isOpen && (
        <WeeklyScheduleModal
          patientName={patientName}
          patientPhone={patientPhone}
          medications={medications}
          interactions={interactions}
          unmatchedMedications={unmatchedMedications}
          locale={locale}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
}

function WeeklyScheduleModal({
  patientName,
  patientPhone,
  medications,
  interactions,
  unmatchedMedications = [],
  locale = "ar",
  onClose,
}: PatientWeeklyScheduleProps & { onClose: () => void }) {
  const isAr = locale === "ar";
  const [selectedDayFilter, setSelectedDayFilter] = useState<number | "ALL">("ALL");
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const [pinnedDoseKey, setPinnedDoseKey] = useState<string | null>(null);

  // ─────────────────────────────────────────────────────────────────────────────
  // Build Day-by-Day Schedule Map with Conflicts & Avoidance Strategies
  // ─────────────────────────────────────────────────────────────────────────────
  const weekSchedule = useMemo(() => {
    return DAYS_OF_WEEK.map((day) => {
      const doses: DoseSlot[] = [];

      // Collect doses for this day
      for (const med of medications) {
        if (med.status !== "ACTIVE") continue;

        for (const sched of med.schedules || []) {
          if (sched.status !== "ACTIVE") continue;
          if (sched.mode === "PRN") continue; // PRN handled separately

          // Check if schedule applies to this day (empty daysOfWeek means every day)
          const applies =
            !sched.daysOfWeek ||
            sched.daysOfWeek.length === 0 ||
            sched.daysOfWeek.includes(day.index);

          if (applies && sched.timesOfDay && sched.timesOfDay.length > 0) {
            for (const time of sched.timesOfDay) {
              doses.push({
                time,
                medicationId: med.id,
                medicationName: med.medicationNameText,
                doseAmount: med.doseAmountText,
                instructions: isAr ? med.instructionsTextAr : med.instructionsTextEn,
                scheduleId: sched.id,
                conflicts: [],
                hasMajorConflict: false,
                hasModerateConflict: false,
              });
            }
          }
        }
      }

      // Sort doses chronologically
      doses.sort((a, b) => a.time.localeCompare(b.time));

      // Resolve conflicts for each dose on this day
      for (let i = 0; i < doses.length; i++) {
        const dose = doses[i];
        const normName = dose.medicationName.trim().toLowerCase();

        // Find interactions involving this medication
        for (const inter of interactions) {
          const a = inter.ingredientA.name.toLowerCase();
          const b = inter.ingredientB.name.toLowerCase();
          const aAr = (inter.ingredientA.nameAr || "").toLowerCase();
          const bAr = (inter.ingredientB.nameAr || "").toLowerCase();
          const related = inter.relatedMedications.map((r) => r.toLowerCase());

          const matchesA = normName.includes(a) || (aAr && normName.includes(aAr));
          const matchesB = normName.includes(b) || (bAr && normName.includes(bAr));
          const matchesRel = related.some((r) => normName.includes(r) || r.includes(normName));

          if (matchesA || matchesB || matchesRel) {
            // Find which other drug is involved
            const otherIngredient = matchesA
              ? isAr && inter.ingredientB.nameAr
                ? `${inter.ingredientB.name} (${inter.ingredientB.nameAr})`
                : inter.ingredientB.name
              : isAr && inter.ingredientA.nameAr
                ? `${inter.ingredientA.name} (${inter.ingredientA.nameAr})`
                : inter.ingredientA.name;

            // Check if the other interacting medication is also taken today
            const otherDoseToday = doses.find(
              (d, idx) =>
                idx !== i &&
                (d.medicationName.toLowerCase().includes(a) ||
                  d.medicationName.toLowerCase().includes(b) ||
                  (aAr && d.medicationName.toLowerCase().includes(aAr)) ||
                  (bAr && d.medicationName.toLowerCase().includes(bAr)) ||
                  related.some((r) => d.medicationName.toLowerCase().includes(r))),
            );

            const isSameTime = Boolean(otherDoseToday && otherDoseToday.time === dose.time);

            // Construct Avoidance Strategy
            let sameTimeAlert: string | null = null;
            if (isSameTime) {
              sameTimeAlert = isAr
                ? `تحذير فوري: الدواءان مجدولان في نفس الميعاد (${dose.time}) تماماً! يجب المباعدة بينهما لتجنب التفاعل المباشر.`
                : `Immediate Warning: Both medications are scheduled at the exact same time (${dose.time})! Reschedule one of them immediately to avoid direct conflict.`;
            }

            const timingRuleText = inter.timingRule
              ? isAr
                ? inter.timingRule.timingInstructionAr || inter.timingRule.timingInstructionEn
                : inter.timingRule.timingInstructionEn
              : null;

            const conflict: DoseConflict = {
              interaction: inter,
              interactingMedName: otherDoseToday ? otherDoseToday.medicationName : otherIngredient,
              isSameTime,
              sameTimeValue: otherDoseToday ? otherDoseToday.time : undefined,
              severity: inter.severity,
              avoidanceStrategy: {
                timingRuleText,
                timingIntervalHours: inter.timingRule?.minIntervalHours,
                managementText: inter.management,
                sameTimeAlert,
                clinicalReference: inter.timingRule?.clinicalReference || inter.reference,
              },
            };

            dose.conflicts.push(conflict);
            if (inter.severity === "MAJOR") dose.hasMajorConflict = true;
            if (inter.severity === "MODERATE") dose.hasModerateConflict = true;
          }
        }
      }

      const dayHasMajor = doses.some((d) => d.hasMajorConflict);
      const dayHasConflicts = doses.some((d) => d.conflicts.length > 0);

      return {
        ...day,
        doses,
        hasMajorConflict: dayHasMajor,
        hasConflicts: dayHasConflicts,
        totalDoses: doses.length,
      };
    });
  }, [medications, interactions, isAr]);

  // PRN (As-needed) medications
  const prnMedications = useMemo(() => {
    return medications.filter(
      (m) =>
        m.status === "ACTIVE" &&
        (m.mode === "PRN" || m.schedules.some((s) => s.status === "ACTIVE" && s.mode === "PRN")),
    );
  }, [medications]);

  const totalWeeklyDoses = weekSchedule.reduce((acc, d) => acc + d.doses.length, 0);
  const totalDaysWithConflicts = weekSchedule.filter((d) => d.hasConflicts).length;
  const majorInteractionsCount = interactions.filter((i) => i.severity === "MAJOR").length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 sm:p-5 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-7xl max-h-[94vh] rounded-3xl bg-white shadow-2xl border border-slate-200 dark:bg-slate-900 dark:border-slate-800 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        dir={isAr ? "rtl" : "ltr"}
      >
        {/* ─────────────────────────────────────────────────────────────────────────────
            MODAL HEADER
           ───────────────────────────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-6 py-4 dark:border-slate-800 dark:bg-slate-900/90 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-teal-100 text-teal-800 shadow-xs dark:bg-teal-950 dark:text-teal-300">
              <Calendar className="size-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  {isAr
                    ? "الجدول الأسبوعي للأدوية وتفادي التفاعلات الدوائية"
                    : "Weekly Medication Schedule & Interaction Avoidance"}
                </h2>
                <span className="rounded-full bg-teal-100 px-2.5 py-0.5 text-xs font-semibold text-teal-800 dark:bg-teal-950 dark:text-teal-300">
                  7 {isAr ? "أيام" : "Days"}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                {isAr ? "المريض: " : "Patient: "}
                <span className="font-semibold text-slate-800 dark:text-slate-200">{patientName}</span>
                {patientPhone && (
                  <span className="ms-2 font-mono text-[11px] text-slate-400" dir="ltr">
                    ({patientPhone})
                  </span>
                )}
                {" · "}
                <span className="font-medium text-teal-700 dark:text-teal-400">
                  {medications.length} {isAr ? "أدوية نشطة" : "Active Medications"}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex size-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer"
              aria-label="Close"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        {/* ─────────────────────────────────────────────────────────────────────────────
            SUMMARY RIBBON & CONTROLS
           ───────────────────────────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-900 shrink-0">
          {/* KPI Pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-slate-700 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-300">
              <Clock className="size-3.5 text-teal-600 dark:text-teal-400" />
              <span>
                {isAr ? "إجمالي جرعات الأسبوع: " : "Weekly Doses: "}
                <strong className="text-slate-900 dark:text-slate-100">{totalWeeklyDoses}</strong>
              </span>
            </div>

            <div
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 ${
                interactions.length > 0
                  ? majorInteractionsCount > 0
                    ? "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
                    : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
              }`}
            >
              {interactions.length > 0 ? (
                <AlertTriangle className="size-3.5 text-current" />
              ) : (
                <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              )}
              <span>
                {interactions.length > 0
                  ? isAr
                    ? `${interactions.length} تفاعل دوائي مرصود (${majorInteractionsCount} حرج)`
                    : `${interactions.length} DDI Conflict(s) (${majorInteractionsCount} Major)`
                  : isAr
                    ? "لا توجد تفاعلات دوائية مسجلة"
                    : "No DDI Conflicts"}
              </span>
            </div>

            {totalDaysWithConflicts > 0 && (
              <div className="flex items-center gap-1 text-[11px] text-rose-600 dark:text-rose-400">
                <span className="size-1.5 rounded-full bg-rose-500 animate-ping" />
                <span>
                  {isAr
                    ? `يتكرر التعارض في ${totalDaysWithConflicts} أيام أسبوعياً`
                    : `Conflicts affect ${totalDaysWithConflicts} days/week`}
                </span>
              </div>
            )}
          </div>

          {/* Filter & View Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOnlyConflicts(!onlyConflicts)}
              className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                onlyConflicts
                  ? "border-rose-300 bg-rose-100 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200"
                  : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-300"
              }`}
            >
              <Filter className="size-3.5" />
              <span>
                {onlyConflicts
                  ? isAr
                    ? "عرض كل الأدوية"
                    : "Show All Medications"
                  : isAr
                    ? "الأدوية المتعارضة فقط"
                    : "Only Conflicting Doses"}
              </span>
            </button>

            {/* Quick Day Selector */}
            <div className="hidden lg:flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-slate-800 dark:bg-slate-800/60">
              <button
                type="button"
                onClick={() => setSelectedDayFilter("ALL")}
                className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                  selectedDayFilter === "ALL"
                    ? "bg-white text-slate-900 shadow-xs font-semibold dark:bg-slate-700 dark:text-white"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                }`}
              >
                {isAr ? "كامل الأسبوع" : "All Week"}
              </button>
              {DAYS_OF_WEEK.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setSelectedDayFilter(d.index)}
                  className={`relative rounded-lg px-2 py-1 text-xs transition-colors cursor-pointer ${
                    selectedDayFilter === d.index
                      ? "bg-white text-teal-800 shadow-xs font-semibold dark:bg-slate-700 dark:text-teal-300"
                      : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                  }`}
                >
                  <span>{isAr ? d.shortAr : d.shortEn}</span>
                  {weekSchedule.find((ws) => ws.index === d.index)?.hasConflicts && (
                    <span className="absolute top-1 end-1 size-1 rounded-full bg-rose-500" />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ─────────────────────────────────────────────────────────────────────────────
            HOVER INSTRUCTION BANNER
           ───────────────────────────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-2 bg-gradient-to-r from-teal-50 via-sky-50 to-indigo-50 px-6 py-2 text-xs text-teal-900 dark:from-teal-950/40 dark:via-sky-950/30 dark:to-indigo-950/40 dark:text-teal-200 border-b border-teal-100 dark:border-teal-900/50">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-teal-600 dark:text-teal-400 shrink-0" />
            <span>
              {isAr
                ? "مرر مؤشر الفأرة (Cursor Hover) فوق أي دواء لمعرفة كيفية تفادي وتجنب التفاعل الدوائي وقواعد الفصل الزمني الذكية."
                : "Hover your cursor over any medication card to reveal how to avoid the interaction and smart timing separation rules."}
            </span>
          </div>
          <span className="hidden sm:inline-flex text-[11px] text-teal-700 dark:text-teal-400 font-medium">
            {isAr ? "انقر على الدواء لتثبيت الشرح" : "Click card to pin details"}
          </span>
        </div>

        {/* ─────────────────────────────────────────────────────────────────────────────
            MAIN SCROLLABLE 7-DAY SCHEDULE VIEW
           ───────────────────────────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto overflow-x-auto p-4 sm:p-6 bg-slate-50/50 dark:bg-slate-950/40">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-3 min-w-[700px] lg:min-w-0">
            {weekSchedule
              .filter((day) => selectedDayFilter === "ALL" || selectedDayFilter === day.index)
              .map((day) => {
                const visibleDoses = onlyConflicts
                  ? day.doses.filter((d) => d.conflicts.length > 0)
                  : day.doses;

                return (
                  <div
                    key={day.key}
                    className={`flex flex-col rounded-2xl border transition-all ${
                      day.hasMajorConflict
                        ? "border-rose-300/80 bg-rose-50/30 dark:border-rose-900/60 dark:bg-rose-950/10"
                        : day.hasConflicts
                          ? "border-amber-300/80 bg-amber-50/30 dark:border-amber-900/60 dark:bg-amber-950/10"
                          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/80"
                    }`}
                  >
                    {/* Day Column Header */}
                    <div
                      className={`flex items-center justify-between border-b px-3.5 py-2.5 rounded-t-2xl ${
                        day.hasMajorConflict
                          ? "border-rose-200 bg-rose-100/60 text-rose-950 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200"
                          : day.hasConflicts
                            ? "border-amber-200 bg-amber-100/60 text-amber-950 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
                            : "border-slate-200 bg-slate-100/70 text-slate-800 dark:border-slate-800 dark:bg-slate-800/60 dark:text-slate-200"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-bold">{isAr ? day.labelAr : day.labelEn}</span>
                      </div>

                      <div className="flex items-center gap-1">
                        {day.hasMajorConflict && (
                          <span
                            className="size-2 rounded-full bg-rose-500 animate-pulse"
                            title={isAr ? "يوجد تعارض حرج اليوم" : "Major conflict today"}
                          />
                        )}
                        <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                          {visibleDoses.length} {isAr ? "جرعات" : "doses"}
                        </span>
                      </div>
                    </div>

                    {/* Doses List for this Day */}
                    <div className="flex-1 p-2 space-y-2">
                      {visibleDoses.length === 0 ? (
                        <div className="flex flex-col items-center justify-center p-6 text-center text-slate-400 dark:text-slate-600">
                          <Clock className="size-6 mb-1 opacity-40" />
                          <p className="text-xs">
                            {onlyConflicts
                              ? isAr
                                ? "لا يوجد تعارضات اليوم"
                                : "No conflicts today"
                              : isAr
                                ? "لا توجد جرعات"
                                : "No scheduled doses"}
                          </p>
                        </div>
                      ) : (
                        visibleDoses.map((dose, idx) => {
                          const doseKey = `${day.key}-${dose.medicationId}-${dose.time}-${idx}`;
                          const isPinned = pinnedDoseKey === doseKey;

                          return (
                            <DoseCardWithHoverAvoidance
                              key={doseKey}
                              dose={dose}
                              dayKey={day.key}
                              isPinned={isPinned}
                              onTogglePin={() => setPinnedDoseKey(isPinned ? null : doseKey)}
                              isAr={isAr}
                            />
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          {/* ─────────────────────────────────────────────────────────────────────────────
              AS-NEEDED (PRN) MEDICATIONS SECTION
             ───────────────────────────────────────────────────────────────────────────── */}
          {prnMedications.length > 0 && (
            <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900 shadow-xs">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2.5 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                    <Pill className="size-4" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                      {isAr ? "أدوية عند اللزوم (PRN Medications)" : "As-Needed (PRN) Medications"}
                    </h3>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {isAr
                        ? "أدوية ليس لها مواعيد يومية ثابتة ولكن تخضع لفحص التفاعلات مع الأدوية المجدولة"
                        : "Medications taken as needed, evaluated against scheduled daily medications"}
                    </p>
                  </div>
                </div>
                <span className="rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                  {prnMedications.length} {isAr ? "دواء" : "meds"}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {prnMedications.map((prn) => {
                  const prnInteractions = interactions.filter((i) => {
                    const norm = prn.medicationNameText.toLowerCase();
                    const a = i.ingredientA.name.toLowerCase();
                    const b = i.ingredientB.name.toLowerCase();
                    return norm.includes(a) || norm.includes(b);
                  });

                  const hasConflict = prnInteractions.length > 0;
                  const isMajor = prnInteractions.some((i) => i.severity === "MAJOR");

                  return (
                    <div
                      key={prn.id}
                      className={`rounded-xl border p-3 ${
                        isMajor
                          ? "border-rose-300 bg-rose-50/50 dark:border-rose-900/60 dark:bg-rose-950/20"
                          : hasConflict
                            ? "border-amber-300 bg-amber-50/50 dark:border-amber-900/60 dark:bg-amber-950/20"
                            : "border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-800/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                          {prn.medicationNameText}
                        </span>
                        <span className="rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                          {isAr ? "عند اللزوم" : "PRN"}
                        </span>
                      </div>
                      {prn.doseAmountText && (
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                          {prn.doseAmountText}
                        </p>
                      )}
                      {hasConflict && (
                        <div className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-rose-700 dark:text-rose-400">
                          <AlertTriangle className="size-3 shrink-0" />
                          <span>
                            {isAr
                              ? `تعارض مع ${prnInteractions.length} دواء مجدول`
                              : `Interacts with ${prnInteractions.length} scheduled med(s)`}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* ─────────────────────────────────────────────────────────────────────────────
            MODAL FOOTER
           ───────────────────────────────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/90 px-6 py-3.5 dark:border-slate-800 dark:bg-slate-900/90 shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Info className="size-4 text-teal-600 dark:text-teal-400 shrink-0" />
            <span>
              {isAr
                ? "قواعد الفصل الزمني والتوجيهات السريرية مستخرجة من قاعدة بيانات DDInter 2.0 ومراجع الهيئة العامة للغذاء والدواء."
                : "Timing separation rules and clinical guidance derived from DDInter 2.0 and approved prescribing information."}
            </span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-200 bg-white px-4 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            {isAr ? "إغلاق الجدول" : "Close Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Individual Scheduled Dose Card with Hover Popover displaying "How to Avoid the Interaction".
 */
function DoseCardWithHoverAvoidance({
  dose,
  dayKey,
  isPinned,
  onTogglePin,
  isAr,
}: {
  dose: DoseSlot;
  dayKey: string;
  isPinned: boolean;
  onTogglePin: () => void;
  isAr: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const showAvoidance = isHovered || isPinned;

  const hasConflicts = dose.conflicts.length > 0;
  const isMajor = dose.hasMajorConflict;

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onTogglePin}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onTogglePin();
          }
        }}
        className={`group relative flex flex-col rounded-xl border p-2.5 transition-all cursor-pointer select-none text-start ${
          isMajor
            ? isPinned
              ? "border-rose-500 bg-rose-100/90 shadow-md ring-2 ring-rose-400/50 dark:border-rose-600 dark:bg-rose-950/70"
              : "border-rose-300 bg-rose-50/90 hover:border-rose-400 hover:bg-rose-100/70 dark:border-rose-900/70 dark:bg-rose-950/40 dark:hover:border-rose-800"
            : hasConflicts
              ? isPinned
                ? "border-amber-500 bg-amber-100/90 shadow-md ring-2 ring-amber-400/50 dark:border-amber-600 dark:bg-amber-950/70"
                : "border-amber-300 bg-amber-50/80 hover:border-amber-400 hover:bg-amber-100/70 dark:border-amber-900/70 dark:bg-amber-950/40 dark:hover:border-amber-800"
              : "border-slate-200 bg-white hover:border-teal-300 hover:shadow-xs dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
        }`}
      >
        {/* Time of Day & Severity Ping */}
        <div className="flex items-center justify-between gap-1 mb-1">
          <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-800 tabular-nums dark:bg-slate-800 dark:text-slate-200">
            <Clock className="size-3 text-teal-600 dark:text-teal-400" />
            <span dir="ltr">{dose.time}</span>
          </span>

          {hasConflicts && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.2 text-[9px] font-bold ${
                isMajor
                  ? "bg-rose-500 text-white animate-pulse"
                  : "bg-amber-500 text-white"
              }`}
            >
              <AlertTriangle className="size-2.5" />
              <span>{isMajor ? (isAr ? "حرج" : "Major") : isAr ? "متوسط" : "Mod"}</span>
            </span>
          )}
        </div>

        {/* Drug Name & Dosage */}
        <p className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">
          {dose.medicationName}
        </p>

        {dose.doseAmount && (
          <p className="text-[10px] text-slate-500 dark:text-slate-400 truncate">
            {dose.doseAmount}
          </p>
        )}

        {/* Conflict indicator subtitle */}
        {hasConflicts && (
          <div className="mt-1.5 pt-1.5 border-t border-rose-200/60 dark:border-rose-900/40 flex items-center justify-between text-[10px]">
            <span
              className={`font-semibold ${
                isMajor ? "text-rose-700 dark:text-rose-300" : "text-amber-700 dark:text-amber-300"
              }`}
            >
              {isAr ? "تعارض دوائي!" : "DDI Conflict!"}
            </span>
            <span className="text-slate-400 group-hover:text-teal-600 dark:group-hover:text-teal-400 transition-colors">
              {isAr ? "طريقة الحل ↖" : "Avoidance ↗"}
            </span>
          </div>
        )}
      </div>

      {/* ─────────────────────────────────────────────────────────────────────────────
          THE HOVER POPOVER CARD: HOW TO AVOID THE INTERACTION
         ───────────────────────────────────────────────────────────────────────────── */}
      {showAvoidance && (
        <div
          className={`absolute z-50 w-80 sm:w-96 rounded-2xl bg-white p-4 shadow-2xl border-2 dark:bg-slate-900 transition-all animate-in fade-in zoom-in-95 duration-150 ${
            isMajor
              ? "border-rose-500/90 ring-4 ring-rose-500/10"
              : hasConflicts
                ? "border-amber-500/90 ring-4 ring-amber-500/10"
                : "border-teal-500/80 ring-4 ring-teal-500/10"
          } ${
            // Smart positioning: flip popover left/right to stay visible within screen
            dayKey === "thursday" || dayKey === "friday"
              ? "end-0 sm:end-0 -top-2 translate-y-[-100%]"
              : "start-0 sm:start-0 -top-2 translate-y-[-100%]"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Popover Header */}
          <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-2.5 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <div
                className={`flex size-7 items-center justify-center rounded-lg ${
                  isMajor
                    ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                    : hasConflicts
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                      : "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300"
                }`}
              >
                {hasConflicts ? <AlertTriangle className="size-4" /> : <ShieldCheck className="size-4" />}
              </div>
              <div>
                <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                  <span>{dose.medicationName}</span>
                  <span className="text-slate-400 font-normal">(@ {dose.time})</span>
                </h4>
                <p className="text-[10px] text-slate-500 dark:text-slate-400">
                  {hasConflicts
                    ? isAr
                      ? `تم رصد تعارض مع أدوية أخرى بهذا الجدول`
                      : `Conflict detected with active regimen`
                    : isAr
                      ? "دواء آمن - لا توجد تفاعلات مرصودة"
                      : "Safe - No conflicts detected"}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onTogglePin}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-0.5 cursor-pointer"
              title={isAr ? "إغلاق" : "Close"}
            >
              <X className="size-4" />
            </button>
          </div>

          {/* If No Conflicts */}
          {!hasConflicts && (
            <div className="pt-3 text-xs text-slate-600 dark:text-slate-300 space-y-1">
              <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-semibold">
                <CheckCircle2 className="size-4" />
                <span>{isAr ? "توافق علاجي ممتاز" : "Excellent Compatibility"}</span>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                {isAr
                  ? "لا يوجد أي تعارض مسجل لهذا الدواء مع باقي الأدوية النشطة للمريض في قاعدة بيانات DDInter 2.0."
                  : "No recorded interactions with any of the patient's other active medications."}
              </p>
            </div>
          )}

          {/* If Conflicts Exist: Display Detailed "How to Avoid" Guide */}
          {hasConflicts && (
            <div className="pt-3 space-y-3">
              {dose.conflicts.map((conflict, cIdx) => (
                <div
                  key={cIdx}
                  className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-800/50 space-y-2.5"
                >
                  {/* Interacting Pair & Severity */}
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
                      <span>{dose.medicationName}</span>
                      <ArrowRightLeft className="size-3 text-slate-400" />
                      <span className="text-rose-600 dark:text-rose-400">
                        {conflict.interactingMedName}
                      </span>
                    </div>

                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                        conflict.severity === "MAJOR"
                          ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                          : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                      }`}
                    >
                      {conflict.severity === "MAJOR"
                        ? isAr
                          ? "حرج / Major"
                          : "Major Conflict"
                        : isAr
                          ? "متوسط / Moderate"
                          : "Moderate Conflict"}
                    </span>
                  </div>

                  {/* Immediate Same-Time Collision Warning */}
                  {conflict.avoidanceStrategy.sameTimeAlert && (
                    <div className="rounded-lg border border-rose-300 bg-rose-100/90 p-2 text-[11px] font-bold text-rose-950 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200 flex items-start gap-1.5">
                      <AlertOctagon className="size-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
                      <span>{conflict.avoidanceStrategy.sameTimeAlert}</span>
                    </div>
                  )}

                  {/* Mechanism / Clinical Risk */}
                  {conflict.interaction.mechanism && (
                    <div className="text-[11px] text-slate-600 dark:text-slate-400">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {isAr ? "الخطر والآلية الدوائية: " : "Clinical Risk: "}
                      </span>
                      <span>{conflict.interaction.mechanism}</span>
                    </div>
                  )}

                  {/* ──────────────── HIGHLIGHT: HOW TO AVOID THE INTERACTION ──────────────── */}
                  <div className="rounded-lg border-2 border-teal-300/80 bg-teal-50/90 p-2.5 dark:border-teal-800 dark:bg-teal-950/60 space-y-1.5 shadow-xs">
                    <div className="flex items-center gap-1.5 text-xs font-bold text-teal-950 dark:text-teal-200">
                      <Sparkles className="size-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
                      <span>
                        {isAr ? "كيفية تفادي التفاعل وتجنب الخطر:" : "How to Avoid This Interaction:"}
                      </span>
                    </div>

                    {/* Avoidance Step 1: Smart Timing Separation */}
                    {conflict.avoidanceStrategy.timingRuleText ? (
                      <div className="flex items-start gap-1.5 text-[11px] text-teal-900 dark:text-teal-200 font-medium bg-white/80 p-2 rounded-md border border-teal-200 dark:bg-slate-900/80 dark:border-teal-900">
                        <Clock className="size-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                        <div>
                          <strong className="block text-teal-950 dark:text-teal-100 font-bold">
                            {isAr
                              ? `الفصل الزمني المطلوب: (${conflict.avoidanceStrategy.timingIntervalHours} ساعات على الأقل)`
                              : `Timing Separation: At least ${conflict.avoidanceStrategy.timingIntervalHours} hours apart`}
                          </strong>
                          <p className="mt-0.5 leading-relaxed">
                            {conflict.avoidanceStrategy.timingRuleText}
                          </p>
                        </div>
                      </div>
                    ) : (
                      /* General Timing Tip if no explicit hour rule */
                      <div className="text-[11px] text-teal-900 dark:text-teal-200 bg-white/80 p-1.5 rounded-md border border-teal-200 dark:bg-slate-900/80 dark:border-teal-900">
                        <span>
                          {isAr
                            ? "المباعدة الزمنية: تجنب تناول الجرعتين في نفس الساعة. افصل بينهما بفاصل مناسب لتفادي ذروة الامتصاص المشتركة."
                            : "Administration Spacing: Avoid taking both doses simultaneously. Space administration to prevent overlapping peak plasma concentrations."}
                        </span>
                      </div>
                    )}

                    {/* Avoidance Step 2: Clinical Management / Precaution */}
                    {conflict.avoidanceStrategy.managementText && (
                      <div className="text-[11px] text-slate-700 dark:text-slate-300 bg-white/70 p-2 rounded-md border border-slate-200/80 dark:bg-slate-900/60 dark:border-slate-800">
                        <strong className="block text-slate-900 dark:text-slate-100 font-semibold mb-0.5">
                          {isAr ? "إجراء الصيدلي / التوجيه العلاجي:" : "Clinical Action / Monitoring:"}
                        </strong>
                        <p className="leading-relaxed">
                          {conflict.avoidanceStrategy.managementText}
                        </p>
                      </div>
                    )}

                    {/* Reference / Source */}
                    {conflict.avoidanceStrategy.clinicalReference && (
                      <p className="text-[10px] text-slate-400 dark:text-slate-500 pt-0.5">
                        <span className="font-semibold">{isAr ? "المرجع: " : "Ref: "}</span>
                        {conflict.avoidanceStrategy.clinicalReference}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Footer Pin status */}
          <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[10px] text-slate-400">
            <span>
              {isPinned
                ? isAr
                  ? "مثبت مفتوحاً (انقر للإغلاق)"
                  : "Pinned Open (Click to close)"
                : isAr
                  ? "انقر لتثبيت النافذة مفتوحة"
                  : "Click card to keep pinned"}
            </span>
            <span className="text-teal-600 dark:text-teal-400 font-semibold">
              {isAr ? "نظام وصال السريري" : "Wesal Clinical"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
