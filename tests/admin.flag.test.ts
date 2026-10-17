import "dotenv/config";

import { describe, expect, it } from "vitest";
import { isAdminEnabled } from "@/server/admin/flag";
import { env, flagEnabled } from "@/server/env";

/**
 * The `ENABLE_ADMIN` switch.
 *
 * The flag decides whether an operations surface exists at all, and it decides
 * it by returning 404 — so a flag that reads as "on" when the operator meant
 * "off" exposes the console, and one that reads "off" when they meant "on"
 * leaves them staring at a missing page with nothing in the logs.
 *
 * Both failures come from the same place: a flag variable whose accepted
 * spellings are wider than its documented ones. `flagEnabled` narrows that to
 * exactly one string, and the table below is the contract.
 */

describe("flagEnabled", () => {
  it('accepts "1"', () => {
    expect(flagEnabled("1")).toBe(true);
  });

  it.each([
    ["0", "the documented off value"],
    ["true", "the other common spelling of on"],
    ["TRUE", "the same, shouted"],
    ["True", "the same, capitalised"],
    ["yes", "a plausible thing to write in an .env file"],
    ["on", "likewise"],
    ["01", "a zero-padded number"],
    ["2", "a count rather than a flag"],
    [" 1", "a leading space from a copy-paste"],
    ["1 ", "a trailing space"],
    ["", "empty, which dotenv produces for `ENABLE_ADMIN=`"],
  ])("treats %j as off (%s)", (raw) => {
    expect(flagEnabled(raw)).toBe(false);
  });
});

describe("ENABLE_ADMIN through the env schema", () => {
  /**
   * The schema runs `.transform(flagEnabled)`. If that transform were ever
   * dropped, the field would be the raw string `"0"` — which is truthy in
   * JavaScript, so the flag would be permanently ON and no test above would
   * notice. Asserting the type is what catches it.
   */
  it("is a boolean, never the raw string", () => {
    expect(typeof env().ENABLE_ADMIN).toBe("boolean");
  });

  it("is what isAdminEnabled() reports", () => {
    expect(isAdminEnabled()).toBe(env().ENABLE_ADMIN);
  });

  /**
   * The default is derived from NODE_ENV rather than fixed, the same way
   * `AUTO_SEED_DEMO` is: on in development so the console needs no setup, off in
   * production so a deployment does not expose an operations surface nobody
   * asked for.
   *
   * Restated here rather than hard-coded, so this passes on a developer machine
   * with `ENABLE_ADMIN=0` in `.env` and still fails if the defaulting rule is
   * inverted — which is the change that would otherwise only ever be noticed in
   * production, where nobody is running the suite.
   */
  it("defaults on outside production and off inside it", () => {
    const expected = process.env.ENABLE_ADMIN
      ? flagEnabled(process.env.ENABLE_ADMIN)
      : process.env.NODE_ENV !== "production";

    expect(env().ENABLE_ADMIN).toBe(expected);
  });
});

describe("METRICS_TOKEN defaults to disabled", () => {
  /**
   * The endpoint's fail-closed default, asserted here rather than in
   * `metrics.auth.test.ts` because that file mocks `env()` in order to drive the
   * handler through both states. This is the one place the REAL value is read.
   *
   * An unset token must resolve to the empty string: the route answers 404 for
   * an empty token, so a deployment that never configured metrics has no
   * endpoint rather than an unauthenticated one.
   */
  it("is the empty string when the environment does not set it", () => {
    expect(env().METRICS_TOKEN).toBe(process.env.METRICS_TOKEN ?? "");
  });

  it("is a string, so an unset value cannot become undefined", () => {
    expect(typeof env().METRICS_TOKEN).toBe("string");
  });
});
