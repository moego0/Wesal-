import { InboundStatus } from "@/generated/prisma/enums";
import { Prisma, type InboundMessage } from "@/generated/prisma/client";
import { prisma, systemPrisma } from "@/server/db";
import { normalizeInboundEvents, type InboundEvent, type MessagingProvider } from "./provider";

/**
 * Inbound webhook handling.
 *
 * The contract with Meta is: acknowledge quickly, then do the thinking
 * elsewhere. Meta times the response out in seconds and redelivers on anything
 * that is not a 2xx, so a webhook that attributes a response inline is a
 * webhook that replays a patient's tap every time the database hiccups.
 */

export type InboundMessageEvent = Extract<
  InboundEvent,
  { kind: "button_reply" | "list_reply" | "text" | "unsupported" }
>;

export type PersistedInboundMessage = {
  event: InboundMessageEvent;
  row: InboundMessage;
  /** The unique constraint caught a redelivery. Not an error. */
  duplicate: boolean;
};

export type InboundResult = {
  /** Everything the provider recognized, receipts included. */
  events: InboundEvent[];
  /** Things the patient did, normalized. */
  messages: ReturnType<typeof normalizeInboundEvents>["messages"];
  /** Delivery receipts, normalized for `applyDeliveryCallback()`. */
  statuses: ReturnType<typeof normalizeInboundEvents>["statuses"];
  /** Rows created — or already present, for a redelivery. */
  rows: PersistedInboundMessage[];
  duplicates: number;
};

/**
 * What goes into `InboundMessage.rawPayload`.
 *
 * The normalized form is what processing reads — the schema has no
 * `buttonPayload` or `title` column, so a drain that only had the provider's
 * payload tree would have to re-derive them, and would re-derive them
 * differently the day a provider changes its envelope. The raw form is kept
 * beside it so the original is never lost to a normalizer bug.
 */
export type InboundRawEnvelope = {
  normalized: ReturnType<typeof normalizeInboundEvents>["messages"][number];
  raw: unknown;
};

/**
 * Normalize a webhook body and persist its messages.
 *
 * Receipts are returned but deliberately not persisted: `InboundMessage` is the
 * record of something a PATIENT sent, and a receipt's wamid identifies an
 * outbound dispatch. Storing both in one table would put rows in the inbound
 * feed that no patient ever sent.
 */
export async function parseAndPersistInbound(
  provider: MessagingProvider,
  rawBody: Buffer,
): Promise<InboundResult> {
  const events = provider.parseWebhook(rawBody);
  const { messages, statuses } = normalizeInboundEvents(events);

  let parsedBody: unknown;
  let parsed = false;
  const originalBody = () => {
    if (!parsed) {
      parsed = true;
      try {
        parsedBody = JSON.parse(rawBody.toString("utf8"));
      } catch {
        // Stored rather than dropped: a body we could not parse is a provider
        // change we need to see, not silence.
        parsedBody = { unparseable: rawBody.toString("utf8").slice(0, 4096) };
      }
    }
    return parsedBody;
  };

  const rows: PersistedInboundMessage[] = [];
  // `messages` preserves the order of the message-shaped events, so the two
  // sequences line up one for one.
  let index = 0;

  for (const event of events) {
    if (event.kind === "status" || event.kind === "template_status") continue;
    rows.push(await persist(event, { normalized: messages[index++], raw: originalBody() }));
  }

  return {
    events,
    messages,
    statuses,
    rows,
    duplicates: rows.filter((row) => row.duplicate).length,
  };
}

async function persist(
  event: InboundMessageEvent,
  envelope: InboundRawEnvelope,
): Promise<PersistedInboundMessage> {
  // `unsupported` carries no context: media has nothing in the payload the
  // patient could have tapped in reply to, and inventing a null there would
  // look like a missing attribution rather than an absent concept.
  const contextMessageId = event.kind === "unsupported" ? null : (event.contextMessageId ?? null);

  // systemPrisma, not prisma: the pharmacy is the thing being resolved from the
  // message, so it cannot also be the filter. This is the call the unguarded
  // client exists for.
  const channel = await systemPrisma.messagingChannel.findUnique({
    where: { providerPhoneNumberId: event.to },
  });

  try {
    const row = await systemPrisma.inboundMessage.create({
      data: {
        pharmacyId: channel?.pharmacyId ?? null,
        providerMessageId: event.providerMessageId,
        fromPhoneE164: event.from,
        // The channel's own number when it resolved; otherwise the raw routing
        // key. Dropping it for an unrouted message would discard the only
        // handle we have on which channel it arrived at.
        toPhoneE164: channel?.displayPhoneE164 ?? event.to,
        channelId: channel?.id ?? null,
        type: event.kind,
        contextMessageId,
        rawPayload: envelope as never,
        receivedAtUtc: event.atUtc,
        processingStatus: channel ? InboundStatus.RECEIVED : InboundStatus.UNROUTED,
      },
    });

    return { event, row, duplicate: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // A redelivery hits the unique index on providerMessageId. Returning the
    // existing row treats it as the no-op it is; letting it escape would turn
    // into a 500, which Meta answers by redelivering again, forever.
    const existing = await systemPrisma.inboundMessage.findUnique({
      where: { providerMessageId: event.providerMessageId },
    });

    if (!existing) throw error;
    return { event, row: existing, duplicate: true };
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === "P2002";
  // The driver adapter does not always surface the Prisma error class.
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

export type PatientSessionWindow = {
  open: boolean;
  lastInboundAtUtc: Date | null;
  /** When the window closes. Null when it never opened. */
  closesAtUtc: Date | null;
};

/**
 * The customer service window for one patient.
 *
 * Governs whether a free-form message may be sent at all: outside the window
 * only an approved template reaches the patient, so this is checked before the
 * message is built, not after Meta refuses it.
 *
 * Null means the patient does not exist as far as this client can see. The read
 * goes through the tenant-guarded client and addresses the row by primary key,
 * so the caller must already hold an id obtained under a pharmacy filter.
 */
export async function computePatientSessionWindow(
  provider: MessagingProvider,
  patientId: string,
  nowUtc: Date = new Date(),
): Promise<PatientSessionWindow | null> {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { phoneE164: true, lastInboundAtUtc: true },
  });

  if (!patient) return null;

  return {
    open: provider.sessionWindowOpen(patient.phoneE164, patient.lastInboundAtUtc, nowUtc),
    lastInboundAtUtc: patient.lastInboundAtUtc,
    closesAtUtc: patient.lastInboundAtUtc
      ? new Date(patient.lastInboundAtUtc.getTime() + provider.capabilities().sessionWindowHours * 3_600_000)
      : null,
  };
}
