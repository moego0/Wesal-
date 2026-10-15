"use server";

import { DateTime } from "luxon";
import { hasLocale } from "next-intl";
import { z } from "zod";
import {
  CaseStatus,
  InterventionOutcome,
  InterventionType,
} from "@/generated/prisma/enums";
import { routing, type AppLocale } from "@/i18n/routing";
import { AUDIT_ACTION, writeAudit, type AuditWriter } from "@/server/audit";
import { requireSessionUser } from "@/server/auth/current-user";
import { PermissionDeniedError, requirePermission } from "@/server/auth/rbac";
import type { SessionContext } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { canTransition, isTerminalStatus } from "@/server/queries/followups";

/**
 * Writes for the follow-up case screen.
 *
 * Two Server Actions, both of them an endpoint a stranger can post to:
 *
 *   - `recordIntervention` — the PRD's requirement. The pharmacist documents
 *     what they did, what the patient said, and when the next follow-up is due.
 *   - `changeCaseStatus` — moving a case between workflow states without
 *     logging a contact (claiming it, or realising it is waiting on the
 *     patient).
 *
 * Every write is scoped by `user.pharmacyId`, and every change is audited inside
 * the same transaction as the change itself. `AuditEvent` is append-only at the
 * database level, so a row written here can never be corrected: the `before` and
 * `after` payloads deliberately carry identifiers and scalar state only. The
 * patient's free-text notes are clinical content and stay in
 * `PharmacistIntervention`, not in an audit log that outlives every retention
 * decision in the product.
 */

export type CaseActionErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "ILLEGAL_TRANSITION"
  | "FORBIDDEN"
  | "FAILED";

/**
 * What a form gets back. Discriminated rather than a nullable error string, so
 * a caller cannot read an error off a success and has to narrow before it can
 * render a message.
 *
 * The codes are machine-readable; the words live in the catalogs, where the
 * coverage test can see them. A raw Prisma message must never reach a
 * pharmacist, and one returned in English would reach an Arabic one.
 */
export type CaseActionState =
  | { kind: "idle" }
  | { kind: "ok"; status: CaseStatus; interventionId: string | null }
  | {
      kind: "error";
      code: CaseActionErrorCode;
      /** Only set for `ILLEGAL_TRANSITION`; the message is built from these. */
      from: CaseStatus | null;
      to: CaseStatus | null;
    };

/**
 * A status change with no contact behind it still has to be named in the audit
 * trail, and `AUDIT_ACTION` (src/server/audit.ts) has no constant for it. Kept
 * local rather than added there, because that module is shared with screens
 * this work must not disturb and this is its only writer.
 */
const ACTION_CASE_STATUS_CHANGED = "CASE_STATUS_CHANGED";

const TERMINAL_REASON = "Case closed by a pharmacist.";

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FormData values are `string | File | null`, and an untouched optional field
 * arrives as `""` rather than as absent. Folding blank to `undefined` once, here,
 * is what lets every optional field below be declared `.optional()` instead of
 * carrying an `.or(z.literal(""))` at each one.
 */
function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The locale a rejected submission bounces back to. It travels in the form
 * because an action cannot read the URL it was posted from, and it is validated
 * rather than trusted — it ends up in a redirect target.
 */
function safeLocale(value: FormDataEntryValue | null): AppLocale {
  return typeof value === "string" && hasLocale(routing.locales, value)
    ? value
    : routing.defaultLocale;
}

/**
 * Prisma's generated enums are const objects, which is exactly the
 * `Record<string, string>` shape `z.enum` accepts — so the members are checked
 * against the schema itself rather than against a hand-written copy that would
 * drift the next time the enum changes.
 */
const recordInterventionInput = z.object({
  caseId: z.string().min(1).max(64),
  interventionType: z.enum(InterventionType),
  outcome: z.enum(InterventionOutcome),
  notes: z.string().max(2000).optional(),
  /** `yyyy-MM-dd`, from an `<input type="date">`. */
  nextFollowUpDate: z.iso.date().optional(),
  nextStatus: z.enum(CaseStatus).optional(),
});

