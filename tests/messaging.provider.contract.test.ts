// First import on purpose: `@/server/db` resolves env() while it is being
// evaluated, and vitest does not load .env for us. ESM evaluates imports in
// source order, so this has to be a side-effect import and not a call.
import "dotenv/config";

import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { systemPrisma } from "@/server/db";
import { computePatientSessionWindow, parseAndPersistInbound } from "@/server/messaging/inbound";
import { reminderButtons, TEMPLATE_BUTTON_LABELS } from "@/server/messaging/menu";
import {
  PROVIDER_ERROR,
  normalizeInboundEvents,
  type InboundEvent,
  type MessagingProvider,
  type SendResult,
} from "@/server/messaging/provider";
import { MockProvider, type MockProviderOptions } from "@/server/messaging/providers/mock";
import { WhatsAppCloudProvider, type MetaErrorBody } from "@/server/messaging/providers/whatsapp-cloud";

/**
 * The provider contract.
 *
 * One suite, run against both providers. The mock is only worth having if it
 * answers the same questions the same way — and the parts that legitimately
 * differ are exactly the parts worth asserting: the wire format, and whether a
 * template button carries anything besides the wamid of the message it was
 * tapped on.
 *
 * The template case is the reason this file exists. A mock that handed back an
 * `evt:<id>` payload on a template tap would make every attribution test pass
 * while production, where the payload is fixed at approval time, attributes
 * every reply to the wrong dose.
 */

const MOCK_SECRET = "contract-test-mock-secret";
const CLOUD_SECRET = "contract-test-app-secret";
const VERIFY_TOKEN = "contract-test-verify-token";
const PHONE_NUMBER_ID = "999888777";
const PATIENT_PHONE = "+201234567890";
const DISPLAY_PHONE = "+201000000000";

type ButtonReply = Extract<InboundEvent, { kind: "button_reply" }>;
type StatusValue = "sent" | "delivered" | "read" | "failed";

