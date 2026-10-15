import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The session cookie, held where the mocked `next/headers` can read it.
 *
 * `vi.hoisted` rather than a plain `let`: the factory below is hoisted above
 * every import in this file, so a variable declared normally would still be in
 * its temporal dead zone when the mock registers.
 */
const session = vi.hoisted(() => ({ token: null as string | null }));

/**
 * Where a redirect was sent, captured rather than thrown past the test.
 *
 * A successful save ends in `redirect(...)`, and Next signals that by throwing.
 * Left uncaught it would abort the test with an unrelated error and hide the
 * database assertions underneath — which are the ones that matter.
 */
const nav = vi.hoisted(() => ({ redirects: [] as string[] }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "wasal_session" && session.token ? { name, value: session.token } : undefined,
  }),
}));

/*
 * Mock `@/i18n/navigation`, not `next/navigation`, for the redirect the action
 * actually performs.
 *
 * `@/i18n/navigation` is a thin wrapper over `next-intl/navigation`, and
 * next-intl's ESM development build imports the bare specifier `next/navigation`
 * from inside `node_modules`. Next 16's exports map has no `./navigation` entry,
 * so that import only resolves for files Vite transforms — from an externalized
 * dependency it fails at load, taking the whole suite with it (0 tests
 * collected). Mocking our own wrapper never loads next-intl's navigation at all.
 *
 * It is also the boundary this code owns, so the mock cannot silently drift from
 * what the action calls. `Link` and the router hooks are stubbed because a
 * server action does not use them, and a test that starts to should say so
 * loudly rather than get `undefined`.
 */
vi.mock("@/i18n/navigation", () => ({
  redirect: (target: { href: string; locale?: string }) => {
    const url = typeof target === "string" ? target : target.href;
    nav.redirects.push(url);
    throw new Error(`WASAL_REDIRECT:${url}`);
  },
  Link: () => {
    throw new Error("WASAL_UNEXPECTED_LINK");
  },
  usePathname: () => {
    throw new Error("WASAL_UNEXPECTED_USE_PATHNAME");
  },
  useRouter: () => {
    throw new Error("WASAL_UNEXPECTED_USE_ROUTER");
  },
  getPathname: () => {
    throw new Error("WASAL_UNEXPECTED_GET_PATHNAME");
  },
}));

// `requireSessionUser` redirects to the login page through `next/navigation`
// when the cookie is missing or dead. Nothing here exercises that path, so if it
// ever fires it means the session setup broke — and this error says so, instead
// of being mistaken for the success redirect above.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`WASAL_UNEXPECTED_LOGIN_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("WASAL_UNEXPECTED_NOT_FOUND");
  },
}));

import { AUDIT_ACTION } from "@/server/audit";
import { createSession } from "@/server/auth/session";
import { systemPrisma } from "@/server/db";
import {
  createMedicationWithSchedule,
  updateMedicationWithSchedule,
  type MedicationFormState,
} from "@/server/medications/actions";

/**
 * Recording a medication — the write the whole product stands on.
 *
 * Nothing else in this system does anything until a medication and its schedule
 * exist: no schedule means no `ReminderEvent` rows, no reminders, no replies, no
 * adherence, and a dashboard that is permanently and silently empty. Every test
 * here is about that chain either completing or not starting at all.
 *
 *   1. A SAVED MEDICATION MUST PRODUCE REMINDERS. The form's success and the
 *      patient's first reminder are two different things, and the failure —
 *      saving cleanly and materializing nothing — is invisible from the screen
 *      the pharmacist just left. They would find out days later, from a patient
 *      who never heard from them.
 *   2. The medication, its schedule, revision 1, the audit row and the horizon
 *      are ONE transaction. A half-written regimen is worse than none: a
 *      medication with no schedule looks recorded and does nothing.
 *   3. A patient in another pharmacy is indistinguishable from one that does not
 *      exist. The form is a courtesy; `patientId` is attacker-controlled and
 *      `pharmacyId` on the session is the only thing standing between tenants.
 *
 * Requires a migrated database (`npm run db:migrate`), like the other tests that
 * talk to Postgres.
 */

