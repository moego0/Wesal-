import type { AlertStatus, Severity } from "@/generated/prisma/enums";
import { systemPrisma } from "@/server/db";
import { buildFactBook, type FactBook } from "./facts";
import {
  RULES,
  dedupeKeyFor,
  findRule,
  resolveParams,
  type RuleKey,
  type RuleMatch,
  type RuleParams,
  type RuleSpec,
} from "./catalog";

/**
 * Rule evaluation and alert lifecycle.
 *
 * Two properties this file is built around:
 *
 *   1. CONCURRENCY IS HANDLED BY THE DATABASE, NOT BY A READ-THEN-WRITE.
 *      The partial unique index on `Alert(dedupeKey) WHERE status IN
 *      ('OPEN','ACKNOWLEDGED')` is the only thing that actually guarantees one
 *      open alert per key. A `SELECT` followed by an `INSERT` races: two workers
 *      evaluating the same patient both see nothing, both insert, and the
 *      pharmacist gets two identical alerts. So we INSERT and treat a unique
 *      violation as "someone else got there first, bump theirs".
 *
 *   2. ALERTS RESOLVE THEMSELVES.
 *      An alert set that only grows is an alert set nobody reads. Every sweep
 *      re-evaluates and auto-resolves alerts for rules that have stopped
 *      matching. Only the rule's OWN key is resolved — a patient can have an
 *      open CONSECUTIVE_MISSES and an open NO_ENGAGEMENT at the same time, and
 *      closing one must not close the other.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

/**
 * The rule layer is deliberately free of Prisma types — the catalog must stay a
 * set of pure functions over plain data so it can be tested without a database.
 * `evidence` therefore arrives as `Record<string, unknown>`, which Prisma's
 * `InputJsonValue` correctly refuses (it cannot prove the values are
 * serialisable). Narrowed once here, at the database boundary, rather than
 * widening the rule types to match the ORM.
 */
const asJson = (value: unknown) => value as never;

/**
 * Which severities also open a `FollowUpCase`.
 *
 * A case is a work item with an owner and a due date; an alert is a signal. Not
 * every signal deserves a work item — auto-creating cases for LOW alerts is how
 * a follow-up list becomes a second inbox nobody opens. LOW and NORMAL surface
 * on the dashboard and the pharmacist promotes them if they agree.
 */
const CASE_OPENING_SEVERITIES: Severity[] = ["HIGH", "URGENT"];

export type EvaluationSummary = {
  patientsEvaluated: number;
  alertsOpened: number;
  alertsBumped: number;
  alertsAutoResolved: number;
  alertsSuppressed: number;
  casesOpened: number;
  errors: number;
};

/** A spec bound to the parameters this pharmacy actually uses. */
export type BoundRule = {
  spec: RuleSpec;
  params: RuleParams;
  cooldownHours: number;
  severity: Severity;
  ruleVersion: number;
};

/**
 * Load the effective rule set for a pharmacy.
 *
 * `RuleDefinition` rows with a null `pharmacyId` are system defaults. A
 * pharmacy's own row for the same key overrides it, which is what lets the
 * pharmacist tune a threshold without forking the catalog.
 */
export async function loadRulesFor(
  tx: Tx,
  pharmacyId: string,
): Promise<BoundRule[]> {
  const rows = await tx.ruleDefinition.findMany({
    where: {
      OR: [{ pharmacyId }, { pharmacyId: null }],
      enabled: true,
    },
  });

  const byKey = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = byKey.get(row.ruleKey);
    // A pharmacy-specific row wins over the system default; otherwise the
    // highest version wins.
    if (!existing) {
      byKey.set(row.ruleKey, row);
      continue;
    }
    const existingIsPharmacy = existing.pharmacyId === pharmacyId;
    const rowIsPharmacy = row.pharmacyId === pharmacyId;
    if (rowIsPharmacy && !existingIsPharmacy) byKey.set(row.ruleKey, row);
    else if (rowIsPharmacy === existingIsPharmacy && row.version > existing.version) {
      byKey.set(row.ruleKey, row);
    }
  }

  const bound: BoundRule[] = [];
  for (const row of byKey.values()) {
    const spec = findRule(row.ruleKey);
    // A rule row whose key is not in the catalog is left alone rather than
    // deleted — it may belong to a newer deployment than this one.
    if (!spec) continue;
    bound.push({
      spec,
      params: resolveParams(spec.key, row.params),
      cooldownHours: row.cooldownHours ?? spec.cooldownHours,
      severity: (row.severity as Severity) ?? spec.severity,
      ruleVersion: row.version ?? spec.version,
    });
  }

  return bound;
}

