import { z } from "zod";
import {
  Locale,
  PharmacyRole,
  type Severity,
  type UserStatus,
} from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { AUDIT_ACTION, writeAudit, type AuditWriter } from "@/server/audit";
import { PASSWORD_ALGO, hashPassword } from "@/server/auth/password";
import { prisma } from "@/server/db";
import {
  RULES,
  findRule,
  resolveParams,
  type RuleKey,
  type RuleParams,
} from "@/server/rules/catalog";
import { dryRunRule } from "@/server/rules/evaluator";

/**
 * Read models AND the mutation core for the administration screens: the pharmacy
 * profile, the rule thresholds, the user list and the audit log.
 *
 * Every function takes an explicit `pharmacyId`. `PharmacyMembership`, `User`
 * and `Pharmacy` are deliberately NOT in the tenant guard's model list in
 * `@/server/db` (they are identity, not clinical data), so the scoping here is
 * the only thing keeping one pharmacy's staff list out of another's — it is
 * written out at every call site rather than assumed.
 *
 * The bottom third of this file writes. The read functions above it do not, and
 * the two halves are kept apart by a labelled section break rather than by being
 * in different modules, because the `"use server"` files that drive the writes
 * cannot host the code that must be tested against a real database. See the
 * comment on that section.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Pharmacy profile
// ─────────────────────────────────────────────────────────────────────────────

export type PharmacyProfile = {
  id: string;
  name: string;
  timeZone: string;
  defaultLocale: Locale;
  quietHoursStart: string;
  quietHoursEnd: string;
};

/**
 * The pharmacy's own row.
 *
 * There is no separate `Setting` model in this codebase — `Pharmacy` IS the
 * settings table, and the columns it carries (name, timeZone, defaultLocale,
 * quietHours*) are the whole of the pharmacy-scoped configuration. Anything the
 * PRD wants that has no column here (a contact phone, an address) has no home
 * yet; `listPharmacyChannels` below is the closest thing that exists, and it is
 * read-only because a channel's number is a webhook routing key, not a label.
 */
export async function getPharmacyProfile(
  pharmacyId: string,
): Promise<PharmacyProfile | null> {
  return prisma.pharmacy.findFirst({
    where: { id: pharmacyId },
    select: {
      id: true,
      name: true,
      timeZone: true,
      defaultLocale: true,
      quietHoursStart: true,
      quietHoursEnd: true,
    },
  });
}

/** The WhatsApp numbers this pharmacy sends from. Read-only — see above. */
export async function listPharmacyChannels(pharmacyId: string) {
  return prisma.messagingChannel.findMany({
    where: { pharmacyId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      provider: true,
      providerPhoneNumberId: true,
      displayPhoneE164: true,
      status: true,
    },
  });
}

/** The IANA identifiers the profile form offers, plus whatever is in use. */
export function supportedTimeZones(current: string): string[] {
  const supported = Intl.supportedValuesOf("timeZone");
  return supported.includes(current)
    ? supported
    : [current, ...supported].filter(Boolean);
}

/**
 * A time zone is valid when the runtime's own tz database accepts it.
 *
 * Asked of `Intl` rather than matched against a hard-coded list: the list drifts
 * with every tzdata release, and a stale copy here would reject a zone the
 * scheduler happily supports (`Asia/Kolkata` aliases, `UTC`, …). An invalid one
 * throws, which is the check.
 */
export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule thresholds
// ─────────────────────────────────────────────────────────────────────────────

export type ParamKind = "count" | "days" | "ratio";
export type ParamMeta = { kind: ParamKind; min: number; max: number };

/**
 * What each parameter MEANS, so the form can label it and the action can bound
 * it without either one hard-coding a rule's shape a second time.
 *
 * `kind` is not cosmetic: an unlabelled number box gives a pharmacist no way to
 * tell that `threshold: 3` means "three missed doses in a row" while
 * `threshold: 0.6` means "sixty percent", and the two live in different rules
 * under the same key. The ratio kinds render as percentages and the counts as
 * integers, which is what makes the distinction visible.
 *
 * The bounds are sanity rails, not clinical advice: they stop a fat-fingered
 * `windowDays: 90000` (which would make the rule scan a patient's entire
 * history on every sweep) without pretending to know the right number.
 */
const RULE_PARAM_META: Record<RuleKey, Record<string, ParamMeta>> = {
  CONSECUTIVE_MISSES: {
    threshold: { kind: "count", min: 2, max: 30 },
    lookbackDoses: { kind: "count", min: 3, max: 120 },
  },
  NO_RESPONSE_STREAK: {
    threshold: { kind: "count", min: 2, max: 30 },
    lookbackDoses: { kind: "count", min: 3, max: 120 },
  },
  NO_ENGAGEMENT: {
    threshold: { kind: "count", min: 2, max: 30 },
  },
  MISSED_DOSE_CLUSTER: {
    windowDays: { kind: "days", min: 3, max: 90 },
    threshold: { kind: "count", min: 2, max: 40 },
    minDoses: { kind: "count", min: 2, max: 120 },
  },
  FREQUENT_LATE_TAKING: {
    windowDays: { kind: "days", min: 3, max: 90 },
    minDoses: { kind: "count", min: 2, max: 120 },
    ratioThreshold: { kind: "ratio", min: 0.1, max: 1 },
  },
  ADHERENCE_BELOW_THRESHOLD: {
    windowDays: { kind: "days", min: 3, max: 90 },
    minDoses: { kind: "count", min: 2, max: 120 },
    threshold: { kind: "ratio", min: 0.1, max: 1 },
  },
  ADHERENCE_DROP: {
    windowDays: { kind: "days", min: 3, max: 90 },
    minDoses: { kind: "count", min: 2, max: 120 },
    dropThreshold: { kind: "ratio", min: 0.05, max: 1 },
  },
};

