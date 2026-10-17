import IORedis from "ioredis";
import { Queue, type ConnectionOptions } from "bullmq";
import { prisma, systemPrisma } from "@/server/db";
import { env } from "@/server/env";
import {
  QUEUE,
  SWEEP_INTERVALS_MS,
  staleAfterMs,
  type QueueName,
  type SweepName,
} from "@/server/queue";

/**
 * Read models for operations: sweep health, queue depth and the per-pharmacy
 * counts that tell an admin whether the machinery is working.
 *
 * ## Two clients, chosen deliberately at every call site
 *
 * `SweepHeartbeat` is NOT a tenant model — one row per sweep for the whole
 * process — so it is read through `systemPrisma`. Every count that touches a
 * patient, a message or a dispatch is scoped to one pharmacy and goes through
 * the guarded `prisma`, with `pharmacyId` written out. Those models are in the
 * tenant guard's list, so a forgotten filter throws rather than leaking; the
 * filter is still stated explicitly because the guard is a backstop, not the
 * design.
 *
 * The one thing this module will NOT do is list another pharmacy's inbound
 * messages. A global list of UNROUTED rows is a list of patients' phone numbers
 * belonging to pharmacies the reader has no relationship with, so the console is
 * tenant-scoped throughout and the cross-tenant data is exposed only as
 * unlabelled aggregates (see `collect.ts`).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Sweep health
// ─────────────────────────────────────────────────────────────────────────────

export type SweepStatus = {
  sweep: SweepName;
  /**
   * Seconds since the last heartbeat, or **-1 when the sweep has never run**.
   * -1 rather than 0 or a huge number: "never ran" and "ran just now" are
   * opposite conditions and must not be representable by the same value.
   */
  ageSeconds: number;
  lastDurationMs: number | null;
  lastError: string | null;
  /** Past its watchdog threshold. A sweep that never ran counts as stale. */
  stale: boolean;
  /**
   * Milliseconds past the threshold, and **-1 only when it never ran**.
   *
   * Clamped at zero rather than left negative, so `-1` unambiguously means "no
   * heartbeat". Without the clamp a healthy sweep sitting one millisecond inside
   * its threshold also reports `-1`, which is the same value as "has never run" —
   * two opposite conditions sharing a sentinel, which is the kind of thing a
   * later reader trusts and gets wrong.
   */
  overdueByMs: number;
};

/** The heartbeat row shape this needs — a structural subset of the model. */
export type HeartbeatRow = {
  sweepName: string;
  lastRunAtUtc: Date;
  lastDurationMs: number;
  lastError: string | null;
};

/**
 * PURE. Derive per-sweep health from heartbeat rows and a clock.
 *
 * Takes `now` as an argument rather than calling `Date.now()` so the staleness
 * boundary is testable without waiting for one, and touches no database so the
 * test does not have to write to `SweepHeartbeat` — a table the worker rewrites
 * every 30 seconds and which every test run would otherwise contend on.
 *
 * This mirrors the watchdog in `src/worker/index.ts`. The two must agree on what
 * counts as stale, or the console and the watchdog will contradict each other
 * during an incident, which is the worst moment to be unsure.
 *
 * `heartbeat` is exempt, exactly as it is there: the sweep that reports on the
 * others cannot meaningfully report on itself.
 */
