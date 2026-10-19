import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemPrisma } from "@/server/db";
import { claimDueReminder, sendReminder } from "@/server/scheduling/dispatch";
import type {
  InboundEvent,
  MessagingProvider,
  ProviderCapabilities,
  SendInteractiveRequest,
  SendResult,
  SendTemplateRequest,
  SendTextRequest,
} from "@/server/messaging/provider";

/**
 * What `sendReminder` actually asks Meta to send.
 *
 * The bug this file exists for: when the approved template was missing, the
 * dispatcher fell back to Meta's stock `hello_world` template. A real patient
 * then received "Hello World" instead of a medication reminder — a message that
 * looks like spam, says nothing about their dose, and spends the number's
 * quality rating. A failed send is the honest outcome; a silent substitution is
 * not.
 *
 * These tests drive `sendReminder` with a fake provider so they can assert on
 * the OUTGOING request, not just the resulting row. Nothing here reaches the
 * network.
 */

const RUN = randomUUID().slice(0, 8);

let pharmacyId: string;
let seq = 0;

beforeAll(async () => {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Dispatch send (${RUN})` },
  });
  pharmacyId = pharmacy.id;
});

afterAll(async () => {
  await systemPrisma.pharmacy.delete({ where: { id: pharmacyId } }).catch(() => {});
  await systemPrisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fake provider
// ─────────────────────────────────────────────────────────────────────────────

const CAPABILITIES: ProviderCapabilities = {
  supportsListMessages: true,
  maxReplyButtons: 3,
  maxListRows: 10,
  // False forces the template path, which is the path under test — otherwise
  // the plan depends on the patient's last inbound message.
  supportsFreeFormWithinSessionWindow: false,
  sessionWindowHours: 24,
  supportsBizOpaqueCallbackData: true,
  supportsTemplateButtonPayloads: false,
};

type Recorder = {
  templates: SendTemplateRequest[];
  interactives: SendInteractiveRequest[];
  texts: SendTextRequest[];
};

function fakeProvider(answer: () => SendResult) {
  const calls: Recorder = { templates: [], interactives: [], texts: [] };

  const provider: MessagingProvider = {
    name: "fake",
    capabilities: () => CAPABILITIES,
    sessionWindowOpen: () => false,
    async sendTemplate(req) {
      calls.templates.push(req);
      return answer();
    },
    async sendInteractive(req) {
      calls.interactives.push(req);
      return answer();
    },
    async sendText(req) {
      calls.texts.push(req);
      return answer();
    },
    verifyWebhookSignature: () => true,
    handleVerificationChallenge: () => null,
    parseWebhook: (): InboundEvent[] => [],
    async healthCheck() {
      return { healthy: true };
    },
  };

  return { provider, calls };
}

const ACCEPTED: SendResult = {
  ok: true,
  providerMessageId: `wamid.${RUN}.${randomUUID()}`,
  acceptedAtUtc: new Date(),
  raw: {},
};

function templateNotFound(): SendResult {
  return {
    ok: false,
    retryable: false,
    errorCode: "template_not_found",
    errorMessage: "Template name does not exist in the translation",
    raw: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A claimed (SENDING) event and its dispatch row, ready for `sendReminder`. */
async function makeClaimedDose() {
  const n = (seq += 1);

  const patient = await systemPrisma.patient.create({
    data: {
      pharmacyId,
      fullName: `Send Patient ${RUN}-${n}`,
      phoneE164: `+20108${String(n).padStart(6, "0")}`,
    },
  });

  const medication = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId,
      patientId: patient.id,
      medicationNameText: `Send Medicine ${n}`,
      startedOn: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  const schedule = await systemPrisma.medicationSchedule.create({
    data: {
      pharmacyId,
      patientId: patient.id,
      medicationId: medication.id,
      mode: "FIXED_TIMES_OF_DAY",
      timesOfDay: ["08:00"],
      daysOfWeek: [],
      timeZone: "Africa/Cairo",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      status: "ACTIVE",
      revision: 1,
    },
  });

  const doseAtUtc = new Date(Date.now() - 5 * 60_000);
  const event = await systemPrisma.reminderEvent.create({
    data: {
      pharmacyId,
      patientId: patient.id,
      medicationId: medication.id,
      scheduleId: schedule.id,
      scheduleRevisionSnapshot: schedule.revision,
      doseAtUtc,
      doseLocalDate: new Date(`${doseAtUtc.toISOString().slice(0, 10)}T00:00:00.000Z`),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(doseAtUtc.getTime() + 4 * 3_600_000),
      deliveryState: "SCHEDULED",
    },
  });

  const claim = await claimDueReminder(event.id);
  if (claim.status !== "claimed") throw new Error(`fixture claim failed: ${claim.reason}`);

  return { patient, event, dispatchId: claim.dispatchId };
}

async function readDispatch(id: string) {
  return systemPrisma.reminderDispatch.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      errorCode: true,
      errorRetryable: true,
      providerTemplateName: true,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("a missing template fails the send", () => {
  /*
   * The regression: one call, the approved template's name, and a FAILED row.
   * A second call here — to `hello_world` or anything else — is the bug coming
   * back, regardless of what the row says.
   */
  it("never substitutes hello_world when the template is not found", async () => {
    const { event, dispatchId } = await makeClaimedDose();
    const { provider, calls } = fakeProvider(templateNotFound);

    const outcome = await sendReminder(dispatchId, provider);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.retryable).toBe(false);
    expect(outcome.errorCode).toBe("template_not_found");

    expect(calls.templates).toHaveLength(1);
    expect(calls.templates[0].templateName).toBe("wasal_dose_reminder_v1");
    expect(calls.interactives).toHaveLength(0);
    expect(calls.texts).toHaveLength(0);

    // `hello_world` must not appear on ANY outgoing call, not merely not first.
    const everythingSent = [...calls.templates, ...calls.interactives, ...calls.texts];
    expect(everythingSent).toHaveLength(1);
    expect(JSON.stringify(everythingSent)).not.toContain("hello_world");

    const dispatch = await readDispatch(dispatchId);
    expect(dispatch.status).toBe("FAILED");
    expect(dispatch.errorCode).toBe("template_not_found");
    expect(dispatch.errorRetryable).toBe(false);

    const after = await systemPrisma.reminderEvent.findUniqueOrThrow({
      where: { id: event.id },
      select: { deliveryState: true, cancelReason: true },
    });
    // Failed at the provider, so FAILED — not EXPIRED, which means "too late to
    // send" and is excluded from adherence.
    expect(after.deliveryState).toBe("FAILED");
    expect(after.cancelReason).toBe("template_not_found");
  });
});

describe("the dispatch row records what was sent", () => {
  it("stores the approved template name and locale on a successful template send", async () => {
    const { patient, dispatchId } = await makeClaimedDose();
    const { provider, calls } = fakeProvider(() => ACCEPTED);

    const outcome = await sendReminder(dispatchId, provider);

    expect(outcome.status).toBe("sent");
    expect(calls.templates).toHaveLength(1);

    const dispatch = await readDispatch(dispatchId);
    expect(dispatch.status).toBe("SENT");
    expect(dispatch.providerTemplateName).toBe("wasal_dose_reminder_v1");

    // Language follows the patient: `ar` unless they chose English.
    const expectedLanguage = patient.preferredLocale === "EN" ? "en" : "ar";
    expect(calls.templates[0].languageCode).toBe(expectedLanguage);
  });
});
