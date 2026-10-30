"use client";

import { useState, useTransition } from "react";
import { resendFollowUpReminder } from "@/server/followup/actions";

export function ResendReminderButton({
  patientId,
  medicationId,
  patientName,
  medicationName,
  locale = "ar",
}: {
  patientId: string;
  medicationId: string;
  patientName: string;
  medicationName: string;
  locale?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isAr = locale === "ar";

  function handleSend() {
    setStatus("idle");
    setErrorMessage(null);

    startTransition(async () => {
      const formData = new FormData();
      formData.set("patientId", patientId);
      formData.set("medicationId", medicationId);
      formData.set("locale", locale);

      const res = await resendFollowUpReminder(formData);
      if (res.ok) {
        setStatus("sent");
        setTimeout(() => setStatus("idle"), 4000);
      } else {
        setStatus("error");
        setErrorMessage(res.error || (isAr ? "فشل الإرسال" : "Failed to send"));
        setTimeout(() => setStatus("idle"), 5000);
      }
    });
  }

  if (status === "sent") {
    return (
      <span className="inline-flex items-center gap-1 rounded-lg bg-teal-100 px-2.5 py-1 text-xs font-semibold text-teal-800 dark:bg-teal-950 dark:text-teal-300">
        ✓ {isAr ? "تم إرسال المتابعة بنجاح" : "Sent successfully"}
      </span>
    );
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={handleSend}
        disabled={isPending}
        className="inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-sky-50 px-2.5 py-1.5 text-xs font-semibold text-sky-800 transition hover:bg-sky-100 hover:border-sky-400 disabled:opacity-60 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300 dark:hover:bg-sky-900/50"
        title={isAr ? `إرسال تذكير متابعة فوري للمريض ${patientName} عبر واتساب` : `Resend WhatsApp follow-up reminder`}
      >
        <span aria-hidden="true">📲</span>
        <span>
          {isPending
            ? isAr ? "جاري الإرسال..." : "Sending..."
            : isAr ? "إعادة إرسال للمتابعة" : "Resend Follow-up"}
        </span>
      </button>
      {status === "error" && (
        <span className="text-[11px] text-rose-600 dark:text-rose-400">
          {errorMessage}
        </span>
      )}
    </div>
  );
}

