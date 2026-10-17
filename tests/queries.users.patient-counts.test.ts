import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemPrisma } from "@/server/db";
import { countPatientsByCreator } from "@/server/queries/admin";

/**
 * Per-user patient counts for the users screen, against the real database.
 *
 * The function under test uses the GUARDED Prisma client, so these assertions
 * also cover the tenant-guard contract: the call only succeeds because
 * `where.pharmacyId` is top-level, and the two pharmacies below prove the
 * counts never leak across that boundary.
 *
 * Fixtures are written with `systemPrisma` so the guard is not involved in
 * building them; the null-creator patients exist because `createdByUserId` is
 * nullable and must be reported, not dropped.
 */

const RUN = randomUUID().slice(0, 8);

const userIds: string[] = [];
const pharmacyIds: string[] = [];

async function makePharmacy(label: string): Promise<string> {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Count Test ${label} (${RUN})`, timeZone: "Africa/Cairo" },
  });
  pharmacyIds.push(pharmacy.id);
  return pharmacy.id;
}

async function makeUser(label: string): Promise<string> {
  const user = await systemPrisma.user.create({
    data: {
      email: `count-${label}-${RUN}@wasal.test`,
      fullName: `Count Test ${label} (${RUN})`,
      status: "ACTIVE",
    },
  });
  userIds.push(user.id);
  return user.id;
}

let patientSeq = 0;

async function makePatient(pharmacyId: string, createdByUserId: string | null) {
  patientSeq += 1;
  return systemPrisma.patient.create({
    data: {
      pharmacyId,
      fullName: `Count Test Patient ${patientSeq} (${RUN})`,
      phoneE164: "+201000000000",
      createdByUserId,
    },
  });
}

let pharmacyA: string;
let pharmacyB: string;
let pharmacyC: string;
let aCreator1: string;
let aCreator2: string;
let aIdle: string;
let bCreator: string;
let shared: string;

beforeAll(async () => {
  [pharmacyA, pharmacyB, pharmacyC] = await Promise.all([
    makePharmacy("a"),
    makePharmacy("b"),
    makePharmacy("c-empty"),
  ]);

  [aCreator1, aCreator2, aIdle, bCreator, shared] = await Promise.all([
    makeUser("a-creator-1"),
    makeUser("a-creator-2"),
    makeUser("a-idle"),
    makeUser("b-creator"),
    makeUser("shared"),
  ]);

  await Promise.all([
    // Pharmacy A: 2 + 1 + 1 attributed, 2 with no recorded creator.
    makePatient(pharmacyA, aCreator1),
    makePatient(pharmacyA, aCreator1),
    makePatient(pharmacyA, aCreator2),
    makePatient(pharmacyA, shared),
    makePatient(pharmacyA, null),
    makePatient(pharmacyA, null),

    // Pharmacy B: the same `shared` user gets a DIFFERENT count here, which is
    // what proves the grouping is pharmacy-scoped rather than global.
    makePatient(pharmacyB, bCreator),
    makePatient(pharmacyB, bCreator),
    makePatient(pharmacyB, bCreator),
    makePatient(pharmacyB, shared),
    makePatient(pharmacyB, shared),
    makePatient(pharmacyB, null),
  ]);
});

afterAll(async () => {
  if (userIds.length > 0) {
    await systemPrisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  if (pharmacyIds.length > 0) {
    // Patients cascade from Pharmacy; `createdByUserId` is a loose scalar with
    // no foreign key, so user deletion has no bearing on it.
    await systemPrisma.pharmacy.deleteMany({ where: { id: { in: pharmacyIds } } });
  }
  await systemPrisma.$disconnect();
});

describe("countPatientsByCreator", () => {
  it("counts each creator's patients in one pharmacy and splits null creators out", async () => {
    const result = await countPatientsByCreator(pharmacyA);

    expect(result.byUserId.get(aCreator1)).toBe(2);
    expect(result.byUserId.get(aCreator2)).toBe(1);
    expect(result.byUserId.get(shared)).toBe(1);
    // A user with no patients is absent, not present with zero. The page maps
    // absence to 0 with `?? 0`.
    expect(result.byUserId.has(aIdle)).toBe(false);
    expect(result.byUserId.size).toBe(3);
    expect(result.unassigned).toBe(2);
  });

  it("scopes counts to the requested pharmacy, even for a user in both", async () => {
    const result = await countPatientsByCreator(pharmacyB);

    expect(result.byUserId.get(bCreator)).toBe(3);
    expect(result.byUserId.get(shared)).toBe(2);
    expect(result.byUserId.has(aCreator1)).toBe(false);
    expect(result.byUserId.has(aIdle)).toBe(false);
    expect([...result.byUserId.keys()].sort()).toEqual([bCreator, shared].sort());
    expect(result.unassigned).toBe(1);
  });

  it("returns empty counts for a pharmacy with no patients", async () => {
    const result = await countPatientsByCreator(pharmacyC);

    expect(result.byUserId.size).toBe(0);
    expect(result.unassigned).toBe(0);
  });
});
