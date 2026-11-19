import { systemPrisma } from "@/server/db";

export interface CatalogSourceConfig {
  name: string;
  displayName: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string | null;
  attribution: string;
  jurisdiction: string | null;
  version: string | null;
  description: string | null;
}

export const APPROVED_CATALOG_SOURCES: Record<string, CatalogSourceConfig> = {
  "eg-drugs": {
    name: "eg-drugs",
    displayName: "Egyptian Medication Catalog (eg-drugs)",
    sourceUrl: "https://github.com/mahmoudfalous/eg-drugs",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    attribution: "Mahmoud Falous (mahmoudfalous/eg-drugs). Derived from Egyptian Drug Authority (EDA) records and local market catalogs.",
    jurisdiction: "EG",
    version: "2024.1",
    description: "Egyptian registered and commercial pharmaceutical products with Arabic & English names, active ingredients, pricing, packaging units, and barcodes.",
  },
  "open-medication-catalog": {
    name: "open-medication-catalog",
    displayName: "Open Medication Catalogue",
    sourceUrl: "https://github.com/open-medication/open-medication-catalog",
    license: "Apache-2.0 (Generator) / Upstream Regulatory Licenses (Content)",
    licenseUrl: "https://github.com/open-medication/open-medication-catalog/blob/main/LICENSE",
    attribution: "Open Medication Catalog Project (open-medication/open-medication-catalog) & National Regulatory Authorities (FDA, URPL, ANSM, Swissmedic).",
    jurisdiction: "INTL",
    version: "2026.11",
    description: "Standardized multi-national medicinal product releases derived from authoritative open regulatory agencies (US, PL, FR, CH).",
  },
  rxnorm: {
    name: "rxnorm",
    displayName: "RxNorm (U.S. National Library of Medicine)",
    sourceUrl: "https://www.nlm.nih.gov/research/umls/rxnorm/",
    license: "Public Domain / US Government Work (NLM UMLS Terms)",
    licenseUrl: "https://www.nlm.nih.gov/research/umls/rxnorm/overview.html",
    attribution: "U.S. National Library of Medicine (NLM), National Institutes of Health. Standard clinical drug vocabulary.",
    jurisdiction: "US",
    version: "2026-current",
    description: "Standardized nomenclature for clinical drugs and active pharmaceutical ingredients; provides normalized RxCUI identifiers and ingredient crosswalks.",
  },
  pubchem: {
    name: "pubchem",
    displayName: "PubChem Compound & Substance Database",
    sourceUrl: "https://pubchem.ncbi.nlm.nih.gov/",
    license: "CC0 1.0 Universal / Public Domain",
    licenseUrl: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
    attribution: "National Center for Biotechnology Information (NCBI), U.S. National Library of Medicine.",
    jurisdiction: "US",
    version: "2026-current",
    description: "Open chemical database providing molecular identifiers (CID, InChIKey), chemical synonyms, and IUPAC nomenclature.",
  },
  dailymed: {
    name: "dailymed",
    displayName: "DailyMed (NLM & FDA Structured Product Labels)",
    sourceUrl: "https://dailymed.nlm.nih.gov/",
    license: "Public Domain / US Government Work",
    licenseUrl: "https://dailymed.nlm.nih.gov/dailymed/about.cfm",
    attribution: "National Library of Medicine and U.S. Food and Drug Administration Structured Product Labeling (SPL) repository.",
    jurisdiction: "US",
    version: "v2-API",
    description: "Official published US package inserts and FDA-approved medication labeling information.",
  },
  openfda: {
    name: "openfda",
    displayName: "openFDA Drug Product & Labeling API",
    sourceUrl: "https://open.fda.gov/apis/drug/",
    license: "CC0 1.0 Universal / Public Domain (openFDA Terms of Service)",
    licenseUrl: "https://open.fda.gov/terms/",
    attribution: "U.S. Food and Drug Administration (FDA) openFDA API. OpenFDA is not endorsed by or affiliated with FDA.",
    jurisdiction: "US",
    version: "v2-API",
    description: "Structured public health and regulatory data on FDA-approved drug labels, NDC numbers, dosage forms, routes, and marketing status.",
  },
  "ddinter": {
    name: "ddinter",
    displayName: "DDInter 2.0 Drug-Drug Interaction Database",
    sourceUrl: "http://ddinter.scbdd.com/",
    license: "CC BY-NC-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
    attribution: "DDInter 2.0: Academic Research Group, Xiangya School of Pharmaceutical Sciences / Zhejiang University of Technology (Xiong et al., Nucleic Acids Res. 2022).",
    jurisdiction: "INTL",
    version: "2.0",
    description: "Curated academic interaction dataset providing severity categorizations, mechanism descriptions, and management guidance.",
  },
};

/**
 * Ensures all approved catalog sources are seeded in the database.
 * Idempotent: Updates metadata if source exists, creates if not.
 */
export async function ensureCatalogSources() {
  const seeded = [];
  for (const config of Object.values(APPROVED_CATALOG_SOURCES)) {
    const record = await systemPrisma.drugCatalogSource.upsert({
      where: { name: config.name },
      update: {
        displayName: config.displayName,
        sourceUrl: config.sourceUrl,
        license: config.license,
        licenseUrl: config.licenseUrl,
        attribution: config.attribution,
        jurisdiction: config.jurisdiction,
        version: config.version,
        description: config.description,
        isActive: true,
      },
      create: {
        name: config.name,
        displayName: config.displayName,
        sourceUrl: config.sourceUrl,
        license: config.license,
        licenseUrl: config.licenseUrl,
        attribution: config.attribution,
        jurisdiction: config.jurisdiction,
        version: config.version,
        description: config.description,
        isActive: true,
      },
    });
    seeded.push(record);
  }
  return seeded;
}

/**
 * Get an approved catalog source by name, seeding it if necessary.
 */
export async function getCatalogSource(name: string) {
  let source = await systemPrisma.drugCatalogSource.findUnique({
    where: { name },
  });
  if (!source) {
    await ensureCatalogSources();
    source = await systemPrisma.drugCatalogSource.findUnique({
      where: { name },
    });
  }
  if (!source) {
    throw new Error(`Approved catalog source '${name}' is not recognized.`);
  }
  return source;
}
