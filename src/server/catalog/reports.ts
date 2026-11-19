import { systemPrisma } from "@/server/db";

export interface SourceCoverageReport {
  generatedAt: string;
  worldwideCoverageStatement: string;
  sources: Array<{
    name: string;
    displayName: string;
    license: string;
    licenseUrl: string | null;
    attribution: string;
    jurisdiction: string | null;
    version: string | null;
    productCount: number;
    importCount: number;
  }>;
  countries: Array<{
    country: string;
    productCount: number;
  }>;
  ingredients: {
    total: number;
    withRxNormCui: number;
    withPubChemCid: number;
    crossSourceMatched: number;
    importedUnverified: number;
    manuallyVerified: number;
  };
  products: {
    total: number;
    importedUnverified: number;
    crossSourceMatched: number;
    manuallyVerified: number;
  };
}

export interface CatalogImportReport {
  generatedAt: string;
  totalImports: number;
  imports: Array<{
    id: string;
    sourceName: string;
    importedAt: Date;
    status: string;
    totalRecords: number;
    insertedRecords: number;
    updatedRecords: number;
    duplicateRecords: number;
    invalidRecords: number;
    unmatchedIngredients: number;
    missingStrengths: number;
    checksum: string | null;
  }>;
}

export interface DdiCoverageReport {
  generatedAt: string;
  licenseCompliance: string;
  safetyDisclaimer: string;
  totalInteractions: number;
  interactionsBySeverity: {
    major: number;
    moderate: number;
    minor: number;
    unknown: number;
  };
  interactionsByApprovalState: {
    importedUnreviewed: number;
    clinicallyApproved: number;
    rejected: number;
    flaggedForReview: number;
  };
  timingRulesCount: number;
  unmatchedRecordsCount: number;
}

/**
 * Generate comprehensive source coverage report.
 */
export async function generateSourceCoverageReport(): Promise<SourceCoverageReport> {
  const sources = await systemPrisma.drugCatalogSource.findMany({
    include: {
      _count: {
        select: { products: true, imports: true },
      },
    },
    orderBy: { name: "asc" },
  });

  const countryCounts = await systemPrisma.drugProduct.groupBy({
    by: ["country"],
    _count: { id: true },
    orderBy: { country: "asc" },
  });

  const [totalIng, rxnormIng, pubchemIng, matchedIng, unverifiedIng, manualIng] = await Promise.all([
    systemPrisma.ingredient.count(),
    systemPrisma.ingredient.count({ where: { rxcui: { not: null } } }),
    systemPrisma.ingredient.count({ where: { pubchemCid: { not: null } } }),
    systemPrisma.ingredient.count({ where: { verificationState: "CROSS_SOURCE_MATCHED" } }),
    systemPrisma.ingredient.count({ where: { verificationState: "IMPORTED_UNVERIFIED" } }),
    systemPrisma.ingredient.count({ where: { verificationState: "MANUALLY_VERIFIED" } }),
  ]);

  const [totalProd, prodUnverified, prodMatched, prodManual] = await Promise.all([
    systemPrisma.drugProduct.count(),
    systemPrisma.drugProduct.count({ where: { verificationState: "IMPORTED_UNVERIFIED" } }),
    systemPrisma.drugProduct.count({ where: { verificationState: "CROSS_SOURCE_MATCHED" } }),
    systemPrisma.drugProduct.count({ where: { verificationState: "MANUALLY_VERIFIED" } }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    worldwideCoverageStatement:
      "DISCLAIMER ON COVERAGE: This catalog contains verified datasets from approved national regulatory and research sources only (Egypt, US, Poland, France, Switzerland). It does NOT provide or claim complete worldwide coverage. No country coverage or product records are synthetically invented.",
    sources: sources.map((s) => ({
      name: s.name,
      displayName: s.displayName,
      license: s.license,
      licenseUrl: s.licenseUrl,
      attribution: s.attribution,
      jurisdiction: s.jurisdiction,
      version: s.version,
      productCount: s._count.products,
      importCount: s._count.imports,
    })),
    countries: countryCounts.map((c) => ({
      country: c.country,
      productCount: c._count.id,
    })),
    ingredients: {
      total: totalIng,
      withRxNormCui: rxnormIng,
      withPubChemCid: pubchemIng,
      crossSourceMatched: matchedIng,
      importedUnverified: unverifiedIng,
      manuallyVerified: manualIng,
    },
    products: {
      total: totalProd,
      importedUnverified: prodUnverified,
      crossSourceMatched: prodMatched,
      manuallyVerified: prodManual,
    },
  };
}

/**
 * Generate catalog import report.
 */
export async function generateCatalogImportReport(): Promise<CatalogImportReport> {
  const imports = await systemPrisma.drugCatalogImport.findMany({
    include: {
      source: { select: { name: true } },
    },
    orderBy: { importedAt: "desc" },
    take: 50,
  });

  return {
    generatedAt: new Date().toISOString(),
    totalImports: imports.length,
    imports: imports.map((i) => ({
      id: i.id,
      sourceName: i.source.name,
      importedAt: i.importedAt,
      status: i.status,
      totalRecords: i.totalRecords,
      insertedRecords: i.insertedRecords,
      updatedRecords: i.updatedRecords,
      duplicateRecords: i.duplicateRecords,
      invalidRecords: i.invalidRecords,
      unmatchedIngredients: i.unmatchedIngredients,
      missingStrengths: i.missingStrengths,
      checksum: i.checksum,
    })),
  };
}

/**
 * Generate DDI coverage report.
 */
export async function generateDdiCoverageReport(): Promise<DdiCoverageReport> {
  const [
    totalInteractions,
    majorCount,
    moderateCount,
    minorCount,
    unknownCount,
    unreviewedCount,
    approvedCount,
    rejectedCount,
    flaggedCount,
    timingRulesCount,
    unmatchedCount,
  ] = await Promise.all([
    systemPrisma.ddiInteraction.count(),
    systemPrisma.ddiInteraction.count({ where: { severity: "MAJOR" } }),
    systemPrisma.ddiInteraction.count({ where: { severity: "MODERATE" } }),
    systemPrisma.ddiInteraction.count({ where: { severity: "MINOR" } }),
    systemPrisma.ddiInteraction.count({ where: { severity: "UNKNOWN" } }),
    systemPrisma.ddiInteraction.count({ where: { clinicalApprovalState: "IMPORTED_UNREVIEWED" } }),
    systemPrisma.ddiInteraction.count({ where: { clinicalApprovalState: "CLINICALLY_APPROVED" } }),
    systemPrisma.ddiInteraction.count({ where: { clinicalApprovalState: "REJECTED" } }),
    systemPrisma.ddiInteraction.count({ where: { clinicalApprovalState: "FLAGGED_FOR_REVIEW" } }),
    systemPrisma.ddiTimingRule.count(),
    systemPrisma.ddiUnmatchedRecord.count(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    licenseCompliance: "DDInter 2.0 dataset licensed under CC BY-NC-SA 4.0. Preserves original identifiers, descriptions, and non-commercial attribution.",
    safetyDisclaimer: "Absence of interaction records does not prove clinical safety. Review by healthcare professional required.",
    totalInteractions,
    interactionsBySeverity: {
      major: majorCount,
      moderate: moderateCount,
      minor: minorCount,
      unknown: unknownCount,
    },
    interactionsByApprovalState: {
      importedUnreviewed: unreviewedCount,
      clinicallyApproved: approvedCount,
      rejected: rejectedCount,
      flaggedForReview: flaggedCount,
    },
    timingRulesCount,
    unmatchedRecordsCount: unmatchedCount,
  };
}
