import "dotenv/config";
import { describe, expect, it } from "vitest";
import { evaluateMedicationInteractions } from "@/server/ddi/engine";

describe("Drug-Drug Interaction (DDI) Engine", { timeout: 20000 }, () => {
  it("evaluates known interaction pairs and includes severity, mechanism, and management", async () => {
    // Tests dolutegravir + aluminum hydroxide which was imported into test database
    const result = await evaluateMedicationInteractions([
      { name: "Tivicay 50 mg (dolutegravir)" },
      { name: "Maalox (aluminum hydroxide)" },
    ]);

    expect(result.patientMedicationsCount).toBe(2);
    expect(result.resolvedIngredientsCount).toBeGreaterThanOrEqual(2);
    expect(result.evaluatedPairsCount).toBeGreaterThanOrEqual(1);
    expect(result.interactionsCount).toBeGreaterThanOrEqual(1);

    const match = result.interactions.find(
      (i) =>
        (i.ingredientA.name === "dolutegravir" && i.ingredientB.name === "aluminum hydroxide") ||
        (i.ingredientA.name === "aluminum hydroxide" && i.ingredientB.name === "dolutegravir"),
    );

    expect(match).toBeDefined();
    expect(match?.severity).toBe("MAJOR");
    expect(match?.mechanism).toContain("Chelation");
    expect(match?.management).toContain("Administer dolutegravir at least 2 hours before");
    expect(match?.source).toBe("DDInter 2.0");

    // Smart timing rule verification
    expect(match?.timingRule).toBeDefined();
    expect(match?.timingRule?.minIntervalHours).toBe(2);
    expect(match?.timingRule?.isApproved).toBe(true);
    expect(match?.timingRule?.clinicalReference).toContain("FDA Tivicay Prescribing Information");
  });

  it("flags unknown or unresolvable medications explicitly for review", async () => {
    const result = await evaluateMedicationInteractions([
      { name: "UnknownSyntheticSubstance999" },
    ]);

    expect(result.unmatchedMedications).toHaveLength(1);
    expect(result.unmatchedMedications[0].name).toBe("UnknownSyntheticSubstance999");
    expect(result.unmatchedMedications[0].reason).toContain("No standardized active ingredients");
  });

  it("never interprets missing interaction records as proof of safety", async () => {
    // Two benign or unrecorded ingredients
    const result = await evaluateMedicationInteractions([
      { name: "Vitamin C" },
      { name: "Paracetamol" },
    ]);

    // Mandatory disclaimer must ALWAYS be present
    expect(result.safetyDisclaimer).toContain("The absence of an interaction record in this database does NOT imply proof of clinical safety");
    expect(result.safetyDisclaimer).toContain("pharmacist or physician");
  });
});
