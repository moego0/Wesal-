"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { DrugNameCombobox } from "@/components/drug-name-combobox";
import {
  Card,
  CardBody,
  CardHeader,
  Field,
  FormActions,
  Notice,
  buttonClass,
  inputClass,
  selectClass,
  textareaClass,
} from "@/components/ui";
import { Link } from "@/i18n/navigation";
import { MedicationStatus, ScheduleMode } from "@/generated/prisma/enums";
import {
  createMedicationWithSchedule,
  updateMedicationWithSchedule,
  type MedicationFormState,
} from "@/server/medications/actions";
import {
  calculateDailyConsumption,
  calculateDaysSupply,
  calculateDepletionDate,
  calculateRefillAlertDates,
  calculateTotalPackages,
  calculateTreatmentDays,
  calculateTreatmentEndDate,
} from "@/lib/refills";

/**
 * The medication form, for both adding and editing.
 *
 * One component with two actions rather than two near-identical screens: the
 * fields, the schedule editor and the validation are the same, and the only
 * difference is which action receives the post and whether the status control
 * exists. Duplicating this markup is how one of the two copies quietly loses the
 * day-of-week rule.
 *
 * Nothing clinical is decided here. The action re-reads the session, re-checks
 * both permissions, re-parses every field, and normalises the times — this
 * component is a convenient way to compose a request a stranger could post by
 * hand, and a hand-built POST gets the same treatment as a typed one.
 */

/** Sunday-first, matching `0 = Sunday` in the schema and `expandSchedule`. */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

const MODES = Object.values(ScheduleMode).filter(
  (mode) => mode !== "INTERVAL_HOURS",
);

const STATUSES = Object.values(MedicationStatus);

const IDLE: MedicationFormState = {
  formError: null,
  fieldErrors: {},
  values: {},
  times: [],
  days: [],
};

export type MedicationFormRecord = {
  id: string;
  name: string;
  /** The RxCUI the name picker resolved, or null. Write-only for now. */
  medicationCode: string | null;
  strength: string;
  doseAmount: string;
  /** The column matching the reader's language; the other may be null. */
  instructions: string;
  prescriber: string;
  indication: string;
  /** `YYYY-MM-DD`. */
  startedOn: string;
  status: string;
  unitsPerPackage?: number | null;
  unitsPerDose?: number | null;
  dosesPerDay?: number | null;
  treatmentDurationValue?: number | null;
  treatmentDurationUnit?: string | null;
  prescriberDoctorName?: string | null;
  prescriberDoctorPhone?: string | null;
};

export type ScheduleFormRecord = {
  id: string;
  mode: string;
  timesOfDay: string[];
  daysOfWeek: number[];
  timeZone: string;
  /** `YYYY-MM-DD`. */
  startDate: string;
  /** `YYYY-MM-DD`, or null. */
  endDate: string | null;
  lateWindowMinutes: number | null;
};

