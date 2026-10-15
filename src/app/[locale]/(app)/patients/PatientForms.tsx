"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { enumKey } from "@/components/status";
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
import {
  ConsentCaptureMethod,
  Gender,
  Locale,
  PatientStatus,
} from "@/generated/prisma/enums";
import {
  createPatient,
  lookupPatientsByPhone,
  updatePatient,
  type PatientFormState,
  type PhoneMatch,
} from "@/server/patients/actions";

/**
 * The two patient forms — registering one and editing one.
 *
 * Client components because `useActionState` and `useFormStatus` are hooks, and
 * the screens around them are server components. Nothing here is trusted: both
 * actions re-read the session, re-check the permission, and re-parse every field,
 * so this component is only a convenient way to compose a request a stranger
 * could post by hand.
 *
 * A field's value is echoed back by the action when a save is refused, and the
 * echo wins over the stored record (`defaultValueOf`). Without that, one bad
 * character in one field wipes twenty the pharmacist just typed — and the
 * handful of fields that hold a phone conversation's worth of detail are exactly
 * the ones nobody retypes twice.
 */

// Option values come from the generated Prisma enums rather than hand-written
// arrays, so a value added to the schema appears here the moment it exists.
// It would appear unlabelled, which `tests/i18n.coverage.test.ts` catches.
const GENDERS = Object.values(Gender);
const LOCALES = Object.values(Locale);
const PATIENT_STATUSES = Object.values(PatientStatus);
const CAPTURE_METHODS = Object.values(ConsentCaptureMethod);

/** The state before anything has been submitted. Identity is the "idle" flag. */
const IDLE: PatientFormState = { formError: null, fieldErrors: {}, values: {} };

/**
 * A rejected submission's echo if there is one, otherwise the stored value.
 *
 * `name in values` rather than a truthiness test: a field the pharmacist
 * deliberately CLEARED comes back as an empty string, and falling back to the
 * stored value there would silently restore what they just deleted.
 */
function defaultValueOf(
  state: PatientFormState,
  name: string,
  fallback = "",
): string {
  return name in state.values ? state.values[name] : fallback;
}

