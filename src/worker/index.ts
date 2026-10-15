import "dotenv/config";
import dns from "node:dns";

// Force IPv4 first to prevent Windows undici ConnectTimeoutError against graph.facebook.com
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // Ignore in environments where not supported
}

import { hostname } from "node:os";
import { Worker, type Job } from "bullmq";
import { systemPrisma } from "@/server/db";
import { env } from "@/server/env";
import { QUEUE, SWEEP_INTERVALS_MS, createRedis, queue, staleAfterMs, type SweepName } from "@/server/queue";
import { getMessagingProvider } from "@/server/messaging/factory";
import {
  claimDueReminders,
  expireStaleScheduled,
  reconcileSendingDispatches,
  sendReminder,
  settleNoResponse,
} from "@/server/scheduling/dispatch";
import { materializeDueSchedules } from "@/server/scheduling/materialize";
import { drainInbound } from "@/server/responses/processInbound";
import { ensureSystemRules, evaluateRulesSweep } from "@/server/rules/evaluator";
import { enqueueSendReminder } from "@/server/queue";

/**
 * The worker process.
 *
 * Runs alongside the Next.js app, sharing one codebase and one database. Every
 * job it handles is a HINT to go and look at Postgres — the durable state is
 * always in the database, never in Redis. That is what makes wiping Redis cost
 * at most one sweep interval instead of losing scheduled reminders, and it is
 * why no sweep has to be idempotent-by-luck: each one re-derives its work from
 * a table.
 *
 * ## Why every sweep reports a heartbeat
 *
 * The failure this guards against has no error attached to it. If Redis is
 * flushed or the repeatable job set is lost, the worker keeps running, the log
 * stays clean, the health check passes, and no reminders are ever sent again.
 * Nothing raises an exception because nothing is being asked to run.
 *
 * Recording a heartbeat on every run turns that into a detectable condition:
 * a sweep that stops running is visibly overdue rather than silently absent.
 */

const HOST = hostname();

type SweepHandler = () => Promise<unknown>;

/**
 * The sweeps, in the order they matter.
 *
 * `dispatchSweep` first: it is the one whose absence stops medication reminders,
 * so it should still run if a later sweep throws during registration.
 */
const SWEEPS: Record<SweepName, SweepHandler> = {
  dispatchSweep: async () => {
    const { dispatchIds, skipped } = await claimDueReminders();
    for (const dispatchId of dispatchIds) {
      await enqueueSendReminder(dispatchId);
    }
    return { claimed: dispatchIds.length, skipped };
  },

  reconcileSending: () => reconcileSendingDispatches(),

  expireStale: () => expireStaleScheduled(),

  settleNoResponse: () => settleNoResponse(),

  materialize: () => materializeDueSchedules(),

  rulesSweep: () => evaluateRulesSweep(),

  heartbeat: () => checkSweepHealth(),
};

/**
 * Record that a sweep ran, and how it went.
 *
 * Upsert on `sweepName`, which is unique — the table holds the LATEST state of
 * each sweep, not a history. History belongs in `AuditEvent`, and a heartbeat
 * table that grows forever is its own outage waiting to happen.
 */
async function recordHeartbeat(
  sweep: SweepName,
  durationMs: number,
  error?: string,
): Promise<void> {
  await systemPrisma.sweepHeartbeat.upsert({
    where: { sweepName: sweep },
    create: {
      sweepName: sweep,
      lastRunAtUtc: new Date(),
      lastDurationMs: Math.round(durationMs),
      hostId: HOST,
      lastError: error ?? null,
    },
    update: {
      lastRunAtUtc: new Date(),
      lastDurationMs: Math.round(durationMs),
      hostId: HOST,
      lastError: error ?? null,
    },
  });
}

/**
 * The watchdog.
 *
 * Reports any sweep whose last heartbeat is older than three of its own
 * intervals. Deliberately never throws: a watchdog that crashes the worker on
 * the first sign of trouble turns a degraded system into a dead one, and the
 * whole point is to keep the other sweeps running so the system degrades
 * gracefully rather than stopping.
 */
