import { systemPrisma } from "@/server/db";
import { getCatalogSource } from "@/server/catalog/sources";
import {
  computeChecksum,
  extractDosageForm,
  extractStrength,
  inferRouteFromForm,
  normalizeIngredientName,
} from "@/server/catalog/utils";
import { Prisma } from "@/generated/prisma/client";
import type { ImportResultSummary } from "./eg-drugs";

export interface OmcIngredientItem {
  name: string;
  strength?: string | null;
  strengthNumerator?: number | null;
  strengthNumeratorUnit?: string | null;
  strengthDenominator?: number | null;
  strengthDenominatorUnit?: string | null;
  isPrimary?: boolean;
}

export interface OmcIdentifierItem {
  idType: string; // NDC, URPL, CIS, SWISSMEDIC, GTIN, OMC_ID
  identifier: string;
  isValid?: boolean;
  issuer?: string;
}

export interface OmcProductRecord {
  id: string;
  country: string; // ISO-3166-1 alpha-2, e.g. "US", "PL", "FR", "CH"
  brandName: string;
  genericName?: string | null;
  manufacturer?: string | null;
  strength?: string | null;
  dosageForm?: string | null;
  route?: string | null;
  registrationNumber?: string | null;
  activeIngredients?: OmcIngredientItem[];
  identifiers?: OmcIdentifierItem[];
  metadata?: Record<string, unknown>;
  upstreamLicense?: string;
}

/**
 * FHIR R4 Medication resource parser to convert OMC FHIR dumps to OmcProductRecord
 */
export function parseFhirMedication(fhir: Record<string, unknown>, country: string): OmcProductRecord | null {
  const id = String(fhir.id || "");
  if (!id) return null;

  const codeObj = fhir.code as { coding?: Array<{ code?: string; display?: string; system?: string }>; text?: string } | undefined;
  const brandName = codeObj?.text || codeObj?.coding?.[0]?.display || id;

  const formObj = fhir.form as { coding?: Array<{ display?: string }>; text?: string } | undefined;
  const dosageForm = formObj?.text || formObj?.coding?.[0]?.display || extractDosageForm(brandName);

  const manufacturerObj = fhir.manufacturer as { display?: string } | undefined;
  const manufacturer = manufacturerObj?.display || null;

  const rawIngredients = (fhir.ingredient as Array<Record<string, unknown>>) || [];
  const activeIngredients: OmcIngredientItem[] = [];

  for (const ing of rawIngredients) {
    const itemConcept = ing.itemCodeableConcept as { text?: string; coding?: Array<{ display?: string }> } | undefined;
    const name = itemConcept?.text || itemConcept?.coding?.[0]?.display;
    if (!name) continue;

    const strengthObj = ing.strength as {
      numerator?: { value?: number; unit?: string };
      denominator?: { value?: number; unit?: string };
    } | undefined;

    let strengthStr: string | null = null;
    if (strengthObj?.numerator?.value) {
      strengthStr = `${strengthObj.numerator.value} ${strengthObj.numerator.unit || ""}`.trim();
      if (strengthObj.denominator?.value && strengthObj.denominator.value > 1) {
        strengthStr += ` / ${strengthObj.denominator.value} ${strengthObj.denominator.unit || ""}`.trim();
      }
    }

    activeIngredients.push({
      name: normalizeIngredientName(name),
      strength: strengthStr,
      strengthNumerator: strengthObj?.numerator?.value || null,
      strengthNumeratorUnit: strengthObj?.numerator?.unit || null,
      strengthDenominator: strengthObj?.denominator?.value || null,
      strengthDenominatorUnit: strengthObj?.denominator?.unit || null,
      isPrimary: activeIngredients.length === 0,
    });
  }

  const identifiers: OmcIdentifierItem[] = [
    { idType: "OMC_ID", identifier: id, issuer: "open-medication-catalog" },
  ];

  if (codeObj?.coding) {
    for (const c of codeObj.coding) {
      if (c.code) {
        const idType = c.system?.includes("ndc") ? "NDC" : "CODE";
        identifiers.push({ idType, identifier: c.code, issuer: c.system });
      }
    }
  }

  return {
    id,
    country: country.toUpperCase(),
    brandName,
    manufacturer,
    dosageForm: dosageForm || null,
    strength: extractStrength(brandName) || activeIngredients.map(i => i.strength).filter(Boolean).join(" / ") || null,
    route: inferRouteFromForm(dosageForm),
    activeIngredients,
    identifiers,
    metadata: { fhirResourceType: fhir.resourceType },
  };
}

/**
 * Importer for Open Medication Catalogue (OMC).
 * Preserves country, upstream licensing, multiple active ingredients, and specific identifiers.
 * Repeatable and idempotent.
 */
