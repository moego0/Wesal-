// First import on purpose: `@/server/db` resolves env() while it is being
// evaluated, and vitest does not load .env for us. ESM evaluates imports in
// source order, so this has to be a side-effect import and not a call.
import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemPrisma } from "@/server/db";
import { parseAndPersistInbound } from "@/server/messaging/inbound";
import { TEMPLATE_BUTTON_LABELS } from "@/server/messaging/menu";
import { MockProvider } from "@/server/messaging/providers/mock";
import { drainInbound } from "@/server/responses/processInbound";

/**
 * The hop between persisting a reply and acting on it.
 *
 * This file exists because that hop was missing. The webhook persists an
 * `InboundMessage` and returns 200 without enqueueing anything, and the
 * `drain-inbound` queue had a consumer but no producer — so nothing ever called
 * `processInboundMessage` in a running system. Every reply, including a STOP,
 * was stored and ignored.
 *
 * The existing tests could not see it. `messaging.provider.contract.test.ts`
 * asserts that a tap is persisted with `processingStatus: "RECEIVED"` and stops
 * there; `responses.semantics.test.ts` calls `applyResponse` directly. Both
 * sides of the missing hop were covered, and the hop itself was covered by
 * nothing. So this asserts the seam end to end: the same call the route makes,
 * then the same call the sweep makes, then the row the patient's answer was
 * supposed to produce.
 */

const RUN = randomUUID().slice(0, 8);

const CHANNEL_KEY = `drain-channel-${RUN}`;
const PATIENT_PHONE = "+201555000222";

let pharmacyId = "";
let channelId = "";
let patientId = "";
let medicationId = "";
let scheduleId = "";

const createdInboundIds: string[] = [];

