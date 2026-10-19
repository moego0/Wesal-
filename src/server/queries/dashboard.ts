import { DateTime } from "luxon";
import { prisma } from "@/server/db";
import type { DeliveryState, RefillStatus, Severity } from "@/generated/prisma/enums";

/**
 * The dashboard's numbers.
 *
 * "Today" is the pharmacy's local day, not the server's. A dose at 23:30 in Cairo
 * belongs to today for the pharmacist looking at it, and computing the boundary
 * from the server clock would move it to tomorrow for anyone reading the panel
 * after 22:00 UTC — which is most of the evening shift. `doseLocalDate` is
 * already stored as a local calendar date at materialization, so the comparison
 * is exact rather than reconstructed.
 */

/** Statuses that mean a case still needs a human. */
const LIVE_CASE_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING_PATIENT"] as const;

/** Statuses that mean an alert is still asserting a current problem. */
const LIVE_ALERT_STATUSES = ["OPEN", "ACKNOWLEDGED"] as const;

/** Doses we never delivered — our infrastructure, not the patient's behaviour. */
const UNDELIVERED: DeliveryState[] = ["EXPIRED", "FAILED", "CANCELLED", "SUPERSEDED", "SKIPPED"];

export type DashboardSummary = {
  activePatients: number;
  openCases: number;
  openAlerts: number;
  /** Alerts currently asserting a problem, by severity. */
  alertsBySeverity: Record<Severity, number>;
  today: {
    total: number;
    answered: number;
    awaiting: number;
  };
  /** Delivery outcomes over the window, for the infrastructure-health strip. */
  delivery: {
    windowDays: number;
    attempted: number;
    delivered: number;
    failed: number;
    expired: number;
    noReply: number;
  };
};