const RUN = randomUUID().slice(0, 8);

const IDLE: MedicationFormState = {
  formError: null,
  fieldErrors: {},
  values: {},
  times: [],
  days: [],
};

let pharmacyId: string;
let otherPharmacyId: string;
let patientId: string;
let foreignPatientId: string;
let pharmacistUserId: string;
let assistantUserId: string;
let pharmacistEmail: string;
let assistantEmail: string;

beforeAll(async () => {
  const [pharmacy, otherPharmacy] = await Promise.all([
    systemPrisma.pharmacy.create({
      data: { name: `Medication actions A (${RUN})`, timeZone: "Africa/Cairo" },
    }),
    systemPrisma.pharmacy.create({ data: { name: `Medication actions B (${RUN})` } }),
  ]);
  pharmacyId = pharmacy.id;
  otherPharmacyId = otherPharmacy.id;

  pharmacistEmail = `medication-pharmacist-${RUN}@test.local`;
  assistantEmail = `medication-assistant-${RUN}@test.local`;

  const [pharmacist, assistant] = await Promise.all([
    systemPrisma.user.create({
      data: { email: pharmacistEmail, fullName: `Pharmacist ${RUN}`, locale: "AR_EG" },
    }),
    systemPrisma.user.create({
      data: { email: assistantEmail, fullName: `Assistant ${RUN}`, locale: "AR_EG" },
    }),
  ]);
  pharmacistUserId = pharmacist.id;
  assistantUserId = assistant.id;

  await Promise.all([
    systemPrisma.pharmacyMembership.create({
      data: { userId: pharmacistUserId, pharmacyId, role: "PHARMACIST", active: true },
    }),
    // ASSISTANT holds `patient:write` but neither `medication:write` nor
    // `schedule:write` — the role this action must refuse.
    systemPrisma.pharmacyMembership.create({
      data: { userId: assistantUserId, pharmacyId, role: "ASSISTANT", active: true },
    }),
  ]);

  const [patient, foreignPatient] = await Promise.all([
    systemPrisma.patient.create({
      data: {
        pharmacyId,
        fullName: `Medication Patient ${RUN}`,
        phoneE164: "+201088810001",
        timeZone: "Africa/Cairo",
      },
    }),
    systemPrisma.patient.create({
      data: {
        pharmacyId: otherPharmacyId,
        fullName: `Foreign Medication Patient ${RUN}`,
        phoneE164: "+201088810002",
        timeZone: "Africa/Cairo",
      },
    }),
  ]);
  patientId = patient.id;
  foreignPatientId = foreignPatient.id;

  session.token = (
    await createSession({ userId: pharmacistUserId, activePharmacyId: pharmacyId })
  ).token;
});

afterAll(async () => {
  // AuditEvent has no foreign key, so nothing cascades it away.
  await systemPrisma.pharmacy
    .deleteMany({ where: { id: { in: [pharmacyId, otherPharmacyId] } } })
    .catch(() => {});

  if (pharmacyId && otherPharmacyId) {
    await withAuditTriggerDisabled(() =>
      systemPrisma.auditEvent.deleteMany({
        where: { pharmacyId: { in: [pharmacyId, otherPharmacyId] } },
      }),
    ).catch(() => {});
  }

  await systemPrisma.user
    .deleteMany({ where: { email: { in: [pharmacistEmail, assistantEmail] } } })
    .catch(() => {});
  await systemPrisma.$disconnect();
});

/** A form submission, as the browser would build it. Repeated keys are appends. */
function fd(
  fields: Record<string, string>,
  times: string[] = [],
  days: number[] = EVERY_DAY,
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  for (const time of times) form.append("timesOfDay", time);
  for (const day of days) form.append("daysOfWeek", String(day));
  return form;
}

