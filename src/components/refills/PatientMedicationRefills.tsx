"use client";

import { useState, useTransition } from "react";
import { Pill } from "@/components/status";
import { buttonClass } from "@/components/ui";
import { updateRefillStatusAction, adjustRefillDateAction } from "@/server/refills/actions";

export type RefillData = {
  id: string;
  cycleNumber: number;
  status: "PENDING" | "STOCK_ORDERED" | "READY_FOR_COLLECTION" | "DISPENSED";
  packagesNeeded: number;
  daysSupply: number | null;
  expectedRunOutOn: Date | string | null;
  refillDueOn: Date | string | null;
  dispensedAtUtc: Date | string | null;
  patientRemindedAtUtc: Date | string | null;
  pharmacyWarnedAtUtc: Date | string | null;
  isUnconfirmedOverdue: boolean;
  inventoryAvailable: boolean | null;
  notes: string | null;
};

export type MedicationRefillProps = {
  medication: {
    id: string;
    medicationNameText: string;
    prescriberDoctorName: string | null;
    prescriberDoctorPhone: string | null;
    unitsPerPackage: number | null;
    unitsPerDose: number | null;
    dosesPerDay: number | null;
    treatmentDurationValue: number | null;
    treatmentDurationUnit: string | null;
    refills?: RefillData[];
  };
  patient: {
    id: string;
    fullName: string;
    phoneE164: string;
  };
  canManage: boolean;
  locale: string;
};

