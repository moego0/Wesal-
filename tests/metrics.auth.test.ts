import "dotenv/config";

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/metrics/route";
import { checkBearerToken } from "@/server/metrics/auth";

/**
 * Authorization on the scrape endpoint.
 *
 * Two separate things are under test, and they fail in different ways.
 *
 * `checkBearerToken` is the comparison itself: it must reject everything that is
 * not the exact token, and — this is the one that matters — it must reject a
 * token of the WRONG LENGTH by returning false rather than by throwing.
 * `timingSafeEqual` throws on a length mismatch, so a naive implementation
 * answers 401 for a guess of the right length and 500 for one of the wrong
 * length, which hands an attacker the token's length and a working oracle.
 *
 * The handler is the policy: unconfigured must be 404 (indistinguishable from no
 * route at all), configured-and-wrong must be 401, and the collectors must not
 * run in either case. A scrape that reaches Postgres before checking the token
 * is a scrape an anonymous caller can make this server perform.
 */

const TOKEN = "s3cret-token-value";

// `env()` is memoised, so a test cannot vary METRICS_TOKEN by writing
// process.env. `vi.hoisted` puts this holder above the `vi.mock` factory that
// closes over it: vitest hoists `vi.mock` calls to the top of the file, and a
// plain `const` written after them would still be in its temporal dead zone when
// the factory is first evaluated.
const { envState, collectMetrics } = vi.hoisted(() => ({
  envState: { METRICS_TOKEN: "" },
  collectMetrics: vi.fn(async () => {}),
}));

vi.mock("@/server/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/env")>()),
  env: () => envState,
}));

// Mocked so the handler's decision can be observed without a database, and so
// "the collectors did not run" is directly assertable.
vi.mock("@/server/metrics/collect", () => ({ collectMetrics }));

/** The handler reads only `headers`, so a header bag is the whole request. */
function scrape(authorization?: string): Promise<Response> {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);

  return GET({ headers } as unknown as NextRequest);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("checkBearerToken", () => {
  it("accepts the exact token", () => {
    expect(checkBearerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("is case-sensitive on the scheme", () => {
    expect(checkBearerToken(`bearer ${TOKEN}`, TOKEN)).toBe(false);
  });

  it("requires the space after the scheme", () => {
    expect(checkBearerToken(`Bearer${TOKEN}`, TOKEN)).toBe(false);
  });

  it("rejects a bare scheme with no token", () => {
    expect(checkBearerToken("Bearer", TOKEN)).toBe(false);
    expect(checkBearerToken("Bearer ", TOKEN)).toBe(false);
    expect(checkBearerToken("Bearer    ", TOKEN)).toBe(false);
  });

  it("rejects a different scheme carrying the right token", () => {
    expect(checkBearerToken(`Basic ${TOKEN}`, TOKEN)).toBe(false);
  });

  it("rejects an absent or null header", () => {
    expect(checkBearerToken(null, TOKEN)).toBe(false);
    expect(checkBearerToken(undefined, TOKEN)).toBe(false);
    expect(checkBearerToken("", TOKEN)).toBe(false);
  });

  /**
   * The oracle. `timingSafeEqual` throws when its two buffers differ in length,
   * and it throws before comparing anything — so these two lines are the
   * difference between a 401 and a 500, and a 500 on a wrong-length guess is a
   * response an attacker can measure.
   */
  it("rejects a token of the wrong length without throwing", () => {
    expect(() => checkBearerToken("Bearer short", TOKEN)).not.toThrow();
    expect(checkBearerToken("Bearer short", TOKEN)).toBe(false);

    expect(() => checkBearerToken(`Bearer ${TOKEN}x`, TOKEN)).not.toThrow();
    expect(checkBearerToken(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
  });

  it("rejects a near-miss that shares the whole prefix", () => {
    const nearMiss = `${TOKEN.slice(0, -1)}z`;
    expect(nearMiss).toHaveLength(TOKEN.length);
    expect(checkBearerToken(`Bearer ${nearMiss}`, TOKEN)).toBe(false);
  });

  /**
   * Fail-closed. An empty `expected` means the deployment never configured
   * metrics; it must not be satisfiable by presenting an empty token, which is
   * why the empty case is rejected explicitly rather than falling out of the
   * comparison.
   */
  it("is false for every header when nothing is configured", () => {
    expect(checkBearerToken("Bearer anything", "")).toBe(false);
    expect(checkBearerToken("Bearer ", "")).toBe(false);
    expect(checkBearerToken("", "")).toBe(false);
    expect(checkBearerToken(null, "")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the scrape endpoint", () => {
  beforeEach(() => {
    collectMetrics.mockClear();
  });

  it("404s when no token is configured, and never collects", async () => {
    envState.METRICS_TOKEN = "";

    const res = await scrape();

    expect(res.status).toBe(404);
    expect(collectMetrics).not.toHaveBeenCalled();
  });

  it("404s on a wrong token too, when no token is configured", async () => {
    envState.METRICS_TOKEN = "";

    // Same answer as the no-header case above: an unconfigured endpoint must not
    // leak, through a different status, that a token would have helped.
    const res = await scrape(`Bearer ${TOKEN}`);

    expect(res.status).toBe(404);
    expect(collectMetrics).not.toHaveBeenCalled();
  });

  it("401s a missing header when a token is configured, and never collects", async () => {
    envState.METRICS_TOKEN = TOKEN;

    const res = await scrape();

    expect(res.status).toBe(401);
    expect(collectMetrics).not.toHaveBeenCalled();
  });

  it("401s a wrong token, and never collects", async () => {
    envState.METRICS_TOKEN = TOKEN;

    const res = await scrape("Bearer not-the-token");

    expect(res.status).toBe(401);
    expect(collectMetrics).not.toHaveBeenCalled();
  });

  /**
   * What makes a misconfigured Prometheus debuggable: the scheme has to be
   * advertised, or the operator is left guessing whether the header was even
   * read.
   */
  it("advertises the Bearer scheme on a 401", async () => {
    envState.METRICS_TOKEN = TOKEN;

    const res = await scrape("Bearer nope");

    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("serves the scrape for the exact token", async () => {
    envState.METRICS_TOKEN = TOKEN;

    const res = await scrape(`Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(collectMetrics).toHaveBeenCalledTimes(1);

    const body = await res.text();

    // The exposition format, and at least one series with a value: the
    // `collectDefaultMetrics` set is registered by the registry itself, so it is
    // present even with every collector mocked away. A 200 with an empty body
    // would be a scrape Prometheus records as an instant failure.
    expect(body).toMatch(/^# HELP /m);
    expect(body).toMatch(/^[a-z_]+.*\s\d+/m);
  });

  it("does not let a scrape be cached", async () => {
    envState.METRICS_TOKEN = TOKEN;

    const res = await scrape(`Bearer ${TOKEN}`);

    // A cached scrape freezes every gauge at the values from whenever it was
    // first fetched, which reads as a system that stopped changing.
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});
