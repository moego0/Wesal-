import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The messaging provider boundary.
 *
 * Everything above this line — the dispatcher, the reconciler, the pharmacist's
 * inbox — works in the vocabulary defined here and never in Meta's. In
 * particular `SendResult.errorCode` is a name from `PROVIDER_ERROR`, not a
 * Graph API number: Meta's codes are sparse, shift meaning with the calling
 * context, and change without notice, so branching on them outside a provider
 * would turn the business logic into a mirror of a third party's release notes.
 */

export type E164 = string;

export type SendResult =
  | { ok: true; providerMessageId: string; acceptedAtUtc: Date; raw: unknown }
  | {
      ok: false;
      /**
       * Whether retrying could plausibly succeed. Providers translate their own
       * error taxonomies into this single boolean so that business logic never
       * has to know that Meta's 131047 means "re-engagement window expired".
       */
      retryable: boolean;
      errorCode: string;
      errorMessage: string;
      raw: unknown;
    };

export type SendTemplateRequest = {
  to: E164;
  templateName: string;
  languageCode: "ar" | "en";
  /**
   * Body parameters, keyed by name for readability but sent positionally in
   * insertion order: both the mock and the Cloud API take an ordered array, and
   * Meta addresses parameters by position, not by key. Callers must add them in
   * the order the approved template declares `{{1}}`, `{{2}}`, … Unordered
   * objects would lose the ordering entirely.
   */
  variables: Record<string, string>;
  callbackData: string;
  correlationId: string;
};

export type SendInteractiveRequest = {
  to: E164;
  bodyText: string;
  header?: { type: "text"; text: string };
  buttons?: Array<{ id: string; title: string }>; // max 3
  list?: { buttonText: string; rows: Array<{ id: string; title: string; description?: string }> };
  callbackData: string;
  correlationId: string;
};

export type SendTextRequest = {
  to: E164;
  bodyText: string;
  callbackData: string;
  correlationId: string;
};

export type InboundEvent =
  | {
      kind: "button_reply";
      providerMessageId: string;
      from: E164;
      to: E164;
      atUtc: Date;
      contextMessageId?: string;
      payload: string;
      title: string;
      raw: unknown;
    }
  | {
      kind: "list_reply";
      providerMessageId: string;
      from: E164;
      to: E164;
      atUtc: Date;
      contextMessageId?: string;
      rowId: string;
      title: string;
      raw: unknown;
    }
  | {
      kind: "text";
      providerMessageId: string;
      from: E164;
      to: E164;
      atUtc: Date;
      contextMessageId?: string;
      text: string;
      raw: unknown;
    }
  | {
      kind: "unsupported";
      providerMessageId: string;
      from: E164;
      to: E164;
      atUtc: Date;
      mediaType?: string;
      raw: unknown;
    }
  | {
      kind: "status";
      providerMessageId: string;
      status: "sent" | "delivered" | "read" | "failed";
      atUtc: Date;
      /**
       * The PROVIDER's diagnostic code and title, deliberately not translated
       * into `PROVIDER_ERROR`. Unlike `SendResult.errorCode` — a decision input
       * the business logic branches on — these are forensic detail about one
       * delivery, and flattening 131026 ("undeliverable") into a category would
       * throw away the only thing that distinguishes it from the next
       * undeliverable. Persist them; do not switch on them.
       */
      errorCode?: string;
      errorTitle?: string;
      callbackData?: string;
      raw: unknown;
    }
  | {
      kind: "template_status";
      providerTemplateId: string;
      name: string;
      languageCode: string;
      status: string;
      reason?: string;
      raw: unknown;
    };

/** What a provider can do. Feature-detected rather than assumed. */
export type ProviderCapabilities = {
  supportsListMessages: boolean;
  /**
   * Maximum reply buttons on ONE interactive message. WhatsApp allows 3 and
   * rejects a fourth with a non-retryable 4xx — so the limit has to be a
   * capability the sender checks, not a fact people remember. The refinement
   * menus are sized against this.
   */
  maxReplyButtons: number;
  maxListRows: number;
  /**
   * Whether a free-form interactive message may be sent inside the 24-hour
   * customer service window. True for WhatsApp Cloud API; a provider that
   * cannot do this (an SMS gateway, say) makes every reminder use a template.
   */
  supportsFreeFormWithinSessionWindow: boolean;
  /** How long the customer service window lasts. WhatsApp: 24h. */
  sessionWindowHours: number;
  supportsBizOpaqueCallbackData: boolean;
  /**
   * False for WhatsApp Cloud API templates: button payloads are fixed at
   * approval time and cannot carry a per-message event id. A template tap then
   * arrives with NO payload — only `context.id` and the button's label — which
   * is what forces the label-matching path in `answerFromButtonLabel`.
   */
  supportsTemplateButtonPayloads: boolean;
};

/** Independent of any provider's wire format. Superset of the provider union. */
export type InboundKind =
  | "BUTTON_REPLY"
  | "LIST_REPLY"
  | "TEXT"
  | "MEDIA"
  | "STATUS_UNSUPPORTED"
  | "UNKNOWN"
  | "UNSUPPORTED";

