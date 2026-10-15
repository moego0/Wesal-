import { prisma } from "@/server/db";
import type { ScheduleStatus } from "@/generated/prisma/enums";

/**
 * Read models for the medication CRUD screens.
 *
 * Same contract as `queries/patients.ts`: every function takes an explicit
 * `pharmacyId` first, and the tenant guard in `@/server/db` rejects any query
 * that forgets it. A medication belonging to another pharmacy has to be
 * indistinguishable from one that does not exist, so the lookup here is a
 * `findFirst({ where: { id, pharmacyId } })` rather than a `findUnique` by id.
 */

export type MedicationDetail = NonNullable<Awaited<ReturnType<typeof getMedicationDetail>>>;

/**
 * One medication, its patient, and every schedule with the last few revision
 * rows attached.
 *
 * The revisions ride along because the edit screen shows them: a schedule change
 * is a clinical event, and a pharmacist about to move a dose time should be able
 * to see when it was last changed and of what kind that change was.
 */
export async function getMedicationDetail(pharmacyId: string, medicationId: string) {
  const medication = await prisma.medicationRecord.findFirst({
    where: { id: medicationId, pharmacyId },
    include: {
      patient: {
        select: {
          id: true,
          fullName: true,
          phoneE164: true,
          timeZone: true,
          preferredLocale: true,
        },
      },
      schedules: {
        orderBy: { createdAt: "desc" },
        include: {
          revisions: {
            orderBy: { revision: "desc" },
            take: 5,
            select: {
              id: true,
              revision: true,
              changeKind: true,
              changedByUserId: true,
              changedAtUtc: true,
              reason: true,
            },
          },
        },
      },
    },
  });

  if (!medication) return null;

  return medication;
}

/**
 * The patient a medication screen is being filled in for.
 *
 * Three columns, on purpose. The add-medication screen needs the patient's name
 * for its heading and their time zone for the schedule's default, and
 * `getPatientDetail` would answer those by reading the whole chart — every
 * medication, twenty cases and their interventions — on every load of a form
 * that shows one line of it.
 *
 * Scoped by `pharmacyId` in the predicate like every other read here: a patient
 * of another pharmacy has to be indistinguishable from one that does not exist.
 */
export async function getPatientForMedication(pharmacyId: string, patientId: string) {
  return prisma.patient.findFirst({
    where: { id: patientId, pharmacyId },
    select: { id: true, fullName: true, timeZone: true, preferredLocale: true },
  });
}

/**
 * The schedule a medication edit screen targets.
 *
 * A medication normally has exactly one, but the model permits more (a gap in a
 * regimen, or a switch from fixed times to an interval). The screen edits the
 * live one and says so; the others stay on the patient's file.
 *
 * Deterministic on purpose: the page picks with this helper and the form posts
 * the resulting `scheduleId` back, so the action never re-derives the choice and
 * cannot end up editing a schedule the pharmacist was not looking at.
 */
export function pickPrimarySchedule<T extends { status: ScheduleStatus }>(
  schedules: readonly T[],
): T | null {
  return schedules.find((s) => s.status === "ACTIVE") ?? schedules[0] ?? null;
}
