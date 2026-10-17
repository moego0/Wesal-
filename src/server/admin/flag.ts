import { env } from "@/server/env";

/**
 * The `ENABLE_ADMIN` switch.
 *
 * Read at REQUEST time, in the body of the page, and deliberately nowhere else:
 *
 *   - Not in `src/proxy.ts`. That file avoids importing `@/server/env` on
 *     purpose — doing so would pull the Prisma client and the full env schema
 *     into the proxy bundle, which runs on every request.
 *   - Not in the prerendered part of a layout. Under `cacheComponents` the
 *     shell a layout renders is static, so a flag read there can be baked into
 *     the build output and then never change, however the deployment is
 *     reconfigured. `(app)/layout.tsx` does read this — inside `SessionBar`,
 *     which is wrapped in `<Suspense>` and already request-scoped because it
 *     resolves the session, so the read happens per request. The distinction is
 *     the component, not the file.
 *
 * `env()` is memoised, so this is restart-scoped rather than live: flipping
 * `ENABLE_ADMIN` takes effect on `docker compose up -d`, not on a page reload.
 * That is documented in both `.env` templates, because an operator who flips it
 * and sees no change will otherwise conclude the flag is broken.
 */

export function isAdminEnabled(): boolean {
  return env().ENABLE_ADMIN;
}
