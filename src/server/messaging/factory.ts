import { env } from "@/server/env";
import type { MessagingProvider } from "./provider";
import { MockProvider } from "./providers/mock";
import { WhatsAppCloudProvider } from "./providers/whatsapp-cloud";

/**
 * Provider selection.
 *
 * One instance per process, pinned on globalThis for the same reason the Prisma
 * client is: Next.js re-evaluates modules on hot reload, and a rebuilt mock
 * would come with an empty outbox — the dev inbox would appear to erase itself
 * every time a file is saved.
 */

const globalForMessaging = globalThis as unknown as { __wasalMessaging?: MessagingProvider };

export function createMessagingProvider(name: string = env().MESSAGING_PROVIDER): MessagingProvider {
  return name === "whatsapp_cloud" ? new WhatsAppCloudProvider() : new MockProvider();
}

export function getMessagingProvider(): MessagingProvider {
  return (globalForMessaging.__wasalMessaging ??= createMessagingProvider());
}

/**
 * The mock behind the live provider, or null when real messages are configured.
 *
 * The dev inbox is a view of the mock, so it must not borrow the real
 * provider's identity just to stay reachable.
 */
export function getMockProvider(): MockProvider | null {
  const provider = getMessagingProvider();
  return provider instanceof MockProvider ? provider : null;
}

/** Test seam. Production never needs to rebuild the provider mid-process. */
export function resetMessagingProvider(): void {
  globalForMessaging.__wasalMessaging = undefined;
}
