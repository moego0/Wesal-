"use client";

import { useEffect, useState, useRef } from "react";
import { AlertTriangle, AlertCircle, Clock, Sparkles, HeartPulse, ShieldCheck, Stethoscope } from "lucide-react";
import type { DetectedInteraction, InteractionEngineReport } from "@/server/ddi/engine";

export function MedicationPreflightCheck({
  currentName,
  existingMedications,
  locale = "ar",
}: {
  currentName: string;
  existingMedications: Array<{ id: string; name: string }>;
  locale?: string;
}) {
  const isAr = locale === "ar";
  const [interactions, setInteractions] = useState<DetectedInteraction[]>([]);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const trimmed = currentName.trim();
    if (trimmed.length < 3 || existingMedications.length === 0) {
      setInteractions([]);
      setLoading(false);
      return;
    }

    const mySeq = ++seqRef.current;
    const controller = new AbortController();

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/clinical/ddi/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            medications: [
              { name: trimmed },
              ...existingMedications.map((m) => ({ identifier: m.id, name: m.name })),
            ],
          }),
        });

        if (mySeq !== seqRef.current) return;

        if (res.ok) {
          const data = (await res.json()) as { report: InteractionEngineReport };
          if (mySeq !== seqRef.current) return;

          // Filter interactions specifically involving the newly entered medication
          const lowerName = trimmed.toLowerCase();
          const relevant = (data.report?.interactions || []).filter((i) => {
            const a = i.ingredientA.name.toLowerCase();
            const b = i.ingredientB.name.toLowerCase();
            const rel = i.relatedMedications.map((r) => r.toLowerCase());
            return (
              lowerName.includes(a) ||
              lowerName.includes(b) ||
              rel.some((r) => r.includes(lowerName) || lowerName.includes(r))
            );
          });

          setInteractions(relevant);
        } else {
          setInteractions([]);
        }
      } catch {
        if (mySeq === seqRef.current) setInteractions([]);
      } finally {
        if (mySeq === seqRef.current) setLoading(false);
      }
    }, 400);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [currentName, existingMedications]);

  if (interactions.length === 0) {
    return null;
  }

  const hasMajor = interactions.some((i) => i.severity === "MAJOR");

  return (
    <div
      className={`relative overflow-hidden rounded-2xl p-[1.5px] transition-all shadow-md animate-in fade-in-50 duration-200 ${
        hasMajor
          ? "bg-gradient-to-r from-rose-500/50 via-amber-500/40 to-rose-600/50"
          : "bg-gradient-to-r from-amber-500/50 via-orange-500/40 to-amber-600/50"
      }`}
    >
      <div className="rounded-[15px] bg-white p-4 dark:bg-slate-900 space-y-3">
        <div className="flex items-center gap-2.5">
          <div
            className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
              hasMajor
                ? "bg-rose-100 text-rose-600 dark:bg-rose-950/70 dark:text-rose-400"
                : "bg-amber-100 text-amber-600 dark:bg-amber-950/70 dark:text-amber-400"
            }`}
          >
            <AlertTriangle className="size-4.5" />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
              <span>
                {isAr
                  ? "تنبيه قبل الحفظ: تم رصد تعارض دوائي مع الأدوية الحالية للمريض"
                  : "Pre-flight Alert: Drug Interaction with Patient Regimen"}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                  hasMajor
                    ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                }`}
              >
                {hasMajor ? (isAr ? "حرج" : "MAJOR") : (isAr ? "متوسط" : "MODERATE")}
              </span>
            </h4>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              {isAr
                ? "راجع التدابير الوقائية والحلول السريرية أدناه قبل اعتماد وحفظ الدواء:"
                : "Review the clinical management solutions below before confirming this medication:"}
            </p>
          </div>
        </div>

        <div className="space-y-2.5">
          {interactions.map((interaction) => (
            <div
              key={interaction.id}
              className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-900/60 space-y-2"
            >
              <div className="flex items-center justify-between text-xs font-semibold text-slate-800 dark:text-slate-200">
                <span>
                  {interaction.ingredientA.name} ↔ {interaction.ingredientB.name}
                </span>
                <span className="text-[10px] text-slate-400 font-normal">
                  {interaction.source}
                </span>
              </div>

              {interaction.mechanism && (
                <p className="text-[11px] text-slate-600 dark:text-slate-400 leading-relaxed bg-white/70 p-2 rounded-lg border border-slate-200/60 dark:bg-slate-800/60 dark:border-slate-700/60">
                  <span className="font-medium text-slate-800 dark:text-slate-200">
                    {isAr ? "الآلية: " : "Mechanism: "}
                  </span>
                  {interaction.mechanism}
                </p>
              )}

              {/* How to solve it / Solution strategy */}
              <div className="rounded-lg border border-teal-200 bg-teal-50/70 p-2.5 text-xs text-teal-900 dark:border-teal-900/50 dark:bg-teal-950/40 dark:text-teal-200 space-y-1">
                <div className="flex items-center gap-1.5 font-bold text-teal-950 dark:text-teal-300">
                  <Sparkles className="size-3.5 text-teal-600 dark:text-teal-400" />
                  <span>{isAr ? "الحل السريري الموصى به:" : "Recommended Clinical Resolution:"}</span>
                </div>

                {interaction.timingRule ? (
                  <div className="flex items-start gap-2 pt-0.5 text-[11px]">
                    <Clock className="size-3.5 text-teal-600 dark:text-teal-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold">
                        {isAr
                          ? `الفصل الزمني: يلزم فاصل زمني لا يقل عن ${interaction.timingRule.minIntervalHours} ساعات بين الجرعتين.`
                          : `Timing Separation: Separate administration by at least ${interaction.timingRule.minIntervalHours} hours.`}
                      </p>
                      <p className="text-[10px] text-teal-800/90 dark:text-teal-300/80">
                        {interaction.timingRule.timingInstructionAr ||
                          interaction.timingRule.timingInstructionEn}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] leading-relaxed">
                    {interaction.management ||
                      (isAr
                        ? "مراقبة العلامات الحيوية أو النظر في تعديل الجرعة / استخدام بديل علاجي."
                        : "Monitor vital signs or consider dosage adjustment / therapeutic alternative.")}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