/**
 * Flat projection of an inbound event, for consumers that only care what the
 * patient did (response attribution, delivery reconciliation).
 *
 * Distinct from the provider's own discriminated `InboundEvent`, which models
 * Meta's payload tree. Two shapes exist on purpose: the provider union keeps
 * provider quirks out of application code, and this one keeps application code
 * from having to pattern-match on them. `normalizeInboundEvents()` converts one
 * into the other.
 *
 * `toPhoneE164` is the receiving CHANNEL key — Meta's `phone_number_id` for the
 * Cloud API — not a human's number: it is what `MessagingChannel` is keyed by,
 * so it is the field that resolves a webhook to a pharmacy. Typed as E164
 * because `InboundEvent.to` is, and a `to` that silently means two different
 * things depending on direction would be worse than a name that reads oddly.
 */
export type NormalizedInboundEvent = {
  providerMessageId: string;
  providerTimestamp: Date;
  fromPhoneE164: E164;
  toPhoneE164: E164;
  kind: InboundKind;
  /**
   * The explicit id the tap carried, or null.
   *
   * Null is the NORMAL case for a template button: its payload is fixed at
   * approval time and cannot carry a per-message event id, so a null here means
   * "attribute from `contextMessageId`, not from this".
   */
  buttonPayload: string | null;
  /** List replies only; the row id, kept apart from `buttonPayload`. */
  rowId: string | null;
  /**
   * The visible LABEL of the button or list row the patient chose.
   *
   * Load-bearing rather than cosmetic: a template tap carries no usable payload,
   * so the label is the only remaining signal about *what* the patient answered.
   * `answerFromButtonLabel()` in `@/server/messaging/menu` matches against it —
   * which is why the outbound labels and the inbound matcher live in one file.
   */
  title: string | null;
  /** For media messages. */
  mediaType: string | null;
  /**
   * `context.id` — the wamid of the message the patient replied to or tapped.
   * The only attribution channel available for template replies.
   */
  contextMessageId: string | null;
  text: string | null;
  raw: unknown;
};

export type NormalizedStatusCallback = {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  atUtc: Date;
  /** Carries back whatever was passed as `callbackData` on send, when the provider round-trips it. */
  callbackData?: string;
  error?: { code?: string; title?: string };
  raw: unknown;
};

function orNull(value: string | undefined | null): string | null {
  return value === undefined || value === null || value.trim() === "" ? null : value;
}

/**
 * Split a parsed webhook into the two streams its consumers actually want:
 * things the patient said, and delivery receipts.
 *
 * `template_status` events are dropped — they are channel operations, not
 * per-message state, and belong to a template sync job rather than to the
 * response path.
 */
export function normalizeInboundEvents(events: InboundEvent[]): {
  messages: NormalizedInboundEvent[];
  statuses: NormalizedStatusCallback[];
} {
  const messages: NormalizedInboundEvent[] = [];
  const statuses: NormalizedStatusCallback[] = [];

  for (const event of events) {
    if (event.kind === "status") {
      statuses.push({
        providerMessageId: event.providerMessageId,
        status: event.status,
        atUtc: event.atUtc,
        callbackData: event.callbackData,
        error:
          event.errorCode || event.errorTitle
            ? { code: event.errorCode, title: event.errorTitle }
            : undefined,
        raw: event.raw,
      });
      continue;
    }

    if (event.kind === "template_status") continue;

    const base = {
      providerMessageId: event.providerMessageId,
      providerTimestamp: event.atUtc,
      fromPhoneE164: event.from,
      toPhoneE164: event.to,
      raw: event.raw,
    };

    if (event.kind === "button_reply") {
      messages.push({
        ...base,
        kind: "BUTTON_REPLY",
        buttonPayload: orNull(event.payload),
        rowId: null,
        title: orNull(event.title),
        mediaType: null,
        contextMessageId: orNull(event.contextMessageId),
        text: null,
      });
    } else if (event.kind === "list_reply") {
      messages.push({
        ...base,
        kind: "LIST_REPLY",
        buttonPayload: orNull(event.rowId),
        rowId: orNull(event.rowId),
        title: orNull(event.title),
        mediaType: null,
        contextMessageId: orNull(event.contextMessageId),
        text: null,
      });
    } else if (event.kind === "text") {
      messages.push({
        ...base,
        kind: "TEXT",
        buttonPayload: null,
        rowId: null,
        title: null,
        mediaType: null,
        contextMessageId: orNull(event.contextMessageId),
        text: event.text,
      });
    } else {
      messages.push({
        ...base,
        kind: event.mediaType ? "MEDIA" : "UNKNOWN",
        buttonPayload: null,
        rowId: null,
        title: null,
        mediaType: orNull(event.mediaType),
        contextMessageId: null,
        text: null,
      });
    }
  }

  return { messages, statuses };
}

