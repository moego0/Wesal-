#!/usr/bin/env node
/**
 * Container healthcheck for the worker service.
 *
 * Deliberately NOT a check that the process is alive — Docker already knows
 * that. The failure this is here to catch has no error attached to it and looks
 * exactly like a healthy process:
 *
 *   If Redis is unreachable, `createRedis` retries forever
 *   (`maxRetriesPerRequest: null`) and emits nothing, so the worker never gets
 *   past `upsertJobScheduler`, never prints `[worker] ready`, and never
 *   registers a single sweep. The container stays up, the logs stay clean, and
 *   no reminder is ever sent again.
 *
 * The only externally visible trace of that state is `SweepHeartbeat` — one row
 * per sweep, rewritten on every run. `dispatchSweep` runs every 30 seconds, so
 * a live worker always has a row newer than a minute or so. Stale rows mean the
 * sweeps stopped running, whatever the process is doing.
 *
 * Exit 0 = healthy, 1 = unhealthy. Writes one line to stdout either way, which
 * `docker inspect` surfaces as the health log.
 *
 * Plain CommonJS and required directly by the container. `dotenv/config` is
 * loaded so the same command can be run by hand on the host for diagnosis:
 *
 *   docker compose -f docker-compose.prod.yml exec worker \
 *     node scripts/worker-healthcheck.js
 */

require("dotenv/config");
const { Client } = require("pg");

// `dispatchSweep` ticks every 30s. Ten intervals of slack means a slow query or
// a paused container cannot flip this to unhealthy, while a genuinely wedged
// worker is flagged well before anyone notices reminders have stopped.
const STALE_AFTER_MS = 300_000;

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.log("unhealthy: DATABASE_URL is not set");
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });

  try {
    await client.connect();

    // Compute the age in SQL, deliberately.
    //
    // `SweepHeartbeat.lastRunAtUtc` is a `timestamp WITHOUT time zone` holding
    // a UTC wall clock. Reading it into JS through node-postgres misparses it:
    // pg's default parser for that type treats the bare string as LOCAL time,
    // so on this machine (UTC+3) every value came back shifted three hours into
    // the past and this check reported "unhealthy" against a worker that was
    // running perfectly. Prisma does not have the bug — it registers its own
    // parser — which is exactly what makes it dangerous: it works in the UTC
    // container and breaks on any developer machine east or west of Greenwich.
    //
    // `now() at time zone 'utc'` yields a timestamp-without-zone in UTC, so the
    // subtraction is correct regardless of the database session's TimeZone.
    const { rows } = await client.query(
      `select round(extract(epoch from ((now() at time zone 'utc') - max("lastRunAtUtc"))))::bigint
              as age_seconds
         from "SweepHeartbeat"`,
    );

    const ageSeconds = rows[0] && rows[0].age_seconds === null ? null : Number(rows[0].age_seconds);

    // A fresh database has no rows until the first tick. That is not a fault,
    // and `start_period` in the compose file covers the window; treating it as
    // healthy avoids a container that reports unhealthy on every first boot.
    if (ageSeconds === null || Number.isNaN(ageSeconds)) {
      console.log("healthy: no sweep heartbeats yet (fresh database)");
      return;
    }

    if (ageSeconds * 1000 > STALE_AFTER_MS) {
      console.log(
        `unhealthy: newest sweep heartbeat is ${ageSeconds}s old ` +
          `(limit ${STALE_AFTER_MS / 1000}s) — sweeps have stopped running`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(`healthy: newest sweep heartbeat ${ageSeconds}s old`);
  } catch (err) {
    console.log(`unhealthy: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
