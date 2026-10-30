"use client";

import { useState, useTransition } from "react";
import { buttonClass, inputClass, selectClass, textareaClass } from "@/components/ui";
import { quickResolveProblemCase } from "@/server/followup/actions";

export function QuickResolveModal({
  caseId,
  patientName,
  medicationName,
  problemSummary,
  locale = "ar",
}: {
  caseId: string;
  patientName: string;
  medicationName: string;
  problemSummary: string;
  locale?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [category, setCategory] = useState<
    "SIDE_EFFECT" | "DOCTOR_REFERRAL" | "DRUG_INTERACTION" | "DOSE_CLARIFICATION" | "GENERAL"
  >("GENERAL");
  const [doctorName, setDoctorName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isAr = locale === "ar";

  function handleResolve(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    startTransition(async () => {
      const formData = new FormData();
      formData.set("caseId", caseId);
      formData.set("category", category);
      formData.set("notes", notes.trim() || (isAr ? "تم التواصل وحل المشكلة بنجاح" : "Problem resolved"));
      if (category === "DOCTOR_REFERRAL" && doctorName.trim()) {
        formData.set("doctorName", doctorName.trim());
      }
      formData.set("locale", locale);

      const result = await quickResolveProblemCase(formData);
      if (result.ok) {
        setIsOpen(false);
      } else {
        setError(isAr ? "حدث خطأ أثناء حفظ الإجراء، يرجى المحاولة ثانية" : "Failed to resolve problem");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-2.5 py-1.5 text-xs font-semibold text-teal-800 transition hover:bg-teal-100 hover:border-teal-300 dark:border-teal-800/60 dark:bg-teal-950/40 dark:text-teal-300 dark:hover:bg-teal-900/50"
        title={isAr ? "حل المشكلة وتوثيق التدخل الصيدلاني" : "Resolve Problem"}
      >
        <span aria-hidden="true" className="text-teal-600 dark:text-teal-400">✓</span>
        <span>{isAr ? "تم حل المشكلة" : "Resolve"}</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl border border-slate-200 dark:bg-slate-900 dark:border-slate-800"
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3 dark:border-slate-800">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {isAr ? "حل المشكلة الدوائية وتوثيق التدخل السريري" : "Resolve Problem & Log Intervention"}
              </h3>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleResolve} className="mt-4 space-y-4">
              <div className="rounded-xl bg-slate-50 p-3 text-xs dark:bg-slate-800/60 space-y-1">
                <p>
                  <span className="font-semibold text-slate-600 dark:text-slate-400">
                    {isAr ? "المريض:" : "Patient:"}
                  </span>{" "}
                  <span className="font-medium text-slate-900 dark:text-slate-200">{patientName}</span>
                </p>
                <p>
                  <span className="font-semibold text-slate-600 dark:text-slate-400">
                    {isAr ? "الدواء:" : "Medication:"}
                  </span>{" "}
                  <span className="font-medium text-slate-900 dark:text-slate-200">{medicationName}</span>
                </p>
                <p>
                  <span className="font-semibold text-slate-600 dark:text-slate-400">
                    {isAr ? "تفاصيل المشكلة:" : "Issue:"}
                  </span>{" "}
                  <span className="text-amber-800 dark:text-amber-300">{problemSummary}</span>
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {isAr ? "نوع التدخل / تصنيف المشكلة:" : "Intervention Category:"}
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as typeof category)}
                  className={selectClass}
                >
                  <option value="GENERAL">{isAr ? "حل مباشر وتثقيف دوائي عام" : "General Resolution & Education"}</option>
                  <option value="SIDE_EFFECT">{isAr ? "التعامل مع عرض جانبي (Side Effect Management)" : "Side Effect Management"}</option>
                  <option value="DOCTOR_REFERRAL">{isAr ? "تحويل إلى الطبيب المعالج (Doctor Referral)" : "Referral to Physician"}</option>
                  <option value="DRUG_INTERACTION">{isAr ? "تداخل دوائي (Drug-Drug Interaction)" : "Drug-Drug Interaction"}</option>
                  <option value="DOSE_CLARIFICATION">{isAr ? "توضيح / تعديل الجرعة (Dose Clarification)" : "Dose Clarification"}</option>
                </select>
              </div>

              {category === "DOCTOR_REFERRAL" && (
                <div className="p-3 rounded-xl border border-teal-200 bg-teal-50/50 dark:border-teal-900/60 dark:bg-teal-950/20">
                  <label className="block text-xs font-semibold text-teal-900 dark:text-teal-200 mb-1">
                    {isAr ? "اسم الطبيب المعالج المحول إليه:" : "Referred Doctor Name:"}
                  </label>
                  <input
                    type="text"
                    required
                    value={doctorName}
                    onChange={(e) => setDoctorName(e.target.value)}
                    placeholder={isAr ? "مثال: د. أحمد رضوان (طبيب الباطنة)" : "e.g. Dr. Ahmed"}
                    className={inputClass}
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {isAr ? "ملاحظات وتوجيهات الصيدلي (سجل التدخل السريري):" : "Clinical Notes & Advice:"}
                </label>
                <textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={
                    category === "SIDE_EFFECT"
                      ? isAr ? "تم إرشاد المريض بتناول الدواء بعد الطعام لتقليل الغثيان ومراقبة الأعراض..." : "Advised patient on taking with food..."
                      : category === "DRUG_INTERACTION"
                      ? isAr ? "تم تنبيه المريض بفصل مواعيد تناول الدواءين بساعتين على الأقل..." : "Advised on 2hr spacing..."
                      : isAr ? "تفاصيل التواصل مع المريض وما تم الاتفاق عليه..." : "Details of consultation..."
                  }
                  className={textareaClass}
                />
              </div>

              {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  disabled={isPending}
                  className={buttonClass("secondary", "sm")}
                >
                  {isAr ? "إلغاء" : "Cancel"}
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className={buttonClass("primary", "sm")}
                >
                  {isPending
                    ? isAr ? "جاري الحفظ..." : "Saving..."
                    : isAr ? "تأكيد حل المشكلة وتسجيل التدخل" : "Confirm & Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

