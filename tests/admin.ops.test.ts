import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bucketChannelStatus,
  bucketTemplateLanguage,
  deriveSweepStatus,
  getGlobalCounts,
  getPharmacyOps,
  getSweepHealth,
  type HeartbeatRow,
} from "@/server/admin/ops";
import { systemPrisma } from "@/server/db";
import { SWEEP_INTERVALS_MS, staleAfterMs, type SweepName } from "@/server/queue";
import { TemplateStatus } from "@/generated/prisma/enums";

/**
 * The operations read models.
 *
 * Three claims here are load-bearing and none of them is visible from reading
 * the code that makes them.
 *
 *   A STOPPED SWEEP IS THE ONLY WAY REMINDERS STOP SILENTLY. Every other failure
 *   in this system raises something; a sweep that stops running logs nothing,
 *   errors nothing, and leaves the app answering 200. So "how long since this
 *   last reported" has to be right, and it has to be right for the sweep that
 *   has never reported at all — the fresh-deployment case, which is exactly when
 *   nobody is watching.
 *
 *   `lastRunAtUtc` IS A TIMEZONE TRAP. The column is `timestamp WITHOUT time
 *   zone` holding a UTC instant. Prisma reads it correctly; a raw `pg` client
 *   hands back a Date built as if the value were LOCAL, which on a UTC+3 host
 *   makes every healthy sweep read as three hours dead. The regression test
 *   below is written to fail in both directions, because the naive fix for one
 *   breaks the other.
 *
 *   NOTHING CROSSES THE TENANT BOUNDARY. The console is read by one pharmacy's
 *   admin and shows them their own patients' phone numbers. A query that forgets
 *   its `pharmacyId` fails silently in the worst possible way — it succeeds, and
 *   shows the wrong pharmacy's data.
 */

const RUN = randomUUID().slice(0, 8);

type Seeded = {
  pharmacyId: string;
  patientId: string;
  medicationId: string;
  scheduleId: string;
};

let alpha: Seeded;
let beta: Seeded;

/** Rows created outside a pharmacy, which no cascade will clean up. */
const looseInboundIds: string[] = [];
const looseChannelIds: string[] = [];
const looseTemplateIds: string[] = [];

let seq = 0;

