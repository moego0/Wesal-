import { systemPrisma } from "@/server/db";
import { Prisma } from "@/generated/prisma/client";

export interface TimingRuleInput {
  ingredientAId: string;
  ingredientBId: string;
  minIntervalHours: number;
  timingInstructionAr?: string | null;
  timingInstructionEn: string;
  clinicalReference: string;
  isApproved?: boolean;
  approvedByUserId?: string | null;
}

/**
 * Smart Scheduling Timing-Rule Database.
 * Ensures co-administered medications with pharmacokinetic chelation/absorption delays
 * are separated by explicit clinically-referenced hourly intervals.
 */
export async function upsertTimingRule(input: TimingRuleInput) {
  if (!input.clinicalReference || !input.clinicalReference.trim()) {
    throw new Error("A specific clinical reference citation is required for timing rules.");
  }

  // Deterministic ID ordering
  const [ingA, ingB] = input.ingredientAId < input.ingredientBId
    ? [input.ingredientAId, input.ingredientBId]
    : [input.ingredientBId, input.ingredientAId];

  return systemPrisma.ddiTimingRule.upsert({
    where: {
      ingredientAId_ingredientBId: {
        ingredientAId: ingA,
        ingredientBId: ingB,
      },
    },
    update: {
      minIntervalHours: new Prisma.Decimal(input.minIntervalHours),
      timingInstructionAr: input.timingInstructionAr || null,
      timingInstructionEn: input.timingInstructionEn,
      clinicalReference: input.clinicalReference,
      isApproved: input.isApproved ?? false,
      approvedByUserId: input.approvedByUserId || null,
      approvedAt: input.isApproved ? new Date() : null,
    },
    create: {
      ingredientAId: ingA,
      ingredientBId: ingB,
      minIntervalHours: new Prisma.Decimal(input.minIntervalHours),
      timingInstructionAr: input.timingInstructionAr || null,
      timingInstructionEn: input.timingInstructionEn,
      clinicalReference: input.clinicalReference,
      isApproved: input.isApproved ?? false,
      approvedByUserId: input.approvedByUserId || null,
      approvedAt: input.isApproved ? new Date() : null,
    },
    include: {
      ingredientA: true,
      ingredientB: true,
    },
  });
}

/**
 * Retrieve approved timing rule between two ingredients if present.
 */
export async function getTimingRuleForPair(ingredientAId: string, ingredientBId: string) {
  const [ingA, ingB] = ingredientAId < ingredientBId ? [ingredientAId, ingredientBId] : [ingredientBId, ingredientAId];

  return systemPrisma.ddiTimingRule.findUnique({
    where: {
      ingredientAId_ingredientBId: {
        ingredientAId: ingA,
        ingredientBId: ingB,
      },
    },
  });
}
