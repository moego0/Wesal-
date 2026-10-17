import type { ActorType } from "@/generated/prisma/enums";
import { systemPrisma } from "./db";

/**
 * Audit trail.
 *
 * `AuditEvent` is append-only in the database (a trigger rejects UPDATE and
 * DELETE), so these rows are permanent. Two consequences shape this module:
 *
 *   1. Never log anything you would not want retained indefinitely. In
 *      particular, do not put clinical free text or message bodies in `before`
 *      / `after` — log identifiers and changed fields.
 *
 *   2. Every call must happen INSIDE the transaction that makes the change.
 *      Auditing after commit means a crash between the two leaves a change with
 *      no record, which is exactly the case an audit trail exists to catch.
 */

/** Anything that can run a query — the client or a transaction handle. */
export type AuditWriter = {
  auditEvent: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
};

export type AuditInput = {
  pharmacyId: string;
  actorType: ActorType;
  actorUserId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  /**
   * Prior and resulting state. Keep these to identifiers and changed scalar
   * fields — not whole patient records.
   */
  before?: unknown;
  after?: unknown;
  reason?: string;
  requestId?: string;
  ipAddress?: string;
};

export async function writeAudit(tx: AuditWriter, input: AuditInput): Promise<void> {
  await tx.auditEvent.create({
    data: {
      pharmacyId: input.pharmacyId,
      actorType: input.actorType,
      actorUserId: input.actorUserId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      before: (input.before ?? null) as never,
      after: (input.after ?? null) as never,
      reason: input.reason ?? null,
      requestId: input.requestId ?? null,
      ipAddress: input.ipAddress ?? null,
    },
  });
}

/**
 * Audit a system-initiated action outside any enclosing transaction.
 *
 * Used by sweeps for events with no surrounding write to be atomic with — for
 * example recording that a sweep expired a batch of reminders. Anything tied to
 * a user action must use `writeAudit` inside that action's transaction instead.
 */
export async function writeSystemAudit(
  input: Omit<AuditInput, "actorType" | "actorUserId">,
): Promise<void> {
  await writeAudit(systemPrisma as unknown as AuditWriter, {
    ...input,
    actorType: "SYSTEM" as ActorType,
  });
}

/**
 * Reduced projection for the audit log screen. Patient-identifying detail is
 * resolved by the caller under its own tenant guard rather than joined here.
 */
export const AUDIT_ACTION = {
  PHARMACY_CREATED: "PHARMACY_CREATED",
  PHARMACY_ACCESSED: "PHARMACY_ACCESSED",
  USER_INVITED: "USER_INVITED",
  USER_ROLE_CHANGED: "USER_ROLE_CHANGED",
  USER_SUSPENDED: "USER_SUSPENDED",
  LOGIN_SUCCEEDED: "LOGIN_SUCCEEDED",
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGOUT: "LOGOUT",

  PATIENT_CREATED: "PATIENT_CREATED",
  PATIENT_UPDATED: "PATIENT_UPDATED",
  PATIENT_ARCHIVED: "PATIENT_ARCHIVED",
  CONSENT_RECORDED: "CONSENT_RECORDED",
  CONSENT_REVOKED: "CONSENT_REVOKED",
  PATIENT_OPTED_OUT: "PATIENT_OPTED_OUT",

  MEDICATION_CREATED: "MEDICATION_CREATED",
  MEDICATION_UPDATED: "MEDICATION_UPDATED",
  MEDICATION_DISCONTINUED: "MEDICATION_DISCONTINUED",
  SCHEDULE_CREATED: "SCHEDULE_CREATED",
  SCHEDULE_CHANGED: "SCHEDULE_CHANGED",
  SCHEDULE_PAUSED: "SCHEDULE_PAUSED",
  SCHEDULE_RESUMED: "SCHEDULE_RESUMED",
  SCHEDULE_DISCONTINUED: "SCHEDULE_DISCONTINUED",
  REMINDER_SKIPPED: "REMINDER_SKIPPED",

  RESPONSE_CORRECTED: "RESPONSE_CORRECTED",
  CASE_OPENED: "CASE_OPENED",
  CASE_ASSIGNED: "CASE_ASSIGNED",
  CASE_RESOLVED: "CASE_RESOLVED",
  INTERVENTION_RECORDED: "INTERVENTION_RECORDED",
  REFILL_RECORDED: "REFILL_RECORDED",

  RULE_CHANGED: "RULE_CHANGED",
  ALERT_ACKNOWLEDGED: "ALERT_ACKNOWLEDGED",
  ALERT_RESOLVED: "ALERT_RESOLVED",

  REPORT_EXPORTED: "REPORT_EXPORTED",
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];
