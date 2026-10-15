import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemPrisma } from "@/server/db";
import { applyResponse } from "@/server/responses/applyResponse";
import { attributeInbound } from "@/server/responses/attribute";
import type { NormalizedInboundEvent } from "@/server/messaging/provider";

/**
 * What happens when a patient answers, especially when they answer twice.
 *
 * Two rules govern every row here, and both exist because the naive versions are
 * silently wrong rather than loudly broken:
 *
 *   FIRST-WINS FOR ADHERENCE, UNION FOR SAFETY.
 *   A patient who taps "taken" and then "I have a problem" has told us two
 *   different kinds of thing. The adherence record must keep the first answer —
 *   otherwise a later stray tap can rewrite whether a dose was taken — while the
 *   problem must still open a case. Neither may suppress the other. Getting this
 *   backwards is how a symptom report disappears or an accurate record is
 *   destroyed by a pocket dial.
 *
 *   SILENCE IS NOT A MISS, AND A LATE REPLY DOES NOT ERASE THE RECORD.
 *   A dose the settlement sweep closed as unanswered keeps that settlement even
 *   when the patient replies an hour later. Overwriting it is where wrong
 *   adherence numbers come from, because the history of "we heard nothing by
 *   the deadline" is itself evidence.
 *
 * Everything is asserted against a real database, because these are transactional
 * behaviours — a mocked Prisma would assert that the code calls the functions it
 * visibly calls and nothing more.
 */

const RUN = randomUUID().slice(0, 8);

let pharmacyId: string;
let patientId: string;
let medicationId: string;
let scheduleId: string;
let doseSeq = 0;

