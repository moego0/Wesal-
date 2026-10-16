import "dotenv/config";
import { DateTime } from "luxon";
import { systemPrisma } from "../src/server/db";
import { hashPassword } from "../src/server/auth/password";
import { materializeDueSchedules } from "../src/server/scheduling/materialize";
import { resolveDoseInstant } from "../src/lib/time";
import { evaluateRulesSweep, ensureSystemRules } from "../src/server/rules/evaluator";
import { applyResponse } from "../src/server/responses/applyResponse";

/**
 * Synthetic seed data.
 *
 * PRD §12 is explicit that acceptance testing must use synthetic data, and that
 * live patient data must not be used until the safeguards and approvals are in
 * place. So every patient here is invented, every phone number is fake, and no
 * record in this file corresponds to a real person.
 *
 * The personas are not decoration. Each one is constructed so that a SPECIFIC
 * piece of clinical logic has something to fire on, which makes this seed the
 * fastest way to see whether the rules, the adherence maths and the dashboard
 * work end to end:
 *
 *   فاطمة    — good adherence; the baseline everything else is measured against
 *   محمود    — deteriorating; drives CONSECUTIVE_MISSES and ADHERENCE_DROP
 *   سعاد     — never engaged; drives NO_ENGAGEMENT (a wrong-number problem)
 *   أحمد     — reported a side effect; opens an URGENT alert and a case
 *   نادية    — frequently late; drives FREQUENT_LATE_TAKING
 *   كريم     — used to respond, then went quiet; drives NO_RESPONSE_STREAK
 *   ليلى     — shares نادية's handset, so an unattributed reply from that number
 *              is genuinely ambiguous and must not be guessed at
 *
 * History is written directly, because we cannot time-travel the sweeps. The
 * future is NOT written here: it comes from the real materializer, so the rows a
 * demo exercises are produced by the same code production runs.
 */

const TZ = "Africa/Cairo";
const HISTORY_DAYS = 21;

/** Deterministic PRNG, so re-seeding reproduces the same demo. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const rand = makeRandom(20261014);

type Outcomes = { taken: number; late: number; missed: number; noResponse: number };

type DoseAnswer = "TAKEN" | "TAKEN_LATE" | "MISSED" | "NONE";

type Persona = {
  fullName: string;
  /** Fake, but structurally valid E.164 for Egypt. */
  phone: string;
  profile: Outcomes;
  /** Behaviour change over the last N days — the "deteriorating" hook. */
  shift?: { lastDays: number; profile: Partial<Outcomes> };
  /**
   * Explicit outcomes for named recent days, overriding the random profile.
   *
   * Some rules only fire on an exact pattern. CONSECUTIVE_MISSES needs three
   * explicit reports in a row, and a random draw just as often produces two
   * misses and a silence — where silence is deliberately NOT a miss, so the rule
   * stays quiet and the demo shows nothing. Scripting those specific days is the
   * difference between a seed that demonstrates the safety rules and one that
   * merely claims to.
   */
  script?: { daysAgo: number; responseState: DoseAnswer }[];
  /** Never answers anything, ever. */
  neverResponds?: boolean;
  /** Answered reliably until N days ago, then stopped. */
  quietSinceDays?: number;
  medications: {
    name: string;
    dose: string;
    times: string[];
    startedDaysAgo: number;
  }[];
};

