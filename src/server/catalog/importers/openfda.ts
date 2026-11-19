import { systemPrisma } from "@/server/db";
import { getCatalogSource } from "@/server/catalog/sources";
import { computeChecksum, extractStrength, normalizeIngredientName } from "@/server/catalog/utils";
import { Prisma } from "@/generated/prisma/client";
import type { ImportResultSummary } from "./eg-drugs";

export interface OpenFdaLabelResult {
  id: string;
  brand_name?: string[];
  generic_name?: string[];
  manufacturer_name?: string[];
  substance_name?: string[];
  dosage_form?: string[];
  route?: string[];
  package_ndc?: string[];
  product_ndc?: string[];
  indications_and_usage?: string[];
  boxed_warning?: string[];
}

/**
 * Query openFDA drug label API for supplementary US label information.
 */
export async function fetchOpenFdaLabels(
  searchTerm: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenFdaLabelResult[]> {
  try {
    const clean = encodeURIComponent(`openfda.generic_name:"${searchTerm}"+openfda.brand_name:"${searchTerm}"`);
    const url = `https://api.fda.gov/drug/label.json?search=${clean}&limit=5`;
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "User-Agent": "WASALH-ClinicalCatalog/1.0" },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as {
      results?: Array<{
        id?: string;
        openfda?: {
          brand_name?: string[];
          generic_name?: string[];
          manufacturer_name?: string[];
          substance_name?: string[];
          dosage_form?: string[];
          route?: string[];
          package_ndc?: string[];
          product_ndc?: string[];
        };
        indications_and_usage?: string[];
        boxed_warning?: string[];
      }>;
    };

    const out: OpenFdaLabelResult[] = [];
    for (const r of data.results || []) {
      if (!r.id) continue;
      out.push({
        id: r.id,
        brand_name: r.openfda?.brand_name,
        generic_name: r.openfda?.generic_name,
        manufacturer_name: r.openfda?.manufacturer_name,
        substance_name: r.openfda?.substance_name,
        dosage_form: r.openfda?.dosage_form,
        route: r.openfda?.route,
        package_ndc: r.openfda?.package_ndc,
        product_ndc: r.openfda?.product_ndc,
        indications_and_usage: r.indications_and_usage,
        boxed_warning: r.boxed_warning,
      });
    }

    return out;
  } catch {
    return [];
  }
}

/**
 * Importer for openFDA supplementary US medication label & NDC information.
 * Repeatable and idempotent.
 */
export async function importOpenFdaLabels(
  searchTerms: string[],
  options: { fetchImpl?: typeof fetch; batchLabel?: string } = {},
): Promise<ImportResultSummary> {
  const startTime = Date.now();
  const source = await getCatalogSource("openfda");
  const fetcher = options.fetchImpl || fetch;

  const batchChecksum = computeChecksum(searchTerms);

  const importLog = await systemPrisma.drugCatalogImport.create({
    data: {
      sourceId: source.id,
      status: "IN_PROGRESS",
      totalRecords: searchTerms.length,
      sourceVersion: source.version,
      checksum: batchChecksum,
      logDetails: {
        batchLabel: options.batchLabel ?? "openfda_import",
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

  for (const term of searchTerms) {
    if (!term.trim()) {
      invalidRecords++;
      continue;
    }

    const labels = await fetchOpenFdaLabels(term, fetcher);
    if (labels.length === 0) {
      unmatchedIngredients++;
      continue;
    }

    for (const label of labels) {
      const brandName = label.brand_name?.[0] || label.generic_name?.[0] || term;
      const genericName = label.generic_name?.[0] || null;
      const manufacturer = label.manufacturer_name?.[0] || null;
      const dosageForm = label.dosage_form?.[0] || "Tablet";
      const route = label.route?.[0] || "Oral";
      const strength = extractStrength(brandName) || (genericName ? extractStrength(genericName) : null);
      if (!strength) missingStrengths++;

      const itemChecksum = computeChecksum(label);

      const existingSourceRecord = await systemPrisma.drugProductSourceRecord.findFirst({
        where: {
          sourceId: source.id,
          sourceExternalId: label.id,
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
            brandName,
            genericName,
            manufacturer,
            dosageForm,
            route,
            strength,
            metadata: label as unknown as Prisma.InputJsonValue,
          },
        });
        updatedRecords++;
        continue;
      }

      const drugProduct = await systemPrisma.drugProduct.create({
        data: {
          sourceId: source.id,
          country: "US",
          brandName,
          genericName,
          manufacturer,
          dosageForm,
          route,
          strength,
          verificationState: "IMPORTED_UNVERIFIED",
          metadata: {
            openFdaId: label.id,
            boxedWarning: label.boxed_warning?.[0] || null,
          },
        },
      });

      // Link Active Ingredients
      for (const sub of label.substance_name || []) {
        const norm = normalizeIngredientName(sub);
        if (norm) {
          const ingredient = await systemPrisma.ingredient.upsert({
            where: { name: norm },
            update: {},
            create: {
              name: norm,
              source: "openfda",
              verificationState: "IMPORTED_UNVERIFIED",
            },
          });

          await systemPrisma.productIngredient.upsert({
            where: {
              productId_ingredientId: {
                productId: drugProduct.id,
                ingredientId: ingredient.id,
              },
            },
            update: {},
            create: {
              productId: drugProduct.id,
              ingredientId: ingredient.id,
              strength,
            },
          });
        }
      }

      // Add NDC identifiers in parallel
      const ndcList = [...(label.package_ndc || []), ...(label.product_ndc || [])];
      await Promise.all(
        ndcList.map((ndc) =>
          systemPrisma.drugProductIdentifier.upsert({
            where: {
              idType_identifier_productId: {
                idType: "NDC",
                identifier: ndc,
                productId: drugProduct.id,
              },
            },
            update: {},
            create: {
              productId: drugProduct.id,
              idType: "NDC",
              identifier: ndc,
              issuer: "FDA",
            },
          }),
        ),
      );

      // Provenance record
      await systemPrisma.drugProductSourceRecord.create({
        data: {
          productId: drugProduct.id,
          sourceId: source.id,
          importId: importLog.id,
          sourceExternalId: label.id,
          rawPayload: label as unknown as Prisma.InputJsonValue,
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
        batchLabel: options.batchLabel ?? "openfda_import",
        durationMs,
        completedAt: new Date().toISOString(),
      },
    },
  });

  return {
    importId: importLog.id,
    source: "openfda",
    totalRecords: searchTerms.length,
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
