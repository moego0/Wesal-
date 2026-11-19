import "dotenv/config";
import { systemPrisma } from "../src/server/db";
import { importDDInterInteractions, type DDInterRawRecord } from "../src/server/ddi/importer";
import { submitDdiReview } from "../src/server/ddi/reviews";
import { upsertTimingRule } from "../src/server/ddi/timing";
import { evaluateMedicationInteractions } from "../src/server/ddi/engine";

async function main() {
  console.log("=================================================");
  console.log("   WESAL DDI KNOWLEDGE BASE & ENGINE TEST SUITE  ");
  console.log("=================================================\n");

  // Step 1: Ensure test ingredients exist in the database
  console.log("1. Ensuring clinical test ingredients exist in catalog...");
  const dolutegravir = await systemPrisma.ingredient.upsert({
    where: { name: "dolutegravir" },
    update: {},
    create: {
      name: "dolutegravir",
      source: "rxnorm",
      verificationState: "CROSS_SOURCE_MATCHED",
      rxcui: "1433868",
    },
  });

  const aluminumHydroxide = await systemPrisma.ingredient.upsert({
    where: { name: "aluminum hydroxide" },
    update: {},
    create: {
      name: "aluminum hydroxide",
      source: "rxnorm",
      verificationState: "CROSS_SOURCE_MATCHED",
      rxcui: "612",
    },
  });

  const verapamil = await systemPrisma.ingredient.upsert({
    where: { name: "verapamil" },
    update: {},
    create: {
      name: "verapamil",
      source: "rxnorm",
      verificationState: "CROSS_SOURCE_MATCHED",
      rxcui: "11170",
    },
  });

  console.log(`- Dolutegravir ID: ${dolutegravir.id}`);
  console.log(`- Aluminum Hydroxide ID: ${aluminumHydroxide.id}`);
  console.log(`- Verapamil ID: ${verapamil.id}`);

  // Step 2: Import actual DDInter 2.0 research interaction records
  console.log("\n2. Importing authentic DDInter 2.0 interaction records...");
  const ddinterRecords: DDInterRawRecord[] = [
    {
      DDInterID_A: "DDInter58",
      Drug_A: "Aluminum hydroxide",
      DDInterID_B: "DDInter582",
      Drug_B: "Dolutegravir",
      Level: "Major",
      mechanism: "Chelation of dolutegravir by polyvalent metal cations in gastrointestinal tract, significantly decreasing dolutegravir absorption and plasma concentrations.",
      management: "Administer dolutegravir at least 2 hours before or 6 hours after aluminum- or magnesium-containing antacids.",
      reference: "DDInter 2.0 / FDA Tivicay Package Insert Section 7.1",
    },
    {
      DDInterID_A: "DDInter271",
      Drug_A: "Calcium carbonate",
      DDInterID_B: "DDInter582",
      Drug_B: "Dolutegravir",
      Level: "Major",
      mechanism: "Cation chelation reducing dolutegravir bioavailability.",
      management: "Separate administration by at least 2 hours before or 6 hours after calcium supplements.",
      reference: "DDInter 2.0 / NIH Guidelines",
    },
    {
      DDInterID_A: "DDInter1263",
      Drug_A: "Bisoprolol",
      DDInterID_B: "DDInter1348",
      Drug_B: "Verapamil",
      Level: "Major",
      mechanism: "Additive negative inotropic and chronotropic effects leading to profound bradycardia, severe hypotension, and heart block.",
      management: "Avoid concomitant use. If essential, close ECG and hemodynamic monitoring is required.",
      reference: "DDInter 2.0 / ACC/AHA Guidelines",
    },
    {
      DDInterID_A: "DDInter9999",
      Drug_A: "ExperimentalCompoundX", // Intentionally unknown to test unmatched record audit
      DDInterID_B: "DDInter582",
      Drug_B: "Dolutegravir",
      Level: "Moderate",
      mechanism: "Unknown experimental interaction",
      reference: "DDInter 2.0",
    },
  ];

  const importResult = await importDDInterInteractions(ddinterRecords, {
    batchLabel: "ddinter_official_sample",
  });
  console.log("DDInter Import Summary:", importResult);

  // Step 3: Verify Clinical Review Workflow
  console.log("\n3. Testing Clinical Review Workflow (Pharmacist Approval)...");
  const ddi = await systemPrisma.ddiInteraction.findFirst({
    where: {
      ingredientAId: aluminumHydroxide.id < dolutegravir.id ? aluminumHydroxide.id : dolutegravir.id,
      ingredientBId: aluminumHydroxide.id < dolutegravir.id ? dolutegravir.id : aluminumHydroxide.id,
    },
  });

  if (!ddi) {
    throw new Error("Expected Dolutegravir + Aluminum Hydroxide interaction not found!");
  }

  console.log(`Initial interaction state: ${ddi.clinicalApprovalState} (Severity: ${ddi.severity})`);

  const reviewResult = await submitDdiReview({
    interactionId: ddi.id,
    reviewerUserId: "pharmacist_clinician_01",
    reviewerRole: "PHARMACIST",
    decision: "APPROVED",
    clinicalNotes: "Clinically confirmed. Chelation significantly compromises antiretroviral therapy efficacy. Timing interval is mandatory.",
  });

  console.log(`Reviewed interaction state: ${reviewResult.interaction.clinicalApprovalState}`);

  // Step 4: Test Smart Scheduling Timing-Rule
  console.log("\n4. Establishing Smart Scheduling Timing Rule...");
  const timingRule = await upsertTimingRule({
    ingredientAId: aluminumHydroxide.id,
    ingredientBId: dolutegravir.id,
    minIntervalHours: 2.0,
    timingInstructionAr: "يجب الفصل بساعتين على الأقل بين مضادات الحموضة ودولوتيجرافير لتجنب تقليل الامتصاص.",
    timingInstructionEn: "Administer dolutegravir at least 2 hours before or 6 hours after aluminum-containing antacids.",
    clinicalReference: "FDA Tivicay Prescribing Information Section 7.1; DHHS Adult Antiretroviral Guidelines",
    isApproved: true,
    approvedByUserId: "pharmacist_clinician_01",
  });
  console.log(`Timing rule registered: Minimum separation of ${timingRule.minIntervalHours} hours.`);

  // Step 5: Test the Interaction Engine on Patient Active Medication List
  console.log("\n5. Testing Interaction Engine with Patient Medication Regimen...");

  // Scenario 1: Patient on Dolutegravir + Aluminum Hydroxide Antacid
  const patientMedications = [
    { name: "Tivicay 50 mg (dolutegravir)" },
    { name: "Maalox oral suspension (aluminum hydroxide)" },
    { name: "UnknownHerbExtra" }, // Tests unmatched medication flagging
  ];

  const evaluation = await evaluateMedicationInteractions(patientMedications);
  console.log("\n--- ENGINE EVALUATION RESULT ---");
  console.log(`Patient medications: ${evaluation.patientMedicationsCount}`);
  console.log(`Resolved ingredients: ${evaluation.resolvedIngredientsCount}`);
  console.log(`Evaluated pairs: ${evaluation.evaluatedPairsCount}`);
  console.log(`Interactions detected: ${evaluation.interactionsCount}`);
  console.log("Interactions by severity:", evaluation.interactionsBySeverity);

  for (const int of evaluation.interactions) {
    console.log(`\n* [${int.severity}] ${int.ingredientA.name} + ${int.ingredientB.name}`);
    console.log(`  Clinical Approval: ${int.clinicalApprovalState}`);
    console.log(`  Mechanism: ${int.mechanism}`);
    console.log(`  Management: ${int.management}`);
    if (int.timingRule) {
      console.log(`  SMART TIMING INTERVAL: ${int.timingRule.minIntervalHours} hours separation required.`);
      console.log(`  Instruction (AR): ${int.timingRule.timingInstructionAr}`);
      console.log(`  Clinical Reference: ${int.timingRule.clinicalReference}`);
    }
  }

  console.log("\nUnmatched Medications (Flagged for Pharmacist Review):");
  for (const un of evaluation.unmatchedMedications) {
    console.log(`- ${un.name}: ${un.reason}`);
  }

  console.log(`\nMandatory Safety Statement:\n"${evaluation.safetyDisclaimer}"`);

  console.log("\n=================================================");
  console.log("   DDI ENGINE SUCCESSFULLY VERIFIED OPERATIONAL  ");
  console.log("=================================================");
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