async function checkSweepHealth(): Promise<{
  healthy: boolean;
  stale: { sweep: string; overdueByMs: number }[];
}> {
  const rows = await systemPrisma.sweepHeartbeat.findMany();

  const byName = new Map(rows.map((r) => [r.sweepName, r]));
  const stale: { sweep: string; overdueByMs: number }[] = [];
  const now = Date.now();

  for (const sweep of Object.keys(SWEEPS) as SweepName[]) {
    // `heartbeat` cannot meaningfully report on itself.
    if (sweep === "heartbeat") continue;

    const row = byName.get(sweep);
    const limit = staleAfterMs(sweep);

    if (!row) {
      // Never run. On a fresh deployment this is normal until the first tick, so
      // it is reported but not treated as an incident.
      stale.push({ sweep, overdueByMs: -1 });
      continue;
    }

    const overdue = now - row.lastRunAtUtc.getTime() - limit;
    if (overdue > 0) stale.push({ sweep, overdueByMs: overdue });
  }

  if (stale.length > 0) {
    // Loud on purpose. This line is the only signal that reminders have stopped
    // going out while everything else still looks healthy.
    console.error(
      `[watchdog] ${stale.length} sweep(s) overdue: ` +
      stale
        .map((s) => `${s.sweep}(${s.overdueByMs < 0 ? "never ran" : `${Math.round(s.overdueByMs / 1000)}s late`})`)
        .join(", "),
    );
  }

  return { healthy: stale.length === 0, stale };
}

/** Wrap a sweep so it always records a heartbeat, even when it throws. */
function withHeartbeat(sweep: SweepName, handler: SweepHandler): SweepHandler {
  return async () => {
    const started = Date.now();
    try {
      const result = await handler();
      await recordHeartbeat(sweep, Date.now() - started);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordHeartbeat(sweep, Date.now() - started, message).catch(() => {
        // If even the heartbeat write fails the database is down, which the
        // failed sweep itself already reports.
      });
      throw err;
    }
  };
}

