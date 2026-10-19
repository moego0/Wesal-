import { DateTime } from "luxon";
import { systemPrisma } from "@/server/db";
import { getMessagingProvider } from "@/server/messaging/factory";
import { calculateDaysRemaining, isOperatingHour, isTreatmentActive } from "@/lib/refills";

/**
 * Sweep for automated medication refill alerts and patient WhatsApp reminders.
 *
 * Runs as a repeatable background sweep in the worker.
 * Idempotent: checks stamps (`pharmacyWarnedAtUtc`, `pharmacyUrgentWarnedAtUtc`,
 * `patientRemindedAtUtc`, `isUnconfirmedOverdue`) to prevent duplicates.
 */
export async function sweepRefills(now: Date = new Date()): Promise<{
  pharmaciesProcessed: number;
  refillsEvaluated: number;
  pharmacyAlertsCreated: number;
  patientRemindersSent: number;
  overdueFlagged: number;
}> {
  const pharmacies = await systemPrisma.pharmacy.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      name: true,
      timeZone: true,
      defaultLocale: true,
      is24Hours: true,
      operatingHoursStart: true,
      operatingHoursEnd: true,
      refillLeadDays: true,
      refillUrgentDays: true,
    },
  });

  let pharmacyAlertsCreated = 0;
  let patientRemindersSent = 0;
  let overdueFlagged = 0;
  let refillsEvaluated = 0;

  const messaging = getMessagingProvider();

  for (const pharmacy of pharmacies) {
    const tz = pharmacy.timeZone || "Africa/Cairo";
    const pharmacyNow = DateTime.fromJSDate(now, { zone: tz });
    const localTodayIso = pharmacyNow.toISODate() ?? "1970-01-01";
    const localTodayDate = new Date(`${localTodayIso}T00:00:00.000Z`);

    // Check if pharmacy is currently open for pharmacy-facing operational notifications
    const pharmacyIsOpen = isOperatingHour(
      now,
      pharmacy.is24Hours,
      pharmacy.operatingHoursStart,
      pharmacy.operatingHoursEnd,
      pharmacy.timeZone,
    );

    // Find active uncompleted refill records
    const refills = await systemPrisma.refillRecord.findMany({
      where: {
        pharmacyId: pharmacy.id,
        status: { in: ["PENDING", "ESTIMATED", "REQUESTED", "SCHEDULED", "STOCK_ORDERED", "READY_FOR_COLLECTION"] },
        expectedRunOutOn: { not: null },
        medication: {
          status: "ACTIVE",
        },
        patient: {
          status: "ACTIVE",
        },
      },
      include: {
        medication: {
          select: {
            id: true,
            medicationNameText: true,
            status: true,
            startedOn: true,
            treatmentDurationValue: true,
            treatmentDurationUnit: true,
            prescriberDoctorName: true,
            prescriberDoctorPhone: true,
            schedules: {
              where: { status: "ACTIVE" },
              select: { endDate: true },
              take: 1,
            },
          },
        },
        patient: {
          select: {
            id: true,
            fullName: true,
            phoneE164: true,
            preferredLocale: true,
            messagingOptOutAt: true,
            consents: {
              where: { consentType: "WHATSAPP_MESSAGING" },
              orderBy: { grantedAt: "desc" },
              take: 1,
            },
          },
        },
      },
    });

    refillsEvaluated += refills.length;

    for (const refill of refills) {
      if (!refill.expectedRunOutOn) continue;

      const activeSchedule = refill.medication.schedules[0];
      const treatmentEndDate = activeSchedule?.endDate ?? null;

      // If treatment duration has ended, stop processing refill reminders
      if (!isTreatmentActive(now, treatmentEndDate)) {
        continue;
      }

      const daysRemaining = calculateDaysRemaining(refill.expectedRunOutOn, localTodayDate);

      const leadDays = pharmacy.refillLeadDays ?? refill.refillLeadDays ?? 5;
      const urgentDays = pharmacy.refillUrgentDays ?? 1;

      // ── 1. Pharmacy Standard Refill Alert (Approaching depletion) ──
      if (
        pharmacyIsOpen &&
        daysRemaining <= leadDays &&
        daysRemaining > urgentDays &&
        !refill.pharmacyWarnedAtUtc
      ) {
        const dedupeKey = `REFILL_APPROACHING|${refill.pharmacyId}|${refill.id}|c${refill.cycleNumber}`;
        const existingAlert = await systemPrisma.alert.findFirst({
          where: { dedupeKey, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        });

        if (!existingAlert) {
          const medName = refill.medication.medicationNameText;
          const patName = refill.patient.fullName;

          await systemPrisma.alert.create({
            data: {
              pharmacyId: pharmacy.id,
              patientId: refill.patient.id,
              medicationId: refill.medication.id,
              ruleKey: "REFILL_APPROACHING",
              ruleVersion: 1,
              dedupeKey,
              severity: "NORMAL",
              status: "OPEN",
              titleEn: `Upcoming Refill: ${medName} for ${patName}`,
              titleAr: `تجديد صرف قادم: ${medName} للمريض ${patName}`,
              detailEn: `Medication is expected to run out in approximately ${daysRemaining} day(s). Refill cycle #${refill.cycleNumber}.`,
              detailAr: `من المتوقع نفاد الدواء خلال حوالي ${daysRemaining} يوم/أيام. دورة صرف رقم ${refill.cycleNumber}.`,
              evidence: {
                refillId: refill.id,
                cycleNumber: refill.cycleNumber,
                daysRemaining,
                expectedRunOutOn: refill.expectedRunOutOn.toISOString().slice(0, 10),
                prescriberDoctorName: refill.medication.prescriberDoctorName,
              },
            },
          });
          pharmacyAlertsCreated++;
        }

        await systemPrisma.refillRecord.update({
          where: { id: refill.id },
          data: { pharmacyWarnedAtUtc: now },
        });
      }

      // ── 2. Pharmacy Urgent Refill Alert (Depletion tomorrow / imminent) ──
      if (
        pharmacyIsOpen &&
        daysRemaining <= urgentDays &&
        daysRemaining >= 0 &&
        !refill.pharmacyUrgentWarnedAtUtc
      ) {
        const dedupeKey = `REFILL_URGENT|${refill.pharmacyId}|${refill.id}|c${refill.cycleNumber}`;
        const existingAlert = await systemPrisma.alert.findFirst({
          where: { dedupeKey, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        });

        if (!existingAlert) {
          const medName = refill.medication.medicationNameText;
          const patName = refill.patient.fullName;

          await systemPrisma.alert.create({
            data: {
              pharmacyId: pharmacy.id,
              patientId: refill.patient.id,
              medicationId: refill.medication.id,
              ruleKey: "REFILL_URGENT",
              ruleVersion: 1,
              dedupeKey,
              severity: "URGENT",
              status: "OPEN",
              titleEn: `URGENT Refill: ${medName} for ${patName}`,
              titleAr: `تنبيه عاجل: قرب نفاد ${medName} للمريض ${patName}`,
              detailEn: `Medication is expected to deplete in ${daysRemaining <= 0 ? "today" : `${daysRemaining} day(s)`}. Please prepare refill.`,
              detailAr: `من المتوقع نفاد عبوة الدواء ${daysRemaining <= 0 ? "اليوم" : `خلال ${daysRemaining} يوم`}. يرجى تجهيز العبوة للصرف.`,
              evidence: {
                refillId: refill.id,
                cycleNumber: refill.cycleNumber,
                daysRemaining,
                expectedRunOutOn: refill.expectedRunOutOn.toISOString().slice(0, 10),
                prescriberDoctorName: refill.medication.prescriberDoctorName,
              },
            },
          });
          pharmacyAlertsCreated++;
        }

        await systemPrisma.refillRecord.update({
          where: { id: refill.id },
          data: { pharmacyUrgentWarnedAtUtc: now },
        });
      }

      // ── 3. Patient WhatsApp Refill Reminder ──
      // Send reminder when medication is approaching depletion (daysRemaining <= leadDays)
      const consent = refill.patient.consents[0];
      const hasConsent = Boolean(consent?.granted && !consent.revokedAt);
      const notOptedOut = !refill.patient.messagingOptOutAt;

      if (daysRemaining <= leadDays && daysRemaining >= 0 && !refill.patientRemindedAtUtc && hasConsent && notOptedOut) {
        const isAr = refill.patient.preferredLocale === "AR_EG";
        const patName = refill.patient.fullName;
        const medName = refill.medication.medicationNameText;

        const bodyText = isAr
          ? `مرحباً ${patName}،\n\nمن المتوقع نفاد عبوة دواء ${medName} خلال حوالي ${daysRemaining} أيام.\n\nيرجى التواصل مع الصيدلية لترتيب موعد صرف العبوة القادمة لضمان استمرار علاجك دون انقطاع.\n\n— وِصال`
          : `Hello ${patName},\n\nYour ${medName} package is expected to run out in approximately ${daysRemaining} days.\n\nPlease contact your pharmacy to arrange your next refill so your treatment continues without interruption.\n\n— Wesal`;

        try {
          const sendResult = await messaging.sendText({
            to: refill.patient.phoneE164,
            bodyText,
            callbackData: `refill_${refill.id}`,
            correlationId: `refill_${refill.id}_${refill.cycleNumber}`,
          });

          if (sendResult.ok) {
            patientRemindersSent++;
            await systemPrisma.refillRecord.update({
              where: { id: refill.id },
              data: {
                patientRemindedAtUtc: now,
                remindedAtUtc: now,
              },
            });
          }
        } catch (err) {
          console.error(`[refillSweep] Failed to send WhatsApp refill reminder to ${refill.patient.phoneE164}:`, err);
        }
      }

      // ── 4. Unconfirmed Overdue Refill Follow-up Flag ──
      // If expected depletion date has passed and patient hasn't had refill dispensed, flag for pharmacist follow-up
      if (daysRemaining < 0 && refill.status !== "DISPENSED" && !refill.isUnconfirmedOverdue) {
        await systemPrisma.refillRecord.update({
          where: { id: refill.id },
          data: { isUnconfirmedOverdue: true },
        });
        overdueFlagged++;

        const dedupeKey = `REFILL_OVERDUE|${refill.pharmacyId}|${refill.id}|c${refill.cycleNumber}`;
        const existingAlert = await systemPrisma.alert.findFirst({
          where: { dedupeKey, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        });

        if (!existingAlert) {
          const medName = refill.medication.medicationNameText;
          const patName = refill.patient.fullName;

          await systemPrisma.alert.create({
            data: {
              pharmacyId: pharmacy.id,
              patientId: refill.patient.id,
              medicationId: refill.medication.id,
              ruleKey: "REFILL_OVERDUE",
              ruleVersion: 1,
              dedupeKey,
              severity: "HIGH",
              status: "OPEN",
              titleEn: `Unconfirmed Overdue Refill: ${medName} for ${patName}`,
              titleAr: `تأكيد صرف الدواء متأخر: ${medName} للمريض ${patName}`,
              detailEn: `Expected depletion date (${refill.expectedRunOutOn.toISOString().slice(0, 10)}) has passed without confirmed refill. Follow up required.`,
              detailAr: `انقضى تاريخ نفاد الدواء المتوقع (${refill.expectedRunOutOn.toISOString().slice(0, 10)}) دون تأكيد الصرف. يتطلب متابعة الصيدلي مع المريض.`,
              evidence: {
                refillId: refill.id,
                cycleNumber: refill.cycleNumber,
                expectedRunOutOn: refill.expectedRunOutOn.toISOString().slice(0, 10),
                overdueDays: Math.abs(daysRemaining),
                prescriberDoctorName: refill.medication.prescriberDoctorName,
                prescriberDoctorPhone: refill.medication.prescriberDoctorPhone,
              },
            },
          });
        }
      }
    }
  }

  return {
    pharmaciesProcessed: pharmacies.length,
    refillsEvaluated,
    pharmacyAlertsCreated,
    patientRemindersSent,
    overdueFlagged,
  };
}
