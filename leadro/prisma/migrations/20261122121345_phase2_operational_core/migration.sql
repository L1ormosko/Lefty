-- Phase 2 operational core: customers, leads, jobs, qualifications, dispatch recommendations, notifications.
-- Generated part first (tables, enums, indexes, composite FKs), hand-written RLS/constraints at the end.

-- Trigram indexes for fuzzy name search (pg_trgm is a trusted extension; the app role may create it).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "ContactChannel" AS ENUM ('PHONE', 'SMS', 'EMAIL', 'IN_PERSON', 'CHAT', 'OTHER');

-- CreateEnum
CREATE TYPE "CustomerKind" AS ENUM ('INDIVIDUAL', 'BUSINESS');

-- CreateEnum
CREATE TYPE "LeadSourceType" AS ENUM ('MANUAL', 'PHONE', 'WEBSITE', 'MARKETING_CAMPAIGN', 'EXTERNAL_CRM', 'API', 'IMPORT', 'INTEGRATION');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'UNASSIGNED', 'ASSIGNED', 'CONTACT_ATTEMPTED', 'CONTACTED', 'QUALIFIED', 'SCHEDULED', 'DISPATCHED', 'CONVERTED', 'LOST', 'DUPLICATE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "AssignmentState" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "InteractionKind" AS ENUM ('CONTACT_ATTEMPT', 'NOTE', 'CUSTOMER_MESSAGE', 'FOLLOW_UP');

-- CreateEnum
CREATE TYPE "InteractionDirection" AS ENUM ('OUTBOUND', 'INBOUND', 'INTERNAL');

