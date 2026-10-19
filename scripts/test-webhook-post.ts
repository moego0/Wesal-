import crypto from "node:crypto";
import "dotenv/config";

async function main() {
  const secret = process.env.WHATSAPP_APP_SECRET!;
  console.log("Using APP_SECRET:", secret.slice(0, 6) + "...");

  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1421222461068438",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+15556609402",
                phone_number_id: "1421222461068438",
              },
              messages: [
                {
                  from: "201011054894",
                  id: "wamid.TEST_" + Date.now(),
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: "Test reply from Mohamed" },
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  });

  const sig =
    "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");

  const res = await fetch("https://wesal-1.onrender.com/api/webhooks/whatsapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sig,
    },
    body: payload,
  });

  console.log("Webhook POST status:", res.status);
  console.log("Webhook POST response:", await res.text());
}

main().catch(console.error);