function ok(result: SendResult): Extract<SendResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected a successful send, got ${result.errorCode}: ${result.errorMessage}`);
  }
  return result;
}

function buttonReply(event: InboundEvent | undefined): ButtonReply {
  if (!event || event.kind !== "button_reply") {
    throw new Error(`expected a button_reply, got ${JSON.stringify(event)}`);
  }
  return event;
}

/** A Cloud API envelope: the shape Meta actually posts, quirks included. */
function cloudEnvelope(value: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: DISPLAY_PHONE.replace("+", ""),
                  phone_number_id: PHONE_NUMBER_ID,
                },
                ...value,
              },
            },
          ],
        },
      ],
    }),
    "utf8",
  );
}

type Harness = {
  name: string;
  /** The secret this provider verifies signatures (and the handshake) with. */
  verifyToken: string;
  sign(rawBody: Buffer): string;
  newProvider(): MessagingProvider;
  /** Send a free-form interactive message with three reply buttons. */
  sendInteractive(p: MessagingProvider): Promise<string>;
  /** Send a list message. */
  sendList(p: MessagingProvider): Promise<string>;
  /** Send a template. */
  sendTemplate(p: MessagingProvider): Promise<string>;
  /** A tap on an INTERACTIVE button: the id we chose at send time. */
  tapInteractiveButton(id: string): Buffer;
  tapListRow(id: string): Buffer;
  /** A tap on a TEMPLATE button: context.id plus a label, and nothing else. */
  tapTemplateButton(id: string): Buffer;
  textBody(): Buffer;
  mediaBody(): Buffer;
  statusBody(id: string, status: StatusValue): Buffer;
};

/**
 * The mock's inbound simulation is instance-based, so the send helpers and the
 * body builders have to agree on which instance they are talking about.
 */
let CURRENT_MOCK: MockProvider;

function mockInstance(options: Partial<MockProviderOptions> = {}): MockProvider {
  const provider = new MockProvider({ secret: MOCK_SECRET, channelKey: PHONE_NUMBER_ID, ...options });
  CURRENT_MOCK = provider;
  return provider;
}

const MOCK_HARNESS: Harness = {
  name: "MockProvider",
  verifyToken: MOCK_SECRET, // with no explicit verify token, the HMAC key doubles as one
  sign: (rawBody) => `sha256=${createHmac("sha256", MOCK_SECRET).update(rawBody).digest("hex")}`,
  newProvider: () => mockInstance(),
  async sendInteractive() {
    return ok(
      await CURRENT_MOCK.sendInteractive({
        to: PATIENT_PHONE,
        bodyText: "خدت الدواء؟",
        buttons: reminderButtons("clxevent001"),
        callbackData: "dispatch-1",
        correlationId: "correlation-1",
      }),
    ).providerMessageId;
  },
  async sendList() {
    return ok(
      await CURRENT_MOCK.sendInteractive({
        to: PATIENT_PHONE,
        bodyText: "الجرعة دي كانت إمتى؟",
        list: {
          buttonText: "اختار",
          rows: [
            { id: "evt:clxevent001:TAKEN_LATE", title: "متأخر شوية" },
            { id: "evt:clxevent001:MISSED", title: "فوّتت الجرعة" },
          ],
        },
        callbackData: "dispatch-1",
        correlationId: "correlation-1",
      }),
    ).providerMessageId;
  },
  async sendTemplate() {
    return ok(
      await CURRENT_MOCK.sendTemplate({
        to: PATIENT_PHONE,
        templateName: "dose_reminder_ar",
        languageCode: "ar",
        variables: { "1": "أحمد", "2": "الميتفورمين", "3": "٨ صباحاً" },
        callbackData: "dispatch-2",
        correlationId: "correlation-2",
      }),
    ).providerMessageId;
  },
  tapInteractiveButton: (id) => CURRENT_MOCK.simulateButtonReply(id),
  tapListRow: (id) => CURRENT_MOCK.simulateListReply(id),
  tapTemplateButton: (id) => CURRENT_MOCK.simulateTemplateReply(id, { button: "TAKEN" }),
  textBody: () => CURRENT_MOCK.simulateTextReply({ from: PATIENT_PHONE, text: "خدته متأخر" }),
  mediaBody: () => CURRENT_MOCK.simulateMedia({ from: PATIENT_PHONE }),
  statusBody: (id, status) =>
    CURRENT_MOCK.simulateStatusCallback(
      id,
      status,
      status === "failed" ? { errorCode: "131026", errorTitle: "Message undeliverable" } : {},
    ),
};

const CLOUD_HARNESS: Harness = {
  name: "WhatsAppCloudProvider",
  verifyToken: VERIFY_TOKEN,
  sign: (rawBody) => `sha256=${createHmac("sha256", CLOUD_SECRET).update(rawBody).digest("hex")}`,
  newProvider: () =>
    cloudProvider(
      async () => new Response(JSON.stringify({ messages: [{ id: "wamid.cloud.out" }] }), { status: 200 }),
    ),
  async sendInteractive() {
    return "wamid.cloud.interactive";
  },
  async sendList() {
    return "wamid.cloud.list";
  },
  async sendTemplate() {
    return "wamid.cloud.template";
  },
  tapInteractiveButton: (id) =>
    cloudEnvelope({
      messages: [
        {
          id: "wamid.cloud.in.1",
          from: PATIENT_PHONE.replace("+", ""),
          timestamp: "1773417600",
          type: "interactive",
          context: { id },
          interactive: { type: "button_reply", button_reply: { id: "evt:clxevent001:TAKEN", title: "خدته ✅" } },
        },
      ],
    }),
  tapListRow: (id) =>
    cloudEnvelope({
      messages: [
        {
          id: "wamid.cloud.in.2",
          from: PATIENT_PHONE.replace("+", ""),
          timestamp: "1773417600",
          type: "interactive",
          context: { id },
          interactive: {
            type: "list_reply",
            list_reply: { id: "evt:clxevent001:TAKEN_LATE", title: "متأخر شوية" },
          },
        },
      ],
    }),
  tapTemplateButton: (id) =>
    cloudEnvelope({
      messages: [
        {
          id: "wamid.cloud.in.3",
          from: PATIENT_PHONE.replace("+", ""),
          timestamp: "1773417600",
          // A template tap: `type: "button"`, the label, and a payload that is
          // empty because the template's payload was fixed at approval time.
          type: "button",
          context: { id },
          button: { text: TEMPLATE_BUTTON_LABELS.TAKEN, payload: "" },
        },
      ],
    }),
  textBody: () =>
    cloudEnvelope({
      messages: [
        {
          id: "wamid.cloud.in.4",
          from: PATIENT_PHONE.replace("+", ""),
          timestamp: "1773417600",
          type: "text",
          text: { body: "خدته متأخر" },
        },
      ],
    }),
  mediaBody: () =>
    cloudEnvelope({
      messages: [
        {
          id: "wamid.cloud.in.5",
          from: PATIENT_PHONE.replace("+", ""),
          timestamp: "1773417600",
          type: "image",
          image: { id: "media-id", mime_type: "image/jpeg" },
        },
      ],
    }),
  statusBody: (id, status) =>
    cloudEnvelope({
      statuses: [
        {
          id,
          status,
          timestamp: "1773417600",
          recipient_id: PATIENT_PHONE.replace("+", ""),
          biz_opaque_callback_data: "dispatch-2",
          ...(status === "failed"
            ? { errors: [{ code: 131026, title: "Message undeliverable", message: "Receiver incapable" }] }
            : {}),
        },
      ],
    }),
};

function cloudProvider(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new WhatsAppCloudProvider({
    accessToken: "test-token",
    phoneNumberId: PHONE_NUMBER_ID,
    appSecret: CLOUD_SECRET,
    verifyToken: VERIFY_TOKEN,
    apiVersion: "v21.0",
    fetchImpl,
    ...overrides,
  });
}

describe.each([MOCK_HARNESS, CLOUD_HARNESS])("provider contract: $name", (harness) => {
  function make(): MessagingProvider {
    return harness.newProvider();
  }

  it("implements the whole surface", () => {
    const provider = make();

    for (const method of [
      "sendTemplate",
      "sendInteractive",
      "sendText",
      "verifyWebhookSignature",
      "handleVerificationChallenge",
      "parseWebhook",
      "capabilities",
      "sessionWindowOpen",
      "healthCheck",
    ] as const) {
      expect(typeof provider[method], method).toBe("function");
    }

    expect(provider.name.length).toBeGreaterThan(0);
  });

  it("declares capabilities that describe the production path", () => {
    const caps = make().capabilities();

    expect(caps.supportsListMessages).toBe(true);
    expect(caps.maxReplyButtons).toBe(3);
    expect(caps.maxListRows).toBe(10);
    expect(caps.sessionWindowHours).toBe(24);
    expect(caps.supportsBizOpaqueCallbackData).toBe(true);
    // The whole point: a template button payload cannot carry an event id.
    expect(caps.supportsTemplateButtonPayloads).toBe(false);
  });

  it("closes the 24h session window exactly at the boundary", () => {
    const provider = make();
    const now = new Date("2026-03-10T12:00:00Z");

    expect(provider.sessionWindowOpen(PATIENT_PHONE, null, now)).toBe(false);
    expect(provider.sessionWindowOpen(PATIENT_PHONE, new Date(now.getTime() - 23 * 3_600_000), now)).toBe(true);
    expect(provider.sessionWindowOpen(PATIENT_PHONE, new Date(now.getTime() - 24 * 3_600_000), now)).toBe(false);
    expect(provider.sessionWindowOpen(PATIENT_PHONE, new Date(now.getTime() - 25 * 3_600_000), now)).toBe(false);
    // Clock skew against Meta must not lock a patient out mid-conversation.
    expect(provider.sessionWindowOpen(PATIENT_PHONE, new Date(now.getTime() + 60_000), now)).toBe(true);
  });

  it("answers the verification handshake with the challenge", () => {
    const provider = make();

    expect(
      provider.handleVerificationChallenge({
        "hub.mode": "subscribe",
        "hub.verify_token": harness.verifyToken,
        "hub.challenge": "1158201444",
      }),
    ).toEqual({ status: 200, body: "1158201444" });

    expect(
      provider.handleVerificationChallenge({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong",
        "hub.challenge": "x",
      }),
    ).toMatchObject({ status: 403 });

    // Not a handshake at all: the route answers 400, not 403.
    expect(provider.handleVerificationChallenge({ "hub.mode": "unsubscribe" })).toBeNull();
  });

  it("normalizes a button_reply from an interactive message", async () => {
    const provider = make();
    const sent = await harness.sendInteractive(provider);

    const reply = buttonReply(provider.parseWebhook(harness.tapInteractiveButton(sent))[0]);

    expect(reply.providerMessageId).toBeTruthy();
    expect(reply.from).toBe(PATIENT_PHONE); // Meta sends bare digits; we store E.164
    expect(reply.to).toBe(PHONE_NUMBER_ID); // the receiving channel key
    expect(reply.atUtc).toBeInstanceOf(Date);
    expect(Number.isNaN(reply.atUtc.getTime())).toBe(false);
    expect(reply.contextMessageId).toBe(sent);
    expect(reply.payload).toBe("evt:clxevent001:TAKEN");
    expect(reply.title).toBe(TEMPLATE_BUTTON_LABELS.TAKEN);
  });

  it("normalizes a list_reply", async () => {
    const provider = make();
    const sent = await harness.sendList(provider);

    const [event] = provider.parseWebhook(harness.tapListRow(sent));
    if (event?.kind !== "list_reply") throw new Error(`expected a list_reply, got ${JSON.stringify(event)}`);

    expect(event.rowId).toBe("evt:clxevent001:TAKEN_LATE");
    expect(event.title).toBe("متأخر شوية");
    expect(event.contextMessageId).toBe(sent);

    const { messages } = normalizeInboundEvents([event]);
    expect(messages[0].kind).toBe("LIST_REPLY");
    expect(messages[0].rowId).toBe("evt:clxevent001:TAKEN_LATE");
  });

  it("normalizes a text message", () => {
    const [event] = make().parseWebhook(harness.textBody());
    if (event?.kind !== "text") throw new Error(`expected text, got ${JSON.stringify(event)}`);

    expect(event.text).toBe("خدته متأخر");
    expect(event.from).toBe(PATIENT_PHONE);
  });

  it("normalizes media into the unsupported member", () => {
    const [event] = make().parseWebhook(harness.mediaBody());
    if (event?.kind !== "unsupported") throw new Error(`expected unsupported, got ${JSON.stringify(event)}`);

    expect(event.mediaType).toBe("image");
    expect(normalizeInboundEvents([event]).messages[0].kind).toBe("MEDIA");
  });

  it("normalizes a status callback, error detail included", async () => {
    const provider = make();
    const sent = await harness.sendTemplate(provider);

    const [delivered] = provider.parseWebhook(harness.statusBody(sent, "delivered"));
    if (delivered?.kind !== "status") throw new Error(`expected status, got ${JSON.stringify(delivered)}`);

    expect(delivered.providerMessageId).toBe(sent);
    expect(delivered.status).toBe("delivered");
    expect(delivered.atUtc).toBeInstanceOf(Date);
    // How a receipt finds the dispatch it belongs to.
    expect(delivered.callbackData).toBe("dispatch-2");
    expect(normalizeInboundEvents([delivered]).statuses[0].status).toBe("delivered");

    const [failed] = provider.parseWebhook(harness.statusBody(sent, "failed"));
    if (failed?.kind !== "status") throw new Error(`expected status, got ${JSON.stringify(failed)}`);

    expect(failed.status).toBe("failed");
    expect(failed.errorCode ?? failed.errorTitle).toBeTruthy();
  });

  it("attributes a TEMPLATE reply through contextMessageId, with NO button payload", async () => {
    // The production path. A template's button payload is frozen at approval
    // time, so there is no `evt:<id>` to read — only the wamid of the message
    // that was tapped, and the label on the button.
    const provider = make();
    const sent = await harness.sendTemplate(provider);

    const reply = buttonReply(provider.parseWebhook(harness.tapTemplateButton(sent))[0]);

    expect(reply.contextMessageId).toBe(sent);
    expect(reply.payload).toBe("");
    expect(reply.title).toBe(TEMPLATE_BUTTON_LABELS.TAKEN);

    const { messages } = normalizeInboundEvents([reply]);
    expect(messages[0].kind).toBe("BUTTON_REPLY");
    expect(messages[0].buttonPayload).toBeNull(); // nothing to parse: attribution MUST use the context
    expect(messages[0].contextMessageId).toBe(sent); // ...which is exactly what it does
    expect(messages[0].title).toBe(TEMPLATE_BUTTON_LABELS.TAKEN); // and the label is the only other signal
  });

  it("accepts a signature over the raw body and rejects a tampered one", () => {
    const provider = make();
    // Awkward spacing and key order: the bytes a re-serializing implementation
    // would produce differ from these.
    const raw = Buffer.from('{\n  "object" : "whatsapp_business_account",\n   "entry": [ ]\n}', "utf8");

    expect(provider.verifyWebhookSignature({ "x-hub-signature-256": harness.sign(raw) }, raw)).toBe(true);
    expect(provider.verifyWebhookSignature({ "X-Hub-Signature-256": harness.sign(raw) }, raw)).toBe(true);

    const tampered = Buffer.from(raw.toString("utf8").replace('"entry": [ ]', '"entry": [1]'), "utf8");
    expect(provider.verifyWebhookSignature({ "x-hub-signature-256": harness.sign(raw) }, tampered)).toBe(false);
    expect(provider.verifyWebhookSignature({}, raw)).toBe(false);
    expect(provider.verifyWebhookSignature({ "x-hub-signature-256": "sha256=00" }, raw)).toBe(false);

    // Proof that the RAW bytes are hashed: a signature over the re-serialized
    // form must NOT verify against the body as sent.
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))), "utf8");
    expect(reserialized.equals(raw)).toBe(false);
    expect(provider.verifyWebhookSignature({ "x-hub-signature-256": harness.sign(reserialized) }, raw)).toBe(false);
  });

  it("returns [] for a body it cannot read, rather than throwing", () => {
    const provider = make();

    expect(provider.parseWebhook(Buffer.from("not json at all", "utf8"))).toEqual([]);
    expect(provider.parseWebhook(Buffer.from('{"object":"something_else"}', "utf8"))).toEqual([]);
  });

  it("returns the declared send-result shapes", async () => {
    const provider = make();

    const sent = ok(
      await provider.sendText({ to: PATIENT_PHONE, bodyText: "مرحباً", callbackData: "d", correlationId: "c" }),
    );

    expect(typeof sent.providerMessageId).toBe("string");
    expect(sent.acceptedAtUtc).toBeInstanceOf(Date);
    expect(sent.raw).toBeDefined();
  });
});

describe("mock provider: adversarial by construction", () => {
  it("fails the next N sends, then recovers", async () => {
    const provider = mockInstance();
    provider.failNext(2, { retryable: true, errorCode: PROVIDER_ERROR.RATE_LIMITED });

    const attempt = () =>
      provider.sendText({ to: PATIENT_PHONE, bodyText: "x", callbackData: "d", correlationId: "c" });

    expect(await attempt()).toMatchObject({ ok: false, retryable: true, errorCode: PROVIDER_ERROR.RATE_LIMITED });
    expect(await attempt()).toMatchObject({ ok: false, retryable: true });
    expect(await attempt()).toMatchObject({ ok: true });

    // Failed attempts stay visible in the outbox, with no message id.
    const failed = provider.outbox().filter((row) => row.providerMessageId === null);
    expect(failed).toHaveLength(2);
    expect(failed[0].status).toBe("FAILED");
    expect(failed[0].error?.retryable).toBe(true);
    // The vocabulary the business layer sees is PROVIDER_ERROR's, never Meta's.
    expect(failed[0].error?.errorCode).not.toMatch(/\d/);
  });

  it("refuses what the Cloud API refuses", async () => {
    const provider = mockInstance();

    const fourButtons = await provider.sendInteractive({
      to: PATIENT_PHONE,
      bodyText: "؟",
      buttons: [
        { id: "a", title: "1" },
        { id: "b", title: "2" },
        { id: "c", title: "3" },
        { id: "d", title: "4" },
      ],
      callbackData: "d",
      correlationId: "c",
    });

    // Meta answers a fourth button with a non-retryable 4xx; so does the mock.
    expect(fourButtons).toMatchObject({ ok: false, retryable: false, errorCode: PROVIDER_ERROR.INVALID_REQUEST });

    const badNumber = await provider.sendText({
      to: "12345",
      bodyText: "x",
      callbackData: "d",
      correlationId: "c",
    });

    expect(badNumber).toMatchObject({ ok: false, retryable: false, errorCode: PROVIDER_ERROR.INVALID_RECIPIENT });
  });

  it("stamps times from a clock the caller controls", async () => {
    const provider = mockInstance({ now: new Date("2026-03-10T08:00:00Z") });

    const first = ok(
      await provider.sendText({ to: PATIENT_PHONE, bodyText: "x", callbackData: "d", correlationId: "c" }),
    );
    expect(first.acceptedAtUtc.toISOString()).toBe("2026-03-10T08:00:00.000Z");

    provider.advanceTo(new Date("2026-03-12T09:30:00.000Z"));

    const second = ok(
      await provider.sendText({ to: PATIENT_PHONE, bodyText: "x", callbackData: "d", correlationId: "c" }),
    );
    expect(second.acceptedAtUtc.toISOString()).toBe("2026-03-12T09:30:00.000Z");
  });

  it("delivers status callbacks out of order and twice, without tidying them", async () => {
    const provider = mockInstance();
    const wamid = ok(
      await provider.sendTemplate({
        to: PATIENT_PHONE,
        templateName: "dose_reminder_ar",
        languageCode: "ar",
        variables: { "1": "أحمد" },
        callbackData: "dispatch-9",
        correlationId: "c",
      }),
    ).providerMessageId;

    // read, then delivered, then delivered again: exactly what a flaky network
    // produces, and exactly what the consumer has to survive. Nothing is
    // reordered or de-duplicated on the way out.
    provider.simulateStatusCallback(wamid, "read");
    provider.simulateStatusCallback(wamid, "delivered");
    const duplicate = provider.simulateStatusCallback(wamid, "delivered");

    const [row] = provider.outbox();
    expect(row.statusHistory.map((entry) => entry.status)).toEqual(["SENT", "READ", "DELIVERED", "DELIVERED"]);
    // Display state stays at the furthest stage reached.
    expect(row.status).toBe("READ");

    const events = provider.parseWebhook(duplicate);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "status",
      status: "delivered",
      providerMessageId: wamid,
      callbackData: "dispatch-9",
    });
  });

  it("replays the button ids the dispatcher actually sent", async () => {
    const provider = mockInstance();
    const wamid = ok(
      await provider.sendInteractive({
        to: PATIENT_PHONE,
        bodyText: "خدت الدواء؟",
        buttons: reminderButtons("clxevent001"),
        callbackData: "d",
        correlationId: "c",
      }),
    ).providerMessageId;

    const [event] = provider.parseWebhook(provider.simulateButtonReply(wamid));
    expect(buttonReply(event).payload).toBe("evt:clxevent001:TAKEN");
  });

  it("refuses to pretend a template tap carries a payload", async () => {
    const provider = mockInstance();
    const wamid = ok(
      await provider.sendTemplate({
        to: PATIENT_PHONE,
        templateName: "dose_reminder_ar",
        languageCode: "ar",
        variables: {},
        callbackData: "d",
        correlationId: "c",
      }),
    ).providerMessageId;

    const [event] = provider.parseWebhook(provider.simulateTemplateReply(wamid));
    expect(buttonReply(event).payload).toBe("");

    // Tapping a template through the interactive path would invent the very
    // payload production never receives.
    expect(() => provider.simulateButtonReply(wamid)).toThrow(/template/i);
  });
});

describe("whatsapp cloud: meta error mapping", () => {
  function stubbed(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  }

  const templateRequest = {
    to: PATIENT_PHONE,
    templateName: "dose_reminder_ar",
    languageCode: "ar" as const,
    variables: { "1": "أحمد" },
    callbackData: "dispatch-1",
    correlationId: "c",
  };

  const cases: Array<{
    description: string;
    httpStatus: number;
    error?: MetaErrorBody;
    retryable: boolean;
    errorCode: string;
  }> = [
    {
      description: "131047 outside the session window → non-retryable",
      httpStatus: 400,
      error: { code: 131047, message: "Re-engagement" },
      retryable: false,
      errorCode: PROVIDER_ERROR.OUTSIDE_SESSION_WINDOW,
    },
    {
      description: "132001 template does not exist → non-retryable",
      httpStatus: 400,
      error: { code: 132001, message: "Template name does not exist" },
      retryable: false,
      errorCode: PROVIDER_ERROR.TEMPLATE_NOT_FOUND,
    },
    {
      description: "131026 undeliverable → non-retryable",
      httpStatus: 400,
      error: { code: 131026, message: "Message undeliverable" },
      retryable: false,
      errorCode: PROVIDER_ERROR.UNDELIVERABLE,
    },
    {
      description: "132000 parameter count mismatch → non-retryable",
      httpStatus: 400,
      error: { code: 132000, message: "Number of params mismatch" },
      retryable: false,
      errorCode: PROVIDER_ERROR.TEMPLATE_PARAM_MISMATCH,
    },
    {
      description: "132005 parameter exceeds size → non-retryable",
      httpStatus: 400,
      error: { code: 132005, message: "Localizable param exceeds size" },
      retryable: false,
      errorCode: PROVIDER_ERROR.TEMPLATE_PARAM_MISMATCH,
    },
    {
      description: "132015 paused template → non-retryable",
      httpStatus: 400,
      error: { code: 132015, message: "Template is paused" },
      retryable: false,
      errorCode: PROVIDER_ERROR.TEMPLATE_PAUSED,
    },
    {
      description: "131009 invalid number → non-retryable",
      httpStatus: 400,
      error: { code: 131009, message: "Parameter value is not valid" },
      retryable: false,
      errorCode: PROVIDER_ERROR.INVALID_RECIPIENT,
    },
    {
      description: "131030 recipient not in the allowed list → non-retryable",
      httpStatus: 400,
      error: { code: 131030 },
      retryable: false,
      errorCode: PROVIDER_ERROR.INVALID_REQUEST,
    },
    {
      description: "an unlisted 4xx → non-retryable",
      httpStatus: 400,
      error: { code: 100, message: "Invalid parameter" },
      retryable: false,
      errorCode: PROVIDER_ERROR.INVALID_REQUEST,
    },
    {
      description: "HTTP 429 → retryable",
      httpStatus: 429,
      error: { code: 4, message: "Too many requests" },
      retryable: true,
      errorCode: PROVIDER_ERROR.RATE_LIMITED,
    },
    {
      description: "130429 rate limit hit → retryable",
      httpStatus: 400,
      error: { code: 130429 },
      retryable: true,
      errorCode: PROVIDER_ERROR.RATE_LIMITED,
    },
    {
      description: "HTTP 500 → retryable",
      httpStatus: 500,
      error: { code: 2, message: "Service unavailable" },
      retryable: true,
      errorCode: PROVIDER_ERROR.PROVIDER_UNAVAILABLE,
    },
    {
      description: "HTTP 503 → retryable",
      httpStatus: 503,
      retryable: true,
      errorCode: PROVIDER_ERROR.PROVIDER_UNAVAILABLE,
    },
  ];

  it.each(cases)("$description", async ({ httpStatus, error, retryable, errorCode }) => {
    const provider = cloudProvider(stubbed(httpStatus, { error }));

    const result = await provider.sendTemplate(templateRequest);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.retryable).toBe(retryable);
    expect(result.errorCode).toBe(errorCode);
    // Meta's number is a fact about one refused message; the code is the only
    // thing business logic may branch on.
    expect(result.errorCode).not.toMatch(/\d/);
    expect(result.raw).toBeDefined();
  });

  it("treats a broken connection as retryable and records why", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await cloudProvider(failing).sendText({
      to: PATIENT_PHONE,
      bodyText: "x",
      callbackData: "d",
      correlationId: "c",
    });

    expect(result).toMatchObject({ ok: false, retryable: true, errorCode: PROVIDER_ERROR.NETWORK_ERROR });
  });

  it("treats a timeout as retryable", async () => {
    const timingOut = vi.fn(async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;

    const result = await cloudProvider(timingOut).sendText({
      to: PATIENT_PHONE,
      bodyText: "x",
      callbackData: "d",
      correlationId: "c",
    });

    expect(result).toMatchObject({ ok: false, retryable: true, errorCode: PROVIDER_ERROR.NETWORK_TIMEOUT });
  });

  it("will not report an accepted message it cannot reconcile", async () => {
    const noId = stubbed(200, { messaging_product: "whatsapp", contacts: [{ input: PATIENT_PHONE }] });

    const result = await cloudProvider(noId).sendText({
      to: PATIENT_PHONE,
      bodyText: "x",
      callbackData: "d",
      correlationId: "c",
    });

    expect(result).toMatchObject({ ok: false, retryable: true, errorCode: PROVIDER_ERROR.UNKNOWN });
  });

  it("builds the documented request bodies", async () => {
    const capture = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 }));
    const provider = cloudProvider(capture as unknown as typeof fetch);

    await provider.sendTemplate({
      to: PATIENT_PHONE,
      templateName: "dose_reminder_ar",
      languageCode: "ar",
      variables: { "1": "أحمد", "2": "الميتفورمين", "3": "٨ صباحاً" },
      callbackData: "dispatch-42",
      correlationId: "c",
    });

    const [url, init] = capture.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(url).toBe(`https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`);
    expect(body.to).toBe(PATIENT_PHONE.replace("+", "")); // Graph wants digits, not E.164
    expect(body.type).toBe("template");
    expect(body.template.name).toBe("dose_reminder_ar");
    expect(body.template.language.code).toBe("ar");
    // Positional: Meta addresses parameters by position, not by key.
    expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual([
      "أحمد",
      "الميتفورمين",
      "٨ صباحاً",
    ]);
    expect(body.biz_opaque_callback_data).toBe("dispatch-42");
    // No attempt to smuggle an event id through a template button.
    expect(JSON.stringify(body)).not.toContain("evt:");

    await provider.sendInteractive({
      to: PATIENT_PHONE,
      bodyText: "؟",
      buttons: reminderButtons("clxevent001"),
      callbackData: "dispatch-42",
      correlationId: "c",
    });

    const [, interactiveInit] = capture.mock.calls[1] as unknown as [string, RequestInit];
    const interactive = JSON.parse(interactiveInit.body as string);

    expect(interactive.interactive.type).toBe("button");
    expect(interactive.interactive.body.text).toBe("؟");
    expect(interactive.interactive.action.buttons[0]).toEqual({
      type: "reply",
      reply: { id: "evt:clxevent001:TAKEN", title: TEMPLATE_BUTTON_LABELS.TAKEN },
    });

    const invalid = await provider.sendInteractive({
      to: PATIENT_PHONE,
      bodyText: "x",
      callbackData: "d",
      correlationId: "c",
    });

    // Nothing to express in Graph JSON, so it never leaves the process.
    expect(invalid).toMatchObject({ ok: false, retryable: false, errorCode: PROVIDER_ERROR.INVALID_REQUEST });
    expect(capture.mock.calls).toHaveLength(2);
  });

  it("fails closed when no app secret is configured", () => {
    const provider = cloudProvider(async () => new Response("{}"), { appSecret: "" });
    const raw = Buffer.from("{}", "utf8");
    const emptyKeySignature = `sha256=${createHmac("sha256", "").update(raw).digest("hex")}`;

    expect(provider.verifyWebhookSignature({ "x-hub-signature-256": emptyKeySignature }, raw)).toBe(false);
  });

  it("surfaces the channel's health without throwing", async () => {
    const healthy = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: PHONE_NUMBER_ID, display_phone_number: DISPLAY_PHONE }), { status: 200 }),
    ) as unknown as typeof fetch;

    expect(await cloudProvider(healthy).healthCheck()).toMatchObject({ healthy: true });

    const broken = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const result = await cloudProvider(broken).healthCheck();
    expect(result.healthy).toBe(false);
    expect(result.detail).toBeTruthy();
  });
});

describe("inbound persistence (live database)", () => {
  const RUN = `t${Date.now().toString(36)}`;
  const CHANNEL_KEY = `contract-channel-${RUN}`;
  const TEST_PHONE = "+201555000111";

  let pharmacyId = "";
  let channelId = "";
  let patientId = "";
  const createdRowIds: string[] = [];

  beforeAll(async () => {
    const pharmacy = await systemPrisma.pharmacy.create({ data: { name: `Contract ${RUN}` } });
    pharmacyId = pharmacy.id;

    const channel = await systemPrisma.messagingChannel.create({
      data: {
        pharmacyId,
        provider: "mock",
        providerPhoneNumberId: CHANNEL_KEY,
        displayPhoneE164: DISPLAY_PHONE,
      },
    });
    channelId = channel.id;

    const patient = await systemPrisma.patient.create({
      data: { pharmacyId, fullName: "Contract Patient", phoneE164: TEST_PHONE },
    });
    patientId = patient.id;
  });

  afterAll(async () => {
    await systemPrisma.inboundMessage.deleteMany({ where: { id: { in: createdRowIds } } });
    await systemPrisma.inboundMessage.deleteMany({ where: { fromPhoneE164: TEST_PHONE } });
    await systemPrisma.patient.deleteMany({ where: { id: patientId } });
    await systemPrisma.messagingChannel.deleteMany({ where: { id: channelId } });
    await systemPrisma.pharmacy.deleteMany({ where: { id: pharmacyId } });
  });

  function routedMock() {
    return new MockProvider({ secret: MOCK_SECRET, channelKey: CHANNEL_KEY });
  }

  async function templateTap(provider: MockProvider) {
    const wamid = ok(
      await provider.sendTemplate({
        to: TEST_PHONE,
        templateName: "dose_reminder_ar",
        languageCode: "ar",
        variables: { "1": "أحمد" },
        callbackData: "dispatch-77",
        correlationId: "c",
      }),
    ).providerMessageId;

    return { wamid, body: provider.simulateTemplateReply(wamid, { button: "TAKEN" }) };
  }

  function track(result: Awaited<ReturnType<typeof parseAndPersistInbound>>) {
    for (const { row } of result.rows) createdRowIds.push(row.id);
    return result;
  }

  it("resolves the pharmacy from the channel key and stores the envelope", async () => {
    const provider = routedMock();
    const { wamid, body } = await templateTap(provider);

    const result = track(await parseAndPersistInbound(provider, body));
    expect(result.rows).toHaveLength(1);

    const { row, duplicate } = result.rows[0];

    expect(duplicate).toBe(false);
    expect(row.pharmacyId).toBe(pharmacyId);
    expect(row.channelId).toBe(channelId);
    expect(row.type).toBe("button_reply");
    expect(row.fromPhoneE164).toBe(TEST_PHONE);
    expect(row.toPhoneE164).toBe(DISPLAY_PHONE);
    expect(row.processingStatus).toBe("RECEIVED");
    // For a template tap this is the ONLY attribution key stored.
    expect(row.contextMessageId).toBe(wamid);

    const payload = row.rawPayload as unknown as {
      normalized: { buttonPayload: string | null; contextMessageId: string | null; title: string | null };
      raw: { object?: string };
    };
    expect(payload.normalized.buttonPayload).toBeNull();
    expect(payload.normalized.contextMessageId).toBe(wamid);
    expect(payload.normalized.title).toBe(TEMPLATE_BUTTON_LABELS.TAKEN);
    expect(payload.raw.object).toBe("wasal_mock");
  });

  it("treats a redelivery as a no-op, not an error", async () => {
    const provider = routedMock();
    const { body } = await templateTap(provider);

    const first = track(await parseAndPersistInbound(provider, body));

    // The same bytes again: the unique index on providerMessageId decides, and
    // what it must not do is throw — a 500 here makes Meta redeliver forever.
    const second = await parseAndPersistInbound(provider, body);

    expect(second.duplicates).toBe(1);
    expect(second.rows[0].duplicate).toBe(true);
    expect(second.rows[0].row.id).toBe(first.rows[0].row.id);

    const stored = await systemPrisma.inboundMessage.count({
      where: { providerMessageId: first.rows[0].row.providerMessageId },
    });
    expect(stored).toBe(1);
  });

  it("stores a message from an unknown channel as unrouted", async () => {
    const stray = new MockProvider({ secret: MOCK_SECRET, channelKey: "no-such-channel" });
    const body = stray.simulateTextReply({ from: TEST_PHONE, text: "مرحباً" });

    const result = track(await parseAndPersistInbound(stray, body));

    expect(result.rows[0].row.pharmacyId).toBeNull();
    expect(result.rows[0].row.channelId).toBeNull();
    expect(result.rows[0].row.processingStatus).toBe("UNROUTED");
    // The routing key is kept: it is the only handle on where the message arrived.
    expect(result.rows[0].row.toPhoneE164).toBe("no-such-channel");
  });

  it("does not persist delivery receipts as inbound messages", async () => {
    const provider = routedMock();
    const { wamid } = await templateTap(provider);
    const body = provider.simulateStatusCallback(wamid, "delivered");

    const result = await parseAndPersistInbound(provider, body);

    expect(result.rows).toHaveLength(0);
    expect(result.messages).toHaveLength(0);
    expect(result.statuses).toHaveLength(1);
    expect(result.statuses[0].providerMessageId).toBe(wamid);
    expect(result.statuses[0].status).toBe("delivered");
    expect(result.statuses[0].callbackData).toBe("dispatch-77");
  });

  it("computes the session window for a patient from stored state", async () => {
    const provider = routedMock();
    const now = new Date("2026-03-10T12:00:00Z");

    const closed = await computePatientSessionWindow(provider, patientId, now);
    expect(closed).toEqual({ open: false, lastInboundAtUtc: null, closesAtUtc: null });

    const inboundAt = new Date(now.getTime() - 3_600_000);
    await systemPrisma.patient.update({ where: { id: patientId }, data: { lastInboundAtUtc: inboundAt } });

    const open = await computePatientSessionWindow(provider, patientId, now);
    expect(open?.open).toBe(true);
    expect(open?.closesAtUtc?.toISOString()).toBe(new Date(inboundAt.getTime() + 24 * 3_600_000).toISOString());

    const expired = await computePatientSessionWindow(
      provider,
      patientId,
      new Date(inboundAt.getTime() + 25 * 3_600_000),
    );
    expect(expired?.open).toBe(false);

    // An id this client cannot see is not an error, it is a null.
    expect(await computePatientSessionWindow(provider, "no-such-patient", now)).toBeNull();
  });
});
