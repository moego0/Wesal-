import "dotenv/config";
import { systemPrisma } from "../src/server/db";

async function run() {
  console.log("1. Finding eg-drugs source...");
  const s = await systemPrisma.drugCatalogSource.findUnique({ where: { name: "eg-drugs" } });
  console.log("Source found:", s?.name);

  console.log("2. Creating import log...");
  const imp = await systemPrisma.drugCatalogImport.create({
    data: {
      sourceId: s!.id,
      status: "TEST",
    },
  });
  console.log("Import log created:", imp.id);

  console.log("3. Creating drug product...");
  const p = await systemPrisma.drugProduct.create({
    data: {
      sourceId: s!.id,
      country: "EG",
      brandName: "Panadol Extra",
      dosageForm: "Tablet",
      verificationState: "IMPORTED_UNVERIFIED",
    },
  });
  console.log("Drug product created:", p.id);

  console.log("4. Cleaning test rows...");
  await systemPrisma.drugProduct.delete({ where: { id: p.id } });
  await systemPrisma.drugCatalogImport.delete({ where: { id: imp.id } });
  console.log("Done clean!");
}

run()
  .then(() => process.exit(0))
  .catch(e => {
    console.error("Diagnostic error:", e);
    process.exit(1);
  });
