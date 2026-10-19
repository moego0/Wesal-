import "dotenv/config";
import dns from "node:dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.setDefaultResultOrder("ipv4first");

import { fetch as undiciFetch, Agent } from "undici";
const agent = new Agent({ connect: { family: 4 } });

async function main() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  console.log(`Checking Phone ID: ${phoneId}`);
  const phoneRes = await undiciFetch(
    `https://graph.facebook.com/v26.0/${phoneId}?fields=verified_name,display_phone_number`,
    {
      dispatcher: agent,
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  const phoneData = await phoneRes.json();
  console.log("Phone Info:", phoneData);

  // If there's an error or we need WABA
  const wabaRes = await fetch(
    `https://graph.facebook.com/v26.0/${phoneId}?fields=whatsapp_business_management`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  // Let's test sending wasal_dose_reminder_v1 (en) to Mohamed
  console.log("\nAttempting send of wasal_dose_reminder_v1 (en)...");
  const sendRes = await undiciFetch(
    `https://graph.facebook.com/v26.0/${phoneId}/messages`,
    {
      dispatcher: agent,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "201011054894",
        type: "template",
        template: {
          name: "wasal_dose_reminder_v1",
          language: { code: "en" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: "Mohamed" },
                { type: "text", text: "Panadol" },
                { type: "text", text: "14:30" },
              ],
            },
          ],
        },
      }),
    }
  );
  console.log("Send (en) status:", sendRes.status);
  console.log("Send (en) body:", await sendRes.json());

  console.log("\nAttempting send of wasal_dose_reminder_v1 (ar)...");
  const sendResAr = await undiciFetch(
    `https://graph.facebook.com/v26.0/${phoneId}/messages`,
    {
      dispatcher: agent,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "201011054894",
        type: "template",
        template: {
          name: "wasal_dose_reminder_v1",
          language: { code: "ar" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: "محمد" },
                { type: "text", text: "بنادول" },
                { type: "text", text: "14:30" },
              ],
            },
          ],
        },
      }),
    }
  );
  console.log("Send (ar) status:", sendResAr.status);
  console.log("Send (ar) body:", await sendResAr.json());
}

main().catch(console.error);
