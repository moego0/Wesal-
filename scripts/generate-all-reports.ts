import "dotenv/config";
import {
  generateSourceCoverageReport,
  generateCatalogImportReport,
  generateDdiCoverageReport,
} from "../src/server/catalog/reports";

async function main() {
  const coverage = await generateSourceCoverageReport();
  const importReport = await generateCatalogImportReport();
  const ddiReport = await generateDdiCoverageReport();

  console.log("================================================================================");
  console.log("          WESAL: SOURCE COVERAGE AND CATALOG AUDIT REPORT                       ");
  console.log("================================================================================\n");

  console.log("GENERATED AT:", coverage.generatedAt);
  console.log("\nSTATEMENT ON COVERAGE:\n" + coverage.worldwideCoverageStatement);

  console.log("\n--- APPROVED CATALOG SOURCES ---");
  for (const s of coverage.sources) {
    console.log(`* ${s.displayName} [${s.name}]`);
    console.log(`  License: ${s.license}`);
    console.log(`  Attribution: ${s.attribution}`);
    console.log(`  Jurisdiction: ${s.jurisdiction || "Global"} | Version: ${s.version || "N/A"}`);
    console.log(`  Products in Catalog: ${s.productCount} | Import Batches: ${s.importCount}`);
  }

  console.log("\n--- JURISDICTION / COUNTRY COVERAGE (NO SYNTHETIC RECORDS) ---");
  for (const c of coverage.countries) {
    console.log(`- Country: ${c.country} -> ${c.productCount} verified products`);
  }

  console.log("\n--- INGREDIENTS NORMALIZATION & CROSSWALK ---");
  console.log(`Total Standardized Ingredients: ${coverage.ingredients.total}`);
  console.log(`With RxNorm RxCUI: ${coverage.ingredients.withRxNormCui}`);
  console.log(`With PubChem CID: ${coverage.ingredients.withPubChemCid}`);
  console.log(`Cross-Source Matched: ${coverage.ingredients.crossSourceMatched}`);
  console.log(`Imported Unverified: ${coverage.ingredients.importedUnverified}`);

  console.log("\n--- RECENT IMPORT BATCHES AUDIT ---");
  console.log(`Total Import Runs Logged: ${importReport.totalImports}`);
  for (const imp of importReport.imports.slice(0, 10)) {
    console.log(`- [${imp.sourceName}] Batch: ${imp.id} | Status: ${imp.status} | Total: ${imp.totalRecords} (New: ${imp.insertedRecords}, Duplicates: ${imp.duplicateRecords}, Updated: ${imp.updatedRecords})`);
    console.log(`  Checksum: ${imp.checksum || "none"}`);
  }

  console.log("\n================================================================================");
  console.log("          DRUG-DRUG INTERACTION (DDI) KNOWLEDGE BASE REPORT                     ");
  console.log("================================================================================\n");
  console.log("LICENSE COMPLIANCE:", ddiReport.licenseCompliance);
  console.log(`Total Interaction Records in Knowledge Base: ${ddiReport.totalInteractions}`);
  console.log("Breakdown by Severity:", ddiReport.interactionsBySeverity);
  console.log("Breakdown by Clinical Review State:", ddiReport.interactionsByApprovalState);
  console.log(`Timing Rules Registered: ${ddiReport.timingRulesCount}`);
  console.log(`Unmatched Records Preserved for Review: ${ddiReport.unmatchedRecordsCount}`);
  console.log("\n" + ddiReport.safetyDisclaimer);
  console.log("\n================================================================================");
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