/** 0 = Sunday. Every day is what a daily medication means. */
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/** A complete, valid submission. Overrides let a test break exactly one thing. */
function validForm(
  overrides: Record<string, string> = {},
  times = ["08:00"],
  days: number[] = EVERY_DAY,
) {
  return fd(
    {
      locale: "ar",
      patientId,
      name: `ميتفورمين ${RUN}`,
      strength: "500mg",
      doseAmount: "قرص واحد",
      indication: "سكري نوع 2",
      prescriber: "د. أحمد",
      instructions: "بعد الأكل",
      startedOn: "2026-01-01",
      mode: "FIXED_TIMES_OF_DAY",
      status: "ACTIVE",
      startDate: "2026-01-01",
      timeZone: "Africa/Cairo",
      ...overrides,
    },
    times,
    days,
  );
}

/**
 * Run an action, treating Next's redirect-throw as the success signal it is
 * rather than letting it abort the test.
 */
async function run(
  action: (prev: MedicationFormState, formData: FormData) => Promise<MedicationFormState>,
  form: FormData,
): Promise<MedicationFormState | "redirected"> {
  nav.redirects.length = 0;
  try {
    return await action(IDLE, form);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("WASAL_REDIRECT")) {
      return "redirected";
    }
    throw error;
  }
}

function save(form: FormData) {
  return run(createMedicationWithSchedule, form);
}

function update(form: FormData) {
  return run(updateMedicationWithSchedule, form);
}

