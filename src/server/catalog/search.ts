import { systemPrisma } from "@/server/db";
import { Prisma } from "@/generated/prisma/client";

export interface DrugSearchFilters {
  q?: string;
  country?: string;
  dosageForm?: string;
  strength?: string;
  verificationState?: string;
  limit?: number;
  offset?: number;
}

export interface DrugSearchResult {
  id: string;
  country: string;
  brandName: string;
  brandNameAr: string | null;
  genericName: string | null;
  manufacturer: string | null;
  strength: string | null;
  dosageForm: string | null;
  route: string | null;
  registrationNumber: string | null;
  verificationState: string;
  price: string | null;
  currency: string | null;
  units: string | null;
  category: string | null;
  indications: string | null;
  source: {
    id: string;
    name: string;
    displayName: string;
    license: string;
    attribution: string;
  };
  ingredients: Array<{
    id: string;
    name: string;
    nameAr: string | null;
    strength: string | null;
    rxcui: string | null;
    pubchemCid: string | null;
    isPrimary: boolean;
  }>;
  identifiers: Array<{
    idType: string;
    identifier: string;
    isValid: boolean;
    issuer: string | null;
  }>;
}

/**
 * Multi-criteria search for drug products across Egypt and international catalogs.
 * Supports brand name, generic name, active ingredient, Arabic & English names, country, strength, and dosage form.
 */
export async function searchDrugProducts(filters: DrugSearchFilters): Promise<{
  total: number;
  limit: number;
  offset: number;
  items: DrugSearchResult[];
}> {
  const limit = Math.min(Math.max(Number(filters.limit) || 20, 1), 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const andConditions: Prisma.DrugProductWhereInput[] = [];

  // Query across brand name, generic name, Arabic name, or active ingredients
  if (filters.q && filters.q.trim()) {
    const term = filters.q.trim();
    andConditions.push({
      OR: [
        { brandName: { contains: term, mode: "insensitive" } },
        { brandNameAr: { contains: term, mode: "insensitive" } },
        { genericName: { contains: term, mode: "insensitive" } },
        {
          ingredients: {
            some: {
              ingredient: {
                OR: [
                  { name: { contains: term, mode: "insensitive" } },
                  { nameAr: { contains: term, mode: "insensitive" } },
                  { synonyms: { has: term.toLowerCase() } },
                ],
              },
            },
          },
        },
      ],
    });
  }

  // Country filter
  if (filters.country && filters.country.trim()) {
    andConditions.push({
      country: { equals: filters.country.trim().toUpperCase() },
    });
  }

  // Dosage Form filter
  if (filters.dosageForm && filters.dosageForm.trim()) {
    andConditions.push({
      dosageForm: { contains: filters.dosageForm.trim(), mode: "insensitive" },
    });
  }

  // Strength filter
  if (filters.strength && filters.strength.trim()) {
    andConditions.push({
      strength: { contains: filters.strength.trim(), mode: "insensitive" },
    });
  }

  // Verification state filter
  if (filters.verificationState && filters.verificationState.trim()) {
    andConditions.push({
      verificationState: { equals: filters.verificationState.trim() as any },
    });
  }

  const where: Prisma.DrugProductWhereInput =
    andConditions.length > 0 ? { AND: andConditions } : {};

  const [total, records] = await Promise.all([
    systemPrisma.drugProduct.count({ where }),
    systemPrisma.drugProduct.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: [{ country: "asc" }, { brandName: "asc" }],
      include: {
        source: {
          select: {
            id: true,
            name: true,
            displayName: true,
            license: true,
            attribution: true,
          },
        },
        ingredients: {
          include: {
            ingredient: {
              select: {
                id: true,
                name: true,
                nameAr: true,
                rxcui: true,
                pubchemCid: true,
              },
            },
          },
          orderBy: { orderIndex: "asc" },
        },
        identifiers: {
          select: {
            idType: true,
            identifier: true,
            isValid: true,
            issuer: true,
          },
        },
      },
    }),
  ]);

  const items: DrugSearchResult[] = records.map((p) => ({
    id: p.id,
    country: p.country,
    brandName: p.brandName,
    brandNameAr: p.brandNameAr,
    genericName: p.genericName,
    manufacturer: p.manufacturer,
    strength: p.strength,
    dosageForm: p.dosageForm,
    route: p.route,
    registrationNumber: p.registrationNumber,
    verificationState: p.verificationState,
    price: p.price ? p.price.toString() : null,
    currency: p.currency,
    units: p.units,
    category: p.category,
    indications: p.indications,
    source: p.source,
    ingredients: p.ingredients.map((pi) => ({
      id: pi.ingredient.id,
      name: pi.ingredient.name,
      nameAr: pi.ingredient.nameAr,
      strength: pi.strength,
      rxcui: pi.ingredient.rxcui,
      pubchemCid: pi.ingredient.pubchemCid,
      isPrimary: pi.isPrimary,
    })),
    identifiers: p.identifiers,
  }));

  return {
    total,
    limit,
    offset,
    items,
  };
}