export function MedicationForm({
  locale,
  patientId,
  patientTimeZone,
  timeZones,
  today,
  medication,
  schedule,
}: {
  locale: string;
  patientId: string;
  patientTimeZone: string;
  /** Every IANA identifier, plus the patient's own if Intl does not list it. */
  timeZones: string[];
  /** Today in the patient's zone — what a new schedule starts from. */
  today: string;
  /** null when adding. */
  medication: MedicationFormRecord | null;
  /** null when adding, or when the medication has no schedule yet. */
  schedule: ScheduleFormRecord | null;
}) {
  const t = useTranslations("medications");
  /*
   * The name field's helper text comes from the picker's namespace, because it
   * is the picker's rule it states: the suggestions are English drug names. A
   * pharmacist who types the Arabic name and watches nothing appear would
   * otherwise have to infer why.
   */
  const tPicker = useTranslations("drugPicker");
  const [state, formAction] = useActionState(
    medication ? updateMedicationWithSchedule : createMedicationWithSchedule,
    IDLE,
  );

  const editing = medication !== null;

  /*
   * Times and days are the only structured inputs, so they are the only ones
   * held in state. `defaultValue` covers the plain fields, and React restores
   * those after a form action resets the form.
   */
  const [times, setTimes] = useState<string[]>(() =>
    schedule && schedule.mode === "FIXED_TIMES_OF_DAY" && schedule.timesOfDay.length > 0
      ? schedule.timesOfDay
      : [""],
  );
  const [days, setDays] = useState<number[]>(() =>
    schedule && schedule.daysOfWeek.length > 0 ? schedule.daysOfWeek : WEEKDAYS,
  );
  const [mode, setMode] = useState<string>(
    schedule?.mode === "PRN" ? "PRN" : "FIXED_TIMES_OF_DAY",
  );

  /*
   * The RxCUI, and the only field here the picker does not own.
   *
   * It is controlled because it has no DOM presence of its own — `<input
   * type="hidden">` is invisible, so there is no "what the pharmacist sees" for
   * it to fall out of step with, and it must track the name exactly. The picker
   * clears it the moment the name is edited, which is the whole defence against
   * a name carrying a code that belongs to a different drug. The action
   * re-validates it anyway: this input is postable by hand.
   */
  const [code, setCode] = useState(medication?.medicationCode ?? "");

  const [unitsPerPackage, setUnitsPerPackage] = useState(
    () => medication?.unitsPerPackage?.toString() ?? "30",
  );
  const [unitsPerDose, setUnitsPerDose] = useState(
    () => medication?.unitsPerDose?.toString() ?? "1",
  );
  const [dosesPerDay, setDosesPerDay] = useState(
    () => medication?.dosesPerDay?.toString() ?? "1",
  );
  const [treatmentDurationValue, setTreatmentDurationValue] = useState(
    () => medication?.treatmentDurationValue?.toString() ?? "6",
  );
  const [treatmentDurationUnit, setTreatmentDurationUnit] = useState(
    () => medication?.treatmentDurationUnit ?? "MONTHS",
  );
  const [startedOn, setStartedOn] = useState(
    () => medication?.startedOn ?? today,
  );

  /*
   * A refused submission replaces what is in the editor with exactly what was
   * submitted, so the pharmacist corrects the one value that was wrong instead
   * of re-entering a seven-time taper.
   *
   * Keyed on the state object's identity: the idle state is a module constant,
   * so `state === IDLE` is true until an action has actually returned.
   */
  useEffect(() => {
    if (state === IDLE) return;
    setTimes(state.times.length > 0 ? state.times : [""]);
    setDays(state.days);
    if (state.values.mode === "PRN" || state.values.mode === "FIXED_TIMES_OF_DAY") {
      setMode(state.values.mode);
    }
    if (state.values.unitsPerPackage) setUnitsPerPackage(state.values.unitsPerPackage);
    if (state.values.unitsPerDose) setUnitsPerDose(state.values.unitsPerDose);
    if (state.values.dosesPerDay) setDosesPerDay(state.values.dosesPerDay);
    if (state.values.treatmentDurationValue) setTreatmentDurationValue(state.values.treatmentDurationValue);
    if (state.values.treatmentDurationUnit) setTreatmentDurationUnit(state.values.treatmentDurationUnit);
    if (state.values.startedOn) setStartedOn(state.values.startedOn);
  }, [state]);

  const value = (name: string, fallback = "") =>
    name in state.values ? state.values[name] : fallback;

  const error = (name: string) => {
    const code = state.fieldErrors[name];
    return code ? t(`errors.${code}`) : undefined;
  };

  const fixedTimes = mode === "FIXED_TIMES_OF_DAY";

  const numPackage = Number(unitsPerPackage);
  const numDose = Number(unitsPerDose);
  const numFreq = Number(dosesPerDay);
  const numDur = Number(treatmentDurationValue);

  let daily = 1;
  let daysSupply = 30;
  let depletionDateStr = "";
  let packagesNeeded = 1;
  let alert5DaysStr = "";
  let alert1DayStr = "";

  if (numPackage > 0 && numDose > 0 && numFreq > 0) {
    daily = calculateDailyConsumption(numDose, numFreq);
    daysSupply = calculateDaysSupply(numPackage, daily);
    const startD = new Date(`${startedOn || today}T00:00:00.000Z`);
    if (!Number.isNaN(startD.getTime())) {
      const depD = calculateDepletionDate(startD, daysSupply);
      depletionDateStr = depD.toISOString().slice(0, 10);
      const alerts = calculateRefillAlertDates(depD, 5, 1);
      alert5DaysStr = alerts.warningDate.toISOString().slice(0, 10);
      alert1DayStr = alerts.urgentDate.toISOString().slice(0, 10);

      if (numDur > 0 && ["DAYS", "WEEKS", "MONTHS"].includes(treatmentDurationUnit)) {
        const treatmentEnd = calculateTreatmentEndDate(
          startD,
          numDur,
          treatmentDurationUnit as "DAYS" | "WEEKS" | "MONTHS",
        );
        const treatmentDays = calculateTreatmentDays(startD, treatmentEnd);
        packagesNeeded = calculateTotalPackages(treatmentDays, daysSupply);
      }
    }
  }

  const isAr = locale === "ar";

  return (
    <form action={formAction} className="space-y-6">
      {/* The action cannot see the URL it was posted from, and a rejected
          submission has to come back in the language it was written in. */}
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="patientId" value={patientId} />
      {medication ? (
        <input type="hidden" name="medicationId" value={medication.id} />
      ) : null}
      {/* The schedule is chosen by the page with `pickPrimarySchedule` and
          posted back, so the action cannot revise a different regimen than the
          one on screen. */}
      {schedule ? <input type="hidden" name="scheduleId" value={schedule.id} /> : null}

      {state.formError ? (
        <Notice tone="danger">{t(`errors.${state.formError}`)}</Notice>
      ) : null}

      <Card>
        <CardHeader title={t("sectionMedication")} />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {/* One grid cell, so the source credit sits under its own field
                instead of taking a column and pushing the other fields across.
                Inside `Field`, the credit would come before the validation
                error, which belongs closest to the input. */}
            <div className="space-y-1.5">
              <Field
                label={t("name")}
                hint={tPicker("hint")}
                error={error("name")}
                required
                htmlFor="name"
              >
                {/* The field itself is unchanged in what it accepts — any text,
                    Arabic included. The picker only offers DailyMed's spellings
                    as the pharmacist types, and clears the hidden code whenever
                    the text changes. */}
                <DrugNameCombobox
                  id="name"
                  defaultValue={value("name", medication?.name ?? "")}
                  required
                  onCodeChange={setCode}
                />
              </Field>

              {/* The two service names are Latin runs inside an Arabic
                  sentence, which the bidi algorithm already renders
                  left-to-right — no `dir` wrapper is needed for a word. */}
              <p className="text-[11px] text-slate-400 dark:text-slate-500">
                {tPicker("attribution")}
              </p>
            </div>

            {/* The RxCUI belonging to the name above, or empty. Invisible, so
                it adds no grid cell, and kept beside its field rather than with
                the routing inputs at the top: what it means depends on the name
                and on nothing else. */}
            <input type="hidden" name="medicationCode" value={code} />

            <Field label={t("strength")} hint={t("strengthHint")} error={error("strength")} htmlFor="strength">
              <input
                id="strength"
                name="strength"
                type="text"
                maxLength={80}
                defaultValue={value("strength", medication?.strength ?? "")}
                className={inputClass}
              />
            </Field>

            <Field label={t("doseAmount")} hint={t("doseAmountHint")} error={error("doseAmount")} htmlFor="doseAmount">
              <input
                id="doseAmount"
                name="doseAmount"
                type="text"
                maxLength={120}
                defaultValue={value("doseAmount", medication?.doseAmount ?? "")}
                className={inputClass}
              />
            </Field>

            <Field label={t("startedOn")} error={error("startedOn")} required htmlFor="startedOn">
              <input
                id="startedOn"
                name="startedOn"
                type="date"
                dir="ltr"
                required
                value={startedOn}
                onChange={(e) => setStartedOn(e.target.value)}
                className={inputClass}
              />
            </Field>

            <Field
              label={locale === "ar" ? "اسم الطبيب المعالج" : "Prescribing Doctor's Name"}
              hint={locale === "ar" ? "الاسم الكامل للطبيب المعالج" : "Full name of the prescribing doctor"}
              error={error("prescriberDoctorName")}
              htmlFor="prescriberDoctorName"
            >
              <input
                id="prescriberDoctorName"
                name="prescriberDoctorName"
                type="text"
                maxLength={120}
                defaultValue={value("prescriberDoctorName", medication?.prescriberDoctorName ?? "")}
                className={inputClass}
              />
            </Field>

            <Field
              label={locale === "ar" ? "هاتف الطبيب المعالج" : "Prescribing Doctor's Phone"}
              hint={locale === "ar" ? "للتواصل السريع عند الاستفسار" : "Phone number for clarifications"}
              error={error("prescriberDoctorPhone")}
              htmlFor="prescriberDoctorPhone"
            >
              <input
                id="prescriberDoctorPhone"
                name="prescriberDoctorPhone"
                type="tel"
                dir="ltr"
                maxLength={40}
                defaultValue={value("prescriberDoctorPhone", medication?.prescriberDoctorPhone ?? "")}
                className={inputClass}
              />
            </Field>

            <Field
              label={locale === "ar" ? "حجم العبوة (كبسولة / قرص)" : "Units per Package"}
              hint={locale === "ar" ? "عدد الأقراص في العبوة الواحدة (مثال: 30)" : "Tablets/capsules per box (e.g. 30)"}
              error={error("unitsPerPackage")}
              required
              htmlFor="unitsPerPackage"
            >
              <input
                id="unitsPerPackage"
                name="unitsPerPackage"
                type="number"
                min={1}
                max={1000}
                required
                dir="ltr"
                value={unitsPerPackage}
                onChange={(e) => setUnitsPerPackage(e.target.value)}
                className={inputClass}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field
                label={locale === "ar" ? "الجرعة المقررة (لكل جرعة)" : "Dosage (units/dose)"}
                hint={locale === "ar" ? "مثال: 1 قرص" : "e.g. 1 tablet"}
                error={error("unitsPerDose")}
                required
                htmlFor="unitsPerDose"
              >
                <input
                  id="unitsPerDose"
                  name="unitsPerDose"
                  type="number"
                  step="any"
                  min={0.1}
                  max={100}
                  required
                  dir="ltr"
                  value={unitsPerDose}
                  onChange={(e) => setUnitsPerDose(e.target.value)}
                  className={inputClass}
                />
              </Field>

              <Field
                label={locale === "ar" ? "التكرار (مرات يومياً)" : "Frequency (doses/day)"}
                hint={locale === "ar" ? "مثال: 1 مرة يومياً" : "e.g. 1 time daily"}
                error={error("dosesPerDay")}
                required
                htmlFor="dosesPerDay"
              >
                <input
                  id="dosesPerDay"
                  name="dosesPerDay"
                  type="number"
                  min={1}
                  max={24}
                  required
                  dir="ltr"
                  value={dosesPerDay}
                  onChange={(e) => setDosesPerDay(e.target.value)}
                  className={inputClass}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field
                label={locale === "ar" ? "مدة العلاج المقررة" : "Treatment Duration"}
                hint={locale === "ar" ? "القيمة العددية (مثال: 6)" : "Duration value (e.g. 6)"}
                error={error("treatmentDurationValue")}
                required
                htmlFor="treatmentDurationValue"
              >
                <input
                  id="treatmentDurationValue"
                  name="treatmentDurationValue"
                  type="number"
                  min={1}
                  max={365}
                  required
                  dir="ltr"
                  value={treatmentDurationValue}
                  onChange={(e) => setTreatmentDurationValue(e.target.value)}
                  className={inputClass}
                />
              </Field>

              <Field
                label={locale === "ar" ? "الوحدة الزمنية" : "Duration Unit"}
                error={error("treatmentDurationUnit")}
                required
                htmlFor="treatmentDurationUnit"
              >
                <select
                  id="treatmentDurationUnit"
                  name="treatmentDurationUnit"
                  required
                  value={treatmentDurationUnit}
                  onChange={(e) => setTreatmentDurationUnit(e.target.value)}
                  className={selectClass}
                >
                  <option value="DAYS">{locale === "ar" ? "أيام" : "Days"}</option>
                  <option value="WEEKS">{locale === "ar" ? "أسابيع" : "Weeks"}</option>
                  <option value="MONTHS">{locale === "ar" ? "أشهر" : "Months"}</option>
                </select>
              </Field>
            </div>

            <Field label={t("prescriber")} hint={t("prescriberHint")} error={error("prescriber")} htmlFor="prescriber">
              <input
                id="prescriber"
                name="prescriber"
                type="text"
                maxLength={120}
                defaultValue={value("prescriber", medication?.prescriber ?? "")}
                className={inputClass}
              />
            </Field>

            <Field label={t("indication")} hint={t("indicationHint")} error={error("indication")} htmlFor="indication">
              <input
                id="indication"
                name="indication"
                type="text"
                maxLength={200}
                defaultValue={value("indication", medication?.indication ?? "")}
                className={inputClass}
              />
            </Field>

            {editing ? (
              <Field label={t("status")} hint={t("statusHint")} error={error("status")} htmlFor="status">
                {/* One control for two statuses. `dispatch.ts` refuses to send
                    unless the SCHEDULE is ACTIVE, so a medication left ACTIVE
                    beside a paused schedule would look live while sending
                    nothing. The action derives the schedule's status from this
                    one on every save. */}
                <select
                  id="status"
                  name="status"
                  defaultValue={value("status", medication.status)}
                  className={selectClass}
                >
                  {STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {t(`statusValues.${status}`)}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>

          <Field label={t("instructions")} hint={t("instructionsHint")} error={error("instructions")} htmlFor="instructions">
            <textarea
              id="instructions"
              name="instructions"
              rows={3}
              maxLength={500}
              defaultValue={value("instructions", medication?.instructions ?? "")}
              className={textareaClass}
            />
          </Field>
        </CardBody>
      </Card>

      {/* ── Medication Refill & Depletion Forecast Card ── */}
      <Card>
        <CardHeader
          title={locale === "ar" ? "خطة تجديد الصرف ونفاد الدواء (حساب تقويم تلقائي)" : "Medication Refill & Depletion Forecast"}
          subtitle={
            locale === "ar"
              ? "حساب دقيق لموعد نفاد كل عبوة وتواريخ تنبيه الصيدلية والمريض"
              : "Automated calendar calculation for depletion dates and proactive alerts"
          }
        />
        <CardBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {locale === "ar" ? "الاستهلاك اليومي" : "Daily Consumption"}
              </p>
              <p className="mt-1 text-lg font-bold text-slate-800 dark:text-slate-100">
                {daily} {locale === "ar" ? "وحدة / يوم" : "units/day"}
              </p>
              <p className="text-[11px] text-slate-400">
                {locale === "ar" ? "الجرعة × التكرار اليومي" : "Dosage × Frequency"}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {locale === "ar" ? "مدة كفاية العبوة" : "Package Days Supply"}
              </p>
              <p className="mt-1 text-lg font-bold text-teal-700 dark:text-teal-400">
                {daysSupply} {locale === "ar" ? "يوم" : "days"}
              </p>
              <p className="text-[11px] text-slate-400">
                {locale === "ar" ? "تكفي العبوة الحالية" : "One package lasts"}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {locale === "ar" ? "إجمالي العبوات المطلوبة" : "Total Packages Needed"}
              </p>
              <p className="mt-1 text-lg font-bold text-indigo-700 dark:text-indigo-400">
                ~{packagesNeeded} {locale === "ar" ? "عبوات" : "packages"}
              </p>
              <p className="text-[11px] text-slate-400">
                {locale === "ar" ? "طوال مدة الكورس العلاجي" : "Throughout full treatment"}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 dark:border-slate-800 dark:bg-slate-900/50">
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {locale === "ar" ? "تاريخ نفاد العبوة" : "Expected Depletion Date"}
              </p>
              <p className="mt-1 text-lg font-bold text-amber-700 dark:text-amber-400" dir="ltr">
                {depletionDateStr || "—"}
              </p>
              <p className="text-[11px] text-slate-400">
                {locale === "ar" ? "موعد تجديد الصرف القادم" : "Next refill due date"}
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-teal-100 bg-teal-50/60 p-3 text-xs text-teal-900 dark:border-teal-900/50 dark:bg-teal-950/30 dark:text-teal-200">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <span className="font-semibold">
                🔔 {locale === "ar" ? "جدول التنبيهات الآلية:" : "Automated Alert Schedule:"}
              </span>
              <span>
                <strong>{locale === "ar" ? "تنبيه الصيدلية والمريض (قبل 5 أيام):" : "Pharmacy & Patient Alert (5 days out):"}</strong>{" "}
                <span dir="ltr">{alert5DaysStr || "—"}</span>
              </span>
              <span>
                <strong>{locale === "ar" ? "تنبيه عاجل للصيدلية (قبل 1 يوم):" : "Urgent Alert (1 day out):"}</strong>{" "}
                <span dir="ltr">{alert1DayStr || "—"}</span>
              </span>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("sectionSchedule")} />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t("mode.label")}
              hint={mode === "PRN" ? t("modePrnHint") : undefined}
              error={error("mode")}
              required
              htmlFor="mode"
            >
              <select
                id="mode"
                name="mode"
                required
                value={mode}
                onChange={(event) => setMode(event.target.value)}
                className={selectClass}
              >
                {MODES.map((option) => (
                  <option key={option} value={option}>
                    {t(`mode.${option}`)}
                  </option>
                ))}
              </select>
            </Field>

            <Field label={t("timeZone")} hint={t("timeZoneHint")} error={error("timeZone")} required htmlFor="timeZone">
              <select
                id="timeZone"
                name="timeZone"
                required
                dir="ltr"
                defaultValue={value("timeZone", schedule?.timeZone ?? patientTimeZone)}
                className={selectClass}
              >
                {timeZones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {fixedTimes ? (
            <Field
              label={t("timesOfDay")}
              hint={t("timesOfDayHint")}
              error={error("timesOfDay")}
              required
            >
              <div className="space-y-2">
                {times.map((time, index) => (
                  <div key={index} className="flex items-center gap-2">
                    {/* `type="time"` yields `HH:MM` in every browser, which is
                        exactly what the DB CHECK accepts. The action still
                        normalises and re-checks: a hand-built POST does not go
                        through this input. */}
                    <input
                      type="time"
                      name="timesOfDay"
                      value={time}
                      onChange={(event) =>
                        setTimes((previous) =>
                          previous.map((entry, at) => (at === index ? event.target.value : entry)),
                        )
                      }
                      dir="ltr"
                      className={`${inputClass} w-40`}
                    />
                    {times.length > 1 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setTimes((previous) => previous.filter((_, at) => at !== index))
                        }
                        className={buttonClass("ghost", "sm")}
                      >
                        {t("removeTime")}
                      </button>
                    ) : null}
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => setTimes((previous) => [...previous, ""])}
                  className={buttonClass("secondary", "sm")}
                >
                  {t("addTime")}
                </button>
              </div>
            </Field>
          ) : null}

          <Field label={t("daysOfWeek")} hint={t("daysOfWeekHint")} error={error("daysOfWeek")}>
            {/* Every day is ticked by default: a fixed-time regimen is usually a
                chronic one, and a form that arrives with no day selected is one
                Save away from a schedule that never fires. */}
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {WEEKDAYS.map((day) => (
                <label key={day} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    name="daysOfWeek"
                    value={day}
                    checked={days.includes(day)}
                    onChange={() =>
                      setDays((previous) =>
                        previous.includes(day)
                          ? previous.filter((entry) => entry !== day)
                          : [...previous, day].sort((a, b) => a - b),
                      )
                    }
                    className="size-4 rounded border-slate-300 accent-teal-600"
                  />
                  {t(`days.${day}`)}
                </label>
              ))}
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t("startDate")} error={error("startDate")} required htmlFor="startDate">
              <input
                id="startDate"
                name="startDate"
                type="date"
                dir="ltr"
                required
                defaultValue={value("startDate", schedule?.startDate ?? today)}
                className={inputClass}
              />
            </Field>

            <Field label={t("endDate")} hint={t("endDateHint")} error={error("endDate")} htmlFor="endDate">
              <input
                id="endDate"
                name="endDate"
                type="date"
                dir="ltr"
                defaultValue={value("endDate", schedule?.endDate ?? "")}
                className={inputClass}
              />
            </Field>

            <Field
              label={t("lateWindowMinutes")}
              hint={t("lateWindowMinutesHint")}
              error={error("lateWindowMinutes")}
              htmlFor="lateWindowMinutes"
            >
              <input
                id="lateWindowMinutes"
                name="lateWindowMinutes"
                type="number"
                min={1}
                max={1440}
                dir="ltr"
                defaultValue={value(
                  "lateWindowMinutes",
                  schedule?.lateWindowMinutes ? String(schedule.lateWindowMinutes) : "",
                )}
                className={inputClass}
              />
            </Field>
          </div>

          {editing ? (
            <Field label={t("reason")} hint={t("reasonHint")} error={error("reason")} htmlFor="reason">
              {/* Kept beside the schedule, not beside the name: what a reason
                  explains is this change, and it is written onto the revision
                  row a pharmacist reads six months from now. */}
              <textarea
                id="reason"
                name="reason"
                rows={2}
                maxLength={500}
                defaultValue={value("reason")}
                className={textareaClass}
              />
            </Field>
          ) : null}
        </CardBody>
      </Card>

      <FormActions>
        <SubmitButton label={t("save")} pendingLabel={t("saving")} />
        <Link href={`/patients/${patientId}`} className={buttonClass("ghost")}>
          {t("cancel")}
        </Link>
      </FormActions>
    </form>
  );
}

/** `useFormStatus` has to be read from a component rendered inside the form. */
function SubmitButton({
  label,
  pendingLabel,
}: {
  label: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className={buttonClass("primary")}>
      {pending ? pendingLabel : label}
    </button>
  );
}