beforeAll(async () => {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Responses (${RUN})` },
  });
  pharmacyId = pharmacy.id;

  const patient = await systemPrisma.patient.create({
    data: { pharmacyId, fullName: `Response Patient ${RUN}`, phoneE164: "+201088800001" },
  });
  patientId = patient.id;

  const medication = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId,
      patientId,
      medicationNameText: "Response Test Medicine",
      startedOn: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  medicationId = medication.id;

  const schedule = await systemPrisma.medicationSchedule.create({
    data: {
      pharmacyId,
      patientId,
      medicationId,
      mode: "FIXED_TIMES_OF_DAY",
      timesOfDay: ["08:00"],
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      timeZone: "Africa/Cairo",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  scheduleId = schedule.id;
});

afterAll(async () => {
  await systemPrisma.pharmacy.delete({ where: { id: pharmacyId } }).catch(() => {});
  await systemPrisma.$disconnect();
});

/** A delivered dose awaiting an answer. */
async function makeDose(overrides: Record<string, unknown> = {}) {
  const doseAtUtc = new Date(Date.UTC(2026, 9, 1, 6, 0, 0) + (doseSeq += 1) * 3_600_000);

  return systemPrisma.reminderEvent.create({
    data: {
      pharmacyId,
      patientId,
      medicationId,
      scheduleId,
      scheduleRevisionSnapshot: 1,
      doseAtUtc,
      doseLocalDate: new Date(doseAtUtc.toISOString().slice(0, 10) + "T00:00:00.000Z"),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(doseAtUtc.getTime() + 4 * 3_600_000),
      deliveryState: "DELIVERED",
      ...overrides,
    },
  });
}

function answer(
  eventId: string | null,
  answerValue: "TAKEN" | "TAKEN_LATE" | "MISSED" | "PROBLEM" | "REMIND_LATER",
  overrides: Partial<Parameters<typeof applyResponse>[0]> = {},
) {
  return applyResponse({
    pharmacyId,
    patientId,
    reminderEventId: eventId,
    channel: "WHATSAPP_BUTTON",
    answer: answerValue,
    receivedAtUtc: new Date(),
    rawMessageId: `wamid.${RUN}.${randomUUID()}`,
    ...overrides,
  });
}

describe("first response wins for adherence", () => {
  it("keeps the first answer when the patient taps again", async () => {
    const dose = await makeDose();

    const first = await answer(dose.id, "TAKEN");
    expect(first.applied).toBe(true);
    expect(first.appliedToAdherence).toBe(true);

    const second = await answer(dose.id, "MISSED");
    expect(second.appliedToAdherence).toBe(false);

    const after = await systemPrisma.reminderEvent.findUniqueOrThrow({
      where: { id: dose.id },
      select: { responseState: true },
    });

    // The dose still reads as taken. A second tap — a mis-tap, a change of mind,
    // or a family member on a shared handset — must not rewrite the record the
    // adherence figures are built from.
    expect(after.responseState).toBe("TAKEN");
  });

  it("still stores the second answer, so nothing is hidden", async () => {
    const dose = await makeDose();
    await answer(dose.id, "TAKEN");
    await answer(dose.id, "MISSED");

    const responses = await systemPrisma.patientResponse.findMany({
      where: { reminderEventId: dose.id },
      orderBy: { receivedAtUtc: "asc" },
      select: { answer: true, appliedToAdherence: true },
    });

    // Dropping the second row would be the other way to make this "consistent",
    // and it would destroy the evidence that the patient said two different
    // things — which is exactly what a pharmacist needs to see.
    expect(responses).toHaveLength(2);
    expect(responses.map((r) => r.answer)).toEqual(["TAKEN", "MISSED"]);
    expect(responses[0].appliedToAdherence).toBe(true);
    expect(responses[1].appliedToAdherence).toBe(false);
  });
});

describe("union for safety", () => {
  it("keeps the dose scored as taken AND opens a case for the problem", async () => {
    const dose = await makeDose();

    await answer(dose.id, "TAKEN");
    const problem = await answer(dose.id, "PROBLEM", { freeText: "صداع شديد" });

    const after = await systemPrisma.reminderEvent.findUniqueOrThrow({
      where: { id: dose.id },
      select: { responseState: true },
    });

    // Both halves, simultaneously. This is the assertion that fails if someone
    // "simplifies" the response handler into a single last-write-wins field: the
    // adherence figure would survive but the symptom report would vanish, or the
    // case would open and the dose would be marked unanswered.
    expect(after.responseState).toBe("TAKEN");
    expect(problem.caseId).not.toBeNull();
  });

  it("opens a case when the FIRST thing reported is a problem", async () => {
    const dose = await makeDose();
    const result = await answer(dose.id, "PROBLEM", { freeText: "الدواء مش موجود" });

    expect(result.caseId).not.toBeNull();
  });
});

describe("Meta's webhook retries do not create phantom answers", () => {
  it("returns the existing response instead of storing a second one", async () => {
    const dose = await makeDose();
    const rawMessageId = `wamid.${RUN}.retry-me`;

    const first = await answer(dose.id, "TAKEN", { rawMessageId });
    const retry = await answer(dose.id, "TAKEN", { rawMessageId });

    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(retry.responseId).toBe(first.responseId);

    const count = await systemPrisma.patientResponse.count({
      where: { reminderEventId: dose.id },
    });

    // One row. A duplicate here would show the pharmacist a patient who answered
    // twice, and would double-count in any query that forgets to dedupe.
    expect(count).toBe(1);
  });
});

describe("a late reply does not erase the settlement", () => {
  it("keeps settledAtUtc and flags the reopen", async () => {
    const settledAt = new Date();
    const dose = await makeDose({ responseState: "NONE", settledAtUtc: settledAt });

    const result = await answer(dose.id, "TAKEN");

    expect(result.lateReopen).toBe(true);

    const after = await systemPrisma.reminderEvent.findUniqueOrThrow({
      where: { id: dose.id },
      select: { responseState: true, settledAtUtc: true },
    });

    // The settlement SURVIVES. "We heard nothing by the deadline, then they told
    // us an hour later" is two facts, and the fact that the answer came late is
    // itself clinically meaningful — a patient who consistently answers after
    // the window is a different conversation from one who answers inside it.
    expect(after.settledAtUtc).not.toBeNull();
    expect(after.responseState).toBe("TAKEN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/** Build the normalised shape the webhook layer produces. */
function inbound(overrides: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    providerMessageId: `wamid.${RUN}.${randomUUID()}`,
    providerTimestamp: new Date(),
    fromPhoneE164: "+201088800001",
    toPhoneE164: "+201000000000",
    kind: "BUTTON",
    buttonPayload: null,
    rowId: null,
    title: null,
    text: null,
    mediaType: null,
    contextMessageId: null,
    raw: {},
    ...overrides,
  } as NormalizedInboundEvent;
}

describe("attribution", () => {
  it("resolves a template tap through context.id with NO button payload", async () => {
    const dose = await makeDose();

    // A template button's payload is fixed at approval time and cannot carry a
    // per-message event id, so this is the ONLY route a template tap can take.
    // The mock provider must exercise it, or the suite passes and production
    // silently attributes nothing.
    await systemPrisma.reminderDispatch.create({
      data: {
        id: randomUUID(),
        pharmacyId,
        reminderEventId: dose.id,
        attemptNo: 1,
        provider: "mock",
        providerMessageId: `wamid.${RUN}.outbound`,
        toPhoneE164: "+201088800001",
        status: "DELIVERED",
        reconcileDeadlineUtc: new Date(Date.now() + 300_000),
      },
    });

    const attribution = await attributeInbound(
      inbound({ buttonPayload: null, contextMessageId: `wamid.${RUN}.outbound`, title: "خدته" }),
      null,
    );

    expect(attribution.kind).toBe("EVENT");
    if (attribution.kind !== "EVENT") throw new Error("unreachable");
    expect(attribution.reminderEventId).toBe(dose.id);
    expect(attribution.method).toBe("CONTEXT_ID");
  });

  it("refuses to guess when a handset is shared", async () => {
    const sharedPhone = "+201088800099";

    const [a, b] = await Promise.all([
      systemPrisma.patient.create({
        data: { pharmacyId, fullName: `Shared Handset A ${RUN}`, phoneE164: sharedPhone },
      }),
      systemPrisma.patient.create({
        data: { pharmacyId, fullName: `Shared Handset B ${RUN}`, phoneE164: sharedPhone },
      }),
    ]);

    const attribution = await attributeInbound(
      inbound({ fromPhoneE164: sharedPhone }),
      pharmacyId,
    );

    // Two patients, one phone. Guessing the most recently reminded one would be
    // right often enough to look fine and wrong often enough to file one
    // patient's answer against another — and the failure is silent, because the
    // record looks perfectly ordinary.
    expect(attribution.kind).toBe("AMBIGUOUS");
    if (attribution.kind !== "AMBIGUOUS") throw new Error("unreachable");

    expect(attribution.candidatePatientIds.sort()).toEqual([a.id, b.id].sort());
  });

  it("resolves unambiguously when only one patient holds the number", async () => {
    const attribution = await attributeInbound(
      inbound({ fromPhoneE164: "+201088800001" }),
      pharmacyId,
    );

    expect(attribution.kind).toBe("PATIENT");
    if (attribution.kind !== "PATIENT") throw new Error("unreachable");
    expect(attribution.patientId).toBe(patientId);
  });

  it("returns UNKNOWN rather than a wrong patient for a number we do not hold", async () => {
    const attribution = await attributeInbound(
      inbound({ fromPhoneE164: "+201099999999" }),
      pharmacyId,
    );

    expect(attribution.kind).toBe("UNKNOWN");
  });
});
