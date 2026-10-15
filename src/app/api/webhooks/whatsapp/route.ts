import type { NextRequest } from "next/server";
import { getMessagingProvider } from "@/server/messaging/factory";
import { parseAndPersistInbound } from "@/server/messaging/inbound";

/**
 * Meta's webhook endpoint.
 *
 * The shape of this file is dictated by Meta's retry policy, not by taste:
 *
 *   - Verification is a GET handshake that echoes `hub.challenge`.
 *   - Signature verification hashes the RAW body. `JSON.stringify` of a parsed
 *     body is not byte-identical to what was posted, so any handler that parses
 *     before it verifies rejects every genuine delivery.
 *   - A redelivery is normal, not an error. The insert is deduplicated by the
 *     unique `providerMessageId`, so the second copy is a no-op that still
 *     returns 200 — whereas a 500 makes Meta redeliver again, and again.
 *   - Nothing is attributed inline. The row records the tap; the worker drains
 *     it. Meta's tolerance for a slow response is measured in seconds.
 *
 * `export const dynamic` is deliberately absent: route segment config for
 * caching no longer applies with cacheComponents enabled, and this handler
 * never prerenders because it reads the request.
 */

export async function GET(req: NextRequest) {
  const challenge = getMessagingProvider().handleVerificationChallenge(
    Object.fromEntries(req.nextUrl.searchParams),
  );

  // Not a handshake at all — nobody should be reaching this endpoint by hand.
  if (!challenge) return new Response("Not a verification request", { status: 400 });

  return new Response(challenge.body, {
    status: challenge.status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function POST(req: NextRequest) {
  const provider = getMessagingProvider();

  // Before parsing. See the note above about what re-serializing costs.
  const rawBody = Buffer.from(await req.arrayBuffer());

  if (!provider.verifyWebhookSignature(Object.fromEntries(req.headers), rawBody)) {
    return new Response("Invalid signature", { status: 401 });
  }

  try {
    const result = await parseAndPersistInbound(provider, rawBody);

    return Response.json({
      received: true,
      messages: result.rows.length,
      duplicates: result.duplicates,
      statuses: result.statuses.length,
    });
  } catch (error) {
    // Answering 200 here would drop the delivery permanently: Meta only
    // retries a non-2xx, and it is the only retry we are going to get.
    console.error("[whatsapp-webhook] could not persist inbound", error);
    return new Response("Persistence failed", { status: 500 });
  }
}