export function normalizeInboundEvent(
  event: InboundEvent,
): NormalizedInboundEvent | NormalizedStatusCallback | null {
  const { messages, statuses } = normalizeInboundEvents([event]);
  return messages[0] ?? statuses[0] ?? null;
}


export interface MessagingProvider {
  readonly name: string;
  sendTemplate(req: SendTemplateRequest): Promise<SendResult>;
  sendInteractive(req: SendInteractiveRequest): Promise<SendResult>;
  sendText(req: SendTextRequest): Promise<SendResult>;
  verifyWebhookSignature(headers: Record<string, string | undefined>, rawBody: Buffer): boolean;
  handleVerificationChallenge(query: Record<string, string>): { status: number; body: string } | null;
  parseWebhook(rawBody: Buffer): InboundEvent[];
  capabilities(): ProviderCapabilities;
  sessionWindowOpen(to: E164, lastInboundAtUtc: Date | null, nowUtc: Date): boolean;
  healthCheck(): Promise<{ healthy: boolean; detail?: string }>;
}

/**
 * Names for the errors business logic is allowed to see. Every provider maps
 * its own error surface onto this set; a code that is not in here has leaked.
 */
export const PROVIDER_ERROR = {
  OUTSIDE_SESSION_WINDOW: "outside_session_window",
  TEMPLATE_NOT_FOUND: "template_not_found",
  TEMPLATE_PARAM_MISMATCH: "template_param_mismatch",
  TEMPLATE_PAUSED: "template_paused",
  UNDELIVERABLE: "undeliverable",
  INVALID_RECIPIENT: "invalid_recipient",
  INVALID_REQUEST: "invalid_request",
  RATE_LIMITED: "rate_limited",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  NETWORK_ERROR: "network_error",
  NETWORK_TIMEOUT: "network_timeout",
  UNKNOWN: "unknown_provider_error",
} as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR)[keyof typeof PROVIDER_ERROR];

/**
 * The customer service window, in hours.
 *
 * Meta's rule and ours are the same number, and the product depends on it
 * exactly: outside it only an approved template may be sent, so a free-form
 * message sent a minute late is a hard rejection, not a queued one.
 */
export const SESSION_WINDOW_HOURS = 24;

/**
 * True while a free-form message is permitted. A future `lastInboundAtUtc`
 * counts as open — clock skew between our server and Meta's must not lock a
 * patient out of a conversation they are actively having.
 */
export function isWithinSessionWindow(
  lastInboundAtUtc: Date | null,
  nowUtc: Date,
  windowHours: number = SESSION_WINDOW_HOURS,
): boolean {
  if (lastInboundAtUtc === null) return false;
  return nowUtc.getTime() - lastInboundAtUtc.getTime() < windowHours * 3_600_000;
}

/**
 * Normalize a provider-supplied number to E.164.
 *
 * Meta sends `from` as bare digits with the country code ("201234567890"), and
 * every column in the schema is E.164, so this cannot be deferred to the
 * callers. Falls back to a bare `+digits` rather than dropping the message: an
 * unparseable number is still a real patient replying.
 */
export function toE164(raw: string): E164 {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return "";

  const digits = trimmed.replace(/\D/g, "");
  return digits === "" ? "" : `+${digits}`;
}

/**
 * `X-Hub-Signature-256: sha256=<hex hmac>`, computed over the RAW request body.
 *
 * Both providers share this implementation on purpose. The subtle failure mode
 * — re-serializing the parsed JSON before hashing, which passes every
 * hand-written test and rejects every real delivery — is exactly the sort of
 * thing that reappears the moment there are two copies of it.
 */
export function signHmacSha256(secret: string, rawBody: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Header names are case-insensitive per RFC 9110; the caller may not lower-case them. */
export function readSignatureHeader(headers: Record<string, string | undefined>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "x-hub-signature-256") return value;
  }
  return undefined;
}

/**
 * Fails closed. An unset secret, a missing header, or a length mismatch all
 * reject: a deployment that forgot to configure the app secret must not accept
 * unsigned bodies, and `timingSafeEqual` throws on unequal lengths rather than
 * returning false.
 */
export function verifyHmacSha256(
  secret: string,
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  if (!secret || !signature) return false;

  const expected = Buffer.from(signHmacSha256(secret, rawBody));
  const actual = Buffer.from(signature.trim().toLowerCase());

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Meta's webhook handshake: echo `hub.challenge` when the token matches.
 *
 * Returns null when this is not a verification request at all, so the route can
 * tell "wrong token" (403) from "not a handshake" (400).
 */
export function runVerificationChallenge(
  query: Record<string, string>,
  verifyToken: string,
): { status: number; body: string } | null {
  if (query["hub.mode"] !== "subscribe") return null;

  const provided = query["hub.verify_token"] ?? "";
  if (!verifyToken || !secretEquals(provided, verifyToken)) {
    return { status: 403, body: "Forbidden" };
  }

  return { status: 200, body: query["hub.challenge"] ?? "" };
}