const PERSONAS: Persona[] = [
  {
    fullName: "فاطمة السيد إبراهيم",
    phone: "+201001234567",
    profile: { taken: 0.92, late: 0.04, missed: 0.02, noResponse: 0.02 },
    medications: [
      { name: "ميتفورمين ٥٠٠ مجم", dose: "قرص واحد", times: ["08:00", "20:00"], startedDaysAgo: 60 },
      { name: "أملوديبين ٥ مجم", dose: "قرص واحد", times: ["09:00"], startedDaysAgo: 60 },
    ],
  },
  {
    fullName: "محمود عبد الرحمن",
    phone: "+201112345678",
    // Adherent for most of the history, then falls off a cliff — the pattern
    // ADHERENCE_DROP exists to catch and a level-based rule never sees.
    profile: { taken: 0.85, late: 0.08, missed: 0.04, noResponse: 0.03 },
    shift: { lastDays: 4, profile: { taken: 0.15, late: 0.1, missed: 0.55, noResponse: 0.2 } },
    // Three explicit misses in a row, which is exactly what CONSECUTIVE_MISSES
    // requires. Left to chance this run produced two misses and then a silence,
    // and the rule correctly stayed quiet — silence is not a miss.
    script: [
      { daysAgo: 3, responseState: "MISSED" },
      { daysAgo: 2, responseState: "MISSED" },
      { daysAgo: 1, responseState: "MISSED" },
    ],
    medications: [
      { name: "أتورفاستاتين ٢٠ مجم", dose: "قرص واحد", times: ["21:00"], startedDaysAgo: 90 },
    ],
  },
  {
    fullName: "سعاد حسن علي",
    phone: "+201223456789",
    profile: { taken: 0, late: 0, missed: 0, noResponse: 1 },
    neverResponds: true,
    medications: [
      { name: "ليفوثيروكسين ٥٠ ميكروجرام", dose: "قرص واحد", times: ["07:00"], startedDaysAgo: 45 },
    ],
  },
  {
    fullName: "أحمد فؤاد سالم",
    phone: "+201234567890",
    profile: { taken: 0.7, late: 0.1, missed: 0.1, noResponse: 0.1 },
    medications: [
      { name: "أسبرين ٨١ مجم", dose: "قرص واحد", times: ["13:00"], startedDaysAgo: 30 },
    ],
  },
  {
    fullName: "نادية إبراهيم محمد",
    phone: "+201556789012",
    profile: { taken: 0.45, late: 0.42, missed: 0.08, noResponse: 0.05 },
    medications: [
      { name: "ميتفورمين ٨٥٠ مجم", dose: "قرص واحد", times: ["08:00", "20:00"], startedDaysAgo: 120 },
    ],
  },
  {
    fullName: "كريم مصطفى كامل",
    phone: "+201067890123",
    profile: { taken: 0.8, late: 0.1, missed: 0.05, noResponse: 0.05 },
    // Responded reliably until five days ago, then stopped entirely. The
    // reminders still get delivered — so this is silence, not a delivery fault,
    // and the two must not be conflated in the reports.
    quietSinceDays: 5,
    medications: [
      { name: "كونكور ٥ مجم", dose: "قرص واحد", times: ["08:00"], startedDaysAgo: 75 },
    ],
  },
  {
    fullName: "ليلى عبد العزيز",
    // The SAME number as نادية. Shared family handsets are common in Egypt,
    // which is why `Patient` carries a non-unique index on (pharmacyId,
    // phoneE164) rather than a unique constraint — a unique constraint would
    // silently block this entirely real enrollment.
    phone: "+201556789012",
    profile: { taken: 0.88, late: 0.06, missed: 0.03, noResponse: 0.03 },
    medications: [
      { name: "فيتامين د ٥٠٠٠٠ وحدة", dose: "كبسولة", times: ["10:00"], startedDaysAgo: 40 },
    ],
  },
];

type Outcome = {
  responseState: DoseAnswer;
  deliveryState: "READ" | "DELIVERED" | "SENT";
};

/**
 * The delivery state implied by a known answer.
 *
 * Every answer except silence arrives as a button tap, and a patient can only
 * tap a message they have read. Recording a reported miss as merely DELIVERED
 * would understate engagement in exactly the reports meant to measure it.
 */
function deliveryFor(responseState: DoseAnswer): Outcome["deliveryState"] {
  // Silence: the message arrived, and we know nothing beyond that.
  return responseState === "NONE" ? "DELIVERED" : "READ";
}

function pickOutcome(profile: Outcomes): Outcome {
  const r = rand();
  const { taken, late, missed } = profile;

  if (r < taken) return { responseState: "TAKEN", deliveryState: "READ" };
  if (r < taken + late) return { responseState: "TAKEN_LATE", deliveryState: "READ" };
  if (r < taken + late + missed) return { responseState: "MISSED", deliveryState: "READ" };

  // Silence. The message itself was fine — that distinction is the whole point
  // of keeping delivery and response state in separate fields.
  return { responseState: "NONE", deliveryState: rand() < 0.6 ? "DELIVERED" : "SENT" };
}