/**
 * A parameter the metadata table has never heard of still renders and still
 * validates. `RuleDefinition.params` is `Json`, and the catalog can grow a new
 * parameter — the settings screen must show it rather than silently dropping a
 * threshold the engine is now reading.
 */
const FALLBACK_PARAM_META: ParamMeta = { kind: "count", min: 0, max: 100_000 };

export function paramMeta(ruleKey: string, param: string): ParamMeta {
  return RULE_PARAM_META[ruleKey as RuleKey]?.[param] ?? FALLBACK_PARAM_META;
}

/** Every parameter name a rule currently resolves to, in catalog order first. */
export function paramNamesFor(ruleKey: string, params: RuleParams): string[] {
  const declared = Object.keys(RULE_PARAM_META[ruleKey as RuleKey] ?? {});
  const extra = Object.keys(params).filter((k) => !declared.includes(k));
  return [...declared, ...extra];
}

/**
 * Build the validator for one rule's submitted parameters.
 *
 * Derived from the same metadata the form is rendered from, so a parameter
 * cannot be editable in the UI and unvalidated on the server — the two lists
 * are one list.
 */
export function buildParamsSchema(ruleKey: string, paramNames: string[]) {
  const shape: Record<string, z.ZodType> = {};

  for (const name of paramNames) {
    const meta = paramMeta(ruleKey, name);
    // `z.coerce` because every FormData value is a string, and an uncoerced
    // "3" would fail a number schema while looking perfectly numeric in the
    // request. `coerce` turns "abc" into NaN, which the number type rejects, so
    // coercion does not soften the check.
    let field = z.coerce.number().min(meta.min).max(meta.max);
    if (meta.kind !== "ratio") field = field.int();
    shape[name] = field;
  }

  return z.object(shape);
}

export type RuleParamView = { name: string; kind: ParamKind; value: number };

export type RuleSetting = {
  key: RuleKey;
  version: number;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  severity: Severity;
  cooldownHours: number;
  params: RuleParamView[];
  /** The pharmacy's own row, when one exists. Null means the catalogue default. */
  ownRowId: string | null;
  ownRowVersion: number | null;
  updatedAt: Date | null;
};

/**
 * Every rule in the catalogue, bound to the parameters this pharmacy actually
 * runs with.
 *
 * The baseline is the CATALOGUE, not the `pharmacyId: null` rows. Those system
 * rows are derived from the catalogue by `ensureSystemRules()` on worker boot
 * and their only job is to be a row the catalog can be loaded from — the
 * catalogue itself is the same data, needs no database round trip, and is
 * available even on a fresh deploy where the worker has never run. It is also
 * the only version reachable through the tenant-guarded client: a `where` of
 * `{ OR: [{ pharmacyId }, { pharmacyId: null }] }` has no top-level
 * `pharmacyId`, and the guard in `@/server/db` rejects exactly that shape — so
 * reading the system rows here would mean reaching for `systemPrisma`, which a
 * screen has no business doing.
 *
 * Only the LATEST pharmacy row per key is shown; older rows stay in the table
 * as the version history `Alert.ruleVersion` points back into.
 */
export async function listRuleSettings(pharmacyId: string): Promise<RuleSetting[]> {
  const ownRows = await prisma.ruleDefinition.findMany({
    where: { pharmacyId },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      ruleKey: true,
      version: true,
      params: true,
      severity: true,
      cooldownHours: true,
      nameAr: true,
      nameEn: true,
      descriptionAr: true,
      descriptionEn: true,
      updatedAt: true,
    },
  });

  const latestByKey = new Map<string, (typeof ownRows)[number]>();
  for (const row of ownRows) {
    if (!latestByKey.has(row.ruleKey)) latestByKey.set(row.ruleKey, row);
  }

  return RULES.map((spec) => {
    const own = latestByKey.get(spec.key) ?? null;
    const effective = resolveParams(spec.key, own?.params);

    return {
      key: spec.key,
      version: own?.version ?? spec.version,
      // A pharmacy row carries its own copy of the copy, so an edit made in a
      // newer deployment is not overwritten by this one's catalogue text.
      nameAr: own?.nameAr ?? spec.nameAr,
      nameEn: own?.nameEn ?? spec.nameEn,
      descriptionAr: own?.descriptionAr ?? spec.descriptionAr,
      descriptionEn: own?.descriptionEn ?? spec.descriptionEn,
      severity: (own?.severity as Severity) ?? spec.severity,
      cooldownHours: own?.cooldownHours ?? spec.cooldownHours,
      params: paramNamesFor(spec.key, effective).map((name) => ({
        name,
        kind: paramMeta(spec.key, name).kind,
        value: effective[name],
      })),
      ownRowId: own?.id ?? null,
      ownRowVersion: own?.version ?? null,
      updatedAt: own?.updatedAt ?? null,
    };
  });
}

