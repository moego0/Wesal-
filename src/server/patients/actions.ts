"use server";

import { hasLocale } from "next-intl";
import { redirect } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { normalizePhone, tryNormalizePhone } from "@/lib/phone";
import { AUDIT_ACTION, writeAudit, type AuditWriter } from "@/server/audit";
import { requireSessionUser } from "@/server/auth/current-user";
import { hasPermission, requirePermission } from "@/server/auth/rbac";
import { prisma } from "@/server/db";

/**
 * Registering and editing patients.
 *
 * Three rules mould everything below.
 *
 * 1. A phone number is an ATTRIBUTE, never an identifier. `Patient.phoneE164` is
 *    indexed but deliberately not unique — shared family handsets are the norm in
 *    Egypt, and a uniqueness check would turn a real enrollment into an error
 *    message. So a duplicate is ALLOWED, and warned about instead: see
 *    `lookupPatientsByPhone`, which the registration form calls as the pharmacist
 *    types. Two patients behind one handset is exactly the case the AMBIGUOUS
 *    inbound-response path exists for, and the pharmacist knowing at enrolment is
 *    the cheapest place to fix it.
 *
 * 2. Consent is captured in the same transaction as the patient, because the
 *    record is worth having and enrollment is the one moment the pharmacist is
 *    certainly looking at the patient. It is a record and not a permission: the
 *    dispatch pre-flight (`checkMessagingAllowed`) does not consult it, so a
 *    patient enrolled with the box unticked is reminded on schedule instead of
 *    being silently inert. The record is still written here, not in a second
 *    step, since it can never be reconstructed later.
 *
 * 3. Every write is scoped by `user.pharmacyId`, read back with a `findFirst`
 *    that includes it, and audited inside the same transaction. An id from
 *    another pharmacy behaves exactly like one that does not exist.
 */

export type PatientFormState = {
  /** Form-level failure as a stable code the form translates. Never prose. */
  formError: string | null;
  /** Field name → error code. */
  fieldErrors: Record<string, string>;
  /** Echo of what was submitted, so a rejected save does not wipe the form. */
  values: Record<string, string>;
};

/**
 * The same narrowing `auth/actions.ts` does. It is not exported from there — a
 * `"use server"` module may only export async functions — so these four lines
 * are repeated rather than imported.
 */
function safeLocale(value: FormDataEntryValue | null): AppLocale {
  return typeof value === "string" && hasLocale(routing.locales, value)
    ? value
    : routing.defaultLocale;
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function nullable(value: string): string | null {
  return value === "" ? null : value;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const GENDERS = ["MALE", "FEMALE", "UNSPECIFIED"] as const;
const CAPTURE_METHODS = ["PAPER_SIGNED", "VERBAL_ATTESTED", "DIGITAL"] as const;
const PATIENT_LOCALES = ["AR_EG", "EN"] as const;
const PATIENT_STATUSES = ["ACTIVE", "PAUSED", "ARCHIVED"] as const;

const FULL_NAME_MAX = 120;
const NOTES_MAX = 2000;
const REF_MAX = 60;

/** Fields the form gets back unchanged after a failed submit. */
const ECHOED = [
  "fullName",
  "phone",
  "dateOfBirth",
  "gender",
  "preferredLocale",
  "timeZone",
  "careNotes",
  "externalRef",
  "status",
  "consentCaptureMethod",
  "consentEvidenceRef",
  "consentNotes",
  "consentDataProcessing",
  "consentWhatsapp",
] as const;

function echo(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of ECHOED) values[key] = field(formData, key);
  return values;
}

/**
 * `YYYY-MM-DD` from an `<input type="date">` into the UTC-midnight Date a
 * `@db.Date` column expects — the same convention the materializer uses for
 * `startDate`/`endDate`, so a day boundary cannot shift with a timezone.
 */
function parseDateOnly(value: string): Date | null {
  if (!DATE_ONLY.test(value)) return null;

  const at = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) return null;

  // 2026-02-31 is a well-formed string that JS rolls into March. Storing it
  // would record a birthday the pharmacist did not type, so it is rejected.
  return at.toISOString().slice(0, 10) === value ? at : null;
}

let ianaZones: Set<string> | null = null;

/**
 * IANA identifiers only, matching the schema comment on `Pharmacy.timeZone`.
 *
 * Deliberately the platform's own list rather than a luxon `isValid()` check:
 * luxon happily accepts fixed offsets such as `+03:00`, which would pin a
 * schedule to a permanent offset and start sending an hour early the next time
 * Egypt changes its DST rule.
 */
function isIanaTimeZone(value: string): boolean {
  if (value === "") return false;
  if (value === "UTC") return true;
  ianaZones ??= new Set(Intl.supportedValuesOf("timeZone"));
  return ianaZones.has(value);
}

