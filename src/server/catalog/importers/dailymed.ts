import { systemPrisma } from "@/server/db";
import { getCatalogSource } from "@/server/catalog/sources";
import { computeChecksum, extractDosageForm, extractStrength, inferRouteFromForm } from "@/server/catalog/utils";
import { Prisma } from "@/generated/prisma/client";
import type { ImportResultSummary } from "./eg-drugs";

export interface DailyMedSplItem {
  setid: string;
  title: string;
  labeler: string;
  published_date?: string;
  drug_name?: string;
}

/**
 * Fetch SPL label metadata from DailyMed v2 REST API.
 */
export async function fetchDailyMedSpls(
  drugName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DailyMedSplItem[]> {
  try {
    const url = `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=${encodeURIComponent(drugName)}&pagesize=10`;
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "WASALH-ClinicalCatalog/1.0" },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as { data?: DailyMedSplItem[] };
    return data.data || [];
  } catch {
    return [];
  }
}

/**
 * Importer for DailyMed supplementary US medication label information.
 * Enriches catalog products with official label SetIDs and package insert metadata.
 * Repeatable and idempotent.
 */
export async function importDailyMedLabels(
  drugNames: string[],
  options: { fetchImpl?: typeof fetch; batchLabel?: string } = {},
): Promise<ImportResultSummary> {
  const startTime = Date.now();
  const source = await getCatalogSource("dailymed");
  const fetcher = options.fetchImpl || fetch;

  const batchChecksum = computeChecksum(drugNames);

  const importLog = await systemPrisma.drugCatalogImport.create({
    data: {
      sourceId: source.id,
      status: "IN_PROGRESS",
      totalRecords: drugNames.length,
      sourceVersion: source.version,
      checksum: batchChecksum,
      logDetails: {
        batchLabel: options.batchLabel ?? "dailymed_label_import",
        startedAt: new Date().toISOString(),
      },
    },
  });

  let insertedRecords = 0;
  let updatedRecords = 0;
  let duplicateRecords = 0;
  let invalidRecords = 0;
  let unmatchedIngredients = 0;
  let missingStrengths = 0;

  for (const drugName of drugNames) {
    if (!drugName.trim()) {
      invalidRecords++;
      continue;
    }

    const spls = await fetchDailyMedSpls(drugName, fetcher);
    if (spls.length === 0) {
      unmatchedIngredients++;
      continue;
    }

    for (const spl of spls) {
      if (!spl.setid || !spl.title) continue;

      const itemChecksum = computeChecksum(spl);

      // Check existing source record
      const existingSourceRecord = await systemPrisma.drugProductSourceRecord.findFirst({
        where: {
          sourceId: source.id,
          sourceExternalId: spl.setid,
        },
        select: { id: true, recordChecksum: true, productId: true },
      });

      if (existingSourceRecord && existingSourceRecord.productId) {
        if (existingSourceRecord.recordChecksum === itemChecksum) {
          duplicateRecords++;
          continue;
        }

        await systemPrisma.drugProduct.update({
          where: { id: existingSourceRecord.productId },
          data: {
            brandName: spl.title,
            manufacturer: spl.labeler || null,
            metadata: spl as unknown as Prisma.InputJsonValue,
          },
        });
        updatedRecords++;
        continue;
      }

      const dosageForm = extractDosageForm(spl.title) || "Tablet";
      const strength = extractStrength(spl.title);
      if (!strength) missingStrengths++;

      // Create DrugProduct under US jurisdiction for DailyMed SPL
      const drugProduct = await systemPrisma.drugProduct.create({
        data: {
          sourceId: source.id,
          country: "US",
          brandName: spl.title,
          manufacturer: spl.labeler || null,
          dosageForm,
          strength,
          route: inferRouteFromForm(dosageForm),
          verificationState: "IMPORTED_UNVERIFIED",
          metadata: {
            setid: spl.setid,
            publishedDate: spl.published_date || null,
          },
        },
      });

      // Add DAILYMED_SETID identifier
      await systemPrisma.drugProductIdentifier.create({
        data: {
          productId: drugProduct.id,
          idType: "DAILYMED_SETID",
          identifier: spl.setid,
          issuer: "DailyMed/NLM",
        },
      });

      // Provenance record
      await systemPrisma.drugProductSourceRecord.create({
        data: {
          productId: drugProduct.id,
          sourceId: source.id,
          importId: importLog.id,
          sourceExternalId: spl.setid,
          rawPayload: spl as unknown as Prisma.InputJsonValue,
          license: source.license,
          recordChecksum: itemChecksum,
        },
      });

      insertedRecords++;
    }
  }

  const durationMs = Date.now() - startTime;

  await systemPrisma.drugCatalogImport.update({
    where: { id: importLog.id },
    data: {
      status: "COMPLETED",
      insertedRecords,
      updatedRecords,
      duplicateRecords,
      invalidRecords,
      unmatchedIngredients,
      missingStrengths,
      logDetails: {
        batchLabel: options.batchLabel ?? "dailymed_label_import",
        durationMs,
        completedAt: new Date().toISOString(),
      },
    },
  });

  return {
    importId: importLog.id,
    source: "dailymed",
    totalRecords: drugNames.length,
    insertedRecords,
    updatedRecords,
    duplicateRecords,
    invalidRecords,
    unmatchedIngredients,
    missingStrengths,
    checksum: batchChecksum,
    durationMs,
  };
}