export type RuleDryRun = {
  ruleKey: RuleKey;
  /** Alerts the rule would raise against the data as it stands. */
  alerts: number;
  patientsMatching: number;
  patientsEvaluated: number;
};

/**
 * How many patients the dry run reads. Exported so the screen can state it.
 *
 * The cost is one fact-book query per patient PER RULE, so this number
 * multiplies by the size of the catalogue. 100 keeps a full seven-rule dry run
 * inside a second on a local database while still being large enough that the
 * count means something; a pharmacy big enough to exhaust the sample will see
 * the sample size printed beside the number rather than a figure that quietly
 * under-reports.
 */
export const DRY_RUN_SAMPLE = 100;

/**
 * What each rule would have produced, on the data as it stands.
 *
 * Calls `dryRunRule` from `@/server/rules/evaluator` rather than re-deriving the
 * count here: that helper builds the fact book through the same
 * `buildFactBook` the sweeps use and calls the same pure `evaluate`, so the
 * number on this screen is the number the pharmacist would actually get. A
 * second implementation in the query layer would be the classic "two screens
 * disagree about the same patient" bug, except here it would be two screens
 * disagreeing about whether a rule fires at all.
 *
 * Runs SEQUENTIALLY on purpose. Seven parallel dry runs would open seven
 * concurrent scans of the same ReminderEvent rows to save a few hundred
 * milliseconds on a screen nobody visits in a hurry.
 *
 * One rule failing must not blank the column, so each is caught on its own and
 * reported as null — the screen renders a dash, not a misleading zero.
 */