function fieldError(
  t: (key: string) => string,
  state: PatientFormState,
  name: string,
): string | undefined {
  const code = state.fieldErrors[name];
  return code ? t(`errors.${code}`) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Register
// ─────────────────────────────────────────────────────────────────────────────

export function RegisterPatientForm({
  locale,
  timeZones,
  defaultTimeZone,
}: {
  locale: string;
  /** Every IANA identifier, plus the pharmacy's own if Intl does not list it. */
  timeZones: string[];
  /** The pharmacy's zone — what an Egyptian pharmacy's patient almost always is. */
  defaultTimeZone: string;
}) {
  const t = useTranslations("patientForm");
  const tEnums = useTranslations("enums");
  const [state, formAction] = useActionState(createPatient, IDLE);

  /*
   * The phone number is the one controlled input here, because it is watched as
   * it is typed. Everything else is uncontrolled and echoes through
   * `defaultValue`, which React restores after a form action resets the form.
   */
  const [phone, setPhone] = useState("");
  const duplicate = useDuplicatePhone(phone, locale);

  const consentWhatsapp = defaultValueOf(state, "consentWhatsapp") === "on";
  const consentDataProcessing =
    defaultValueOf(state, "consentDataProcessing") === "on";

  return (
    <form action={formAction} className="space-y-6">
      {/* The action cannot see the URL it was posted from, and a rejected
          submission has to come back in the language it was written in. */}
      <input type="hidden" name="locale" value={locale} />

      <FormError t={t} state={state} />

      <Card>
        <CardHeader title={t("sectionPatient")} />
        <CardBody className="space-y-4">
          <PatientDetailFields
            t={t}
            tEnums={tEnums}
            state={state}
            timeZones={timeZones}
            defaultTimeZone={defaultTimeZone}
            showStatus={false}
            phone={{
              value: phone,
              onChange: setPhone,
              hint: t("phoneHint"),
              warning: (
                <DuplicatePhoneWarning
                  t={t}
                  checking={duplicate.checking}
                  matches={duplicate.matches}
                />
              ),
            }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("sectionConsent")} />
        <CardBody className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t("consentIntro")}
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* Checkboxes are uncontrolled and echo through `defaultChecked`.
                Nothing else in the form depends on them, so a patient who
                declined is recorded as declining — the refusal is the record
                that matters, not an error to be corrected.
                Neither box gates anything: reminders are sent whatever is
                recorded here. This section exists so the pharmacy has evidence
                of what the patient agreed to, and for no other reason. */}
            <Field
              label={t("consentWhatsapp")}
              htmlFor="consentWhatsapp"
            >
              <input
                id="consentWhatsapp"
                name="consentWhatsapp"
                type="checkbox"
                defaultChecked={consentWhatsapp}
                className="size-5 rounded border-slate-300 accent-teal-600"
              />
            </Field>

            <Field
              label={t("consentDataProcessing")}
              hint={t("consentDataProcessingHint")}
              htmlFor="consentDataProcessing"
            >
              <input
                id="consentDataProcessing"
                name="consentDataProcessing"
                type="checkbox"
                defaultChecked={consentDataProcessing}
                className="size-5 rounded border-slate-300 accent-teal-600"
              />
            </Field>
          </div>

          <ConsentEvidenceFields t={t} tEnums={tEnums} state={state} />
        </CardBody>
      </Card>

      <FormActions>
        <SubmitButton label={t("save")} pendingLabel={t("saving")} />
        <Link href="/patients" className={buttonClass("ghost")}>
          {t("cancel")}
        </Link>
      </FormActions>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit
// ─────────────────────────────────────────────────────────────────────────────

export type PatientFormRecord = {
  id: string;
  fullName: string;
  /** Kept as typed: re-normalising the same string reproduces the same E.164,
   *  so an unrelated edit does not repaint the phone number in the audit log. */
  phone: string;
  phoneE164: string;
  /** `YYYY-MM-DD`, or null. */
  dateOfBirth: string | null;
  gender: string;
  preferredLocale: string;
  timeZone: string;
  careNotes: string | null;
  externalRef: string | null;
  status: string;
};

export function EditPatientForm({
  locale,
  timeZones,
  patient,
  consent,
}: {
  locale: string;
  timeZones: string[];
  patient: PatientFormRecord;
  /**
   * The latest `WHATSAPP_MESSAGING` record, as the action will read it.
   * Prefilled so that a save which does not touch consent posts the same values
   * back and is not mistaken for a change.
   */
  consent: {
    granted: boolean;
    captureMethod: string;
    evidenceRef: string | null;
    notes: string | null;
  } | null;
}) {
  const t = useTranslations("patientForm");
  const tEnums = useTranslations("enums");
  const [state, formAction] = useActionState(updatePatient, IDLE);
  const [phone, setPhone] = useState(patient.phone);

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="patientId" value={patient.id} />

      <FormError t={t} state={state} />

      <Card>
        <CardHeader title={t("sectionPatient")} />
        <CardBody className="space-y-4">
          <PatientDetailFields
            t={t}
            tEnums={tEnums}
            state={state}
            timeZones={timeZones}
            defaultTimeZone={patient.timeZone}
            showStatus
            defaults={patient}
            phone={{
              value: phone,
              onChange: setPhone,
              hint: t("phoneStoredAs", { e164: patient.phoneE164 }),
            }}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t("sectionConsent")} />
        <CardBody className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t("consentAppendNote")}
          </p>

          <Field
            label={t("consentWhatsapp")}
            htmlFor="consentWhatsapp"
          >
            <input
              id="consentWhatsapp"
              name="consentWhatsapp"
              type="checkbox"
              defaultChecked={
                "consentWhatsapp" in state.values
                  ? state.values.consentWhatsapp === "on"
                  : (consent?.granted ?? false)
              }
              className="size-5 rounded border-slate-300 accent-teal-600"
            />
          </Field>

          <ConsentEvidenceFields
            t={t}
            tEnums={tEnums}
            state={state}
            defaults={consent}
          />
        </CardBody>
      </Card>

      <FormActions>
        <SubmitButton label={t("save")} pendingLabel={t("saving")} />
        <Link href={`/patients/${patient.id}`} className={buttonClass("ghost")}>
          {t("cancel")}
        </Link>
      </FormActions>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared pieces
// ─────────────────────────────────────────────────────────────────────────────

type Translator = (key: string, values?: Record<string, string | number>) => string;