export async function getDashboardSummary(
  pharmacyId: string,
  timeZone: string,
  windowDays = 7,
): Promise<DashboardSummary> {
  // `toISODate()` returns null only for an invalid DateTime, which would mean the
  // stored zone is not a real IANA name. Falling back to UTC keeps the panel
  // rendering rather than throwing on a bad settings value.
  const localToday = DateTime.now().setZone(timeZone);
  const todayIso = (localToday.isValid ? localToday : DateTime.utc()).toISODate() ?? "1970-01-01";

  // `doseLocalDate` is a `@db.Date`, so the comparison value must be a date at
  // UTC midnight — passing a zoned DateTime here is off by the zone's offset.
  const todayDate = new Date(`${todayIso}T00:00:00.000Z`);
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const [
    activePatients,
    openCases,
    alertsBySeverityRows,
    todayTotal,
    todayAnswered,
    deliveryRows,
  ] = await Promise.all([
    prisma.patient.count({ where: { pharmacyId, status: "ACTIVE" } }),
    prisma.followUpCase.count({
      where: { pharmacyId, status: { in: [...LIVE_CASE_STATUSES] } },
    }),
    prisma.alert.groupBy({
      by: ["severity"],
      where: { pharmacyId, status: { in: [...LIVE_ALERT_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.reminderEvent.count({ where: { pharmacyId, doseLocalDate: todayDate } }),
    prisma.reminderEvent.count({
      where: { pharmacyId, doseLocalDate: todayDate, responseState: { not: "NONE" } },
    }),
    prisma.reminderEvent.groupBy({
      by: ["deliveryState", "responseState"],
      where: { pharmacyId, doseAtUtc: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const alertsBySeverity: Record<Severity, number> = {
    LOW: 0,
    NORMAL: 0,
    HIGH: 0,
    URGENT: 0,
  };
  let openAlerts = 0;
  for (const row of alertsBySeverityRows) {
    alertsBySeverity[row.severity] = row._count._all;
    openAlerts += row._count._all;
  }

  const delivery = {
    windowDays,
    attempted: 0,
    delivered: 0,
    failed: 0,
    expired: 0,
    noReply: 0,
  };

  for (const row of deliveryRows) {
    const count = row._count._all;
    delivery.attempted += count;

    if (row.deliveryState === "FAILED") delivery.failed += count;
    if (row.deliveryState === "EXPIRED") delivery.expired += count;

    /*
     * "Delivered" counts messages the provider accepted AND that were not one of
     * the never-sent states. It is deliberately NOT `deliveryState === "DELIVERED"`:
     * a message that was sent and then answered has usually moved on from
     * `DELIVERED`, and `READ` is strictly better news, not worse.
     */
    if (!UNDELIVERED.includes(row.deliveryState) && row.deliveryState !== "SCHEDULED") {
      delivery.delivered += count;
    }

    /*
     * Silence, counted separately from failure and never merged into it.
     * `NONE` here means the patient did not answer a message we did send — it is
     * not our outage, and folding the two together is how an infrastructure
     * problem gets reported as patient non-adherence.
     */
    if (row.responseState === "NONE" && !UNDELIVERED.includes(row.deliveryState)) {
      delivery.noReply += count;
    }
  }

  return {
    activePatients,
    openCases,
    openAlerts,
    alertsBySeverity,
    today: {
      total: todayTotal,
      answered: todayAnswered,
      awaiting: todayTotal - todayAnswered,
    },
    delivery,
  };
}

export type UpcomingRefillItem = {
  id: string;
  cycleNumber: number;
  status: RefillStatus;
  expectedRunOutOn: Date;
  refillDueOn: Date | null;
  daysRemaining: number;
  packagesNeeded: number;
  inventoryAvailable: boolean | null;
  isUnconfirmedOverdue: boolean;
  notes: string | null;
  patient: {
    id: string;
    fullName: string;
    phoneE164: string;
  };
  medication: {
    id: string;
    name: string;
    strength: string | null;
    unitsPerPackage: number | null;
    prescriberDoctorName: string | null;
    prescriberDoctorPhone: string | null;
  };
};

export async function getUpcomingRefills(
  pharmacyId: string,
  timeZone: string,
  daysAhead = 7,
): Promise<UpcomingRefillItem[]> {
  const localToday = DateTime.now().setZone(timeZone);
  const todayIso = (localToday.isValid ? localToday : DateTime.utc()).toISODate() ?? "1970-01-01";
  const todayDate = new Date(`${todayIso}T00:00:00.000Z`);

  const cutoff = (localToday.isValid ? localToday : DateTime.utc()).plus({ days: daysAhead });
  const cutoffIso = cutoff.toISODate() ?? "2099-12-31";
  const cutoffDate = new Date(`${cutoffIso}T23:59:59.999Z`);

  const refills = await prisma.refillRecord.findMany({
    where: {
      pharmacyId,
      status: { in: ["PENDING", "ESTIMATED", "REQUESTED", "SCHEDULED", "STOCK_ORDERED", "READY_FOR_COLLECTION"] },
      expectedRunOutOn: { lte: cutoffDate },
      medication: { status: "ACTIVE" },
      patient: { status: "ACTIVE" },
    },
    orderBy: [{ expectedRunOutOn: "asc" }, { cycleNumber: "asc" }],
    take: 20,
    select: {
      id: true,
      cycleNumber: true,
      status: true,
      expectedRunOutOn: true,
      refillDueOn: true,
      packagesNeeded: true,
      inventoryAvailable: true,
      isUnconfirmedOverdue: true,
      notes: true,
      patient: {
        select: {
          id: true,
          fullName: true,
          phoneE164: true,
        },
      },
      medication: {
        select: {
          id: true,
          medicationNameText: true,
          strengthText: true,
          unitsPerPackage: true,
          prescriberDoctorName: true,
          prescriberDoctorPhone: true,
        },
      },
    },
  });

  return refills.map((r) => {
    const runOut = r.expectedRunOutOn ?? todayDate;
    const diffDays = Math.round((runOut.getTime() - todayDate.getTime()) / 86_400_000);
    return {
      id: r.id,
      cycleNumber: r.cycleNumber,
      status: r.status,
      expectedRunOutOn: runOut,
      refillDueOn: r.refillDueOn,
      daysRemaining: diffDays,
      packagesNeeded: r.packagesNeeded,
      inventoryAvailable: r.inventoryAvailable,
      isUnconfirmedOverdue: r.isUnconfirmedOverdue || diffDays < 0,
      notes: r.notes,
      patient: r.patient,
      medication: {
        id: r.medication.id,
        name: r.medication.medicationNameText,
        strength: r.medication.strengthText,
        unitsPerPackage: r.medication.unitsPerPackage,
        prescriberDoctorName: r.medication.prescriberDoctorName,
        prescriberDoctorPhone: r.medication.prescriberDoctorPhone,
      },
    };
  });
}

