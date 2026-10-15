import "dotenv/config";

async function main() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const wamid = "wamid.HBgMMjAxMDExMDU0ODk0FQIAERgSQkYxQjA4QTYwOTEwN0M4MDBGAA==";

  // Let's check the business profile or messages if possible
  const res = await fetch(`https://graph.facebook.com/v21.0/${wamid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log("Status query:", res.status);
  const json = await res.json();
  console.log("Response:", json);
}

main().catch(console.error);