type ConsentInput = {
  captureMethod: (typeof CAPTURE_METHODS)[number];
  evidenceRef: string | null;
  notes: string | null;
};

function parseConsentFields(
  formData: FormData,
  fieldErrors: Record<string, string>,
): ConsentInput {
  const captureMethod = field(formData, "consentCaptureMethod");
  const evidenceRef = nullable(field(formData, "consentEvidenceRef"));
  const notes = nullable(field(formData, "consentNotes"));

  if (!(CAPTURE_METHODS as readonly string[]).includes(captureMethod)) {
    fieldErrors.consentCaptureMethod = "REQUIRED";
  }
  if (evidenceRef && evidenceRef.length > REF_MAX) fieldErrors.consentEvidenceRef = "TOO_LONG";
  if (notes && notes.length > NOTES_MAX) fieldErrors.consentNotes = "TOO_LONG";

  return {
    captureMethod: (CAPTURE_METHODS as readonly string[]).includes(captureMethod)
      ? (captureMethod as ConsentInput["captureMethod"])
      : "VERBAL_ATTESTED",
    evidenceRef,
    notes,
  };
}

type PatientInput = {
  fullName: string;
  phoneE164: string;
  phoneRaw: string;
  dateOfBirth: Date | null;
  gender: (typeof GENDERS)[number] | null;
  preferredLocale: (typeof PATIENT_LOCALES)[number];
  timeZone: string;
  careNotes: string | null;
  externalRef: string | null;
};

function parsePatientFields(
  formData: FormData,
  fieldErrors: Record<string, string>,
): PatientInput {
  const fullName = field(formData, "fullName");
  const typedPhone = field(formData, "phone");
  const dateOfBirthRaw = field(formData, "dateOfBirth");
  const genderRaw = field(formData, "gender");
  const localeRaw = field(formData, "preferredLocale");
  const timeZone = field(formData, "timeZone");
  const careNotes = nullable(field(formData, "careNotes"));
  const externalRef = nullable(field(formData, "externalRef"));

  if (fullName.length < 2 || fullName.length > FULL_NAME_MAX) {
    fieldErrors.fullName = fullName === "" ? "REQUIRED" : "INVALID";
  }

  // E.164 is the only form the rest of the system reads — dialling, and the
  // attribution match on inbound webhooks. `phoneRaw` is kept beside it so a
  // number entered in a local format can still be reconciled with the handset.
  let phoneE164 = "";
  let phoneRaw = typedPhone;
  try {
    const normalized = normalizePhone(typedPhone);
    phoneE164 = normalized.e164;
    phoneRaw = normalized.raw;
  } catch {
    fieldErrors.phone = "INVALID_PHONE";
  }

  let dateOfBirth: Date | null = null;
  if (dateOfBirthRaw !== "") {
    dateOfBirth = parseDateOnly(dateOfBirthRaw);
    if (!dateOfBirth) fieldErrors.dateOfBirth = "INVALID_DATE";
  }

  const gender = (GENDERS as readonly string[]).includes(genderRaw)
    ? (genderRaw as (typeof GENDERS)[number])
    : null;
  if (genderRaw !== "" && gender === null) fieldErrors.gender = "INVALID";

  if (!isIanaTimeZone(timeZone)) fieldErrors.timeZone = "INVALID_TIMEZONE";
  if (careNotes && careNotes.length > NOTES_MAX) fieldErrors.careNotes = "TOO_LONG";
  if (externalRef && externalRef.length > REF_MAX) fieldErrors.externalRef = "TOO_LONG";

  return {
    fullName,
    phoneE164,
    phoneRaw,
    dateOfBirth,
    gender,
    preferredLocale: (PATIENT_LOCALES as readonly string[]).includes(localeRaw)
      ? (localeRaw as (typeof PATIENT_LOCALES)[number])
      : "AR_EG",
    timeZone,
    careNotes,
    externalRef,
  };
}

function failure(
  values: Record<string, string>,
  fieldErrors: Record<string, string>,
  formError: string | null = null,
): PatientFormState {
  return { formError, fieldErrors, values };
}

// ─────────────────────────────────────────────────────────────────────────────
// Register
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register a patient and capture their consent in one transaction.
 *
 * Ordered so nothing can be observed half-written: by the time the transaction
 * commits, the patient row always has its consent rows and its audit rows, and a
 * failure anywhere rolls back all of them.
 */
