import "dotenv/config";
import { describe, expect, it } from "vitest";
import {
  computeChecksum,
  extractDosageForm,
  extractStrength,
  inferRouteFromForm,
  normalizeIngredientName,
  splitActiveIngredients,
} from "@/server/catalog/utils";
import { parseFhirMedication } from "@/server/catalog/importers/omc";

describe("Medication Catalog Utilities", () => {
  it("normalizes ingredient names consistently", () => {
    expect(normalizeIngredientName("  PARACETAMOL  ")).toBe("paracetamol");
    expect(normalizeIngredientName("Metformin Hydrochloride (USP)")).toBe("metformin hydrochloride usp");
    expect(normalizeIngredientName("pseudoephedrine-HCl")).toBe("pseudoephedrine-hcl");
  });

  it("splits active ingredients across multiple delimiters", () => {
    // Egyptian eg-drugs '+' format
    expect(
      splitActiveIngredients("chlorpheniramine+paracetamol+pseudoephedrine"),
    ).toEqual(["chlorpheniramine", "paracetamol", "pseudoephedrine"]);

    // Slash format
    expect(splitActiveIngredients("amoxicillin / clavulanic acid")).toEqual([
      "amoxicillin",
      "clavulanic acid",
    ]);

    // 'and' / '&' format
    expect(
      splitActiveIngredients("sitagliptin and metformin hydrochloride"),
    ).toEqual(["sitagliptin", "metformin hydrochloride"]);

    // Deduplicates redundant items
    expect(splitActiveIngredients("paracetamol + paracetamol")).toEqual([
      "paracetamol",
    ]);

    // Returns empty array for null/empty
    expect(splitActiveIngredients(null)).toEqual([]);
    expect(splitActiveIngredients("")).toEqual([]);
  });

  it("extracts recognized dosage forms", () => {
    expect(extractDosageForm("Panadol Extra 24 Film-coated Tablets")).toBe("Tablet");
    expect(extractDosageForm("1 2 3 Syrup 120 ml")).toBe("Syrup");
    expect(extractDosageForm("Augmentin Oral Suspension 457mg")).toBe("Suspension");
    expect(extractDosageForm("Ceftriaxone 1g Injection Vial")).toBe("Injection");
    expect(extractDosageForm("Voltaren Emulgel 1% Topical Gel")).toBe("Gel");
    expect(extractDosageForm("Otrivin 0.1% Nasal Spray")).toBe("Spray");
    expect(extractDosageForm("Ventolin Inhaler 100mcg")).toBe("Inhaler");
  });

  it("infers route of administration from dosage form", () => {
    expect(inferRouteFromForm("Tablet")).toBe("Oral");
    expect(inferRouteFromForm("Syrup")).toBe("Oral");
    expect(inferRouteFromForm("Injection")).toBe("Parenteral (IV/IM/SC)");
    expect(inferRouteFromForm("Cream")).toBe("Topical");
    expect(inferRouteFromForm("Spray")).toBe("Nasal / Oral");
    expect(inferRouteFromForm("Inhaler")).toBe("Inhalation");
    expect(inferRouteFromForm("Suppository")).toBe("Rectal / Vaginal");
  });

  it("extracts strengths from brand title", () => {
    expect(extractStrength("Concor 5 mg 30 tab")).toBe("5 mg");
    expect(extractStrength("Panadol Extra 500 mg / 65 mg Tablets")).toBe("500 mg / 65 mg");
    expect(extractStrength("1 2 3 Syrup 120 ml")).toBe("120 ml");
    expect(extractStrength("Lipitor 20mg Film-coated Tablet")).toBe("20mg");
    expect(extractStrength("Drug Without Strength Tab")).toBeNull();
  });

  it("computes deterministic checksum for idempotency", () => {
    const a = { name: "Drug A", strength: "500 mg" };
    const b = { name: "Drug A", strength: "500 mg" };
    const c = { name: "Drug A", strength: "1000 mg" };

    expect(computeChecksum(a)).toBe(computeChecksum(b));
    expect(computeChecksum(a)).not.toBe(computeChecksum(c));
  });

  it("parses FHIR R4 Medication resource accurately", () => {
    const fhirResource = {
      resourceType: "Medication",
      id: "omc-ch-47500",
      code: {
        text: "Dafalgan 500 mg Comprimés",
        coding: [{ system: "http://swissmedic.ch/id", code: "47500" }],
      },
      form: { text: "Tablet" },
      manufacturer: { display: "UPSA Switzerland" },
      ingredient: [
        {
          itemCodeableConcept: { text: "Paracetamol" },
          strength: { numerator: { value: 500, unit: "mg" } },
        },
      ],
    };

    const parsed = parseFhirMedication(fhirResource, "CH");
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe("omc-ch-47500");
    expect(parsed?.country).toBe("CH");
    expect(parsed?.brandName).toBe("Dafalgan 500 mg Comprimés");
    expect(parsed?.manufacturer).toBe("UPSA Switzerland");
    expect(parsed?.dosageForm).toBe("Tablet");
    expect(parsed?.activeIngredients).toHaveLength(1);
    expect(parsed?.activeIngredients?.[0].name).toBe("paracetamol");
    expect(parsed?.activeIngredients?.[0].strength).toBe("500 mg");
    expect(parsed?.identifiers).toContainEqual(
      expect.objectContaining({ idType: "OMC_ID", identifier: "omc-ch-47500" }),
    );
  });
});