function behaviourAt(persona: Persona, daysBack: number): Outcomes {
  if (persona.shift && daysBack <= persona.shift.lastDays) {
    return { ...persona.profile, ...persona.shift.profile };
  }
  return persona.profile;
}

/**
 * Empty the audit log.
 *
 * `AuditEvent` is append-only, enforced by a trigger in the hard-constraints
 * migration that raises on any UPDATE or DELETE. That is a production guarantee
 * and the seed must not weaken it — so rather than dropping the trigger, this
 * disables it for the duration of one statement and re-enables it in a
 * `finally`.
 *
 * The `finally` is the load-bearing part. If the delete threw while the trigger
 * was disabled, the database would silently keep running without its
 * append-only guarantee and nothing would ever report it — a much worse outcome
 * than a failed seed.
 *
 * `ALTER TABLE ... DISABLE TRIGGER` rather than `SET session_replication_role`:
 * the latter is session-scoped, and Prisma may run the `deleteMany` on a
 * different pooled connection than the one that set it.
 *
 * A fresh pharmacy row gets a new cuid on every run, so leaving old audit rows
 * behind would litter the log with entries pointing at a pharmacy that no longer
 * exists.
 */
async function wipeAuditLog(): Promise<void> {
  const TRIGGER = "audit_event_no_update_delete";

  await systemPrisma.$executeRawUnsafe(
    `ALTER TABLE "AuditEvent" DISABLE TRIGGER "${TRIGGER}"`,
  );

  try {
    const { count } = await systemPrisma.auditEvent.deleteMany();
    if (count > 0) console.log(`  (cleared ${count} audit event(s))`);
  } finally {
    await systemPrisma.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" ENABLE TRIGGER "${TRIGGER}"`,
    );
  }
}

