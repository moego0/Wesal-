import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemPrisma } from "@/server/db";
import {
  applyDeliveryCallback,
  claimDueReminder,
  settleNoResponse,
} from "@/server/scheduling/dispatch";

/**
 * The dispatch state machine, and the one line that makes it safe.
 *
 * `claimDueReminder` ends in a compare-and-swap:
 *
 *     UPDATE "ReminderEvent" SET deliveryState = 'SENDING', ...
 *      WHERE id = $1 AND deliveryState = 'SCHEDULED'
 *
 * That WHERE clause is the entire at-most-once guarantee. Redis cannot provide
 * it — a flushed Redis, a redelivered BullMQ job and a second worker all look
 * identical to the database, which is exactly why the claim is here and not in
 * a queue. If someone ever "simplifies" this into a read-then-write, two
 * workers will send the same dose to the same patient and nothing will log an
 * error. The concurrency test below is what fails when that happens.
 *
 * The callback tests cover the other half: Meta delivers status callbacks OUT OF
 * ORDER, and a late `sent` must not regress a message the patient already read.
 */

const RUN = randomUUID().slice(0, 8);

let pharmacyId: string;
let seq = 0;

beforeAll(async () => {
  const pharmacy = await systemPrisma.pharmacy.create({
    data: { name: `Dispatch (${RUN})` },
  });
  pharmacyId = pharmacy.id;
});

