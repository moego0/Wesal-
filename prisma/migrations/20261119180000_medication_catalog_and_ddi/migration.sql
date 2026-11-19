-- CreateEnum
CREATE TYPE "SourceVerificationState" AS ENUM ('IMPORTED_UNVERIFIED', 'CROSS_SOURCE_MATCHED', 'MANUALLY_VERIFIED');

-- CreateEnum
CREATE TYPE "DdiSeverity" AS ENUM ('MAJOR', 'MODERATE', 'MINOR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DdiApprovalState" AS ENUM ('IMPORTED_UNREVIEWED', 'CLINICALLY_APPROVED', 'REJECTED', 'FLAGGED_FOR_REVIEW');

-- CreateEnum
CREATE TYPE "DdiReviewDecision" AS ENUM ('APPROVED', 'REJECTED', 'MODIFIED', 'NEEDS_MORE_EVIDENCE');

-- CreateTable
CREATE TABLE "DrugCatalogSource" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "licenseUrl" TEXT,
    "attribution" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "version" TEXT,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DrugCatalogSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrugCatalogImport" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "totalRecords" INTEGER NOT NULL DEFAULT 0,
    "insertedRecords" INTEGER NOT NULL DEFAULT 0,
    "updatedRecords" INTEGER NOT NULL DEFAULT 0,
    "duplicateRecords" INTEGER NOT NULL DEFAULT 0,
    "invalidRecords" INTEGER NOT NULL DEFAULT 0,
    "unmatchedIngredients" INTEGER NOT NULL DEFAULT 0,
    "missingStrengths" INTEGER NOT NULL DEFAULT 0,
    "sourceVersion" TEXT,
    "checksum" TEXT,
    "logDetails" JSONB,
    "errorMessage" TEXT,

    CONSTRAINT "DrugCatalogImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "synonyms" TEXT[],
    "rxcui" TEXT,
    "pubchemCid" TEXT,
    "inchiKey" TEXT,
    "atcCode" TEXT,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "verificationState" "SourceVerificationState" NOT NULL DEFAULT 'IMPORTED_UNVERIFIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrugProduct" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "brandNameAr" TEXT,
    "genericName" TEXT,
    "manufacturer" TEXT,
    "strength" TEXT,
    "dosageForm" TEXT,
    "route" TEXT,
    "registrationNumber" TEXT,
    "verificationState" "SourceVerificationState" NOT NULL DEFAULT 'IMPORTED_UNVERIFIED',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "price" DECIMAL(10,2),
    "currency" TEXT DEFAULT 'EGP',
    "units" TEXT,
    "category" TEXT,
    "indications" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DrugProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductIngredient" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "strength" TEXT,
    "strengthNumerator" DECIMAL(12,4),
    "strengthNumeratorUnit" TEXT,
    "strengthDenominator" DECIMAL(12,4),
    "strengthDenominatorUnit" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrugProductIdentifier" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "idType" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "isValid" BOOLEAN NOT NULL DEFAULT true,
    "issuer" TEXT,

    CONSTRAINT "DrugProductIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrugProductSourceRecord" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "sourceId" TEXT NOT NULL,
    "importId" TEXT,
    "sourceExternalId" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "license" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordChecksum" TEXT,

    CONSTRAINT "DrugProductSourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DdiInteraction" (
    "id" TEXT NOT NULL,
    "ingredientAId" TEXT NOT NULL,
    "ingredientBId" TEXT NOT NULL,
    "sourceDrugAId" TEXT,
    "sourceDrugBId" TEXT,
    "sourceDrugAName" TEXT,
    "sourceDrugBName" TEXT,
    "severity" "DdiSeverity" NOT NULL DEFAULT 'UNKNOWN',
    "description" TEXT,
    "mechanism" TEXT,
    "management" TEXT,
    "source" TEXT NOT NULL DEFAULT 'DDInter 2.0',
    "license" TEXT NOT NULL DEFAULT 'CC BY-NC-SA 4.0',
    "reference" TEXT,
    "clinicalApprovalState" "DdiApprovalState" NOT NULL DEFAULT 'IMPORTED_UNREVIEWED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DdiInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DdiReview" (
    "id" TEXT NOT NULL,
    "interactionId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "reviewerRole" TEXT NOT NULL,
    "decision" "DdiReviewDecision" NOT NULL,
    "adjustedSeverity" "DdiSeverity",
    "adjustedManagement" TEXT,
    "clinicalNotes" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DdiReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DdiTimingRule" (
    "id" TEXT NOT NULL,
    "ingredientAId" TEXT NOT NULL,
    "ingredientBId" TEXT NOT NULL,
    "minIntervalHours" DECIMAL(5,2) NOT NULL,
    "timingInstructionAr" TEXT,
    "timingInstructionEn" TEXT NOT NULL,
    "clinicalReference" TEXT NOT NULL,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DdiTimingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DdiUnmatchedRecord" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'DDInter 2.0',
    "sourceDrugAId" TEXT NOT NULL,
    "sourceDrugAName" TEXT NOT NULL,
    "sourceDrugBId" TEXT NOT NULL,
    "sourceDrugBName" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "rawRecord" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DdiUnmatchedRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DrugCatalogSource_name_key" ON "DrugCatalogSource"("name");

-- CreateIndex
CREATE INDEX "DrugCatalogSource_name_idx" ON "DrugCatalogSource"("name");

-- CreateIndex
CREATE INDEX "DrugCatalogImport_sourceId_importedAt_idx" ON "DrugCatalogImport"("sourceId", "importedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_name_key" ON "Ingredient"("name");

-- CreateIndex
CREATE INDEX "Ingredient_rxcui_idx" ON "Ingredient"("rxcui");

-- CreateIndex
CREATE INDEX "Ingredient_pubchemCid_idx" ON "Ingredient"("pubchemCid");

-- CreateIndex
CREATE INDEX "Ingredient_atcCode_idx" ON "Ingredient"("atcCode");

-- CreateIndex
CREATE INDEX "DrugProduct_country_brandName_idx" ON "DrugProduct"("country", "brandName");

-- CreateIndex
CREATE INDEX "DrugProduct_country_genericName_idx" ON "DrugProduct"("country", "genericName");

-- CreateIndex
CREATE INDEX "DrugProduct_sourceId_idx" ON "DrugProduct"("sourceId");

-- CreateIndex
CREATE INDEX "DrugProduct_verificationState_idx" ON "DrugProduct"("verificationState");

-- CreateIndex
CREATE INDEX "ProductIngredient_ingredientId_idx" ON "ProductIngredient"("ingredientId");

-- CreateIndex
CREATE INDEX "ProductIngredient_productId_idx" ON "ProductIngredient"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductIngredient_productId_ingredientId_key" ON "ProductIngredient"("productId", "ingredientId");

-- CreateIndex
CREATE INDEX "DrugProductIdentifier_idType_identifier_idx" ON "DrugProductIdentifier"("idType", "identifier");

-- CreateIndex
CREATE INDEX "DrugProductIdentifier_productId_idx" ON "DrugProductIdentifier"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "DrugProductIdentifier_idType_identifier_productId_key" ON "DrugProductIdentifier"("idType", "identifier", "productId");

-- CreateIndex
CREATE INDEX "DrugProductSourceRecord_sourceId_sourceExternalId_idx" ON "DrugProductSourceRecord"("sourceId", "sourceExternalId");

-- CreateIndex
CREATE INDEX "DrugProductSourceRecord_productId_idx" ON "DrugProductSourceRecord"("productId");

-- CreateIndex
CREATE INDEX "DdiInteraction_ingredientAId_idx" ON "DdiInteraction"("ingredientAId");

-- CreateIndex
CREATE INDEX "DdiInteraction_ingredientBId_idx" ON "DdiInteraction"("ingredientBId");

-- CreateIndex
CREATE INDEX "DdiInteraction_severity_idx" ON "DdiInteraction"("severity");

-- CreateIndex
CREATE INDEX "DdiInteraction_clinicalApprovalState_idx" ON "DdiInteraction"("clinicalApprovalState");

-- CreateIndex
CREATE UNIQUE INDEX "DdiInteraction_ingredientAId_ingredientBId_source_key" ON "DdiInteraction"("ingredientAId", "ingredientBId", "source");

-- CreateIndex
CREATE INDEX "DdiReview_interactionId_idx" ON "DdiReview"("interactionId");

-- CreateIndex
CREATE INDEX "DdiReview_reviewerUserId_idx" ON "DdiReview"("reviewerUserId");

-- CreateIndex
CREATE INDEX "DdiTimingRule_ingredientAId_idx" ON "DdiTimingRule"("ingredientAId");

-- CreateIndex
CREATE INDEX "DdiTimingRule_ingredientBId_idx" ON "DdiTimingRule"("ingredientBId");

-- CreateIndex
CREATE UNIQUE INDEX "DdiTimingRule_ingredientAId_ingredientBId_key" ON "DdiTimingRule"("ingredientAId", "ingredientBId");

-- CreateIndex
CREATE INDEX "DdiUnmatchedRecord_sourceDrugAName_idx" ON "DdiUnmatchedRecord"("sourceDrugAName");

-- CreateIndex
CREATE INDEX "DdiUnmatchedRecord_sourceDrugBName_idx" ON "DdiUnmatchedRecord"("sourceDrugBName");

-- AddForeignKey
ALTER TABLE "DrugCatalogImport" ADD CONSTRAINT "DrugCatalogImport_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DrugCatalogSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrugProduct" ADD CONSTRAINT "DrugProduct_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DrugCatalogSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DrugProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrugProductIdentifier" ADD CONSTRAINT "DrugProductIdentifier_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DrugProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrugProductSourceRecord" ADD CONSTRAINT "DrugProductSourceRecord_productId_fkey" FOREIGN KEY ("productId") REFERENCES "DrugProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DrugProductSourceRecord" ADD CONSTRAINT "DrugProductSourceRecord_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DrugCatalogSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DdiInteraction" ADD CONSTRAINT "DdiInteraction_ingredientAId_fkey" FOREIGN KEY ("ingredientAId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DdiInteraction" ADD CONSTRAINT "DdiInteraction_ingredientBId_fkey" FOREIGN KEY ("ingredientBId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DdiReview" ADD CONSTRAINT "DdiReview_interactionId_fkey" FOREIGN KEY ("interactionId") REFERENCES "DdiInteraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DdiTimingRule" ADD CONSTRAINT "DdiTimingRule_ingredientAId_fkey" FOREIGN KEY ("ingredientAId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DdiTimingRule" ADD CONSTRAINT "DdiTimingRule_ingredientBId_fkey" FOREIGN KEY ("ingredientBId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
