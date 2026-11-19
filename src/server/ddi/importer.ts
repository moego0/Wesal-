import { systemPrisma } from "@/server/db";
import { normalizeIngredientName } from "@/server/catalog/utils";
import { Prisma } from "@/generated/prisma/client";

export interface DDInterRawRecord {
  DDInterID_A: string;
  Drug_A: string;
  DDInterID_B: string;
  Drug_B: string;
  Level: string; // Major, Moderate, Minor, Unknown
  description?: string;
  mechanism?: string;
  management?: string;
  reference?: string;
}

export interface DdiImportSummary {
  totalRecords: number;
  insertedInteractions: number;
  duplicateInteractions: number;
  unmatchedRecords: number;
  unmatchedDrugNames: string[];
  durationMs: number;
}

/**
 * Maps DDInter text risk level to DdiSeverity enum.
 */
function mapSeverity(level?: string): "MAJOR" | "MODERATE" | "MINOR" | "UNKNOWN" {
  if (!level) return "UNKNOWN";
  switch (level.trim().toLowerCase()) {
    case "major":
      return "MAJOR";
    case "moderate":
      return "MODERATE";
    case "minor":
      return "MINOR";
    default:
      return "UNKNOWN";
  }
}

/**
 * DDInter 2.0 Dataset Importer.
 * License: CC BY-NC-SA 4.0.
 *
 * Maps DDInter drugs to Wesal's standardized Ingredients.
 * Never automatically matches based solely on similar names.
 * Flags ambiguous/unmatched records into DdiUnmatchedRecord.
 * Imported interactions start in IMPORTED_UNREVIEWED state.
 */
export async function importDDInterInteractions(
  records: DDInterRawRecord[],
  options: { batchLabel?: string } = {},
): Promise<DdiImportSummary> {
  const startTime = Date.now();

  let insertedInteractions = 0;
  let duplicateInteractions = 0;
  let unmatchedCount = 0;
  const unmatchedDrugNamesSet = new Set<string>();

  // In-memory cache for ingredient lookup: normalized name / synonym -> ingredientId
  const ingredientLookupCache = new Map<string, string | null>();

  async function resolveIngredientId(rawName: string): Promise<string | null> {
    const clean = normalizeIngredientName(rawName);
    if (!clean) return null;

    if (ingredientLookupCache.has(clean)) {
      return ingredientLookupCache.get(clean)!;
    }

    // 1. Try exact name match
    let ing = await systemPrisma.ingredient.findUnique({
      where: { name: clean },
      select: { id: true },
    });

    // 2. Try exact synonym match
    if (!ing) {
      ing = await systemPrisma.ingredient.findFirst({
        where: {
          synonyms: { has: clean },
        },
        select: { id: true },
      });
    }

    const resolvedId = ing?.id || null;
    ingredientLookupCache.set(clean, resolvedId);
    return resolvedId;
  }

  for (const row of records) {
    if (!row.Drug_A || !row.Drug_B) continue;

    const ingAId = await resolveIngredientId(row.Drug_A);
    const ingBId = await resolveIngredientId(row.Drug_B);

    if (!ingAId || !ingBId) {
      unmatchedCount++;
      const reason = !ingAId && !ingBId
        ? "UNMATCHED_BOTH_DRUGS"
        : !ingAId
          ? "UNMATCHED_DRUG_A"
          : "UNMATCHED_DRUG_B";

      if (!ingAId) unmatchedDrugNamesSet.add(row.Drug_A);
      if (!ingBId) unmatchedDrugNamesSet.add(row.Drug_B);

      // Preserve unmatched record for future mapping audit
      await systemPrisma.ddiUnmatchedRecord.create({
        data: {
          source: "DDInter 2.0",
          sourceDrugAId: row.DDInterID_A,
          sourceDrugAName: row.Drug_A,
          sourceDrugBId: row.DDInterID_B,
          sourceDrugBName: row.Drug_B,
          severity: row.Level || "UNKNOWN",
          reason,
          rawRecord: row as unknown as Prisma.InputJsonValue,
        },
      });

      continue;
    }

    // Deterministic ordering of ingredient IDs so (A, B) and (B, A) are uniform
    const [firstId, secondId] = ingAId < ingBId ? [ingAId, ingBId] : [ingBId, ingAId];
    const isReversed = firstId !== ingAId;

    const sourceDrugAId = isReversed ? row.DDInterID_B : row.DDInterID_A;
    const sourceDrugBId = isReversed ? row.DDInterID_A : row.DDInterID_B;
    const sourceDrugAName = isReversed ? row.Drug_B : row.Drug_A;
    const sourceDrugBName = isReversed ? row.Drug_A : row.Drug_B;

    const severity = mapSeverity(row.Level);

    // Check if interaction already exists
    const existing = await systemPrisma.ddiInteraction.findUnique({
      where: {
        ingredientAId_ingredientBId_source: {
          ingredientAId: firstId,
          ingredientBId: secondId,
          source: "DDInter 2.0",
        },
      },
      select: { id: true },
    });

    if (existing) {
      duplicateInteractions++;
      continue;
    }

    // Insert interaction with IMPORTED_UNREVIEWED clinical status
    await systemPrisma.ddiInteraction.create({
      data: {
        ingredientAId: firstId,
        ingredientBId: secondId,
        sourceDrugAId,
        sourceDrugBId,
        sourceDrugAName,
        sourceDrugBName,
        severity,
        description: row.description || `Potential pharmacokinetic/pharmacodynamic interaction between ${sourceDrugAName} and ${sourceDrugBName}.`,
        mechanism: row.mechanism || null,
        management: row.management || null,
        source: "DDInter 2.0",
        license: "CC BY-NC-SA 4.0",
        reference: row.reference || "DDInter 2.0 Research Database",
        clinicalApprovalState: "IMPORTED_UNREVIEWED",
      },
    });

    insertedInteractions++;
  }

  const durationMs = Date.now() - startTime;

  return {
    totalRecords: records.length,
    insertedInteractions,
    duplicateInteractions,
    unmatchedRecords: unmatchedCount,
    unmatchedDrugNames: Array.from(unmatchedDrugNamesSet),
    durationMs,
  };
}
