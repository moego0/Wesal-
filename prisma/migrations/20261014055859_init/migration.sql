-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('AR_EG', 'EN');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'UNSPECIFIED');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'INVITED');

-- CreateEnum
CREATE TYPE "PharmacyRole" AS ENUM ('PHARMACY_ADMIN', 'PHARMACIST', 'ASSISTANT', 'VIEWER');

-- CreateEnum
CREATE TYPE "PatientStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('DATA_PROCESSING', 'WHATSAPP_MESSAGING', 'RESEARCH');

-- CreateEnum
CREATE TYPE "ConsentCaptureMethod" AS ENUM ('PAPER_SIGNED', 'VERBAL_ATTESTED', 'DIGITAL');

-- CreateEnum
CREATE TYPE "MedicationStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'DISCONTINUED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'DISCONTINUED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ScheduleMode" AS ENUM ('FIXED_TIMES_OF_DAY', 'INTERVAL_HOURS', 'PRN');

-- CreateEnum
CREATE TYPE "ScheduleChangeKind" AS ENUM ('CREATED', 'TIMES_CHANGED', 'MODE_CHANGED', 'DAYS_CHANGED', 'PAUSED', 'RESUMED', 'DISCONTINUED', 'COMPLETED', 'END_DATE_CHANGED', 'TZ_CHANGED', 'DOSE_CHANGED');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'EXPIRED', 'CANCELLED', 'SUPERSEDED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ResponseState" AS ENUM ('NONE', 'TAKEN', 'TAKEN_LATE', 'MISSED', 'REMIND_LATER', 'PROBLEM', 'UNATTRIBUTED');

-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('SCHEDULED_DOSE', 'SNOOZE', 'REFILL_PROMPT', 'ADHOC');

-- CreateEnum
CREATE TYPE "ResponseChannel" AS ENUM ('WHATSAPP_BUTTON', 'WHATSAPP_LIST', 'WHATSAPP_TEXT', 'PHARMACIST_ENTRY');

-- CreateEnum
CREATE TYPE "ResponseSource" AS ENUM ('PATIENT_REPORTED');

-- CreateEnum
CREATE TYPE "VerificationState" AS ENUM ('UNVERIFIED', 'PHARMACIST_CONFIRMED', 'PHARMACIST_CORRECTED');

-- CreateEnum
CREATE TYPE "CaseOrigin" AS ENUM ('RULE_ALERT', 'PROBLEM_RESPONSE', 'MANUAL', 'UNSOLICITED_MESSAGE', 'REFILL', 'PATIENT_REQUEST');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_PATIENT', 'RESOLVED', 'CLOSED_NO_ACTION');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "InterventionType" AS ENUM ('PHONE_CALL', 'WHATSAPP_MESSAGE', 'DOSE_CHANGE', 'REFILL_SET', 'PATIENT_EDUCATION', 'REFERRAL', 'NO_ACTION');

-- CreateEnum
CREATE TYPE "InterventionOutcome" AS ENUM ('REACHED', 'NO_ANSWER', 'LEFT_MESSAGE', 'PATIENT_CONFIRMED', 'PATIENT_DENIED', 'UNABLE_TO_CONTACT');

