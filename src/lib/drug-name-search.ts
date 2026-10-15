/**
 * Ranking DailyMed's drug-name suggestions.
 *
 * DailyMed's `drugnames` service matches on SUBSTRING and returns its rows
 * ALPHABETICALLY, with no relevance signal of any kind. Measured against the
 * live service: the query `omeprazol` returns 108 rows in which `OMEPRAZOLE`
 * itself sits at index 68 — behind `24 HOUR OMEPRAZOLE` and `24 HOUR
 * ESOMEPRAZOLE MAGNESIUM`. Handing that list to the pharmacist as-is is worse
 * than the plain text box it replaces: they scroll past two dozen combination
 * and store-brand products to reach the ingredient whose first six letters they
 * already typed.
 *
 * So this ranking is the feature, not decoration. It is deliberately pure — no
 * network, no clock, no React — because the ordering rules are the part worth
 * asserting directly. Everything that touches the outside world lives in
 * `src/server/medications/drug-names.ts` and is tested separately with an
 * injected fetch.
 */

/** One row of DailyMed's `data` array, as far as anything here cares. */
export type DailyMedRow = {
  drug_name?: string | null;
  name_type?: string | null;
};

export type DrugSuggestion = {
  /** The normalized name — what we scored is what the form stores. */
  name: string;
  /**
   * `G` for a generic, `B` for a brand. Where DailyMed lists the same name as
   * both, this is the MERGED label (`G` wins), not the winning row's own type.
   */
  nameType: "G" | "B";
};

/** How many suggestions the picker shows. Eight fits without scrolling. */
const DEFAULT_LIMIT = 8;

/**
 * Match strength, mirroring DailyMed's own substring semantics.
 *
 * The gaps are wide enough that no penalty below can reorder two names in
 * different tiers, which is the property that makes the ordering predictable.
 */
const BASE_EXACT = 1000;
const BASE_WORD_PREFIX = 800;
const BASE_PREFIX = 600;
const BASE_CONTAINS = 400;

/**
 * A combination product is decisively worse than a single-ingredient match at
 * the same strength.
 *
 * Wide enough to outweigh the entire token penalty a name of up to 25 words
 * could accumulate, so within a tier — both exact, both prefix, both substring —
 * the single ingredient always wins. Across tiers it cannot, and should not: a
 * combination that begins with the word that was typed (`METFORMIN AND
 * SITAGLIPTIN`) is a better answer than a single ingredient that merely contains
 * it late in a long name. What this fixes is the alphabetical lead, where
 * `metformin` offers `ALOGLIPTIN AND METFORMIN HYDROCHLORIDE` first.
 */
const COMBINATION_PENALTY = 500;

/** Cheap per extra word, so a salt or dosage form costs little. */
const EXTRA_TOKEN_PENALTY = 20;

/**
 * How DailyMed joins multi-ingredient products.
 *
 * Deliberately the joiners only, and deliberately NOT a token count: a count
 * would misfire on honest single-ingredient names such as `INSULIN LISPRO` and
 * `INSULIN GLARGINE`, which is a far worse error than missing an exotic
 * combination whose name does not use a joiner.
 *
 * The bare `"/"` is not a tidied-up version of `" / "` — measured against the
 * live service, DailyMed writes `OMEPRAZOLE/BICARBONATE` and `AMOXICILLIN
 * CLAV/POT` with NO surrounding spaces, so only the bare form matches what is
 * actually returned. A single-ingredient name containing a slash is not a thing.
 */
const COMBINATION_JOINERS = [" AND ", " + ", "/"];

/**
 * Uppercase, one space between words.
 *
 * Leading punctuation is NOT stripped. DailyMed really does return rows like
 * `.INSULIN ASPART` and `1.85% HYDROCORTISONE ACETATE …`, and those are better
 * ranked low as a plain substring match than promoted to a prefix match by
 * tidying them up first.
 */
