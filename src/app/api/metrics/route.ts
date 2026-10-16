import type { NextRequest } from "next/server";
import { env } from "@/server/env";
import { checkBearerToken } from "@/server/metrics/auth";
import { collectMetrics } from "@/server/metrics/collect";
import { metrics } from "@/server/metrics/registry";

/**
 * The Prometheus scrape endpoint.
 *
 * ## Why the path is `/api/metrics`
 *
 * `src/proxy.ts` matches everything except `api`, `_next`, `monitoring` and
 * paths with a file extension. A root `/metrics` therefore DOES run through the
 * proxy, where next-intl rewrites it to `/ar/metrics` and the session gate
 * redirects it to the login page — so the obvious path is not the workable one.
 * Under `/api` the handler is exempt from the proxy and must do its own
 * authorization, which is what `checkBearerToken` above is.
 *
 * That also means this endpoint is NOT behind the app's session gate, so the
 * token is the only thing in front of it. Two further measures sit outside this
 * file: `deploy/Caddyfile` answers 404 for this path so it is not reachable from
 * the internet at all, and every value published is an aggregate that identifies
 * no patient and no pharmacy.
 *
 * ## Why these responses are shaped the way they are
 *
 * **Unconfigured is a 404, not a 401.** A deployment that never set
 * `METRICS_TOKEN` has no metrics endpoint — not an open one. Answering 401 would
 * advertise that there is something here worth authenticating to, and would
 * still hand an attacker an oracle to grind against.
 *
 * **A wrong token is a 401 with `WWW-Authenticate: Bearer`**, which is what the
 * scheme requires and what makes a misconfigured Prometheus easy to diagnose.
 *
 * ## Why there is no route segment config
 *
 * `dynamic`, `revalidate`, `fetchCache` and `dynamicParams` are build errors
 * under `cacheComponents`, and `runtime` is not exported either. None are needed:
 * this handler reads the request headers, so it can never prerender.
 */

export async function GET(req: NextRequest) {
  const expected = env().METRICS_TOKEN;

  if (!expected) {
    // Deliberately identical to what a nonexistent route returns.
    return new Response("Not found", { status: 404 });
  }

  if (!checkBearerToken(req.headers.get("authorization"), expected)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="metrics"' },
    });
  }

  // Failures are contained inside `collectMetrics`; this cannot throw.
  await collectMetrics();

  const { registry } = metrics();

  return new Response(await registry.metrics(), {
    headers: {
      "content-type": registry.contentType,
      // Nothing about a scrape is worth caching, and a cached one would freeze
      // the gauges at their values from whenever it was first fetched.
      "cache-control": "no-store",
    },
  });
}
