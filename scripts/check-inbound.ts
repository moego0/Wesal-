import pg from "pg";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

const pool = new pg.Pool({
  host: "3.120.236.187",
  port: 5432,
  user: "wasal_db_txjr_user",
  password: "vJ3OY58sAPsdpmQ5tWRNaBlzEi1xonxk",
  database: "wasal_db_txjr",
  ssl: {
    rejectUnauthorized: false,
    servername: "dpg-db8j2k0u01pc738cd2s0-a.frankfurt-postgres.render.com",
  },
});

async function main() {
  console.log("Connecting to Render PostgreSQL...");
  const client = await pool.connect();
  try {
    const inbounds = await client.query(
      `SELECT * FROM "InboundMessage" ORDER BY "receivedAtUtc" DESC LIMIT 10`
    );
    console.log(`\n=== INBOUND MESSAGES (${inbounds.rows.length}) ===`);
    for (const row of inbounds.rows) {
      console.log(row);
    }

    const channels = await client.query(
      `SELECT * FROM "MessagingChannel"`
    );
    console.log(`\n=== CHANNELS (${channels.rows.length}) ===`);
    for (const row of channels.rows) {
      console.log(row);
    }

    const heartbeats = await client.query(
      `SELECT * FROM "SweepHeartbeat" ORDER BY "lastRunAtUtc" DESC`
    );
    console.log(`\n=== WORKER HEARTBEATS (${heartbeats.rows.length}) ===`);
    for (const row of heartbeats.rows) {
      console.log(row);
    }

    const responses = await client.query(
      `SELECT * FROM "PatientResponse" ORDER BY "recordedAtUtc" DESC LIMIT 10`
    );
    console.log(`\n=== PATIENT RESPONSES (${responses.rows.length}) ===`);
    for (const row of responses.rows) {
      console.log(row);
    }

    const events = await client.query(
      `SELECT id, "patientId", "deliveryState", "doseAtUtc", "doseLocalTime" FROM "ReminderEvent" ORDER BY "createdAt" DESC LIMIT 5`
    );
    console.log(`\n=== RECENT REMINDER EVENTS (${events.rows.length}) ===`);
    for (const row of events.rows) {
      console.log(row);
    }

    const dispatches = await client.query(
      `SELECT * FROM "ReminderDispatch" ORDER BY "createdAt" DESC LIMIT 5`
    );
    console.log(`\n=== RECENT DISPATCHES (${dispatches.rows.length}) ===`);
    for (const row of dispatches.rows) {
      console.log(row);
    }

    const patients = await client.query(
      `SELECT id, "fullName", "phoneE164" FROM "Patient" LIMIT 5`
    );
    console.log(`\n=== PATIENTS (${patients.rows.length}) ===`);
    for (const row of patients.rows) {
      console.log(row);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