function PatientDetailFields({
  t,
  tEnums,
  state,
  timeZones,
  defaultTimeZone,
  showStatus,
  defaults,
  phone,
}: {
  t: Translator;
  tEnums: (key: string) => string;
  state: PatientFormState;
  timeZones: string[];
  defaultTimeZone: string;
  showStatus: boolean;
  defaults?: PatientFormRecord;
  phone: {
    value: string;
    onChange: (value: string) => void;
    hint: string;
    warning?: React.ReactNode;
  };
}) {
  const timeZone = defaultValueOf(state, "timeZone", defaultTimeZone);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={t("fullName")}
          hint={t("fullNameHint")}
          error={fieldError(t, state, "fullName")}
          required
          htmlFor="fullName"
        >
          <input
            id="fullName"
            name="fullName"
            type="text"
            required
            maxLength={120}
            autoComplete="name"
            defaultValue={defaultValueOf(state, "fullName", defaults?.fullName ?? "")}
            className={inputClass}
          />
        </Field>

        <Field
          label={t("phone")}
          hint={phone.hint}
          error={fieldError(t, state, "phone")}
          required
          htmlFor="phone"
        >
          {/* A phone number is a Latin numeric run: left-aligned in both
              languages, or the `+` and the digit groups reorder under RTL as
              the reader types. */}
          <input
            id="phone"
            name="phone"
            type="tel"
            inputMode="tel"
            dir="ltr"
            required
            autoComplete="tel"
            value={phone.value}
            onChange={(event) => phone.onChange(event.target.value)}
            className={inputClass}
          />
          {phone.warning}
        </Field>

        <Field
          label={t("dateOfBirth")}
          hint={t("dateOfBirthHint")}
          error={fieldError(t, state, "dateOfBirth")}
          htmlFor="dateOfBirth"
        >
          <input
            id="dateOfBirth"
            name="dateOfBirth"
            type="date"
            dir="ltr"
            defaultValue={defaultValueOf(state, "dateOfBirth", defaults?.dateOfBirth ?? "")}
            className={inputClass}
          />
        </Field>

        <Field label={t("gender.label")} htmlFor="gender">
          <select
            id="gender"
            name="gender"
            defaultValue={defaultValueOf(state, "gender", defaults?.gender ?? "UNSPECIFIED")}
            className={selectClass}
          >
            {GENDERS.map((value) => (
              <option key={value} value={value}>
                {t(`gender.${value}`)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t("locale.label")} htmlFor="preferredLocale">
          <select
            id="preferredLocale"
            name="preferredLocale"
            defaultValue={defaultValueOf(
              state,
              "preferredLocale",
              defaults?.preferredLocale ?? "AR_EG",
            )}
            className={selectClass}
          >
            {LOCALES.map((value) => (
              <option key={value} value={value}>
                {t(`locale.${value}`)}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={t("timeZone")}
          hint={t("timeZoneHint")}
          error={fieldError(t, state, "timeZone")}
          required
          htmlFor="timeZone"
        >
          <select
            id="timeZone"
            name="timeZone"
            required
            defaultValue={timeZone}
            className={selectClass}
            dir="ltr"
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </Field>

        {showStatus ? (
          <Field label={t("status")} hint={t("statusHint")} htmlFor="status">
            <select
              id="status"
              name="status"
              defaultValue={defaultValueOf(state, "status", defaults?.status ?? "ACTIVE")}
              className={selectClass}
            >
              {PATIENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {tEnums(enumKey.patientStatus(value))}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field
          label={t("externalRef")}
          hint={t("externalRefHint")}
          error={fieldError(t, state, "externalRef")}
          htmlFor="externalRef"
        >
          <input
            id="externalRef"
            name="externalRef"
            type="text"
            maxLength={60}
            dir="ltr"
            defaultValue={defaultValueOf(state, "externalRef", defaults?.externalRef ?? "")}
            className={inputClass}
          />
        </Field>
      </div>

      <Field
        label={t("careNotes")}
        hint={t("careNotesHint")}
        error={fieldError(t, state, "careNotes")}
        htmlFor="careNotes"
      >
        <textarea
          id="careNotes"
          name="careNotes"
          rows={4}
          maxLength={2000}
          defaultValue={defaultValueOf(state, "careNotes", defaults?.careNotes ?? "")}
          className={textareaClass}
        />
      </Field>
    </>
  );
}

function ConsentEvidenceFields({
  t,
  tEnums,
  state,
  defaults,
}: {
  t: Translator;
  tEnums: (key: string) => string;
  state: PatientFormState;
  defaults?: { captureMethod: string; evidenceRef: string | null; notes: string | null } | null;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field
        label={t("consentCaptureMethod")}
        error={fieldError(t, state, "consentCaptureMethod")}
        required
        htmlFor="consentCaptureMethod"
      >
        {/* No preselected method: "how this was taken" is the one part of a
            consent record that cannot be inferred, and a form that answers it
            for the pharmacist records a signature nobody collected. */}
        <select
          id="consentCaptureMethod"
          name="consentCaptureMethod"
          required
          defaultValue={defaultValueOf(state, "consentCaptureMethod", defaults?.captureMethod ?? "")}
          className={selectClass}
        >
          <option value="" disabled>
            —
          </option>
          {CAPTURE_METHODS.map((value) => (
            <option key={value} value={value}>
              {tEnums(enumKey.captureMethod(value))}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={t("consentEvidenceRef")}
        hint={t("consentEvidenceRefHint")}
        error={fieldError(t, state, "consentEvidenceRef")}
        htmlFor="consentEvidenceRef"
      >
        <input
          id="consentEvidenceRef"
          name="consentEvidenceRef"
          type="text"
          maxLength={60}
          dir="ltr"
          defaultValue={defaultValueOf(state, "consentEvidenceRef", defaults?.evidenceRef ?? "")}
          className={inputClass}
        />
      </Field>

      <Field
        label={t("consentNotes")}
        hint={t("consentNotesHint")}
        error={fieldError(t, state, "consentNotes")}
        htmlFor="consentNotes"
      >
        <textarea
          id="consentNotes"
          name="consentNotes"
          rows={2}
          maxLength={2000}
          defaultValue={defaultValueOf(state, "consentNotes", defaults?.notes ?? "")}
          className={textareaClass}
        />
      </Field>
    </div>
  );
}

/**
 * The duplicate-number warning.
 *
 * A warning, never a block. Two people in one household share a handset here as
 * a matter of course, and both registrations have to succeed — so the check is a
 * live lookup that renders names and links, and the create action never looks at
 * it. What must not happen is a SILENT duplicate: a reply from a shared handset
 * is attributable to the wrong patient, which is why inbound attribution has an
 * AMBIGUOUS outcome at all.
 */
function DuplicatePhoneWarning({
  t,
  checking,
  matches,
}: {
  t: Translator;
  checking: boolean;
  matches: PhoneMatch[] | null;
}) {
  if (matches === null || matches.length === 0) {
    return checking ? (
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {t("duplicatePhoneChecking")}
      </p>
    ) : null;
  }

  return (
    <Notice tone="warning" title={t("duplicatePhoneTitle")}>
      <span className="block">{t("duplicatePhoneHint")}</span>
      <ul className="mt-1.5 space-y-0.5">
        {matches.map((match) => (
          <li key={match.id}>
            <Link href={`/patients/${match.id}`} className="font-medium underline">
              {match.fullName}
            </Link>{" "}
            <span dir="ltr" className="tabular-nums">
              {match.phoneE164}
            </span>
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/**
 * Watch the typed number and ask the server who else is registered on it.
 *
 * Debounced, cancelled on unmount and on the next keystroke, and silent on
 * failure: this is a warning beside a field the pharmacist is filling in, and a
 * slow or failed lookup must never delay, block, or interrupt the save.
 */
function useDuplicatePhone(phone: string, locale: string) {
  const [matches, setMatches] = useState<PhoneMatch[] | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const raw = phone.trim();
    if (raw.length < 6) {
      // Not enough digits to be a number yet. Clearing here is what removes the
      // warning when the pharmacist corrects a typo into a fresh number.
      setChecking(false);
      setMatches(null);
      return;
    }

    let cancelled = false;
    setChecking(true);

    const timer = setTimeout(() => {
      lookupPatientsByPhone(raw, locale).then(
        (found) => {
          if (cancelled) return;
          setMatches(found);
          setChecking(false);
        },
        () => {
          if (cancelled) return;
          setChecking(false);
        },
      );
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phone, locale]);

  return { matches, checking };
}

/**
 * A refusal that belongs to no single field: a missing record, a save with
 * nothing in it, a consent change this role may not make.
 */
function FormError({ t, state }: { t: Translator; state: PatientFormState }) {
  if (!state.formError) return null;
  return <Notice tone="danger">{t(`errors.${state.formError}`)}</Notice>;
}

/** `useFormStatus` has to be read from inside the form. */
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