async function main(): Promise<void> {
  const config = env();

  console.log(`[worker] starting on ${HOST}, provider=${config.MESSAGING_PROVIDER}`);

  // The catalog lives in TypeScript, so the RuleDefinition rows are derived from
  // it at boot rather than frozen into a migration that would drift from the
  // code it was copied out of.
  const rulesCreated = await ensureSystemRules();
  if (rulesCreated > 0) console.log(`[worker] seeded ${rulesCreated} system rule(s)`);

  const provider = getMessagingProvider();
  console.log(`[worker] messaging provider: ${provider.name}`);

  // ── queues ──
  const sendQueue = queue(QUEUE.sendReminder);
  const inboundQueue = queue(QUEUE.drainInbound);
  const sweepsQueue = queue(QUEUE.sweeps);

  // ── send-reminder worker ──
  //
  // Concurrency is modest on purpose. The provider call is an HTTP round trip to
  // Meta, and the failure mode of a burst is rate-limiting that looks like
  // deliverability problems. Reminders are not latency-sensitive.
  const sendWorker = new Worker(
    QUEUE.sendReminder,
    async (job: Job<{ dispatchId: string }>) => {
      const outcome = await sendReminder(job.data.dispatchId, provider);

      // `noop` means the dispatch was already resolved — a redelivery, or a race
      // the CAS already settled. Not an error, and it must not be retried.
      if (outcome.status === "noop") return outcome;

      if (outcome.status === "sent") return outcome;

      // A retryable provider failure is thrown so BullMQ applies the backoff.
      // A definitive one is returned as a completed job: retrying a rejected
      // template or an invalid number burns the rate limit and changes nothing.
      if (outcome.retryable) {
        throw new Error(`${outcome.errorCode}: ${outcome.errorMessage}`);
      }

      return outcome;
    },
    {
      connection: createRedis(),
      concurrency: 5,
    },
  );

  sendWorker.on("failed", async (job, err) => {
    if (!job) return;

    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? 1;

    // Only on the FINAL failure. Marking the event FAILED on a first attempt
    // that still has retries left would report a delivery failure for a reminder
    // that is about to go out.
    if (attemptsMade < maxAttempts) return;

    const dispatchId = job.data?.dispatchId;
    if (!dispatchId) return;

    console.error(`[worker] send permanently failed for dispatch ${dispatchId}: ${err.message}`);

    await systemPrisma.$transaction(async (tx) => {
      const dispatch = await tx.reminderDispatch.findUnique({
        where: { id: dispatchId },
        select: { reminderEventId: true, status: true },
      });
      if (!dispatch) return;

      // Do not overwrite a state a delivery receipt has since established.
      // Meta may have accepted the message and the callback arrived while we were
      // retrying.
      if (dispatch.status === "SENT" || dispatch.status === "DELIVERED" || dispatch.status === "READ") {
        return;
      }

      await tx.reminderDispatch.update({
        where: { id: dispatchId },
        data: { status: "FAILED", failedAtUtc: new Date(), errorMessage: err.message },
      });

      await tx.reminderEvent.updateMany({
        where: { id: dispatch.reminderEventId, deliveryState: "SENDING" },
        data: { deliveryState: "FAILED", cancelReason: "SEND_EXHAUSTED_RETRIES" },
      });
    });
  });

  sendWorker.on("error", (err) => console.error("[worker] send worker error", err));

  // ── inbound drain worker ──
  //
  // Also runs as a sweep, so a message persisted just before a restart is
  // processed rather than stranded. This worker exists to make the common case
  // fast — a patient's tap should be acknowledged in seconds, not at the next
  // tick.
  const inboundWorker = new Worker(
    QUEUE.drainInbound,
    async () => drainInbound(50),
    { connection: createRedis(), concurrency: 2 },
  );

  inboundWorker.on("error", (err) => console.error("[worker] inbound worker error", err));

  // ── register the sweeps ──
  //
  // `upsertJobScheduler` rather than `add({ repeat })`: it is idempotent on the
  // scheduler id, so restarting the worker updates the schedule in place.
  // Registering with `add` on every boot is how a queue quietly accumulates
  // seven copies of every sweep.
  for (const sweep of Object.keys(SWEEPS) as SweepName[]) {
    await sweepsQueue.upsertJobScheduler(
      `sweep:${sweep}`,
      { every: SWEEP_INTERVALS_MS[sweep] },
      { name: sweep, opts: { removeOnComplete: { count: 50 }, removeOnFail: { count: 100 } } },
    );
    console.log(`[worker] scheduled ${sweep} every ${SWEEP_INTERVALS_MS[sweep] / 1000}s`);
  }

  const sweepsWorker = new Worker(
    QUEUE.sweeps,
    async (job: Job) => {
      const sweep = job.name as SweepName;
      const handler = SWEEPS[sweep];

      if (!handler) {
        // A job left over from an older deployment. Completing it is correct —
        // failing it would retry forever against code that no longer exists.
        console.warn(`[worker] unknown sweep "${sweep}", ignoring`);
        return null;
      }

      return withHeartbeat(sweep, handler)();
    },
    {
      // One at a time. Sweeps coordinate through the database with CAS, so they
      // are safe to overlap, but serialising them keeps a slow sweep from
      // stacking up behind a fast one and makes the timings in the heartbeat
      // table meaningful.
      connection: createRedis(),
      concurrency: 1,
    },
  );

  sweepsWorker.on("failed", (job, err) => {
    console.error(`[worker] sweep "${job?.name}" failed: ${err.message}`);
  });

  sweepsWorker.on("error", (err) => console.error("[worker] sweeps worker error", err));

  console.log("[worker] ready");

  // ── graceful shutdown ──
  //
  // A send interrupted by SIGTERM is what the reconciler exists to resolve, but
  // it is far better not to create the situation. Closing the workers waits for
  // in-flight jobs.
  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, draining…`);
    try {
      await Promise.all([sendWorker.close(), inboundWorker.close(), sweepsWorker.close()]);
      await Promise.all([sendQueue.close(), inboundQueue.close(), sweepsQueue.close()]);
      console.log("[worker] stopped cleanly");
      process.exit(0);
    } catch (err) {
      console.error("[worker] error during shutdown", err);
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