export async function dryRunRuleSettings(
  pharmacyId: string,
  settings: ReadonlyArray<{ key: RuleKey; params: RuleParams }>,
  samplePatients = DRY_RUN_SAMPLE,
  now = new Date(),
): Promise<Map<string, RuleDryRun | null>> {
  const results = new Map<string, RuleDryRun | null>();

  for (const setting of settings) {
    try {
      const run = await dryRunRule(pharmacyId, setting.key, setting.params, now, samplePatients);
      results.set(setting.key, {
        ruleKey: setting.key,
        // Every match is one alert row the engine would open or bump — the rule
        // is evaluated per medication, so a patient failing on two medicines
        // produces two alerts, and counting patients here would understate the
        // load the pharmacist is about to take on.
        alerts: run.matchesPerPatient.length,
        patientsMatching: run.patientsMatching,
        patientsEvaluated: run.patientsEvaluated,
      });
    } catch (err) {
      console.error(`[admin] dry run failed for rule ${setting.key}`, err);
      results.set(setting.key, null);
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

export type MembershipRow = {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  phoneE164: string | null;
  role: PharmacyRole;
  active: boolean;
  userStatus: UserStatus;
  lastLoginAt: Date | null;
  joinedAt: Date;
  /** True for the signed-in user's own row. Drives the server-side guards. */
  isSelf: boolean;
};

/**
 * The pharmacy's staff, active first.
 *
 * Inactive memberships are INCLUDED. A deactivated colleague is exactly who an
 * admin needs to find in order to reactivate them, and hiding them turns every
 * accidental deactivation into a support ticket. They are rendered muted
 * instead.
 */
export async function listPharmacyMemberships(
  pharmacyId: string,
  currentUserId: string,
): Promise<MembershipRow[]> {
  const rows = await prisma.pharmacyMembership.findMany({
    where: { pharmacyId },
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      userId: true,
      role: true,
      active: true,
      createdAt: true,
      // Selected field by field rather than `include: { user: true }`: the
      // latter hands back `passwordHash` and `passwordAlgo` in the returned
      // object, which is one careless spread away from the RSC payload.
      user: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phoneE164: true,
          status: true,
          lastLoginAt: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    membershipId: row.id,
    userId: row.userId,
    fullName: row.user.fullName,
    email: row.user.email,
    phoneE164: row.user.phoneE164,
    role: row.role,
    active: row.active,
    userStatus: row.user.status,
    lastLoginAt: row.user.lastLoginAt,
    joinedAt: row.createdAt,
    isSelf: row.userId === currentUserId,
  }));
}

/** How many people could still administer the pharmacy. Drives a UI warning. */
export async function countActiveAdmins(pharmacyId: string): Promise<number> {
  return prisma.pharmacyMembership.count({
    where: { pharmacyId, role: "PHARMACY_ADMIN", active: true },
  });
}

export type PatientCreatorCounts = {
  /** userId → patients in this pharmacy created by that user. Zero-count users are absent. */
  byUserId: Map<string, number>;
  /** Patients in this pharmacy with no recorded creator (`createdByUserId IS NULL`). */
  unassigned: number;
};

/**
 * How many patients each colleague added, for the users table.
 *
 * `Patient.createdByUserId` is a plain scalar with no relation and no index, so
 * one grouped scan is the cheapest honest answer — a per-member `count()` would
 * be N+1 queries. The column is nullable, which is why the null group is
 * reported separately instead of being dropped: those patients would otherwise
 * vanish from a screen that looks like a complete roster.
 *
 * A patient whose creator no longer has a membership here is in neither bucket
 * (the scalar is not a relation), so the UI must not claim the counts add up to
 * the pharmacy's patient total.
 *
 * The guarded `prisma` client is used deliberately: the tenant guard accepts
 * this call only because `where.pharmacyId` is top-level, and that requirement
 * is part of the contract this function relies on.
 */
export async function countPatientsByCreator(
  pharmacyId: string,
): Promise<PatientCreatorCounts> {
  const groups = await prisma.patient.groupBy({
    by: ["createdByUserId"],
    where: { pharmacyId },
    _count: { _all: true },
  });

  const byUserId = new Map<string, number>();
  let unassigned = 0;

  for (const group of groups) {
    if (group.createdByUserId === null) unassigned = group._count._all;
    else byUserId.set(group.createdByUserId, group._count._all);
  }

  return { byUserId, unassigned };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────

export const AUDIT_PAGE_SIZE = 25;

export type AuditFilters = {
  /** A user id, or the literal "SYSTEM" for rows with no actor. */
  actor?: string;
  action?: string;
  entityType?: string;
  fromUtc?: Date;
  toUtc?: Date;
};

export type AuditRow = {
  /** `AuditEvent.id` is a BigInt; stringified at this boundary. */
  id: string;
  actorType: string;
  actorUserId: string | null;
  actorName: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  ipAddress: string | null;
  occurredAtUtc: Date;
};

export type AuditPage = {
  rows: AuditRow[];
  total: number;
  page: number;
  pageCount: number;
};

function buildAuditWhere(pharmacyId: string, filters: AuditFilters) {
  const where: Prisma.AuditEventWhereInput = { pharmacyId };

  if (filters.actor === "SYSTEM") {
    where.actorUserId = null;
    where.actorType = "SYSTEM";
  } else if (filters.actor) {
    where.actorUserId = filters.actor;
  }

  if (filters.action) where.action = filters.action;
  if (filters.entityType) where.entityType = filters.entityType;

  if (filters.fromUtc || filters.toUtc) {
    where.occurredAtUtc = {
      ...(filters.fromUtc ? { gte: filters.fromUtc } : {}),
      ...(filters.toUtc ? { lte: filters.toUtc } : {}),
    };
  }

  return where;
}

/**
 * One page of the audit log, newest first, with the unfiltered-in-page total.
 *
 * Read-only, and read-only by construction: `AuditEvent` has no update or delete
 * path anywhere in the application, and the database trigger from
 * `20261014060000_hard_constraints` rejects both even from raw SQL. This
 * function is the only way the log reaches a screen, and it never writes.
 *
 * `where.pharmacyId` is not optional — `AuditEvent` IS a tenant-guarded model,
 * so a query without it throws rather than returning every pharmacy's history.
 */
export async function listAuditEvents(
  pharmacyId: string,
  filters: AuditFilters,
  page = 1,
  pageSize = AUDIT_PAGE_SIZE,
): Promise<AuditPage> {
  const where = buildAuditWhere(pharmacyId, filters);

  const total = await prisma.auditEvent.count({ where });

  // A page past the end (a stale link, or a filter that shrank the result set)
  // would otherwise render an empty table under a total that says otherwise.
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);

  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: { occurredAtUtc: "desc" },
    take: pageSize,
    skip: (safePage - 1) * pageSize,
    select: {
      id: true,
      actorType: true,
      actorUserId: true,
      entityType: true,
      entityId: true,
      action: true,
      before: true,
      after: true,
      reason: true,
      ipAddress: true,
      occurredAtUtc: true,
    },
  });

  const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter((id): id is string => !!id))];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const actorNames = new Map(actors.map((a) => [a.id, a.fullName || a.email]));

  return {
    rows: rows.map((row) => ({
      ...row,
      // BigInt cannot cross the RSC boundary and cannot be a React child; the
      // string form is also what the UI should show, since the id is an opaque
      // ordering artefact, not a number anyone does arithmetic on.
      id: String(row.id),
      actorName: row.actorUserId ? (actorNames.get(row.actorUserId) ?? null) : null,
    })),
    total,
    page: safePage,
    pageCount,
  };
}

/**
 * The values actually present in this pharmacy's log, for the filter dropdowns.
 *
 * Built from the data rather than from the `AUDIT_ACTION` constant: the log
 * contains rows written by features that no longer exist, and a filter that
 * cannot reach them makes the log look like it never happened.
 */
