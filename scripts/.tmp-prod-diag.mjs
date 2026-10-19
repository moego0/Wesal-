// TEMPORARY diagnostic. Connects to the Render Postgres EXTERNAL host derived
// from DATABASE_URL in .env (never prints credentials) and reports what the
// reminder pipeline actually did for the most recent medications.
import fs from "node:fs";
import pg from "pg";

const line = fs
  .readFileSync(".env", "utf8")
  .split(/\r?\n/)
  .find((l) => l.startsWith("DATABASE_URL="));
let raw = line.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, "");
const u = new URL(raw);
if (!u.hostname.includes(".")) {
  u.hostname = `${u.hostname}.oregon-postgres.render.com`;
}
u.searchParams.set("sslmode", "require");
const url = u.toString();

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

function iso(v) {
  if (v == null) return null;
  // pg returns timestamptz as Date; print without timezone ambiguity.
  return new Date(v).toISOString();
}

await client.connect();

const now = await client.query(`SELECT now() AS now`);
console.log("DB now (UTC):", iso(now.rows[0].now));
console.log("");

const counts = await client.query(`
  SELECT
    (SELECT count(*) FROM "Patient")        AS patients,
    (SELECT count(*) FROM "MedicationSchedule") AS schedules,
    (SELECT count(*) FROM "ReminderEvent")  AS events,
    (SELECT count(*) FROM "ReminderDispatch") AS dispatches
`);
console.log("COUNTS:", counts.rows[0]);
console.log("");

const patients = await client.query(`
  SELECT id, "fullName", "phoneE164", status, "messagingOptOutAt",
         "lastInboundAtUtc", "preferredLocale", "createdAt"
  FROM "Patient"
  ORDER BY "createdAt" DESC
  LIMIT 5
`);
console.log("=== RECENT PATIENTS ===");
for (const p of patients.rows) {
  console.log(
    `${p.fullName} | ${p.phoneE164} | status=${p.status} | optOut=${iso(p.messagingOptOutAt)} | created=${iso(p.createdAt)}`,
  );
}
console.log("");

const schedules = await client.query(`
  SELECT s.id, s.status, s."timesOfDay", s."timeZone", s."startDate",
         s."createdAt", s."lateWindowMinutes",
         m."medicationNameText", p."fullName"
  FROM "MedicationSchedule" s
  JOIN "MedicationRecord" m ON m.id = s."medicationId"
  JOIN "Patient" p ON p.id = s."patientId"
  ORDER BY s."createdAt" DESC
  LIMIT 5
`);
console.log("=== RECENT SCHEDULES ===");
for (const s of schedules.rows) {
  console.log(
    `${s.fullName} | ${s.medicationNameText} | status=${s.status} | times=${JSON.stringify(s.timesOfDay)} | tz=${s.timeZone} | start=${iso(s.startDate)} | created=${iso(s.createdAt)} | lateWindow=${s.lateWindowMinutes}`,
  );
}
console.log("");

const events = await client.query(`
  SELECT e.id, e."doseAtUtc", e."doseLocalDate", e."doseLocalTime",
         e."deliveryState", e."cancelReason", e."attemptCount",
         e."createdAt", p."fullName", m."medicationNameText"
  FROM "ReminderEvent" e
  JOIN "Patient" p ON p.id = e."patientId"
  JOIN "MedicationRecord" m ON m.id = e."medicationId"
  ORDER BY e."doseAtUtc" DESC
  LIMIT 12
`);
console.log("=== RECENT EVENTS (by dose time) ===");
for (const e of events.rows) {
  console.log(
    `${e.fullName} | ${e.medicationNameText} | dose=${iso(e.doseAtUtc)} (${e.doseLocalTime} local) | state=${e.deliveryState} | cancel=${e.cancelReason} | attempts=${e.attemptCount} | created=${iso(e.createdAt)}`,
  );
}
console.log("");

const dispatches = await client.query(`
  SELECT d.id, d.status, d.provider, d."providerMessageId", d."errorCode",
         d."errorMessage", d."errorRetryable", d."providerTemplateName",
         d."toPhoneE164", d."createdAt", d."acceptedAtUtc", d."failedAtUtc"
  FROM "ReminderDispatch" d
  ORDER BY d."createdAt" DESC
  LIMIT 10
`);
console.log("=== RECENT DISPATCHES ===");
for (const d of dispatches.rows) {
  console.log(
    `status=${d.status} | provider=${d.provider} | to=${d.toPhoneE164} | template=${d.providerTemplateName} | wamid=${d.providerMessageId} | err=${d.errorCode}/${d.errorRetryable}: ${d.errorMessage} | created=${iso(d.createdAt)}`,
  );
}
console.log("");

const channels = await client.query(`
  SELECT * FROM "MessagingChannel" LIMIT 5
`).catch(() => ({ rows: [], note: "no MessagingChannel table" }));
console.log("=== MESSAGING CHANNELS ===");
for (const c of channels.rows) console.log(JSON.stringify(c));
console.log("");

const heartbeats = await client.query(`
  SELECT * FROM "SweepHeartbeat" ORDER BY "lastRunAtUtc" DESC LIMIT 10
`).catch(() => ({ rows: [] }));
console.log("=== SWEEP HEARTBEATS ===");
for (const h of heartbeats.rows) {
  console.log(
    `${h.sweep} | lastRun=${iso(h.lastRunAtUtc)} | durationMs=${h.lastDurationMs} | error=${h.lastError ?? "-"}`,
  );
}

await client.end();
