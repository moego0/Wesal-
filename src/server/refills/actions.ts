"use server";

import { revalidatePath } from "next/cache";
import { type RefillStatus } from "@/generated/prisma/enums";
import { AUDIT_ACTION, writeAudit, type AuditWriter } from "@/server/audit";
import { requireSessionUser } from "@/server/auth/current-user";
import { requirePermission } from "@/server/auth/rbac";
import { systemPrisma } from "@/server/db";
import { calculateDepletionDate, calculateTreatmentEndDate, isTreatmentActive } from "@/lib/refills";

const ALLOWED_STATUSES: RefillStatus[] = [
  "PENDING",
  "STOCK_ORDERED",
  "READY_FOR_COLLECTION",
  "DISPENSED",
];

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function safeLocale(value: FormDataEntryValue | null): "ar" | "en" {
  return value === "en" ? "en" : "ar";
}

/**
 * Updates a refill's status through its clinical workflow:
 * PENDING -> STOCK_ORDERED -> READY_FOR_COLLECTION -> DISPENSED.
 *
 * When marked as DISPENSED, if the medication treatment duration has not ended,
 * automatically generates the next refill cycle record.
 */
export async function updateRefillStatusAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const locale = safeLocale(formData.get("locale"));
  const user = await requireSessionUser(locale);
  requirePermission(user, "medication:write");

  const refillId = field(formData, "refillId");
  const status = field(formData, "status") as RefillStatus;
  const notes = field(formData, "notes") || null;

  if (!refillId || !ALLOWED_STATUSES.includes(status)) {
    return { ok: false, error: "INVALID_STATUS" };
  }

  const refill = await systemPrisma.refillRecord.findFirst({
    where: { id: refillId, pharmacyId: user.pharmacyId },
    include: {
      medication: {
        include: {
          schedules: {
            where: { status: "ACTIVE" },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
      },
      patient: { select: { id: true, timeZone: true } },
    },
  });

  if (!refill) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const now = new Date();

  await systemPrisma.$transaction(async (tx) => {
    const isDispensed = status === "DISPENSED";
    const isStockOrdered = status === "STOCK_ORDERED";
    const isReady = status === "READY_FOR_COLLECTION";

    const updateData: Record<string, unknown> = {
      status,
      notes: notes ?? refill.notes,
    };

    if (isDispensed) {
      updateData.dispensedAtUtc = now;
      updateData.isUnconfirmedOverdue = false;
      updateData.inventoryAvailable = true;
    } else if (isStockOrdered) {
      updateData.inventoryAvailable = false;
    } else if (isReady) {
      updateData.inventoryAvailable = true;
    }

    const updated = await tx.refillRecord.update({
      where: { id: refill.id },
      data: updateData,
    });

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: user.pharmacyId,
      actorType: "USER",
      actorUserId: user.userId,
      entityType: "RefillRecord",
      entityId: refill.id,
      action: "REFILL_STATUS_UPDATED",
      before: { status: refill.status, notes: refill.notes },
      after: { status: updated.status, notes: updated.notes },
    });

    // If dispensed, automatically calculate and generate subsequent refill cycle if treatment continues
    if (isDispensed) {
      const medication = refill.medication;
      const activeSchedule = medication.schedules[0];

      // Determine treatment end date from duration or active schedule
      let treatmentEndDate: Date | null = activeSchedule?.endDate ?? null;
      if (!treatmentEndDate && medication.treatmentDurationValue && medication.treatmentDurationUnit) {
        treatmentEndDate = calculateTreatmentEndDate(
          medication.startedOn,
          medication.treatmentDurationValue,
          medication.treatmentDurationUnit as "DAYS" | "WEEKS" | "MONTHS",
        );
      }

      // Check if treatment is still active
      const treatmentStillActive = isTreatmentActive(now, treatmentEndDate);

      if (treatmentStillActive && medication.status === "ACTIVE") {
        const nextCycleNumber = refill.cycleNumber + 1;
        const daysSupply = refill.daysSupply ?? 30;

        // Next cycle starts from the dispense date
        const nextRunOutOn = calculateDepletionDate(now, daysSupply);

        // Check if an existing uncompleted cycle already exists
        const existingNext = await tx.refillRecord.findFirst({
          where: {
            medicationId: medication.id,
            cycleNumber: nextCycleNumber,
          },
        });

        if (!existingNext) {
          await tx.refillRecord.create({
            data: {
              pharmacyId: user.pharmacyId,
              patientId: refill.patientId,
              medicationId: medication.id,
              cycleNumber: nextCycleNumber,
              status: "PENDING",
              daysSupply,
              packagesNeeded: refill.packagesNeeded,
              expectedRunOutOn: nextRunOutOn,
              refillDueOn: nextRunOutOn,
              refillLeadDays: refill.refillLeadDays,
              inventoryAvailable: null,
            },
          });
        }
      }
    }
  });

  revalidatePath("/", "layout");
  return { ok: true };
}

/**
 * Manually adjusts the expected depletion / refill date for a refill record.
 */
export async function adjustRefillDateAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const locale = safeLocale(formData.get("locale"));
  const user = await requireSessionUser(locale);
  requirePermission(user, "medication:write");

  const refillId = field(formData, "refillId");
  const expectedRunOutRaw = field(formData, "expectedRunOutOn");
  const refillDueRaw = field(formData, "refillDueOn") || expectedRunOutRaw;

  if (!refillId || !expectedRunOutRaw) {
    return { ok: false, error: "INVALID_INPUT" };
  }

  const expectedRunOutOn = new Date(`${expectedRunOutRaw}T00:00:00.000Z`);
  const refillDueOn = new Date(`${refillDueRaw}T00:00:00.000Z`);

  if (Number.isNaN(expectedRunOutOn.getTime()) || Number.isNaN(refillDueOn.getTime())) {
    return { ok: false, error: "INVALID_DATE" };
  }

  const refill = await systemPrisma.refillRecord.findFirst({
    where: { id: refillId, pharmacyId: user.pharmacyId },
  });

  if (!refill) {
    return { ok: false, error: "NOT_FOUND" };
  }

  await systemPrisma.$transaction(async (tx) => {
    const updated = await tx.refillRecord.update({
      where: { id: refill.id },
      data: {
        expectedRunOutOn,
        refillDueOn,
        // Reset unconfirmed overdue flag since date was manually adjusted
        isUnconfirmedOverdue: false,
      },
    });

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: user.pharmacyId,
      actorType: "USER",
      actorUserId: user.userId,
      entityType: "RefillRecord",
      entityId: refill.id,
      action: "REFILL_DATE_ADJUSTED",
      before: {
        expectedRunOutOn: refill.expectedRunOutOn?.toISOString().slice(0, 10),
        refillDueOn: refill.refillDueOn?.toISOString().slice(0, 10),
      },
      after: {
        expectedRunOutOn: updated.expectedRunOutOn?.toISOString().slice(0, 10),
        refillDueOn: updated.refillDueOn?.toISOString().slice(0, 10),
      },
    });
  });

  revalidatePath("/", "layout");
  return { ok: true };
}
