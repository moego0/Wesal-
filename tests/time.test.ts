import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  computeLateWindowMinutes,
  computeResponseWindowMinutes,
  expandSchedule,
  minutesBetween,
  resolveDoseInstant,
  type ExpandableSchedule,
} from "@/lib/time";

const CAIRO = "Africa/Cairo";

/** Luxon weekday: 1=Mon..7=Sun. We store 0=Sun. */
function weekday(dateIso: string, zone = CAIRO): number {
  return DateTime.fromISO(dateIso, { zone }).weekday % 7;
}

describe("resolveDoseInstant", () => {
  it("resolves an ordinary local time to the right UTC instant", () => {
    const dose = resolveDoseInstant("2026-03-10", "08:00", CAIRO);

    // Egypt is UTC+2 outside DST.
    expect(dose.atUtc.toISOString()).toBe("2026-03-10T06:00:00.000Z");
    expect(dose.localTime).toBe("08:00");
    expect(dose.adjusted).toBe(false);
  });

  it("resolves the same wall-clock time differently once DST is in force", () => {
    // This is the whole reason schedules store wall-clock times: 08:00 must
    // remain 08:00 to the patient, which means a DIFFERENT UTC instant.
    const winter = resolveDoseInstant("2026-03-10", "08:00", CAIRO);
    const summer = resolveDoseInstant("2026-06-10", "08:00", CAIRO);

    expect(winter.atUtc.toISOString()).toBe("2026-03-10T06:00:00.000Z");
    expect(summer.atUtc.toISOString()).toBe("2026-06-10T05:00:00.000Z");
  });

  it("DETECTS the spring-forward gap rather than silently moving the dose", () => {
    // 2026-04-24 00:30 does not exist in Cairo; clocks jump 00:00 -> 01:00.
    // Luxon returns a VALID DateTime shifted to 01:30, so this cannot be
    // caught with isValid() — it has to be detected by comparing wall clocks.
    const dose = resolveDoseInstant("2026-04-24", "00:30", CAIRO);

    expect(dose.adjusted).toBe(true);
    expect(dose.localTime).toBe("01:30");
    expect(dose.atUtc.toISOString()).toBe("2026-04-23T22:30:00.000Z");
  });

  it("picks the FIRST occurrence of an ambiguous fall-back time", () => {
    // 2026-10-29 23:00-23:59 occurs twice. Firing twice would send the patient
    // two reminders for one dose.
    const dose = resolveDoseInstant("2026-10-29", "23:30", CAIRO);

    // +03:00 (still DST) means the earlier of the two occurrences.
    expect(dose.atUtc.toISOString()).toBe("2026-10-29T20:30:00.000Z");
    expect(dose.localTime).toBe("23:30");
  });

  it("rejects a malformed wall-clock time", () => {
    expect(() => resolveDoseInstant("2026-03-10", "8:00", CAIRO)).toThrow(/Invalid wall-clock/);
    expect(() => resolveDoseInstant("2026-03-10", "25:00", CAIRO)).toThrow(/Invalid wall-clock/);
  });
});