export function deriveSweepStatus(
  rows: readonly HeartbeatRow[],
  now: number = Date.now(),
): SweepStatus[] {
  const byName = new Map(rows.map((row) => [row.sweepName, row]));

  return (Object.keys(SWEEP_INTERVALS_MS) as SweepName[]).map((sweep) => {
    const row = byName.get(sweep);

    if (!row) {
      return {
        sweep,
        ageSeconds: -1,
        lastDurationMs: null,
        lastError: null,
        // Reported, not ignored. On a fresh deployment this is simply "the
        // first tick has not happened yet", which the alerting rule covers with
        // a `for:` duration rather than by pretending it is healthy.
        stale: true,
        overdueByMs: -1,
      };
    }

    const ageMs = now - row.lastRunAtUtc.getTime();
    const exempt = sweep === "heartbeat";
    // Zero for an exempt sweep and zero for any sweep inside its threshold, so
    // the value is "how late", never "how early".
    const overdueByMs = exempt ? 0 : Math.max(0, ageMs - staleAfterMs(sweep));

    return {
      sweep,
      // Clamped at zero: a heartbeat written by a host whose clock is slightly
      // ahead would otherwise produce a negative age, and a negative "seconds
      // since" reads as a bug in the panel rather than as clock skew.
      ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
      lastDurationMs: row.lastDurationMs,
      lastError: row.lastError,
      stale: overdueByMs > 0,
      overdueByMs,
    };
  });
}

/** Global infrastructure state: one row per sweep for the whole process. */
export async function getSweepHealth(now: number = Date.now()): Promise<SweepStatus[]> {
  const rows = await systemPrisma.sweepHeartbeat.findMany({
    select: { sweepName: true, lastRunAtUtc: true, lastDurationMs: true, lastError: true },
  });

  return deriveSweepStatus(rows, now);
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue depth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only Redis connection in the app that is allowed to FAIL FAST.
 *
 * `createRedis()` in `@/server/queue` sets `maxRetriesPerRequest: null`, which is
 * required by BullMQ but means a command issued while Redis is down is retried
 * forever instead of rejecting. That is correct for a worker — it should wait
 * for Redis to come back — and catastrophic for a metrics scrape, which would
 * hang until Prometheus timed out and then report the whole endpoint as down,
 * taking the database metrics with it.
 *
 * So this connection gets a bounded retry budget and a per-command timeout: a
 * dead Redis produces a rejected promise in a few seconds, the queue collector
 * records `wasal_metrics_collector_error{collector="queue"}`, and every other
 * metric in the scrape is still published.
 */
const globalForQueueMetrics = globalThis as unknown as { __wasalMetricsRedis?: IORedis };

function metricsRedis(): IORedis {
  return (globalForQueueMetrics.__wasalMetricsRedis ??= new IORedis(env().REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    commandTimeout: 3_000,
    enableReadyCheck: false,
  }));
}

/**
 * The states asked of BullMQ, and the only ones the console shows.
 *
 * `paused` is deliberately absent, and it is not an oversight. BullMQ 5 made a
 * paused queue a queue-level flag rather than a job list, so `paused` is not a
 * `JobType` in v6 and `getJobCounts("paused")` does not typecheck. Nothing in
 * this codebase calls `queue.pause()`, so there is no paused state to report
 * and a column that could only ever read 0 would be worse than no column.
 *
 * `prioritized` and `waiting-children` are likewise omitted: this app adds no
 * prioritized jobs and uses no flows, so both would be permanent zeros.
 */
const JOB_STATES = ["wait", "active", "delayed", "failed", "completed"] as const;

export type QueueDepth = { queue: string; state: string; count: number };

/**
 * Depth of every queue that matters, by state.
 *
 * A `completed` count that climbs without bound is the signature of a scheduler
 * that is still registering but whose consumers have stopped; a `wait` count
 * that climbs is a stalled consumer. Both are invisible from Postgres, which is
 * why this reaches into Redis at all.
 */