/**
 * Evaluate one patient against a rule set and apply the results.
 *
 * Exported so it can be called synchronously when a response arrives — a
 * pharmacist should not have to wait up to fifteen minutes for the sweep to
 * notice what the patient just told us.
 */
export async function evaluatePatient(
  pharmacyId: string,
  patientId: string,
  rules: BoundRule[],
  now = new Date(),
  book?: FactBook,
): Promise<EvaluationSummary> {
  const summary: EvaluationSummary = {
    patientsEvaluated: 1,
    alertsOpened: 0,
    alertsBumped: 0,
    alertsAutoResolved: 0,
    alertsSuppressed: 0,
    casesOpened: 0,
    errors: 0,
  };

  const facts = book ?? (await buildFactBook(patientId, now));

  // Everything each rule currently says about this patient.
  const firing = new Map<string, { rule: BoundRule; match: RuleMatch }>();

  for (const rule of rules) {
    let matches: RuleMatch[];
    try {
      matches = rule.spec.evaluate(facts, rule.params);
    } catch (err) {
      // One broken rule must not stop the other six from protecting patients.
      summary.errors += 1;
      console.error(`[rules] ${rule.spec.key} threw for patient ${patientId}`, err);
      continue;
    }

    for (const match of matches) {
      firing.set(dedupeKeyFor(rule.spec.key, patientId, match.medicationId), {
        rule,
        match,
      });
    }
  }

  // ── open or bump ──
  for (const [dedupeKey, { rule, match }] of firing) {
    const result = await upsertAlert(pharmacyId, patientId, dedupeKey, rule, match, now);
    if (result === "OPENED") summary.alertsOpened += 1;
    else if (result === "BUMPED") summary.alertsBumped += 1;
    else if (result === "SUPPRESSED") summary.alertsSuppressed += 1;
    else if (result === "CASE_OPENED") {
      summary.alertsOpened += 1;
      summary.casesOpened += 1;
    }
  }

  // ── auto-resolve what stopped firing ──
  //
  // Scoped to rule-catalog alerts only. A `PATIENT_REPORTED_PROBLEM` alert is
  // opened by the response path and must be closed by a human, never swept away
  // because a statistical rule happens not to match.
  const catalogKeys = new Set(RULES.map((r) => r.key as string));

  const openAlerts = await systemPrisma.alert.findMany({
    where: {
      patientId,
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
    },
    select: { id: true, dedupeKey: true, ruleKey: true },
  });

  const toResolve = openAlerts.filter((a) => {
    if (!catalogKeys.has(a.ruleKey)) return false;
    return !firing.has(a.dedupeKey);
  });

  if (toResolve.length > 0) {
    const resolved = await systemPrisma.alert.updateMany({
      where: { id: { in: toResolve.map((a) => a.id) } },
      data: {
        status: "RESOLVED_AUTO" as AlertStatus,
        resolvedAtUtc: now,
        resolutionNote: "Condition no longer met on re-evaluation",
      },
    });
    summary.alertsAutoResolved = resolved.count;
  }

  return summary;
}

type UpsertResult = "OPENED" | "BUMPED" | "SUPPRESSED" | "CASE_OPENED" | "COOLDOWN";

/**
 * Insert-or-bump, keyed on the partial unique index.
 *
 * The INSERT is attempted first and the unique violation is caught, rather than
 * checking for an existing row and then inserting. The check-then-insert version
 * is the bug this whole design exists to avoid: two concurrent evaluations both
 * find nothing and both insert.
 */
