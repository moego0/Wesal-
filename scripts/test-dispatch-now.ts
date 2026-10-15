import "dotenv/config";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { systemPrisma } from "../src/server/db";
import { claimDueReminders, sendReminder } from "../src/server/scheduling/dispatch";
import { getMessagingProvider } from "../src/server/messaging/factory";

async function main() {
  const patient = await systemPrisma.patient.findFirst({
    where: { phoneE164: "+201011054894" },
    include: { schedules: true },
  });

  if (!patient || patient.schedules.length === 0) {
    console.error("No patient or schedule found!");
    return;
  }

  const schedule = patient.schedules[0];
  console.log(`Using patient: ${patient.fullName}, schedule: ${schedule.id}`);

  // Create or reset a reminder event due right now
  const now = new Date();
  const event = await systemPrisma.reminderEvent.create({
    data: {
      pharmacyId: patient.pharmacyId,
      patientId: patient.id,
      medicationId: schedule.medicationId,
      scheduleId: schedule.id,
      scheduleRevisionSnapshot: schedule.revision,
      doseAtUtc: new Date(now.getTime() - 1000), // 1 second ago so it is due
      doseLocalDate: now,
      doseLocalTime: "22:55",
      deliveryState: "SCHEDULED",
      responseWindowEndsAtUtc: new Date(now.getTime() + 4 * 3600_000),
    },
  });

  console.log(`Created test due ReminderEvent: ${event.id}`);

  // Now claim it
  console.log("Claiming due reminders...");
  const claimRes = await claimDueReminders(now);
  console.log("Claim result:", claimRes);

  if (claimRes.dispatchIds.length === 0) {
    console.error("No dispatches claimed!");
    return;
  }

  const provider = getMessagingProvider();
  console.log(`Using provider: ${provider.name}`);

  for (const dispatchId of claimRes.dispatchIds) {
    console.log(`Sending reminder for dispatch: ${dispatchId}...`);
    const sendRes = await sendReminder(dispatchId, provider, now);
    console.log("Send result:", sendRes);
  }
}

main().catch(console.error).finally(() => systemPrisma.$disconnect());