export async function createPatient(
  _prev: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const locale = safeLocale(formData.get("locale"));
  const user = await requireSessionUser(locale);
  requirePermission(user, "patient:write");

  const values = echo(formData);
  const fieldErrors: Record<string, string> = {};

  const consent = parseConsentFields(formData, fieldErrors);
  const input = parsePatientFields(formData, fieldErrors);

  if (Object.keys(fieldErrors).length > 0) return failure(values, fieldErrors);

  // Both consent checkboxes are captured at enrolment. WhatsApp is the one that
  // gates delivery; data processing is the one the pharmacy has to be able to
  // produce on request. An unchecked box is recorded as `granted: false` rather
  // than omitted — "the patient declined" is itself the record that matters.
  const dataProcessingGranted = field(formData, "consentDataProcessing") === "on";
  const whatsappGranted = field(formData, "consentWhatsapp") === "on";
  const now = new Date();

  const created = await prisma.$transaction(async (tx) => {
    const patient = await tx.patient.create({
      data: {
        pharmacyId: user.pharmacyId,
        fullName: input.fullName,
        phoneE164: input.phoneE164,
        phoneRaw: input.phoneRaw,
        dateOfBirth: input.dateOfBirth,
        gender: input.gender,
        preferredLocale: input.preferredLocale,
        timeZone: input.timeZone,
        careNotes: input.careNotes,
        externalRef: input.externalRef,
        createdByUserId: user.userId,
      },
    });

    const consentRows = [
      { consentType: "DATA_PROCESSING" as const, granted: dataProcessingGranted },
      { consentType: "WHATSAPP_MESSAGING" as const, granted: whatsappGranted },
    ];

    for (const row of consentRows) {
      const record = await tx.consentRecord.create({
        data: {
          pharmacyId: user.pharmacyId,
          patientId: patient.id,
          consentType: row.consentType,
          granted: row.granted,
          grantedAt: row.granted ? now : null,
          grantedByUserId: user.userId,
          captureMethod: consent.captureMethod,
          evidenceRef: consent.evidenceRef,
          notes: consent.notes,
        },
      });

      await writeAudit(tx as unknown as AuditWriter, {
        pharmacyId: user.pharmacyId,
        actorType: "USER",
        actorUserId: user.userId,
        entityType: "ConsentRecord",
        entityId: record.id,
        action: AUDIT_ACTION.CONSENT_RECORDED,
        after: {
          patientId: patient.id,
          consentType: row.consentType,
          granted: row.granted,
          captureMethod: consent.captureMethod,
        },
      });
    }

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: user.pharmacyId,
      actorType: "USER",
      actorUserId: user.userId,
      entityType: "Patient",
      entityId: patient.id,
      action: AUDIT_ACTION.PATIENT_CREATED,
      after: {
        fullName: patient.fullName,
        phoneE164: patient.phoneE164,
        status: patient.status,
        preferredLocale: patient.preferredLocale,
        timeZone: patient.timeZone,
      },
    });

    return patient;
  });

  return redirect({ href: `/patients/${created.id}`, locale });
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which scalar fields actually changed, and their old/new values.
 *
 * `careNotes` is marked as changed without being copied: AuditEvent is
 * append-only and permanent, and clinical free text does not belong in a log
 * that can never be redacted.
 */
function changedPatientFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};

  for (const key of Object.keys(after)) {
    const oldValue = before[key] ?? null;
    const newValue = after[key] ?? null;

    const same =
      oldValue instanceof Date && newValue instanceof Date
        ? oldValue.getTime() === newValue.getTime()
        : oldValue === newValue;

    if (same) continue;

    from[key] = key === "careNotes" ? "[changed]" : oldValue;
    to[key] = key === "careNotes" ? "[changed]" : newValue;
  }

  return { before: from, after: to };
}

/**
 * Edit a patient's record, appending a new consent record when it changed here.
 *
 * Consent is a timeline, not a column: a change is an INSERT and never an
 * update of the existing row. Nothing here touches the old record — the fact
 * that consent was once given, and later withdrawn, is the part that matters.
 * Nothing reads the timeline to decide whether to send; see `consent.ts`.
 */