-- CreateEnum
CREATE TYPE "ContactOutcome" AS ENUM ('REACHED', 'NO_ANSWER', 'VOICEMAIL', 'BUSY', 'WRONG_NUMBER', 'CALLBACK_REQUESTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "DuplicateKind" AS ENUM ('LEAD_LEAD', 'CUSTOMER_CUSTOMER', 'LEAD_CUSTOMER');

-- CreateEnum
CREATE TYPE "DuplicateMatchField" AS ENUM ('PHONE', 'EMAIL', 'ADDRESS', 'NAME', 'EXTERNAL_ID', 'RECENT_HISTORY');

-- CreateEnum
CREATE TYPE "DuplicateStatus" AS ENUM ('OPEN', 'NOT_DUPLICATE', 'CONFIRMED_DUPLICATE');

-- CreateEnum
CREATE TYPE "JobOrigin" AS ENUM ('LEAD_CONVERSION', 'RECURRING_AGREEMENT', 'MANUAL', 'INTEGRATION', 'CUSTOMER_FOLLOW_UP');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('CREATED', 'PENDING_ASSIGNMENT', 'ASSIGNED', 'SCHEDULED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'AWAITING_REVIEW', 'CLOSED', 'CANCELLED', 'CUSTOMER_UNAVAILABLE', 'RESCHEDULED', 'FAILED', 'ON_HOLD', 'REQUIRES_RETURN_VISIT');

-- CreateEnum
CREATE TYPE "JobAssignmentRole" AS ENUM ('LEAD', 'CREW');

-- CreateEnum
CREATE TYPE "AssignmentMethod" AS ENUM ('MANUAL', 'RECOMMENDATION_APPROVED', 'RECOMMENDATION_MODIFIED', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "RequirementSource" AS ENUM ('JOB_TYPE', 'MANUAL');

-- CreateEnum
CREATE TYPE "QualificationKind" AS ENUM ('SKILL', 'CERTIFICATION', 'LICENSE', 'EQUIPMENT');

-- CreateEnum
CREATE TYPE "QualificationStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AvailabilityKind" AS ENUM ('WEEKLY_WINDOW', 'EXCEPTION_AVAILABLE', 'EXCEPTION_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "DispatchMode" AS ENUM ('MANUAL', 'AI_ASSISTED', 'RULE_BASED_AUTO', 'OPTIMIZATION');

-- CreateEnum
CREATE TYPE "DispatchRecommendationStatus" AS ENUM ('PENDING', 'APPROVED', 'MODIFIED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'PUSH', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'NOT_CONFIGURED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RetryStatus" AS ENUM ('NONE', 'SCHEDULED', 'EXHAUSTED');

-- CreateTable
CREATE TABLE "NumberSequence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationsSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "dispatchMode" "DispatchMode" NOT NULL DEFAULT 'AI_ASSISTED',
    "disabledLeadTransitions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disabledJobTransitions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "duplicateMatchers" JSONB,
    "enabledChannels" "NotificationChannel"[] DEFAULT ARRAY['IN_APP']::"NotificationChannel"[],
    "contactAttemptOpenMinutes" INTEGER NOT NULL DEFAULT 30,
    "qualificationWarningDays" INTEGER NOT NULL DEFAULT 30,
    "defaultCurrency" CHAR(3) NOT NULL DEFAULT 'USD',
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "OperationsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "CustomerKind" NOT NULL DEFAULT 'INDIVIDUAL',
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "phoneE164" TEXT,
    "preferredLocale" TEXT,
    "preferredContactChannel" "ContactChannel",
    "contactPreferences" JSONB,
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "orgUnitId" TEXT,
    "billingName" TEXT,
    "billingEmail" TEXT,
    "billingAddress" JSONB,
    "taxId" TEXT,
    "paymentTerms" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAddress" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL DEFAULT 'US',
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "coordinateSource" TEXT,
    "normalizedKey" TEXT NOT NULL,
    "accessInstructions" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "orgUnitId" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LeadSourceType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeadSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" "WorkPriority" NOT NULL DEFAULT 'NORMAL',
    "sourceId" TEXT,
    "campaign" TEXT,
    "externalId" TEXT,
    "customerId" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "contactPhoneE164" TEXT,
    "contactEmail" TEXT,
    "customerAddressId" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "addressCity" TEXT,
    "addressRegion" TEXT,
    "addressPostalCode" TEXT,
    "addressNormalizedKey" TEXT,
    "jobTypeId" TEXT,
    "serviceCategory" TEXT,
    "requestedWork" TEXT,
    "preferredWindowStart" TIMESTAMPTZ(3),
    "preferredWindowEnd" TIMESTAMPTZ(3),
    "preferredTimeNote" TEXT,
    "notes" TEXT,
    "quotedAmountMinor" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "orgUnitId" TEXT,
    "nextFollowUpAt" TIMESTAMPTZ(3),
    "duplicateOfLeadId" TEXT,
    "closedReason" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "state" "AssignmentState" NOT NULL DEFAULT 'ACTIVE',
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,
    "reason" TEXT,
    "conflictConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "endedAt" TIMESTAMPTZ(3),
    "endedReason" TEXT,

    CONSTRAINT "LeadAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadStatusHistory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "fromStatus" "LeadStatus",
    "toStatus" "LeadStatus" NOT NULL,
    "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
    "actorUserId" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadInteraction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "kind" "InteractionKind" NOT NULL,
    "direction" "InteractionDirection" NOT NULL DEFAULT 'OUTBOUND',
    "channel" "ContactChannel",
    "outcome" "ContactOutcome",
    "body" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "durationSeconds" INTEGER,
    "followUpAt" TIMESTAMPTZ(3),
    "authorId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DuplicateFlag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "DuplicateKind" NOT NULL,
    "pairKey" TEXT NOT NULL,
    "leadId" TEXT,
    "otherLeadId" TEXT,
    "customerId" TEXT,
    "otherCustomerId" TEXT,
    "matchedOn" "DuplicateMatchField"[],
    "reason" TEXT,
    "status" "DuplicateStatus" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "DuplicateFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "QualificationKind" NOT NULL DEFAULT 'CERTIFICATION',
    "issuingAuthority" TEXT,
    "validityMonths" INTEGER,
    "requiresNumber" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Certification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeQualification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "QualificationKind" NOT NULL,
    "skillId" TEXT,
    "certificationId" TEXT,
    "level" INTEGER,
    "number" TEXT,
    "issuingAuthority" TEXT,
    "issuedAt" DATE,
    "expiresAt" DATE,
    "status" "QualificationStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmployeeQualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceTerritory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "includeDescendants" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceTerritory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Availability" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "AvailabilityKind" NOT NULL,
    "timeZone" TEXT NOT NULL,
    "isoDayOfWeek" INTEGER,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "validFrom" DATE,
    "validTo" DATE,
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobType" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "defaultDurationMinutes" INTEGER NOT NULL,
    "defaultPriority" "WorkPriority" NOT NULL DEFAULT 'NORMAL',
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "requiredEquipment" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "completionFormSchema" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JobType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobTypeSkill" (
    "tenantId" TEXT NOT NULL,
    "jobTypeId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "minLevel" INTEGER,

    CONSTRAINT "JobTypeSkill_pkey" PRIMARY KEY ("jobTypeId","skillId")
);

-- CreateTable
CREATE TABLE "JobTypeCertification" (
    "tenantId" TEXT NOT NULL,
    "jobTypeId" TEXT NOT NULL,
    "certificationId" TEXT NOT NULL,

    CONSTRAINT "JobTypeCertification_pkey" PRIMARY KEY ("jobTypeId","certificationId")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" TEXT NOT NULL,
    "serviceAddressId" TEXT NOT NULL,
    "jobTypeId" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "leadId" TEXT,
    "parentJobId" TEXT,
    "origin" "JobOrigin" NOT NULL DEFAULT 'MANUAL',
    "status" "JobStatus" NOT NULL DEFAULT 'CREATED',
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" "WorkPriority" NOT NULL DEFAULT 'NORMAL',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "appointmentWindowStart" TIMESTAMPTZ(3),
    "appointmentWindowEnd" TIMESTAMPTZ(3),
    "scheduledStartAt" TIMESTAMPTZ(3),
    "scheduledEndAt" TIMESTAMPTZ(3),
    "timeZone" TEXT,
    "estimatedDurationMinutes" INTEGER NOT NULL,
    "quotedAmountMinor" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "statusReason" TEXT,
    "archivedAt" TIMESTAMPTZ(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRequirement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "skillId" TEXT,
    "certificationId" TEXT,
    "minLevel" INTEGER,
    "source" "RequirementSource" NOT NULL DEFAULT 'JOB_TYPE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "employeeId" TEXT,
    "teamOrgUnitId" TEXT,
    "role" "JobAssignmentRole" NOT NULL DEFAULT 'LEAD',
    "state" "AssignmentState" NOT NULL DEFAULT 'ACTIVE',
    "method" "AssignmentMethod" NOT NULL DEFAULT 'MANUAL',
    "overrideReason" TEXT,
    "recommendationId" TEXT,
    "assignedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,
    "reason" TEXT,
    "endedAt" TIMESTAMPTZ(3),
    "endedReason" TEXT,

    CONSTRAINT "JobAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobStatusHistory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "fromStatus" "JobStatus",
    "toStatus" "JobStatus" NOT NULL,
    "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
    "actorUserId" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
    "actorUserId" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientEventId" TEXT,
    "payload" JSONB,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DispatchRecommendation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "mode" "DispatchMode" NOT NULL,
    "status" "DispatchRecommendationStatus" NOT NULL DEFAULT 'PENDING',
    "candidates" JSONB NOT NULL,
    "blockingReasons" JSONB,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedById" TEXT,
    "chosenEmployeeId" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" TEXT,
    "decisionReason" TEXT,

    CONSTRAINT "DispatchRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "params" JSONB,
    "targetType" TEXT,
    "targetId" TEXT,
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "providerResponse" JSONB,
    "failureReason" TEXT,
    "retryStatus" "RetryStatus" NOT NULL DEFAULT 'NONE',
    "nextRetryAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptedAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NumberSequence_id_tenantId_key" ON "NumberSequence"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "NumberSequence_tenantId_name_key" ON "NumberSequence"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "OperationsSettings_id_tenantId_key" ON "OperationsSettings"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "OperationsSettings_tenantId_key" ON "OperationsSettings"("tenantId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_archivedAt_createdAt_idx" ON "Customer"("tenantId", "archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Customer_tenantId_phoneE164_idx" ON "Customer"("tenantId", "phoneE164");

-- CreateIndex
CREATE INDEX "Customer_tenantId_email_idx" ON "Customer"("tenantId", "email");

-- CreateIndex
CREATE INDEX "Customer_tenantId_orgUnitId_idx" ON "Customer"("tenantId", "orgUnitId");

-- CreateIndex
CREATE INDEX "Customer_name_trgm_idx" ON "Customer" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_id_tenantId_key" ON "Customer"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_tenantId_number_key" ON "Customer"("tenantId", "number");

-- CreateIndex
CREATE INDEX "CustomerAddress_tenantId_customerId_idx" ON "CustomerAddress"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "CustomerAddress_tenantId_normalizedKey_idx" ON "CustomerAddress"("tenantId", "normalizedKey");

-- CreateIndex
CREATE INDEX "CustomerAddress_tenantId_orgUnitId_idx" ON "CustomerAddress"("tenantId", "orgUnitId");

-- CreateIndex
CREATE INDEX "CustomerAddress_tenantId_postalCode_idx" ON "CustomerAddress"("tenantId", "postalCode");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAddress_id_tenantId_key" ON "CustomerAddress"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAddress_id_customerId_tenantId_key" ON "CustomerAddress"("id", "customerId", "tenantId");

-- CreateIndex
CREATE INDEX "CustomerNote_tenantId_customerId_createdAt_idx" ON "CustomerNote"("tenantId", "customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerNote_id_tenantId_key" ON "CustomerNote"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSource_id_tenantId_key" ON "LeadSource"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSource_tenantId_code_key" ON "LeadSource"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Lead_tenantId_status_createdAt_idx" ON "Lead"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_tenantId_status_nextFollowUpAt_idx" ON "Lead"("tenantId", "status", "nextFollowUpAt");

-- CreateIndex
CREATE INDEX "Lead_tenantId_orgUnitId_status_idx" ON "Lead"("tenantId", "orgUnitId", "status");

-- CreateIndex
CREATE INDEX "Lead_tenantId_priority_status_idx" ON "Lead"("tenantId", "priority", "status");

-- CreateIndex
CREATE INDEX "Lead_tenantId_customerId_idx" ON "Lead"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "Lead_tenantId_sourceId_createdAt_idx" ON "Lead"("tenantId", "sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_tenantId_contactPhoneE164_idx" ON "Lead"("tenantId", "contactPhoneE164");

-- CreateIndex
CREATE INDEX "Lead_tenantId_contactEmail_idx" ON "Lead"("tenantId", "contactEmail");

-- CreateIndex
CREATE INDEX "Lead_tenantId_addressNormalizedKey_idx" ON "Lead"("tenantId", "addressNormalizedKey");

-- CreateIndex
CREATE INDEX "Lead_tenantId_archivedAt_createdAt_idx" ON "Lead"("tenantId", "archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_contactName_trgm_idx" ON "Lead" USING GIN ("contactName" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_id_tenantId_key" ON "Lead"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_tenantId_number_key" ON "Lead"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_tenantId_sourceId_externalId_key" ON "Lead"("tenantId", "sourceId", "externalId");

-- CreateIndex
CREATE INDEX "LeadAssignment_tenantId_employeeId_state_idx" ON "LeadAssignment"("tenantId", "employeeId", "state");

-- CreateIndex
CREATE INDEX "LeadAssignment_tenantId_leadId_state_idx" ON "LeadAssignment"("tenantId", "leadId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "LeadAssignment_id_tenantId_key" ON "LeadAssignment"("id", "tenantId");

-- CreateIndex
CREATE INDEX "LeadStatusHistory_tenantId_leadId_occurredAt_idx" ON "LeadStatusHistory"("tenantId", "leadId", "occurredAt");

-- CreateIndex
CREATE INDEX "LeadStatusHistory_tenantId_toStatus_occurredAt_idx" ON "LeadStatusHistory"("tenantId", "toStatus", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadStatusHistory_id_tenantId_key" ON "LeadStatusHistory"("id", "tenantId");

-- CreateIndex
CREATE INDEX "LeadInteraction_tenantId_leadId_occurredAt_idx" ON "LeadInteraction"("tenantId", "leadId", "occurredAt");

-- CreateIndex
CREATE INDEX "LeadInteraction_tenantId_kind_closedAt_occurredAt_idx" ON "LeadInteraction"("tenantId", "kind", "closedAt", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadInteraction_id_tenantId_key" ON "LeadInteraction"("id", "tenantId");

-- CreateIndex
CREATE INDEX "DuplicateFlag_tenantId_status_detectedAt_idx" ON "DuplicateFlag"("tenantId", "status", "detectedAt");

-- CreateIndex
CREATE INDEX "DuplicateFlag_tenantId_leadId_status_idx" ON "DuplicateFlag"("tenantId", "leadId", "status");

-- CreateIndex
CREATE INDEX "DuplicateFlag_tenantId_otherLeadId_idx" ON "DuplicateFlag"("tenantId", "otherLeadId");

-- CreateIndex
CREATE INDEX "DuplicateFlag_tenantId_customerId_status_idx" ON "DuplicateFlag"("tenantId", "customerId", "status");

-- CreateIndex
CREATE INDEX "DuplicateFlag_tenantId_otherCustomerId_idx" ON "DuplicateFlag"("tenantId", "otherCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateFlag_id_tenantId_key" ON "DuplicateFlag"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DuplicateFlag_tenantId_pairKey_key" ON "DuplicateFlag"("tenantId", "pairKey");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_id_tenantId_key" ON "Skill"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_tenantId_code_key" ON "Skill"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Certification_tenantId_type_idx" ON "Certification"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Certification_id_tenantId_key" ON "Certification"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Certification_tenantId_code_key" ON "Certification"("tenantId", "code");

-- CreateIndex
CREATE INDEX "EmployeeQualification_tenantId_employeeId_status_idx" ON "EmployeeQualification"("tenantId", "employeeId", "status");

-- CreateIndex
CREATE INDEX "EmployeeQualification_tenantId_skillId_idx" ON "EmployeeQualification"("tenantId", "skillId");

-- CreateIndex
CREATE INDEX "EmployeeQualification_tenantId_certificationId_idx" ON "EmployeeQualification"("tenantId", "certificationId");

-- CreateIndex
CREATE INDEX "EmployeeQualification_tenantId_expiresAt_idx" ON "EmployeeQualification"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeQualification_id_tenantId_key" ON "EmployeeQualification"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeQualification_tenantId_employeeId_skillId_key" ON "EmployeeQualification"("tenantId", "employeeId", "skillId");

-- CreateIndex
CREATE INDEX "ServiceTerritory_tenantId_orgUnitId_idx" ON "ServiceTerritory"("tenantId", "orgUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceTerritory_id_tenantId_key" ON "ServiceTerritory"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceTerritory_tenantId_employeeId_orgUnitId_key" ON "ServiceTerritory"("tenantId", "employeeId", "orgUnitId");

-- CreateIndex
CREATE INDEX "Availability_tenantId_employeeId_kind_isoDayOfWeek_idx" ON "Availability"("tenantId", "employeeId", "kind", "isoDayOfWeek");

-- CreateIndex
CREATE INDEX "Availability_tenantId_employeeId_startsAt_endsAt_idx" ON "Availability"("tenantId", "employeeId", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Availability_id_tenantId_key" ON "Availability"("id", "tenantId");

-- CreateIndex
CREATE INDEX "JobType_tenantId_category_idx" ON "JobType"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "JobType_id_tenantId_key" ON "JobType"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobType_tenantId_code_key" ON "JobType"("tenantId", "code");

-- CreateIndex
CREATE INDEX "JobTypeSkill_tenantId_skillId_idx" ON "JobTypeSkill"("tenantId", "skillId");

-- CreateIndex
CREATE INDEX "JobTypeCertification_tenantId_certificationId_idx" ON "JobTypeCertification"("tenantId", "certificationId");

-- CreateIndex
CREATE INDEX "Job_tenantId_status_scheduledStartAt_idx" ON "Job"("tenantId", "status", "scheduledStartAt");

-- CreateIndex
CREATE INDEX "Job_tenantId_orgUnitId_status_scheduledStartAt_idx" ON "Job"("tenantId", "orgUnitId", "status", "scheduledStartAt");

-- CreateIndex
CREATE INDEX "Job_tenantId_scheduledStartAt_idx" ON "Job"("tenantId", "scheduledStartAt");

-- CreateIndex
CREATE INDEX "Job_tenantId_appointmentWindowStart_idx" ON "Job"("tenantId", "appointmentWindowStart");

-- CreateIndex
CREATE INDEX "Job_tenantId_customerId_createdAt_idx" ON "Job"("tenantId", "customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Job_tenantId_jobTypeId_status_idx" ON "Job"("tenantId", "jobTypeId", "status");

-- CreateIndex
CREATE INDEX "Job_tenantId_priority_status_idx" ON "Job"("tenantId", "priority", "status");

-- CreateIndex
CREATE INDEX "Job_tenantId_parentJobId_idx" ON "Job"("tenantId", "parentJobId");

-- CreateIndex
CREATE INDEX "Job_tenantId_archivedAt_createdAt_idx" ON "Job"("tenantId", "archivedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_id_tenantId_key" ON "Job"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Job_tenantId_number_key" ON "Job"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Job_leadId_tenantId_key" ON "Job"("leadId", "tenantId");

-- CreateIndex
CREATE INDEX "JobRequirement_tenantId_skillId_idx" ON "JobRequirement"("tenantId", "skillId");

-- CreateIndex
CREATE INDEX "JobRequirement_tenantId_certificationId_idx" ON "JobRequirement"("tenantId", "certificationId");

-- CreateIndex
CREATE UNIQUE INDEX "JobRequirement_id_tenantId_key" ON "JobRequirement"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobRequirement_tenantId_jobId_skillId_key" ON "JobRequirement"("tenantId", "jobId", "skillId");

-- CreateIndex
CREATE UNIQUE INDEX "JobRequirement_tenantId_jobId_certificationId_key" ON "JobRequirement"("tenantId", "jobId", "certificationId");

-- CreateIndex
CREATE INDEX "JobAssignment_tenantId_employeeId_state_idx" ON "JobAssignment"("tenantId", "employeeId", "state");

-- CreateIndex
CREATE INDEX "JobAssignment_tenantId_jobId_state_idx" ON "JobAssignment"("tenantId", "jobId", "state");

-- CreateIndex
CREATE INDEX "JobAssignment_tenantId_teamOrgUnitId_state_idx" ON "JobAssignment"("tenantId", "teamOrgUnitId", "state");

-- CreateIndex
CREATE INDEX "JobAssignment_tenantId_recommendationId_idx" ON "JobAssignment"("tenantId", "recommendationId");

-- CreateIndex
CREATE UNIQUE INDEX "JobAssignment_id_tenantId_key" ON "JobAssignment"("id", "tenantId");

-- CreateIndex
CREATE INDEX "JobStatusHistory_tenantId_jobId_occurredAt_idx" ON "JobStatusHistory"("tenantId", "jobId", "occurredAt");

-- CreateIndex
CREATE INDEX "JobStatusHistory_tenantId_toStatus_occurredAt_idx" ON "JobStatusHistory"("tenantId", "toStatus", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobStatusHistory_id_tenantId_key" ON "JobStatusHistory"("id", "tenantId");

-- CreateIndex
CREATE INDEX "JobEvent_tenantId_jobId_occurredAt_idx" ON "JobEvent"("tenantId", "jobId", "occurredAt");

-- CreateIndex
CREATE INDEX "JobEvent_tenantId_type_occurredAt_idx" ON "JobEvent"("tenantId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobEvent_id_tenantId_key" ON "JobEvent"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobEvent_tenantId_jobId_clientEventId_key" ON "JobEvent"("tenantId", "jobId", "clientEventId");

-- CreateIndex
CREATE INDEX "DispatchRecommendation_tenantId_jobId_generatedAt_idx" ON "DispatchRecommendation"("tenantId", "jobId", "generatedAt");

-- CreateIndex
CREATE INDEX "DispatchRecommendation_tenantId_status_generatedAt_idx" ON "DispatchRecommendation"("tenantId", "status", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchRecommendation_id_tenantId_key" ON "DispatchRecommendation"("id", "tenantId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_recipientId_readAt_createdAt_idx" ON "Notification"("tenantId", "recipientId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_tenantId_eventId_idx" ON "Notification"("tenantId", "eventId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_eventType_createdAt_idx" ON "Notification"("tenantId", "eventType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_id_tenantId_key" ON "Notification"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_tenantId_recipientId_idempotencyKey_key" ON "Notification"("tenantId", "recipientId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "NotificationDelivery_tenantId_notificationId_idx" ON "NotificationDelivery"("tenantId", "notificationId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_tenantId_status_nextRetryAt_idx" ON "NotificationDelivery"("tenantId", "status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_id_tenantId_key" ON "NotificationDelivery"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_attempt_key" ON "NotificationDelivery"("notificationId", "channel", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_id_tenantId_key" ON "NotificationPreference"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_tenantId_userId_eventType_channel_key" ON "NotificationPreference"("tenantId", "userId", "eventType", "channel");

-- AddForeignKey
ALTER TABLE "NumberSequence" ADD CONSTRAINT "NumberSequence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationsSettings" ADD CONSTRAINT "OperationsSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAddress" ADD CONSTRAINT "CustomerAddress_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerNote" ADD CONSTRAINT "CustomerNote_authorId_tenantId_fkey" FOREIGN KEY ("authorId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSource" ADD CONSTRAINT "LeadSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_sourceId_tenantId_fkey" FOREIGN KEY ("sourceId", "tenantId") REFERENCES "LeadSource"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_customerAddressId_customerId_tenantId_fkey" FOREIGN KEY ("customerAddressId", "customerId", "tenantId") REFERENCES "CustomerAddress"("id", "customerId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_jobTypeId_tenantId_fkey" FOREIGN KEY ("jobTypeId", "tenantId") REFERENCES "JobType"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_duplicateOfLeadId_tenantId_fkey" FOREIGN KEY ("duplicateOfLeadId", "tenantId") REFERENCES "Lead"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAssignment" ADD CONSTRAINT "LeadAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAssignment" ADD CONSTRAINT "LeadAssignment_leadId_tenantId_fkey" FOREIGN KEY ("leadId", "tenantId") REFERENCES "Lead"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAssignment" ADD CONSTRAINT "LeadAssignment_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAssignment" ADD CONSTRAINT "LeadAssignment_assignedById_tenantId_fkey" FOREIGN KEY ("assignedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadStatusHistory" ADD CONSTRAINT "LeadStatusHistory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadStatusHistory" ADD CONSTRAINT "LeadStatusHistory_leadId_tenantId_fkey" FOREIGN KEY ("leadId", "tenantId") REFERENCES "Lead"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadStatusHistory" ADD CONSTRAINT "LeadStatusHistory_actorUserId_tenantId_fkey" FOREIGN KEY ("actorUserId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadInteraction" ADD CONSTRAINT "LeadInteraction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadInteraction" ADD CONSTRAINT "LeadInteraction_leadId_tenantId_fkey" FOREIGN KEY ("leadId", "tenantId") REFERENCES "Lead"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadInteraction" ADD CONSTRAINT "LeadInteraction_authorId_tenantId_fkey" FOREIGN KEY ("authorId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT "DuplicateFlag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT "DuplicateFlag_leadId_tenantId_fkey" FOREIGN KEY ("leadId", "tenantId") REFERENCES "Lead"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT "DuplicateFlag_otherLeadId_tenantId_fkey" FOREIGN KEY ("otherLeadId", "tenantId") REFERENCES "Lead"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT "DuplicateFlag_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT "DuplicateFlag_otherCustomerId_tenantId_fkey" FOREIGN KEY ("otherCustomerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT "DuplicateFlag_resolvedById_tenantId_fkey" FOREIGN KEY ("resolvedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_skillId_tenantId_fkey" FOREIGN KEY ("skillId", "tenantId") REFERENCES "Skill"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_certificationId_tenantId_fkey" FOREIGN KEY ("certificationId", "tenantId") REFERENCES "Certification"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_verifiedById_tenantId_fkey" FOREIGN KEY ("verifiedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTerritory" ADD CONSTRAINT "ServiceTerritory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTerritory" ADD CONSTRAINT "ServiceTerritory_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceTerritory" ADD CONSTRAINT "ServiceTerritory_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Availability" ADD CONSTRAINT "Availability_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobType" ADD CONSTRAINT "JobType_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTypeSkill" ADD CONSTRAINT "JobTypeSkill_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTypeSkill" ADD CONSTRAINT "JobTypeSkill_jobTypeId_tenantId_fkey" FOREIGN KEY ("jobTypeId", "tenantId") REFERENCES "JobType"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTypeSkill" ADD CONSTRAINT "JobTypeSkill_skillId_tenantId_fkey" FOREIGN KEY ("skillId", "tenantId") REFERENCES "Skill"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTypeCertification" ADD CONSTRAINT "JobTypeCertification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTypeCertification" ADD CONSTRAINT "JobTypeCertification_jobTypeId_tenantId_fkey" FOREIGN KEY ("jobTypeId", "tenantId") REFERENCES "JobType"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTypeCertification" ADD CONSTRAINT "JobTypeCertification_certificationId_tenantId_fkey" FOREIGN KEY ("certificationId", "tenantId") REFERENCES "Certification"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_serviceAddressId_customerId_tenantId_fkey" FOREIGN KEY ("serviceAddressId", "customerId", "tenantId") REFERENCES "CustomerAddress"("id", "customerId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_jobTypeId_tenantId_fkey" FOREIGN KEY ("jobTypeId", "tenantId") REFERENCES "JobType"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_leadId_tenantId_fkey" FOREIGN KEY ("leadId", "tenantId") REFERENCES "Lead"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_parentJobId_tenantId_fkey" FOREIGN KEY ("parentJobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequirement" ADD CONSTRAINT "JobRequirement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequirement" ADD CONSTRAINT "JobRequirement_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequirement" ADD CONSTRAINT "JobRequirement_skillId_tenantId_fkey" FOREIGN KEY ("skillId", "tenantId") REFERENCES "Skill"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequirement" ADD CONSTRAINT "JobRequirement_certificationId_tenantId_fkey" FOREIGN KEY ("certificationId", "tenantId") REFERENCES "Certification"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_teamOrgUnitId_tenantId_fkey" FOREIGN KEY ("teamOrgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_assignedById_tenantId_fkey" FOREIGN KEY ("assignedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_recommendationId_tenantId_fkey" FOREIGN KEY ("recommendationId", "tenantId") REFERENCES "DispatchRecommendation"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStatusHistory" ADD CONSTRAINT "JobStatusHistory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStatusHistory" ADD CONSTRAINT "JobStatusHistory_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobStatusHistory" ADD CONSTRAINT "JobStatusHistory_actorUserId_tenantId_fkey" FOREIGN KEY ("actorUserId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_actorUserId_tenantId_fkey" FOREIGN KEY ("actorUserId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRecommendation" ADD CONSTRAINT "DispatchRecommendation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRecommendation" ADD CONSTRAINT "DispatchRecommendation_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRecommendation" ADD CONSTRAINT "DispatchRecommendation_generatedById_tenantId_fkey" FOREIGN KEY ("generatedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRecommendation" ADD CONSTRAINT "DispatchRecommendation_decidedById_tenantId_fkey" FOREIGN KEY ("decidedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DispatchRecommendation" ADD CONSTRAINT "DispatchRecommendation_chosenEmployeeId_tenantId_fkey" FOREIGN KEY ("chosenEmployeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_tenantId_fkey" FOREIGN KEY ("recipientId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_tenantId_fkey" FOREIGN KEY ("notificationId", "tenantId") REFERENCES "Notification"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN PART (Phase 2): row-level security, integrity CHECKs, partial unique indexes,
-- append-only history. Invisible to the Prisma schema; verified by tests/db/rls.test.ts and
-- tests/db/phase2-schema.test.ts. Constraint names are asserted by tests: do not rename.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Row-level security (same DO-block as 20261121134040_rls_and_constraints) ─────────────
-- Re-applied to EVERY table with a "tenantId" column; idempotent, so the Phase 1 tables are simply
-- re-asserted and every new Phase 2 table is covered. See that migration for the fail-closed rationale.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'tenantId'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT NULLIF(current_setting(''app.tenant_id'', true), ''''))) WITH CHECK ("tenantId" = (SELECT NULLIF(current_setting(''app.tenant_id'', true), '''')))',
      t.table_name
    );
  END LOOP;
END
$$;

-- ───────────── Append-only history tables ─────────────
CREATE OR REPLACE FUNCTION leadro_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER lead_status_history_no_update_delete
  BEFORE UPDATE OR DELETE ON "LeadStatusHistory"
  FOR EACH ROW EXECUTE FUNCTION leadro_append_only();
CREATE TRIGGER lead_status_history_no_truncate
  BEFORE TRUNCATE ON "LeadStatusHistory"
  FOR EACH STATEMENT EXECUTE FUNCTION leadro_append_only();

CREATE TRIGGER job_status_history_no_update_delete
  BEFORE UPDATE OR DELETE ON "JobStatusHistory"
  FOR EACH ROW EXECUTE FUNCTION leadro_append_only();
CREATE TRIGGER job_status_history_no_truncate
  BEFORE TRUNCATE ON "JobStatusHistory"
  FOR EACH STATEMENT EXECUTE FUNCTION leadro_append_only();

CREATE TRIGGER job_event_no_update_delete
  BEFORE UPDATE OR DELETE ON "JobEvent"
  FOR EACH ROW EXECUTE FUNCTION leadro_append_only();
CREATE TRIGGER job_event_no_truncate
  BEFORE TRUNCATE ON "JobEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION leadro_append_only();

-- ───────────── Partial unique indexes: "at most one ACTIVE ..." ─────────────
-- A lead has at most one current owner.
CREATE UNIQUE INDEX "LeadAssignment_one_active_per_lead"
  ON "LeadAssignment" ("tenantId", "leadId") WHERE "state" = 'ACTIVE';
-- A job has at most one active LEAD (employee or team) ...
CREATE UNIQUE INDEX "JobAssignment_one_active_lead_per_job"
  ON "JobAssignment" ("tenantId", "jobId") WHERE "state" = 'ACTIVE' AND "role" = 'LEAD';
-- ... and an employee / team appears at most once among its active assignments.
CREATE UNIQUE INDEX "JobAssignment_one_active_per_job_employee"
  ON "JobAssignment" ("tenantId", "jobId", "employeeId") WHERE "state" = 'ACTIVE' AND "employeeId" IS NOT NULL;
CREATE UNIQUE INDEX "JobAssignment_one_active_per_job_team"
  ON "JobAssignment" ("tenantId", "jobId", "teamOrgUnitId") WHERE "state" = 'ACTIVE' AND "teamOrgUnitId" IS NOT NULL;
-- Index for the retry worker: only deliveries that still need a retry.
CREATE INDEX "NotificationDelivery_due_retry_idx"
  ON "NotificationDelivery" ("tenantId", "nextRetryAt") WHERE "retryStatus" = 'SCHEDULED';

-- ───────────── Value domains: identifiers, formats, locales ─────────────
-- Stable lower-case keys.
ALTER TABLE "LeadSource" ADD CONSTRAINT lead_source_code_format CHECK ("code" ~ '^[a-z0-9][a-z0-9_-]{0,62}$');
ALTER TABLE "Skill" ADD CONSTRAINT skill_code_format CHECK ("code" ~ '^[a-z0-9][a-z0-9_-]{0,62}$');
ALTER TABLE "Certification" ADD CONSTRAINT certification_code_format CHECK ("code" ~ '^[a-z0-9][a-z0-9_-]{0,62}$');
ALTER TABLE "JobType" ADD CONSTRAINT job_type_code_format CHECK ("code" ~ '^[a-z0-9][a-z0-9_-]{0,62}$');
ALTER TABLE "NumberSequence" ADD CONSTRAINT number_sequence_name_format CHECK ("name" ~ '^[a-z][a-z0-9_]{0,62}$');
ALTER TABLE "NumberSequence" ADD CONSTRAINT number_sequence_non_negative CHECK ("lastValue" >= 0);

-- Dotted lower-case vocabularies (open-ended, see schema header).
ALTER TABLE "JobEvent" ADD CONSTRAINT job_event_type_format CHECK ("type" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$');
ALTER TABLE "Notification" ADD CONSTRAINT notification_event_type_format CHECK ("eventType" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$');
ALTER TABLE "Notification" ADD CONSTRAINT notification_idempotency_key_present CHECK (length("idempotencyKey") > 0);
ALTER TABLE "Notification" ADD CONSTRAINT notification_target_pair CHECK (("targetType" IS NULL) = ("targetId" IS NULL));
ALTER TABLE "NotificationPreference" ADD CONSTRAINT notification_preference_event_type_format
  CHECK ("eventType" = '*' OR "eventType" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$');

-- Emails lower-case, phones E.164, locales supported, currencies ISO-4217-shaped, countries alpha-2.
ALTER TABLE "Customer" ADD CONSTRAINT customer_email_lowercase CHECK ("email" IS NULL OR "email" = lower("email"));
ALTER TABLE "Customer" ADD CONSTRAINT customer_billing_email_lowercase CHECK ("billingEmail" IS NULL OR "billingEmail" = lower("billingEmail"));
ALTER TABLE "Customer" ADD CONSTRAINT customer_phone_e164 CHECK ("phoneE164" IS NULL OR "phoneE164" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "Customer" ADD CONSTRAINT customer_locale_supported CHECK ("preferredLocale" IS NULL OR "preferredLocale" IN ('en-US', 'es-US', 'he-IL'));
ALTER TABLE "Customer" ADD CONSTRAINT customer_number_positive CHECK ("number" > 0);
ALTER TABLE "Lead" ADD CONSTRAINT lead_email_lowercase CHECK ("contactEmail" IS NULL OR "contactEmail" = lower("contactEmail"));
ALTER TABLE "Lead" ADD CONSTRAINT lead_phone_e164 CHECK ("contactPhoneE164" IS NULL OR "contactPhoneE164" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "Lead" ADD CONSTRAINT lead_currency_format CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "Lead" ADD CONSTRAINT lead_number_positive CHECK ("number" > 0);
ALTER TABLE "Job" ADD CONSTRAINT job_currency_format CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "Job" ADD CONSTRAINT job_number_positive CHECK ("number" > 0);
ALTER TABLE "OperationsSettings" ADD CONSTRAINT operations_settings_currency_format CHECK ("defaultCurrency" ~ '^[A-Z]{3}$');
ALTER TABLE "CustomerAddress" ADD CONSTRAINT customer_address_country_format CHECK ("countryCode" ~ '^[A-Z]{2}$');

-- ───────────── Customers ─────────────
ALTER TABLE "CustomerAddress" ADD CONSTRAINT customer_address_latitude_range CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90));
ALTER TABLE "CustomerAddress" ADD CONSTRAINT customer_address_longitude_range CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));
ALTER TABLE "CustomerAddress" ADD CONSTRAINT customer_address_coordinates_pair CHECK (("latitude" IS NULL) = ("longitude" IS NULL));

-- ───────────── Leads ─────────────
ALTER TABLE "Lead" ADD CONSTRAINT lead_amount_non_negative CHECK ("quotedAmountMinor" IS NULL OR "quotedAmountMinor" >= 0);
ALTER TABLE "Lead" ADD CONSTRAINT lead_preferred_window_order
  CHECK ("preferredWindowStart" IS NULL OR "preferredWindowEnd" IS NULL OR "preferredWindowEnd" > "preferredWindowStart");
-- (address, customer) is one composite FK: it is only enforced when BOTH columns are set, so require the customer.
ALTER TABLE "Lead" ADD CONSTRAINT lead_address_needs_customer CHECK ("customerAddressId" IS NULL OR "customerId" IS NOT NULL);
ALTER TABLE "Lead" ADD CONSTRAINT lead_not_own_duplicate CHECK ("duplicateOfLeadId" IS NULL OR "duplicateOfLeadId" <> "id");

ALTER TABLE "LeadAssignment" ADD CONSTRAINT lead_assignment_state_ended
  CHECK (("state" = 'ACTIVE' AND "endedAt" IS NULL) OR ("state" = 'ENDED' AND "endedAt" IS NOT NULL));
ALTER TABLE "LeadAssignment" ADD CONSTRAINT lead_assignment_dates CHECK ("endedAt" IS NULL OR "endedAt" >= "assignedAt");

ALTER TABLE "LeadStatusHistory" ADD CONSTRAINT lead_status_history_changed CHECK ("fromStatus" IS NULL OR "fromStatus" <> "toStatus");

ALTER TABLE "LeadInteraction" ADD CONSTRAINT lead_interaction_duration CHECK ("durationSeconds" IS NULL OR "durationSeconds" >= 0);
ALTER TABLE "LeadInteraction" ADD CONSTRAINT lead_interaction_closed_after_start CHECK ("closedAt" IS NULL OR "closedAt" >= "occurredAt");
ALTER TABLE "LeadInteraction" ADD CONSTRAINT lead_interaction_attempt_has_channel CHECK ("kind" <> 'CONTACT_ATTEMPT' OR "channel" IS NOT NULL);

-- Duplicate flags: the id columns must match the kind, same-type pairs are stored in sorted order
-- (one row per pair together with the unique pairKey), and a decided flag carries its timestamp.
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT duplicate_flag_shape CHECK (
  ("kind" = 'LEAD_LEAD' AND "leadId" IS NOT NULL AND "otherLeadId" IS NOT NULL AND "customerId" IS NULL AND "otherCustomerId" IS NULL
     AND "leadId" < "otherLeadId") OR
  ("kind" = 'CUSTOMER_CUSTOMER' AND "customerId" IS NOT NULL AND "otherCustomerId" IS NOT NULL AND "leadId" IS NULL AND "otherLeadId" IS NULL
     AND "customerId" < "otherCustomerId") OR
  ("kind" = 'LEAD_CUSTOMER' AND "leadId" IS NOT NULL AND "customerId" IS NOT NULL AND "otherLeadId" IS NULL AND "otherCustomerId" IS NULL)
);
ALTER TABLE "DuplicateFlag" ADD CONSTRAINT duplicate_flag_resolution CHECK (
  ("status" = 'OPEN' AND "resolvedAt" IS NULL) OR ("status" <> 'OPEN' AND "resolvedAt" IS NOT NULL)
);

-- ───────────── Qualifications ─────────────
ALTER TABLE "Certification" ADD CONSTRAINT certification_not_skill CHECK ("type" <> 'SKILL');
ALTER TABLE "Certification" ADD CONSTRAINT certification_validity_positive CHECK ("validityMonths" IS NULL OR "validityMonths" > 0);
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT employee_qualification_target CHECK (
  ("kind" = 'SKILL' AND "skillId" IS NOT NULL AND "certificationId" IS NULL) OR
  ("kind" <> 'SKILL' AND "certificationId" IS NOT NULL AND "skillId" IS NULL)
);
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT employee_qualification_level
  CHECK ("level" IS NULL OR ("kind" = 'SKILL' AND "level" BETWEEN 1 AND 5));
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT employee_qualification_dates
  CHECK ("issuedAt" IS NULL OR "expiresAt" IS NULL OR "expiresAt" > "issuedAt");
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT employee_qualification_verified
  CHECK ("status" <> 'VERIFIED' OR ("verifiedById" IS NOT NULL AND "verifiedAt" IS NOT NULL));

ALTER TABLE "ServiceTerritory" ADD CONSTRAINT service_territory_dates CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

ALTER TABLE "Availability" ADD CONSTRAINT availability_shape CHECK (
  ("kind" = 'WEEKLY_WINDOW'
     AND "isoDayOfWeek" BETWEEN 1 AND 7 AND "startMinute" BETWEEN 0 AND 1439 AND "endMinute" BETWEEN 1 AND 1440
     AND "endMinute" > "startMinute" AND "startsAt" IS NULL AND "endsAt" IS NULL) OR
  ("kind" IN ('EXCEPTION_AVAILABLE', 'EXCEPTION_UNAVAILABLE')
     AND "startsAt" IS NOT NULL AND "endsAt" IS NOT NULL AND "endsAt" > "startsAt"
     AND "isoDayOfWeek" IS NULL AND "startMinute" IS NULL AND "endMinute" IS NULL
     AND "validFrom" IS NULL AND "validTo" IS NULL)
);
ALTER TABLE "Availability" ADD CONSTRAINT availability_valid_dates CHECK ("validFrom" IS NULL OR "validTo" IS NULL OR "validTo" >= "validFrom");
ALTER TABLE "Availability" ADD CONSTRAINT availability_time_zone_present CHECK (length("timeZone") > 0);

-- ───────────── Jobs ─────────────
ALTER TABLE "JobType" ADD CONSTRAINT job_type_duration_range CHECK ("defaultDurationMinutes" > 0 AND "defaultDurationMinutes" <= 10080);
ALTER TABLE "JobTypeSkill" ADD CONSTRAINT job_type_skill_level CHECK ("minLevel" IS NULL OR "minLevel" BETWEEN 1 AND 5);

ALTER TABLE "Job" ADD CONSTRAINT job_duration_range CHECK ("estimatedDurationMinutes" > 0 AND "estimatedDurationMinutes" <= 10080);
ALTER TABLE "Job" ADD CONSTRAINT job_amount_non_negative CHECK ("quotedAmountMinor" IS NULL OR "quotedAmountMinor" >= 0);
ALTER TABLE "Job" ADD CONSTRAINT job_appointment_window CHECK (
  ("appointmentWindowStart" IS NULL AND "appointmentWindowEnd" IS NULL) OR
  ("appointmentWindowStart" IS NOT NULL AND "appointmentWindowEnd" IS NOT NULL AND "appointmentWindowEnd" > "appointmentWindowStart")
);
ALTER TABLE "Job" ADD CONSTRAINT job_scheduled_slot CHECK (
  ("scheduledStartAt" IS NULL AND "scheduledEndAt" IS NULL) OR
  ("scheduledStartAt" IS NOT NULL AND "scheduledEndAt" IS NOT NULL AND "scheduledEndAt" > "scheduledStartAt")
);
ALTER TABLE "Job" ADD CONSTRAINT job_not_own_parent CHECK ("parentJobId" IS NULL OR "parentJobId" <> "id");

ALTER TABLE "JobRequirement" ADD CONSTRAINT job_requirement_target CHECK (
  ("skillId" IS NOT NULL AND "certificationId" IS NULL) OR ("skillId" IS NULL AND "certificationId" IS NOT NULL)
);
ALTER TABLE "JobRequirement" ADD CONSTRAINT job_requirement_level CHECK ("minLevel" IS NULL OR ("skillId" IS NOT NULL AND "minLevel" BETWEEN 1 AND 5));

ALTER TABLE "JobAssignment" ADD CONSTRAINT job_assignment_target CHECK (
  ("employeeId" IS NOT NULL AND "teamOrgUnitId" IS NULL) OR ("employeeId" IS NULL AND "teamOrgUnitId" IS NOT NULL)
);
ALTER TABLE "JobAssignment" ADD CONSTRAINT job_assignment_state_ended
  CHECK (("state" = 'ACTIVE' AND "endedAt" IS NULL) OR ("state" = 'ENDED' AND "endedAt" IS NOT NULL));
ALTER TABLE "JobAssignment" ADD CONSTRAINT job_assignment_dates CHECK ("endedAt" IS NULL OR "endedAt" >= "assignedAt");
ALTER TABLE "JobAssignment" ADD CONSTRAINT job_assignment_override_reason
  CHECK ("method" <> 'OVERRIDE' OR length(btrim(coalesce("overrideReason", ''))) > 0);
ALTER TABLE "JobAssignment" ADD CONSTRAINT job_assignment_recommendation_link
  CHECK ("method" NOT IN ('RECOMMENDATION_APPROVED', 'RECOMMENDATION_MODIFIED') OR "recommendationId" IS NOT NULL);

ALTER TABLE "JobStatusHistory" ADD CONSTRAINT job_status_history_changed CHECK ("fromStatus" IS NULL OR "fromStatus" <> "toStatus");

-- PENDING has no decision yet; APPROVED / MODIFIED / REJECTED record who decided and when; SUPERSEDED is system-set.
ALTER TABLE "DispatchRecommendation" ADD CONSTRAINT dispatch_recommendation_decision CHECK (
  ("status" = 'PENDING' AND "decidedAt" IS NULL AND "decidedById" IS NULL) OR
  ("status" = 'SUPERSEDED') OR
  ("status" IN ('APPROVED', 'MODIFIED', 'REJECTED') AND "decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL)
);

-- ───────────── Notifications ─────────────
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT notification_delivery_attempt_positive CHECK ("attempt" >= 1);
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT notification_delivery_failure_reason
  CHECK ("status" <> 'FAILED' OR length(btrim(coalesce("failureReason", ''))) > 0);
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT notification_delivery_retry_time
  CHECK ("retryStatus" <> 'SCHEDULED' OR "nextRetryAt" IS NOT NULL);

-- ───────────── Operations settings ─────────────
ALTER TABLE "OperationsSettings" ADD CONSTRAINT operations_settings_positive
  CHECK ("contactAttemptOpenMinutes" > 0 AND "qualificationWarningDays" > 0);
