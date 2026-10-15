import { DeliveryState } from "@/generated/prisma/enums";
import { env } from "@/server/env";
import { templateButtons } from "../menu";
import {
  PROVIDER_ERROR,
  isWithinSessionWindow,
  readSignatureHeader,
  runVerificationChallenge,
  signHmacSha256,
  toE164,
  verifyHmacSha256,
  type E164,
  type InboundEvent,
  type MessagingProvider,
  type ProviderCapabilities,
  type SendInteractiveRequest,
  type SendResult,
  type SendTemplateRequest,
  type SendTextRequest,
} from "../provider";

/**
 * Local provider.
 *
 * The point of this class is not to be convenient — it is to be hostile in the
 * same ways Meta is. A mock that always succeeds, answers in order, and hands
 * back a usable payload on every reply produces a test suite that passes on
 * every commit and a production system that drops every template response.
 * So it: rejects what the Cloud API rejects, stamps times from a clock you have
 * to move by hand, lets a status callback arrive out of order or twice, and
 * models a template tap as what it actually is — a `context.id` and nothing
 * else.
 */

export type MockRequest =
  | {
      kind: "template";
      to: E164;
      templateName: string;
      languageCode: "ar" | "en";
      variables: Record<string, string>;
      callbackData: string;
      correlationId: string;
    }
  | {
      kind: "interactive";
      to: E164;
      bodyText: string;
      header?: { type: "text"; text: string };
      buttons?: Array<{ id: string; title: string }>;
      list?: { buttonText: string; rows: Array<{ id: string; title: string; description?: string }> };
      callbackData: string;
      correlationId: string;
    }
  | {
      kind: "text";
      to: E164;
      bodyText: string;
      callbackData: string;
      correlationId: string;
    };

export type MockOutboxRow = {
  /** Null on an attempt that never reached the provider. */
  providerMessageId: string | null;
  kind: MockRequest["kind"];
  to: E164;
  preview: string;
  callbackData: string;
  correlationId: string;
  attemptedAtUtc: Date;
  /** Furthest state reached, for display. `statusHistory` is the truth. */
  status: DeliveryState;
  statusHistory: Array<{ status: DeliveryState; atUtc: Date }>;
  error: { errorCode: string; errorMessage: string; retryable: boolean } | null;
  request: MockRequest;
};

/**
 * The mock's wire format. Deliberately NOT the Cloud API's envelope: two
 * different parsers converging on one `InboundEvent` is what makes the parse
 * contract worth testing. `from`/`to` are bare digits, as Meta sends them, so
 * the E.164 normalization runs in dev too.
 */
export type MockWireEvent =
  | {
      kind: "button_reply";
      messageId: string;
      from: string;
      to: string;
      atUtc: string;
      contextMessageId?: string;
      payload: string;
      title: string;
    }
  | {
      kind: "list_reply";
      messageId: string;
      from: string;
      to: string;
      atUtc: string;
      contextMessageId?: string;
      rowId: string;
      title: string;
    }
  | { kind: "text"; messageId: string; from: string; to: string; atUtc: string; contextMessageId?: string; text: string }
  | { kind: "unsupported"; messageId: string; from: string; to: string; atUtc: string; mediaType: string }
  | {
      kind: "status";
      messageId: string;
      status: "sent" | "delivered" | "read" | "failed";
      atUtc: string;
      errorCode?: string;
      errorTitle?: string;
      callbackData?: string;
    }
  | {
      kind: "template_status";
      templateId: string;
      name: string;
      languageCode: string;
      status: string;
      reason?: string;
    };

export type MockWireEnvelope = { object: "wasal_mock"; events: MockWireEvent[] };

export type MockProviderOptions = {
  /** HMAC key for `X-Hub-Signature-256`. Defaults to the verify token. */
  secret?: string;
  /** The pharmacy channel key inbound messages are addressed to. */
  channelKey?: string;
  now?: Date;
};

type ScriptedFailure = { retryable: boolean; errorCode: string; errorMessage: string };

/** The three quick replies an approved Arabic dose reminder carries. */
export const MOCK_TEMPLATE_BUTTONS = templateButtons();

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

export class MockProvider implements MessagingProvider {
  readonly name = "mock";

