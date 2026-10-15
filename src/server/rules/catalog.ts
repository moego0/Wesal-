import type { Severity } from "@/generated/prisma/enums";
import {
  ADHERENT_OUTCOMES,
  SCORED_OUTCOMES,
  adherenceRate,
  countBy,
  daysAgo,
  since,
  trailingStreak,
  type DoseFact,
  type FactBook,
} from "./facts";

/**
 * The rule catalog.
 *
 * Every rule is a pure function over a `FactBook`, so the whole clinical layer
 * can be tested without a database, a clock, or a WhatsApp account. That
 * matters more here than anywhere else in the system: these are the rules that
 * decide which patients a pharmacist is told to worry about, and "it seemed to
 * work when I tried it" is not a standard of evidence for that.
 *
 * ## Thresholds are the pharmacist's to own
 *
 * The defaults are deliberately CONSERVATIVE — they under-alert. The PRD says
 * the thresholds need clinical validation, and the failure mode of an
 * over-eager rule is worse than a quiet one: a pharmacist who gets eight alerts
 * a day stops reading them, and then a real one is invisible too. Every
 * threshold is a parameter, and `dryRunRule` exists so the pharmacist can ask
 * "what would this have produced over the last 30 days?" before committing.
 *
 * ## What is deliberately NOT a rule
 *
 * `PROBLEM_REPORTED` is absent. A patient reporting a problem opens a case
 * immediately and synchronously in `applyResponse`, at URGENT severity, because
 * a symptom report must not wait for a sweep. Adding it here as well would
 * double-alert on the same event.
 */

export type RuleKey =
  | "CONSECUTIVE_MISSES"
  | "NO_RESPONSE_STREAK"
  | "NO_ENGAGEMENT"
  | "MISSED_DOSE_CLUSTER"
  | "FREQUENT_LATE_TAKING"
  | "ADHERENCE_BELOW_THRESHOLD"
  | "ADHERENCE_DROP";

export type RuleParams = Record<string, number>;

export type RuleMatch = {
  /** Null when the rule is about the patient overall rather than one medicine. */
  medicationId: string | null;
  titleAr: string;
  titleEn: string;
  detailAr: string;
  detailEn: string;
  /** The triggering doses and computed values — the transparency requirement. */
  evidence: Record<string, unknown>;
};

