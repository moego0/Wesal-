import "dotenv/config";

async function main() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  console.log("Testing fetch to Meta Graph API...");
  console.log(`Phone ID: ${phoneId}`);

  try {
    const t0 = Date.now();
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}?fields=verified_name,code_verification_status,display_phone_number,quality_rating`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    console.log(`Fetch completed in ${Date.now() - t0}ms, status:`, res.status);
    const json = await res.json();
    console.log("Response:", JSON.stringify(json, null, 2));
  } catch (err) {
    console.error("Fetch failed with error:", err);
  }
}

main();