export async function listAuditFilterOptions(pharmacyId: string): Promise<{
  actors: { value: string; label: string }[];
  actions: string[];
  entityTypes: string[];
}> {
  const [actorRows, actionRows, entityRows] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { pharmacyId },
      distinct: ["actorUserId"],
      select: { actorUserId: true },
    }),
    prisma.auditEvent.findMany({
      where: { pharmacyId },
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    }),
    prisma.auditEvent.findMany({
      where: { pharmacyId },
      distinct: ["entityType"],
      select: { entityType: true },
      orderBy: { entityType: "asc" },
    }),
  ]);

  const ids = actorRows
    .map((r) => r.actorUserId)
    .filter((id): id is string => id !== null);

  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, fullName: true, email: true },
        orderBy: { fullName: "asc" },
      })
    : [];

  const actors = users.map((u) => ({ value: u.id, label: u.fullName || u.email }));

  if (actorRows.some((r) => r.actorUserId === null)) {
    // Rendered with a translated label by the page; the value is the sentinel
    // `buildAuditWhere` understands.
    actors.push({ value: "SYSTEM", label: "" });
  }

  return {
    actors,
    actions: actionRows.map((r) => r.action),
    entityTypes: entityRows.map((r) => r.entityType),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation core for the administration screens
//
// These live here, in a plain module, rather than in the `"use server"` files
// that call them. Every export of a `"use server"` file is a PUBLIC ENDPOINT —
// the client can invoke any of them with any arguments — so a helper that takes
// its actor as a parameter cannot be exported from one: a caller could pass a
// forged pharmacy id and skip straight past the permission check that the real
// action performs. Keeping the core in a normal module means it is unreachable
// from the browser, and the only way in is through an action that has already
// run `requireSessionUser` and `requirePermission`.
//
// CONSEQUENCE FOR CALLERS: `actor` is trusted input. It must come from a
// validated session, never from a form field or a URL.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Codes the actions translate into user-facing text. Kept as string unions
 * rather than thrown errors so an action can turn any outcome — including a
 * refusal — into a redirect without a try/catch around `redirect()`, which
 * swallows it.
 */
export type AdminSuccessCode =
  | "PROFILE_SAVED"
  | "RULE_SAVED"
  | "ROLE_CHANGED"
  | "MEMBER_INVITED"
  | "MEMBER_ACTIVATED"
  | "MEMBER_DEACTIVATED"
  | "NO_CHANGE";

export type AdminRefusalCode =
  | "NOT_FOUND"
  | "SELF_ROLE"
  | "SELF_DEACTIVATE"
  | "LAST_ADMIN"
  | "EMAIL_TAKEN"
  | "INVALID_INPUT";

export type AdminMutationResult<T = undefined> =
  | { ok: true; code: AdminSuccessCode; data: T }
  | { ok: false; code: AdminRefusalCode; /** The field that failed, when known. */ detail?: string };

/** The already-authenticated caller. See the note above. */
export type AdminActor = { pharmacyId: string; userId: string };

/**
 * `AuditEvent.action` is a plain String column, so a constant here is about
 * greppability, not about a constraint. These two are declared locally because
 * `AUDIT_ACTION` in `@/server/audit.ts` — a file shared with other work landing
 * concurrently — has no entry for either.
 */
const LOCAL_AUDIT_ACTION = {
  /** There is a `PHARMACY_CREATED` but no update counterpart. */
  PHARMACY_UPDATED: "PHARMACY_UPDATED",
  /** `USER_SUSPENDED` covers deactivation; nothing covers the reverse. */
  USER_REACTIVATED: "USER_REACTIVATED",
} as const;

/**
 * The transaction handle.
 *
 * Derived from the client itself rather than written as `Prisma.TransactionClient`,
 * because `prisma` from `@/server/db` is not a bare client — the tenant guard is
 * a `$extends` wrapper, so the callback it hands you is the EXTENDED client, and
 * the two are structurally different (the extension rewrites the args type of
 * every guarded model). `Omit<typeof prisma, …>` is the documented shape of that
 * handle and stays correct if the extension changes; `Prisma.TransactionClient`
 * is the un-extended one and fails to accept it.
 */
type Tx = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

/**
 * `RuleDefinition.params` and friends are Prisma `Json` inputs, which the
 * generated types will not accept from an `unknown`-typed value. The catalogue
 * hands back plain objects and numbers that serialise by inspection; the cast is
 * the same one `evaluator.ts` uses for the same reason.
 */
const asJson = (value: unknown) => value as never;

/**
 * The optional "why" an admin may attach to a change.
 *
 * Clamped rather than rejected: a 2000-character justification is not an error,
 * it is a long one, and refusing the whole change over it would lose the change.
 * Blank folds to `undefined` so an untouched field does not leave an empty
 * string in the audit row, where `null` and `""` read differently.
 */
function auditReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, 200);
}

// ── pharmacy profile ──

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/**
 * Prisma's generated enums are const objects, which is exactly the
 * `Record<string, string>` shape `z.enum` accepts — so `defaultLocale` is
 * checked against the schema's own `Locale` rather than against a hand-written
 * copy of it that would drift the next time a language is added. `env.ts` does
 * the same thing for `MESSAGING_PROVIDER`.
 */
const profileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  timeZone: z.string().trim().min(1).max(64).refine(isValidTimeZone),
  defaultLocale: z.enum(Locale),
  quietHoursStart: z.string().regex(HHMM),
  quietHoursEnd: z.string().regex(HHMM),
  reason: z.string().trim().max(200).optional(),
});

/** Field name → the refusal code the screen knows how to explain. */
const PROFILE_FIELD_CODE: Record<string, AdminRefusalCode> = {
  name: "INVALID_INPUT",
  timeZone: "INVALID_INPUT",
  defaultLocale: "INVALID_INPUT",
  quietHoursStart: "INVALID_INPUT",
  quietHoursEnd: "INVALID_INPUT",
};

