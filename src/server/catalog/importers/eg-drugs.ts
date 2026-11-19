import { systemPrisma } from "@/server/db";
import { getCatalogSource } from "@/server/catalog/sources";
import {
  computeChecksum,
  extractDosageForm,
  extractStrength,
  inferRouteFromForm,
  splitActiveIngredients,
} from "@/server/catalog/utils";
import { Prisma } from "@/generated/prisma/client";

export interface EgDrugRawItem {
  id: number;
  name: string;
  arabic?: string | null;
  active?: string | null;
  company?: string | null;
  price?: string | null;
  oldprice?: string | null;
  barcode?: string | null;
  slug?: string | null;
  units?: string | null;
  description?: string | null;
  uses?: string | null;
  barcode_valid?: string | null;
}

export interface ImportResultSummary {
  importId: string;
  source: string;
  totalRecords: number;
  insertedRecords: number;
  updatedRecords: number;
  duplicateRecords: number;
  invalidRecords: number;
  unmatchedIngredients: number;
  missingStrengths: number;
  checksum: string;
  durationMs: number;
}

/**
 * Importer for Egyptian Medication Catalog (eg-drugs).
 * CC BY 4.0 Attribution: Mahmoud Falous (mahmoudfalous/eg-drugs).
 *
 * Fully repeatable and idempotent.
 */