function medicationsFor(patient: string) {
  return systemPrisma.medicationRecord.findMany({
    where: { patientId: patient },
    select: { id: true, medicationNameText: true, instructionsTextAr: true, instructionsTextEn: true },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("a saved medication produces reminders", () => {
  it("materializes the horizon, so the patient's first reminder exists immediately", async () => {
    const before = await systemPrisma.reminderEvent.count({ where: { pharmacyId } });

    const outcome = await save(validForm());
    expect(outcome).toBe("redirected");
    // Back to the patient the medication was recorded against. A redirect
    // anywhere else would drop the pharmacist somewhere the new regimen is not.
    expect(nav.redirects).toEqual([`/patients/${patientId}`]);

    const created = await systemPrisma.medicationRecord.findFirstOrThrow({
      where: { patientId, pharmacyId },
      select: { id: true },
    });

    const schedule = await systemPrisma.medicationSchedule.findFirstOrThrow({
      where: { medicationId: created.id },
      select: { id: true, revision: true, status: true, timesOfDay: true, timeZone: true },
    });

    /*
     * THE ASSERTION THIS FILE EXISTS FOR. A medication row with no
     * `ReminderEvent` rows behind it is a regimen the pharmacist believes is
     * running and which will never send anything. Nothing on the screen after
     * the redirect distinguishes the two.
     */
    const reminders = await systemPrisma.reminderEvent.count({
      where: { scheduleId: schedule.id },
    });
    expect(reminders).toBeGreaterThan(0);

    const after = await systemPrisma.reminderEvent.count({ where: { pharmacyId } });
    expect(after).toBe(before + reminders);

    // A new medication is active whatever the form posted, so its schedule is
    // active and the projection starts now rather than waiting for an edit.
    expect(schedule.status).toBe("ACTIVE");
    expect(schedule.revision).toBe(1);
    expect(schedule.timesOfDay).toEqual(["08:00"]);
    expect(schedule.timeZone).toBe("Africa/Cairo");

    // Every materialized dose carries the schedule's own time zone decision, and
    // the wall clock the pharmacist typed — not the instant it resolves to.
    const first = await systemPrisma.reminderEvent.findFirstOrThrow({
      where: { scheduleId: schedule.id },
      orderBy: { doseAtUtc: "asc" },
      select: { doseLocalTime: true, doseLocalDate: true, deliveryState: true },
    });
    expect(first.doseLocalTime).toBe("08:00");
    expect(first.deliveryState).toBe("SCHEDULED");
  });

  it("writes the medication, its schedule, revision 1 and one audit row together", async () => {
    const times = ["09:15", "21:15"];
    expect(await save(validForm({ name: `أموكسيسيلين ${RUN}` }, times))).toBe("redirected");

    const medication = await systemPrisma.medicationRecord.findFirstOrThrow({
      where: { patientId, medicationNameText: `أموكسيسيلين ${RUN}` },
      select: { id: true, strengthText: true, doseAmountText: true, startedOn: true },
    });

    expect(medication.strengthText).toBe("500mg");
    expect(medication.doseAmountText).toBe("قرص واحد");

    const schedule = await systemPrisma.medicationSchedule.findFirstOrThrow({
      where: { medicationId: medication.id },
      select: { id: true, revision: true, timesOfDay: true, daysOfWeek: true },
    });
    expect(schedule.timesOfDay).toEqual(times);
    expect(schedule.daysOfWeek).toEqual(EVERY_DAY);

    /*
     * Revision 1 is written explicitly rather than treated as implicit. The
     * revision table is what a pharmacist reads to see how a regimen evolved, and
     * a history that begins at "revision 2" is one they cannot read from the
     * start.
     */
    const revisions = await systemPrisma.medicationScheduleRevision.findMany({
      where: { scheduleId: schedule.id },
      select: { revision: true },
    });
    expect(revisions.map((r) => r.revision)).toEqual([1]);

    const audits = await systemPrisma.auditEvent.findMany({
      where: { pharmacyId, entityId: medication.id },
      select: { action: true, actorUserId: true, entityType: true },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe(AUDIT_ACTION.MEDICATION_CREATED);
    expect(audits[0].actorUserId).toBe(pharmacistUserId);
    expect(audits[0].entityType).toBe("MedicationRecord");
  });

  it("writes instructions into the column for the language that was typed", async () => {
    // The form has one instructions box. It is filled in the language the
    // pharmacist is reading, so only that column is written — inventing a
    // translation nobody wrote would put Arabic prose in the English screen.
    expect(
      await save(validForm({ name: `باراسيتامول ${RUN}`, locale: "ar" })),
    ).toBe("redirected");

    const arabic = await systemPrisma.medicationRecord.findFirstOrThrow({
      where: { patientId, medicationNameText: `باراسيتامول ${RUN}` },
      select: { instructionsTextAr: true, instructionsTextEn: true },
    });
    expect(arabic.instructionsTextAr).toBe("بعد الأكل");
    expect(arabic.instructionsTextEn).toBeNull();

    expect(
      await save(
        validForm({
          name: `Paracetamol ${RUN}`,
          locale: "en",
          instructions: "After food",
        }),
      ),
    ).toBe("redirected");

    const english = await systemPrisma.medicationRecord.findFirstOrThrow({
      where: { patientId, medicationNameText: `Paracetamol ${RUN}` },
      select: { instructionsTextAr: true, instructionsTextEn: true },
    });
    expect(english.instructionsTextEn).toBe("After food");
    expect(english.instructionsTextAr).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("nothing is written unless everything can be", () => {
  it("refuses a medication with no name and writes no rows", async () => {
    const before = await medicationsFor(patientId);

    const state = await save(validForm({ name: "" }));

    expect(state).not.toBe("redirected");
    if (state === "redirected") throw new Error("unreachable");
    expect(state.fieldErrors.name).toBe("REQUIRED");

    // A rejected save must leave the database exactly as it was. The schedule is
    // created by a second statement inside the transaction, so a validation
    // failure that returns early from the wrong place can leave an orphan.
    expect(await medicationsFor(patientId)).toHaveLength(before.length);
  });

  it("refuses a schedule with no dose times", async () => {
    const before = await medicationsFor(patientId);

    const state = await save(validForm({ name: `بلا مواعيد ${RUN}` }, []));

    expect(state).not.toBe("redirected");
    if (state === "redirected") throw new Error("unreachable");
    expect(state.fieldErrors.timesOfDay).toBe("TIMES_REQUIRED");

    expect(await medicationsFor(patientId)).toHaveLength(before.length);
  });

  it("refuses a schedule with no days ticked, rather than sending seven days a week", async () => {
    /*
     * The schema reads an empty `daysOfWeek` as "every day", which is a fine
     * storage convention and a trap in a form: a pharmacist who unticks every
     * box to mean "no days" would get reminders every day of the week and the
     * form would have told them nothing. The action has to refuse it here,
     * because the database will happily store it.
     */
    const state = await save(validForm({ name: `بلا أيام ${RUN}` }, ["08:00"], []));

    expect(state).not.toBe("redirected");
    if (state === "redirected") throw new Error("unreachable");
    expect(state.fieldErrors.daysOfWeek).toBe("DAYS_REQUIRED");
  });

  it("refuses an end date before the start date", async () => {
    const state = await save(
      validForm({ name: `تواريخ مقلوبة ${RUN}`, endDate: "2025-01-01" }),
    );

    expect(state).not.toBe("redirected");
    if (state === "redirected") throw new Error("unreachable");
    expect(state.fieldErrors.endDate).toBe("END_BEFORE_START");
  });

  it("refuses an unknown IANA time zone", async () => {
    const state = await save(
      validForm({ name: `منطقة غلط ${RUN}`, timeZone: "Africa/Cairoo" }),
    );

    expect(state).not.toBe("redirected");
    if (state === "redirected") throw new Error("unreachable");
    expect(state.fieldErrors.timeZone).toBe("INVALID_TIMEZONE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the RxCUI the drug-name picker resolved", () => {
  /*
   * `medicationCode` is optional metadata: nothing reads it yet and no save
   * depends on it, so a bug here costs nothing today and everything the day
   * something does read it. Two things are worth pinning down — that a real
   * RxCUI is stored, and that nothing else can be. The column is a free-text
   * `String?` with no database check, and the hidden input that fills it is
   * postable by hand.
   */

  it("stores the code alongside the name that was picked", async () => {
    const name = `ميتفورمين كود ${RUN}`;
    expect(await save(validForm({ name, medicationCode: "860975" }))).toBe("redirected");

    const stored = await systemPrisma.medicationRecord.findFirstOrThrow({
      where: { patientId, medicationNameText: name },
      select: { medicationCode: true },
    });
    expect(stored.medicationCode).toBe("860975");
  });

  it("saves without a code when the picker found none", async () => {
    // The ordinary path for a name typed by hand — an Egyptian brand DailyMed
    // has never heard of, or Arabic. An empty hidden field is not an error.
    const name = `كونكور ${RUN}`;
    expect(await save(validForm({ name, medicationCode: "" }))).toBe("redirected");

    const stored = await systemPrisma.medicationRecord.findFirstOrThrow({
      where: { patientId, medicationNameText: name },
      select: { medicationCode: true },
    });
    expect(stored.medicationCode).toBeNull();
  });

  it("drops a code that is not a well-formed RxCUI, and still saves the medication", async () => {
    /*
     * Dropped SILENTLY, and that is the decision rather than an oversight: the
     * input is hidden, so a `fieldErrors` entry could not be rendered beside
     * anything, and no malformed metadata is worth costing the pharmacist the
     * medication they just recorded. The invariant being defended is "only a
     * well-formed RxCUI is ever persisted", not "the sender is told".
     */
    const rejected = ["not-a-code", "860975; DROP TABLE", "1".repeat(9), "-1", "860975.0", " "];

    for (const [index, code] of rejected.entries()) {
      const name = `كود مرفوض ${index} ${RUN}`;
      expect(await save(validForm({ name, medicationCode: code }))).toBe("redirected");

      const stored = await systemPrisma.medicationRecord.findFirstOrThrow({
        where: { patientId, medicationNameText: name },
        select: { medicationCode: true },
      });
      expect(stored.medicationCode).toBeNull();
    }
  });

  it("echoes the code back, so a rejected save does not lose the pick", async () => {
    // A suggestion is worth picking once. If the echo dropped the code, the
    // pharmacist would correct an unrelated field and silently lose it.
    const state = await save(
      validForm({ name: `كود مرفوض مع الاسم ${RUN}`, medicationCode: "860975" }, []),
    );

    expect(state).not.toBe("redirected");
    if (state === "redirected") throw new Error("unreachable");
    expect(state.fieldErrors.timesOfDay).toBe("TIMES_REQUIRED");
    expect(state.values.medicationCode).toBe("860975");
  });

  it("keeps the code through an edit that changes something else", async () => {
    /*
     * The trap this exists for. The update writes exactly what the form posts,
     * so a code the edit page forgets to render into its hidden input is nulled
     * by the first unrelated edit — a dose change, a pause, a corrected
     * prescriber. Nothing on screen would show it, and nothing reads the column
     * yet, so nothing would report it either.
     */
    const name = `كود محفوظ ${RUN}`;
    expect(await save(validForm({ name, medicationCode: "6809" }))).toBe("redirected");

    const medication = await systemPrisma.medicationRecord.findFirstOrThrow({
      where: { patientId, medicationNameText: name },
      select: { id: true, schedules: { select: { id: true } } },
    });

    expect(
      await update(
        validForm({
          medicationId: medication.id,
          scheduleId: medication.schedules[0].id,
          name,
          medicationCode: "6809",
          doseAmount: "قرصين",
        }),
      ),
    ).toBe("redirected");

    const after = await systemPrisma.medicationRecord.findUniqueOrThrow({
      where: { id: medication.id },
      select: { medicationCode: true, doseAmountText: true },
    });
    expect(after.doseAmountText).toBe("قرصين");
    expect(after.medicationCode).toBe("6809");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("who may record a medication", () => {
  it("refuses an ASSISTANT, and writes nothing at all", async () => {
    const assistantToken = session.token;
    session.token = (
      await createSession({ userId: assistantUserId, activePharmacyId: pharmacyId })
    ).token;

    const before = await medicationsFor(patientId);
    const beforeAudits = await systemPrisma.auditEvent.count({ where: { pharmacyId } });

    // An action is a public endpoint: the form hides the button from this role,
    // and that is the only thing stopping them. The check has to be here.
    await expect(save(validForm({ name: `مساعد ${RUN}` }))).rejects.toThrow(
      /not permitted/i,
    );

    expect(await medicationsFor(patientId)).toHaveLength(before.length);
    expect(await systemPrisma.auditEvent.count({ where: { pharmacyId } })).toBe(beforeAudits);

    session.token = assistantToken;
  });

  it("treats another pharmacy's patient exactly as it treats one that does not exist", async () => {
    const beforeForeign = await medicationsFor(foreignPatientId);
    const beforeForeignAudits = await systemPrisma.auditEvent.count({
      where: { pharmacyId: otherPharmacyId },
    });

    const foreign = await save(validForm({ patientId: foreignPatientId }));
    const missing = await save(
      validForm({ patientId: randomUUID(), name: `مش موجود ${RUN}` }),
    );

    /*
     * Byte-identical refusals. If a foreign id answered differently from a
     * nonexistent one, the difference itself tells an attacker that the patient
     * is real and belongs to someone else.
     *
     * `values` is excluded deliberately and is not part of the answer: it echoes
     * the submission back so the form can re-render what was typed, and the two
     * forms differ in the fields this test varies. Echoing back what the caller
     * already sent discloses nothing. `formError` and `fieldErrors` are what the
     * caller learns, and those must not differ.
     */
    expect(foreign).not.toBe("redirected");
    if (foreign === "redirected" || missing === "redirected") {
      throw new Error("unreachable");
    }
    expect(foreign.formError).toBe("NOT_FOUND");
    expect(foreign.formError).toBe(missing.formError);
    expect(foreign.fieldErrors).toEqual(missing.fieldErrors);

    expect(await medicationsFor(foreignPatientId)).toHaveLength(beforeForeign.length);
    expect(
      await systemPrisma.auditEvent.count({ where: { pharmacyId: otherPharmacyId } }),
    ).toBe(beforeForeignAudits);
    // Neither attempt may materialize a dose anywhere — a refusal that still
    // created reminders would be a cross-tenant write wearing an error message.
    expect(await systemPrisma.reminderEvent.count({ where: { pharmacyId: otherPharmacyId } })).toBe(
      0,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

async function withAuditTriggerDisabled<T>(fn: () => Promise<T>): Promise<T> {
  await systemPrisma.$executeRawUnsafe(
    `ALTER TABLE "AuditEvent" DISABLE TRIGGER "audit_event_no_update_delete"`,
  );
  try {
    return await fn();
  } finally {
    await systemPrisma.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" ENABLE TRIGGER "audit_event_no_update_delete"`,
    );
  }
}