describe("expandSchedule", () => {
  const base: ExpandableSchedule = {
    mode: "FIXED_TIMES_OF_DAY",
    timesOfDay: ["08:00", "20:00"],
    daysOfWeek: [],
    intervalHours: null,
    anchorAtUtc: null,
    timeZone: CAIRO,
    startDate: new Date("2026-03-01T00:00:00.000Z"),
    endDate: null,
  };

  it("expands twice-daily dosing across a window", () => {
    const doses = expandSchedule(
      base,
      new Date("2026-03-10T00:00:00.000Z"),
      new Date("2026-03-11T23:59:59.000Z"),
    );

    // 08:00 and 20:00 Cairo on the 10th and 11th.
    expect(doses.map((d) => d.atUtc.toISOString())).toEqual([
      "2026-03-10T06:00:00.000Z",
      "2026-03-10T18:00:00.000Z",
      "2026-03-11T06:00:00.000Z",
      "2026-03-11T18:00:00.000Z",
    ]);
  });

  it("includes the dose pushed by the spring-forward gap and flags it", () => {
    const schedule: ExpandableSchedule = {
      ...base,
      timesOfDay: ["00:30"],
    };

    const doses = expandSchedule(
      schedule,
      new Date("2026-04-23T20:00:00.000Z"),
      new Date("2026-04-24T23:00:00.000Z"),
    );

    const apr24 = doses.find((d) => d.localDate === "2026-04-24");
    expect(apr24).toBeDefined();
    expect(apr24!.adjusted).toBe(true);
    expect(apr24!.localTime).toBe("01:30");
  });

  it("emits exactly one dose across the fall-back overlap", () => {
    const schedule: ExpandableSchedule = { ...base, timesOfDay: ["23:30"] };

    const doses = expandSchedule(
      schedule,
      new Date("2026-10-29T00:00:00.000Z"),
      new Date("2026-10-30T23:00:00.000Z"),
    );

    const onTransitionDay = doses.filter((d) => d.localDate === "2026-10-29");
    expect(onTransitionDay).toHaveLength(1);
  });

  it("honours daysOfWeek", () => {
    // Only Sundays through Thursdays — the Egyptian working week.
    const schedule: ExpandableSchedule = {
      ...base,
      timesOfDay: ["09:00"],
      daysOfWeek: [0, 1, 2, 3, 4],
    };

    const doses = expandSchedule(
      schedule,
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-03-08T23:59:59.000Z"),
    );

    // 2026-03-06 is a Friday and 2026-03-07 a Saturday — both excluded.
    expect(doses.map((d) => d.localDate)).not.toContain("2026-03-06");
    expect(doses.map((d) => d.localDate)).not.toContain("2026-03-07");
    expect(doses.map((d) => d.localDate)).toContain("2026-03-05");
    expect(weekday("2026-03-06")).toBe(5);
  });

  it("does not emit doses before startDate or after endDate", () => {
    const schedule: ExpandableSchedule = {
      ...base,
      timesOfDay: ["09:00"],
      startDate: new Date("2026-03-10T00:00:00.000Z"),
      endDate: new Date("2026-03-12T00:00:00.000Z"),
    };

    const doses = expandSchedule(
      schedule,
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-03-20T00:00:00.000Z"),
    );

    expect(doses.map((d) => d.localDate)).toEqual(["2026-03-10", "2026-03-11", "2026-03-12"]);
  });

  it("expands interval dosing from its anchor", () => {
    const schedule: ExpandableSchedule = {
      ...base,
      mode: "INTERVAL_HOURS",
      timesOfDay: [],
      intervalHours: 6,
      anchorAtUtc: new Date("2026-03-10T06:00:00.000Z"),
    };

    const doses = expandSchedule(
      schedule,
      new Date("2026-03-10T06:00:00.000Z"),
      new Date("2026-03-10T23:00:00.000Z"),
    );

    expect(doses.map((d) => d.atUtc.toISOString())).toEqual([
      "2026-03-10T06:00:00.000Z",
      "2026-03-10T12:00:00.000Z",
      "2026-03-10T18:00:00.000Z",
    ]);
  });

  it("produces nothing for PRN schedules", () => {
    expect(
      expandSchedule(
        { ...base, mode: "PRN", timesOfDay: [] },
        new Date("2026-03-10T00:00:00.000Z"),
        new Date("2026-03-20T00:00:00.000Z"),
      ),
    ).toEqual([]);
  });

  it("is deterministic — the same window twice yields identical instants", () => {
    // This is what makes the materializer safe to re-run: the unique constraint
    // on (scheduleId, doseAtUtc) turns a repeat run into a no-op.
    const from = new Date("2026-03-10T00:00:00.000Z");
    const to = new Date("2026-03-13T00:00:00.000Z");

    const a = expandSchedule(base, from, to).map((d) => d.atUtc.toISOString());
    const b = expandSchedule(base, from, to).map((d) => d.atUtc.toISOString());

    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe("window clamps", () => {
  it("caps the late window at half the time to the next dose", () => {
    // q4h: half of 240 minutes is 120.
    expect(computeLateWindowMinutes(null, 240)).toBe(120);
    // q3h: half of 180 is 90.
    expect(computeLateWindowMinutes(null, 180)).toBe(90);
  });

  it("never lets the late window exceed 180 minutes", () => {
    // Once-daily: half the interval would be 720 minutes, which would allow a
    // reminder at 23:00 for an 08:00 dose.
    expect(computeLateWindowMinutes(null, 1440)).toBe(180);
  });

  it("never lets the late window fall below 20 minutes", () => {
    expect(computeLateWindowMinutes(null, 20)).toBe(20);
  });

  it("honours an explicit override", () => {
    expect(computeLateWindowMinutes(45, 1440)).toBe(45);
  });

  it("keeps the response window within 2h..24h", () => {
    expect(computeResponseWindowMinutes(null, 60)).toBe(180); // 3 x 60, floored at 120
    expect(computeResponseWindowMinutes(null, 1440)).toBe(1440); // capped at 24h
    expect(computeResponseWindowMinutes(null, null)).toBe(1440);
  });
});

describe("minutesBetween", () => {
  it("returns null when the next dose is absent or already past", () => {
    expect(minutesBetween(new Date("2026-03-10T08:00:00Z"), null)).toBeNull();
    expect(
      minutesBetween(new Date("2026-03-10T08:00:00Z"), new Date("2026-03-10T07:00:00Z")),
    ).toBeNull();
  });

  it("measures forward", () => {
    expect(
      minutesBetween(new Date("2026-03-10T08:00:00Z"), new Date("2026-03-10T12:00:00Z")),
    ).toBe(240);
  });
});
