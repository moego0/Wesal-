import { Counter, Gauge, Registry, collectDefaultMetrics } from "@prometheus-io/client";

/**
 * The metrics registry — one per process, declared once.
 *
 * ## Why the singleton is pinned on globalThis
 *
 * Next.js re-evaluates modules on hot reload, and a bundler may place this file
 * in more than one server chunk: the `instrumentation.ts` graph and the route
 * handler's graph are separate entry points. Either path leads to the same
 * failure. In the loud version, a second evaluation calls `new Gauge(...)` over
 * a registry that already holds that name and the process dies with
 * `A metric with the name X has already been registered`. In the quiet version
 * the route ends up holding a DIFFERENT Registry from the one
 * `instrumentation.ts` populated, and serves an empty scrape while every
 * container reports healthy.
 *
 * Pinning it here fixes both, and is the pattern `@/server/db` and
 * `@/server/messaging/factory` already use for the Prisma client and the
 * messaging provider. `serverExternalPackages` in next.config.ts is the other
 * half — it keeps the library's own module-level state out of the bundler.
 *
 * ## Why the gauges are declared even though a scrape fills them
 *
 * A Gauge that is never `.set()` emits no series, so a collector that throws
 * would produce an empty scrape that looks identical to a healthy system with
 * nothing to report. `collect.ts` resets and repopulates every one of these on
 * each scrape, and stamps `wasal_metrics_collector_error` when a collector
 * fails, so "no data" is never ambiguous.
 */

function create() {
  const registry = new Registry();

  // `nodejs_*` and `process_*`: heap, event loop lag, GC, open handles. These
  // are what tell a scrape storm apart from a leak when the box starts
  // swapping, and they cost nothing to collect.
  const defaults = collectDefaultMetrics({ register: registry });

  const sweepRunAge = new Gauge({
    name: "wasal_sweep_last_run_age_seconds",
    help: "Seconds since a sweep last recorded a heartbeat. -1 means it has never run.",
    labelNames: ["sweep"],
    registers: [registry],
  });

  const sweepDuration = new Gauge({
    name: "wasal_sweep_last_duration_milliseconds",
    help: "How long the sweep's most recent run took, in milliseconds.",
    labelNames: ["sweep"],
    registers: [registry],
  });

  const sweepStale = new Gauge({
    name: "wasal_sweep_stale",
    help: "1 when the sweep is past its watchdog threshold, 0 when it is on time.",
    labelNames: ["sweep"],
    registers: [registry],
  });

  const sweepHasError = new Gauge({
    name: "wasal_sweep_has_error",
    help: "1 when the sweep's most recent run recorded an error, 0 otherwise.",
    labelNames: ["sweep"],
    registers: [registry],
  });

  const queueJobs = new Gauge({
    name: "wasal_queue_jobs",
    help: "BullMQ job counts by queue and state.",
    labelNames: ["queue", "state"],
    registers: [registry],
  });

  const inboundUnrouted = new Gauge({
    name: "wasal_inbound_unrouted",
    help: "Inbound messages that matched no messaging channel, across all pharmacies.",
    registers: [registry],
  });

  const inboundUnprocessed = new Gauge({
    name: "wasal_inbound_unprocessed",
    help: "Inbound messages persisted but not yet turned into a patient response.",
    registers: [registry],
  });

  const dispatchFailedRecent = new Gauge({
    name: "wasal_dispatch_failed_recent",
    help: "Reminder dispatches that failed within the window, by window.",
    labelNames: ["window"],
    registers: [registry],
  });

  const dispatchAttemptingOverdue = new Gauge({
    name: "wasal_dispatch_attempting_overdue",
    help: "Dispatches stuck in ATTEMPTING past the reconciler's threshold.",
    registers: [registry],
  });

  const messagingChannels = new Gauge({
    name: "wasal_messaging_channels",
    help: "Messaging channels by bucketed status. Unknown values are reported as OTHER.",
    labelNames: ["status"],
    registers: [registry],
  });

  const whatsappTemplates = new Gauge({
    name: "wasal_whatsapp_templates",
    help: "WhatsApp template records by status and bucketed language.",
    labelNames: ["status", "language"],
    registers: [registry],
  });

  const collectorError = new Gauge({
    name: "wasal_metrics_collector_error",
    help: "1 when a collector failed during the most recent scrape, 0 when it succeeded.",
    labelNames: ["collector"],
    registers: [registry],
  });

  // The one counter. The gauges above are pull-based snapshots recomputed from
  // Postgres on every scrape, so a counter model would reset on each restart and
  // report a rate that never happened. This one accumulates genuine events.
  const httpRequestErrors = new Counter({
    name: "wasal_http_request_errors_total",
    help: "Requests that reached an error boundary, by route type and route path.",
    labelNames: ["route_type", "route_path"],
    registers: [registry],
  });

  return {
    registry,
    defaults,
    sweepRunAge,
    sweepDuration,
    sweepStale,
    sweepHasError,
    queueJobs,
    inboundUnrouted,
    inboundUnprocessed,
    dispatchFailedRecent,
    dispatchAttemptingOverdue,
    messagingChannels,
    whatsappTemplates,
    collectorError,
    httpRequestErrors,
  };
}

export type Metrics = ReturnType<typeof create>;

const globalForMetrics = globalThis as unknown as { __wasalMetrics?: Metrics };

export function metrics(): Metrics {
  return (globalForMetrics.__wasalMetrics ??= create());
}

/**
 * Called from `instrumentation.ts` so the default collectors start at boot
 * rather than at the first scrape. Without this, `nodejs_*` would begin
 * measuring whenever Prometheus first happened to ask, and the event-loop-lag
 * history that explains an incident would postdate it.
 *
 * Safe to call more than once — `metrics()` is the singleton and
 * `collectDefaultMetrics` is imported from a package the bundler externalizes.
 */
export function initMetrics(): void {
  metrics();
}