export type RuleSpec = {
  key: RuleKey;
  version: number;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  severity: Severity;
  defaultParams: RuleParams;
  cooldownHours: number;
  evaluate: (book: FactBook, params: RuleParams) => RuleMatch[];
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** How many of the most recent doses a rule should look at, at most. */
function tail(doses: DoseFact[], n: number): DoseFact[] {
  return doses.slice(-n);
}

export const RULES: RuleSpec[] = [
  {
    key: "CONSECUTIVE_MISSES",
    version: 1,
    nameAr: "جرعات متكررة لم تُؤخذ",
    nameEn: "Consecutive missed doses",
    descriptionAr:
      "يُنبّه عندما يُبلّغ المريض عن عدد متتالٍ من الجرعات الفائتة. يشمل البلاغات الصريحة فقط، وليس الصمت — فالصمت له قاعدة مستقلة.",
    descriptionEn:
      "Fires when the patient explicitly reports several missed doses in a row. Explicit reports only — silence is a separate rule, because the two mean different things.",
    severity: "HIGH",
    defaultParams: { threshold: 3, lookbackDoses: 14 },
    cooldownHours: 24,
    evaluate: (book, params) => {
      const threshold = params.threshold ?? 3;
      const lookback = params.lookbackDoses ?? 14;
      const out: RuleMatch[] = [];

      for (const [medicationId, doses] of book.byMedication) {
        const window = tail(doses, lookback);
        const streak = trailingStreak(window, (d) => d.outcome === "MISSED");
        if (streak < threshold) continue;

        const med = window[window.length - 1]?.medicationName ?? "";
        out.push({
          medicationId,
          titleAr: `${streak} جرعات فائتة متتالية`,
          titleEn: `${streak} consecutive missed doses`,
          detailAr: `المريض أبلغ عن ${streak} جرعات فائتة متتالية من ${med}.`,
          detailEn: `Patient reported ${streak} consecutive missed doses of ${med}.`,
          evidence: {
            rule: "CONSECUTIVE_MISSES",
            threshold,
            observedStreak: streak,
            medicationName: med,
            eventIds: window.slice(-streak).map((d) => d.eventId),
            doseTimes: window.slice(-streak).map((d) => d.doseAtUtc.toISOString()),
          },
        });
      }
      return out;
    },
  },

  {
    key: "MISSED_DOSE_CLUSTER",
    version: 1,
    nameAr: "نمط فوات متقطع",
    nameEn: "Clustered missed doses",
    descriptionAr:
      "يُنبّه عند تكرار فوات الجرعات خلال فترة قصيرة دون أن تكون متتالية. يلتقط النمط المتقطع الذي لا ترصده قاعدة الجرعات المتتالية.",
    descriptionEn:
      "Fires when missed doses accumulate in a short window without being consecutive. Catches erratic non-adherence that the consecutive rule never sees.",
    severity: "NORMAL",
    defaultParams: { windowDays: 14, threshold: 4, minDoses: 6 },
    cooldownHours: 48,
    evaluate: (book, params) => {
      const windowDays = params.windowDays ?? 14;
      const threshold = params.threshold ?? 4;
      const minDoses = params.minDoses ?? 6;
      const out: RuleMatch[] = [];

      for (const [medicationId, doses] of book.byMedication) {
        const window = since(doses, daysAgo(book.now, windowDays));
        const scored = window.filter((d) => SCORED_OUTCOMES.includes(d.outcome));
        // Without a floor on the denominator, a patient with two doses in the
        // window and two misses would trip a threshold meant for a fortnight.
        if (scored.length < minDoses) continue;

        const missed = countBy(scored, "MISSED");
        if (missed < threshold) continue;

        const med = scored[0]?.medicationName ?? "";
        out.push({
          medicationId,
          titleAr: `${missed} جرعات فائتة خلال ${windowDays} يومًا`,
          titleEn: `${missed} missed doses in ${windowDays} days`,
          detailAr: `فوت المريض ${missed} جرعة من ${med} خلال ${windowDays} يومًا (من إجمالي ${scored.length} جرعة مُقيَّمة).`,
          detailEn: `Patient missed ${missed} doses of ${med} in ${windowDays} days, out of ${scored.length} scored.`,
          evidence: {
            rule: "MISSED_DOSE_CLUSTER",
            windowDays,
            threshold,
            missedCount: missed,
            scoredCount: scored.length,
            eventIds: scored.filter((d) => d.outcome === "MISSED").map((d) => d.eventId),
          },
        });
      }
      return out;
    },
  },

  {
    key: "NO_RESPONSE_STREAK",
    version: 1,
    nameAr: "انقطاع الردود",
    nameEn: "Consecutive non-responses",
    descriptionAr:
      "يُنبّه عند عدم رد المريض على عدة تذكيرات متتالية رغم وصولها إليه. الجرعات التي لم تُسلَّم تُستثنى تمامًا ولا تُحسب ضد المريض.",
    descriptionEn:
      "Fires when the patient stops responding to several delivered reminders in a row. Reminders that were never delivered are excluded entirely and never counted against the patient.",
    severity: "NORMAL",
    defaultParams: { threshold: 3, lookbackDoses: 12 },
    cooldownHours: 72,
    evaluate: (book, params) => {
      const threshold = params.threshold ?? 3;
      const lookback = params.lookbackDoses ?? 12;
      const out: RuleMatch[] = [];

      for (const [medicationId, doses] of book.byMedication) {
        const window = tail(doses, lookback);
        // A PENDING or UNDELIVERED dose breaks the streak rather than extending
        // it — we cannot conclude anything from a reminder still in flight.
        const streak = trailingStreak(window, (d) => d.outcome === "NO_RESPONSE");
        if (streak < threshold) continue;

        const med = window[window.length - 1]?.medicationName ?? "";
        out.push({
          medicationId,
          titleAr: `لا يوجد رد على ${streak} تذكيرات`,
          titleEn: `No response to ${streak} reminders`,
          detailAr: `لم يرد المريض على ${streak} تذكيرات متتالية من ${med} رغم تسليمها. قد يكون الرقم غير صحيح أو المريض بحاجة لمتابعة.`,
          detailEn: `Patient did not respond to ${streak} consecutive delivered reminders for ${med}. The number may be wrong, or follow-up is needed.`,
          evidence: {
            rule: "NO_RESPONSE_STREAK",
            threshold,
            observedStreak: streak,
            eventIds: window.slice(-streak).map((d) => d.eventId),
            note: "Only delivered reminders are counted; undelivered ones are excluded.",
          },
        });
      }
      return out;
    },
  },

  {
    key: "NO_ENGAGEMENT",
    version: 1,
    nameAr: "لم يتفاعل مطلقًا",
    nameEn: "Never engaged",
    descriptionAr:
      "يُنبّه عندما لا يرد المريض على أي تذكير منذ التسجيل. هذه مشكلة تسجيل أو رقم خاطئ، وليست مشكلة التزام — ولذلك لها قاعدة منفصلة.",
    descriptionEn:
      "Fires when the patient has never responded to any reminder since enrollment. This is an onboarding or wrong-number problem, not an adherence one, which is why it is a separate rule with its own response.",
    severity: "NORMAL",
    defaultParams: { threshold: 4 },
    cooldownHours: 168,
    evaluate: (book, params) => {
      const threshold = params.threshold ?? 4;
      const scored = book.doses.filter((d) => SCORED_OUTCOMES.includes(d.outcome));
      if (scored.length < threshold) return [];

      // Any response at all clears this — the rule is about the channel working,
      // not about adherence quality.
      const everResponded = scored.some(
        (d) => d.responseState !== "NONE" && d.responseState !== "UNATTRIBUTED",
      );
      if (everResponded) return [];

      return [
        {
          medicationId: null,
          titleAr: "المريض لم يتفاعل مع أي تذكير",
          titleEn: "Patient has never engaged",
          detailAr: `لم يرد المريض على أي من ${scored.length} تذكيرًا منذ التسجيل. يُرجَّح أن الرقم غير صحيح أو أن المريض لا يستخدم واتساب.`,
          detailEn: `No response to any of ${scored.length} reminders since enrollment. The number is likely wrong or the patient does not use WhatsApp.`,
          evidence: {
            rule: "NO_ENGAGEMENT",
            deliveredCount: scored.length,
            eventIds: scored.slice(-5).map((d) => d.eventId),
          },
        },
      ];
    },
  },

  {
    key: "FREQUENT_LATE_TAKING",
    version: 1,
    nameAr: "تكرار تناول الجرعة متأخرًا",
    nameEn: "Frequently taken late",
    descriptionAr:
      "يُنبّه عندما يتكرر تناول الجرعات متأخرًا عن موعدها. قد يشير إلى مواعيد غير عملية أو تفاعلات دوائية تستدعي مراجعة الصيدلي.",
    descriptionEn:
      "Fires when doses are repeatedly taken late. Often means the schedule is impractical for the patient's routine rather than that they are non-adherent.",
    severity: "LOW",
    defaultParams: { windowDays: 30, minDoses: 8, ratioThreshold: 0.5 },
    cooldownHours: 168,
    evaluate: (book, params) => {
      const windowDays = params.windowDays ?? 30;
      const minDoses = params.minDoses ?? 8;
      const ratioThreshold = params.ratioThreshold ?? 0.5;
      const out: RuleMatch[] = [];

      for (const [medicationId, doses] of book.byMedication) {
        const window = since(doses, daysAgo(book.now, windowDays));
        const scored = window.filter((d) => SCORED_OUTCOMES.includes(d.outcome));
        if (scored.length < minDoses) continue;

        const late = countBy(scored, "TAKEN_LATE");
        const ratio = late / scored.length;
        if (ratio < ratioThreshold) continue;

        const med = scored[0]?.medicationName ?? "";
        out.push({
          medicationId,
          titleAr: `تناول متأخر في ${pct(ratio)} من الجرعات`,
          titleEn: `Taken late in ${pct(ratio)} of doses`,
          detailAr: `تناول المريض ${late} من ${scored.length} جرعة من ${med} متأخرًا. قد تحتاج المواعيد إلى تعديل لتناسب روتين المريض.`,
          detailEn: `${late} of ${scored.length} doses of ${med} were taken late. The schedule may need adjusting to fit the patient's routine.`,
          evidence: {
            rule: "FREQUENT_LATE_TAKING",
            windowDays,
            lateCount: late,
            scoredCount: scored.length,
            ratio,
          },
        });
      }
      return out;
    },
  },

  {
    key: "ADHERENCE_BELOW_THRESHOLD",
    version: 1,
    nameAr: "الالتزام أقل من الحد المطلوب",
    nameEn: "Adherence below threshold",
    descriptionAr:
      "يُنبّه عندما ينخفض معدل الالتزام عن حد معين خلال فترة محددة.",
    descriptionEn:
      "Fires when the adherence rate over a window falls below a threshold.",
    severity: "NORMAL",
    defaultParams: { windowDays: 30, minDoses: 8, threshold: 0.6 },
    cooldownHours: 168,
    evaluate: (book, params) => {
      const windowDays = params.windowDays ?? 30;
      const minDoses = params.minDoses ?? 8;
      const threshold = params.threshold ?? 0.6;
      const out: RuleMatch[] = [];

      for (const [medicationId, doses] of book.byMedication) {
        const window = since(doses, daysAgo(book.now, windowDays));
        const scored = window.filter((d) => SCORED_OUTCOMES.includes(d.outcome));
        if (scored.length < minDoses) continue;

        const rate = adherenceRate(scored);
        if (rate === null || rate >= threshold) continue;

        const med = scored[0]?.medicationName ?? "";
        out.push({
          medicationId,
          titleAr: `الالتزام ${pct(rate)} خلال ${windowDays} يومًا`,
          titleEn: `Adherence ${pct(rate)} over ${windowDays} days`,
          detailAr: `معدل الالتزام بدواء ${med} هو ${pct(rate)} خلال ${windowDays} يومًا، وهو أقل من الحد (${pct(threshold)}).`,
          detailEn: `Adherence for ${med} is ${pct(rate)} over ${windowDays} days, below the ${pct(threshold)} threshold.`,
          evidence: {
            rule: "ADHERENCE_BELOW_THRESHOLD",
            windowDays,
            threshold,
            rate,
            scoredCount: scored.length,
            breakdown: {
              taken: countBy(scored, "TAKEN"),
              takenLate: countBy(scored, "TAKEN_LATE"),
              missed: countBy(scored, "MISSED"),
              noResponse: countBy(scored, "NO_RESPONSE"),
            },
            // Stated explicitly so nobody reading a report has to guess whether
            // our own downtime was counted against the patient. It was not.
            excluded: {
              undelivered: countBy(window, "UNDELIVERED"),
              pending: countBy(window, "PENDING"),
            },
          },
        });
      }
      return out;
    },
  },

  {
    key: "ADHERENCE_DROP",
    version: 1,
    nameAr: "تراجع في الالتزام",
    nameEn: "Adherence decline",
    descriptionAr:
      "يُنبّه عند حدوث تراجع ملموس في الالتزام مقارنة بالفترة السابقة. يقيس التغيّر لا المستوى، فيكشف التدهور لدى مريض معدله لا يزال مقبولًا.",
    descriptionEn:
      "Fires on a material fall in adherence versus the preceding period. Measures change rather than level, so it catches a patient whose rate is still acceptable but is deteriorating.",
    severity: "HIGH",
    defaultParams: { windowDays: 14, minDoses: 6, dropThreshold: 0.25 },
    cooldownHours: 168,
    evaluate: (book, params) => {
      const windowDays = params.windowDays ?? 14;
      const minDoses = params.minDoses ?? 6;
      const dropThreshold = params.dropThreshold ?? 0.25;
      const out: RuleMatch[] = [];

      for (const [medicationId, doses] of book.byMedication) {
        const recent = since(doses, daysAgo(book.now, windowDays));
        const previous = doses.filter(
          (d) =>
            d.doseAtUtc.getTime() >= daysAgo(book.now, windowDays * 2).getTime() &&
            d.doseAtUtc.getTime() < daysAgo(book.now, windowDays).getTime(),
        );

        const recentScored = recent.filter((d) => SCORED_OUTCOMES.includes(d.outcome));
        const prevScored = previous.filter((d) => SCORED_OUTCOMES.includes(d.outcome));

        // Both windows need enough data. Comparing against a two-dose baseline
        // produces a "decline" every time a single dose is missed.
        if (recentScored.length < minDoses || prevScored.length < minDoses) continue;

        const recentRate = adherenceRate(recentScored);
        const prevRate = adherenceRate(prevScored);
        if (recentRate === null || prevRate === null) continue;

        const drop = prevRate - recentRate;
        if (drop < dropThreshold) continue;

        const med = recentScored[0]?.medicationName ?? "";
        out.push({
          medicationId,
          titleAr: `تراجع الالتزام من ${pct(prevRate)} إلى ${pct(recentRate)}`,
          titleEn: `Adherence fell from ${pct(prevRate)} to ${pct(recentRate)}`,
          detailAr: `انخفض الالتزام بدواء ${med} من ${pct(prevRate)} إلى ${pct(recentRate)} خلال آخر ${windowDays} يومًا.`,
          detailEn: `Adherence for ${med} fell from ${pct(prevRate)} to ${pct(recentRate)} over the last ${windowDays} days.`,
          evidence: {
            rule: "ADHERENCE_DROP",
            windowDays,
            recentRate,
            previousRate: prevRate,
            drop,
            recentScored: recentScored.length,
            previousScored: prevScored.length,
          },
        });
      }
      return out;
    },
  },
];

export const RULES_BY_KEY: Map<RuleKey, RuleSpec> = new Map(RULES.map((r) => [r.key, r]));

export function findRule(key: string): RuleSpec | undefined {
  return RULES_BY_KEY.get(key as RuleKey);
}

/**
 * Merge a pharmacy's overrides over the defaults.
 *
 * Unknown keys are kept rather than dropped, so a rule that was configured by a
 * newer version and then read by an older one does not silently lose its
 * settings.
 */
export function resolveParams(key: RuleKey, overrides: unknown): RuleParams {
  const spec = RULES_BY_KEY.get(key);
  const base = spec ? { ...spec.defaultParams } : {};
  if (overrides && typeof overrides === "object") {
    for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) base[k] = v;
    }
  }
  return base;
}

/** Stable dedupe key. One open alert per (rule, patient, medication). */
export function dedupeKeyFor(key: RuleKey, patientId: string, medicationId: string | null): string {
  return `${key}|${patientId}|${medicationId ?? "none"}`;
}

/**
 * Which alert to auto-resolve when this rule stops firing.
 *
 * Only the rule's OWN key — a patient may legitimately have an open
 * CONSECUTIVE_MISSES alert and an open NO_ENGAGEMENT alert at once, and
 * resolving one must not close the other.
 */
export function autoResolveKey(key: RuleKey): RuleKey {
  return key;
}

/**
 * Re-exported so reporting can compute the same numbers the rules do, from the
 * same place. A dashboard that computes adherence its own way will eventually
 * disagree with the alert that brought the pharmacist there.
 */
export { adherenceRate, countBy, ADHERENT_OUTCOMES, SCORED_OUTCOMES };