export async function getQueueDepth(): Promise<QueueDepth[]> {
  const names: QueueName[] = [QUEUE.sendReminder, QUEUE.drainInbound, QUEUE.sweeps];
  const out: QueueDepth[] = [];

  // One Queue object per name per process. Creating them per scrape leaks a
  // connection each time, and `queue()` cannot be reused here because it is
  // bound to the shared retry-forever client.
  const queues = names.map(
    (name) => new Queue(name, { connection: metricsRedis() as unknown as ConnectionOptions }),
  );

  try {
    const counts = await Promise.all(queues.map((q) => q.getJobCounts(...JOB_STATES)));

    names.forEach((name, i) => {
      const byState = counts[i] ?? {};
      for (const state of JOB_STATES) {
        // Emitted as 0 rather than omitted, so a state that drains to empty is
        // visibly empty instead of the series disappearing — a gap and a zero
        // look very different on a graph, and only one of them means "fine".
        out.push({ queue: name, state, count: byState[state] ?? 0 });
      }
    });
  } finally {
    await Promise.all(queues.map((q) => q.close().catch(() => {})));
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Label bucketing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Both of these columns are FREE STRINGS, not enums, so their values are
 * whatever a migration, a seed or a hand-written `UPDATE` put there.
 *
 * A metric label is not a field — every distinct value becomes a permanent time
 * series. `status="ACTIVE"` costs one series; feeding a free-text column
 * straight in means one series per value anyone ever writes, forever, and a
 * typo is indistinguishable from a new state. So values are bucketed to a
 * whitelist and anything unrecognised collapses into OTHER, which keeps the
 * cardinality fixed and still makes the anomaly visible.
 */

const CHANNEL_STATUSES = new Set(["ACTIVE", "INACTIVE", "SUSPENDED"]);

export function bucketChannelStatus(raw: string): string {
  return CHANNEL_STATUSES.has(raw) ? raw : "OTHER";
}

/**
 * Language, bucketed to `ar`/`en`/`other`.
 *
 * Needed for a concrete reason rather than defensiveness: the Meta sync writes
 * `message_template_language` verbatim (`whatsapp-cloud.ts`), and Meta reports
 * locale identifiers like `ar_EG` and `en_US` — not the `ar`/`en` the send path
 * uses. So the same template can legitimately appear as either form, and
 * comparing the raw string would split one language across two series.
 */
export function bucketTemplateLanguage(raw: string): string {
  const base = raw.trim().toLowerCase().split(/[-_]/)[0];
  return base === "ar" || base === "en" ? base : "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant aggregates — PII-free, for /api/metrics only
// ─────────────────────────────────────────────────────────────────────────────

export type GlobalCounts = {
  inboundUnrouted: number;
  inboundUnprocessed: number;
  dispatchAttemptingOverdue: number;
  dispatchFailed: Record<string, number>;
  channelsByStatus: Record<string, number>;
  templatesByStatusLanguage: Record<string, number>;
};

/** Windows, in milliseconds, for the failed-dispatch gauge. */
export const FAILURE_WINDOWS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: "1h", ms: 3_600_000 },
  { label: "24h", ms: 86_400_000 },
];

/**
 * Counts only — no phone numbers, no pharmacy ids, no message ids.
 *
 * That constraint is the whole reason this can be cross-tenant. What leaves the
 * process is an integer per bucket; there is nothing here to attribute to a
 * patient, so the token-gated endpoint cannot become a way to read the database
 * sideways.
 */
export async function getGlobalCounts(now: Date = new Date()): Promise<GlobalCounts> {
  const [inboundUnrouted, inboundUnprocessed, dispatchAttemptingOverdue, channels, templates] =
    await Promise.all([
      systemPrisma.inboundMessage.count({ where: { processingStatus: "UNROUTED" } }),
      // `processedAtUtc: null` is the drain queue's own predicate — the same
      // rows `drainInbound` selects. Deriving it any other way would let this
      // number and the worker's behaviour disagree.
      systemPrisma.inboundMessage.count({ where: { processedAtUtc: null } }),
      // Mirrors `reconcileSendingDispatches`: ATTEMPTING with a deadline in the
      // past is the set the reconciler is about to resolve.
      systemPrisma.reminderDispatch.count({
        where: { status: "ATTEMPTING", reconcileDeadlineUtc: { lte: now } },
      }),
      systemPrisma.messagingChannel.groupBy({ by: ["status"], _count: { _all: true } }),
      systemPrisma.whatsAppTemplate.groupBy({
        by: ["status", "languageCode"],
        _count: { _all: true },
      }),
    ]);

  const dispatchFailed: Record<string, number> = {};
  for (const window of FAILURE_WINDOWS) {
    dispatchFailed[window.label] = await systemPrisma.reminderDispatch.count({
      where: { status: "FAILED", failedAtUtc: { gte: new Date(now.getTime() - window.ms) } },
    });
  }

  const channelsByStatus: Record<string, number> = {};
  for (const row of channels) {
    const key = bucketChannelStatus(row.status);
    channelsByStatus[key] = (channelsByStatus[key] ?? 0) + row._count._all;
  }

  const templatesByStatusLanguage: Record<string, number> = {};
  for (const row of templates) {
    // `status` is the bounded `TemplateStatus` enum, so it needs no bucketing.
    const key = `${row.status}|${bucketTemplateLanguage(row.languageCode)}`;
    templatesByStatusLanguage[key] = (templatesByStatusLanguage[key] ?? 0) + row._count._all;
  }

  return {
    inboundUnrouted,
    inboundUnprocessed,
    dispatchAttemptingOverdue,
    dispatchFailed,
    channelsByStatus,
    templatesByStatusLanguage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// One pharmacy's operations — for /admin
// ─────────────────────────────────────────────────────────────────────────────

export type PharmacyOps = {
  unrouted: number;
  unprocessed: number;
  attemptingOverdue: number;
  failedLast24h: number;
  recentFailures: {
    id: string;
    toPhoneE164: string;
    errorCode: string | null;
    errorMessage: string | null;
    failedAtUtc: Date | null;
  }[];
};

/**
 * This pharmacy's operational counts, and the failures a human might act on.
 *
 * Every query carries `pharmacyId` explicitly. `toPhoneE164` appears in the
 * failures list because a pharmacist looking at a failed reminder needs to know
 * whose it was — that is the pharmacy's own patient, reached through the
 * pharmacy's own session, which is exactly the scope the tenant boundary is
 * meant to allow.
 */
export async function getPharmacyOps(pharmacyId: string): Promise<PharmacyOps> {
  const dayAgo = new Date(Date.now() - 86_400_000);

  const [unrouted, unprocessed, attemptingOverdue, failedLast24h, recentFailures] =
    await Promise.all([
      prisma.inboundMessage.count({ where: { pharmacyId, processingStatus: "UNROUTED" } }),
      prisma.inboundMessage.count({ where: { pharmacyId, processedAtUtc: null } }),
      prisma.reminderDispatch.count({
        where: { pharmacyId, status: "ATTEMPTING", reconcileDeadlineUtc: { lte: new Date() } },
      }),
      prisma.reminderDispatch.count({
        where: { pharmacyId, status: "FAILED", failedAtUtc: { gte: dayAgo } },
      }),
      prisma.reminderDispatch.findMany({
        where: { pharmacyId, status: "FAILED" },
        orderBy: { failedAtUtc: "desc" },
        take: 10,
        select: {
          id: true,
          toPhoneE164: true,
          errorCode: true,
          errorMessage: true,
          failedAtUtc: true,
        },
      }),
    ]);

  return { unrouted, unprocessed, attemptingOverdue, failedLast24h, recentFailures };
}

/**
 * This pharmacy's template records.
 *
 * `WhatsAppTemplate` is NOT in the tenant guard's model list in `@/server/db` —
 * it has a nullable `pharmacyId` and was left out alongside the identity models
 * — so unlike the clinical models, a missing filter here is a silent cross-tenant
 * read rather than a thrown error. The `where` is therefore the only thing
 * scoping this, and it is written out for that reason.
 *
 * A null `pharmacyId` is a shared template not owned by anyone, so it is
 * deliberately excluded: showing another tenant's row would be the leak this
 * filter exists to prevent.
 */
export async function listPharmacyTemplates(pharmacyId: string) {
  return prisma.whatsAppTemplate.findMany({
    where: { pharmacyId },
    orderBy: [{ providerName: "asc" }, { languageCode: "asc" }],
    select: {
      id: true,
      providerName: true,
      languageCode: true,
      category: true,
      status: true,
      lastSyncedAtUtc: true,
    },
  });
}
