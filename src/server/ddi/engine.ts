import { systemPrisma } from "@/server/db";
import { normalizeIngredientName, splitActiveIngredients } from "@/server/catalog/utils";
import { getTimingRuleForPair } from "./timing";

export interface DrugInput {
  id?: string;
  drugProductId?: string;
  medicationRecordId?: string;
  name?: string;
}

export interface DetectedInteraction {
  id: string;
  ingredientA: {
    id: string;
    name: string;
    nameAr: string | null;
  };
  ingredientB: {
    id: string;
    name: string;
    nameAr: string | null;
  };
  severity: "MAJOR" | "MODERATE" | "MINOR" | "UNKNOWN";
  description: string | null;
  mechanism: string | null;
  management: string | null;
  source: string;
  reference: string | null;
  clinicalApprovalState: "IMPORTED_UNREVIEWED" | "CLINICALLY_APPROVED" | "REJECTED" | "FLAGGED_FOR_REVIEW";
  timingRule?: {
    minIntervalHours: number;
    timingInstructionAr: string | null;
    timingInstructionEn: string;
    clinicalReference: string;
    isApproved: boolean;
  } | null;
  relatedMedications: string[];
}

export interface InteractionEngineReport {
  timestamp: string;
  patientMedicationsCount: number;
  resolvedIngredientsCount: number;
  evaluatedPairsCount: number;
  interactionsCount: number;
  interactionsBySeverity: {
    major: number;
    moderate: number;
    minor: number;
    unknown: number;
  };
  interactions: DetectedInteraction[];
  unmatchedMedications: Array<{
    identifier: string;
    name: string;
    reason: string;
  }>;
  ingredientsWithNoDdiData: string[];
  safetyDisclaimer: string;
}

const MANDATORY_SAFETY_DISCLAIMER =
  "CLINICAL SAFETY NOTICE: The absence of an interaction record in this database does NOT imply proof of clinical safety or absence of adverse drug events. Co-administration decisions must be evaluated by a licensed pharmacist or physician.";

/**
 * Drug-Drug Interaction (DDI) Evaluation Engine.
 * Evaluates a patient's active medication list, resolves active ingredients,
 * evaluates all unique pairwise combinations against local DDI & timing rules,
 * and highlights unmatched items with explicit safety disclaimers.
 */
