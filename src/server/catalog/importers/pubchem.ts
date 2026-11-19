import { systemPrisma } from "@/server/db";
import { getCatalogSource } from "@/server/catalog/sources";
import { computeChecksum, normalizeIngredientName } from "@/server/catalog/utils";
import type { ImportResultSummary } from "./eg-drugs";

export interface PubChemCompoundResult {
  cid: string;
  inchiKey?: string | null;
  molecularFormula?: string | null;
  synonyms: string[];
}

/**
 * Lookup compound details from PubChem PUG REST API.
 */
export async function lookupPubChemCompound(
  ingredientName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PubChemCompoundResult | null> {
  const clean = normalizeIngredientName(ingredientName);
  if (!clean) return null;

  try {
    // 1. Fetch CID for compound name
    const cidUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(clean)}/cids/JSON`;
    const res = await fetchImpl(cidUrl, {
      headers: { Accept: "application/json", "User-Agent": "WASALH-ClinicalCatalog/1.0" },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const cidData = (await res.json()) as { IdentifierList?: { CID?: number[] } };
    const cidNum = cidData.IdentifierList?.CID?.[0];
    if (!cidNum) return null;

    const cid = String(cidNum);

    // 2. Fetch properties (InChIKey, MolecularFormula)
    let inchiKey: string | null = null;
    let molecularFormula: string | null = null;

    try {
      const propUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/InChIKey,MolecularFormula/JSON`;
      const propRes = await fetchImpl(propUrl, {
        headers: { Accept: "application/json", "User-Agent": "WASALH-ClinicalCatalog/1.0" },
        signal: AbortSignal.timeout(4000),
      });
      if (propRes.ok) {
        const propData = (await propRes.json()) as {
          PropertyTable?: { Properties?: Array<{ InChIKey?: string; MolecularFormula?: string }> };
        };
        const props = propData.PropertyTable?.Properties?.[0];
        inchiKey = props?.InChIKey || null;
        molecularFormula = props?.MolecularFormula || null;
      }
    } catch {}

    // 3. Fetch Synonyms
    const synonyms: string[] = [];
    try {
      const synUrl = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/synonyms/JSON`;
      const synRes = await fetchImpl(synUrl, {
        headers: { Accept: "application/json", "User-Agent": "WASALH-ClinicalCatalog/1.0" },
        signal: AbortSignal.timeout(4000),
      });
      if (synRes.ok) {
        const synData = (await synRes.json()) as {
          InformationList?: { Information?: Array<{ Synonym?: string[] }> };
        };
        const list = synData.InformationList?.Information?.[0]?.Synonym || [];
        for (const s of list.slice(0, 15)) {
          const norm = normalizeIngredientName(s);
          if (norm && norm.length > 2 && norm.length < 50) {
            synonyms.push(norm);
          }
        }
      }
    } catch {}

    return {
      cid,
      inchiKey,
      molecularFormula,
      synonyms,
    };
  } catch {
    return null;
  }
}

/**
 * Normalizes ingredients in the database using PubChem.
 * Enriches ingredient records with PubChem CID, InChIKey, and synonyms.
 * Repeatable and idempotent.
 */
export async function normalizeIngredientsWithPubChem(
  options: {
    limit?: number;
    targetIngredientNames?: string[];
    fetchImpl?: typeof fetch;
    batchLabel?: string;
  } = {},
): Promise<ImportResultSummary> {
  const startTime = Date.now();
  const source = await getCatalogSource("pubchem");
  const fetcher = options.fetchImpl || fetch;

  const whereClause = options.targetIngredientNames?.length
    ? { name: { in: options.targetIngredientNames.map(normalizeIngredientName) } }
    : { pubchemCid: null };

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
        batchLabel: options.batchLabel ?? "pubchem_normalization",
        startedAt: new Date().toISOString(),
      },
    },
  });

  let updatedRecords = 0;
  let unmatchedIngredients = 0;
  let duplicateRecords = 0;

  for (const ing of ingredients) {
    if (ing.pubchemCid) {
      duplicateRecords++;
      continue;
    }

    const compound = await lookupPubChemCompound(ing.name, fetcher);
    if (compound && compound.cid) {
      const mergedSynonyms = Array.from(
        new Set([...(ing.synonyms || []), ...compound.synonyms, ing.name]),
      );

      await systemPrisma.ingredient.update({
        where: { id: ing.id },
        data: {
          pubchemCid: compound.cid,
          inchiKey: compound.inchiKey || ing.inchiKey,
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
        batchLabel: options.batchLabel ?? "pubchem_normalization",
        durationMs,
        completedAt: new Date().toISOString(),
      },
    },
  });

  return {
    importId: importLog.id,
    source: "pubchem",
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
