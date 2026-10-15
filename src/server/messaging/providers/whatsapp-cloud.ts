import { env } from "@/server/env";
import {
  PROVIDER_ERROR,
  isWithinSessionWindow,
  readSignatureHeader,
  runVerificationChallenge,
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
 * WhatsApp Business Cloud API.
 *
 * Two things here are not obvious from the docs and were expensive to learn:
 *
 *   1. A template's quick-reply buttons carry a payload that is fixed when Meta
 *      approves the template. It cannot hold a per-message `evt:<id>`, so a
 *      template reply is attributable only through `context.id` — the wamid of
 *      the message the patient tapped. Anything that tries to smuggle state
 *      through a template button payload will attribute every reply to the
 *      wrong dose.
 *
 *   2. The signature covers the raw bytes. `X-Hub-Signature-256` is computed
 *      over what was posted, so the body must be hashed before it is parsed;
 *      `JSON.stringify(JSON.parse(body))` differs from `body` and will reject
 *      every real webhook.
 */

export type MetaErrorBody = {
  code?: number;
  title?: string;
  message?: string;
  type?: string;
  error_subcode?: number;
  error_data?: { details?: string };
};

export type WhatsAppCloudConfig = {
  accessToken?: string;
  phoneNumberId?: string;
  appSecret?: string;
  verifyToken?: string;
  apiVersion?: string;
  baseUrl?: string;
  /** Injected in tests so the suite never touches graph.facebook.com. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type ResolvedConfig = {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  verifyToken: string;
  apiVersion: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
};

type MetaMessage = {
  id: string;
  from: string;
  timestamp?: string;
  type?: string;
  context?: { id?: string; from?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  text?: { body?: string };
};

type MetaStatus = {
  id: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  biz_opaque_callback_data?: string;
  errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
};

type MetaChangeValue = {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
  event?: string;
  message_template_id?: number | string;
  message_template_name?: string;
  message_template_language?: string;
  reason?: string;
};

type MetaWebhookBody = {
  object?: string;
  entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: MetaChangeValue }> }>;
};

/**
 * Translate Meta's error surface into the only error vocabulary the business
 * layer is allowed to see.
 *
 * `retryable` is the load-bearing value: it decides whether the dispatcher
 * tries again or writes the reminder off, and getting it wrong in one direction
 * spams a patient and in the other drops a dose.
 */
export function mapMetaError(
  httpStatus: number,
  error: MetaErrorBody | undefined,
): { retryable: boolean; errorCode: string; errorMessage: string } {
  const details = error?.error_data?.details;
  const errorMessage = [error?.message ?? `HTTP ${httpStatus}`, details && `(${details})`]
    .filter(Boolean)
    .join(" ");

  // Meta has moved some of these between `code` and `error_subcode` over API
  // versions; recognise either.
  const code = error?.code ?? error?.error_subcode;

  switch (code) {
    case 131047:
      return { retryable: false, errorCode: PROVIDER_ERROR.OUTSIDE_SESSION_WINDOW, errorMessage };
    case 132001:
      return { retryable: false, errorCode: PROVIDER_ERROR.TEMPLATE_NOT_FOUND, errorMessage };
    case 131026:
      return { retryable: false, errorCode: PROVIDER_ERROR.UNDELIVERABLE, errorMessage };
    case 132000:
    case 132005:
      return { retryable: false, errorCode: PROVIDER_ERROR.TEMPLATE_PARAM_MISMATCH, errorMessage };
    case 132015:
    case 132016:
      return { retryable: false, errorCode: PROVIDER_ERROR.TEMPLATE_PAUSED, errorMessage };
    case 131009:
      return { retryable: false, errorCode: PROVIDER_ERROR.INVALID_RECIPIENT, errorMessage };
    case 131030:
    case 131051:
      return { retryable: false, errorCode: PROVIDER_ERROR.INVALID_REQUEST, errorMessage };
    case 131048:
    case 131056:
    case 130429:
      return { retryable: true, errorCode: PROVIDER_ERROR.RATE_LIMITED, errorMessage };
    default:
      break;
  }

  if (httpStatus === 429) {
    return { retryable: true, errorCode: PROVIDER_ERROR.RATE_LIMITED, errorMessage };
  }

  if (httpStatus >= 500) {
    return { retryable: true, errorCode: PROVIDER_ERROR.PROVIDER_UNAVAILABLE, errorMessage };
  }

  // Every remaining 4xx is the request's fault and will fail identically on the
  // next attempt. Retrying is what turns a bad parameter into a patient who
  // receives the same broken message six times.
  if (httpStatus >= 400) {
    return { retryable: false, errorCode: PROVIDER_ERROR.INVALID_REQUEST, errorMessage };
  }

  return { retryable: true, errorCode: PROVIDER_ERROR.UNKNOWN, errorMessage };
}

/**
 * Returns a fetch-compatible function backed by an undici Agent that binds to
 * IPv4 only. On Windows, Node 22's global fetch (undici) defaults to trying
 * IPv6 first and may time out against graph.facebook.com when the IPv6 path is
 * broken. Setting `family: 4` on the Agent forces AF_INET, which matches what
 * `curl` does by default and is always reachable.
 *
 * Falls back to the global fetch if undici is not available (e.g. in test
 * environments that stub fetch).
 */
function makeIpv4Fetch(): typeof fetch {
  try {
    // undici is a peer dep of Node 18+ and is always present in the worker.
    // Dynamic require avoids a top-level import that would break in edge runtimes.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fetch: undiciFetch, Agent } = require("undici") as typeof import("undici");
    const agent = new Agent({ connect: { family: 4 } });
    return (input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher: agent,
      }) as Promise<Response>;
  } catch {
    // undici not available — fall back to global fetch (tests, edge runtime).
    return fetch;
  }
}

export class WhatsAppCloudProvider implements MessagingProvider {
  readonly name = "whatsapp_cloud";

  private readonly overrides: WhatsAppCloudConfig;
  private cached: ResolvedConfig | null = null;

  constructor(config: WhatsAppCloudConfig = {}) {
    this.overrides = config;
  }

  // Env is read lazily: a provider instance must be constructible (and its
  // parser testable) without a fully configured process environment.
  private config(): ResolvedConfig {
    if (this.cached) return this.cached;

    const e = env();
    const apiVersion = (this.overrides.apiVersion ?? e.WHATSAPP_API_VERSION).replace(/^v?/, "v");

    this.cached = {
      accessToken: this.overrides.accessToken ?? e.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: this.overrides.phoneNumberId ?? e.WHATSAPP_PHONE_NUMBER_ID,
      appSecret: this.overrides.appSecret ?? e.WHATSAPP_APP_SECRET,
      verifyToken: this.overrides.verifyToken ?? e.WHATSAPP_VERIFY_TOKEN,
      apiVersion,
      baseUrl: (this.overrides.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, ""),
      fetchImpl: this.overrides.fetchImpl ?? makeIpv4Fetch(),
      timeoutMs: this.overrides.timeoutMs ?? 15_000,
    };

    return this.cached;
  }

  // ── sends ────────────────────────────────────────────────────────────────

  async sendTemplate(req: SendTemplateRequest): Promise<SendResult> {
    const values = Object.values(req.variables);

    return this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digits(req.to),
      type: "template",
      template: {
        name: req.templateName,
        language: {
          code: req.templateName === "hello_world" && req.languageCode === "en" ? "en_US" : req.languageCode,
        },
        // Rapid-reply buttons are intentionally NOT parameterised: their
        // payloads come from the approved template and per-message values are
        // impossible. See the class comment.
        ...(values.length > 0
          ? { components: [{ type: "body", parameters: values.map((text) => ({ type: "text", text })) }] }
          : {}),
      },
      biz_opaque_callback_data: req.callbackData,
    });
  }

  async sendInteractive(req: SendInteractiveRequest): Promise<SendResult> {
    const header = req.header ? { type: "text", text: req.header.text } : undefined;

    let action: Record<string, unknown> | null = null;
    if (req.buttons && req.buttons.length > 0) {
      action = {
        buttons: req.buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
      };
    } else if (req.list) {
      action = {
        button: req.list.buttonText,
        sections: [
          {
            rows: req.list.rows.map((r) => ({
              id: r.id,
              title: r.title,
              ...(r.description ? { description: r.description } : {}),
            })),
          },
        ],
      };
    }

    if (!action) {
      // No Graph payload would express this, so it never leaves the process.
      return {
        ok: false,
        retryable: false,
        errorCode: PROVIDER_ERROR.INVALID_REQUEST,
        errorMessage: "interactive message needs buttons or a list",
        raw: { request: req },
      };
    }

    return this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digits(req.to),
      type: "interactive",
      interactive: {
        type: req.list && !req.buttons?.length ? "list" : "button",
        ...(header ? { header } : {}),
        body: { text: req.bodyText },
        action,
      },
      biz_opaque_callback_data: req.callbackData,
    });
  }

  async sendText(req: SendTextRequest): Promise<SendResult> {
    return this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digits(req.to),
      type: "text",
      text: { preview_url: false, body: req.bodyText },
      biz_opaque_callback_data: req.callbackData,
    });
  }

  // ── webhook ──────────────────────────────────────────────────────────────

  verifyWebhookSignature(headers: Record<string, string | undefined>, rawBody: Buffer): boolean {
    return verifyHmacSha256(this.config().appSecret, rawBody, readSignatureHeader(headers));
  }

  handleVerificationChallenge(query: Record<string, string>): { status: number; body: string } | null {
    return runVerificationChallenge(query, this.config().verifyToken);
  }

  parseWebhook(rawBody: Buffer): InboundEvent[] {
    let decoded: MetaWebhookBody;
    try {
      decoded = JSON.parse(rawBody.toString("utf8")) as MetaWebhookBody;
    } catch {
      return [];
    }

    if (decoded?.object !== "whatsapp_business_account") return [];

    const events: InboundEvent[] = [];

    for (const entry of decoded.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};

        if (change.field === "message_template_status_update" || value.event !== undefined) {
          events.push({
            kind: "template_status",
            providerTemplateId: String(value.message_template_id ?? ""),
            name: value.message_template_name ?? "",
            languageCode: value.message_template_language ?? "",
            status: value.event ?? "",
            reason: value.reason,
            raw: value,
          });
          continue;
        }

        if (change.field !== "messages") continue;

        // The receiving channel, not a human's number: this is the key that
        // resolves the webhook to a pharmacy. See NormalizedInboundEvent.
        const channelKey = value.metadata?.phone_number_id ?? "";

        for (const message of value.messages ?? []) {
          const event = toInboundMessage(message, channelKey);
          if (event) events.push(event);
        }

        for (const status of value.statuses ?? []) {
          events.push(toInboundStatus(status));
        }

        // `value.errors` describes a batch-level failure with no wamid of its
        // own; the affected message already arrives as its own status callback,
        // so there is nothing here an InboundEvent could address.
      }
    }

    return events;
  }

  capabilities(): ProviderCapabilities {
    return {
      supportsListMessages: true,
      maxReplyButtons: 3,
      maxListRows: 10,
      supportsFreeFormWithinSessionWindow: true,
      sessionWindowHours: 24,
      supportsBizOpaqueCallbackData: true,
      supportsTemplateButtonPayloads: false,
    };
  }

  sessionWindowOpen(_to: E164, lastInboundAtUtc: Date | null, nowUtc: Date): boolean {
    return isWithinSessionWindow(lastInboundAtUtc, nowUtc, this.capabilities().sessionWindowHours);
  }

  async healthCheck(): Promise<{ healthy: boolean; detail?: string }> {
    const cfg = this.config();

    try {
      const response = await cfg.fetchImpl(
        `${cfg.baseUrl}/${cfg.apiVersion}/${cfg.phoneNumberId}?fields=id,display_phone_number`,
        { headers: { authorization: `Bearer ${cfg.accessToken}` }, signal: AbortSignal.timeout(cfg.timeoutMs) },
      );

      const body = (await safeJson(response)) as { id?: string; display_phone_number?: string; error?: MetaErrorBody };

      if (!response.ok) {
        const mapped = mapMetaError(response.status, body?.error);
        return { healthy: false, detail: `${mapped.errorCode}: ${mapped.errorMessage}` };
      }

      return body?.id
        ? { healthy: true, detail: body.display_phone_number ?? body.id }
        : { healthy: false, detail: "response carried no phone number id" };
    } catch (error) {
      return { healthy: false, detail: describeNetworkError(error) };
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async post(body: Record<string, unknown>): Promise<SendResult> {
    const cfg = this.config();
    const url = `${cfg.baseUrl}/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;

    let response: Response;
    try {
      response = await cfg.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (error) {
      const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      return {
        ok: false,
        // A connection that never answered may or may not have delivered; the
        // dispatcher's reconciler owns that ambiguity, and `raw` records why.
        retryable: true,
        errorCode: aborted ? PROVIDER_ERROR.NETWORK_TIMEOUT : PROVIDER_ERROR.NETWORK_ERROR,
        errorMessage: describeNetworkError(error),
        raw: { request: body, error: String(error) },
      };
    }

    const payload = await safeJson(response);

    if (!response.ok) {
      const mapped = mapMetaError(response.status, (payload as { error?: MetaErrorBody })?.error);
      return { ok: false, ...mapped, raw: payload };
    }

    const providerMessageId = (payload as { messages?: Array<{ id?: string }> })?.messages?.[0]?.id;

    if (!providerMessageId) {
      // A 200 without a wamid cannot be reconciled against a later receipt.
      // Marked retryable so the dispatch loop escalates to the reconciler
      // rather than silently recording a send that can never be confirmed.
      return {
        ok: false,
        retryable: true,
        errorCode: PROVIDER_ERROR.UNKNOWN,
        errorMessage: "accepted with no message id",
        raw: payload,
      };
    }

    return {
      ok: true,
      providerMessageId,
      // The Graph API returns no timestamp for an accepted message; this is
      // our clock, recorded as the attempt instant.
      acceptedAtUtc: new Date(),
      raw: payload,
    };
  }
}

function digits(value: string): string {
  return (value ?? "").replace(/\D/g, "");
}

function parseTimestamp(seconds: string | undefined): Date {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000) : new Date();
}

function toInboundMessage(message: MetaMessage, channelKey: string): InboundEvent | null {
  const base = {
    providerMessageId: message.id,
    from: toE164(message.from),
    to: channelKey,
    atUtc: parseTimestamp(message.timestamp),
    raw: message,
  };

  if (message.type === "button" && message.button) {
    return {
      ...base,
      kind: "button_reply",
      contextMessageId: message.context?.id,
      payload: message.button.payload ?? "",
      title: message.button.text ?? "",
    };
  }

  if (message.type === "interactive") {
    const reply = message.interactive?.button_reply;
    if (reply) {
      return {
        ...base,
        kind: "button_reply",
        contextMessageId: message.context?.id,
        payload: reply.id ?? "",
        title: reply.title ?? "",
      };
    }

    const listReply = message.interactive?.list_reply;
    if (listReply) {
      return {
        ...base,
        kind: "list_reply",
        contextMessageId: message.context?.id,
        rowId: listReply.id ?? "",
        title: listReply.title ?? "",
      };
    }
  }

  if (message.type === "text" && message.text) {
    return {
      ...base,
      kind: "text",
      contextMessageId: message.context?.id,
      text: message.text.body ?? "",
    };
  }

  if (!message.type) return null;

  return { ...base, kind: "unsupported", mediaType: message.type };
}

function toInboundStatus(status: MetaStatus): Extract<InboundEvent, { kind: "status" }> {
  const failure = status.errors?.[0];

  return {
    kind: "status",
    providerMessageId: status.id,
    status: (status.status ?? "failed") as "sent" | "delivered" | "read" | "failed",
    atUtc: parseTimestamp(status.timestamp),
    errorCode: failure?.code === undefined ? undefined : String(failure.code),
    errorTitle: failure?.title ?? failure?.message,
    callbackData: status.biz_opaque_callback_data,
    raw: status,
  };
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describeNetworkError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
