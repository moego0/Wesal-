import { createHash } from "node:crypto";

/**
 * Standardize an ingredient name: lowercase, trim, strip superfluous punctuation.
 */
export function normalizeIngredientName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^\w\s\-/+.]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Parse an active ingredients string (e.g. "chlorpheniramine+paracetamol+pseudoephedrine" or "amoxicillin / clavulanic acid")
 * into individual clean ingredient names.
 */
export function splitActiveIngredients(raw?: string | null): string[] {
  if (!raw || !raw.trim()) return [];

  // Delimiters used across datasets: '+', '/', ';', ' and ', '&'
  const parts = raw.split(/\+|\/|;|\band\b|&/gi);
  const seen = new Set<string>();
  const results: string[] = [];

  for (const part of parts) {
    const cleaned = normalizeIngredientName(part);
    if (cleaned && cleaned.length > 1 && !seen.has(cleaned)) {
      seen.add(cleaned);
      results.push(cleaned);
    }
  }

  return results;
}

/**
 * Common pharmaceutical dosage forms recognition patterns.
 */
const DOSAGE_FORM_PATTERNS: Array<{ form: string; regex: RegExp }> = [
  { form: "Tablet", regex: /\b(tablets?|tabs?|film-coated tablets?|f\.c\.? tablets?|dispersible tablets?|chewable tablets?)\b/i },
  { form: "Capsule", regex: /\b(capsules?|caps?|soft gelatin capsules?|softgels?|hard gelatin capsules?)\b/i },
  { form: "Syrup", regex: /\b(syrups?|syr)\b/i },
  { form: "Suspension", regex: /\b(suspension|susp)\b/i },
  { form: "Solution", regex: /\b(solution|sol|oral solution)\b/i },
  { form: "Injection", regex: /\b(injection|inj|ampoules?|amps?|vials?|infusion|i\.?v\.?|i\.?m\.?)\b/i },
  { form: "Cream", regex: /\b(creams?|crm)\b/i },
  { form: "Ointment", regex: /\b(ointments?|oint)\b/i },
  { form: "Gel", regex: /\b(gels?|oral gel|topical gel)\b/i },
  { form: "Drops", regex: /\b(eye drops?|ear drops?|oral drops?|drops?|gtts?)\b/i },
  { form: "Spray", regex: /\b(nasal spray|oral spray|sprays?)\b/i },
  { form: "Inhaler", regex: /\b(inhaler|inhalation|mew|rotacap|respules?)\b/i },
  { form: "Suppository", regex: /\b(suppositories?|supp|suppos?)\b/i },
  { form: "Sachet", regex: /\b(sachets?|effervescent granules?|powder)\b/i },
  { form: "Lotion", regex: /\b(lotions?)\b/i },
  { form: "Patch", regex: /\b(transdermal patch|patches?)\b/i },
];

/**
 * Detect dosage form from medication text.
 */
export function extractDosageForm(text: string): string | null {
  for (const { form, regex } of DOSAGE_FORM_PATTERNS) {
    if (regex.test(text)) {
      return form;
    }
  }
  return null;
}

/**
 * Route of administration inference from dosage form.
 */
export function inferRouteFromForm(form?: string | null): string {
  if (!form) return "Oral"; // default presumption if unknown
  switch (form.toLowerCase()) {
    case "tablet":
    case "capsule":
    case "syrup":
    case "suspension":
    case "solution":
    case "sachet":
      return "Oral";
    case "injection":
      return "Parenteral (IV/IM/SC)";
    case "cream":
    case "ointment":
    case "gel":
    case "lotion":
    case "patch":
      return "Topical";
    case "drops":
      return "Ophthalmic / Otic / Oral";
    case "spray":
      return "Nasal / Oral";
    case "inhaler":
      return "Inhalation";
    case "suppository":
      return "Rectal / Vaginal";
    default:
      return "Oral";
  }
}

/**
 * Extract strength expressions from medication title (e.g. "500 mg", "1000 mg", "120 ml", "5 mg / 500 mg").
 */
export function extractStrength(text: string): string | null {
  const match = text.match(
    /\b(\d+(?:\.\d+)?\s*(?:mg|g|mcg|µg|ml|iu|ui|%|meq)(?:\s*[\/+]\s*\d+(?:\.\d+)?\s*(?:mg|g|mcg|µg|ml|iu|ui|%|meq))*)\b/i,
  );
  return match ? match[1].trim() : null;
}

/**
 * Deterministic hash for payload change detection and idempotency.
 */
export function computeChecksum(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