function normalize(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

/** Words in the name that the query does not account for. */
function extraTokens(name: string, query: string): number {
  const queryTokens = new Set(query.split(" "));
  return name.split(" ").filter((token) => !queryTokens.has(token)).length;
}

/** Null when the row does not match the query at all. */
function score(name: string, query: string): number | null {
  let base: number;

  if (name === query) base = BASE_EXACT;
  else if (name.startsWith(`${query} `)) base = BASE_WORD_PREFIX;
  else if (name.startsWith(query)) base = BASE_PREFIX;
  else if (name.includes(query)) base = BASE_CONTAINS;
  else return null;

  if (COMBINATION_JOINERS.some((joiner) => name.includes(joiner))) {
    base -= COMBINATION_PENALTY;
  }

  return base - extraTokens(name, query) * EXTRA_TOKEN_PENALTY;
}

/**
 * Dedupe, rank and cap one page of DailyMed rows.
 *
 * The dedupe is not cosmetic. DailyMed lists a combination product twice, once
 * as `B` and once as `G` — `ALOGLIPTIN AND METFORMIN HYDROCHLORIDE` appears on
 * two consecutive rows — so without it a third of the dropdown is the same name
 * printed twice, and a brand that is only ever a `B` would be dropped entirely
 * by a naive `filter(name_type === "G")`.
 */
export function rankDrugNames(
  rows: readonly DailyMedRow[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): DrugSuggestion[] {
  const normalizedQuery = normalize(query);
  if (normalizedQuery === "") return [];

  const merged = new Map<string, Set<string>>();

  for (const row of rows) {
    const rawName = typeof row.drug_name === "string" ? row.drug_name : "";
    if (rawName.trim() === "") continue;

    // Case-folded because this is an external API's casing, not ours to trust.
    const rawType = (row.name_type ?? "").trim().toUpperCase();
    if (rawType !== "G" && rawType !== "B") continue;

    const name = normalize(rawName);
    const types = merged.get(name);
    if (types) types.add(rawType);
    else merged.set(name, new Set([rawType]));
  }

  const ranked: { suggestion: DrugSuggestion; score: number }[] = [];

  for (const [name, types] of merged) {
    const value = score(name, normalizedQuery);
    if (value === null) continue;

    ranked.push({
      suggestion: { name, nameType: types.has("G") ? "G" : "B" },
      score: value,
    });
  }

  /*
   * How many other names in this payload are built ON this one — how many
   * extend it by another word.
   *
   * This is the only signal the payload carries about which of two equally good
   * matches is the drug and which is the lookalike, and it is the one that
   * settles `atorva`. Measured against the live service: `ATORVASTATIN` is the
   * stem of `ATORVASTATIN CALCIUM`, `ATORVASTATIN FILM COATED` and several more,
   * while `ATORVALIQ` is the stem of nothing. It is also what makes `OMEPRAZOLE`
   * beat `OMEPRAZOLE/BICARBONATE` on purpose rather than by accident.
   *
   * Used ONLY as a tie-break below, never as a score bonus, so it can never lift
   * a name above a better match — it only decides between names already equal.
   * O(n²) over at most 100 deduped names, which is microseconds.
   */
  const families = [...merged.keys()];
  const variants = new Map<string, number>();

  for (const name of families) {
    let count = 0;
    for (const other of families) {
      if (other.startsWith(`${name} `)) count += 1;
    }
    variants.set(name, count);
  }

  ranked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;

    /*
     * Generic before brand.
     *
     * Weaker than it looks, and worth being honest about: DailyMed types
     * `ATORVALIQ` as a GENERIC, so for `atorva` this separates nothing. It is
     * kept because it is free and correct where it does apply, but the variant
     * count below is what actually resolves that tie.
     */
    const aGeneric = a.suggestion.nameType === "G" ? 0 : 1;
    const bGeneric = b.suggestion.nameType === "G" ? 0 : 1;
    if (aGeneric !== bGeneric) return aGeneric - bGeneric;

    // Then the name that other products are variants of.
    const aVariants = variants.get(a.suggestion.name) ?? 0;
    const bVariants = variants.get(b.suggestion.name) ?? 0;
    if (aVariants !== bVariants) return bVariants - aVariants;

    /*
     * Only now, length — and it must come after both of the above.
     *
     * `ATORVALIQ` is shorter than `ATORVASTATIN` and `OMEPRAZOLE/BICARBONATE`
     * is longer than `OMEPRAZOLE`, so length alone gets one of the two right and
     * one wrong. It is the last resort it should be, not the first.
     */
    if (a.suggestion.name.length !== b.suggestion.name.length) {
      return a.suggestion.name.length - b.suggestion.name.length;
    }

    // Plain comparison, not localeCompare: these are ASCII drug names, and a
    // locale-sensitive order would make the dropdown depend on the server's ICU.
    if (a.suggestion.name === b.suggestion.name) return 0;
    return a.suggestion.name < b.suggestion.name ? -1 : 1;
  });

  return ranked.slice(0, limit).map((entry) => entry.suggestion);
}
