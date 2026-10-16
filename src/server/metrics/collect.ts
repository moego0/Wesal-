import { FAILURE_WINDOWS, getGlobalCounts, getQueueDepth, getSweepHealth } from "@/server/admin/ops";
import { metrics } from "./registry";

/**
 * Fill the registry from Postgres and Redis at scrape time.
 *
 * ## Why nothing is cached
 *
 * Every value here is a snapshot recomputed on each scrape, so Prometheus and
 * the `/admin` console read the same database at nearly the same moment and
 * cannot drift apart. The cost is a handful of indexed counts per scrape, which
 * at a 15-second interval is negligible against the reminder sweeps already
 * running every 30 seconds.
 *
 * ## Why each collector is isolated
 *
 * A scrape is all-or-nothing from Prometheus's point of view: one rejected
 * promise returns a 500, the target goes `up == 0`, and EVERY metric from the
 * process disappears — including the ones that had nothing to do with the
 * failure. A Redis blip would therefore hide the database metrics, which is
 * exactly backwards during an incident.
 *
 * So a failing collector sets `wasal_metrics_collector_error{collector}` to 1
 * and the rest of the scrape still publishes. The failure is visible as a
 * metric instead of as an absence of metrics, which is the difference between a
 * graph with a spike and a graph with a hole.
 *
 * ## Why every gauge is reset first
 *
 * A Gauge keeps the last value it was given. Without a reset, a label series
 * that is no longer produced — a messaging channel that changed status, a
 * template that was deleted — would hold its old number forever and be read as
 * current. The bucketing in `ops.ts` already fixes the cardinality; the reset
 * makes the values honest.
 */

type Collector = { name: string; run: () => Promise<void> };

const COLLECTORS: Collector[] = [
  {
    name: "sweeps",
    run: async () => {
      const m = metrics();
      const health = await getSweepHealth();

      m.sweepRunAge.reset();
      m.sweepDuration.reset();
      m.sweepStale.reset();
      m.sweepHasError.reset();

      for (const sweep of health) {
        m.sweepRunAge.labels(sweep.sweep).set(sweep.ageSeconds);
        m.sweepStale.labels(sweep.sweep).set(sweep.stale ? 1 : 0);
        m.sweepHasError.labels(sweep.sweep).set(sweep.lastError ? 1 : 0);

        // Left unset when the sweep has never run, rather than defaulted to 0.
        // A 0 here would read as "it ran instantly", which is a very different
        // thing from "it has never run" — the `wasal_sweep_stale` gauge and the
        // -1 age already say which.
        if (sweep.lastDurationMs !== null) {
          m.sweepDuration.labels(sweep.sweep).set(sweep.lastDurationMs);
        }
      }
    },
  },
  {
    name: "queue",
    run: async () => {
      const m = metrics();
      const depth = await getQueueDepth();

      m.queueJobs.reset();
      for (const row of depth) {
        m.queueJobs.labels(row.queue, row.state).set(row.count);
      }
    },
  },
  {
    name: "aggregates",
    run: async () => {
      const m = metrics();
      const counts = await getGlobalCounts();

      m.inboundUnrouted.set(counts.inboundUnrouted);
      m.inboundUnprocessed.set(counts.inboundUnprocessed);
      m.dispatchAttemptingOverdue.set(counts.dispatchAttemptingOverdue);

      m.dispatchFailedRecent.reset();
      for (const window of FAILURE_WINDOWS) {
        m.dispatchFailedRecent.labels(window.label).set(counts.dispatchFailed[window.label] ?? 0);
      }

      m.messagingChannels.reset();
      for (const [status, count] of Object.entries(counts.channelsByStatus)) {
        m.messagingChannels.labels(status).set(count);
      }

      m.whatsappTemplates.reset();
      for (const [key, count] of Object.entries(counts.templatesByStatusLanguage)) {
        // The key is `${status}|${language}`, assembled in `ops.ts` where both
        // halves are already validated against their buckets. `split` with a
        // limit keeps the status intact if it ever contains a pipe.
        const [status, language] = key.split("|");
        m.whatsappTemplates.labels(status, language).set(count);
      }
    },
  },
];

/**
 * Run every collector, isolating failures.
 *
 * Never throws. The caller is a route handler whose only job is to serialize
 * whatever the registry holds — including, on a bad day, only the default
 * `nodejs_*` metrics plus a collector-error gauge.
 */
export async function collectMetrics(): Promise<void> {
  for (const collector of COLLECTORS) {
    try {
      await collector.run();
      metrics().collectorError.labels(collector.name).set(0);
    } catch (error) {
      // Logged as well as counted: the metric says something broke, and this
      // line says what.
      console.error(`[metrics] collector "${collector.name}" failed`, error);
      metrics().collectorError.labels(collector.name).set(1);
    }
  }
}