export async function applyPharmacyProfile(
  actor: AdminActor,
  input: {
    name: unknown;
    timeZone: unknown;
    defaultLocale: unknown;
    quietHoursStart: unknown;
    quietHoursEnd: unknown;
    reason?: unknown;
  },
): Promise<AdminMutationResult> {
  const parsed = profileSchema.safeParse({ ...input, reason: auditReason(input.reason) });

  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return { ok: false, code: PROFILE_FIELD_CODE[field] ?? "INVALID_INPUT", detail: field };
  }

  const next = parsed.data;

  // `findFirst` on the session's own pharmacyId, so this cannot be pointed at
  // another tenant even if the id were somehow attacker-controlled.
  const before = await prisma.pharmacy.findFirst({
    where: { id: actor.pharmacyId },
    select: {
      name: true,
      timeZone: true,
      defaultLocale: true,
      quietHoursStart: true,
      quietHoursEnd: true,
    },
  });

  if (!before) return { ok: false, code: "NOT_FOUND" };

  await prisma.$transaction(async (tx) => {
    await tx.pharmacy.update({
      where: { id: actor.pharmacyId },
      data: {
        name: next.name,
        timeZone: next.timeZone,
        defaultLocale: next.defaultLocale,
        quietHoursStart: next.quietHoursStart,
        quietHoursEnd: next.quietHoursEnd,
      },
    });

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: actor.pharmacyId,
      actorType: "USER",
      actorUserId: actor.userId,
      entityType: "Pharmacy",
      entityId: actor.pharmacyId,
      action: LOCAL_AUDIT_ACTION.PHARMACY_UPDATED,
      before,
      after: {
        name: next.name,
        timeZone: next.timeZone,
        defaultLocale: next.defaultLocale,
        quietHoursStart: next.quietHoursStart,
        quietHoursEnd: next.quietHoursEnd,
      },
      reason: next.reason,
    });
  });

  return { ok: true, code: "PROFILE_SAVED", data: undefined };
}

// ── rule thresholds ──

export type RuleSaveData = { ruleKey: RuleKey; params: RuleParams };

/**
 * Write a pharmacy-scoped `RuleDefinition` for one rule.
 *
 * A NEW ROW PER SAVE, version bumped. `@@unique([pharmacyId, ruleKey, version])`
 * exists precisely so this shape is legal, and `Alert.ruleVersion` records which
 * version fired — so an alert raised in March stays explainable after the
 * threshold is retuned in April. Updating in place would erase the only record
 * of what the engine was actually configured to do at the time.
 *
 * `enabled` is written as `true` and the screen offers no way to write anything
 * else. `loadRulesFor` in `@/server/rules/evaluator.ts` filters `enabled: true`
 * in the same query it uses to choose the pharmacy's row, so a disabled
 * pharmacy row is not "off" — it is invisible, and the system default quietly
 * takes over. A kill switch here would look like it worked and behave like
 * "reset to defaults", so there is not one.
 */
export async function applyRuleParams(
  actor: AdminActor,
  input: { ruleKey: unknown; params: Record<string, unknown>; reason?: unknown },
): Promise<AdminMutationResult<RuleSaveData>> {
  const spec = typeof input.ruleKey === "string" ? findRule(input.ruleKey) : undefined;
  if (!spec) return { ok: false, code: "INVALID_INPUT", detail: "ruleKey" };

  // Latest row wins, matching `loadRulesFor`.
  const own = await prisma.ruleDefinition.findFirst({
    where: { pharmacyId: actor.pharmacyId, ruleKey: spec.key },
    orderBy: { version: "desc" },
    select: { id: true, version: true, params: true, cooldownHours: true, actions: true },
  });

  const effective = resolveParams(spec.key, own?.params);
  const names = paramNamesFor(spec.key, effective);

  const parsed = buildParamsSchema(spec.key, names).safeParse(
    Object.fromEntries(names.map((name) => [name, input.params[name]])),
  );

  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return { ok: false, code: "INVALID_INPUT", detail: field };
  }

  const params = parsed.data as RuleParams;
  const reason = auditReason(input.reason);

  const nextVersion = (own?.version ?? spec.version) + 1;

  await prisma.$transaction(async (tx) => {
    const created = await tx.ruleDefinition.create({
      data: {
        pharmacyId: actor.pharmacyId,
        ruleKey: spec.key,
        version: nextVersion,
        nameAr: spec.nameAr,
        nameEn: spec.nameEn,
        descriptionAr: spec.descriptionAr,
        descriptionEn: spec.descriptionEn,
        enabled: true,
        severity: spec.severity,
        params: asJson(params),
        scope: asJson({ appliesTo: "PATIENT" }),
        triggerType: "SWEEP",
        // Documented as an output written for auditability; the executable
        // predicate is always derived from ruleKey + params in code.
        compiledCondition: asJson({ ruleKey: spec.key, params }),
        dedupeKeyTemplate: `${spec.key}|{patientId}|{medicationId}`,
        cooldownHours: own?.cooldownHours ?? spec.cooldownHours,
        actions:
          own?.actions ??
          asJson({ openCase: spec.severity === "HIGH" || spec.severity === "URGENT" }),
        isSystemDefault: false,
        createdByUserId: actor.userId,
      },
      select: { id: true },
    });

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: actor.pharmacyId,
      actorType: "USER",
      actorUserId: actor.userId,
      entityType: "RuleDefinition",
      entityId: created.id,
      action: AUDIT_ACTION.RULE_CHANGED,
      before: {
        version: own?.version ?? null,
        source: own ? "PHARMACY" : "CATALOGUE_DEFAULT",
        params: effective,
      },
      after: { version: nextVersion, ruleKey: spec.key, params },
      reason,
    });
  });

  return { ok: true, code: "RULE_SAVED", data: { ruleKey: spec.key, params } };
}

