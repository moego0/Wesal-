"use client";

import React, { useState } from "react";
import { AlertTriangle, AlertCircle, Clock, ShieldAlert, ChevronRight } from "lucide-react";
import type { DetectedInteraction } from "@/server/ddi/engine";

export interface MedicationInteractionBadgeProps {
  medicationName: string;
  interactions: DetectedInteraction[];
  locale?: string;
  onViewDetails?: (interaction: DetectedInteraction) => void;
}

/**
 * Inline badge component rendered on medication cards to visibly signal
 * detected drug interactions and timing conflicts.
 *
 * Implements shadcn/ui aesthetic with Lucide React SVG icons (no emojis).
 */
export function MedicationInteractionBadge({
  medicationName,
  interactions,
  locale = "ar",
  onViewDetails,
}: {
  medicationName: string;
  interactions: DetectedInteraction[];
  locale?: string;
  onViewDetails?: (interaction: DetectedInteraction) => void;
}) {
  const isAr = locale === "ar";
  const normName = medicationName.trim().toLowerCase();

  // Find interactions involving this medication name or ingredient
  const matching = interactions.filter((i) => {
    const a = i.ingredientA.name.toLowerCase();
    const b = i.ingredientB.name.toLowerCase();
    const related = i.relatedMedications.map((r) => r.toLowerCase());

    return (
      normName.includes(a) ||
      normName.includes(b) ||
      related.some((r) => normName.includes(r) || r.includes(normName))
    );
  });

  if (matching.length === 0) {
    return null;
  }

  // Pick worst severity
  const hasMajor = matching.some((i) => i.severity === "MAJOR");
  const primaryInteraction = matching[0];
  const otherDrug =
    primaryInteraction.ingredientA.name.toLowerCase() === normName
      ? primaryInteraction.ingredientB.name
      : primaryInteraction.ingredientA.name;

  const hasTimingRule = matching.some((i) => i.timingRule !== null);
  const timingRule = matching.find((i) => i.timingRule !== null)?.timingRule;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onViewDetails?.(primaryInteraction)}
        className={`group inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-all shadow-sm ${
          hasMajor
            ? "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 hover:border-rose-400 dark:border-rose-800 dark:bg-rose-950/70 dark:text-rose-300 dark:hover:bg-rose-900/80"
            : "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 hover:border-amber-400 dark:border-amber-800 dark:bg-amber-950/70 dark:text-amber-300 dark:hover:bg-amber-900/80"
        }`}
        title={
          isAr
            ? `تفاعل دوائي مع ${otherDrug}: ${primaryInteraction.mechanism || primaryInteraction.management || ""}`
            : `Interaction with ${otherDrug}: ${primaryInteraction.mechanism || primaryInteraction.management || ""}`
        }
      >
        <span className="relative flex size-2 shrink-0">
          <span
            className={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping ${
              hasMajor ? "bg-rose-500" : "bg-amber-500"
            }`}
          />
          <span
            className={`relative inline-flex size-2 rounded-full ${
              hasMajor ? "bg-rose-600" : "bg-amber-600"
            }`}
          />
        </span>

        {hasMajor ? (
          <AlertTriangle className="size-3.5 text-rose-600 dark:text-rose-400 shrink-0" />
        ) : (
          <AlertCircle className="size-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
        )}

        <span>
          {isAr
            ? `${hasMajor ? "تفاعل حرج مع" : "تفاعل مع"} ${otherDrug}`
            : `${hasMajor ? "Major conflict with" : "Interacts with"} ${otherDrug}`}
        </span>

        <ChevronRight className="size-3 opacity-60 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
      </button>

      {hasTimingRule && timingRule && (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-teal-300 bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-800 dark:border-teal-800 dark:bg-teal-950/60 dark:text-teal-300"
          title={timingRule.timingInstructionAr || timingRule.timingInstructionEn}
        >
          <Clock className="size-3 text-teal-600 dark:text-teal-400 shrink-0" />
          <span>
            {isAr
              ? `فاصل ${timingRule.minIntervalHours} س`
              : `Separate ${timingRule.minIntervalHours}h`}
          </span>
        </span>
      )}
    </div>
  );
}
