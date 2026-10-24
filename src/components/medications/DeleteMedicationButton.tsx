"use client";

import { useState, useTransition } from "react";
import { buttonClass } from "@/components/ui";
import { deleteMedication } from "@/server/medications/actions";

export function DeleteMedicationButton({
  medicationId,
  medicationName,
  locale = "ar",
  size = "md",
  className = "",
}: {
  medicationId: string;
  medicationName: string;
  locale?: string;
  size?: "sm" | "md" | "xs";
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const isAr = locale === "ar";
  const label = size === "sm" || size === "xs" ? (isAr ? "حذف" : "Delete") : (isAr ? "حذف الدواء" : "Delete medication");

  function handleDelete() {
    startTransition(async () => {
      const formData = new FormData();
      formData.set("medicationId", medicationId);
      formData.set("locale", locale);
      await deleteMedication(formData);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={`${buttonClass("danger", size)} ${className}`}
        title={isAr ? "حذف الدواء" : "Delete medication"}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="size-4"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z"
            clipRule="evenodd"
          />
        </svg>
        <span>{label}</span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs">
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-5"
                >
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </div>
              <div>
                <h3 id="delete-dialog-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {isAr ? "حذف الدواء" : "Delete Medication"}
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {medicationName}
                </p>
              </div>
            </div>

            <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
              {isAr
                ? "هل أنت متأكد من حذف هذا الدواء؟ سيتم حذف جميع المواعيد والتنبيهات المرتبطة به نهائياً ولا يمكن التراجع عن هذه الخطوة."
                : "Are you sure you want to delete this medication? All associated schedules and reminders will be deleted permanently. This action cannot be undone."}
            </p>

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button
                type="button"
                disabled={isPending}
                onClick={() => setIsOpen(false)}
                className={buttonClass("secondary")}
              >
                {isAr ? "إلغاء" : "Cancel"}
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={handleDelete}
                className={buttonClass("danger")}
              >
                {isPending ? (isAr ? "جاري الحذف…" : "Deleting…") : isAr ? "نعم، احذف الدواء" : "Yes, delete medication"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