// ── memberships ──

const roleSchema = z.enum(PharmacyRole);
const idSchema = z.string().trim().min(1).max(64);

/**
 * Take a write lock on the pharmacy row for the rest of this transaction.
 *
 * THE LAST-ADMIN CHECK CANNOT BE A READ-THEN-WRITE. Two demotions submitted at
 * the same instant — one admin demoting A, another demoting B — both read
 * "two active admins", both conclude they are safe, and the pharmacy is left
 * with none. Nothing in the database catches it: `PharmacyMembership` has no
 * constraint that could express "at least one active admin", so the invariant
 * exists only in application code, and application code that reads before it
 * writes is a race. Locking a single row both transactions must touch turns the
 * check and the write into one serial operation, so the second one reads the
 * first one's result.
 *
 * A lock on `Pharmacy` rather than on the membership rows because the lock
 * target must exist for EVERY mutation, including the one that demotes the last
 * admin — locking rows that may not be there is not a lock.
 */
async function lockPharmacy(tx: Tx, pharmacyId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Pharmacy" WHERE "id" = ${pharmacyId} FOR UPDATE`;
}

type MembershipSnapshot = {
  id: string;
  userId: string;
  role: PharmacyRole;
  active: boolean;
};

/**
 * The row, or nothing — scoped by the actor's pharmacy.
 *
 * `findFirst({ where: { id, pharmacyId } })`, never `findUnique({ where: { id } })`:
 * a membership belonging to another pharmacy has to be indistinguishable from
 * one that does not exist, or this action becomes a way to probe for and then
 * modify another tenant's staff.
 */
async function loadMembership(
  tx: Tx,
  pharmacyId: string,
  membershipId: string,
): Promise<MembershipSnapshot | null> {
  return tx.pharmacyMembership.findFirst({
    where: { id: membershipId, pharmacyId },
    select: { id: true, userId: true, role: true, active: true },
  });
}

/**
 * Refuse to leave the pharmacy without an active administrator.
 *
 * Called with the lock already held — see `lockPharmacy` for why the ordering
 * matters more than the predicate.
 */
async function wouldRemoveLastAdmin(
  tx: Tx,
  pharmacyId: string,
  membership: MembershipSnapshot,
): Promise<boolean> {
  if (membership.role !== "PHARMACY_ADMIN" || !membership.active) return false;

  const remaining = await tx.pharmacyMembership.count({
    where: {
      pharmacyId,
      role: "PHARMACY_ADMIN",
      active: true,
      id: { not: membership.id },
    },
  });

  return remaining === 0;
}

export async function applyMembershipRole(
  actor: AdminActor,
  input: { membershipId: unknown; role: unknown; reason?: unknown },
): Promise<AdminMutationResult> {
  const membershipId = idSchema.safeParse(input.membershipId);
  const role = roleSchema.safeParse(input.role);

  if (!membershipId.success) return { ok: false, code: "INVALID_INPUT", detail: "membershipId" };
  if (!role.success) return { ok: false, code: "INVALID_INPUT", detail: "role" };

  const reason = auditReason(input.reason);

  const outcome = await prisma.$transaction(async (tx) => {
    await lockPharmacy(tx, actor.pharmacyId);

    const membership = await loadMembership(tx, actor.pharmacyId, membershipId.data);
    if (!membership) return { ok: false, code: "NOT_FOUND" } as const;

    // An admin who demotes themselves can lock the pharmacy out of its own
    // settings, and if they are the only admin there is no way back in — so
    // this is refused flatly rather than guarded by the last-admin check, which
    // would still allow the second-to-last admin to demote themselves.
    if (membership.userId === actor.userId) return { ok: false, code: "SELF_ROLE" } as const;

    if (membership.role === role.data) {
      // Not a mutation, so nothing is written — including no audit row. An
      // audit log padded with "nothing happened" entries is one nobody reads.
      return { ok: true, code: "NO_CHANGE", data: undefined } as const;
    }

    if (await wouldRemoveLastAdmin(tx, actor.pharmacyId, membership)) {
      return { ok: false, code: "LAST_ADMIN" } as const;
    }

    await tx.pharmacyMembership.update({
      where: { id: membership.id },
      data: { role: role.data },
    });

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: actor.pharmacyId,
      actorType: "USER",
      actorUserId: actor.userId,
      entityType: "PharmacyMembership",
      entityId: membership.id,
      action: AUDIT_ACTION.USER_ROLE_CHANGED,
      before: { userId: membership.userId, role: membership.role },
      after: { userId: membership.userId, role: role.data },
      reason,
      // Sessions are NOT revoked here: `validateSession` re-reads the
      // membership on every request, so the new role is in force on the
      // colleague's very next page load rather than at token expiry.
    });

    return { ok: true, code: "ROLE_CHANGED", data: undefined } as const;
  });

  return outcome;
}