afterAll(async () => {
  await systemPrisma.pharmacy.delete({ where: { id: pharmacyId } }).catch(() => {});
  await systemPrisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

type ScheduleOptions = {
  status?: "ACTIVE" | "PAUSED" | "DISCONTINUED" | "COMPLETED";
  revision?: number;
  /** Null means "use the computed clamp", which never exceeds 180 minutes. */
  lateWindowMinutes?: number | null;
};

/**
 * A patient, a medication and a schedule.
 *
 * Every test gets its own, so one test pausing a schedule or opting a patient
 * out cannot reach into another's fixture.
 *
 * There is deliberately NO `WHATSAPP_MESSAGING` consent record here. Reminders
 * go out without one — see `consent.ts` — and leaving it out of every fixture is
 * what keeps that true: reintroducing a consent pre-flight turns this whole file
 * red instead of one test.
 */
async function makeSchedule(options: ScheduleOptions = {}) {
  const n = (seq += 1);

  const patient = await systemPrisma.patient.create({
    data: {
      pharmacyId,
      fullName: `Dispatch Patient ${RUN}-${n}`,
      phoneE164: `+20107${String(n).padStart(6, "0")}`,
    },
  });

  const medication = await systemPrisma.medicationRecord.create({
    data: {
      pharmacyId,
      patientId: patient.id,
      medicationNameText: `Dispatch Medicine ${n}`,
      startedOn: new Date("2026-01-01T00:00:00.000Z"),
    },
  });

  const schedule = await systemPrisma.medicationSchedule.create({
    data: {
      pharmacyId,
      patientId: patient.id,
      medicationId: medication.id,
      mode: "FIXED_TIMES_OF_DAY",
      timesOfDay: ["08:00"],
      daysOfWeek: [],
      timeZone: "Africa/Cairo",
      startDate: new Date("2026-01-01T00:00:00.000Z"),
      status: options.status ?? "ACTIVE",
      revision: options.revision ?? 1,
      lateWindowMinutes: options.lateWindowMinutes ?? null,
    },
  });

  return { patient, medication, schedule };
}

/** A dose that is due now but not yet claimed. */
async function makeDueDose(
  fixture: Awaited<ReturnType<typeof makeSchedule>>,
  minutesAgo = 5,
  overrides: Record<string, unknown> = {},
) {
  const doseAtUtc = new Date(Date.now() - minutesAgo * 60_000);

  return systemPrisma.reminderEvent.create({
    data: {
      pharmacyId,
      patientId: fixture.patient.id,
      medicationId: fixture.medication.id,
      scheduleId: fixture.schedule.id,
      scheduleRevisionSnapshot: fixture.schedule.revision,
      doseAtUtc,
      doseLocalDate: new Date(`${doseAtUtc.toISOString().slice(0, 10)}T00:00:00.000Z`),
      doseLocalTime: "08:00",
      responseWindowEndsAtUtc: new Date(doseAtUtc.getTime() + 4 * 3_600_000),
      deliveryState: "SCHEDULED",
      ...overrides,
    },
  });
}

async function readEvent(id: string) {
  return systemPrisma.reminderEvent.findUniqueOrThrow({
    where: { id },
    select: {
      deliveryState: true,
      attemptCount: true,
      activeDispatchId: true,
      cancelReason: true,
      supersededByScheduleRevision: true,
      responseState: true,
      settledAtUtc: true,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the claim is at-most-once", () => {
  it("lets exactly one of two concurrent claims win", async () => {
    const fixture = await makeSchedule();
    const event = await makeDueDose(fixture);

    const outcomes = await Promise.all([
      claimDueReminder(event.id),
      claimDueReminder(event.id),
    ]);

    const claimed = outcomes.filter((o) => o.status === "claimed");
    expect(claimed).toHaveLength(1);

    const loser = outcomes.find((o) => o.status === "skipped");
    expect(loser).toBeDefined();
    if (loser?.status !== "skipped") throw new Error("unreachable");

    /*
     * Both reasons are correct, and which one appears depends on how the two
     * transactions interleave: a loser that read the row before the winner
     * committed gets LOST_RACE from the CAS, and one that read afterwards gets
     * NOT_SCHEDULED from the early return. Pinning a specific one would make
     * this test pass or fail on timing rather than on the guarantee.
     */
    expect(["LOST_RACE", "NOT_SCHEDULED"]).toContain(loser.reason);

    const after = await readEvent(event.id);
    expect(after.deliveryState).toBe("SENDING");
    expect(after.attemptCount).toBe(1);

    // One dispatch row, not two. A second row here is a second WhatsApp message
    // to the same patient for the same dose.
    const dispatches = await systemPrisma.reminderDispatch.findMany({
      where: { reminderEventId: event.id },
      select: { id: true, attemptNo: true },
    });

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].attemptNo).toBe(1);
    expect(after.activeDispatchId).toBe(dispatches[0].id);
  });

  it("refuses a second claim on a dose already in flight", async () => {
    const fixture = await makeSchedule();
    const event = await makeDueDose(fixture);

    const first = await claimDueReminder(event.id);
    expect(first.status).toBe("claimed");

    const second = await claimDueReminder(event.id);
    expect(second.status).toBe("skipped");
    if (second.status !== "skipped") throw new Error("unreachable");
    expect(second.reason).toBe("NOT_SCHEDULED");

    // The attempt counter is the record of how many times we tried. A refused
    // claim must not increment it, or the delivery log reports retries that
    // never happened.
    expect((await readEvent(event.id)).attemptCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the pre-send guards, checked inside the claim transaction", () => {
  /*
   * Consent is evidence, not a permission.
   *
   * The fixture already carries no consent record at all, so this test adds the
   * loudest possible one — withdrawn, with a reason — and demands the dose still
   * go out. If a consent pre-flight is ever reintroduced, this is the test that
   * fails, and it fails for the right reason.
   */
  it("sends the dose even when a consent record was revoked after enrollment", async () => {
    const fixture = await makeSchedule();
    const event = await makeDueDose(fixture);

    await systemPrisma.consentRecord.create({
      data: {
        pharmacyId,
        patientId: fixture.patient.id,
        consentType: "WHATSAPP_MESSAGING",
        granted: false,
        revokedAt: new Date(),
        revokedReason: "patient request",
        captureMethod: "DIGITAL",
      },
    });

    const outcome = await claimDueReminder(event.id);

    expect(outcome.status).toBe("claimed");

    const after = await readEvent(event.id);
    expect(after.deliveryState).toBe("SENDING");
    expect(after.cancelReason).toBeNull();
  });

  /*
   * The one thing that still stops a send, and the reason it is not negotiable:
   * the patient themselves asked us to stop. This is the guard that keeps the
   * number sendable — Meta's quality rating is driven by recipients blocking and
   * reporting, which is what an ignored STOP produces.
   *
   * `messagingOptOutAt` is set directly rather than through `recordOptOut`,
   * because `recordOptOut` also cancels the already-materialized events and this
   * test is about the claim-time guard, not the sweep.
   */
  it("cancels the dose when the patient has opted out", async () => {
    const fixture = await makeSchedule();
    const event = await makeDueDose(fixture);

    await systemPrisma.patient.update({
      where: { id: fixture.patient.id },
      data: { messagingOptOutAt: new Date() },
    });

    const outcome = await claimDueReminder(event.id);

    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toBe("OPTED_OUT");

    const after = await readEvent(event.id);
    expect(after.deliveryState).toBe("CANCELLED");
    expect(after.cancelReason).toBe("OPTED_OUT");
  });

  it("cancels the dose when the patient is no longer active", async () => {
    const fixture = await makeSchedule();
    const event = await makeDueDose(fixture);

    await systemPrisma.patient.update({
      where: { id: fixture.patient.id },
      data: { status: "ARCHIVED" },
    });

    const outcome = await claimDueReminder(event.id);

    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toBe("PATIENT_NOT_ACTIVE");

    expect((await readEvent(event.id)).deliveryState).toBe("CANCELLED");
  });

  it("cancels the dose when the medication was paused", async () => {
    const fixture = await makeSchedule();
    const event = await makeDueDose(fixture);

    await systemPrisma.medicationSchedule.update({
      where: { id: fixture.schedule.id },
      data: { status: "PAUSED" },
    });

    const outcome = await claimDueReminder(event.id);

    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toBe("SCHEDULE_INACTIVE");

    const after = await readEvent(event.id);
    expect(after.deliveryState).toBe("CANCELLED");
    // The cause names the state that stopped it, so a pharmacist reading the
    // delivery log can tell a pause from a discontinuation.
    expect(after.cancelReason).toBe("SCHEDULE_PAUSED");
  });

  it("supersedes a dose whose schedule moved under it", async () => {
    const fixture = await makeSchedule();
    const event = await makeDueDose(fixture);

    // A time edit bumps `revision`. The row still describes 08:00; the schedule
    // no longer does.
    await systemPrisma.medicationSchedule.update({
      where: { id: fixture.schedule.id },
      data: { timesOfDay: ["09:00"], revision: { increment: 1 } },
    });

    const outcome = await claimDueReminder(event.id);

    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toBe("REVISION_MISMATCH");

    const after = await readEvent(event.id);
    // SUPERSEDED, not CANCELLED: this dose was moved, not withdrawn. Adherence
    // reporting treats the two differently.
    expect(after.deliveryState).toBe("SUPERSEDED");
    expect(after.supersededByScheduleRevision).toBe(2);
  });

  it("expires a dose that has become too late to be worth sending", async () => {
    const fixture = await makeSchedule();
    // Four hours old. The computed late window never exceeds 180 minutes, so no
    // configuration of this schedule can still consider it sendable.
    const event = await makeDueDose(fixture, 240);

    const outcome = await claimDueReminder(event.id);

    expect(outcome.status).toBe("skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toBe("TOO_LATE");

    const after = await readEvent(event.id);
    // EXPIRED and not FAILED: nothing was attempted and nothing went wrong at
    // the provider. This dose is excluded from adherence, so it can never be
    // counted against the patient.
    expect(after.deliveryState).toBe("EXPIRED");
    expect(after.cancelReason).toBe("TOO_LATE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("delivery callbacks arriving out of order", () => {
  /** A dispatch whose message has been accepted by the provider. */
  async function makeSentDispatch(deliveryState: "SENT" | "DELIVERED" | "CANCELLED" = "SENT") {
    const fixture = await makeSchedule();
    const event = await makeDueDose(fixture, 5, { deliveryState });
    const providerMessageId = `wamid.${RUN}.${randomUUID()}`;

    const dispatch = await systemPrisma.reminderDispatch.create({
      data: {
        id: randomUUID(),
        pharmacyId,
        reminderEventId: event.id,
        attemptNo: 1,
        provider: "mock",
        providerMessageId,
        toPhoneE164: fixture.patient.phoneE164,
        status: deliveryState === "DELIVERED" ? "DELIVERED" : "SENT",
        reconcileDeadlineUtc: new Date(Date.now() + 300_000),
      },
    });

    return { event, dispatch, providerMessageId };
  }

  it("applies receipts in order and refuses to regress", async () => {
    const { event, providerMessageId } = await makeSentDispatch();

    const read = await applyDeliveryCallback(providerMessageId, "read", new Date());
    expect(read.applied).toBe(true);
    expect((await readEvent(event.id)).deliveryState).toBe("READ");

    // Meta does deliver a `sent` callback after a `read` callback. Applying it
    // blindly would walk a read message back to sent, and the pharmacist's
    // delivery log would lose the fact that the patient opened it.
    const late = await applyDeliveryCallback(providerMessageId, "sent", new Date());
    expect(late.applied).toBe(false);
    expect(late.reason).toBe("OUT_OF_ORDER");
    expect((await readEvent(event.id)).deliveryState).toBe("READ");
  });

  it("applies a delivered receipt that upgrades a sent message", async () => {
    const { event, providerMessageId } = await makeSentDispatch();

    const delivered = await applyDeliveryCallback(providerMessageId, "delivered", new Date());

    expect(delivered.applied).toBe(true);
    expect((await readEvent(event.id)).deliveryState).toBe("DELIVERED");
  });

  it("ignores a receipt for a message we have no record of", async () => {
    const result = await applyDeliveryCallback(`wamid.${RUN}.unknown`, "delivered", new Date());

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("UNKNOWN_MESSAGE_ID");
  });

  it("refuses to move a cancelled dose back when a receipt arrives late", async () => {
    const { event, providerMessageId } = await makeSentDispatch("CANCELLED");

    const result = await applyDeliveryCallback(providerMessageId, "delivered", new Date());

    expect(result.applied).toBe(false);
    expect(result.reason).toBe("EVENT_TERMINAL");
    expect((await readEvent(event.id)).deliveryState).toBe("CANCELLED");
  });

  it("disbelieves a failure report for a message the device already acknowledged", async () => {
    const { event, providerMessageId } = await makeSentDispatch("DELIVERED");

    const result = await applyDeliveryCallback(providerMessageId, "failed", new Date(), {
      code: "131026",
      title: "Message undeliverable",
    });

    // Meta occasionally emits a late failure for a message that was delivered
    // and read. Believing it would put a false "delivery failed" in front of the
    // pharmacist for a dose the patient actually received.
    expect(result.applied).toBe(false);
    expect(result.reason).toBe("NOT_IN_FAILABLE_STATE");
    expect((await readEvent(event.id)).deliveryState).toBe("DELIVERED");
  });

  it("believes a failure report for a message still in flight", async () => {
    const { event, providerMessageId } = await makeSentDispatch();

    const result = await applyDeliveryCallback(providerMessageId, "failed", new Date(), {
      code: "131026",
      title: "Message undeliverable",
    });

    expect(result.applied).toBe(true);

    const after = await readEvent(event.id);
    expect(after.deliveryState).toBe("FAILED");
    expect(after.cancelReason).toBe("131026");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("settling silence", () => {
  /*
   * These assert on the ROW, never on the returned count. `settleNoResponse`
   * sweeps the whole database, so its count depends on what other suites left
   * behind and on whether they are running concurrently — a count assertion
   * here would be a flaky test that looks like a real one.
   */

  it("stamps settledAtUtc and leaves responseState as NONE", async () => {
    const fixture = await makeSchedule();
    const windowClosed = new Date(Date.now() - 60_000);
    const event = await makeDueDose(fixture, 120, {
      deliveryState: "DELIVERED",
      responseWindowEndsAtUtc: windowClosed,
    });

    await settleNoResponse(new Date());

    const after = await readEvent(event.id);
    expect(after.settledAtUtc).not.toBeNull();

    // The whole point of a derived disposition. Writing a NO_RESPONSE value into
    // responseState would force a choice about whether a late reply overwrites
    // it, and that choice is where wrong adherence numbers come from.
    expect(after.responseState).toBe("NONE");
  });

  it("leaves a dose whose window is still open alone", async () => {
    const fixture = await makeSchedule();
    const event = await makeDueDose(fixture, 5, {
      deliveryState: "DELIVERED",
      responseWindowEndsAtUtc: new Date(Date.now() + 3_600_000),
    });

    await settleNoResponse(new Date());

    expect((await readEvent(event.id)).settledAtUtc).toBeNull();
  });

  it("does not settle a dose that was never delivered", async () => {
    const fixture = await makeSchedule();
    // Our own outage, not the patient's silence. Settling it would put it in the
    // adherence denominator as a missed dose.
    const event = await makeDueDose(fixture, 120, {
      deliveryState: "EXPIRED",
      responseWindowEndsAtUtc: new Date(Date.now() - 60_000),
    });

    await settleNoResponse(new Date());

    expect((await readEvent(event.id)).settledAtUtc).toBeNull();
  });

  it("does not settle a dose that was never sent", async () => {
    const fixture = await makeSchedule();
    const event = await makeDueDose(fixture, 120, {
      deliveryState: "SCHEDULED",
      responseWindowEndsAtUtc: new Date(Date.now() - 60_000),
    });

    await settleNoResponse(new Date());

    expect((await readEvent(event.id)).settledAtUtc).toBeNull();
  });
});
