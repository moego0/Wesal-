// TEMPORARY diagnostic. Read-only Graph API calls. Prints status codes and
// non-secret fields only; the access token is never logged.
import fs from "node:fs";

const env = Object.fromEntries(
  fs
    .readFileSync(".env", "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);

const TOKEN = env.WHATSAPP_ACCESS_TOKEN;
const VERSION = env.WHATSAPP_API_VERSION || "v21.0";
const CHANNEL_PHONE_ID = "1421222461068438"; // row in MessagingChannel that production uses
const LOCAL_PHONE_ID = env.WHATSAPP_PHONE_NUMBER_ID;

async function get(path) {
  const res = await fetch(`https://graph.facebook.com/${VERSION}/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = { parseError: true };
  }
  return { status: res.status, json };
}

function show(label, r) {
  console.log(`--- ${label} (HTTP ${r.status}) ---`);
  console.log(JSON.stringify(r.json, null, 2));
  console.log("");
}

console.log("token present:", Boolean(TOKEN), "| api:", VERSION);
console.log("");

for (const [label, id] of [
  ["CHANNEL phone id", CHANNEL_PHONE_ID],
  ["LOCAL .env phone id", LOCAL_PHONE_ID],
]) {
  if (!id) continue;
  const r = await get(`${id}?fields=display_phone_number,verified_name,quality_rating,platform_type`);
  show(label, r);
}

show("token debug", await get(`debug_token?input_token=${encodeURIComponent(TOKEN)}`));

const accounts = await get(`me/whatsapp_business_accounts?fields=id,name`);
show("me/whatsapp_business_accounts", accounts);

const wabaIds = new Set();
for (const a of accounts.json?.data ?? []) wabaIds.add(a.id);
// The debug token's granular scopes name the WABA ids the token was granted on.
for (const g of (await get(`debug_token?input_token=${encodeURIComponent(TOKEN)}`)).json?.data?.granular_scopes ?? []) {
  for (const t of g.target_ids ?? []) if (String(t).length > 10) wabaIds.add(String(t));
}

for (const wabaId of wabaIds) {
  show(
    `templates wasal_dose_reminder_v1 in WABA ${wabaId}`,
    await get(
      `${wabaId}/message_templates?name=wasal_dose_reminder_v1&fields=name,status,language,category,rejected_reason`,
    ),
  );
  const all = await get(`${wabaId}/message_templates?limit=50&fields=name,status,language,category`);
  if (all.json?.data) {
    console.log(`--- all templates in WABA ${wabaId} ---`);
    for (const t of all.json.data) console.log(`${t.name} | ${t.language} | ${t.status} | ${t.category}`);
    console.log("");
  }
}
