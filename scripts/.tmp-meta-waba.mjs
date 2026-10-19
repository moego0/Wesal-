// TEMPORARY diagnostic: find the WABA(s) this token can see and list templates.
import fs from "node:fs";
const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);
const TOKEN = env.WHATSAPP_ACCESS_TOKEN;
const V = env.WHATSAPP_API_VERSION || "v21.0";
const SYS_USER = "122100015003515718";

async function get(path) {
  const res = await fetch(`https://graph.facebook.com/${V}/${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

for (const path of [
  `${SYS_USER}/assigned_whatsapp_business_accounts?fields=id,name`,
  `${SYS_USER}/assigned_businesses?fields=id,name`,
  `me/businesses?fields=id,name`,
  `${SYS_USER}?fields=id,name`,
]) {
  const r = await get(path);
  console.log(`--- ${path} (HTTP ${r.status})`);
  console.log(JSON.stringify(r.json).slice(0, 600));
  console.log("");
}

const wabas = new Set();
for (const path of [`${SYS_USER}/assigned_whatsapp_business_accounts?fields=id,name`]) {
  const r = await get(path);
  for (const a of r.json?.data ?? []) wabas.add(a.id);
}

for (const waba of wabas) {
  console.log(`=== WABA ${waba} ===`);
  const phones = await get(`${waba}/phone_numbers?fields=id,display_phone_number,verified_name`);
  console.log("phones:", JSON.stringify(phones.json));
  const t = await get(`${waba}/message_templates?limit=100&fields=name,status,language,category,rejected_reason`);
  console.log("templates HTTP", t.status);
  for (const x of t.json?.data ?? []) console.log(`  ${x.name} | ${x.language} | ${x.status} | ${x.category}`);
  if (t.json?.error) console.log(JSON.stringify(t.json.error));
  console.log("");
}