async function seedPharmacy(label: string): Promise<Seeded> {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Ops ${label} (${RUN})`, timeZone: "Africa/Cairo" },
  });

  const patient = await systemPrisma.patient.create({
    data: {
      pharmacyId: pharmacy.id,
      fullName: `Ops ${label} Patient ${RUN}`,
      phoneE164: `+20109${label === "alpha" ? "1000" : "2000"}${RUN.slice(0, 3)}`,
    },
  });

  const medication = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId: pharmacy.id,
      patientId: patient.id,
      medicationNameText: `Ops Medicine ${RUN}`,
      startedOn: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  const schedule = await systemPrisma.medicationSchedule.create({
    data: {
      pharmacyId: pharmacy.id,
      patientId: patient.id,
      medicationId: medication.id,
      mode: "FIXED_TIMES_OF_DAY",
      timesOfDay: ["08:00"],
      daysOfWeek: [],
      timeZone: "Africa/Cairo",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  return {
    pharmacyId: pharmacy.id,
    patientId: patient.id,
    medicationId: medication.id,
    scheduleId: schedule.id,
  };
}

/**
 * A dispatch, with the event and dose slot it needs to exist.
 *
 * `doseAtUtc` is unique per schedule, so it comes from the counter rather than
 * the clock — two rows created in the same millisecond would otherwise collide
 * on `@@unique([scheduleId, doseAtUtc])`.
 */
async function addDispatch(
  ctx: Seeded,
  options: {
    status: "FAILED" | "ATTEMPTING";
    reconcileDeadlineUtc: Date;
    failedAtUtc?: Date;
    errorCode?: string;
    toPhoneE164: string;
  },
) {
  seq += 1;
  const doseAtUtc = new Date(Date.UTC(2026, 1, 1) + seq * 3_600_000);

  const event = await systemPrisma.reminderEvent.create({
    data: {
      pharmacyId: ctx.pharmacyId,
      patientId: ctx.patientId,
      medicationId: ctx.medicationId,
      scheduleId: ctx.scheduleId,
      scheduleRevisionSnapshot: 1,
      doseAtUtc,
      doseLocalDate: new Date(Date.UTC(2026, 1, 1)),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(doseAtUtc.getTime() + 4 * 3_600_000),
    },
  });

  return systemPrisma.reminderDispatch.create({
    data: {
      id: randomUUID(),
      pharmacyId: ctx.pharmacyId,
      reminderEventId: event.id,
      attemptNo: 1,
      provider: "mock",
      toPhoneE164: options.toPhoneE164,
      status: options.status,
      failedAtUtc: options.failedAtUtc ?? null,
      errorCode: options.errorCode ?? null,
      errorMessage: options.errorCode ? "rejected by provider" : null,
      reconcileDeadlineUtc: options.reconcileDeadlineUtc,
    },
  });
}

async function addInbound(options: {
  pharmacyId: string | null;
  status: "RECEIVED" | "ROUTED" | "UNROUTED";
  processed: boolean;
  from: string;
}) {
  const row = await systemPrisma.inboundMessage.create({
    data: {
      pharmacyId: options.pharmacyId,
      providerMessageId: `wamid.ops.${randomUUID()}`,
      fromPhoneE164: options.from,
      toPhoneE164: "+201000000000",
      type: "button",
      rawPayload: {},
      receivedAtUtc: new Date(),
      processedAtUtc: options.processed ? new Date() : null,
      processingStatus: options.status,
    },
  });

  if (options.pharmacyId === null) looseInboundIds.push(row.id);
  return row;
}

beforeAll(async () => {
  alpha = await seedPharmacy("alpha");
  beta = await seedPharmacy("beta");

  const now = Date.now();

  // ── alpha: one of everything the console counts ────────────────────────────
  await addInbound({
    pharmacyId: alpha.pharmacyId,
    status: "UNROUTED",
    processed: false,
    from: "+201001110001",
  });
  await addInbound({
    pharmacyId: alpha.pharmacyId,
    status: "RECEIVED",
    processed: false,
    from: "+201001110002",
  });
  await addInbound({
    pharmacyId: alpha.pharmacyId,
    status: "ROUTED",
    processed: true,
    from: "+201001110003",
  });

  await addDispatch(alpha, {
    status: "FAILED",
    toPhoneE164: "+201001110010",
    failedAtUtc: new Date(now - 60_000),
    errorCode: "131047",
    reconcileDeadlineUtc: new Date(now - 60_000),
  });
  // Outside the 24-hour window, so it must NOT appear in `failedLast24h` — but
  // it IS still a recent failure worth showing, which is why that list carries no
  // window at all.
  await addDispatch(alpha, {
    status: "FAILED",
    toPhoneE164: "+201001110011",
    failedAtUtc: new Date(now - 48 * 3_600_000),
    errorCode: "131026",
    reconcileDeadlineUtc: new Date(now - 48 * 3_600_000),
  });
  // Stuck mid-flight: the worker died between contacting WhatsApp and recording
  // a result, and the reconciler's deadline has passed.
  await addDispatch(alpha, {
    status: "ATTEMPTING",
    toPhoneE164: "+201001110012",
    reconcileDeadlineUtc: new Date(now - 60_000),
  });
  // Attempting, but still inside its deadline — a send in flight, not a stuck one.
  await addDispatch(alpha, {
    status: "ATTEMPTING",
    toPhoneE164: "+201001110013",
    reconcileDeadlineUtc: new Date(now + 3_600_000),
  });

  // ── beta: the same kind of row, to prove it never leaks into alpha's view ──
  await addDispatch(beta, {
    status: "FAILED",
    toPhoneE164: "+201002220010",
    failedAtUtc: new Date(now - 60_000),
    errorCode: "131047",
    reconcileDeadlineUtc: new Date(now - 60_000),
  });
  await addInbound({
    pharmacyId: beta.pharmacyId,
    status: "UNROUTED",
    processed: false,
    from: "+201002220001",
  });
});

afterAll(async () => {
  // Ordered explicitly rather than relying on cascades: `InboundMessage` has a
  // nullable `pharmacyId` and no relation to `Pharmacy`, so nothing would clean
  // those rows up and they would accumulate across runs.
  await systemPrisma.reminderDispatch.deleteMany({
    where: { pharmacyId: { in: [alpha.pharmacyId, beta.pharmacyId] } },
  });
  await systemPrisma.reminderEvent.deleteMany({
    where: { pharmacyId: { in: [alpha.pharmacyId, beta.pharmacyId] } },
  });
  await systemPrisma.inboundMessage.deleteMany({
    where: { pharmacyId: { in: [alpha.pharmacyId, beta.pharmacyId] } },
  });
  await systemPrisma.inboundMessage.deleteMany({ where: { id: { in: looseInboundIds } } });
  await systemPrisma.messagingChannel.deleteMany({ where: { id: { in: looseChannelIds } } });
  await systemPrisma.whatsAppTemplate.deleteMany({ where: { id: { in: looseTemplateIds } } });
  await systemPrisma.pharmacy.deleteMany({
    where: { id: { in: [alpha.pharmacyId, beta.pharmacyId] } },
  });
  await systemPrisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("deriveSweepStatus", () => {
  const NOW = Date.parse("2026-03-01T12:00:00.000Z");

  function heartbeat(sweepName: string, ageMs: number, lastError: string | null = null) {
    return {
      sweepName,
      lastRunAtUtc: new Date(NOW - ageMs),
      lastDurationMs: 25,
      lastError,
    } satisfies HeartbeatRow;
  }

  function pick(rows: readonly HeartbeatRow[], sweep: SweepName) {
    const found = deriveSweepStatus(rows, NOW).find((s) => s.sweep === sweep);
    expect(found, `no status derived for ${sweep}`).toBeDefined();
    return found!;
  }

  it("reports every sweep the worker schedules, and nothing else", () => {
    // Driven off the worker's own table rather than a literal 8, so a sweep
    // added there is covered here without anyone remembering to update a count.
    const statuses = deriveSweepStatus([], NOW);

    expect(statuses.map((s) => s.sweep).sort()).toEqual(
      (Object.keys(SWEEP_INTERVALS_MS) as SweepName[]).sort(),
    );
    expect(new Set(statuses.map((s) => s.sweep)).size).toBe(statuses.length);
  });

  it("ignores a heartbeat for a sweep that is no longer scheduled", () => {
    // A renamed sweep leaves its old row behind. Reporting it would put a
    // permanently-stale entry on the console that no amount of fixing can clear.
    const statuses = deriveSweepStatus([heartbeat("retiredSweep", 0)], NOW);

    expect(statuses.map((s) => s.sweep)).not.toContain("retiredSweep");
  });

  it("calls a sweep that just ran on time", () => {
    const status = pick([heartbeat("dispatchSweep", 2_000)], "dispatchSweep");

    expect(status.ageSeconds).toBe(2);
    expect(status.stale).toBe(false);
    expect(status.overdueByMs).toBe(0);
  });

  it("stays on time right up to the threshold and goes stale just past it", () => {
    // The rule is three intervals plus a grace period, so one slow run or a
    // brief Redis blip is not an alarm. Asserted on the boundary itself: an
    // off-by-one here is a page at 3am or a real outage nobody hears about.
    const threshold = staleAfterMs("dispatchSweep");
    expect(threshold).toBe(SWEEP_INTERVALS_MS.dispatchSweep * 3 + 30_000);

    const inside = pick([heartbeat("dispatchSweep", threshold - 1_000)], "dispatchSweep");
    expect(inside.stale).toBe(false);
    expect(inside.overdueByMs).toBe(0);

    const past = pick([heartbeat("dispatchSweep", threshold + 1_000)], "dispatchSweep");
    expect(past.stale).toBe(true);
    expect(past.overdueByMs).toBe(1_000);
  });

  it("reports a sweep that has never run as stale, with an age of -1", () => {
    // The fresh-deployment case: an empty table. This is the moment the console
    // matters most, and the one where a "0 seconds ago" default would be a lie.
    const status = pick([], "dispatchSweep");

    expect(status.ageSeconds).toBe(-1);
    expect(status.stale).toBe(true);
    expect(status.overdueByMs).toBe(-1);
    expect(status.lastDurationMs).toBeNull();
    expect(status.lastError).toBeNull();
  });

  it("never reports the heartbeat sweep itself as stale", () => {
    // The sweep that reports on the others cannot meaningfully report on itself,
    // so it is exempt — the same exclusion `checkSweepHealth` in the worker
    // makes. If the two disagreed, the console and the watchdog would contradict
    // each other during an incident.
    const status = pick([heartbeat("heartbeat", 10 * 3_600_000)], "heartbeat");

    expect(status.ageSeconds).toBe(36_000);
    expect(status.stale).toBe(false);
    expect(status.overdueByMs).toBe(0);
  });

  it("clamps a heartbeat written by a clock running ahead", () => {
    // Never negative: "-3 seconds since it last ran" reads as a broken panel
    // rather than as clock skew, and a reader who stops trusting the age column
    // has lost the one signal this whole table exists to carry.
    const status = pick([heartbeat("materialize", -5_000)], "materialize");

    expect(status.ageSeconds).toBe(0);
    expect(status.stale).toBe(false);
  });

  it("carries the last error and duration through untouched", () => {
    const rows: HeartbeatRow[] = [
      { ...heartbeat("rulesSweep", 1_000), lastDurationMs: 4_321, lastError: "boom" },
    ];

    const status = pick(rows, "rulesSweep");

    expect(status.lastDurationMs).toBe(4_321);
    expect(status.lastError).toBe("boom");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("getSweepHealth reads lastRunAtUtc as the UTC instant it is", () => {
  /**
   * Ground truth is taken from POSTGRES, not from the client.
   *
   * `now() AT TIME ZONE 'utc'` minus the stored naive column is the age Postgres
   * computes itself, with no client-side timezone interpretation anywhere in the
   * path. Whatever `getSweepHealth` derives has to agree with it. Prisma reads
   * this column correctly today; the assertion exists for the day someone
   * "optimises" the query into raw SQL — the column is `timestamp WITHOUT time
   * zone` holding UTC, so a `pg` client hands it back as a Date built in LOCAL
   * time, and on this UTC+3 host that makes a sweep that ran 25 seconds ago read
   * as 10 825 seconds dead.
   *
   * Deliberately compared rather than pinned to a fixture age. `SweepHeartbeat`
   * is rewritten by the worker every 30 seconds on a running stack, so a row
   * this test wrote could be replaced between the write and the read — the age
   * would then be honest and the test would fail anyway, for a reason that has
   * nothing to do with the column. Two readings of the same live row cannot be
   * raced into a false failure: a concurrent rewrite moves both, and the largest
   * possible move is one sweep interval.
   */
  const TOLERANCE_SECONDS = 60; // > one dispatchSweep interval; << the 10 800 s shift

  it("derives the same age Postgres does, in both directions", async () => {
    /*
     * A row has to exist for there to be anything to compare. It is created only
     * when the table is EMPTY, which is precisely when no worker is running —
     * so the one write this test ever performs is uncontended by construction,
     * and is overwritten by the worker's first tick on any live stack.
     */
    const existing = await systemPrisma.sweepHeartbeat.count();

    if (existing === 0) {
      await systemPrisma.sweepHeartbeat.create({
        data: {
          sweepName: "dispatchSweep",
          lastRunAtUtc: new Date(Date.now() - 600_000),
          lastDurationMs: 12,
          hostId: `test-${RUN}`,
        },
      });
    }

    const truth = await systemPrisma.$queryRaw<
      { sweepName: string; ageSeconds: number }[]
    >`
      SELECT "sweepName",
             EXTRACT(EPOCH FROM (now() AT TIME ZONE 'utc' - "lastRunAtUtc"))::float8 AS "ageSeconds"
      FROM "SweepHeartbeat"
    `;

    const derived = new Map((await getSweepHealth()).map((s) => [s.sweep, s]));

    expect(truth.length).toBeGreaterThan(0);

    let compared = 0;

    for (const row of truth) {
      const status = derived.get(row.sweepName as SweepName);
      // A heartbeat for a sweep that is no longer in `SWEEP_INTERVALS_MS` is not
      // reported at all; that case is covered in the pure suite above.
      if (!status) continue;

      compared += 1;

      /*
       * Two-sided, and both sides are load-bearing.
       *
       * On a host east of UTC the trap INFLATES the age — a naive-UTC value read
       * as local becomes an instant hours earlier — so the upper bound catches
       * it. West of UTC the same mistake yields a negative age, which the clamp
       * turns into 0, so only the lower bound catches it. A one-sided assertion
       * would pass on half the world's machines.
       */
      expect(
        Math.abs(status.ageSeconds - row.ageSeconds),
        `${row.sweepName}: panel says ${status.ageSeconds}s, Postgres says ${Math.round(row.ageSeconds)}s`,
      ).toBeLessThanOrEqual(TOLERANCE_SECONDS);
    }

    expect(compared).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("getPharmacyOps is scoped to one pharmacy", () => {
  it("counts only this pharmacy's inbound messages", async () => {
    const ops = await getPharmacyOps(alpha.pharmacyId);

    expect(ops.unrouted).toBe(1);
    // Both the UNROUTED row and the RECEIVED one, and not the ROUTED one.
    // Unrouted is a subset of unprocessed, deliberately: a reply that reached no
    // pharmacy has also not been read by anyone.
    expect(ops.unprocessed).toBe(2);
  });

  it("does not count another pharmacy's inbound messages", async () => {
    const ops = await getPharmacyOps(beta.pharmacyId);

    expect(ops.unrouted).toBe(1);
    expect(ops.unprocessed).toBe(1);
  });

  it("counts only this pharmacy's failed and stuck dispatches", async () => {
    const ops = await getPharmacyOps(alpha.pharmacyId);

    // One FAILED inside the 24-hour window; the 48-hour-old one is excluded.
    expect(ops.failedLast24h).toBe(1);
    // One ATTEMPTING past its reconcile deadline. The in-flight one, whose
    // deadline is in the future, is a send that is merely in progress.
    expect(ops.attemptingOverdue).toBe(1);
  });

  it("shows this pharmacy's failures and never another's", async () => {
    const ops = await getPharmacyOps(alpha.pharmacyId);

    // Both failures, newest first, with no time window — a failure from two days
    // ago is still an unexplained failure.
    expect(ops.recentFailures).toHaveLength(2);
    expect(ops.recentFailures[0].errorCode).toBe("131047");

    const numbers = ops.recentFailures.map((f) => f.toPhoneE164);
    expect(numbers).toEqual(["+201001110010", "+201001110011"]);
    // The one row that would prove a leak.
    expect(numbers).not.toContain("+201002220010");
  });

  it("gives the other pharmacy its own failures", async () => {
    const ops = await getPharmacyOps(beta.pharmacyId);

    expect(ops.failedLast24h).toBe(1);
    expect(ops.recentFailures.map((f) => f.toPhoneE164)).toEqual(["+201002220010"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("label bucketing keeps metric cardinality fixed", () => {
  /**
   * `MessagingChannel.status` and `WhatsAppTemplate.languageCode` are free-text
   * columns, not enums. A metric label is not a field — every distinct value is a
   * time series that lives forever, and a typo is indistinguishable from a new
   * state. So both are bucketed to a whitelist, and the tests below are the
   * whitelist.
   */
  it("passes through the statuses it knows", () => {
    for (const status of ["ACTIVE", "INACTIVE", "SUSPENDED"]) {
      expect(bucketChannelStatus(status)).toBe(status);
    }
  });

  it("collapses everything else to OTHER, including a near-miss", () => {
    expect(bucketChannelStatus("FROZEN")).toBe("OTHER");
    expect(bucketChannelStatus("")).toBe("OTHER");
    // Case and whitespace are not normalised: `active` is a different string from
    // `ACTIVE`, and quietly accepting it would mean the bucket set is wider than
    // the one written down.
    expect(bucketChannelStatus("active")).toBe("OTHER");
    expect(bucketChannelStatus(" ACTIVE")).toBe("OTHER");
  });

  it("buckets Meta's locale identifiers to a bare language", () => {
    // Concretely required, not defensive: the template sync writes
    // `message_template_language` verbatim, and Meta reports `ar_EG` / `en_US` —
    // not the `ar` / `en` the send path uses. Without this the same language
    // would occupy two series and the dashboard would show neither.
    expect(bucketTemplateLanguage("ar_EG")).toBe("ar");
    expect(bucketTemplateLanguage("en_US")).toBe("en");
    expect(bucketTemplateLanguage("ar-EG")).toBe("ar");
    expect(bucketTemplateLanguage("AR")).toBe("ar");
    expect(bucketTemplateLanguage(" ar_eg ")).toBe("ar");
    expect(bucketTemplateLanguage("ar")).toBe("ar");
    expect(bucketTemplateLanguage("en")).toBe("en");
  });

  it("has exactly one bucket for everything unknown", () => {
    expect(bucketTemplateLanguage("fr")).toBe("other");
    expect(bucketTemplateLanguage("")).toBe("other");
    expect(bucketTemplateLanguage("arabe")).toBe("other");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("getGlobalCounts publishes aggregates that identify nobody", () => {
  it("buckets channels by status against real rows", async () => {
    const before = await getGlobalCounts();

    // A status no code writes, to prove the bucket is enforced at the database
    // boundary and not merely in the pure function above.
    const channel = await systemPrisma.messagingChannel.create({
      data: {
        pharmacyId: alpha.pharmacyId,
        provider: "mock",
        providerPhoneNumberId: `ops-${RUN}-frozen`,
        displayPhoneE164: "+201000000099",
        status: "FROZEN",
      },
    });
    looseChannelIds.push(channel.id);

    const after = await getGlobalCounts();

    expect((after.channelsByStatus.OTHER ?? 0) - (before.channelsByStatus.OTHER ?? 0)).toBe(1);

    // And nothing anywhere in the map is a raw, unbucketed value.
    for (const status of Object.keys(after.channelsByStatus)) {
      expect(["ACTIVE", "INACTIVE", "SUSPENDED", "OTHER"]).toContain(status);
    }
  });

  it("buckets template languages against real rows", async () => {
    const before = await getGlobalCounts();

    const template = await systemPrisma.whatsAppTemplate.create({
      data: {
        pharmacyId: null,
        providerName: `ops_${RUN}_reminder`,
        languageCode: "ar_EG",
        category: "UTILITY",
        components: {},
        variablesSchema: {},
      },
    });
    looseTemplateIds.push(template.id);

    const after = await getGlobalCounts();
    const key = `${template.status}|ar`;

    expect((after.templatesByStatusLanguage[key] ?? 0) -
      (before.templatesByStatusLanguage[key] ?? 0)).toBe(1);

    // Every key is a bounded status and a bounded language. A locale like
    // `ar_EG` reaching this map would mean the bucketing had stopped being
    // applied somewhere between the column and the metric.
    for (const composite of Object.keys(after.templatesByStatusLanguage)) {
      const [status, language] = composite.split("|");
      expect(Object.values(TemplateStatus)).toContain(status);
      expect(["ar", "en", "other"]).toContain(language);
    }
  });

  it("counts unrouted replies across every pharmacy", async () => {
    const before = await getGlobalCounts();

    // `pharmacyId: null` is the real shape of an unrouted row: the webhook could
    // not resolve the receiving channel to a pharmacy, so there is nobody to
    // attribute it to. This count is the only place those rows surface at all.
    await addInbound({
      pharmacyId: null,
      status: "UNROUTED",
      processed: false,
      from: "+201003330001",
    });

    const after = await getGlobalCounts();

    expect(after.inboundUnrouted - before.inboundUnrouted).toBe(1);
  });

  it("returns numbers, never identifiers", async () => {
    const counts = await getGlobalCounts();

    // The whole reason this can be cross-tenant while `/admin` cannot: what
    // leaves the process is an integer per bucket. If a shape like this ever
    // grew a `pharmacyId` or a phone number, the token-gated endpoint would have
    // become a way to read the database sideways.
    const serialized = JSON.stringify(counts);

    expect(serialized).not.toMatch(/\+\d{8,}/);
    expect(JSON.stringify(Object.keys(counts))).not.toContain("pharmacyId");

    for (const value of Object.values(counts)) {
      if (typeof value === "object") {
        for (const inner of Object.values(value)) expect(typeof inner).toBe("number");
      } else {
        expect(typeof value).toBe("number");
      }
    }
  });
});
