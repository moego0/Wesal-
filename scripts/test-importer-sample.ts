import "dotenv/config";
import { importEgDrugs } from "../src/server/catalog/importers/eg-drugs";
import { systemPrisma } from "../src/server/db";

const sample = [
  {
    id: 1,
    name: "1 2 3 (one two three) syrup 120 ml",
    arabic: "ون تو ثري شراب 120 مل",
    active: "chlorpheniramine+paracetamol+pseudoephedrine",
    company: "hikma pharma",
    price: "40",
    oldprice: "32",
    barcode: "6221000003295",
    slug: "1-2-3--one-two-three--syrup-120-ml",
    units: "1",
    description: "cold products",
    uses: "تخفيف أعراض نزلات البرد والإنفلونزا",
    barcode_valid: "1",
  },
  {
    id: 2,
    name: "panadol extra 24 tab",
    arabic: "بنادول اكسترا 24 قرص",
    active: "paracetamol+caffeine",
    company: "glaxosmithkline",
    price: "52",
    barcode: "6223000001234",
    slug: "panadol-extra-24-tab",
    units: "24",
    description: "analgesics",
    uses: "تسكين الآلام وخفض الحرارة",
    barcode_valid: "1",
  },
  {
    id: 3,
    name: "concor 5 mg 30 tab",
    arabic: "كونكور 5 مجم 30 قرص",
    active: "bisoprolol",
    company: "merck",
    price: "63",
    barcode: "6224000005678",
    slug: "concor-5-mg-30-tab",
    units: "30",
    description: "cardiovascular",
    uses: "علاج ارتفاع ضغط الدم",
    barcode_valid: "1",
  },
];

async function main() {
  console.log("Running eg-drugs sample import...");
  const res1 = await importEgDrugs(sample, { batchLabel: "sample_run_1" });
  console.log("Run 1 Result:", res1);

  console.log("Running second import to test idempotency...");
  const res2 = await importEgDrugs(sample, { batchLabel: "sample_run_2_idempotency" });
  console.log("Run 2 Result:", res2);

  // Inspect what was saved in the DB
  const products = await systemPrisma.drugProduct.findMany({
    include: {
      ingredients: {
        include: { ingredient: true },
      },
      identifiers: true,
      sourceRecords: true,
    },
  });

  console.log(`\nImported ${products.length} products:`);
  for (const p of products) {
    console.log(`- [${p.country}] ${p.brandName} (${p.brandNameAr || ""})`);
    console.log(`  Dosage form: ${p.dosageForm}, Strength: ${p.strength}, Route: ${p.route}`);
    console.log(`  Active Ingredients: ${p.ingredients.map(i => i.ingredient.name).join(", ")}`);
    console.log(`  Identifiers: ${p.identifiers.map(i => `${i.idType}=${i.identifier}`).join(", ")}`);
    console.log(`  Verification state: ${p.verificationState}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