-- CreateEnum
CREATE TYPE "RefillStatus" AS ENUM ('ESTIMATED', 'DUE', 'REQUESTED', 'SCHEDULED', 'DISPENSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED_AUTO', 'RESOLVED_MANUAL', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('ATTEMPTING', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "InboundStatus" AS ENUM ('RECEIVED', 'ROUTED', 'UNROUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'PATIENT', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "MessageIntent" AS ENUM ('STOP', 'PROBLEM', 'REFILL', 'TAKEN', 'MISSED', 'REMIND_LATER', 'OTHER');

-- CreateTable
CREATE TABLE "Pharmacy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
    "defaultLocale" "Locale" NOT NULL DEFAULT 'AR_EG',
    "quietHoursStart" TEXT NOT NULL DEFAULT '21:00',
    "quietHoursEnd" TEXT NOT NULL DEFAULT '07:00',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pharmacy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phoneE164" TEXT,
    "fullName" TEXT NOT NULL,
    "locale" "Locale" NOT NULL DEFAULT 'AR_EG',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "passwordHash" TEXT,
    "passwordAlgo" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PharmacyMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "role" "PharmacyRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PharmacyMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activePharmacyId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessagingChannel" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPhoneNumberId" TEXT NOT NULL,
    "displayPhoneE164" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessagingChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Patient" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "phoneRaw" TEXT,
    "preferredLocale" "Locale" NOT NULL DEFAULT 'AR_EG',
    "timeZone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
    "dateOfBirth" DATE,
    "gender" "Gender",
    "status" "PatientStatus" NOT NULL DEFAULT 'ACTIVE',
    "messagingOptOutAt" TIMESTAMP(3),
    "lastInboundAtUtc" TIMESTAMP(3),
    "lastOutboundAtUtc" TIMESTAMP(3),
    "careNotes" TEXT,
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,

    CONSTRAINT "Patient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "consentType" "ConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "grantedByUserId" TEXT,
    "captureMethod" "ConsentCaptureMethod" NOT NULL,
    "evidenceRef" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationRecord" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "medicationNameText" TEXT NOT NULL,
    "medicationCode" TEXT,
    "dosageForm" TEXT,
    "strengthText" TEXT,
    "doseAmountText" TEXT,
    "instructionsTextAr" TEXT,
    "instructionsTextEn" TEXT,
    "prescriberText" TEXT,
    "indicationText" TEXT,
    "status" "MedicationStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedOn" DATE NOT NULL,
    "discontinuedOn" DATE,
    "discontinueReason" TEXT,
    "isChronic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,

    CONSTRAINT "MedicationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationSchedule" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "medicationId" TEXT NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "mode" "ScheduleMode" NOT NULL,
    "timesOfDay" TEXT[],
    "daysOfWeek" INTEGER[],
    "intervalHours" INTEGER,
    "anchorAtUtc" TIMESTAMP(3),
    "timeZone" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "durationDays" INTEGER,
    "lateWindowMinutes" INTEGER,
    "responseWindowMinutes" INTEGER,
    "lateResponseMinutes" INTEGER NOT NULL DEFAULT 15,
    "snoozeDefaultMinutes" INTEGER NOT NULL DEFAULT 30,
    "maxSnoozesPerDose" INTEGER NOT NULL DEFAULT 2,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "materializedThroughUtc" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MedicationSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationScheduleRevision" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changeKind" "ScheduleChangeKind" NOT NULL,
    "changedByUserId" TEXT NOT NULL,
    "changedAtUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "MedicationScheduleRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderEvent" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "medicationId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "scheduleRevisionSnapshot" INTEGER NOT NULL,
    "kind" "ReminderKind" NOT NULL DEFAULT 'SCHEDULED_DOSE',
    "parentEventId" TEXT,
    "doseAtUtc" TIMESTAMP(3) NOT NULL,
    "doseLocalDate" DATE NOT NULL,
    "doseLocalTime" TEXT NOT NULL,
    "dstAdjusted" BOOLEAN NOT NULL DEFAULT false,
    "responseWindowEndsAtUtc" TIMESTAMP(3) NOT NULL,
    "deliveryState" "DeliveryState" NOT NULL DEFAULT 'SCHEDULED',
    "responseState" "ResponseState" NOT NULL DEFAULT 'NONE',
    "activeDispatchId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAtUtc" TIMESTAMP(3),
    "firstSentAtUtc" TIMESTAMP(3),
    "settledAtUtc" TIMESTAMP(3),
    "lateReopen" BOOLEAN NOT NULL DEFAULT false,
    "countedForAdherence" BOOLEAN NOT NULL DEFAULT true,
    "ruleEligible" BOOLEAN NOT NULL DEFAULT true,
    "staleFlag" BOOLEAN NOT NULL DEFAULT false,
    "snoozeCount" INTEGER NOT NULL DEFAULT 0,
    "cancelReason" TEXT,
    "supersededByScheduleRevision" INTEGER,
    "skipReason" TEXT,
    "materializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderDispatch" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "reminderEventId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "providerTemplateName" TEXT,
    "toPhoneE164" TEXT NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'ATTEMPTING',
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "errorRetryable" BOOLEAN,
    "acceptedAtUtc" TIMESTAMP(3),
    "deliveredAtUtc" TIMESTAMP(3),
    "readAtUtc" TIMESTAMP(3),
    "failedAtUtc" TIMESTAMP(3),
    "reconcileDeadlineUtc" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReminderDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundMessage" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT,
    "providerMessageId" TEXT NOT NULL,
    "fromPhoneE164" TEXT NOT NULL,
    "toPhoneE164" TEXT NOT NULL,
    "channelId" TEXT,
    "type" TEXT NOT NULL,
    "contextMessageId" TEXT,
    "rawPayload" JSONB NOT NULL,
    "receivedAtUtc" TIMESTAMP(3) NOT NULL,
    "processedAtUtc" TIMESTAMP(3),
    "processingStatus" "InboundStatus" NOT NULL DEFAULT 'RECEIVED',
    "processingError" TEXT,
    "routedPatientId" TEXT,
    "routedEventId" TEXT,

    CONSTRAINT "InboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientResponse" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "reminderEventId" TEXT,
    "inboundMessageId" TEXT,
    "rawMessageId" TEXT,
    "channel" "ResponseChannel" NOT NULL,
    "answer" "ResponseState",
    "freeText" TEXT,
    "intentClassified" "MessageIntent",
    "source" "ResponseSource" NOT NULL DEFAULT 'PATIENT_REPORTED',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verificationState" "VerificationState" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedByUserId" TEXT,
    "verifiedAtUtc" TIMESTAMP(3),
    "applied" BOOLEAN NOT NULL DEFAULT true,
    "appliedToAdherence" BOOLEAN NOT NULL DEFAULT true,
    "ruleEligible" BOOLEAN NOT NULL DEFAULT true,
    "staleFlag" BOOLEAN NOT NULL DEFAULT false,
    "supersedesResponseId" TEXT,
    "patientClaimedAtUtc" TIMESTAMP(3),
    "receivedAtUtc" TIMESTAMP(3) NOT NULL,
    "recordedAtUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientMessage" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "inboundMessageId" TEXT,
    "intent" "MessageIntent",
    "bodyText" TEXT,
    "mediaType" TEXT,
    "mediaRef" TEXT,
    "handledByUserId" TEXT,
    "handledAtUtc" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpCase" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "medicationId" TEXT,
    "openedByAlertId" TEXT,
    "openedByUserId" TEXT,
    "origin" "CaseOrigin" NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'NORMAL',
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "titleAr" TEXT,
    "titleEn" TEXT,
    "summary" TEXT,
    "assigneeUserId" TEXT,
    "openedAtUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueByUtc" TIMESTAMP(3),
    "firstActionAtUtc" TIMESTAMP(3),
    "resolvedAtUtc" TIMESTAMP(3),
    "resolutionCode" TEXT,
    "resolutionNotes" TEXT,
    "tags" TEXT[],

    CONSTRAINT "FollowUpCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PharmacistIntervention" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "caseId" TEXT,
    "patientId" TEXT NOT NULL,
    "medicationId" TEXT,
    "interventionType" "InterventionType" NOT NULL,
    "outcome" "InterventionOutcome" NOT NULL,
    "notes" TEXT,
    "performedByUserId" TEXT NOT NULL,
    "performedAtUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationSeconds" INTEGER,

    CONSTRAINT "PharmacistIntervention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefillRecord" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "medicationId" TEXT NOT NULL,
    "status" "RefillStatus" NOT NULL DEFAULT 'ESTIMATED',
    "lastDispensedOn" DATE,
    "daysSupply" INTEGER,
    "unitsDispensed" DECIMAL(12,3),
    "expectedRunOutOn" DATE,
    "refillDueOn" DATE,
    "refillLeadDays" INTEGER NOT NULL DEFAULT 5,
    "requestedAtUtc" TIMESTAMP(3),
    "remindedAtUtc" TIMESTAMP(3),
    "dispensedAtUtc" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "RefillRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleDefinition" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT,
    "ruleKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "descriptionAr" TEXT NOT NULL,
    "descriptionEn" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "severity" "Severity" NOT NULL,
    "params" JSONB NOT NULL,
    "scope" JSONB NOT NULL,
    "triggerType" TEXT NOT NULL,
    "cronExpression" TEXT,
    "compiledCondition" JSONB NOT NULL,
    "dedupeKeyTemplate" TEXT NOT NULL,
    "cooldownHours" INTEGER NOT NULL DEFAULT 24,
    "autoResolveRuleKey" TEXT,
    "actions" JSONB NOT NULL,
    "isSystemDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuleDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "medicationId" TEXT,
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "titleAr" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "detailAr" TEXT NOT NULL,
    "detailEn" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "openedAtUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAtUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "suppressUntilUtc" TIMESTAMP(3),
    "resolvedAtUtc" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolutionNote" TEXT,
    "caseId" TEXT,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "atUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "meta" JSONB,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppTemplate" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT,
    "providerName" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'UNKNOWN',
    "components" JSONB NOT NULL,
    "variablesSchema" JSONB NOT NULL,
    "lastSyncedAtUtc" TIMESTAMP(3),

    CONSTRAINT "WhatsAppTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "pharmacyId" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorUserId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "requestId" TEXT,
    "ipAddress" TEXT,
    "occurredAtUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "pharmacyId" TEXT,
    "topic" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAtUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAtUtc" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SweepHeartbeat" (
    "id" TEXT NOT NULL,
    "sweepName" TEXT NOT NULL,
    "lastRunAtUtc" TIMESTAMP(3) NOT NULL,
    "lastDurationMs" INTEGER NOT NULL,
    "hostId" TEXT NOT NULL,
    "lastError" TEXT,

    CONSTRAINT "SweepHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "PharmacyMembership_pharmacyId_role_active_idx" ON "PharmacyMembership"("pharmacyId", "role", "active");

-- CreateIndex
CREATE UNIQUE INDEX "PharmacyMembership_userId_pharmacyId_key" ON "PharmacyMembership"("userId", "pharmacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_expiresAt_idx" ON "Session"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessagingChannel_providerPhoneNumberId_key" ON "MessagingChannel"("providerPhoneNumberId");

-- CreateIndex
CREATE INDEX "MessagingChannel_pharmacyId_idx" ON "MessagingChannel"("pharmacyId");

-- CreateIndex
CREATE INDEX "Patient_pharmacyId_phoneE164_idx" ON "Patient"("pharmacyId", "phoneE164");

-- CreateIndex
CREATE INDEX "Patient_pharmacyId_status_idx" ON "Patient"("pharmacyId", "status");

-- CreateIndex
CREATE INDEX "Patient_status_timeZone_idx" ON "Patient"("status", "timeZone");

-- CreateIndex
CREATE INDEX "ConsentRecord_patientId_consentType_grantedAt_idx" ON "ConsentRecord"("patientId", "consentType", "grantedAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_pharmacyId_consentType_granted_idx" ON "ConsentRecord"("pharmacyId", "consentType", "granted");

-- CreateIndex
CREATE INDEX "MedicationRecord_pharmacyId_patientId_status_idx" ON "MedicationRecord"("pharmacyId", "patientId", "status");

-- CreateIndex
CREATE INDEX "MedicationRecord_patientId_status_idx" ON "MedicationRecord"("patientId", "status");

-- CreateIndex
CREATE INDEX "MedicationSchedule_pharmacyId_status_idx" ON "MedicationSchedule"("pharmacyId", "status");

-- CreateIndex
CREATE INDEX "MedicationSchedule_status_materializedThroughUtc_idx" ON "MedicationSchedule"("status", "materializedThroughUtc");

-- CreateIndex
CREATE INDEX "MedicationSchedule_patientId_status_idx" ON "MedicationSchedule"("patientId", "status");

-- CreateIndex
CREATE INDEX "MedicationScheduleRevision_scheduleId_changedAtUtc_idx" ON "MedicationScheduleRevision"("scheduleId", "changedAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "MedicationScheduleRevision_scheduleId_revision_key" ON "MedicationScheduleRevision"("scheduleId", "revision");

-- CreateIndex
CREATE INDEX "ReminderEvent_deliveryState_doseAtUtc_idx" ON "ReminderEvent"("deliveryState", "doseAtUtc");

-- CreateIndex
CREATE INDEX "ReminderEvent_deliveryState_updatedAt_idx" ON "ReminderEvent"("deliveryState", "updatedAt");

-- CreateIndex
CREATE INDEX "ReminderEvent_responseState_responseWindowEndsAtUtc_idx" ON "ReminderEvent"("responseState", "responseWindowEndsAtUtc");

-- CreateIndex
CREATE INDEX "ReminderEvent_pharmacyId_doseAtUtc_idx" ON "ReminderEvent"("pharmacyId", "doseAtUtc");

-- CreateIndex
CREATE INDEX "ReminderEvent_patientId_doseAtUtc_idx" ON "ReminderEvent"("patientId", "doseAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderEvent_scheduleId_doseAtUtc_key" ON "ReminderEvent"("scheduleId", "doseAtUtc");

-- CreateIndex
CREATE INDEX "ReminderDispatch_status_reconcileDeadlineUtc_idx" ON "ReminderDispatch"("status", "reconcileDeadlineUtc");

-- CreateIndex
CREATE INDEX "ReminderDispatch_providerMessageId_idx" ON "ReminderDispatch"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderDispatch_reminderEventId_attemptNo_key" ON "ReminderDispatch"("reminderEventId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMessage_providerMessageId_key" ON "InboundMessage"("providerMessageId");

-- CreateIndex
CREATE INDEX "InboundMessage_fromPhoneE164_receivedAtUtc_idx" ON "InboundMessage"("fromPhoneE164", "receivedAtUtc");

-- CreateIndex
CREATE INDEX "InboundMessage_processingStatus_receivedAtUtc_idx" ON "InboundMessage"("processingStatus", "receivedAtUtc");

-- CreateIndex
CREATE INDEX "InboundMessage_contextMessageId_idx" ON "InboundMessage"("contextMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "PatientResponse_rawMessageId_key" ON "PatientResponse"("rawMessageId");

-- CreateIndex
CREATE INDEX "PatientResponse_reminderEventId_idx" ON "PatientResponse"("reminderEventId");

-- CreateIndex
CREATE INDEX "PatientResponse_patientId_receivedAtUtc_idx" ON "PatientResponse"("patientId", "receivedAtUtc");

-- CreateIndex
CREATE INDEX "PatientResponse_pharmacyId_applied_receivedAtUtc_idx" ON "PatientResponse"("pharmacyId", "applied", "receivedAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "PatientMessage_inboundMessageId_key" ON "PatientMessage"("inboundMessageId");

-- CreateIndex
CREATE INDEX "PatientMessage_pharmacyId_handledAtUtc_idx" ON "PatientMessage"("pharmacyId", "handledAtUtc");

-- CreateIndex
CREATE INDEX "PatientMessage_patientId_createdAt_idx" ON "PatientMessage"("patientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpCase_openedByAlertId_key" ON "FollowUpCase"("openedByAlertId");

-- CreateIndex
CREATE INDEX "FollowUpCase_pharmacyId_status_priority_openedAtUtc_idx" ON "FollowUpCase"("pharmacyId", "status", "priority", "openedAtUtc");

-- CreateIndex
CREATE INDEX "FollowUpCase_assigneeUserId_status_idx" ON "FollowUpCase"("assigneeUserId", "status");

-- CreateIndex
CREATE INDEX "FollowUpCase_patientId_status_idx" ON "FollowUpCase"("patientId", "status");

-- CreateIndex
CREATE INDEX "PharmacistIntervention_patientId_performedAtUtc_idx" ON "PharmacistIntervention"("patientId", "performedAtUtc");

-- CreateIndex
CREATE INDEX "PharmacistIntervention_caseId_idx" ON "PharmacistIntervention"("caseId");

-- CreateIndex
CREATE INDEX "PharmacistIntervention_pharmacyId_performedAtUtc_idx" ON "PharmacistIntervention"("pharmacyId", "performedAtUtc");

-- CreateIndex
CREATE INDEX "RefillRecord_pharmacyId_status_refillDueOn_idx" ON "RefillRecord"("pharmacyId", "status", "refillDueOn");

-- CreateIndex
CREATE INDEX "RefillRecord_patientId_medicationId_idx" ON "RefillRecord"("patientId", "medicationId");

-- CreateIndex
CREATE INDEX "RuleDefinition_pharmacyId_enabled_idx" ON "RuleDefinition"("pharmacyId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "RuleDefinition_pharmacyId_ruleKey_version_key" ON "RuleDefinition"("pharmacyId", "ruleKey", "version");

-- CreateIndex
CREATE INDEX "Alert_pharmacyId_status_severity_openedAtUtc_idx" ON "Alert"("pharmacyId", "status", "severity", "openedAtUtc");

-- CreateIndex
CREATE INDEX "Alert_patientId_openedAtUtc_idx" ON "Alert"("patientId", "openedAtUtc");

-- CreateIndex
CREATE INDEX "Alert_caseId_idx" ON "Alert"("caseId");

-- CreateIndex
CREATE INDEX "AlertEvent_alertId_atUtc_idx" ON "AlertEvent"("alertId", "atUtc");

-- CreateIndex
CREATE INDEX "WhatsAppTemplate_pharmacyId_status_idx" ON "WhatsAppTemplate"("pharmacyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTemplate_providerName_languageCode_key" ON "WhatsAppTemplate"("providerName", "languageCode");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_occurredAtUtc_idx" ON "AuditEvent"("entityType", "entityId", "occurredAtUtc");

-- CreateIndex
CREATE INDEX "AuditEvent_pharmacyId_occurredAtUtc_idx" ON "AuditEvent"("pharmacyId", "occurredAtUtc");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_occurredAtUtc_idx" ON "AuditEvent"("actorUserId", "occurredAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_dedupeKey_key" ON "OutboxEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAtUtc_idx" ON "OutboxEvent"("status", "availableAtUtc");

-- CreateIndex
CREATE UNIQUE INDEX "SweepHeartbeat_sweepName_key" ON "SweepHeartbeat"("sweepName");

-- AddForeignKey
ALTER TABLE "PharmacyMembership" ADD CONSTRAINT "PharmacyMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacyMembership" ADD CONSTRAINT "PharmacyMembership_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "Pharmacy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingChannel" ADD CONSTRAINT "MessagingChannel_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "Pharmacy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Patient" ADD CONSTRAINT "Patient_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "Pharmacy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationRecord" ADD CONSTRAINT "MedicationRecord_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationSchedule" ADD CONSTRAINT "MedicationSchedule_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationSchedule" ADD CONSTRAINT "MedicationSchedule_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "MedicationRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationScheduleRevision" ADD CONSTRAINT "MedicationScheduleRevision_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "MedicationSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderEvent" ADD CONSTRAINT "ReminderEvent_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderEvent" ADD CONSTRAINT "ReminderEvent_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "MedicationRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderEvent" ADD CONSTRAINT "ReminderEvent_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "MedicationSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderEvent" ADD CONSTRAINT "ReminderEvent_parentEventId_fkey" FOREIGN KEY ("parentEventId") REFERENCES "ReminderEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderDispatch" ADD CONSTRAINT "ReminderDispatch_reminderEventId_fkey" FOREIGN KEY ("reminderEventId") REFERENCES "ReminderEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientResponse" ADD CONSTRAINT "PatientResponse_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientResponse" ADD CONSTRAINT "PatientResponse_reminderEventId_fkey" FOREIGN KEY ("reminderEventId") REFERENCES "ReminderEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientResponse" ADD CONSTRAINT "PatientResponse_inboundMessageId_fkey" FOREIGN KEY ("inboundMessageId") REFERENCES "InboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientMessage" ADD CONSTRAINT "PatientMessage_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpCase" ADD CONSTRAINT "FollowUpCase_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpCase" ADD CONSTRAINT "FollowUpCase_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "MedicationRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacistIntervention" ADD CONSTRAINT "PharmacistIntervention_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "FollowUpCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacistIntervention" ADD CONSTRAINT "PharmacistIntervention_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PharmacistIntervention" ADD CONSTRAINT "PharmacistIntervention_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "MedicationRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefillRecord" ADD CONSTRAINT "RefillRecord_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefillRecord" ADD CONSTRAINT "RefillRecord_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "MedicationRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleDefinition" ADD CONSTRAINT "RuleDefinition_pharmacyId_fkey" FOREIGN KEY ("pharmacyId") REFERENCES "Pharmacy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "FollowUpCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;