  private readonly options: MockProviderOptions;
  private clock: Date;
  private seq = 0;
  private rows: MockOutboxRow[] = [];
  private failures: ScriptedFailure[] = [];
  private inbound: Array<{ atUtc: string; event: MockWireEvent }> = [];

  constructor(options: MockProviderOptions = {}) {
    this.options = options;
    this.clock = options.now ?? new Date();
  }

  // ── dev controls ─────────────────────────────────────────────────────────

  /** Move the provider's clock. Everything it stamps is taken from this, so a
   *  24-hour window can be crossed in a test without waiting a day. */
  advanceTo(date: Date): void {
    this.clock = date;
  }

  now(): Date {
    return new Date(this.clock.getTime());
  }

  /** Make the next `count` sends fail, then recover. */
  failNext(
    count: number,
    options: { retryable: boolean; errorCode?: string; errorMessage?: string },
  ): void {
    for (let i = 0; i < count; i++) {
      this.failures.push({
        retryable: options.retryable,
        errorCode: options.errorCode ?? (options.retryable ? PROVIDER_ERROR.PROVIDER_UNAVAILABLE : PROVIDER_ERROR.UNDELIVERABLE),
        errorMessage: options.errorMessage ?? "scripted failure (mock)",
      });
    }
  }

  outbox(): MockOutboxRow[] {
    return structuredClone(this.rows);
  }

  /** The webhook bodies this provider has generated, newest last. */
  inboundLog(): Array<{ atUtc: string; event: MockWireEvent }> {
    return structuredClone(this.inbound);
  }

  /** Clear outbox, scripted failures and pending inbound. Keeps the clock. */
  reset(): void {
    this.rows = [];
    this.failures = [];
    this.inbound = [];
    this.seq = 0;
  }

  /** The header value a real provider would send. Dev and test only. */
  signBody(rawBody: Buffer): string {
    return signHmacSha256(this.secret(), rawBody);
  }

  /** The channel key inbound webhooks are addressed to — the value a
   *  `MessagingChannel.providerPhoneNumberId` must hold for routing to resolve. */
  channelKey(): string {
    return this.options.channelKey ?? (env().WHATSAPP_PHONE_NUMBER_ID || "mock-phone-number-id");
  }

  // ── simulated inbound ────────────────────────────────────────────────────

  /**
   * A tap on a quick-reply button of a TEMPLATE message.
   *
   * `payload` defaults to the empty string because a Cloud API template's
   * button payload is fixed when Meta approves the template; it cannot carry
   * the per-message `evt:<id>` an interactive message would. The only reliable
   * attribution keys are `context.id` — the wamid of the message that was
   * tapped — and the button's label, which is why the mock emits both and
   * invents neither.
   *
   * The labels come from `menu.ts` rather than from a private copy here: a mock
   * whose labels differ from the approved template's would demonstrate an
   * attribution path production never takes.
   */
  simulateTemplateReply(
    providerMessageId: string,
    options: { button?: string; payload?: string; title?: string } = {},
  ): Buffer {
    const row = this.requireRow(providerMessageId);
    const button =
      MOCK_TEMPLATE_BUTTONS.find((b) => b.id === options.button) ?? MOCK_TEMPLATE_BUTTONS[0];

    return this.envelope([
      {
        kind: "button_reply",
        messageId: `wamid.mock.in.${++this.seq}`,
        from: digits(row.to),
        to: this.channelKey(),
        atUtc: this.clock.toISOString(),
        contextMessageId: providerMessageId,
        payload: options.payload ?? "",
        title: options.title ?? button.title,
      },
    ]);
  }

  /**
   * A tap on a button of an INTERACTIVE message. The payload is whatever was
   * sent — the `evt:<id>` the dispatcher generated — read back out of the
   * outbox, not invented here.
   */
  simulateButtonReply(providerMessageId: string, options: { buttonIndex?: number } = {}): Buffer {
    const row = this.requireRow(providerMessageId);
    if (row.request.kind !== "interactive") {
      throw new Error(
        `Mock: ${providerMessageId} is a ${row.request.kind} message; a template tap carries no ` +
          `usable payload — use simulateTemplateReply() to exercise the production path.`,
      );
    }

    const button = row.request.buttons?.[options.buttonIndex ?? 0];
    if (!button) throw new Error(`Mock: ${providerMessageId} has no button at index ${options.buttonIndex ?? 0}`);

    return this.envelope([
      {
        kind: "button_reply",
        messageId: `wamid.mock.in.${++this.seq}`,
        from: digits(row.to),
        to: this.channelKey(),
        atUtc: this.clock.toISOString(),
        contextMessageId: providerMessageId,
        payload: button.id,
        title: button.title,
      },
    ]);
  }

