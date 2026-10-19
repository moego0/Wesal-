// TEMPORARY diagnostic: pull the WABA id out of stored webhook payloads.
import fs from "node:fs";
import pg from "pg";

const line = fs.readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
const raw = line.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, "");
const u = new URL(raw);
if (!u.hostname.includes(".")) u.hostname += ".oregon-postgres.render.com";
u.searchParams.set("sslmode", "require");

const client = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
await client.connect();

const r = await client.query(`
  SELECT "providerMessageId", "processingStatus", type, "fromPhoneE164", "toPhoneE164",
         "receivedAtUtc", "rawPayload"
  FROM "InboundMessage"
  ORDER BY "receivedAtUtc" DESC
  LIMIT 10
`);
console.log("inbound rows:", r.rowCount);
for (const row of r.rows) {
  const entryIds = [];
  const metadata = [];
  try {
    const body = typeof row.rawPayload === "string" ? JSON.parse(row.rawPayload) : row.rawPayload;
    for (const e of body?.entry ?? []) {
      entryIds.push(e.id);
      for (const c of e.changes ?? []) {
        metadata.push({
          display_phone_number: c.value?.metadata?.display_phone_number,
          phone_number_id: c.value?.metadata?.phone_number_id,
          field: c.field,
        });
      }
    }
  } catch {
    /* ignore */
  }
  console.log(
    `from=${row.fromPhoneE164} to=${row.toPhoneE164} type=${row.type} status=${row.processingStatus} at=${new Date(row.receivedAtUtc).toISOString()}`,
  );
  console.log(`   entry(WABA)=${entryIds.join(",") || "-"} metadata=${JSON.stringify(metadata)}`);
}

await client.end();