const changeStatusInput = z.object({
  caseId: z.string().min(1).max(64),
  status: z.enum(CaseStatus),
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared plumbing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The columns both actions read off the case before changing it. Declared once
 * so the two transactions cannot drift into checking different things.
 *
 * The `findFirst` itself is written out at each call site rather than hidden in
 * a helper: it is where `pharmacyId` enters the query, and the tenant guard in
 * `@/server/db` is satisfied by that predicate being visible. A helper typed to
 * accept a transaction handle would also have to be typed against Prisma's base
 * client, which the guarded extension does not satisfy.
 */
const CASE_ROW_SELECT = {
  id: true,
  status: true,
  dueByUtc: true,
  firstActionAtUtc: true,
  patientId: true,
  medicationId: true,
} as const;

function fail(
  code: CaseActionErrorCode,
  from: CaseStatus | null = null,
  to: CaseStatus | null = null,
): CaseActionState {
  return { kind: "error", code, from, to };
}

type Authorization = { denied: CaseActionState } | { user: SessionContext };

/**
 * Session, then permission, before anything is read or parsed.
 *
 * An action is a public endpoint — hiding the form on the page protects
 * nothing. `requireSessionUser` redirects to the login page when the cookie is
 * missing, expired or revoked; `requirePermission` throws, and that throw is
 * turned into a state the form can render rather than a 500.
 */
async function authorize(formData: FormData): Promise<Authorization> {
  const user = await requireSessionUser(safeLocale(formData.get("locale")));

  try {
    requirePermission(user, "followup:write");
  } catch (error) {
    if (error instanceof PermissionDeniedError) return { denied: fail("FORBIDDEN") };
    throw error;
  }

  return { user };
}

/**
 * A date chosen in the form, as the instant it is due.
 *
 * `<input type="date">` yields a calendar date, and a case due "on the 3rd" is
 * due at the END of the 3rd in the pharmacy's own timezone — not at midnight,
 * which would show it as overdue for the whole day the pharmacist was told to
 * follow up on. Luxon does the conversion because Egypt reintroduced DST and a
 * fixed offset is how an app starts being an hour out twice a year.
 */
function dueByUtcFrom(localDate: string, zone: string): Date | null {
  const endOfDay = DateTime.fromISO(localDate, { zone }).endOf("day");
  return endOfDay.isValid ? endOfDay.toUTC().toJSDate() : null;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording an intervention
// ─────────────────────────────────────────────────────────────────────────────

type RecordOutcome =
  | { kind: "ok"; status: CaseStatus; interventionId: string }
  | { kind: "not_found" }
  | { kind: "illegal"; from: CaseStatus; to: CaseStatus };

/**
 * The point of the screen: the pharmacist documents what happened.
 *
 * One transaction writes three things — the intervention, the case's new state,
 * and the audit row — because a partial write here leaves a clinical record
 * that disagrees with itself. The case update covers every field the workflow
 * needs: `firstActionAtUtc` (set once, never overwritten), `dueByUtc` for the
 * next follow-up, and, when the pharmacist closes the case, `resolvedAtUtc` /
 * `resolutionCode` / `resolutionNotes`.
 */
export async function recordIntervention(
  _prev: CaseActionState,
  formData: FormData,
): Promise<CaseActionState> {
  const auth = await authorize(formData);
  if ("denied" in auth) return auth.denied;
  const user = auth.user;

  const parsed = recordInterventionInput.safeParse({
    caseId: field(formData, "caseId"),
    interventionType: field(formData, "interventionType"),
    outcome: field(formData, "outcome"),
    notes: field(formData, "notes"),
    nextFollowUpDate: field(formData, "nextFollowUpDate"),
    nextStatus: field(formData, "nextStatus"),
  });

  if (!parsed.success) return fail("INVALID_INPUT");
  const input = parsed.data;

  const dueByUtc = input.nextFollowUpDate
    ? dueByUtcFrom(input.nextFollowUpDate, user.pharmacyTimeZone)
    : null;

  // A date Luxon cannot resolve is a rejected input, not a silently dropped due
  // date: the pharmacist's next-follow-up instruction is the one thing on this
  // form that a later shift depends on.
  if (input.nextFollowUpDate && dueByUtc === null) return fail("INVALID_INPUT");

  const now = new Date();
  let outcome: RecordOutcome;

  try {
    outcome = await prisma.$transaction(async (tx): Promise<RecordOutcome> => {
      // Scoped by `pharmacyId` through `findFirst`, never `findUnique` by id: a
      // case belonging to another pharmacy has to be indistinguishable from one
      // that does not exist, so the miss below is a plain not-found.
      const kase = await tx.followUpCase.findFirst({
        where: { id: input.caseId, pharmacyId: user.pharmacyId },
        select: CASE_ROW_SELECT,
      });
      if (!kase) return { kind: "not_found" };

      // `undefined` means "leave the status alone"; a target equal to the
      // current status is a no-op rather than an error, so a form submitted
      // twice does not fail the second time.
      const target =
        input.nextStatus && input.nextStatus !== kase.status ? input.nextStatus : null;

      if (target && !canTransition(kase.status, target)) {
        return { kind: "illegal", from: kase.status, to: target };
      }

      const nextStatus = target ?? kase.status;
      const resolving = isTerminalStatus(nextStatus);
      /*
       * A closed case has no next follow-up. `dueByUtc` is a promise to act on
       * this case again, and there is nobody left to act: keeping the date would
       * leave a terminal case that the reports would go on counting as due.
       */
      const nextDueByUtc = resolving ? null : dueByUtc;

      const intervention = await tx.pharmacistIntervention.create({
        data: {
          pharmacyId: user.pharmacyId,
          caseId: kase.id,
          patientId: kase.patientId,
          medicationId: kase.medicationId,
          interventionType: input.interventionType,
          outcome: input.outcome,
          notes: input.notes ?? null,
          performedByUserId: user.userId,
          performedAtUtc: now,
        },
        select: { id: true },
      });

      await tx.followUpCase.updateMany({
        where: { id: kase.id, pharmacyId: user.pharmacyId },
        data: {
          status: nextStatus,
          firstActionAtUtc: kase.firstActionAtUtc ?? now,
          ...(nextDueByUtc ? { dueByUtc: nextDueByUtc } : {}),
          ...(resolving
            ? {
                resolvedAtUtc: now,
                resolutionCode: nextStatus,
                resolutionNotes: input.notes ?? null,
              }
            : {}),
        },
      });

      await writeAudit(tx as unknown as AuditWriter, {
        pharmacyId: user.pharmacyId,
        actorType: "USER",
        actorUserId: user.userId,
        entityType: "FollowUpCase",
        entityId: kase.id,
        action: AUDIT_ACTION.INTERVENTION_RECORDED,
        before: {
          status: kase.status,
          dueByUtc: iso(kase.dueByUtc),
          firstActionAtUtc: iso(kase.firstActionAtUtc),
        },
        after: {
          status: nextStatus,
          dueByUtc: iso(nextDueByUtc ?? kase.dueByUtc),
          resolvedAtUtc: resolving ? now.toISOString() : null,
          interventionId: intervention.id,
          interventionType: input.interventionType,
          outcome: input.outcome,
        },
        reason: resolving ? TERMINAL_REASON : undefined,
      });

      return { kind: "ok", status: nextStatus, interventionId: intervention.id };
    });
  } catch {
    // A raw Prisma error shown to a pharmacist is at best noise and at worst a
    // schema dump. The state carries a code the catalog turns into a sentence.
    return fail("FAILED");
  }

  if (outcome.kind === "not_found") return fail("NOT_FOUND");
  if (outcome.kind === "illegal") return fail("ILLEGAL_TRANSITION", outcome.from, outcome.to);

  return { kind: "ok", status: outcome.status, interventionId: outcome.interventionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Moving a case
// ─────────────────────────────────────────────────────────────────────────────

type MoveOutcome =
  | { kind: "ok"; status: CaseStatus }
  | { kind: "not_found" }
  | { kind: "illegal"; from: CaseStatus; to: CaseStatus };

/**
 * Move a case between workflow states without recording a contact.
 *
 * The transition is refused server-side, not merely hidden in the UI: the
 * dropdown is built from the same table, but a hand-built POST can name any
 * status, and a closed case silently reopening would erase the closure decision
 * from the record the audit trail exists to preserve.
 */
export async function changeCaseStatus(
  _prev: CaseActionState,
  formData: FormData,
): Promise<CaseActionState> {
  const auth = await authorize(formData);
  if ("denied" in auth) return auth.denied;
  const user = auth.user;

  const parsed = changeStatusInput.safeParse({
    caseId: field(formData, "caseId"),
    status: field(formData, "status"),
  });

  if (!parsed.success) return fail("INVALID_INPUT");
  const input = parsed.data;

  const now = new Date();
  let outcome: MoveOutcome;

  try {
    outcome = await prisma.$transaction(async (tx): Promise<MoveOutcome> => {
      // Scoped by `pharmacyId` through `findFirst`, never `findUnique` by id: a
      // case belonging to another pharmacy has to be indistinguishable from one
      // that does not exist, so the miss below is a plain not-found.
      const kase = await tx.followUpCase.findFirst({
        where: { id: input.caseId, pharmacyId: user.pharmacyId },
        select: CASE_ROW_SELECT,
      });
      if (!kase) return { kind: "not_found" };

      // Already there. Nothing changed, so nothing is written and no audit row
      // is created — but this is the state the caller asked for, not a failure.
      if (kase.status === input.status) return { kind: "ok", status: kase.status };

      if (!canTransition(kase.status, input.status)) {
        return { kind: "illegal", from: kase.status, to: input.status };
      }

      const resolving = isTerminalStatus(input.status);

      await tx.followUpCase.updateMany({
        where: { id: kase.id, pharmacyId: user.pharmacyId },
        data: {
          status: input.status,
          firstActionAtUtc: kase.firstActionAtUtc ?? now,
          ...(resolving
            ? { resolvedAtUtc: now, resolutionCode: input.status, resolutionNotes: null }
            : {}),
        },
      });

      await writeAudit(tx as unknown as AuditWriter, {
        pharmacyId: user.pharmacyId,
        actorType: "USER",
        actorUserId: user.userId,
        entityType: "FollowUpCase",
        entityId: kase.id,
        action: resolving ? AUDIT_ACTION.CASE_RESOLVED : ACTION_CASE_STATUS_CHANGED,
        before: { status: kase.status },
        after: {
          status: input.status,
          resolvedAtUtc: resolving ? now.toISOString() : null,
        },
        reason: resolving ? TERMINAL_REASON : undefined,
      });

      return { kind: "ok", status: input.status };
    });
  } catch {
    return fail("FAILED");
  }

  if (outcome.kind === "not_found") return fail("NOT_FOUND");
  if (outcome.kind === "illegal") return fail("ILLEGAL_TRANSITION", outcome.from, outcome.to);

  return { kind: "ok", status: outcome.status, interventionId: null };
}