export async function applyMembershipActive(
  actor: AdminActor,
  input: { membershipId: unknown; active: unknown; reason?: unknown },
): Promise<AdminMutationResult> {
  const membershipId = idSchema.safeParse(input.membershipId);
  if (!membershipId.success) return { ok: false, code: "INVALID_INPUT", detail: "membershipId" };

  const active = input.active === true || input.active === "true" || input.active === "on";
  const reason = auditReason(input.reason);

  const outcome = await prisma.$transaction(async (tx) => {
    await lockPharmacy(tx, actor.pharmacyId);

    const membership = await loadMembership(tx, actor.pharmacyId, membershipId.data);
    if (!membership) return { ok: false, code: "NOT_FOUND" } as const;

    // Deactivating yourself is the same trap as demoting yourself, one step
    // further along: the account that could undo it is the account that just
    // lost access.
    if (!active && membership.userId === actor.userId) {
      return { ok: false, code: "SELF_DEACTIVATE" } as const;
    }

    if (membership.active === active) return { ok: true, code: "NO_CHANGE", data: undefined } as const;

    if (!active && (await wouldRemoveLastAdmin(tx, actor.pharmacyId, membership))) {
      return { ok: false, code: "LAST_ADMIN" } as const;
    }

    await tx.pharmacyMembership.update({
      where: { id: membership.id },
      // Only the membership flips. `User.status` is global — the same person
      // may be on staff at a second pharmacy, and suspending their account here
      // would sign them out there.
      data: { active },
    });

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: actor.pharmacyId,
      actorType: "USER",
      actorUserId: actor.userId,
      entityType: "PharmacyMembership",
      entityId: membership.id,
      action: active ? LOCAL_AUDIT_ACTION.USER_REACTIVATED : AUDIT_ACTION.USER_SUSPENDED,
      before: { userId: membership.userId, active: membership.active },
      after: { userId: membership.userId, active },
      reason,
    });

    return { ok: true, code: active ? "MEMBER_ACTIVATED" : "MEMBER_DEACTIVATED", data: undefined } as const;
  });

  return outcome;
}

const inviteSchema = z.object({
  // Trim and lower-case BEFORE the format check, not after: `z.email()` on its
  // own rejects ` A@B.com ` because of the spaces, and the admin pasting an
  // address out of an email client is the common case, not the odd one. Stored
  // lower-cased because `User.email` is unique and the database would otherwise
  // treat `A@b.com` and `a@b.com` as two staff accounts.
  email: z.string().trim().toLowerCase().max(200).pipe(z.email()),
  fullName: z.string().trim().min(2).max(120),
  role: roleSchema,
  phoneE164: z.string().trim().max(20).optional(),
  /**
   * Optional. Left empty, the account is created in `INVITED` with no password
   * hash at all — which means it CANNOT sign in, because `loginAction` refuses a
   * user without one. That is the honest state of an invitation with no email
   * delivery and no password-reset flow behind it, and it is better than
   * inventing a password nobody knows. Filled in, the admin is provisioning the
   * account by hand and it goes live immediately.
   */
  initialPassword: z.string().min(10).max(200).optional(),
});

export async function invitePharmacyMember(
  actor: AdminActor,
  input: Record<string, unknown>,
): Promise<AdminMutationResult> {
  const parsed = inviteSchema.safeParse({
    email: input.email,
    fullName: input.fullName,
    role: input.role,
    phoneE164:
      typeof input.phoneE164 === "string" && input.phoneE164.trim() !== ""
        ? input.phoneE164
        : undefined,
    initialPassword:
      typeof input.initialPassword === "string" && input.initialPassword !== ""
        ? input.initialPassword
        : undefined,
  });

  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "");
    return { ok: false, code: "INVALID_INPUT", detail: field };
  }

  const { email, fullName, role, phoneE164, initialPassword } = parsed.data;

  const passwordHash = initialPassword ? await hashPassword(initialPassword) : null;

  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, status: true },
    });

    if (existing) {
      const alreadyMember = await tx.pharmacyMembership.findFirst({
        where: { pharmacyId: actor.pharmacyId, userId: existing.id },
        select: { id: true },
      });
      if (alreadyMember) return { ok: false, code: "EMAIL_TAKEN" } as const;
    }

    // A `User` is a GLOBAL identity — one person, two pharmacies. When the
    // address already exists the membership is attached to it rather than a
    // second account being invented; `User.email` is unique, so the alternative
    // is an error that strands a real colleague with no way in.
    const userId = existing
      ? existing.id
      : (
          await tx.user.create({
            data: {
              email,
              fullName,
              phoneE164: phoneE164 ?? null,
              status: passwordHash ? "ACTIVE" : "INVITED",
              passwordHash,
              passwordAlgo: passwordHash ? PASSWORD_ALGO : null,
            },
            select: { id: true },
          })
        ).id;

    // Fills in a missing password for an existing account that has never been
    // able to sign in. Never overwrites one that works.
    if (existing && passwordHash && !existing.passwordHash) {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordAlgo: PASSWORD_ALGO, status: "ACTIVE" },
      });
    }

    const membership = await tx.pharmacyMembership.create({
      data: { userId, pharmacyId: actor.pharmacyId, role, active: true },
      select: { id: true },
    });

    await writeAudit(tx as unknown as AuditWriter, {
      pharmacyId: actor.pharmacyId,
      actorType: "USER",
      actorUserId: actor.userId,
      entityType: "PharmacyMembership",
      entityId: membership.id,
      action: AUDIT_ACTION.USER_INVITED,
      after: { userId, email, role, activated: Boolean(passwordHash) },
    });

    return { ok: true, code: "MEMBER_INVITED", data: undefined } as const;
  });

  return outcome;
}
