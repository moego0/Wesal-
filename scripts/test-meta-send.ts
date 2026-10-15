import "dotenv/config";
import { WhatsAppCloudProvider } from "../src/server/messaging/providers/whatsapp-cloud";

async function main() {
  const provider = new WhatsAppCloudProvider();
  console.log("Testing provider.sendTemplate with wasal_dose_reminder_v1...");
  const res1 = await provider.sendTemplate({
    to: "+201011054894",
    templateName: "wasal_dose_reminder_v1",
    languageCode: "ar",
    variables: { "1": "محمد", "2": "بنادول", "3": "22:30" },
  });
  console.log("Template result:", res1);

  console.log("\nTesting provider.sendTemplate with hello_world...");
  const res2 = await provider.sendTemplate({
    to: "+201011054894",
    templateName: "hello_world",
    languageCode: "en_US",
    variables: {},
  });
  console.log("Hello world result:", res2);
}

main().catch(console.error);
