import "dotenv/config";
import { systemPrisma } from "../src/server/db";

async function main() {
  console.log("Seeding clinical catalog & DDI interactions for user testing...");

  // 1. Get or create DDInter source
  let ddinterSource = await systemPrisma.drugCatalogSource.findUnique({
    where: { name: "ddinter" },
  });
  if (!ddinterSource) {
    ddinterSource = await systemPrisma.drugCatalogSource.create({
      data: {
        name: "ddinter",
        displayName: "DDInter 2.0 (Academic DDI Knowledge Base)",
        sourceUrl: "http://ddinter.scbdd.com/",
        license: "CC BY-NC-SA 4.0",
        attribution: "DDInter Consortium",
        jurisdiction: "GLOBAL",
        isActive: true,
      },
    });
  }

  // 2. Ingredients to ensure exist
  const ingredientsData = [
    {
      name: "warfarin",
      nameAr: "وارفارين",
      synonyms: ["warfarin sodium", "coumadin", "marevan", "warfarin 5mg"],
      verificationState: "CROSS_SOURCE_MATCHED" as const,
    },
    {
      name: "aspirin",
      nameAr: "أسبرين",
      synonyms: ["acetylsalicylic acid", "aspocid", "aspirin protect", "bayer aspirin", "aspocid 75mg"],
      verificationState: "CROSS_SOURCE_MATCHED" as const,
    },
    {
      name: "sildenafil",
      nameAr: "سيلدينافيل",
      synonyms: ["sildenafil citrate", "viagra", "revatio", "sildenafil 50mg", "sildenafil 100mg"],
      verificationState: "CROSS_SOURCE_MATCHED" as const,
    },
    {
      name: "nitroglycerin",
      nameAr: "نيتروجليسرين",
      synonyms: ["glyceryl trinitrate", "nitroderm", "angised", "nitronal", "nitroglycerin sublingual"],
      verificationState: "CROSS_SOURCE_MATCHED" as const,
    },
    {
      name: "codeine",
      nameAr: "كودايين",
      synonyms: ["codeine phosphate"],
      verificationState: "CROSS_SOURCE_MATCHED" as const,
    },
    {
      name: "paracetamol",
      nameAr: "باراسيتامول",
      synonyms: ["acetaminophen", "panadol", "paramol", "adol"],
      verificationState: "CROSS_SOURCE_MATCHED" as const,
    },
  ];

  const ingMap = new Map<string, string>();

  for (const item of ingredientsData) {
    const existing = await systemPrisma.ingredient.findFirst({
      where: {
        OR: [
          { name: { equals: item.name, mode: "insensitive" } },
          { synonyms: { has: item.name } },
        ],
      },
    });

    if (existing) {
      // update synonyms if needed
      const merged = Array.from(new Set([...existing.synonyms, ...item.synonyms]));
      const updated = await systemPrisma.ingredient.update({
        where: { id: existing.id },
        data: { synonyms: merged },
      });
      ingMap.set(item.name, updated.id);
    } else {
      const created = await systemPrisma.ingredient.create({
        data: {
          name: item.name,
          nameAr: item.nameAr,
          synonyms: item.synonyms,
          verificationState: item.verificationState,
        },
      });
      ingMap.set(item.name, created.id);
    }
  }

  // 3. Ensure DrugProducts for common brand names
  // PANACODE -> Paracetamol + Codeine
  const paracetamolId = ingMap.get("paracetamol");
  const codeineId = ingMap.get("codeine");
  if (paracetamolId && codeineId) {
    const existingPanacode = await systemPrisma.drugProduct.findFirst({
      where: { brandName: { contains: "panacode", mode: "insensitive" } },
    });
    if (!existingPanacode) {
      const panacode = await systemPrisma.drugProduct.create({
        data: {
          brandName: "PANACODE",
          genericName: "Paracetamol and Codeine Phosphate",
          country: "EG",
          strength: "500 mg / 30 mg",
          dosageForm: "Tablet",
          route: "Oral",
          sourceId: ddinterSource.id,
          verificationState: "MANUALLY_VERIFIED",
        },
      });

      await systemPrisma.productIngredient.createMany({
        data: [
          { productId: panacode.id, ingredientId: paracetamolId, strength: "500 mg" },
          { productId: panacode.id, ingredientId: codeineId, strength: "30 mg" },
        ],
        skipDuplicates: true,
      });
      console.log("Created DrugProduct: PANACODE (paracetamol + codeine)");
    }
  }

  // 4. Create DdiInteractions
  // Interaction A: Warfarin + Aspirin
  const warfarinId = ingMap.get("warfarin")!;
  const aspirinId = ingMap.get("aspirin")!;
  const [wId, aId] = warfarinId < aspirinId ? [warfarinId, aspirinId] : [aspirinId, warfarinId];

  const existingWarfAsp = await systemPrisma.ddiInteraction.findFirst({
    where: { ingredientAId: wId, ingredientBId: aId },
  });

  if (!existingWarfAsp) {
    await systemPrisma.ddiInteraction.create({
      data: {
        ingredientAId: wId,
        ingredientBId: aId,
        severity: "MAJOR",
        source: "DDInter 2.0",
        sourceDrugAId: "DDInter_WAR",
        sourceDrugBId: "DDInter_ASP",
        mechanism:
          "Additive pharmacological effects: aspirin induces platelet inhibition and gastric mucosal injury while warfarin impairs vitamin K-dependent coagulation factors, leading to a markedly elevated risk of gastrointestinal and major systemic hemorrhage.",
        management:
          "Avoid concurrent use unless strictly indicated (e.g. mechanical heart valve plus recent coronary stent). If co-prescribed, monitor INR rigorously and consider gastroprotective proton pump inhibitor co-therapy.",
        clinicalApprovalState: "CLINICALLY_APPROVED",
        reference: "DDInter 2.0 & CHEST Antithrombotic Guidelines",
      },
    });
    console.log("Created Interaction: Warfarin + Aspirin (MAJOR)");
  }

  // Interaction B: Sildenafil + Nitroglycerin
  const sildenafilId = ingMap.get("sildenafil")!;
  const nitroglycerinId = ingMap.get("nitroglycerin")!;
  const [sId, nId] = sildenafilId < nitroglycerinId ? [sildenafilId, nitroglycerinId] : [nitroglycerinId, sildenafilId];

  const existingSilNitro = await systemPrisma.ddiInteraction.findFirst({
    where: { ingredientAId: sId, ingredientBId: nId },
  });

  if (!existingSilNitro) {
    const ddi = await systemPrisma.ddiInteraction.create({
      data: {
        ingredientAId: sId,
        ingredientBId: nId,
        severity: "MAJOR",
        source: "DDInter 2.0",
        sourceDrugAId: "DDInter_SIL",
        sourceDrugBId: "DDInter_NIT",
        mechanism:
          "Severe synergistic vasodilatory hypotension: Sildenafil selectively inhibits PDE5-mediated cGMP degradation, markedly potentiation nitric oxide/cyclic GMP pathway activation caused by nitroglycerin, resulting in life-threatening hypotension and syncope.",
        management:
          "Absolute contraindication. Nitrates in any form (sublingual, transdermal, IV) must not be administered within 24 hours of sildenafil administration.",
        clinicalApprovalState: "CLINICALLY_APPROVED",
        reference: "DDInter 2.0 & American College of Cardiology (ACC/AHA)",
      },
    });

    // Timing Rule: 24 hours
    await systemPrisma.ddiTimingRule.create({
      data: {
        ingredientAId: sId,
        ingredientBId: nId,
        minIntervalHours: 24,
        timingInstructionEn: "Do not administer nitrates within at least 24 hours of sildenafil use.",
        timingInstructionAr: "يحظر تماماً تناول مشتقات النيتروجليسرين قبل مرور 24 ساعة على الأقل من تناول السيلدينافيل.",
        clinicalReference: "ACC/AHA Expert Consensus Document on Nitrates and Sildenafil",
        isApproved: true,
      },
    });
    console.log("Created Interaction: Sildenafil + Nitroglycerin (MAJOR with 24h Timing Rule)");
  }

  console.log("Seeding complete successfully!");
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