export async function updatePatient(
  _prev: PatientFormState,
  formData: FormData,
): Promise<PatientFormState> {
  const locale = safeLocale(formData.get("locale"));
  const user = await requireSessionUser(locale);
  requirePermission(user, "patient:write");

  const values = echo(formData);
  const fieldErrors: Record<string, string> = {};
  const patientId = field(formData, "patientId");

  const consent = parseConsentFields(formData, fieldErrors);
  parsePatientFields(formData, fieldErrors);

  const statusRaw = field(formData, "status");
  if (!(PATIENT_STATUSES as readonly string[]).includes(statusRaw)) {
    fieldErrors.status = "INVALID";
  }

  if (Object.keys(fieldErrors).length > 0) return failure(values, fieldErrors);

  const status = statusRaw as (typeof PATIENT_STATUSES)[number];

  /*
   * Ownership is decided here, before anything is written, and with the
   * pharmacyId in the predicate. An id from another pharmacy returns the same
   * `NOT_FOUND` as a typo, so this screen cannot be used to probe for patients
   * that are not this pharmacy's.
   */
  const existing = await prisma.patient.findFirst({
    where: { id: patientId, pharmacyId: user.pharmacyId },
  });

  if (!existing) return failure(values, {}, "NOT_FOUND");

  const input = parsePatientFields(formData, {});
  const whatsappGranted = field(formData, "consentWhatsapp") === "on";
  const now = new Date();

  const latestWhatsappConsent = await prisma.consentRecord.findFirst({
    where: {
      pharmacyId: user.pharmacyId,
      patientId: existing.id,
      consentType: "WHATSAPP_MESSAGING",
    },
    orderBy: [{ grantedAt: "desc" }, { createdAt: "desc" }],
  });

  const consentChanged =
    latestWhatsappConsent === null ||
    latestWhatsappConsent.granted !== whatsappGranted ||
    latestWhatsappConsent.captureMethod !== consent.captureMethod ||
    (latestWhatsappConsent.evidenceRef ?? null) !== consent.evidenceRef;

  if (consentChanged && !hasPermission(user, "patient:consent")) {
    return failure(values, {}, "FORBIDDEN_CONSENT");
  }

  const next = {
    fullName: input.fullName,
    phoneE164: input.phoneE164,
    phoneRaw: input.phoneRaw,
    dateOfBirth: input.dateOfBirth,
    gender: input.gender,
    preferredLocale: input.preferredLocale,
    timeZone: input.timeZone,
    careNotes: input.careNotes,
    externalRef: input.externalRef,
    status,
  };

  const before = {
    fullName: existing.fullName,
    phoneE164: existing.phoneE164,
    phoneRaw: existing.phoneRaw,
    dateOfBirth: existing.dateOfBirth,
    gender: existing.gender,
    preferredLocale: existing.preferredLocale,
    timeZone: existing.timeZone,
    careNotes: existing.careNotes,
    externalRef: existing.externalRef,
    status: existing.status,
  };

  const diff = changedPatientFields(before, next);
  const patientChanged = Object.keys(diff.after).length > 0;

  if (!patientChanged && !consentChanged) return failure(values, {}, "NO_CHANGES");

  await prisma.$transaction(async (tx) => {
    if (patientChanged) {
      await tx.patient.update({ where: { id: existing.id }, data: next });

      await writeAudit(tx as unknown as AuditWriter, {
        pharmacyId: user.pharmacyId,
        actorType: "USER",
        actorUserId: user.userId,
        entityType: "Patient",
        entityId: existing.id,
        action:
          next.status === "ARCHIVED" && existing.status !== "ARCHIVED"
            ? AUDIT_ACTION.PATIENT_ARCHIVED
            : AUDIT_ACTION.PATIENT_UPDATED,
        before: diff.before,
        after: diff.after,
      });
    }

    if (consentChanged) {
      const record = await tx.consentRecord.create({
        data: {
          pharmacyId: user.pharmacyId,
          patientId: existing.id,
          consentType: "WHATSAPP_MESSAGING",
          granted: whatsappGranted,
          grantedAt: whatsappGranted ? now : null,
          grantedByUserId: user.userId,
          captureMethod: consent.captureMethod,
          evidenceRef: consent.evidenceRef,
          notes: consent.notes,
        },
      });

      await writeAudit(tx as unknown as AuditWriter, {
        pharmacyId: user.pharmacyId,
        actorType: "USER",
        actorUserId: user.userId,
        entityType: "ConsentRecord",
        entityId: record.id,
        action: AUDIT_ACTION.CONSENT_RECORDED,
        after: {
          patientId: existing.id,
          consentType: "WHATSAPP_MESSAGING",
          granted: whatsappGranted,
          captureMethod: consent.captureMethod,
        },
      });
    }
  });

  return redirect({ href: `/patients/${existing.id}`, locale });
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate-number warning
// ─────────────────────────────────────────────────────────────────────────────

export type PhoneMatch = { id: string; fullName: string; phoneE164: string };

/**
 * Other patients at this pharmacy already registered on a number.
 *
 * Called by the registration form as the pharmacist types, and shown in the form
 * rather than enforced at submit: two people sharing one handset is ordinary
 * here and both registrations must succeed. What must not happen is a SILENT
 * duplicate — a "taken" reply from a shared handset is attributable to the wrong
 * person, which is why attribution has an AMBIGUOUS outcome at all.
 */
export async function lookupPatientsByPhone(
  rawPhone: string,
  locale: string,
): Promise<PhoneMatch[]> {
  const user = await requireSessionUser(safeLocale(locale));
  if (!hasPermission(user, "patient:read")) return [];

  const normalized = tryNormalizePhone(rawPhone);
  if (!normalized) return [];

  return prisma.patient.findMany({
    where: { pharmacyId: user.pharmacyId, phoneE164: normalized.e164 },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: { id: true, fullName: true, phoneE164: true },
  });
}