  simulateListReply(providerMessageId: string, options: { rowIndex?: number } = {}): Buffer {
    const row = this.requireRow(providerMessageId);
    const listRow = row.request.kind === "interactive" ? row.request.list?.rows[options.rowIndex ?? 0] : undefined;
    if (!listRow) throw new Error(`Mock: ${providerMessageId} is not a list message with a row at ${options.rowIndex ?? 0}`);

    return this.envelope([
      {
        kind: "list_reply",
        messageId: `wamid.mock.in.${++this.seq}`,
        from: digits(row.to),
        to: this.channelKey(),
        atUtc: this.clock.toISOString(),
        contextMessageId: providerMessageId,
        rowId: listRow.id,
        title: listRow.title,
      },
    ]);
  }

  /** A typed reply. Usually NOT a reply to anything — patients just type. */
  simulateTextReply(options: { from: E164; text: string; contextMessageId?: string }): Buffer {
    return this.envelope([
      {
        kind: "text",
        messageId: `wamid.mock.in.${++this.seq}`,
        from: digits(options.from),
        to: this.channelKey(),
        atUtc: this.clock.toISOString(),
        contextMessageId: options.contextMessageId,
        text: options.text,
      },
    ]);
  }

  simulateMedia(options: { from: E164; mediaType?: string }): Buffer {
    return this.envelope([
      {
        kind: "unsupported",
        messageId: `wamid.mock.in.${++this.seq}`,
        from: digits(options.from),
        to: this.channelKey(),
        atUtc: this.clock.toISOString(),
        mediaType: options.mediaType ?? "image",
      },
    ]);
  }

  /**
   * A delivery receipt, fireable at will.
   *
   * Nothing here reorders or de-duplicates: a real provider will deliver a
   * `read` before a `delivered` after a network blip, and will deliver both
   * twice. The consumer has to cope, so the mock does not hide it.
   *
   * `delayMs` applies the status to the outbox row later — the returned body is
   * the callback the provider will send when that timer fires.
   */
  simulateStatusCallback(
    providerMessageId: string,
    status: "sent" | "delivered" | "read" | "failed",
    options: { delayMs?: number; errorCode?: string; errorTitle?: string } = {},
  ): Buffer {
    const callbackData = this.rows.find((r) => r.providerMessageId === providerMessageId)?.callbackData;

    if (options.delayMs && options.delayMs > 0) {
      setTimeout(() => this.applyStatus(providerMessageId, status), options.delayMs).unref?.();
    } else {
      this.applyStatus(providerMessageId, status);
    }

    return this.envelope([
      {
        kind: "status",
        messageId: providerMessageId,
        status,
        atUtc: this.clock.toISOString(),
        errorCode: options.errorCode,
        errorTitle: options.errorTitle,
        callbackData,
      },
    ]);
  }

  simulateTemplateStatus(options: {
    name: string;
    languageCode?: string;
    status?: string;
    reason?: string;
  }): Buffer {
    return this.envelope([
      {
        kind: "template_status",
        templateId: `mock-template-${++this.seq}`,
        name: options.name,
        languageCode: options.languageCode ?? "ar",
        status: options.status ?? "APPROVED",
        reason: options.reason,
      },
    ]);
  }

  // ── MessagingProvider ────────────────────────────────────────────────────

  async sendTemplate(req: SendTemplateRequest): Promise<SendResult> {
    return this.accept({ kind: "template", ...req });
  }

  async sendInteractive(req: SendInteractiveRequest): Promise<SendResult> {
    return this.accept({ kind: "interactive", ...req });
  }

  async sendText(req: SendTextRequest): Promise<SendResult> {
    return this.accept({ kind: "text", ...req });
  }

  verifyWebhookSignature(headers: Record<string, string | undefined>, rawBody: Buffer): boolean {
    return verifyHmacSha256(this.secret(), rawBody, readSignatureHeader(headers));
  }

