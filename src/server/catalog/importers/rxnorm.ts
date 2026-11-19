import { systemPrisma } from "@/server/db";
import { getCatalogSource } from "@/server/catalog/sources";
import { computeChecksum, normalizeIngredientName } from "@/server/catalog/utils";
import type { ImportResultSummary } from "./eg-drugs";

export interface RxNormConceptResult {
  rxcui: string;
  name: string;
  synonyms: string[];
}

/**
 * Fetch RxCUI and concept properties from NLM RxNav REST API.
 */
export async function lookupRxNormIngredient(
  ingredientName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RxNormConceptResult | null> {
  const clean = normalizeIngredientName(ingredientName);
  if (!clean) return null;

  try {
    // 1. Try exact name lookup
    const exactUrl = `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(clean)}`;
    const res = await fetchImpl(exactUrl, {
      headers: { Accept: "application/json", "User-Agent": "WASALH-ClinicalCatalog/1.0" },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = (await res.json()) as { idGroup?: { rxnormId?: string[] } };
      const rxnormId = data.idGroup?.rxnormId?.[0];
      if (rxnormId && /^\d+$/.test(rxnormId)) {
        const synonyms = await fetchRxNormSynonyms(rxnormId, fetchImpl);
        return {
          rxcui: rxnormId,
          name: clean,
          synonyms,
        };
      }
    }

    // 2. Fallback to approximate term match
    const approxUrl = `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(clean)}&maxEntries=1`;
    const approxRes = await fetchImpl(approxUrl, {
      headers: { Accept: "application/json", "User-Agent": "WASALH-ClinicalCatalog/1.0" },
      signal: AbortSignal.timeout(5000),
    });

    if (approxRes.ok) {
      const data = (await approxRes.json()) as {
        approximateGroup?: { candidate?: Array<{ rxcui?: string; score?: string }> };
      };
      const candidate = data.approximateGroup?.candidate?.[0];
      if (candidate?.rxcui && Number(candidate.score || 0) >= 70) {
        const synonyms = await fetchRxNormSynonyms(candidate.rxcui, fetchImpl);
        return {
          rxcui: candidate.rxcui,
          name: clean,
          synonyms,
        };
      }
    }
  } catch (err) {
    // Graceful network handling for API boundaries
  }

  return null;
}

/**
 * Fetch synonyms for an RxCUI.
 */
async function fetchRxNormSynonyms(rxcui: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  try {
    const url = `https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/allProperties.json?prop=names`;
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "WASALH-ClinicalCatalog/1.0" },
      signal: AbortSignal.timeout(4000),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        propConceptGroup?: { propConcept?: Array<{ propName?: string; propValue?: string }> };
      };
      const names = new Set<string>();
      for (const item of data.propConceptGroup?.propConcept || []) {
        if (item.propValue && item.propValue.trim()) {
          names.add(normalizeIngredientName(item.propValue));
        }
      }
      return Array.from(names);
    }
  } catch {}

  return [];
}

/**
 * Normalizes ingredients in the database using RxNorm.
 * Updates ingredient records with verified RxCUIs, synonyms, and updates verificationState to CROSS_SOURCE_MATCHED.
 * Repeatable and idempotent.
 */
export async function normalizeIngredientsWithRxNorm(
  options: {
    limit?: number;
    targetIngredientNames?: string[];
    fetchImpl?: typeof fetch;
    batchLabel?: string;
  } = {},
): Promise<ImportResultSummary> {
  const startTime = Date.now();
  const source = await getCatalogSource("rxnorm");
  const fetcher = options.fetchImpl || fetch;

  // Find ingredients to normalize (those without rxcui, or specific targets)
  const whereClause = options.targetIngredientNames?.length
    ? { name: { in: options.targetIngredientNames.map(normalizeIngredientName) } }
    : { rxcui: null };

  const ingredients = await systemPrisma.ingredient.findMany({
    where: whereClause,
    take: options.limit || 50,
  });

  const batchChecksum = computeChecksum(ingredients.map((i) => i.name));

  const importLog = await systemPrisma.drugCatalogImport.create({
    data: {
      sourceId: source.id,
      status: "IN_PROGRESS",
      totalRecords: ingredients.length,
      sourceVersion: source.version,
      checksum: batchChecksum,
      logDetails: {
        batchLabel: options.batchLabel ?? "rxnorm_normalization",
        startedAt: new Date().toISOString(),
      },
    },
  });

  let updatedRecords = 0;
  let unmatchedIngredients = 0;
  let duplicateRecords = 0;

  for (const ing of ingredients) {
    if (ing.rxcui) {
      duplicateRecords++;
      continue;
    }

    const rxResult = await lookupRxNormIngredient(ing.name, fetcher);
    if (rxResult && rxResult.rxcui) {
      // Merge unique synonyms
      const mergedSynonyms = Array.from(
        new Set([...(ing.synonyms || []), ...rxResult.synonyms, ing.name]),
      );

      await systemPrisma.ingredient.update({
        where: { id: ing.id },
        data: {
          rxcui: rxResult.rxcui,
          synonyms: mergedSynonyms,
          verificationState: "CROSS_SOURCE_MATCHED",
        },
      });

      updatedRecords++;
    } else {
      unmatchedIngredients++;
    }
  }

  const durationMs = Date.now() - startTime;

  await systemPrisma.drugCatalogImport.update({
    where: { id: importLog.id },
    data: {
      status: "COMPLETED",
      insertedRecords: 0,
      updatedRecords,
      duplicateRecords,
      invalidRecords: 0,
      unmatchedIngredients,
      missingStrengths: 0,
      logDetails: {
        batchLabel: options.batchLabel ?? "rxnorm_normalization",
        durationMs,
        completedAt: new Date().toISOString(),
      },
    },
  });

  return {
    importId: importLog.id,
    source: "rxnorm",
    totalRecords: ingredients.length,
    insertedRecords: 0,
    updatedRecords,
    duplicateRecords,
    invalidRecords: 0,
    unmatchedIngredients,
    missingStrengths: 0,
    checksum: batchChecksum,
    durationMs,
  };
}
