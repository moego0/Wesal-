import "dotenv/config";
import { systemPrisma } from "../src/server/db";

async function main() {
  const patient = await systemPrisma.patient.findFirst({
    where: { phoneE164: "+201011054894" },
    include: {
      schedules: {
        include: {
          medication: true,
          events: {
            orderBy: { doseAtUtc: "desc" },
            take: 10,
          },
        },
      },
    },
  });

  console.log("=== PATIENT ===");
  console.log({
    id: patient?.id,
    fullName: patient?.fullName,
    phoneE164: patient?.phoneE164,
    messagingOptOutAt: patient?.messagingOptOutAt,
    preferredLocale: patient?.preferredLocale,
    lastInboundAtUtc: patient?.lastInboundAtUtc,
  });

  if (patient) {
    for (const s of patient.schedules) {
      console.log(`\nSchedule ${s.id} (${s.medication.medicationNameText}): status=${s.status}, times=${JSON.stringify(s.timesOfDay)}`);
      for (const ev of s.events) {
        console.log(`  Event ${ev.id}: doseAtUtc=${ev.doseAtUtc.toISOString()} localTime=${ev.doseLocalTime} state=${ev.deliveryState} cancelReason=${ev.cancelReason} attemptCount=${ev.attemptCount}`);
      }
    }
  }

  const dispatches = await systemPrisma.reminderDispatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  console.log("\n=== RECENT DISPATCHES ===");
  for (const d of dispatches) {
    console.log(`Dispatch ${d.id}: status=${d.status} provider=${d.provider} providerMsgId=${d.providerMessageId} err=${d.errorCode}: ${d.errorMessage}`);
  }

  const webhooks = await systemPrisma.inboundMessage.findMany({
    orderBy: { receivedAtUtc: "desc" },
    take: 5,
  });
  console.log("\n=== RECENT INBOUND MESSAGES ===");
  console.log(`Total count: ${webhooks.length}`);
  for (const w of webhooks) {
    console.log(`Message ${w.id}: providerMsgId=${w.providerMessageId} status=${w.processingStatus} type=${w.type} payload=${JSON.stringify(w.rawPayload).slice(0, 100)}`);
  }
}

main().catch(console.error).finally(() => systemPrisma.$disconnect());