async function main() {
  console.log("Seeding synthetic data…\n");

  await wipeAuditLog();

  // ── wipe the rest, in dependency order ──
  //
  // A seed that can only run once is a seed nobody runs. Deleting in FK order is
  // what makes `npm run db:seed` usable repeatedly during development.
  await systemPrisma.$transaction([
    systemPrisma.patientResponse.deleteMany(),
    systemPrisma.reminderDispatch.deleteMany(),
    systemPrisma.reminderEvent.deleteMany(),
    systemPrisma.inboundMessage.deleteMany(),
    systemPrisma.patientMessage.deleteMany(),
    systemPrisma.alertEvent.deleteMany(),
    systemPrisma.alert.deleteMany(),
    systemPrisma.pharmacistIntervention.deleteMany(),
    systemPrisma.followUpCase.deleteMany(),
    systemPrisma.medicationScheduleRevision.deleteMany(),
    systemPrisma.medicationSchedule.deleteMany(),
    systemPrisma.refillRecord.deleteMany(),
    systemPrisma.medicationRecord.deleteMany(),
    systemPrisma.consentRecord.deleteMany(),
    systemPrisma.patient.deleteMany(),
    systemPrisma.session.deleteMany(),
    systemPrisma.pharmacyMembership.deleteMany(),
    systemPrisma.messagingChannel.deleteMany(),
    systemPrisma.whatsAppTemplate.deleteMany(),
    systemPrisma.ruleDefinition.deleteMany(),
    systemPrisma.sweepHeartbeat.deleteMany(),
    systemPrisma.outboxEvent.deleteMany(),
    systemPrisma.user.deleteMany(),
    systemPrisma.pharmacy.deleteMany(),
  ]);

  // ── pharmacy ──
  const pharmacy = await systemPrisma.pharmacy.create({
    data: {
      name: "صيدلية النور",
      timeZone: TZ,
      defaultLocale: "AR_EG",
      quietHoursStart: "21:30",
      quietHoursEnd: "07:00",
    },
  });

  // ── users ──
  //
  // These passwords are documented in the README rather than kept secret: this
  // is a local demo dataset with no real patient data behind it.
  const owner = await systemPrisma.user.create({
    data: {
      email: "pharmacist@wasal.demo",
      fullName: "د. هالة منصور",
      passwordHash: await hashPassword("WasalDemo!2026"),
      locale: "AR_EG",
      phoneE164: "+201000000001",
    },
  });

  const staff = await systemPrisma.user.create({
    data: {
      email: "assistant@wasal.demo",
      fullName: "م. يوسف رمضان",
      passwordHash: await hashPassword("WasalStaff!2026"),
      locale: "AR_EG",
    },
  });

  await systemPrisma.pharmacyMembership.createMany({
    data: [
      { pharmacyId: pharmacy.id, userId: owner.id, role: "PHARMACY_ADMIN", active: true },
      { pharmacyId: pharmacy.id, userId: staff.id, role: "ASSISTANT", active: true },
    ],
  });

  // ── messaging channel ──
  //
  // `provider: "mock"` matches MESSAGING_PROVIDER in .env, so the dev inbox
  // receives everything this seed schedules.
  await systemPrisma.messagingChannel.create({
    data: {
      pharmacyId: pharmacy.id,
      provider: "mock",
      providerPhoneNumberId: "mock-phone-number-id-001",
      displayPhoneE164: "+201000000099",
    },
  });

  // ── the reminder template ──
  //
  // Recorded with its category because the single biggest commercial risk in
  // this project is Meta reclassifying it as MARKETING, which would multiply the
  // per-patient cost roughly eighteen-fold. Having the category in the database
  // makes that change visible when it happens.
  await systemPrisma.whatsAppTemplate.create({
    data: {
      pharmacyId: pharmacy.id,
      providerName: "wasal_dose_reminder_v1",
      languageCode: "ar",
      category: "UTILITY",
      status: "APPROVED",
      lastSyncedAtUtc: new Date(),
      components: [
        {
          // The body is deliberately wordier than the message needs to be.
          // Meta rejects a template whose variables are too dense for its
          // length ("this template has too many variables for its length"),
          // and the three variables here are all load-bearing — the patient's
          // name because shared family handsets are common, see
          // `sendReminder`. The only remaining lever is static text, so the
          // sentence after the times exists to satisfy that ratio. Do not
          // tighten this wording without re-submitting to Meta. Keep it
          // purely transactional: promotional filler is what gets a reminder
          // reclassified as MARKETING, at roughly 18x the per-patient cost.
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

  console.log("✓ pharmacy, 2 users, channel, reminder template");

  // ── patients, medications, schedules, history ──
  const now = new Date();
  const nowUtc = DateTime.fromJSDate(now, { zone: "utc" });

  let events = 0;
  let responses = 0;

  for (const persona of PERSONAS) {
    const patient = await systemPrisma.patient.create({
      data: {
        pharmacyId: pharmacy.id,
        fullName: persona.fullName,
        phoneE164: persona.phone,
        preferredLocale: "AR_EG",
        timeZone: TZ,
        status: "ACTIVE",
        createdByUserId: owner.id,
        createdAt: nowUtc.minus({ days: HISTORY_DAYS }).toJSDate(),
      },
    });

    const enrolledAt = patient.createdAt;

    for (const consentType of ["WHATSAPP_MESSAGING", "DATA_PROCESSING"] as const) {
      await systemPrisma.consentRecord.create({
        data: {
          pharmacyId: pharmacy.id,
          patientId: patient.id,
          consentType,
          granted: true,
          grantedAt: enrolledAt,
          grantedByUserId: owner.id,
          // Attested verbal capture. Whether the pilot needs a scanned paper
          // form instead is an open question for the client — it is recorded
          // here rather than assumed so the answer changes one field.
          captureMethod: "VERBAL_ATTESTED",
          notes: "موافقة شفهية موثقة أثناء التسجيل في الصيدلية (بيانات تجريبية)",
        },
      });
    }

    for (const med of persona.medications) {
      const medication = await systemPrisma.medicationRecord.create({
        data: {
          pharmacyId: pharmacy.id,
          patientId: patient.id,
          medicationNameText: med.name,
          doseAmountText: med.dose,
          status: "ACTIVE",
          isChronic: true,
          startedOn: nowUtc.minus({ days: med.startedDaysAgo }).toJSDate(),
          createdByUserId: owner.id,
        },
      });

      const schedule = await systemPrisma.medicationSchedule.create({
        data: {
          pharmacyId: pharmacy.id,
          patientId: patient.id,
          medicationId: medication.id,
          status: "ACTIVE",
          mode: "FIXED_TIMES_OF_DAY",
          timesOfDay: med.times,
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          timeZone: TZ,
          startDate: nowUtc.minus({ days: med.startedDaysAgo }).toJSDate(),
          createdByUserId: owner.id,
        },
      });

      // ── history, including today's doses that have already passed ──
      for (let daysBack = HISTORY_DAYS; daysBack >= 0; daysBack -= 1) {
        const day = DateTime.fromJSDate(now, { zone: TZ }).minus({ days: daysBack });
        const localDate = day.toFormat("yyyy-MM-dd");

        if (day < DateTime.fromJSDate(schedule.startDate, { zone: TZ })) continue;

        const profile = behaviourAt(persona, daysBack);

        const silent =
          persona.neverResponds === true ||
          (persona.quietSinceDays !== undefined && daysBack <= persona.quietSinceDays);

        for (const time of med.times) {
          // Throws on malformed "HH:mm"; the values above are literals, so a
          // throw here is a bug in this file and should be loud.
          const resolved = resolveDoseInstant(localDate, time, TZ);

          if (resolved.atUtc >= now) continue;

          // Precedence: a scripted day beats the random profile, and silence
          // beats both — a persona who never answers cannot be scripted into
          // answering, or the two would contradict each other.
          const scripted = persona.script?.find((s) => s.daysAgo === daysBack);

          const outcome: Outcome = silent
            ? { responseState: "NONE", deliveryState: "DELIVERED" }
            : scripted
              ? {
                  responseState: scripted.responseState,
                  deliveryState: deliveryFor(scripted.responseState),
                }
              : pickOutcome(profile);

          // The real window is derived from the gap to the next dose at
          // materialization time. A fixed approximation is fine for history,
          // because every FUTURE dose gets the real computation.
          const gapMinutes = med.times.length > 1 ? 720 : 1440;
          const windowMinutes = Math.max(120, Math.min(1440, Math.floor(gapMinutes * 0.75)));
          const windowEnds = new Date(resolved.atUtc.getTime() + windowMinutes * 60_000);

          const event = await systemPrisma.reminderEvent.create({
            data: {
              pharmacyId: pharmacy.id,
              patientId: patient.id,
              medicationId: medication.id,
              scheduleId: schedule.id,
              scheduleRevisionSnapshot: schedule.revision,
              kind: "SCHEDULED_DOSE",
              doseAtUtc: resolved.atUtc,
              doseLocalDate: new Date(`${resolved.localDate}T00:00:00.000Z`),
              doseLocalTime: resolved.localTime,
              dstAdjusted: resolved.adjusted,
              responseWindowEndsAtUtc: windowEnds,
              deliveryState: outcome.deliveryState,
              responseState: outcome.responseState,
              attemptCount: 1,
              lastAttemptAtUtc: resolved.atUtc,
              firstSentAtUtc: resolved.atUtc,
              countedForAdherence: true,
              ruleEligible: true,
              // An unanswered dose past its window is settled. `responseState`
              // stays NONE and the settlement lands in its own column, so a late
              // reply coexists with it instead of erasing the record.
              settledAtUtc: outcome.responseState === "NONE" ? windowEnds : null,
            },
            select: { id: true },
          });

          events += 1;

          if (outcome.responseState !== "NONE") {
            await systemPrisma.patientResponse.create({
              data: {
                pharmacyId: pharmacy.id,
                patientId: patient.id,
                reminderEventId: event.id,
                channel: "WHATSAPP_BUTTON",
                answer: outcome.responseState,
                // Patient-reported, never verified. No inbound path may set
                // isVerified — a pharmacist correction is a separate row.
                source: "PATIENT_REPORTED",
                isVerified: false,
                verificationState: "UNVERIFIED",
                applied: true,
                appliedToAdherence: true,
                ruleEligible: true,
                receivedAtUtc: new Date(resolved.atUtc.getTime() + 4 * 60_000),
              },
            });
            responses += 1;
          }
        }
      }
    }
  }

  console.log(
    `✓ ${PERSONAS.length} patients · ${events} historical doses · ${responses} responses`,
  );

  // ── the reported side effect ──
  //
  // أحمد reports a problem two days ago. This goes through the REAL
  // `applyResponse`, not a hand-written row: opening the case and raising the
  // URGENT alert is behaviour `applyResponse` owns, and the rule catalog
  // deliberately has no PROBLEM_REPORTED rule to duplicate it. Writing the row
  // directly would produce a seed that looks like it demonstrates the problem
  // path while nothing at all reaches the pharmacist's queue.
  const ahmed = await systemPrisma.patient.findFirst({
    where: { pharmacyId: pharmacy.id, fullName: "أحمد فؤاد سالم" },
    select: { id: true },
  });

  if (ahmed) {
    const reportedAtUtc = new Date(now.getTime() - 2 * 86_400_000 + 3600_000);

    const event = await systemPrisma.reminderEvent.findFirst({
      where: { patientId: ahmed.id, doseAtUtc: { lt: reportedAtUtc } },
      orderBy: { doseAtUtc: "desc" },
      select: { id: true },
    });

    const result = await applyResponse({
      pharmacyId: pharmacy.id,
      patientId: ahmed.id,
      reminderEventId: event?.id ?? null,
      channel: "WHATSAPP_BUTTON",
      answer: "PROBLEM",
      freeText: "عرض جانبي",
      rawMessageId: "wamid.seed.ahmed.problem",
      receivedAtUtc: reportedAtUtc,
    });

    console.log(
      `✓ أحمد reported a side effect → case ${
        result.caseId ? "opened" : "NOT opened"
      }, alert ${result.alertId ? "raised" : "NOT raised"}`,
    );
  }

  // ── rule definitions ──
  const ruleCount = await ensureSystemRules();
  console.log(`✓ ${ruleCount} system rule definition(s) created`);

  // ── materialize the future ──
  //
  // The only part of the reminder set produced by production code rather than
  // fabricated, and the reason `db:seed` alone leaves a demo that can actually
  // be driven: there are real due-soon reminders for the dispatch sweep to find.
  const materialized = await materializeDueSchedules(now);
  console.log(
    `✓ materialized ${materialized.created} upcoming reminder(s) ` +
      `across ${materialized.schedules} schedule(s) over the 72h horizon`,
  );

  // ── evaluate the rules ──
  console.log("\nRunning the rules sweep over the seeded history…");
  const summary = await evaluateRulesSweep(now);
  console.log(
    `  ${summary.patientsEvaluated} patients · ${summary.alertsOpened} alerts opened · ` +
      `${summary.casesOpened} cases · ${summary.errors} errors`,
  );

  const alerts = await systemPrisma.alert.findMany({
    where: { pharmacyId: pharmacy.id },
    select: { ruleKey: true, severity: true, status: true, titleAr: true },
    orderBy: { severity: "desc" },
  });

  if (alerts.length === 0) {
    console.log("\nNo alerts raised — the rules found nothing to act on.");
  } else {
    console.log("\nAlerts raised:");
    for (const alert of alerts) {
      console.log(
        `  [${alert.severity.padEnd(6)}] ${alert.ruleKey.padEnd(24)} ${alert.titleAr}`,
      );
    }
  }

  console.log(`
────────────────────────────────────────────────────────────
  Sign in at http://localhost:3000/ar/login

    د. هالة منصور (admin)    pharmacist@wasal.demo  / WasalDemo!2026
    م. يوسف رمضان (staff)    assistant@wasal.demo   / WasalStaff!2026

  All data here is synthetic. See PRD §12.
────────────────────────────────────────────────────────────
`);

  await systemPrisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await systemPrisma.$disconnect();
  process.exit(1);
});