export async function importOmcProducts(
  records: OmcProductRecord[],
  options: { batchLabel?: string; jurisdiction?: string } = {},
): Promise<ImportResultSummary> {
  const startTime = Date.now();
  const source = await getCatalogSource("open-medication-catalog");

  const batchChecksum = computeChecksum(records);

  const importLog = await systemPrisma.drugCatalogImport.create({
    data: {
      sourceId: source.id,
      status: "IN_PROGRESS",
      totalRecords: records.length,
      sourceVersion: source.version,
      checksum: batchChecksum,
      logDetails: {
        batchLabel: options.batchLabel ?? "omc_import",
        jurisdiction: options.jurisdiction ?? "INTL",
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

  const ingredientCache = new Map<string, string>(); // name -> id

  for (const item of records) {
    if (!item.brandName || !item.brandName.trim() || !item.country) {
      invalidRecords++;
      continue;
    }

    const brandName = item.brandName.trim();
    const country = item.country.trim().toUpperCase();
    const dosageForm = item.dosageForm?.trim() || extractDosageForm(brandName) || "Tablet";
    const strength = item.strength?.trim() || extractStrength(brandName);
    const route = item.route?.trim() || inferRouteFromForm(dosageForm);
    const manufacturer = item.manufacturer?.trim() || null;
    const registrationNumber = item.registrationNumber?.trim() || null;

    if (!strength) {
      missingStrengths++;
    }

    const activeIngredients = item.activeIngredients || [];
    if (activeIngredients.length === 0) {
      unmatchedIngredients++;
    }

    const genericName =
      item.genericName?.trim() ||
      (activeIngredients.length > 0
        ? activeIngredients.map((i) => i.name).join(" + ")
        : null);

    const itemChecksum = computeChecksum(item);

    // Look for existing source record
    const existingSourceRecord = await systemPrisma.drugProductSourceRecord.findFirst({
      where: {
        sourceId: source.id,
        sourceExternalId: item.id,
      },
      select: {
        id: true,
        recordChecksum: true,
        productId: true,
      },
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
          strength,
          dosageForm,
          route,
          registrationNumber,
          metadata: item.metadata as Prisma.InputJsonValue,
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

    // Create DrugProduct
    const drugProduct = await systemPrisma.drugProduct.create({
      data: {
        sourceId: source.id,
        country,
        brandName,
        genericName,
        manufacturer,
        strength,
        dosageForm,
        route,
        registrationNumber,
        verificationState: "IMPORTED_UNVERIFIED",
        metadata: (item.metadata || {}) as Prisma.InputJsonValue,
      },
    });

    // Link Ingredients
    for (let i = 0; i < activeIngredients.length; i++) {
      const ing = activeIngredients[i];
      const normalized = normalizeIngredientName(ing.name);
      let ingredientId = ingredientCache.get(normalized);

      if (!ingredientId) {
        const ingredient = await systemPrisma.ingredient.upsert({
          where: { name: normalized },
          update: {},
          create: {
            name: normalized,
            source: "open-medication-catalog",
            verificationState: "IMPORTED_UNVERIFIED",
          },
          select: { id: true },
        });
        ingredientId = ingredient.id;
        ingredientCache.set(normalized, ingredientId);
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
          isPrimary: ing.isPrimary ?? i === 0,
          strength: ing.strength || null,
          strengthNumerator: ing.strengthNumerator !== undefined && ing.strengthNumerator !== null
            ? new Prisma.Decimal(ing.strengthNumerator)
            : null,
          strengthNumeratorUnit: ing.strengthNumeratorUnit || null,
          strengthDenominator: ing.strengthDenominator !== undefined && ing.strengthDenominator !== null
            ? new Prisma.Decimal(ing.strengthDenominator)
            : null,
          strengthDenominatorUnit: ing.strengthDenominatorUnit || null,
        },
      });
    }

    // Add Identifiers
    const identifierCreates: Array<Promise<unknown>> = [];

    const seenIdentKeys = new Set<string>();
    const rawIds = [...(item.identifiers || []), { idType: "OMC_ID", identifier: item.id, issuer: "open-medication-catalog" }];

    for (const ident of rawIds) {
      if (ident.identifier && ident.identifier.trim()) {
        const trimmed = ident.identifier.trim();
        const key = `${ident.idType}:${trimmed}`;
        if (seenIdentKeys.has(key)) continue;
        seenIdentKeys.add(key);

        identifierCreates.push(
          systemPrisma.drugProductIdentifier.upsert({
            where: {
              idType_identifier_productId: {
                idType: ident.idType,
                identifier: trimmed,
                productId: drugProduct.id,
              },
            },
            update: {},
            create: {
              productId: drugProduct.id,
              idType: ident.idType,
              identifier: trimmed,
              isValid: ident.isValid ?? true,
              issuer: ident.issuer || null,
            },
          }),
        );
      }
    }

    // Provenance Source Record
    identifierCreates.push(
      systemPrisma.drugProductSourceRecord.create({
        data: {
          productId: drugProduct.id,
          sourceId: source.id,
          importId: importLog.id,
          sourceExternalId: item.id,
          rawPayload: item as unknown as Prisma.InputJsonValue,
          license: item.upstreamLicense || source.license,
          recordChecksum: itemChecksum,
        },
      }),
    );

    await Promise.all(identifierCreates);

    insertedRecords++;
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
        batchLabel: options.batchLabel ?? "omc_import",
        jurisdiction: options.jurisdiction ?? "INTL",
        durationMs,
        completedAt: new Date().toISOString(),
      },
    },
  });

  return {
    importId: importLog.id,
    source: "open-medication-catalog",
    totalRecords: records.length,
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
