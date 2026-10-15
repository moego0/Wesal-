-- Hard constraints that Prisma's schema DSL cannot express.
--
-- These are load-bearing. Each one enforces an invariant that would otherwise
-- depend on every future contributor remembering to write correct application
-- code. A test in tests/hard-constraints.test.ts asserts they all exist, so a
-- later `prisma migrate dev` that decides to drop an "unknown" index fails CI
-- rather than silently removing the protection.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. At most ONE open alert per dedupe key.
--
-- A partial unique index, not application logic. The read-then-insert pattern
-- races: a rolling redeploy overlapping a cron tick produces two concurrent
-- evaluators that both see "no open alert" and both insert. The pharmacist's
-- queue then shows the same case three times, they stop trusting it, and the
-- product fails at its entire job.
--
-- RESOLVED_* and SUPPRESSED are outside the predicate on purpose, so a resolved
-- condition frees the key (subject to the rule's cooldown) and can reopen.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "alert_one_open_per_key"
  ON "Alert" ("dedupeKey")
  WHERE "status" IN ('OPEN', 'ACKNOWLEDGED');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. A patient-reported response is never "verified".
--
-- The PRD requires that a patient response be stored as patient-reported
-- information and never as independently verified proof of ingestion. The
-- Prisma schema defaults isVerified to false, but a default is a convention —
-- this is a guarantee. A future contributor cannot quietly flip the flag on an
-- inbound path and have it stick.
--
-- A pharmacist correction is modelled as a SEPARATE row with
-- verificationState = PHARMACIST_CORRECTED; it never retroactively promotes the
-- patient's own report.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "PatientResponse"
  ADD CONSTRAINT "patient_response_never_verified"
  CHECK ("source" <> 'PATIENT_REPORTED' OR "isVerified" = false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. AuditEvent is append-only, enforced by trigger rather than by GRANT.
--
-- REVOKE UPDATE, DELETE would be the textbook approach, but the application
-- connects as the table owner (and as a superuser in local dev), and neither
-- can be revoked from itself. A trigger holds regardless of role.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION wasal_audit_event_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'AuditEvent is append-only: % is not permitted (id=%)', TG_OP, COALESCE(OLD."id"::text, '?')
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_event_no_update_delete"
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION wasal_audit_event_immutable();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Numeric sanity on scheduling counters.
--
-- A negative attemptCount would make the "attempt < 2" retry guard silently
-- permit unlimited retries — a slow-motion way to spam a patient.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "ReminderEvent"
  ADD CONSTRAINT "reminder_event_counters_non_negative"
  CHECK ("attemptCount" >= 0 AND "snoozeCount" >= 0 AND "scheduleRevisionSnapshot" >= 1);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. A response window must end after the dose it belongs to.
--
-- responseWindowEndsAtUtc is computed at materialization. A window that closes
-- before the dose opens would settle every reminder as NO_RESPONSE the instant
-- it was created.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "ReminderEvent"
  ADD CONSTRAINT "reminder_event_window_after_dose"
  CHECK ("responseWindowEndsAtUtc" > "doseAtUtc");

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Local time must be a real wall-clock "HH:MM".
--
-- This value is what the pharmacist reads and what day-boundary reporting
-- groups by. A malformed one silently corrupts adherence-by-time-of-day
-- reporting without failing anything.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "ReminderEvent"
  ADD CONSTRAINT "reminder_event_local_time_format"
  CHECK ("doseLocalTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Snooze children must be distinguishable from the dose they serve.
--
-- The dose is the scoring unit; a snooze is only a reminder. A snooze child
-- that counted for adherence would make a patient who snoozed twice look like
-- they had three doses.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "ReminderEvent"
  ADD CONSTRAINT "reminder_event_snooze_is_not_a_dose"
  CHECK ("kind" <> 'SNOOZE' OR "countedForAdherence" = false);