/**
 * Retrieve single drug product by ID with full provenance and source records.
 */
export async function getDrugProductById(id: string) {
  const drug = await systemPrisma.drugProduct.findUnique({
    where: { id },
    include: {
      source: true,
      ingredients: {
        include: { ingredient: true },
        orderBy: { orderIndex: "asc" },
      },
      identifiers: true,
      sourceRecords: {
        select: {
          id: true,
          sourceExternalId: true,
          license: true,
          retrievedAt: true,
          recordChecksum: true,
          source: { select: { name: true, displayName: true } },
        },
      },
    },
  });

  return drug;
}

/**
 * Search standardized active ingredients.
 */
export async function searchIngredients(q?: string, limit = 20) {
  const clean = q ? q.trim() : "";
  const max = Math.min(Math.max(limit, 1), 100);

  const where: Prisma.IngredientWhereInput = clean
    ? {
        OR: [
          { name: { contains: clean, mode: "insensitive" } },
          { nameAr: { contains: clean, mode: "insensitive" } },
          { synonyms: { has: clean.toLowerCase() } },
          { rxcui: { equals: clean } },
          { pubchemCid: { equals: clean } },
        ],
      }
    : {};

  const ingredients = await systemPrisma.ingredient.findMany({
    where,
    take: max,
    orderBy: { name: "asc" },
    include: {
      _count: {
        select: { productIngredients: true },
      },
    },
  });

  return ingredients.map((i) => ({
    id: i.id,
    name: i.name,
    nameAr: i.nameAr,
    synonyms: i.synonyms,
    rxcui: i.rxcui,
    pubchemCid: i.pubchemCid,
    inchiKey: i.inchiKey,
    atcCode: i.atcCode,
    verificationState: i.verificationState,
    source: i.source,
    productCount: i._count.productIngredients,
  }));
}

/**
 * Get distinct catalog countries with product counts.
 */
export async function getCatalogCountries() {
  const counts = await systemPrisma.drugProduct.groupBy({
    by: ["country"],
    _count: { id: true },
    orderBy: { country: "asc" },
  });

  return counts.map((c) => ({
    country: c.country,
    count: c._count.id,
  }));
}

/**
 * Get approved catalog sources with record counts and licensing.
 */
export async function getCatalogSources() {
  const sources = await systemPrisma.drugCatalogSource.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: {
        select: {
          products: true,
          imports: true,
          sourceRecords: true,
        },
      },
    },
  });

  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    displayName: s.displayName,
    sourceUrl: s.sourceUrl,
    license: s.license,
    licenseUrl: s.licenseUrl,
    attribution: s.attribution,
    jurisdiction: s.jurisdiction,
    version: s.version,
    description: s.description,
    isActive: s.isActive,
    productCount: s._count.products,
    importCount: s._count.imports,
    recordCount: s._count.sourceRecords,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}
