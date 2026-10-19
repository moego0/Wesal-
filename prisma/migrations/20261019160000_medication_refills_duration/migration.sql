-- Migration: medication_refills_duration
-- Extends RefillStatus enum, Pharmacy operating hours & refill thresholds,
-- MedicationRecord prescription package & doctor info, and RefillRecord cycle tracking.

-- 1. RefillStatus enum values
ALTER TYPE "RefillStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "RefillStatus" ADD VALUE IF NOT EXISTS 'STOCK_ORDERED';
ALTER TYPE "RefillStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_COLLECTION';

-- 2. Pharmacy operating hours and refill thresholds
ALTER TABLE "Pharmacy" ADD COLUMN IF NOT EXISTS "is24Hours" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Pharmacy" ADD COLUMN IF NOT EXISTS "operatingHoursStart" TEXT NOT NULL DEFAULT '08:00';
ALTER TABLE "Pharmacy" ADD COLUMN IF NOT EXISTS "operatingHoursEnd" TEXT NOT NULL DEFAULT '22:00';
ALTER TABLE "Pharmacy" ADD COLUMN IF NOT EXISTS "refillLeadDays" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "Pharmacy" ADD COLUMN IF NOT EXISTS "refillUrgentDays" INTEGER NOT NULL DEFAULT 1;

-- 3. MedicationRecord prescription details & doctor info
ALTER TABLE "MedicationRecord" ADD COLUMN IF NOT EXISTS "unitsPerPackage" INTEGER;
ALTER TABLE "MedicationRecord" ADD COLUMN IF NOT EXISTS "unitsPerDose" DECIMAL(10, 2);
ALTER TABLE "MedicationRecord" ADD COLUMN IF NOT EXISTS "dosesPerDay" INTEGER;
ALTER TABLE "MedicationRecord" ADD COLUMN IF NOT EXISTS "treatmentDurationValue" INTEGER;
ALTER TABLE "MedicationRecord" ADD COLUMN IF NOT EXISTS "treatmentDurationUnit" TEXT;
ALTER TABLE "MedicationRecord" ADD COLUMN IF NOT EXISTS "prescriberDoctorName" TEXT;
ALTER TABLE "MedicationRecord" ADD COLUMN IF NOT EXISTS "prescriberDoctorPhone" TEXT;

-- 4. RefillRecord cycle & tracking fields
ALTER TABLE "RefillRecord" ADD COLUMN IF NOT EXISTS "cycleNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "RefillRecord" ADD COLUMN IF NOT EXISTS "packagesNeeded" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "RefillRecord" ADD COLUMN IF NOT EXISTS "patientRemindedAtUtc" TIMESTAMP(3);
ALTER TABLE "RefillRecord" ADD COLUMN IF NOT EXISTS "pharmacyWarnedAtUtc" TIMESTAMP(3);
ALTER TABLE "RefillRecord" ADD COLUMN IF NOT EXISTS "pharmacyUrgentWarnedAtUtc" TIMESTAMP(3);
ALTER TABLE "RefillRecord" ADD COLUMN IF NOT EXISTS "isUnconfirmedOverdue" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RefillRecord" ADD COLUMN IF NOT EXISTS "inventoryAvailable" BOOLEAN;
