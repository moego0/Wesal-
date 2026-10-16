import "dotenv/config";
import { randomBytes } from "node:crypto";
import { systemPrisma } from "../src/server/db";
import { PASSWORD_ALGO, hashPassword } from "../src/server/auth/password";

/**
 * First-time production setup.
 *
 * Deliberately NOT `prisma/seed.ts`. That seed is a demo dataset: it deletes
 * every row in the database and creates the logins printed in the README. This
 * script is its opposite — idempotent, and it never deletes anything. Running
 * it twice is a no-op, so it is safe to reach for when something looks wrong.
 *
 * What it creates:
 *
 *   1. the pharmacy
 *   2. one admin user (a PHARMACY_ADMIN member of that pharmacy)
 *   3. the MessagingChannel row — the inbound routing key
 *   4. the reminder template record (bookkeeping only, see below)
 *
 * What it does NOT create: `RuleDefinition` rows. Those are derived from the
 * TypeScript catalog by `ensureSystemRules()` at worker boot, so writing them
 * here would only create a second source of truth that can drift.
 *
 * ── The MessagingChannel is the one row that actually matters ──
 *
 * The webhook routes an inbound message by looking up
 * `messagingChannel.providerPhoneNumberId === metadata.phone_number_id`. When no
 * row matches, the message is still persisted — as UNROUTED with a null
 * pharmacy — and the webhook still returns 200. Nothing errors and nothing
 * alerts; the patient taps a button and the pharmacy simply never sees it. The
 * demo seed creates this row with the literal string
 * "mock-phone-number-id-001", which is exactly that failure waiting to happen.
 *
 * So the value here is required, not defaulted.
 *
 * Usage (inside the deployment, after postgres is healthy and migrations are
 * applied):
 *
 *   docker compose -f docker-compose.prod.yml run --rm web npm run db:bootstrap
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required.\n` +
        `  Set it in .env, or pass it inline:\n` +
        `    docker compose -f docker-compose.prod.yml run --rm -e ${name}=… web npm run db:bootstrap`,
    );
  }
  return value;
}

const TEMPLATE_NAME = "wasal_dose_reminder_v1";

async function main() {
  // Required rather than optional: see the note above. An empty value here would
  // create a channel with a key no webhook can ever match.
  const phoneNumberId = required("WHATSAPP_PHONE_NUMBER_ID");

  const adminEmail = required("ADMIN_EMAIL").toLowerCase();
  const pharmacyName = process.env.PHARMACY_NAME?.trim() || "صيدلية النور";

  // ── 1. pharmacy ──
  //
  // Keyed by name so a re-run adopts the existing row instead of creating a
  // second pharmacy with its own (empty) patient list.
  const pharmacy =
    (await systemPrisma.pharmacy.findFirst({ where: { name: pharmacyName } })) ??
    (await systemPrisma.pharmacy.create({
      data: {
        name: pharmacyName,
        timeZone: process.env.PHARMACY_TIMEZONE?.trim() || "Africa/Cairo",
        // Arabic-first, matching every other default in the product.
        defaultLocale: "AR_EG",
        quietHoursStart: process.env.PHARMACY_QUIET_START?.trim() || "21:30",
        quietHoursEnd: process.env.PHARMACY_QUIET_END?.trim() || "07:00",
      },
    }));

  // ── 2. admin user ──
  //
  // The password comes from the environment, or is generated and printed
  // exactly once. Only the scrypt hash is stored, so a generated password that
  // is not captured here is unrecoverable — by design, and worth saying out
  // loud rather than discovering later.
  //
  // `hashPassword` is the same helper the login path verifies against, so the
  // parameters in the stored hash are the ones `verifyPassword` expects.
  const passwordWasGenerated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(18).toString("base64url");

  const existingAdmin = await systemPrisma.user.findUnique({ where: { email: adminEmail } });

  const admin =
    existingAdmin ??
    (await systemPrisma.user.create({
      data: {
        email: adminEmail,
        fullName: process.env.ADMIN_NAME?.trim() || "Pharmacy Admin",
        passwordHash: await hashPassword(password),
        passwordAlgo: PASSWORD_ALGO,
        locale: "AR_EG",
        phoneE164: process.env.ADMIN_PHONE_E164?.trim() || null,
      },
    }));

  // ── 3. membership ──
  //
  // PHARMACY_ADMIN holds the full permission set, including the admin-only
  // `user:manage`, `settings:manage` and `audit:read` that PHARMACIST omits.
  await systemPrisma.pharmacyMembership.upsert({
    where: { userId_pharmacyId: { userId: admin.id, pharmacyId: pharmacy.id } },
    update: { role: "PHARMACY_ADMIN", active: true },
    create: {
      userId: admin.id,
      pharmacyId: pharmacy.id,
      role: "PHARMACY_ADMIN",
      active: true,
    },
  });

  // ── 4. the messaging channel ──
  //
  // `provider` is "whatsapp_cloud", not the seed's "mock": with the mock
  // provider set the outbound path would log to the dev outbox and no patient
  // would ever receive anything.
  const channel = await systemPrisma.messagingChannel.upsert({
    where: { providerPhoneNumberId: phoneNumberId },
    update: { pharmacyId: pharmacy.id, provider: "whatsapp_cloud" },
    create: {
      pharmacyId: pharmacy.id,
      provider: "whatsapp_cloud",
      providerPhoneNumberId: phoneNumberId,
      displayPhoneE164: process.env.WHATSAPP_DISPLAY_PHONE_E164?.trim() || "",
    },
  });

  // ── 5. the reminder template record ──
  //
  // Bookkeeping only: nothing reads this table at send time. The name the code
  // actually sends is a constant, `wasal_dose_reminder_v1` in
  // src/server/scheduling/dispatch.ts. This row exists so the template's
  // category is recorded somewhere queryable — Meta reclassifying it from
  // UTILITY to MARKETING would multiply the per-patient cost roughly
  // eighteen-fold, and that is worth having a row for.
  const existingTemplate = await systemPrisma.whatsAppTemplate.findUnique({
    where: { providerName_languageCode: { providerName: TEMPLATE_NAME, languageCode: "ar" } },
  });

  if (!existingTemplate) {
    await systemPrisma.whatsAppTemplate.create({
      data: {
        pharmacyId: pharmacy.id,
        providerName: TEMPLATE_NAME,
        languageCode: "ar",
        category: "UTILITY",
        // UNKNOWN, not APPROVED: this script has no way to ask Meta, and
        // claiming approval that was never confirmed is the kind of record that
        // gets trusted later.
        status: "UNKNOWN",
        lastSyncedAtUtc: null,
        components: [
          {
            type: "BODY",
            text:
              "تذكير بموعد الدواء لـ {{1}}: معاد {{2}} الساعة {{3}}.\n" +
              "خدت الدواء؟ رد علينا بالزرار اللي تحت، ولو عندك أي سؤال أو مشكلة كلم الصيدلية على طول.",
          },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "خدته ✅" },
              { type: "QUICK_REPLY", text: "لسه ❌" },
              { type: "QUICK_REPLY", text: "عندي مشكلة ⚠️" },
            ],
          },
        ],
        variablesSchema: [
          { index: 1, name: "patient_name", example: "فاطمة" },
          { index: 2, name: "medication", example: "ميتفورمين" },
          { index: 3, name: "time", example: "٨:٠٠ ص" },
        ],
      },
    });
  }

  // ── report ──
  console.log("");
  console.log("  ── bootstrap complete ──────────────────────────────────────");
  console.log(`  pharmacy   ${pharmacy.name}  (${pharmacy.id})`);
  console.log(`  timezone   ${pharmacy.timeZone}, quiet ${pharmacy.quietHoursStart}–${pharmacy.quietHoursEnd}`);
  console.log(`  admin      ${admin.email}  (PHARMACY_ADMIN)`);
  console.log(`  channel    providerPhoneNumberId=${channel.providerPhoneNumberId}`);
  console.log(`  template   ${TEMPLATE_NAME} (ar) — recorded, status UNKNOWN`);
  console.log("");

  if (passwordWasGenerated && !existingAdmin) {
    console.log("  ┌─ ADMIN PASSWORD — SHOWN ONCE, NOT RECOVERABLE ───────────┐");
    console.log(`  │  ${password}`);
    console.log("  └──────────────────────────────────────────────────────────┘");
    console.log("  Only the hash is stored. Save this now.");
    console.log("");
  } else if (existingAdmin) {
    console.log("  Admin already existed; password left unchanged.");
    console.log("");
  }

  if (existingTemplate) {
    console.log("  Template row already existed; left unchanged.");
    console.log("");
  }

  console.log("  Still to confirm by hand, in the Meta dashboard:");
  console.log(`    · a template named exactly "${TEMPLATE_NAME}" approved in ar AND en,`);
  console.log("      with 3 body variables (patient name, medication, time) and the");
  console.log("      three quick-reply buttons — otherwise every send fails with");
  console.log("      132001 template_not_found, which is NOT retried.");
  console.log("    · its category: UTILITY is roughly 18x cheaper than MARKETING.");
  console.log("    · the webhook Callback URL points at this host with the same");
  console.log("      WHATSAPP_VERIFY_TOKEN, and the `messages` field is subscribed.");
  console.log("");
}

main()
  .catch(async (err) => {
    console.error("\n  bootstrap failed:", err instanceof Error ? err.message : err);
    console.error("");
    process.exitCode = 1;
  })
  .finally(async () => {
    await systemPrisma.$disconnect();
  });
