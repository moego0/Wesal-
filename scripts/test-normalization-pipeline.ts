import "dotenv/config";
import { normalizeIngredientsWithRxNorm } from "../src/server/catalog/importers/rxnorm";
import { normalizeIngredientsWithPubChem } from "../src/server/catalog/importers/pubchem";
import { importDailyMedLabels } from "../src/server/catalog/importers/dailymed";
import { importOpenFdaLabels } from "../src/server/catalog/importers/openfda";
import { systemPrisma } from "../src/server/db";

async function main() {
  console.log("=== 1. Testing RxNorm Normalization ===");
  const rxRes = await normalizeIngredientsWithRxNorm({
    targetIngredientNames: ["metformin", "bisoprolol", "paracetamol"],
    batchLabel: "test_rxnorm_pipeline",
  });
  console.log("RxNorm Normalization Result:", rxRes);

  console.log("\n=== 2. Testing PubChem Normalization ===");
  const pubRes = await normalizeIngredientsWithPubChem({
    targetIngredientNames: ["metformin", "paracetamol"],
    batchLabel: "test_pubchem_pipeline",
  });
  console.log("PubChem Normalization Result:", pubRes);

  console.log("\n=== 3. Testing DailyMed Supplementary Labels ===");
  const dmRes = await importDailyMedLabels(["metformin"], {
    batchLabel: "test_dailymed_pipeline",
  });
  console.log("DailyMed Import Result:", dmRes);

  console.log("\n=== 4. Testing openFDA Supplementary Labels ===");
  const fdaRes = await importOpenFdaLabels(["metformin"], {
    batchLabel: "test_openfda_pipeline",
  });
  console.log("openFDA Import Result:", fdaRes);

  console.log("\n=== 5. Verifying Normalized Ingredients in DB ===");
  const ingredients = await systemPrisma.ingredient.findMany({
    where: {
      name: { in: ["metformin", "paracetamol", "bisoprolol"] },
    },
  });

  for (const ing of ingredients) {
    console.log(`- Ingredient: ${ing.name}`);
    console.log(`  RxCUI: ${ing.rxcui || "none"}, PubChem CID: ${ing.pubchemCid || "none"}, InChIKey: ${ing.inchiKey || "none"}`);
    console.log(`  Synonyms count: ${ing.synonyms?.length || 0}`);
    console.log(`  Verification state: ${ing.verificationState}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
