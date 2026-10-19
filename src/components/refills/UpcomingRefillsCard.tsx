"use client";

import { useTransition } from "react";
import { Link } from "@/i18n/navigation";
import { Pill } from "@/components/status";
import { Card, CardBody, CardHeader, EmptyState, buttonClass } from "@/components/ui";
import type { UpcomingRefillItem } from "@/server/queries/dashboard";
import { updateRefillStatusAction } from "@/server/refills/actions";

export function UpcomingRefillsCard({
  refills,
  locale,
}: {
  refills: UpcomingRefillItem[];
  locale: string;
}) {
  const isAr = locale === "ar";
  const [isPending, startTransition] = useTransition();

  const handleStatusChange = (refillId: string, status: string) => {
    startTransition(async () => {
      const formData = new FormData();
      formData.append("refillId", refillId);
      formData.append("status", status);
      await updateRefillStatusAction(formData);
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

  return (
    <Card>
      <CardHeader
        title={isAr ? "أدوية تقترب من النفاد وتجديد الصرف (خلال 7 أيام)" : "Upcoming Medication Refills (Next 7 Days)"}
        subtitle={
          isAr
            ? "متابعة استباقية لاحتياجات المرضى وتجهيز مخزون الصيدلية قبل نفاد الدواء"
            : "Proactively track patient depletion dates and prepare pharmacy inventory"
        }
      />
      <CardBody className="space-y-4">
        {refills.length === 0 ? (
          <EmptyState
            title={isAr ? "لا توجد أدوية بحاجة لتجديد الصرف حالياً" : "No upcoming refills due"}
            hint={isAr ? "جميع المرضى لديهم مخزون كافٍ لأكثر من 7 أيام" : "All patients have sufficient supply for the next 7 days"}
          />
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {refills.map((refill) => {
              const cleanPhone = refill.medication.prescriberDoctorPhone
                ? refill.medication.prescriberDoctorPhone.replace(/[^0-9]/g, "")
                : null;

              return (
                <div key={refill.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    {/* Left details */}
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/patients/${refill.patient.id}`}
                          className="font-semibold text-teal-800 hover:underline dark:text-teal-300"
                        >
                          {refill.patient.fullName}
                        </Link>
                        <span className="text-slate-400">·</span>
                        <span className="font-medium text-slate-900 dark:text-slate-100">
                          {refill.medication.name}
                          {refill.medication.strength ? ` (${refill.medication.strength})` : ""}
                        </span>
                        <Pill tone={getStatusTone(refill.status)}>
                          {getStatusLabel(refill.status)}
                        </Pill>
                        {refill.isUnconfirmedOverdue ? (
                          <Pill tone="warn" dot>
                            {isAr ? "تأكيد الصرف متأخر" : "Overdue Refill"}
                          </Pill>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                        <span>
                          <strong className="text-slate-700 dark:text-slate-300">
                            {isAr ? "تاريخ النفاد المتوقع:" : "Expected Depletion:"}
                          </strong>{" "}
                          <span dir="ltr">{refill.expectedRunOutOn.toISOString().slice(0, 10)}</span>
                        </span>
                        <span>
                          <strong className="text-slate-700 dark:text-slate-300">
                            {isAr ? "الأيام المتبقية:" : "Days Remaining:"}
                          </strong>{" "}
                          <span
                            className={
                              refill.daysRemaining <= 1
                                ? "font-bold text-rose-600 dark:text-rose-400"
                                : refill.daysRemaining <= 3
                                ? "font-semibold text-amber-600 dark:text-amber-400"
                                : "font-medium text-teal-600 dark:text-teal-400"
                            }
                          >
                            {refill.daysRemaining <= 0
                              ? isAr
                                ? "اليوم أو متأخر"
                                : "Today / Overdue"
                              : isAr
                              ? `${refill.daysRemaining} يوم`
                              : `${refill.daysRemaining} day(s)`}
                          </span>
                        </span>
                        <span>
                          <strong className="text-slate-700 dark:text-slate-300">
                            {isAr ? "الكمية المطلوبة:" : "Quantity Needed:"}
                          </strong>{" "}
                          {refill.packagesNeeded}{" "}
                          {isAr ? "عبوة" : "package(s)"}
                        </span>
                      </div>

                      {/* Doctor info & Contact */}
                      {refill.medication.prescriberDoctorName ? (
                        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-slate-600 dark:text-slate-300">
                          <span className="font-medium text-slate-500">
                            {isAr ? "الطبيب المعالج:" : "Prescribing Doctor:"}
                          </span>
                          <span>{refill.medication.prescriberDoctorName}</span>
                          {refill.medication.prescriberDoctorPhone ? (
                            <>
                              <span dir="ltr" className="font-mono text-slate-500">
                                {refill.medication.prescriberDoctorPhone}
                              </span>
                              <a
                                href={`tel:${refill.medication.prescriberDoctorPhone}`}
                                className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                              >
                                📞 {isAr ? "اتصال" : "Call"}
                              </a>
                              {cleanPhone ? (
                                <a
                                  href={`https://wa.me/${cleanPhone}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center rounded bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300"
                                >
                                  💬 {isAr ? "واتساب" : "WhatsApp"}
                                </a>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      ) : null}

                      {/* Inventory availability indicator */}
                      {refill.inventoryAvailable === false || refill.status === "STOCK_ORDERED" ? (
                        <div className="inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                          <span>⚠️</span>
                          <span>
                            {isAr
                              ? "المخزون غير متوفر / يلزم طلب الدواء من المورد فوراً"
                              : "Inventory insufficient — order additional stock from supplier"}
                          </span>
                        </div>
                      ) : null}
                    </div>

                    {/* Quick status actions */}
                    <div className="flex flex-wrap items-center gap-1.5 pt-2 lg:pt-0">
                      <button
                        type="button"
                        disabled={isPending || refill.status === "PENDING"}
                        onClick={() => handleStatusChange(refill.id, "PENDING")}
                        className={buttonClass("ghost", "xs")}
                      >
                        {isAr ? "قيد الانتظار" : "Pending"}
                      </button>
                      <button
                        type="button"
                        disabled={isPending || refill.status === "STOCK_ORDERED"}
                        onClick={() => handleStatusChange(refill.id, "STOCK_ORDERED")}
                        className={buttonClass("secondary", "xs")}
                      >
                        {isAr ? "طلب مخزون" : "Order Stock"}
                      </button>
                      <button
                        type="button"
                        disabled={isPending || refill.status === "READY_FOR_COLLECTION"}
                        onClick={() => handleStatusChange(refill.id, "READY_FOR_COLLECTION")}
                        className={buttonClass("secondary", "xs")}
                      >
                        {isAr ? "جاهز للاستلام" : "Ready"}
                      </button>
                      <button
                        type="button"
                        disabled={isPending || refill.status === "DISPENSED"}
                        onClick={() => handleStatusChange(refill.id, "DISPENSED")}
                        className={buttonClass("primary", "xs")}
                      >
                        ✓ {isAr ? "صرف العبوة" : "Dispense"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
