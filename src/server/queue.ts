import { Queue, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import { env } from "./env";

/**
 * BullMQ wiring.
 *
 * Redis here holds NO state that matters. Every queue job is a hint to go and
 * look at Postgres; if Redis is wiped, at most one sweep interval of dispatch
 * work is lost and nothing becomes inconsistent. This is what removes the
 * entire class of "a job exists but its reminder was cancelled" bugs, and why
 * a schedule edit only ever has to reconcile one system.
 */

export const QUEUE = {
  sendReminder: "send-reminder",
  evaluateRules: "evaluate-rules",
  drainInbound: "drain-inbound",
  sweeps: "sweeps",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/**
 * `maxRetriesPerRequest: null` is required by BullMQ — a worker must be able to
 * block indefinitely on BRPOPLPUSH rather than having ioredis abort the command
 * after the default retry budget.
 */
export function createRedis(): IORedis {
  return new IORedis(env().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

let shared: IORedis | undefined;

export function redis(): IORedis {
  shared ??= createRedis();
  return shared;
}

const queues = new Map<string, Queue>();

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redis() as unknown as ConnectionOptions });
    queues.set(name, q);
  }
  return q;
}

/**
 * Enqueue a send job.
 *
 * The job id is the dispatch row's id, so a duplicate `add` is a no-op rather
 * than a second send. Combined with the row-level CAS in `claimDueReminders`,
 * this gives at-most-once *enqueue* — though not at-most-once *delivery*, which
 * WhatsApp does not offer; see the reconciler in dispatch.ts.
 */
export async function enqueueSendReminder(
  dispatchId: string,
  opts: { delayMs?: number } = {},
): Promise<void> {
  await queue(QUEUE.sendReminder).add(
    "send",
    { dispatchId },
    {
      jobId: dispatchId,
      delay: opts.delayMs,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      // Keep completed jobs briefly for debugging, but do not let Redis grow
      // without bound — the database, not Redis, is the record.
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86_400 },
    },
  );
}

/**
 * Repeatable sweeps. Registered on worker boot via `upsertJobScheduler`, which
 * is idempotent — re-registering on every restart updates the schedule in place
 * rather than accumulating a second copy of every sweep.
 *
 * `sweepStaleAfterMs` is the watchdog threshold: if a sweep has not recorded a
 * heartbeat within this window, the worker's own health check reports it. That
 * check exists because the worst failure this system can have is silent — Redis
 * flushed, repeatable jobs gone, no reminders sent, and nothing in the logs.
 */
export const SWEEP_INTERVALS_MS = {
  dispatchSweep: 30_000,
  reconcileSending: 60_000,
  expireStale: 60_000,
  settleNoResponse: 300_000,
  materialize: 900_000,
  rulesSweep: 900_000,
  heartbeat: 60_000,
} as const;

export type SweepName = keyof typeof SWEEP_INTERVALS_MS;

/**
 * How long a sweep may go without a heartbeat before the watchdog complains.
 * Three intervals, so a single slow run or a brief Redis blip is not an alarm.
 */
export function staleAfterMs(sweep: SweepName): number {
  return SWEEP_INTERVALS_MS[sweep] * 3 + 30_000;
}

/** A sweep that legitimately runs daily must not trip the watchdog between runs. */
export const MAX_SWEEP_INTERVAL_MS = Math.max(...Object.values(SWEEP_INTERVALS_MS));

export async function closeQueues(): Promise<void> {
  for (const q of queues.values()) await q.close();
  queues.clear();
  if (shared) {
    await shared.quit();
    shared = undefined;
  }
}
