"use client";

import { useState, useTransition } from "react";
import { buttonClass, inputClass, selectClass, textareaClass } from "@/components/ui";
import { recordClinicalInterventionDirect } from "@/server/followup/actions";

export function NewInterventionModal({
  patients,
  locale = "ar",
}: {
  patients: Array<{ id: string; fullName: string; phoneE164: string }>;
  locale?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [patientId, setPatientId] = useState(patients[0]?.id || "");
  const [medicationName, setMedicationName] = useState("");
  const [category, setCategory] = useState<
    "SIDE_EFFECT" | "DOCTOR_REFERRAL" | "DRUG_INTERACTION" | "DOSE_CLARIFICATION" | "GENERAL"
  >("SIDE_EFFECT");
  const [doctorName, setDoctorName] = useState("");
  const [notes, setNotes] = useState("");
  const [outcome, setOutcome] = useState("PATIENT_CONFIRMED");
  const [error, setError] = useState<string | null>(null);

  const isAr = locale === "ar";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!patientId) {
      setError(isAr ? "يرجى اختيار المريض" : "Please select a patient");
      return;
    }

    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("patientId", patientId);
      formData.set("category", category);
      formData.set("notes", notes.trim() + (medicationName.trim() ? ` [الدواء: ${medicationName.trim()}]` : ""));
      if (category === "DOCTOR_REFERRAL" && doctorName.trim()) {
        formData.set("doctorName", doctorName.trim());
      }
      formData.set("outcome", outcome);
      formData.set("locale", locale);

      const res = await recordClinicalInterventionDirect(formData);
      if (res.ok) {
        setIsOpen(false);
        setNotes("");
        setDoctorName("");
        setMedicationName("");
      } else {
        setError(isAr ? "حدث خطأ أثناء حفظ التدخل السريري" : "Failed to record intervention");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={buttonClass("primary", "sm")}
      >
        <span>+</span>
        <span>{isAr ? "تسجيل تدخل سريري جديد" : "Record Clinical Intervention"}</span>
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
                {isAr ? "توثيق تدخل سريري في السجل الطبي" : "Record Clinical Intervention"}
              </h3>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {isAr ? "اختيار المريض:" : "Select Patient:"}
                </label>
                <select
                  required
                  value={patientId}
                  onChange={(e) => setPatientId(e.target.value)}
                  className={selectClass}
                >
                  <option value="">{isAr ? "— اختر المريض —" : "— Select Patient —"}</option>
                  {patients.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.fullName} ({p.phoneE164})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {isAr ? "الدواء المعني (اختياري):" : "Medication (Optional):"}
                </label>
                <input
                  type="text"
                  value={medicationName}
                  onChange={(e) => setMedicationName(e.target.value)}
                  placeholder={isAr ? "مثال: ميتفورمين 500mg أو كونكور 5mg" : "e.g. Metformin 500mg"}
                  className={inputClass}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {isAr ? "تصنيف التدخل السريري:" : "Intervention Category:"}
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as typeof category)}
                  className={selectClass}
                >
                  <option value="SIDE_EFFECT">
                    {isAr ? "⚠️ التعامل مع عرض جانبي (Side Effect Management)" : "Side Effect Management"}
                  </option>
                  <option value="DOCTOR_REFERRAL">
                    {isAr ? "👨‍⚕️ تحويل إلى الطبيب المعالج (Doctor Referral)" : "Referral to Physician"}
                  </option>
                  <option value="DRUG_INTERACTION">
                    {isAr ? "💊🔄💊 تداخل دوائي (Drug-Drug Interaction)" : "Drug-Drug Interaction"}
                  </option>
                  <option value="DOSE_CLARIFICATION">
                    {isAr ? "ℹ️ توضيح الجرعة وتثقيف دوائي (Dose Clarification & Education)" : "Dose Clarification"}
                  </option>
                  <option value="GENERAL">
                    {isAr ? "متابعة واستشارة صيدلانية عامة" : "General Clinical Consultation"}
                  </option>
                </select>
              </div>

              {category === "DOCTOR_REFERRAL" && (
                <div className="p-3 rounded-xl border border-teal-200 bg-teal-50/50 dark:border-teal-900/60 dark:bg-teal-950/20">
                  <label className="block text-xs font-semibold text-teal-900 dark:text-teal-200 mb-1">
                    {isAr ? "اسم الطبيب المحول إليه وتخصصه:" : "Referred Doctor Name & Specialty:"}
                  </label>
                  <input
                    type="text"
                    required
                    value={doctorName}
                    onChange={(e) => setDoctorName(e.target.value)}
                    placeholder={isAr ? "مثال: د. طارق محمود - أخصائي القلب" : "e.g. Dr. Tarek (Cardiologist)"}
                    className={inputClass}
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {isAr ? "نتيجة التواصل مع المريض:" : "Consultation Outcome:"}
                </label>
                <select
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                  className={selectClass}
                >
                  <option value="PATIENT_CONFIRMED">
                    {isAr ? "أكد المريض فهمه واتباع التوجيه الصيدلاني" : "Patient confirmed understanding"}
                  </option>
                  <option value="REACHED">
                    {isAr ? "تم التواصل وشرح الحالة" : "Reached & advised"}
                  </option>
                  <option value="LEFT_MESSAGE">
                    {isAr ? "تم ترك رسالة توجيهية للمريض" : "Left message"}
                  </option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  {isAr ? "تفاصيل الإجراء والملاحظات السريرية:" : "Action Taken & Clinical Notes:"}
                </label>
                <textarea
                  rows={3}
                  required
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={
                    category === "SIDE_EFFECT"
                      ? isAr ? "تفاصيل العرض الجانبي والإرشاد المقدم للمريض لتقليل أثره..." : "Details of side effect and advice..."
                      : category === "DRUG_INTERACTION"
                      ? isAr ? "الأدوية المتداخلة والإجراء المتخذ (فصل المواعيد / استشارة الطبيب)..." : "Interacting drugs and action..."
                      : isAr ? "تفاصيل التدخل الطبي والتوجيه المقدم للمريض..." : "Details of clinical intervention..."
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
                    : isAr ? "حفظ التدخل في السجل" : "Save Intervention"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