export function PatientMedicationRefills({
  medication,
  patient,
  canManage,
  locale,
}: MedicationRefillProps) {
  const isAr = locale === "ar";
  const [isPending, startTransition] = useTransition();
  const [isEditingDate, setIsEditingDate] = useState(false);
  const [adjustedDate, setAdjustedDate] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const cleanDoctorPhone = medication.prescriberDoctorPhone
    ? medication.prescriberDoctorPhone.replace(/[^0-9]/g, "")
    : null;

  const refills = medication.refills ?? [];
  // Active/latest refill is the highest cycle number or un-dispensed
  const activeRefill =
    refills.find((r) => r.status !== "DISPENSED") ??
    (refills.length > 0 ? refills[refills.length - 1] : null);

  const pastRefills = refills.filter((r) => r.id !== activeRefill?.id && r.status === "DISPENSED");

  // Calculate days remaining
  let daysRemaining: number | null = null;
  if (activeRefill?.expectedRunOutOn) {
    const depletion = new Date(activeRefill.expectedRunOutOn);
    const now = new Date();
    const diff = Math.ceil((depletion.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    daysRemaining = diff;
  }

  const handleStatusChange = (refillId: string, status: string) => {
    setActionError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.append("refillId", refillId);
      formData.append("status", status);
      const res = await updateRefillStatusAction(formData);
      if (!res.ok) {
        setActionError(isAr ? "فشل تحديث حالة إعادة الصرف" : "Failed to update refill status");
      }
    });
  };

  const handleDateAdjust = (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeRefill || !adjustedDate) return;
    setActionError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.append("refillId", activeRefill.id);
      formData.append("expectedRunOutOn", adjustedDate);
      formData.append("refillDueOn", adjustedDate);
      const res = await adjustRefillDateAction(formData);
      if (res.ok) {
        setIsEditingDate(false);
      } else {
        setActionError(isAr ? "فشل تعديل تاريخ إعادة الصرف" : "Failed to adjust refill date");
      }
    });
  };

  const getStatusTone = (status: string) => {
    switch (status) {
      case "DISPENSED":
        return "good";
      case "READY_FOR_COLLECTION":
        return "good";
      case "STOCK_ORDERED":
        return "warn";
      case "PENDING":
      default:
        return "neutral";
    }
  };

  const getStatusLabel = (status: string) => {
    if (isAr) {
      switch (status) {
        case "PENDING":
          return "قيد الانتظار";
        case "STOCK_ORDERED":
          return "تم طلب المخزون";
        case "READY_FOR_COLLECTION":
          return "جاهز للاستلام";
        case "DISPENSED":
          return "تم الصرف";
        default:
          return status;
      }
    }
    switch (status) {
      case "PENDING":
        return "Pending";
      case "STOCK_ORDERED":
        return "Stock Ordered";
      case "READY_FOR_COLLECTION":
        return "Ready for Collection";
      case "DISPENSED":
        return "Dispensed";
      default:
        return status;
    }
  };

  const formatDisplayDate = (d: Date | string | null | undefined) => {
    if (!d) return "—";
    const date = new Date(d);
    return date.toLocaleDateString(locale === "ar" ? "ar-SA" : "en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const formatDateInputValue = (d: Date | string | null | undefined) => {
    if (!d) return "";
    const date = new Date(d);
    return date.toISOString().slice(0, 10);
  };

  const durationUnitLabel = (unit: string | null) => {
    if (!unit) return "";
    if (isAr) {
      switch (unit) {
        case "DAYS":
          return "يوم";
        case "WEEKS":
          return "أسبوع";
        case "MONTHS":
          return "شهر";
        default:
          return unit;
      }
    }
    return unit.toLowerCase();
  };

  const doctorGreeting = isAr
    ? encodeURIComponent(
        `السلام عليكم دكتور ${medication.prescriberDoctorName || ""}، بخصوص وصفة المريض ${patient.fullName} لدواء ${medication.medicationNameText}.`
      )
    : encodeURIComponent(
        `Hello Dr. ${medication.prescriberDoctorName || ""}, regarding patient ${patient.fullName}'s prescription for ${medication.medicationNameText}.`
      );

  const hasTrackingData =
    medication.prescriberDoctorName ||
    medication.unitsPerPackage ||
    medication.treatmentDurationValue ||
    activeRefill;

  if (!hasTrackingData) {
    return null;
  }

  return (
    <div className="mt-4 rounded-xl border border-sky-100 bg-sky-50/40 p-4 text-sm dark:border-sky-950 dark:bg-sky-950/20">
      <div className="space-y-4">
        {/* Prescribing Doctor Information */}
        {medication.prescriberDoctorName ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-sky-100/70 pb-3 dark:border-sky-900/40">
            <div className="space-y-0.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-sky-800 dark:text-sky-300">
                {isAr ? "الطبيب المعالج والواصف" : "Prescribing Doctor"}
              </span>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  {medication.prescriberDoctorName}
                </span>
                {medication.prescriberDoctorPhone ? (
                  <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400" dir="ltr">
                    ({medication.prescriberDoctorPhone})
                  </span>
                ) : null}
              </div>
            </div>

            {/* Quick Contact Actions */}
            {medication.prescriberDoctorPhone ? (
              <div className="flex items-center gap-2">
                <a
                  href={`tel:${medication.prescriberDoctorPhone}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  title={isAr ? "اتصال بالطبيب" : "Call Doctor"}
                >
                  <svg className="h-3.5 w-3.5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  <span>{isAr ? "اتصال" : "Call"}</span>
                </a>
                {cleanDoctorPhone ? (
                  <a
                    href={`https://wa.me/${cleanDoctorPhone}?text=${doctorGreeting}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-700"
                    title={isAr ? "مراسلة عبر واتساب" : "Message on WhatsApp"}
                  >
                    <svg className="h-3.5 w-3.5 fill-current" viewBox="0 0 24 24">
                      <path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.711 2.598 2.664-.698c.993.54 1.787.778 2.796.779 3.18 0 5.766-2.586 5.767-5.766 0-3.18-2.586-5.766-5.767-5.766zm3.374 8.16c-.14.394-.71.748-1.026.792-.317.045-.733.155-2.482-.572-1.748-.727-2.859-2.502-2.946-2.618-.088-.116-.71-1.01-.71-1.927 0-.917.478-1.368.648-1.543.17-.175.372-.218.497-.218.125 0 .25.002.359.007.115.006.269-.044.42.323.156.377.531 1.297.577 1.39.047.094.078.204.016.327-.063.123-.094.2-.188.311-.093.111-.197.247-.281.332-.094.094-.192.196-.083.383.109.187.484.798 1.037 1.291.713.636 1.314.833 1.501.926.187.093.296.078.406-.047.109-.125.468-.545.593-.732.125-.187.25-.156.421-.093.172.062 1.09.514 1.277.608.187.094.312.14.359.218.046.079.046.453-.094.848z" />
                    </svg>
                    <span>{isAr ? "واتساب" : "WhatsApp"}</span>
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Treatment Duration & Consumption Metrics */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
          {medication.unitsPerPackage ? (
            <div className="rounded-lg bg-white/70 p-2 shadow-xs dark:bg-slate-900/50">
              <span className="text-slate-500 dark:text-slate-400">
                {isAr ? "حجم العبوة" : "Package Size"}
              </span>
              <p className="mt-0.5 font-semibold text-slate-800 dark:text-slate-200">
                {medication.unitsPerPackage} {isAr ? "وحدة/قرص" : "units"}
              </p>
            </div>
          ) : null}

          {medication.unitsPerDose && medication.dosesPerDay ? (
            <div className="rounded-lg bg-white/70 p-2 shadow-xs dark:bg-slate-900/50">
              <span className="text-slate-500 dark:text-slate-400">
                {isAr ? "الجرعة اليومية" : "Daily Dosage"}
              </span>
              <p className="mt-0.5 font-semibold text-slate-800 dark:text-slate-200">
                {medication.unitsPerDose} × {medication.dosesPerDay} (
                {medication.unitsPerDose * medication.dosesPerDay} {isAr ? "يومياً" : "/day"})
              </p>
            </div>
          ) : null}

          {medication.treatmentDurationValue ? (
            <div className="rounded-lg bg-white/70 p-2 shadow-xs dark:bg-slate-900/50">
              <span className="text-slate-500 dark:text-slate-400">
                {isAr ? "مدة العلاج الكلية" : "Total Treatment"}
              </span>
              <p className="mt-0.5 font-semibold text-slate-800 dark:text-slate-200">
                {medication.treatmentDurationValue} {durationUnitLabel(medication.treatmentDurationUnit)}
              </p>
            </div>
          ) : null}

          {activeRefill ? (
            <div className="rounded-lg bg-white/70 p-2 shadow-xs dark:bg-slate-900/50">
              <span className="text-slate-500 dark:text-slate-400">
                {isAr ? "العبوات المطلوبة للدورة" : "Packages Required"}
              </span>
              <p className="mt-0.5 font-semibold text-slate-800 dark:text-slate-200">
                {activeRefill.packagesNeeded} {isAr ? "عبوة" : "pkgs"}
              </p>
            </div>
          ) : null}
        </div>

        {/* Current Active Refill Cycle */}
        {activeRefill ? (
          <div className="rounded-xl border border-sky-200/60 bg-white p-3.5 shadow-xs dark:border-sky-800/40 dark:bg-slate-900">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    {isAr ? `دورة إعادة الصرف #${activeRefill.cycleNumber}` : `Refill Cycle #${activeRefill.cycleNumber}`}
                  </span>
                  <Pill tone={getStatusTone(activeRefill.status)}>
                    {getStatusLabel(activeRefill.status)}
                  </Pill>
                  {activeRefill.isUnconfirmedOverdue ? (
                    <Pill tone="critical">
                      {isAr ? "متأخر وغير مؤكد" : "Overdue Unconfirmed"}
                    </Pill>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
                  <span>
                    {isAr ? "تاريخ النفاد المتوقع: " : "Expected Depletion: "}
                    <strong className="text-slate-800 dark:text-slate-200">
                      {formatDisplayDate(activeRefill.expectedRunOutOn)}
                    </strong>
                  </span>

                  {daysRemaining !== null ? (
                    <span>
                      {isAr ? "المتبقي: " : "Remaining: "}
                      <strong
                        className={
                          daysRemaining <= 1
                            ? "text-rose-600 font-bold"
                            : daysRemaining <= 5
                            ? "text-amber-600 font-bold"
                            : "text-slate-800 dark:text-slate-200"
                        }
                      >
                        {daysRemaining > 0
                          ? isAr
                            ? `${daysRemaining} يوم`
                            : `${daysRemaining} days`
                          : isAr
                          ? "نفد أو مستحق اليوم"
                          : "Depleted / Due Today"}
                      </strong>
                    </span>
                  ) : null}

                  {canManage ? (
                    <button
                      type="button"
                      onClick={() => {
                        setAdjustedDate(formatDateInputValue(activeRefill.expectedRunOutOn));
                        setIsEditingDate(!isEditingDate);
                      }}
                      className="text-xs font-medium text-sky-600 underline hover:text-sky-800 dark:text-sky-400"
                    >
                      {isEditingDate
                        ? isAr
                          ? "إلغاء التعديل"
                          : "Cancel"
                        : isAr
                        ? "تعديل موعد الصرف"
                        : "Adjust Date"}
                    </button>
                  ) : null}
                </div>
              </div>

              {/* Status Action Buttons for Pharmacist */}
              {canManage && activeRefill.status !== "DISPENSED" ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {activeRefill.status === "PENDING" ? (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => handleStatusChange(activeRefill.id, "STOCK_ORDERED")}
                      className={buttonClass("secondary", "xs")}
                    >
                      {isAr ? "طلب المخزون" : "Order Stock"}
                    </button>
                  ) : null}

                  {activeRefill.status === "PENDING" || activeRefill.status === "STOCK_ORDERED" ? (
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => handleStatusChange(activeRefill.id, "READY_FOR_COLLECTION")}
                      className={buttonClass("secondary", "xs")}
                    >
                      {isAr ? "جاهز للاستلام" : "Ready for Pickup"}
                    </button>
                  ) : null}

                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => handleStatusChange(activeRefill.id, "DISPENSED")}
                    className={buttonClass("primary", "xs")}
                  >
                    {isAr ? "صرف وتجديد الدورة ✓" : "Dispense & Cycle ✓"}
                  </button>
                </div>
              ) : null}
            </div>

            {/* Date Adjustment Form */}
            {isEditingDate ? (
              <form onSubmit={handleDateAdjust} className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                <span className="text-xs text-slate-500">
                  {isAr ? "تاريخ النفاد/الصرف الجديد:" : "New depletion/refill date:"}
                </span>
                <input
                  type="date"
                  required
                  value={adjustedDate}
                  onChange={(e) => setAdjustedDate(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900 shadow-xs focus:border-sky-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
                <button
                  type="submit"
                  disabled={isPending}
                  className={buttonClass("primary", "xs")}
                >
                  {isAr ? "حفظ التاريخ" : "Save Date"}
                </button>
              </form>
            ) : null}

            {actionError ? (
              <p className="mt-2 text-xs font-medium text-rose-600 dark:text-rose-400">
                {actionError}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Previous Dispensed Cycles */}
        {pastRefills.length > 0 ? (
          <div className="pt-1">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {isAr ? "دورات صرف سابقة:" : "Previous Refill Cycles:"}{" "}
            </span>
            <div className="mt-1 flex flex-wrap gap-2 text-xs">
              {pastRefills.map((pr) => (
                <span
                  key={pr.id}
                  className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                >
                  <span>{isAr ? `دورة ${pr.cycleNumber}` : `Cycle ${pr.cycleNumber}`}</span>
                  <span className="text-slate-400">•</span>
                  <span>{formatDisplayDate(pr.dispensedAtUtc ?? pr.expectedRunOutOn)}</span>
                  <span className="text-emerald-600 font-bold">✓</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
