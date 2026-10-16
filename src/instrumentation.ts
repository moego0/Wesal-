import type { Instrumentation } from "next";

/**
 * Next.js instrumentation hooks.
 *
 * ## What this file is for
 *
 * `register()` runs once when a server instance starts, which is the only place
 * the metrics registry can be built at boot rather than at the first scrape.
 * Starting `collectDefaultMetrics` here means the `nodejs_*` series — event loop
 * lag above all — begin measuring when the process does, so the history that
 * explains an incident is not missing its first minutes.
 *
 * `onRequestError` is the only hook Next exposes for request failures. It fires
 * for an error that reached a boundary, which makes it a counter of real faults
 * rather than of handled 4xx responses.
 *
 * ## What this file deliberately does NOT do
 *
 * There is **no request-latency histogram here**, and that is a limitation
 * rather than an oversight. `onRequestError` fires only on errors and `register`
 * fires once at boot, so Next 16 offers no hook that sees a successful request
 * end — and therefore no honest way to measure its duration. A histogram built
 * from the wrong hook would report the latency of failures as if it were the
 * latency of traffic.
 *
 * Real request latency and the edge error rate come from **Caddy's** metrics
 * instead (`deploy/Caddyfile` exposes its admin endpoint, `prometheus.yml`
 * scrapes it). Caddy terminates every request this app serves, so it measures
 * the thing this file cannot. See `docs/DEPLOY.md`.
 *
 * ## The runtime guard
 *
 * The registry is Node-only: it reaches Postgres and Redis through `ops.ts`.
 * Importing it into an edge bundle would fail at run time, and the cost of
 * being wrong about which runtime this is would be an instrumentation failure
 * that takes the whole server down. The dynamic import is what keeps the module
 * out of the edge graph, and the guard is what stops it being evaluated there.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;

  const { initMetrics } = await import("@/server/metrics/registry");
  initMetrics();
}

export const onRequestError: Instrumentation.onRequestError = async (
  _err,
  _request,
  context,
) => {
  if (process.env.NEXT_RUNTIME === "edge") return;

  const { metrics } = await import("@/server/metrics/registry");

  /*
   * Labelled by `context.routePath`, which is the ROUTE FILE path — e.g.
   * `/app/[locale]/(app)/settings/users` — not the requested URL.
   *
   * That distinction is the whole reason this label is safe. Labelling on
   * `request.path` would create a series per distinct URL, and this app's URLs
   * contain patient ids: `/ar/patients/clx8…`. The metric would grow without
   * bound and, worse, would put patient identifiers into a time-series database
   * that the PDPL position in the README has not cleared for patient data.
   * `routePath` is bounded by the number of route files, which is a number that
   * changes when someone writes code and never when a patient uses the app.
   *
   * `routeType` is one of four values (`render`, `route`, `action`, `proxy`)
   * and is bounded by definition.
   */
  metrics().httpRequestErrors.labels(context.routeType, context.routePath).inc();
};