export async function evaluateMedicationInteractions(
  medications: DrugInput[],
): Promise<InteractionEngineReport> {
  // Step 1: Resolve all medication products to their active ingredients
  const resolvedIngredientsMap = new Map<string, { id: string; name: string; nameAr: string | null }>();
  const ingredientToMedsMap = new Map<string, Set<string>>(); // ingredientId -> Set of medication labels
  const unmatchedMedications: Array<{ identifier: string; name: string; reason: string }> = [];

  for (const med of medications) {
    const medLabel = med.name || med.drugProductId || med.medicationRecordId || "Unknown Medication";
    let foundIngredients = false;

    // 1. By DrugProduct ID
    if (med.drugProductId) {
      const product = await systemPrisma.drugProduct.findUnique({
        where: { id: med.drugProductId },
        include: {
          ingredients: {
            include: { ingredient: true },
          },
        },
      });

      if (product && product.ingredients.length > 0) {
        foundIngredients = true;
        for (const pi of product.ingredients) {
          resolvedIngredientsMap.set(pi.ingredient.id, {
            id: pi.ingredient.id,
            name: pi.ingredient.name,
            nameAr: pi.ingredient.nameAr,
          });
          if (!ingredientToMedsMap.has(pi.ingredient.id)) {
            ingredientToMedsMap.set(pi.ingredient.id, new Set());
          }
          ingredientToMedsMap.get(pi.ingredient.id)!.add(product.brandName);
        }
      }
    }

    // 2. By MedicationRecord ID (patient record)
    if (!foundIngredients && med.medicationRecordId) {
      const rec = await systemPrisma.medicationRecord.findUnique({
        where: { id: med.medicationRecordId },
      });

      if (rec) {
        // Try searching ingredient by name text
        const cleanName = normalizeIngredientName(rec.medicationNameText);
        const ing = await systemPrisma.ingredient.findFirst({
          where: {
            OR: [
              { name: cleanName },
              { synonyms: { has: cleanName } },
            ],
          },
        });

        if (ing) {
          foundIngredients = true;
          resolvedIngredientsMap.set(ing.id, {
            id: ing.id,
            name: ing.name,
            nameAr: ing.nameAr,
          });
          if (!ingredientToMedsMap.has(ing.id)) {
            ingredientToMedsMap.set(ing.id, new Set());
          }
          ingredientToMedsMap.get(ing.id)!.add(rec.medicationNameText);
        }
      }
    }

    // 3. By raw Name / Free-text
    if (!foundIngredients && med.name) {
      const rawText = med.name.trim();

      // Check if text has parenthetical ingredient e.g. "Tivicay 50 mg (dolutegravir)"
      const parenMatch = rawText.match(/\(([^)]+)\)/);
      const candidatesToTry: string[] = [];

      if (parenMatch) {
        candidatesToTry.push(parenMatch[1]);
      }

      // Check if matches an existing DrugProduct brand name
      const matchingProduct = await systemPrisma.drugProduct.findFirst({
        where: {
          OR: [
            { brandName: { contains: rawText, mode: "insensitive" } },
            { genericName: { contains: rawText, mode: "insensitive" } },
          ],
        },
        include: {
          ingredients: {
            include: { ingredient: true },
          },
        },
      });

      if (matchingProduct && matchingProduct.ingredients.length > 0) {
        foundIngredients = true;
        for (const pi of matchingProduct.ingredients) {
          resolvedIngredientsMap.set(pi.ingredient.id, {
            id: pi.ingredient.id,
            name: pi.ingredient.name,
            nameAr: pi.ingredient.nameAr,
          });
          if (!ingredientToMedsMap.has(pi.ingredient.id)) {
            ingredientToMedsMap.set(pi.ingredient.id, new Set());
          }
          ingredientToMedsMap.get(pi.ingredient.id)!.add(med.name);
        }
      }

      // Also split candidate terms by active ingredients joiners
      const terms = [
        ...candidatesToTry,
        ...splitActiveIngredients(rawText),
        rawText,
      ];

      for (const term of terms) {
        const clean = normalizeIngredientName(term);
        if (!clean || clean.length < 3) continue;

        const ing = await systemPrisma.ingredient.findFirst({
          where: {
            OR: [
              { name: { equals: clean, mode: "insensitive" } },
              { name: { contains: clean, mode: "insensitive" } },
              { synonyms: { has: clean } },
            ],
          },
        });

        if (ing) {
          foundIngredients = true;
          resolvedIngredientsMap.set(ing.id, {
            id: ing.id,
            name: ing.name,
            nameAr: ing.nameAr,
          });
          if (!ingredientToMedsMap.has(ing.id)) {
            ingredientToMedsMap.set(ing.id, new Set());
          }
          ingredientToMedsMap.get(ing.id)!.add(med.name);
        }
      }
    }

    if (!foundIngredients) {
      unmatchedMedications.push({
        identifier: med.id || med.drugProductId || med.medicationRecordId || "unidentified",
        name: medLabel,
        reason: "No standardized active ingredients could be resolved for this medication.",
      });
    }
  }

  // Step 2: Generate unique pairwise ingredient combinations
  const ingredientsList = Array.from(resolvedIngredientsMap.values());
  const evaluatedPairs: Array<[typeof ingredientsList[0], typeof ingredientsList[0]]> = [];

  for (let i = 0; i < ingredientsList.length; i++) {
    for (let j = i + 1; j < ingredientsList.length; j++) {
      evaluatedPairs.push([ingredientsList[i], ingredientsList[j]]);
    }
  }

  // Step 3 & 4: Search DDI database for each pair & check timing rules
  const detectedInteractions: DetectedInteraction[] = [];
  const ingredientsWithInteractions = new Set<string>();

  const severityCounts = {
    major: 0,
    moderate: 0,
    minor: 0,
    unknown: 0,
  };

  for (const [ingA, ingB] of evaluatedPairs) {
    const [firstId, secondId] = ingA.id < ingB.id ? [ingA.id, ingB.id] : [ingB.id, ingA.id];

    const interaction = await systemPrisma.ddiInteraction.findFirst({
      where: {
        ingredientAId: firstId,
        ingredientBId: secondId,
      },
    });

    if (interaction) {
      ingredientsWithInteractions.add(ingA.id);
      ingredientsWithInteractions.add(ingB.id);

      switch (interaction.severity) {
        case "MAJOR":
          severityCounts.major++;
          break;
        case "MODERATE":
          severityCounts.moderate++;
          break;
        case "MINOR":
          severityCounts.minor++;
          break;
        default:
          severityCounts.unknown++;
      }

      // Check timing rule
      const timing = await getTimingRuleForPair(firstId, secondId);

      const relatedMeds = Array.from(
        new Set([
          ...(ingredientToMedsMap.get(ingA.id) || []),
          ...(ingredientToMedsMap.get(ingB.id) || []),
        ]),
      );

      detectedInteractions.push({
        id: interaction.id,
        ingredientA: {
          id: ingA.id,
          name: ingA.name,
          nameAr: ingA.nameAr,
        },
        ingredientB: {
          id: ingB.id,
          name: ingB.name,
          nameAr: ingB.nameAr,
        },
        severity: interaction.severity,
        description: interaction.description,
        mechanism: interaction.mechanism,
        management: interaction.management,
        source: interaction.source,
        reference: interaction.reference,
        clinicalApprovalState: interaction.clinicalApprovalState,
        timingRule: timing
          ? {
              minIntervalHours: Number(timing.minIntervalHours),
              timingInstructionAr: timing.timingInstructionAr,
              timingInstructionEn: timing.timingInstructionEn,
              clinicalReference: timing.clinicalReference,
              isApproved: timing.isApproved,
            }
          : null,
        relatedMedications: relatedMeds,
      });
    }
  }

  // Step 6: Identify resolved ingredients with no interactions found
  const ingredientsWithNoDdiData = ingredientsList
    .filter((ing) => !ingredientsWithInteractions.has(ing.id))
    .map((ing) => ing.name);

  return {
    timestamp: new Date().toISOString(),
    patientMedicationsCount: medications.length,
    resolvedIngredientsCount: ingredientsList.length,
    evaluatedPairsCount: evaluatedPairs.length,
    interactionsCount: detectedInteractions.length,
    interactionsBySeverity: severityCounts,
    interactions: detectedInteractions,
    unmatchedMedications,
    ingredientsWithNoDdiData,
    safetyDisclaimer: MANDATORY_SAFETY_DISCLAIMER,
  };
}
