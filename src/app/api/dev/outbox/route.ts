import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { getMockProvider } from "@/server/messaging/factory";
import { parseAndPersistInbound } from "@/server/messaging/inbound";
import { reminderButtons, templateButtons } from "@/server/messaging/menu";
import { MockProvider } from "@/server/messaging/providers/mock";

/**
 * Dev inbox for the mock provider.
 *
 * Everything the mock sends lands in an in-memory outbox; this endpoint is the
 * window onto it, and the POST actions are how a developer "taps" a button.
 *
 * Every action that produces inbound goes through the SAME three steps the real
 * webhook takes — sign, verify, persist — so the dev path cannot quietly
 * diverge from the one Meta uses.
 *
 * Absent in production, and absent when the live provider is not the mock: a
 * door left open for convenience is a door.
 */

export async function GET(req: NextRequest) {
  const mock = devMock();
  if (mock instanceof Response) return mock;

  const full = req.nextUrl.searchParams.get("full") === "1";

  return Response.json({
    provider: mock.name,
    channelKey: mock.channelKey(),
    nowUtc: mock.now(),
    capabilities: mock.capabilities(),
    outbox: mock.outbox().map((row) => ({
      ...row,
      // The full request carries whole message bodies; opt in.
      request: full ? row.request : undefined,
      canTap: row.providerMessageId !== null,
    })),
    inbound: mock.inboundLog().slice(-20),
  });
}

export async function POST(req: NextRequest) {
  const mock = devMock();
  if (mock instanceof Response) return mock;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest("expected a JSON body");
  }

  try {
    return await dispatch(mock, body);
  } catch (error) {
    if (error instanceof BadRequest) return badRequest(error.message);
    throw error;
  }
}

async function dispatch(mock: MockProvider, body: Record<string, unknown>): Promise<Response> {
  const action = str(body.action);

  switch (action) {
    case "send": {
      const to = need(body, "to");
      const { send, templateButtons } = await demo(mock, to, body);
      return Response.json({ ok: true, result: send, templateButtons });
    }

    case "button_reply":
      return wire(mock, mock.simulateButtonReply(need(body, "providerMessageId"), {
        buttonIndex: num(body.buttonIndex),
      }));

    case "list_reply":
      return wire(mock, mock.simulateListReply(need(body, "providerMessageId"), {
        rowIndex: num(body.rowIndex),
      }));

    case "template_reply":
      return wire(mock, mock.simulateTemplateReply(need(body, "providerMessageId"), {
        button: str(body.button),
        payload: typeof body.payload === "string" ? body.payload : undefined,
      }));

    case "text_reply":
      return wire(mock, mock.simulateTextReply({
        from: need(body, "from"),
        text: str(body.text) ?? "",
        contextMessageId: str(body.contextMessageId),
      }));

    case "media":
      return wire(mock, mock.simulateMedia({ from: need(body, "from"), mediaType: str(body.mediaType) }));

    case "status":
      return wire(mock, mock.simulateStatusCallback(
        need(body, "providerMessageId"),
        (str(body.status) ?? "delivered") as "sent" | "delivered" | "read" | "failed",
        {
          delayMs: num(body.delayMs),
          errorCode: str(body.errorCode),
          errorTitle: str(body.errorTitle),
        },
      ));

    case "template_status":
      return wire(mock, mock.simulateTemplateStatus({
        name: need(body, "name"),
        languageCode: str(body.languageCode),
        status: str(body.status),
        reason: str(body.reason),
      }));

    case "advance_clock": {
      const toUtc = str(body.toUtc);
      const byMs = num(body.byMs);
      mock.advanceTo(toUtc ? new Date(toUtc) : new Date(mock.now().getTime() + (byMs ?? 0)));
      return Response.json({ ok: true, nowUtc: mock.now() });
    }

    case "fail_next":
      mock.failNext(num(body.count) ?? 1, {
        retryable: body.retryable !== false,
        errorCode: str(body.errorCode),
        errorMessage: str(body.errorMessage),
      });
      return Response.json({ ok: true });

    case "clear":
      mock.reset();
      return Response.json({ ok: true });

    default:
      return badRequest(
        `unknown action ${JSON.stringify(action)}; expected one of send, button_reply, list_reply, ` +
          `template_reply, text_reply, media, status, template_status, advance_clock, fail_next, clear`,
      );
  }
}

/** The same sign → verify → persist sequence the webhook route performs. */
async function wire(mock: MockProvider, rawBody: Buffer): Promise<Response> {
  const headers = { "x-hub-signature-256": mock.signBody(rawBody) };

  if (!mock.verifyWebhookSignature(headers, rawBody)) {
    return Response.json({ ok: false, error: "signature rejected" }, { status: 401 });
  }

  const result = await parseAndPersistInbound(mock, rawBody);

  return Response.json({
    ok: true,
    duplicates: result.duplicates,
    rows: result.rows.map(({ row, duplicate }) => ({
      id: row.id,
      pharmacyId: row.pharmacyId,
      channelId: row.channelId,
      type: row.type,
      contextMessageId: row.contextMessageId,
      processingStatus: row.processingStatus,
      duplicate,
    })),
    statuses: result.statuses,
  });
}

function devMock(): MockProvider | Response {
  if (process.env.NODE_ENV === "production") return new Response("Not found", { status: 404 });

  const mock = getMockProvider();
  if (!mock) {
    return new Response("The dev inbox only exists while MESSAGING_PROVIDER=mock", { status: 404 });
  }

  return mock;
}

/** Send something a developer can then tap, and report what they would be tapping. */
async function demo(mock: MockProvider, to: string, body: Record<string, unknown>) {
  if (body.asTemplate === true) {
    const send = await mock.sendTemplate({
      to,
      templateName: str(body.templateName) ?? "dose_reminder_ar",
      languageCode: "ar",
      variables: { "1": str(body.bodyText) ?? "الميتفورمين 500mg" },
      callbackData: "dev-dispatch",
      correlationId: "dev",
    });

    return {
      send,
      // The buttons the approved template carries. Their payloads are empty,
      // exactly as in production — attribution has to come from the context id
      // and the label, which is what this demo exists to make visible.
      templateButtons: templateButtons(),
    };
  }

  return {
    send: await mock.sendInteractive({
      to,
      bodyText: str(body.bodyText) ?? "هل أخذت جرعة الصباح؟",
      // Free-form messages DO get a per-message id: we choose the button ids
      // here, which is the one case where a payload is authoritative.
      buttons: reminderButtons(str(body.reminderEventId) ?? `dev-${randomUUID()}`),
      callbackData: "dev-dispatch",
      correlationId: "dev",
    }),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function need(body: Record<string, unknown>, field: string): string {
  const value = str(body[field]);
  if (!value) throw new BadRequest(`${field} is required`);
  return value;
}

function badRequest(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}

class BadRequest extends Error {}