  handleVerificationChallenge(query: Record<string, string>): { status: number; body: string } | null {
    return runVerificationChallenge(query, this.secret());
  }

  parseWebhook(rawBody: Buffer): InboundEvent[] {
    let envelope: MockWireEnvelope;
    try {
      envelope = JSON.parse(rawBody.toString("utf8")) as MockWireEnvelope;
    } catch {
      return [];
    }

    if (envelope?.object !== "wasal_mock" || !Array.isArray(envelope.events)) return [];

    return envelope.events.map((event) => this.toInboundEvent(event)).filter((e): e is InboundEvent => e !== null);
  }

  capabilities(): ProviderCapabilities {
    return {
      // True so tests exercise the production path: the Cloud API does support
      // list messages, and a mock that said otherwise would stop covering it.
      supportsListMessages: true,
      maxReplyButtons: 3,
      maxListRows: 10,
      supportsFreeFormWithinSessionWindow: true,
      sessionWindowHours: 24,
      supportsBizOpaqueCallbackData: true,
      // Mirrors the Cloud API. Never let this be true: business code that
      // branches on it would take a path production cannot offer.
      supportsTemplateButtonPayloads: false,
    };
  }

  sessionWindowOpen(_to: E164, lastInboundAtUtc: Date | null, nowUtc: Date): boolean {
    return isWithinSessionWindow(lastInboundAtUtc, nowUtc, this.capabilities().sessionWindowHours);
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    return { healthy: true, detail: "mock provider — no network" };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private secret(): string {
    return this.options.secret ?? (env().WHATSAPP_VERIFY_TOKEN || "wasal-mock-dev-secret");
  }

  private accept(request: MockRequest): SendResult {
    const attemptedAtUtc = this.now();

    const scripted = this.failures.shift();
    if (scripted) {
      this.pushRow({
        providerMessageId: null,
        request,
        attemptedAtUtc,
        error: scripted,
        status: DeliveryState.FAILED,
      });
      return { ok: false, ...scripted, raw: { mock: true, scripted: true, request } };
    }

    const invalid = validate(request);
    if (invalid) {
      this.pushRow({
        providerMessageId: null,
        request,
        attemptedAtUtc,
        error: invalid,
        status: DeliveryState.FAILED,
      });
      return { ok: false, ...invalid, raw: { mock: true, rejected: true, request } };
    }

    const providerMessageId = `wamid.mock.${++this.seq}`;
    this.pushRow({
      providerMessageId,
      request,
      attemptedAtUtc,
      error: null,
      status: DeliveryState.SENT,
    });

    return { ok: true, providerMessageId, acceptedAtUtc: attemptedAtUtc, raw: request };
  }

  private pushRow(row: {
    providerMessageId: string | null;
    request: MockRequest;
    attemptedAtUtc: Date;
    error: { errorCode: string; errorMessage: string; retryable: boolean } | null;
    status: DeliveryState;
  }): void {
    this.rows.push({
      ...row,
      kind: row.request.kind,
      to: row.request.to,
      preview: preview(row.request),
      callbackData: row.request.callbackData,
      correlationId: row.request.correlationId,
      statusHistory: [{ status: row.status, atUtc: row.attemptedAtUtc }],
    });
  }

  private applyStatus(providerMessageId: string, status: "sent" | "delivered" | "read" | "failed"): void {
    const row = this.rows.find((r) => r.providerMessageId === providerMessageId);
    // An unknown wamid is emitted rather than swallowed: Meta does not police
    // our outbox, and a reconciler that ignores unknown receipts is a bug.
    if (!row) return;

    const next = statusToDeliveryState(status);
    row.statusHistory.push({ status: next, atUtc: this.now() });
    if (STATUS_RANK[status] >= STATUS_RANK[statusOf(row.status)]) row.status = next;
  }

  private envelope(events: MockWireEvent[]): Buffer {
    const atUtc = this.clock.toISOString();
    this.inbound.push(...events.map((event) => ({ atUtc, event })));
    if (this.inbound.length > 50) this.inbound.splice(0, this.inbound.length - 50);

    return Buffer.from(JSON.stringify({ object: "wasal_mock", events } satisfies MockWireEnvelope), "utf8");
  }

  private requireRow(providerMessageId: string): MockOutboxRow {
    const row = this.rows.find((r) => r.providerMessageId === providerMessageId);
    if (!row) throw new Error(`Mock: no outbox row for ${providerMessageId}. Send something first.`);
    return row;
  }

  private toInboundEvent(event: MockWireEvent): InboundEvent | null {
    if (event.kind === "template_status") {
      return {
        kind: "template_status",
        providerTemplateId: event.templateId,
        name: event.name,
        languageCode: event.languageCode,
        status: event.status,
        reason: event.reason,
        raw: event,
      };
    }

    if (event.kind === "status") {
      return {
        kind: "status",
        providerMessageId: event.messageId,
        status: event.status,
        atUtc: new Date(event.atUtc),
        errorCode: event.errorCode,
        errorTitle: event.errorTitle,
        callbackData: event.callbackData,
        raw: event,
      };
    }

    const base = {
      providerMessageId: event.messageId,
      from: toE164(event.from),
      to: event.to,
      atUtc: new Date(event.atUtc),
      raw: event,
    };

    if (event.kind === "button_reply") {
      return {
        ...base,
        kind: "button_reply",
        contextMessageId: event.contextMessageId,
        payload: event.payload,
        title: event.title,
      };
    }

    if (event.kind === "list_reply") {
      return {
        ...base,
        kind: "list_reply",
        contextMessageId: event.contextMessageId,
        rowId: event.rowId,
        title: event.title,
      };
    }

    if (event.kind === "text") {
      return { ...base, kind: "text", contextMessageId: event.contextMessageId, text: event.text };
    }

    return { ...base, kind: "unsupported", mediaType: event.mediaType };
  }
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function preview(request: MockRequest): string {
  if (request.kind === "template") {
    const values = Object.values(request.variables).join(" | ");
    return `[${request.templateName}/${request.languageCode}] ${values}`.trim();
  }
  return request.bodyText;
}

function statusToDeliveryState(status: "sent" | "delivered" | "read" | "failed"): DeliveryState {
  return {
    sent: DeliveryState.SENT,
    delivered: DeliveryState.DELIVERED,
    read: DeliveryState.READ,
    failed: DeliveryState.FAILED,
  }[status];
}

function statusOf(state: DeliveryState): string {
  return state.toLowerCase();
}

/**
 * The Cloud API's own limits. A mock that accepted a 4-button message would
 * move the failure into production, where it costs a reminder.
 */
function validate(request: MockRequest): { errorCode: string; errorMessage: string; retryable: boolean } | null {
  const invalid = (errorMessage: string) => ({
    errorCode: PROVIDER_ERROR.INVALID_REQUEST,
    errorMessage,
    retryable: false,
  });

  if (!/^\+\d{8,15}$/.test(request.to)) {
    return {
      errorCode: PROVIDER_ERROR.INVALID_RECIPIENT,
      errorMessage: `not an E.164 number: ${JSON.stringify(request.to)}`,
      retryable: false,
    };
  }

  if (request.kind === "text" && request.bodyText.length > 4096) {
    return invalid(`text body is ${request.bodyText.length} chars; the limit is 4096`);
  }

  if (request.kind !== "interactive") return null;

  if (!request.buttons && !request.list) return invalid("interactive message needs buttons or a list");
  if (request.bodyText.length > 1024) return invalid("interactive body exceeds 1024 chars");
  if (request.header && request.header.text.length > 60) return invalid("header exceeds 60 chars");

  if (request.buttons) {
    if (request.buttons.length > 3) return invalid(`${request.buttons.length} buttons; the limit is 3`);
    for (const button of request.buttons) {
      if (button.title.length > 20) return invalid(`button title exceeds 20 chars: ${JSON.stringify(button.title)}`);
    }
  }

  if (request.list) {
    if (request.list.buttonText.length > 20) return invalid("list button text exceeds 20 chars");
    if (request.list.rows.length > 10) return invalid(`${request.list.rows.length} rows; the limit is 10`);
    for (const row of request.list.rows) {
      if (row.title.length > 24) return invalid(`row title exceeds 24 chars: ${JSON.stringify(row.title)}`);
      if (row.description && row.description.length > 72) return invalid("row description exceeds 72 chars");
    }
  }

  return null;
}