async function upsertAlert(
  pharmacyId: string,
  patientId: string,
  dedupeKey: string,
  rule: BoundRule,
  match: RuleMatch,
  now: Date,
): Promise<UpsertResult> {
  const open = await systemPrisma.alert.findFirst({
    where: { dedupeKey, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    select: { id: true, status: true, suppressUntilUtc: true },
  });

  if (open) {
    // Suppressed: the pharmacist said "I know, stop telling me". Bump
    // `lastSeenAtUtc` so the condition is still tracked, but leave status alone.
    if (open.suppressUntilUtc && open.suppressUntilUtc > now) {
      await systemPrisma.alert.update({
        where: { id: open.id },
        data: {
          lastSeenAtUtc: now,
          occurrenceCount: { increment: 1 },
          evidence: asJson(match.evidence),
        },
      });
      return "SUPPRESSED";
    }

    await systemPrisma.alert.update({
      where: { id: open.id },
      data: {
        lastSeenAtUtc: now,
        occurrenceCount: { increment: 1 },
        evidence: asJson(match.evidence),
      },
    });
    await systemPrisma.alertEvent.create({
      data: {
        alertId: open.id,
        eventType: "RE_EVALUATED",
        meta: asJson({ at: now.toISOString() }),
      },
    });
    return "BUMPED";
  }

  // Cooldown: an alert resolved (by a human) less than `cooldownHours` ago is
  // not immediately reopened. Without this, resolving an alert that is still
  // technically true produces a reopen on the next sweep, the pharmacist learns
  // that resolving does nothing, and the resolve button stops being used.
  const recentlyResolved = await systemPrisma.alert.findFirst({
    where: {
      dedupeKey,
      status: { in: ["RESOLVED_AUTO", "RESOLVED_MANUAL", "SUPPRESSED"] },
      resolvedAtUtc: { gt: new Date(now.getTime() - rule.cooldownHours * 3600_000) },
    },
    select: { id: true },
  });

  if (recentlyResolved) return "COOLDOWN";

  const shouldOpenCase = CASE_OPENING_SEVERITIES.includes(rule.severity);

  try {
    const alert = await systemPrisma.alert.create({
      data: {
        pharmacyId,
        patientId,
        medicationId: match.medicationId,
        ruleKey: rule.spec.key,
        ruleVersion: rule.ruleVersion,
        dedupeKey,
        severity: rule.severity,
        status: "OPEN",
        titleAr: match.titleAr,
        titleEn: match.titleEn,
        detailAr: match.detailAr,
        detailEn: match.detailEn,
        evidence: asJson(match.evidence),
        openedAtUtc: now,
        lastSeenAtUtc: now,
      },
      select: { id: true },
    });

    await systemPrisma.alertEvent.create({
      data: { alertId: alert.id, eventType: "OPENED", meta: asJson(match.evidence) },
    });

    if (shouldOpenCase) {
      const created = await systemPrisma.followUpCase.create({
        data: {
          pharmacyId,
          patientId,
          medicationId: match.medicationId,
          openedByAlertId: alert.id,
          origin: "RULE_ALERT",
          priority: rule.severity === "URGENT" ? "URGENT" : "HIGH",
          status: "OPEN",
          titleAr: match.titleAr,
          titleEn: match.titleEn,
          summary: match.detailEn,
        },
        select: { id: true },
      });

      await systemPrisma.alert.update({
        where: { id: alert.id },
        data: { caseId: created.id },
      });

      return "CASE_OPENED";
    }

    return "OPENED";
  } catch (err) {
    // P2002 here means a concurrent evaluation inserted the same dedupeKey
    // between our lookup and our insert. That is exactly the race the partial
    // index exists to lose safely — so we bump instead of failing.
    if (isUniqueViolation(err)) {
      const existing = await systemPrisma.alert.findFirst({
        where: { dedupeKey, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
        select: { id: true },
      });
      if (existing) {
        await systemPrisma.alert.update({
          where: { id: existing.id },
          data: {
          lastSeenAtUtc: now,
          occurrenceCount: { increment: 1 },
          evidence: asJson(match.evidence),
        },
        });
        return "BUMPED";
      }
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * The sweep.
 *
 * Bounded per run so a large pharmacy cannot turn one sweep into a
 * multi-minute transaction that overlaps the next one. Patients are taken
 * oldest-evaluated-first, so a pharmacy that outgrows the batch size still
 * covers everyone eventually rather than re-evaluating the same head of the list
 * forever.
 */
export async function evaluateRulesSweep(
  now = new Date(),
  batchSize = 200,
): Promise<EvaluationSummary> {
  const total: EvaluationSummary = {
    patientsEvaluated: 0,
    alertsOpened: 0,
    alertsBumped: 0,
    alertsAutoResolved: 0,
    alertsSuppressed: 0,
    casesOpened: 0,
    errors: 0,
  };

  const pharmacies = await systemPrisma.pharmacy.findMany({
    where: { status: "ACTIVE" },
    select: { id: true },
  });

  for (const pharmacy of pharmacies) {
    const rules = await loadRulesFor(systemPrisma, pharmacy.id);
    if (rules.length === 0) continue;

    const patients = await systemPrisma.patient.findMany({
      where: { pharmacyId: pharmacy.id, status: "ACTIVE" },
      select: { id: true },
      take: batchSize,
      orderBy: { id: "asc" },
    });

    for (const patient of patients) {
      try {
        const summary = await evaluatePatient(pharmacy.id, patient.id, rules, now);
        total.patientsEvaluated += 1;
        total.alertsOpened += summary.alertsOpened;
        total.alertsBumped += summary.alertsBumped;
        total.alertsAutoResolved += summary.alertsAutoResolved;
        total.alertsSuppressed += summary.alertsSuppressed;
        total.casesOpened += summary.casesOpened;
      } catch (err) {
        // One patient with malformed history must not abort the sweep for the
        // pharmacy — the remaining patients are the reason it runs.
        total.errors += 1;
        console.error(`[rules] evaluation failed for patient ${patient.id}`, err);
      }
    }
  }

  return total;
}

/**
 * Dry run: what would these parameters have produced?
 *
 * This exists because the PRD is right that the thresholds need clinical
 * validation, and a pharmacist cannot validate a number they cannot see the
 * consequences of. Without it, tuning happens by guessing, waiting a week, and
 * discovering that the pharmacy now gets forty alerts a day.
 *
 * Read-only: no alerts are created, nothing is written.
 */
export async function dryRunRule(
  pharmacyId: string,
  ruleKey: RuleKey,
  params: RuleParams,
  now = new Date(),
  samplePatients = 500,
): Promise<{
  patientsMatching: number;
  patientsEvaluated: number;
  matchesPerPatient: { patientId: string; medicationId: string | null; titleEn: string }[];
}> {
  const spec = findRule(ruleKey);
  if (!spec) throw new Error(`Unknown rule: ${ruleKey}`);

  const resolved = { ...spec.defaultParams, ...params };

  const patients = await systemPrisma.patient.findMany({
    where: { pharmacyId, status: "ACTIVE" },
    select: { id: true },
    take: samplePatients,
  });

  const matches: { patientId: string; medicationId: string | null; titleEn: string }[] = [];

  for (const patient of patients) {
    const book = await buildFactBook(patient.id, now);
    for (const match of spec.evaluate(book, resolved)) {
      matches.push({
        patientId: patient.id,
        medicationId: match.medicationId,
        titleEn: match.titleEn,
      });
    }
  }

  return {
    patientsMatching: new Set(matches.map((m) => m.patientId)).size,
    patientsEvaluated: patients.length,
    matchesPerPatient: matches,
  };
}

/**
 * Ensure the system-default `RuleDefinition` rows exist.
 *
 * Idempotent, and run on worker boot rather than by a migration: the catalog
 * lives in TypeScript, so the rows are derived from it. A migration would freeze
 * a copy of the defaults into SQL and the two would drift.
 */
export async function ensureSystemRules(): Promise<number> {
  let created = 0;

  for (const spec of RULES) {
    const existing = await systemPrisma.ruleDefinition.findFirst({
      where: { pharmacyId: null, ruleKey: spec.key, version: spec.version },
      select: { id: true },
    });
    if (existing) continue;

    await systemPrisma.ruleDefinition.create({
      data: {
        pharmacyId: null,
        ruleKey: spec.key,
        version: spec.version,
        nameAr: spec.nameAr,
        nameEn: spec.nameEn,
        descriptionAr: spec.descriptionAr,
        descriptionEn: spec.descriptionEn,
        enabled: true,
        severity: spec.severity,
        params: spec.defaultParams,
        scope: { appliesTo: "PATIENT" },
        triggerType: "SWEEP",
        compiledCondition: {},
        dedupeKeyTemplate: `${spec.key}|{patientId}|{medicationId}`,
        cooldownHours: spec.cooldownHours,
        actions: {
          openCase: CASE_OPENING_SEVERITIES.includes(spec.severity),
        },
        isSystemDefault: true,
      },
    });
    created += 1;
  }

  return created;
}