beforeAll(async () => {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Drain (${RUN})` },
  });
  pharmacyId = pharmacy.id;

  // Inbound routing resolves the channel by `providerPhoneNumberId`, which for a
  // mock holds the channel key.
  const channel = await systemPrisma.messagingChannel.create({
    data: {
      pharmacyId,
      provider: "mock",
      providerPhoneNumberId: CHANNEL_KEY,
      displayPhoneE164: "+201000000000",
    },
  });
  channelId = channel.id;

  const patient = await systemPrisma.patient.create({
    data: { pharmacyId, fullName: `Drain Patient ${RUN}`, phoneE164: PATIENT_PHONE },
  });
  patientId = patient.id;

  const medication = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId,
      patientId,
      medicationNameText: "Drain Test Medicine",
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
  await systemPrisma.inboundMessage.deleteMany({ where: { id: { in: createdInboundIds } } });
  await systemPrisma.inboundMessage.deleteMany({ where: { fromPhoneE164: PATIENT_PHONE } });
  await systemPrisma.patientResponse.deleteMany({ where: { patientId } });
  await systemPrisma.reminderDispatch.deleteMany({ where: { pharmacyId } });
  await systemPrisma.reminderEvent.deleteMany({ where: { pharmacyId } });
  await systemPrisma.medicationSchedule.deleteMany({ where: { id: scheduleId } });
  await systemPrisma.medicationRecord.deleteMany({ where: { id: medicationId } });
  await systemPrisma.patient.deleteMany({ where: { id: patientId } });
  await systemPrisma.messagingChannel.deleteMany({ where: { id: channelId } });
  await systemPrisma.pharmacy.deleteMany({ where: { id: pharmacyId } });
  await systemPrisma.$disconnect();
});

function provider() {
  return new MockProvider({ secret: "drain-test-secret", channelKey: CHANNEL_KEY });
}

/**
 * A reminder that has actually gone out: the event the patient is answering,
 * plus the dispatch row that makes its wamid resolvable — which is the only
 * attribution channel a template tap has.
 */
async function sentReminder(mock: MockProvider) {
  const doseAtUtc = new Date();

  const event = await systemPrisma.reminderEvent.create({
    data: {
      pharmacyId,
      patientId,
      medicationId,
      scheduleId,
      scheduleRevisionSnapshot: 1,
      kind: "SCHEDULED_DOSE",
      doseAtUtc,
      doseLocalDate: new Date(doseAtUtc.toISOString().slice(0, 10) + "T00:00:00.000Z"),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(doseAtUtc.getTime() + 4 * 3_600_000),
      deliveryState: "DELIVERED",
      firstSentAtUtc: doseAtUtc,
    },
  });

  const sent = await mock.sendTemplate({
    to: PATIENT_PHONE,
    templateName: "wasal_dose_reminder_v1",
    languageCode: "ar",
    variables: { "1": "أحمد", "2": "دواء", "3": "08:00" },
    callbackData: `dispatch-${event.id}`,
    correlationId: event.id,
  });

  if (!sent.ok) throw new Error(`mock send failed: ${sent.errorCode}`);

  await systemPrisma.reminderDispatch.create({
    data: {
      id: `dispatch-${event.id}`,
      pharmacyId,
      reminderEventId: event.id,
      attemptNo: 1,
      provider: "mock",
      providerMessageId: sent.providerMessageId,
      toPhoneE164: PATIENT_PHONE,
      status: "DELIVERED",
      acceptedAtUtc: doseAtUtc,
      deliveredAtUtc: doseAtUtc,
      reconcileDeadlineUtc: new Date(doseAtUtc.getTime() + 120_000),
    },
  });

  return { event, wamid: sent.providerMessageId };
}

/** Persist a reply exactly as the webhook route does, and record the row. */
async function persist(mock: MockProvider, body: Buffer) {
  const result = await parseAndPersistInbound(mock, body);
  for (const { row } of result.rows) createdInboundIds.push(row.id);
  expect(result.rows).toHaveLength(1);
  return result.rows[0].row;
}

describe("inbound drain (live database)", () => {
  it("persists a template tap and leaves it unprocessed, then drains it into a response", async () => {
    const mock = provider();
    const { event, wamid } = await sentReminder(mock);

    const row = await persist(mock, mock.simulateTemplateReply(wamid, { button: "TAKEN" }));

    // The state the whole bug lived in: stored, recognised, and untouched.
    expect(row.processingStatus).toBe("RECEIVED");
    expect(row.processedAtUtc).toBeNull();
    expect(row.contextMessageId).toBe(wamid);

    // …and what the sweep now does with it.
    const { processed } = await drainInbound(50);
    expect(processed).toBeGreaterThanOrEqual(1);

    const responses = await systemPrisma.patientResponse.findMany({
      where: { reminderEventId: event.id },
    });
    expect(responses).toHaveLength(1);
    expect(responses[0].answer).toBe("TAKEN");
    expect(responses[0].appliedToAdherence).toBe(true);

    // The dose is scored, and the row is no longer pending — so a second sweep
    // is a no-op rather than a second response.
    const after = await systemPrisma.reminderEvent.findUniqueOrThrow({
      where: { id: event.id },
      select: { responseState: true },
    });
    expect(after.responseState).toBe("TAKEN");

    const drained = await systemPrisma.inboundMessage.findUniqueOrThrow({
      where: { id: row.id },
      select: { processedAtUtc: true, processingStatus: true },
    });
    expect(drained.processedAtUtc).not.toBeNull();
    expect(drained.processingStatus).not.toBe("RECEIVED");

    const replay = await drainInbound(50);
    expect(replay.processed).toBe(0);
  });

  it("acts on a STOP typed as free text", async () => {
    const mock = provider();

    const row = await persist(
      mock,
      mock.simulateTextReply({ from: PATIENT_PHONE, text: "اوقف الرسائل" }),
    );
    expect(row.processingStatus).toBe("RECEIVED");

    await drainInbound(50);

    // The consequence that makes this the highest-priority bug in the system: a
    // patient asking to be left alone was previously stored and then ignored,
    // and every later reminder would have been sent anyway.
    const patient = await systemPrisma.patient.findUniqueOrThrow({
      where: { id: patientId },
      select: { messagingOptOutAt: true },
    });
    expect(patient.messagingOptOutAt).not.toBeNull();
  });
});
