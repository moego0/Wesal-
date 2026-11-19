import "dotenv/config";
import { importOmcProducts, parseFhirMedication, type OmcProductRecord } from "../src/server/catalog/importers/omc";
import { systemPrisma } from "../src/server/db";

const internationalSample: OmcProductRecord[] = [
  {
    id: "omc-us-lipitor-20",
    country: "US",
    brandName: "Lipitor 20 mg",
    genericName: "atorvastatin calcium",
    manufacturer: "Pfizer Laboratories Div Pfizer Inc",
    strength: "20 mg",
    dosageForm: "Tablet",
    route: "Oral",
    registrationNumber: "NDA020702",
    activeIngredients: [
      {
        name: "atorvastatin",
        strength: "20 mg",
        strengthNumerator: 20,
        strengthNumeratorUnit: "mg",
        isPrimary: true,
      },
    ],
    identifiers: [
      { idType: "NDC", identifier: "0069-3150-83", issuer: "FDA" },
    ],
    upstreamLicense: "Public Domain / US FDA",
  },
  {
    id: "omc-us-janumet-50-1000",
    country: "US",
    brandName: "Janumet 50 mg / 1000 mg",
    genericName: "sitagliptin + metformin hydrochloride",
    manufacturer: "Merck Sharp & Dohme Corp",
    strength: "50 mg / 1000 mg",
    dosageForm: "Tablet",
    route: "Oral",
    registrationNumber: "NDA022044",
    activeIngredients: [
      {
        name: "sitagliptin",
        strength: "50 mg",
        strengthNumerator: 50,
        strengthNumeratorUnit: "mg",
        isPrimary: true,
      },
      {
        name: "metformin",
        strength: "1000 mg",
        strengthNumerator: 1000,
        strengthNumeratorUnit: "mg",
        isPrimary: false,
      },
    ],
    identifiers: [
      { idType: "NDC", identifier: "0006-0577-61", issuer: "FDA" },
    ],
    upstreamLicense: "Public Domain / US FDA",
  },
  {
    id: "omc-pl-apap-500",
    country: "PL",
    brandName: "APAP 500 mg",
    genericName: "paracetamol",
    manufacturer: "US Pharmacia Sp. z o.o.",
    strength: "500 mg",
    dosageForm: "Tablet",
    route: "Oral",
    registrationNumber: "R/0123",
    activeIngredients: [
      {
        name: "paracetamol",
        strength: "500 mg",
        strengthNumerator: 500,
        strengthNumeratorUnit: "mg",
      },
    ],
    identifiers: [
      { idType: "URPL", identifier: "PL-0123-APAP", issuer: "URPL" },
      { idType: "GTIN", identifier: "5909990001234", issuer: "GS1 Poland" },
    ],
    upstreamLicense: "Open Public Data / URPL Poland",
  },
  {
    id: "omc-fr-doliprane-1000",
    country: "FR",
    brandName: "Doliprane 1000 mg",
    genericName: "paracetamol",
    manufacturer: "Sanofi-Aventis France",
    strength: "1000 mg",
    dosageForm: "Tablet",
    route: "Oral",
    registrationNumber: "CIS-60234125",
    activeIngredients: [
      {
        name: "paracetamol",
        strength: "1000 mg",
        strengthNumerator: 1000,
        strengthNumeratorUnit: "mg",
      },
    ],
    identifiers: [
      { idType: "CIS", identifier: "60234125", issuer: "ANSM France" },
    ],
    upstreamLicense: "Licence Ouverte / Open Licence 2.0 (ANSM)",
  },
];

async function main() {
  console.log("Testing OMC FHIR parser helper...");
  const mockFhir = {
    resourceType: "Medication",
    id: "omc-ch-dafalgan-500",
    code: {
      text: "Dafalgan 500 mg Comprimés",
      coding: [{ system: "http://swissmedic.ch/id", code: "47500" }],
    },
    form: { text: "Comprimé" },
    manufacturer: { display: "UPSA Switzerland AG" },
    ingredient: [
      {
        itemCodeableConcept: { text: "Paracetamol" },
        strength: { numerator: { value: 500, unit: "mg" } },
      },
    ],
  };

  const parsedSwiss = parseFhirMedication(mockFhir, "CH");
  if (parsedSwiss) {
    internationalSample.push(parsedSwiss);
    console.log("Parsed Swiss FHIR item:", parsedSwiss.brandName, parsedSwiss.country);
  }

  console.log("Importing OMC products...");
  const res1 = await importOmcProducts(internationalSample, { batchLabel: "omc_sample_run_1" });
  console.log("Run 1 Result:", res1);

  console.log("Testing idempotency with Run 2...");
  const res2 = await importOmcProducts(internationalSample, { batchLabel: "omc_sample_run_2" });
  console.log("Run 2 Result:", res2);

  // Verify stored products across countries
  const countries = await systemPrisma.drugProduct.groupBy({
    by: ["country"],
    _count: { id: true },
  });
  console.log("\nCatalog products count by country:", countries);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