export async function importEgDrugs(
  records: EgDrugRawItem[],
  options: { maxRecords?: number; batchLabel?: string } = {},
): Promise<ImportResultSummary> {
  const startTime = Date.now();
  const source = await getCatalogSource("eg-drugs");

  const itemsToProcess = options.maxRecords
    ? records.slice(0, options.maxRecords)
    : records;

  const batchChecksum = computeChecksum(itemsToProcess);

  // Initialize Catalog Import audit row
  const importLog = await systemPrisma.drugCatalogImport.create({
    data: {
      sourceId: source.id,
      status: "IN_PROGRESS",
      totalRecords: itemsToProcess.length,
      sourceVersion: source.version,
      checksum: batchChecksum,
      logDetails: {
        batchLabel: options.batchLabel ?? "sample_or_full",
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

  // In-memory cache of resolved ingredients to minimize transatlantic DB roundtrips
  const ingredientCache = new Map<string, string>(); // name -> id

  for (const item of itemsToProcess) {
    if (!item.name || !item.name.trim()) {
      invalidRecords++;
      continue;
    }

    const brandNameEn = item.name.trim();
    const brandNameAr = item.arabic?.trim() || null;
    const manufacturer = item.company?.trim() || null;
    const dosageForm = extractDosageForm(brandNameEn) || "Tablet";
    const strength = extractStrength(brandNameEn);
    const route = inferRouteFromForm(dosageForm);

    if (!strength) {
      missingStrengths++;
    }

    // Active ingredients
    const activeNames = splitActiveIngredients(item.active);
    if (activeNames.length === 0) {
      unmatchedIngredients++;
    }

    const genericName = activeNames.length > 0 ? activeNames.join(" + ") : null;

    // Numerical price
    let parsedPrice: Prisma.Decimal | null = null;
    if (item.price && !isNaN(Number(item.price))) {
      parsedPrice = new Prisma.Decimal(item.price);
    }

    const itemChecksum = computeChecksum(item);

    // Check if product with this source and external ID already exists
    const existingSourceRecord = await systemPrisma.drugProductSourceRecord.findFirst({
      where: {
        sourceId: source.id,
        sourceExternalId: String(item.id),
      },
      select: {
        id: true,
        recordChecksum: true,
        productId: true,
      },
    });

    if (existingSourceRecord && existingSourceRecord.productId) {
      if (existingSourceRecord.recordChecksum === itemChecksum) {
        // Exactly identical, no changes needed
        duplicateRecords++;
        continue;
      }

      // Update existing product
      await systemPrisma.drugProduct.update({
        where: { id: existingSourceRecord.productId },
        data: {
          brandName: brandNameEn,
          brandNameAr,
          genericName,
          manufacturer,
          strength,
          dosageForm,
          route,
          price: parsedPrice,
          units: item.units?.trim() || null,
          category: item.description?.trim() || null,
          indications: item.uses?.trim() || null,
          metadata: {
            oldPrice: item.oldprice || null,
            slug: item.slug || null,
          },
        },
      });

      await systemPrisma.drugProductSourceRecord.update({
        where: { id: existingSourceRecord.id },
        data: {
          rawPayload: item as unknown as Prisma.InputJsonValue,
          recordChecksum: itemChecksum,
          importId: importLog.id,
        },
      });

      updatedRecords++;
      continue;
    }

    // Create new DrugProduct
    const drugProduct = await systemPrisma.drugProduct.create({
      data: {
        sourceId: source.id,
        country: "EG",
        brandName: brandNameEn,
        brandNameAr,
        genericName,
        manufacturer,
        strength,
        dosageForm,
        route,
        verificationState: "IMPORTED_UNVERIFIED",
        price: parsedPrice,
        currency: "EGP",
        units: item.units?.trim() || null,
        category: item.description?.trim() || null,
        indications: item.uses?.trim() || null,
        metadata: {
          egDrugsId: item.id,
          slug: item.slug || null,
          oldPrice: item.oldprice || null,
        },
      },
    });

    // Create / Connect Ingredients with in-memory caching
    for (let i = 0; i < activeNames.length; i++) {
      const ingredientName = activeNames[i];
      let ingredientId = ingredientCache.get(ingredientName);

      if (!ingredientId) {
        const ingredient = await systemPrisma.ingredient.upsert({
          where: { name: ingredientName },
          update: {},
          create: {
            name: ingredientName,
            source: "eg-drugs",
            verificationState: "IMPORTED_UNVERIFIED",
          },
          select: { id: true },
        });
        ingredientId = ingredient.id;
        ingredientCache.set(ingredientName, ingredientId);
      }

      await systemPrisma.productIngredient.upsert({
        where: {
          productId_ingredientId: {
            productId: drugProduct.id,
            ingredientId,
          },
        },
        update: {},
        create: {
          productId: drugProduct.id,
          ingredientId,
          orderIndex: i,
          isPrimary: i === 0,
          strength: activeNames.length === 1 ? strength : null,
        },
      });
    }

    // Add Identifiers
    const identifierCreates: Array<Promise<unknown>> = [];

    if (item.barcode && item.barcode.trim()) {
      identifierCreates.push(
        systemPrisma.drugProductIdentifier.create({
          data: {
            productId: drugProduct.id,
            idType: "BARCODE",
            identifier: item.barcode.trim(),
            isValid: item.barcode_valid === "1",
            issuer: "GS1",
          },
        }),
      );
    }

    if (item.slug && item.slug.trim()) {
      identifierCreates.push(
        systemPrisma.drugProductIdentifier.create({
          data: {
            productId: drugProduct.id,
            idType: "SLUG",
            identifier: item.slug.trim(),
            issuer: "eg-drugs",
          },
        }),
      );
    }

    // Store raw provenance record
    identifierCreates.push(
      systemPrisma.drugProductSourceRecord.create({
        data: {
          productId: drugProduct.id,
          sourceId: source.id,
          importId: importLog.id,
          sourceExternalId: String(item.id),
          rawPayload: item as unknown as Prisma.InputJsonValue,
          license: source.license,
          recordChecksum: itemChecksum,
        },
      }),
    );

    await Promise.all(identifierCreates);

    insertedRecords++;
  }

  const durationMs = Date.now() - startTime;

  // Complete import log
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
        batchLabel: options.batchLabel ?? "sample_or_full",
        durationMs,
        completedAt: new Date().toISOString(),
      },
    },
  });

  return {
    importId: importLog.id,
    source: "eg-drugs",
    totalRecords: itemsToProcess.length,
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
