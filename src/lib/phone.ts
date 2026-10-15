import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

/**
 * Phone number handling.
 *
 * A patient's phone number is an attribute, never an identifier — the PRD is
 * explicit that it must not be the primary key, and the schema deliberately
 * does not make it unique (shared family handsets are common in Egypt).
 */

export const DEFAULT_COUNTRY: CountryCode = "EG";

export type NormalizedPhone = {
  /** E.164, e.g. "+201234567890". This is what gets stored and dialled. */
  e164: string;
  /** What the pharmacist actually typed, kept for reconciliation and display. */
  raw: string;
};

export class InvalidPhoneError extends Error {
  constructor(raw: string, reason: string) {
    super(`Invalid phone number ${JSON.stringify(raw)}: ${reason}`);
    this.name = "InvalidPhoneError";
  }
}

/**
 * Normalize user input to E.164.
 *
 * `defaultCountry` is applied to national-format input ("01234567890"). Pass
 * `null` to require an explicit country code.
 */
export function normalizePhone(
  raw: string,
  defaultCountry: CountryCode | null = DEFAULT_COUNTRY,
): NormalizedPhone {
  const trimmed = raw.trim();

  if (trimmed === "") throw new InvalidPhoneError(raw, "empty");

  const parsed = parsePhoneNumberFromString(
    trimmed,
    defaultCountry === null ? undefined : defaultCountry,
  );

  if (!parsed) throw new InvalidPhoneError(raw, "not a recognisable number");
  if (!parsed.isValid()) throw new InvalidPhoneError(raw, "fails validation for its region");

  return { e164: parsed.number, raw: trimmed };
}

/** Non-throwing variant, for validation in forms and bulk import. */
export function tryNormalizePhone(
  raw: string,
  defaultCountry: CountryCode | null = DEFAULT_COUNTRY,
): NormalizedPhone | null {
  try {
    return normalizePhone(raw, defaultCountry);
  } catch {
    return null;
  }
}

/**
 * Render a number for display in a message body.
 *
 * Deliberately not used to build wa.me links for patient-facing copy — the
 * pharmacy's own number is what patients see.
 */
export function formatPhoneForDisplay(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}

/** True when the two inputs are the same number written differently. */
export function samePhone(a: string, b: string): boolean {
  const pa = tryNormalizePhone(a, null);
  const pb = tryNormalizePhone(b, null);
  return pa !== null && pb !== null && pa.e164 === pb.e164;
}
